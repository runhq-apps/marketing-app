import './env.js';  // must come first: everything below reads process.env at import time
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { json, HttpError, Router } from './http.js';
import { api } from './routes/api.js';
import { collect } from './routes/collect.js';
import { startScheduler } from './sync.js';
import './db.js';

const PORT = Number(process.env.PORT || 4000);
const PUBLIC_URL = process.env.RUNHQ_PUBLIC_URL || `http://localhost:${PORT}`;
const ADMIN_TOKEN = process.env.RUNHQ_ADMIN_TOKEN || null;

const WEB_DIST = resolve(new URL('../../web/dist', import.meta.url).pathname);
const SDK_DIST = resolve(new URL('../../sdk/dist', import.meta.url).pathname);

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.map': 'application/json',
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, PUBLIC_URL);
  const query = Object.fromEntries(url.searchParams);
  const path = url.pathname;

  // The collector is called cross-origin from customer sites; the admin API is not.
  const isCollect = path.startsWith('/api/collect') || path === '/sdk.js';
  if (isCollect) {
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-headers', 'content-type, x-runhq-key');
    res.setHeader('access-control-max-age', '86400');
  }
  if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }

  try {
    if (path === '/sdk.js') return await serveSdk(res);

    for (const router of [collect, api]) {
      const hit = router.match(req.method, path);
      if (!hit) continue;
      if (hit.methodMismatch) return json(res, 405, { error: `${req.method} not allowed on ${path}` });
      if (router === api && !authorised(req)) {
        return json(res, 401, { error: 'missing or invalid admin token' });
      }
      return await hit.handler({ req, res, params: hit.params, query });
    }

    if (path.startsWith('/api/')) return json(res, 404, { error: `no route for ${path}` });
    return await serveWeb(path, res);
  } catch (err) {
    if (err instanceof HttpError) return json(res, err.status, { error: err.message, ...(err.extra ?? {}) });
    console.error('[runhq]', req.method, path, err);
    return json(res, 500, { error: err.message || 'internal error' });
  }
});

/** Optional shared-secret gate. Unset (the default for a local install) means open. */
function authorised(req) {
  if (!ADMIN_TOKEN) return true;
  const header = req.headers.authorization || '';
  return header === `Bearer ${ADMIN_TOKEN}` || req.headers['x-admin-token'] === ADMIN_TOKEN;
}

async function serveSdk(res) {
  try {
    const body = await readFile(join(SDK_DIST, 'runhq.js'));
    res.writeHead(200, {
      'content-type': 'text/javascript; charset=utf-8',
      'cache-control': 'public, max-age=300',
      'content-length': body.length,
    });
    res.end(body);
  } catch {
    json(res, 404, { error: 'SDK is not built yet — run `npm run build -w @runhq/sdk`' });
  }
}

async function serveWeb(path, res) {
  const rel = normalize(path === '/' ? 'index.html' : path.replace(/^\/+/, ''));
  if (rel.startsWith('..')) return json(res, 400, { error: 'bad path' });
  const file = join(WEB_DIST, rel);
  try {
    const info = await stat(file);
    if (info.isFile()) return send(res, file);
  } catch { /* fall through to the SPA entry point */ }
  try {
    return await send(res, join(WEB_DIST, 'index.html'));
  } catch {
    return json(res, 404, {
      error: 'The dashboard is not built yet.',
      fix: 'Run `npm run build` in the repo root, or `npm run dev` to use the Vite dev server.',
    });
  }
}

async function send(res, file) {
  const body = await readFile(file);
  const type = MIME[extname(file)] ?? 'application/octet-stream';
  const cacheable = /\/assets\//.test(file);
  res.writeHead(200, {
    'content-type': type,
    'content-length': body.length,
    'cache-control': cacheable ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  res.end(body);
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[runhq] port ${PORT} is already in use — another copy of the server is probably running.`);
    console.error('[runhq] Stop it, or start this one on a different port:  PORT=4001 npm start');
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, () => {
  console.log(`[runhq] dashboard + API on ${PUBLIC_URL}`);
  if (!process.env.RUNHQ_ADMIN_TOKEN) console.log('[runhq] no RUNHQ_ADMIN_TOKEN set — the admin API is open on this host');
  startScheduler();
});

export { server };

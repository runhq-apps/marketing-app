/** Minimal helpers over node:http — this server has no framework dependency. */

export function json(res, status, body) {
  const payload = JSON.stringify(body ?? null);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

export class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
}
export const bad = (msg, extra) => new HttpError(400, msg, extra);
export const notFound = (what = 'resource') => new HttpError(404, `${what} not found`);

/**
 * The body as the sender wrote it. Webhook signatures are computed over these exact
 * bytes, so anything that verifies one has to read the raw text, never a re-serialised
 * version of the parsed object — key order and whitespace both matter.
 */
export async function readRaw(req, limitBytes = 1_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) throw bad('request body too large');
    chunks.push(chunk);
  }
  return size ? Buffer.concat(chunks).toString('utf8') : '';
}

export async function readJson(req, limitBytes = 1_000_000) {
  const raw = await readRaw(req, limitBytes);
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { throw bad('body is not valid JSON'); }
}

/**
 * Tiny path router. Routes are registered as ('GET', '/projects/:id/channels', handler).
 * Handlers receive ({ req, res, params, query, body }).
 */
export class Router {
  #routes = [];
  add(method, pattern, handler) {
    const keys = [];
    const rx = new RegExp('^' + pattern.replace(/\/:([A-Za-z_]\w*)/g, (_, k) => { keys.push(k); return '/([^/]+)'; }) + '$');
    this.#routes.push({ method, rx, keys, handler });
    return this;
  }
  get(p, h) { return this.add('GET', p, h); }
  post(p, h) { return this.add('POST', p, h); }
  patch(p, h) { return this.add('PATCH', p, h); }
  del(p, h) { return this.add('DELETE', p, h); }

  match(method, pathname) {
    let pathExists = false;
    for (const r of this.#routes) {
      const m = r.rx.exec(pathname);
      if (!m) continue;
      pathExists = true;
      if (r.method !== method) continue;
      const params = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      return { handler: r.handler, params };
    }
    return pathExists ? { methodMismatch: true } : null;
  }
}

/** Parses ?from=&to= into inclusive ISO dates, defaulting to the last `days` days. */
export function dateRange(query, days = 30) {
  const iso = (d) => d.toISOString().slice(0, 10);
  const valid = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
  const to = valid(query.to) ? query.to : iso(new Date());
  const from = valid(query.from)
    ? query.from
    : iso(new Date(Date.parse(to + 'T00:00:00Z') - (days - 1) * 86400_000));
  return from <= to ? { from, to } : { from: to, to: from };
}

export function eachDate(from, to) {
  const out = [];
  for (let t = Date.parse(from + 'T00:00:00Z'); t <= Date.parse(to + 'T00:00:00Z'); t += 86400_000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

/**
 * Loads the repo-root .env, if there is one.
 *
 * This is deliberately done in code rather than with node's --env-file flag: under
 * `node --watch` the flag registers the file as a watched path, and a missing .env —
 * the normal state of a fresh clone — crashes the process with ENOENT before the
 * server ever starts. Reading it here works the same whether or not the file exists.
 *
 * Real environment variables always win, so a value exported in the shell or set by a
 * deployment platform is never overwritten by a stale local file.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ENV_PATH = process.env.RUNHQ_ENV_FILE || resolve(new URL('../../../.env', import.meta.url).pathname);

export function loadEnv(path = ENV_PATH) {
  let raw;
  try { raw = readFileSync(path, 'utf8'); }
  catch { return { loaded: false, path, count: 0 }; }

  let count = 0;
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (key in process.env) continue;
    let value = trimmed.slice(eq + 1).trim();
    // Strip one layer of matching quotes, the way every .env format does.
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
    count++;
  }
  return { loaded: true, path, count };
}

export const env = loadEnv();

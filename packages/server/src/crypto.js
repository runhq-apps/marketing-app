import { createCipheriv, createDecipheriv, randomBytes, scryptSync, randomUUID } from 'node:crypto';

const SECRET = process.env.RUNHQ_SECRET || 'dev-insecure-secret-change-me-please-0000';
if (!process.env.RUNHQ_SECRET) {
  console.warn('[runhq] RUNHQ_SECRET is not set — channel credentials are encrypted with a well-known dev key. Set RUNHQ_SECRET before storing anything real.');
}
const KEY = scryptSync(SECRET, 'run-marketing-credentials-v1', 32);

/** Encrypt a JSON-serialisable credential bag. Returns `v1:<iv>:<tag>:<ciphertext>` (base64url parts). */
export function seal(obj) {
  if (obj == null) return null;
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', KEY, iv);
  const body = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), body.toString('base64url')].join(':');
}

export function open(blob) {
  if (!blob) return null;
  const [v, iv, tag, body] = String(blob).split(':');
  if (v !== 'v1') throw new Error('unknown credential envelope version');
  const d = createDecipheriv('aes-256-gcm', KEY, Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return JSON.parse(Buffer.concat([d.update(Buffer.from(body, 'base64url')), d.final()]).toString('utf8'));
}

/** What the UI is allowed to see about stored credentials: which fields are set, never the values. */
export function describeCredentials(blob, fields = []) {
  if (!blob) return { configured: false, fields: {} };
  let creds;
  try { creds = open(blob); } catch { return { configured: false, fields: {}, error: 'undecryptable — RUNHQ_SECRET changed?' }; }
  const out = {};
  for (const f of fields) {
    const val = creds?.[f.key];
    out[f.key] = val ? (f.secret ? mask(String(val)) : String(val)) : null;
  }
  return { configured: true, fields: out };
}

const mask = (s) => s.length <= 4 ? '••••' : '••••' + s.slice(-4);

export const newKey = (prefix) => `${prefix}_${randomBytes(18).toString('base64url')}`;
export { randomUUID };

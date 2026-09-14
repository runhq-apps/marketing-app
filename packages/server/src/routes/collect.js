import { Router, json, readJson, readRaw, bad } from '../http.js';
import { ingestBatch, projectByKey } from '../ingest.js';
import { getRevenueSource, sourceCredentials, applyStripeEvent, stripe } from '../revenue/index.js';

export const collect = new Router();

/**
 * The SDK's ingest endpoint. Public by design — it is called from the customer's own
 * site with a publishable key — so it accepts only what a browser can be trusted to
 * say about itself, and the key identifies the project, nothing more.
 */
collect.post('/api/collect', async ({ req, res }) => {
  const body = await readJson(req, 256_000);
  const key = body.key || req.headers['x-runhq-key'];
  if (!key) throw bad('missing SDK key');

  const result = ingestBatch({
    key,
    anon_id: body.anon_id,
    events: body.events,
    context: {
      url: body.url,
      referrer: body.referrer,
      country: req.headers['cf-ipcountry'] || req.headers['x-vercel-ip-country'] || null,
    },
  });
  json(res, 202, result);
});

/**
 * `navigator.sendBeacon` on page-unload can only send a body, and some CSPs block
 * XHR entirely — a 1×1 GIF with the payload in the query string always gets through.
 */
collect.get('/api/collect.gif', ({ req, res, query }) => {
  try {
    const payload = query.d ? JSON.parse(Buffer.from(query.d, 'base64url').toString('utf8')) : null;
    if (payload?.key) {
      ingestBatch({ key: payload.key, anon_id: payload.anon_id, events: payload.events, context: {} });
    }
  } catch { /* a tracking pixel never reports its errors to the page */ }
  const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
  res.writeHead(200, { 'content-type': 'image/gif', 'content-length': gif.length, 'cache-control': 'no-store' });
  res.end(gif);
});

/** Lets the SDK verify a key at init time and fail loudly in development. */
collect.get('/api/collect/verify', ({ res, query }) => {
  const p = query.key ? projectByKey(query.key) : null;
  json(res, p ? 200 : 404, p ? { ok: true, project: p.name } : { ok: false, error: 'unknown SDK key' });
});

/* -------------------------------------------------------------- webhooks */

/**
 * Stripe's webhook endpoint, one URL per connected source.
 *
 * It lives beside the collector rather than in the admin API for the same reason the
 * collector does: Stripe cannot present an admin token. What it can present is a
 * signature over the exact bytes it sent, which is verified here before a single field
 * of the payload is trusted. An unverified request is rejected without being parsed.
 */
collect.post('/api/revenue/stripe/:source_id', async ({ req, res, params }) => {
  const raw = await readRaw(req, 1_000_000);
  const source = getRevenueSource(params.source_id);
  // A wrong id and a bad signature answer the same way: an endpoint that confirms which
  // source ids exist is an endpoint that can be enumerated.
  const secret = source?.provider === 'stripe' ? sourceCredentials(source)?.webhook_secret : null;

  const check = stripe.verifyWebhookSignature(raw, req.headers['stripe-signature'], secret);
  if (!check.ok) return json(res, 400, { error: `webhook rejected: ${check.error}` });

  let event;
  try { event = JSON.parse(raw); } catch { throw bad('webhook body is not valid JSON'); }

  // Stripe retries anything that is not a 2xx. A payload this app cannot use is not a
  // failure — acknowledge it, or Stripe will keep redelivering it for three days.
  try {
    const result = applyStripeEvent(source, event);
    json(res, 200, { received: true, type: event.type, ...result });
  } catch (e) {
    console.error('[runhq] stripe webhook', event?.type, e.message);
    json(res, 200, { received: true, type: event?.type, applied: false, error: e.message });
  }
});

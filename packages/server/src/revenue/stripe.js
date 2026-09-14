import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Stripe, over plain fetch.
 *
 * The rest of this server has no runtime dependencies and this does not change that:
 * everything needed is four list endpoints, one account lookup and an HMAC.
 *
 * The API version is pinned. Stripe changes response shapes between versions, and a
 * dashboard that silently starts reading a different shape is worse than one that
 * fails loudly, so the version travels with the code rather than with the account.
 */
const API = 'https://api.stripe.com/v1';
export const STRIPE_API_VERSION = '2024-06-20';

/** Currencies Stripe quotes in whole units, or in thousandths, rather than in cents. */
const ZERO_DECIMAL = new Set(['bif', 'clp', 'djf', 'gnf', 'jpy', 'kmf', 'krw', 'mga',
  'pyg', 'rwf', 'ugx', 'vnd', 'vuv', 'xaf', 'xof', 'xpf']);
const THREE_DECIMAL = new Set(['bhd', 'jod', 'kwd', 'omr', 'tnd']);

/** Stripe amounts are integers in the currency's smallest unit — ¥500 is 500, $5 is 500. */
export function fromMinor(amount, currency) {
  const c = String(currency ?? 'usd').toLowerCase();
  const divisor = ZERO_DECIMAL.has(c) ? 1 : THREE_DECIMAL.has(c) ? 1000 : 100;
  return Math.round((Number(amount ?? 0) / divisor) * 1e6) / 1e6;
}

export const isTestKey = (key) => /^(sk|rk)_test_/.test(String(key ?? ''));

const isoFrom = (epochSeconds) =>
  (epochSeconds ? new Date(Number(epochSeconds) * 1000).toISOString() : null);

const epochOf = (isoDate, endOfDay = false) =>
  Math.floor(Date.parse(`${isoDate}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`) / 1000);

/**
 * One request. 429s and 5xx are retried with backoff — a rate limit in the middle of a
 * 12-month backfill should cost a second, not the whole run.
 */
async function stripeFetch(key, path, params = {}, { attempt = 0 } = {}) {
  if (!key) throw new Error('Stripe: no secret key configured');
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v == null) continue;
    if (Array.isArray(v)) for (const item of v) search.append(k, String(item));
    else search.append(k, String(v));
  }
  const url = `${API}${path}${search.toString() ? `?${search}` : ''}`;

  let res;
  try {
    res = await fetch(url, {
      headers: {
        authorization: `Bearer ${key}`,
        'stripe-version': STRIPE_API_VERSION,
      },
      signal: AbortSignal.timeout(60_000),
    });
  } catch (e) {
    throw new Error(`Stripe request failed: ${e.message}`);
  }

  if ((res.status === 429 || res.status >= 500) && attempt < 3) {
    await new Promise((r) => setTimeout(r, 2 ** attempt * 500));
    return stripeFetch(key, path, params, { attempt: attempt + 1 });
  }

  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = {}; }
  if (!res.ok) {
    const err = body?.error ?? {};
    // Stripe's own message names the missing permission or the bad key; pass it through
    // rather than replacing it with a generic "unauthorized".
    throw new Error(`Stripe returned ${res.status}: ${err.message || res.statusText}`);
  }
  return body;
}

/** Walks a Stripe list endpoint to the end. */
async function listAll(key, path, params, { max = 5000 } = {}) {
  const out = [];
  let startingAfter = null;
  for (let page = 0; page < 200; page++) {
    const body = await stripeFetch(key, path, {
      ...params, limit: 100, ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    const data = body.data ?? [];
    out.push(...data);
    if (!body.has_more || !data.length || out.length >= max) break;
    startingAfter = data[data.length - 1].id;
  }
  return out;
}

/* --------------------------------------------------------------- account */

/** Confirms the key works and says which account (and which mode) it belongs to. */
export async function verifyAccount(key) {
  const acct = await stripeFetch(key, '/account');
  return {
    account_ref: acct.id ?? null,
    account_name: acct.settings?.dashboard?.display_name || acct.business_profile?.name || acct.email || acct.id || 'Stripe',
    currency: String(acct.default_currency ?? 'usd').toUpperCase(),
    charges_enabled: !!acct.charges_enabled,
    // /v1/account carries no livemode flag; the key prefix is the reliable signal.
    livemode: !isTestKey(key),
  };
}

/* -------------------------------------------------------------- payments */

export async function fetchCharges(key, { from, to }) {
  const charges = await listAll(key, '/charges', {
    'created[gte]': epochOf(from),
    'created[lte]': epochOf(to, true),
    'expand[]': ['data.customer'],
  });
  return charges.filter((c) => c.status === 'succeeded' && c.paid).map(normaliseCharge);
}

export function normaliseCharge(charge) {
  const customer = typeof charge.customer === 'object' && charge.customer ? charge.customer : null;
  return {
    external_id: charge.id,
    kind: 'payment',
    customer_ref: customer?.id ?? (typeof charge.customer === 'string' ? charge.customer : null),
    email: charge.billing_details?.email || charge.receipt_email || customer?.email || null,
    name: charge.billing_details?.name || customer?.name || null,
    amount: fromMinor(charge.amount, charge.currency),
    currency: String(charge.currency ?? 'usd').toUpperCase(),
    description: charge.description || charge.calculated_statement_descriptor || null,
    invoice_ref: typeof charge.invoice === 'string' ? charge.invoice : charge.invoice?.id ?? null,
    subscription_ref: null,
    status: charge.status,
    livemode: charge.livemode !== false,
    occurred_at: isoFrom(charge.created),
  };
}

export async function fetchRefunds(key, { from, to }) {
  const refunds = await listAll(key, '/refunds', {
    'created[gte]': epochOf(from),
    'created[lte]': epochOf(to, true),
  });
  return refunds.filter((r) => r.status === 'succeeded' || r.status === 'pending').map(normaliseRefund);
}

/**
 * A refund is a negative payment on the day it happened, not a correction backdated to
 * the charge. Revenue for last month should not move because someone refunded today.
 */
export function normaliseRefund(refund) {
  return {
    external_id: refund.id,
    kind: 'refund',
    charge_ref: typeof refund.charge === 'string' ? refund.charge : refund.charge?.id ?? null,
    customer_ref: null,
    email: null,
    name: null,
    amount: -Math.abs(fromMinor(refund.amount, refund.currency)),
    currency: String(refund.currency ?? 'usd').toUpperCase(),
    description: refund.reason ? `Refund (${refund.reason})` : 'Refund',
    invoice_ref: null,
    subscription_ref: null,
    status: refund.status,
    livemode: refund.livemode !== false,
    occurred_at: isoFrom(refund.created),
  };
}

/* --------------------------------------------------------- subscriptions */

export async function fetchSubscriptions(key) {
  const subs = await listAll(key, '/subscriptions', {
    status: 'all',
    'expand[]': ['data.customer'],
  });
  return subs.map(normaliseSubscription);
}

/** How many months one billing interval covers — the denominator for MRR. */
const MONTHS_PER_INTERVAL = { day: 1 / 30.44, week: 7 / 30.44, month: 1, year: 12 };

export function monthlyValue(amount, interval, intervalCount = 1) {
  const months = MONTHS_PER_INTERVAL[interval] * (Number(intervalCount) || 1);
  if (!months || !Number.isFinite(months)) return 0;
  return Math.round((Number(amount ?? 0) / months) * 100) / 100;
}

/**
 * `mrr` on a subscription row is its price normalised to a month, whatever its status —
 * which is what makes churned MRR answerable later. Deciding whose money actually
 * counts as recurring revenue is a reporting question, answered in metrics.js.
 */
export const COUNTS_TO_MRR = new Set(['active']);

export function normaliseSubscription(sub) {
  const customer = typeof sub.customer === 'object' && sub.customer ? sub.customer : null;
  const items = sub.items?.data ?? [];
  let amount = 0;
  let mrr = 0;
  let interval = null;
  const plans = [];

  for (const item of items) {
    const price = item.price ?? {};
    const qty = Number(item.quantity ?? 1) || 1;
    const unit = fromMinor(price.unit_amount ?? 0, price.currency ?? sub.currency);
    const line = unit * qty;
    amount += line;
    interval ??= price.recurring?.interval ?? null;
    mrr += monthlyValue(line, price.recurring?.interval, price.recurring?.interval_count);
    if (price.nickname) plans.push(price.nickname);
    else if (typeof price.product === 'string') plans.push(price.product);
  }

  return {
    external_id: sub.id,
    customer_ref: customer?.id ?? (typeof sub.customer === 'string' ? sub.customer : null),
    email: customer?.email ?? null,
    status: sub.status,
    plan: plans.join(' + ') || null,
    interval,
    quantity: Number(items[0]?.quantity ?? 1) || 1,
    amount: Math.round(amount * 100) / 100,
    mrr: Math.round(mrr * 100) / 100,
    currency: String(sub.currency ?? 'usd').toUpperCase(),
    started_at: isoFrom(sub.start_date ?? sub.created),
    current_period_end: isoFrom(sub.current_period_end),
    canceled_at: isoFrom(sub.canceled_at),
  };
}

/* ------------------------------------------------------------- webhooks */

/**
 * Verifies a `Stripe-Signature` header against the raw request body.
 *
 * The body must be the exact bytes Stripe sent — re-serialising the parsed JSON
 * changes key order and whitespace and every signature then fails.
 */
export function verifyWebhookSignature(rawBody, header, secret, { toleranceSec = 300, now = Date.now() } = {}) {
  if (!secret) return { ok: false, error: 'no webhook signing secret is configured for this source' };
  if (!header) return { ok: false, error: 'missing Stripe-Signature header' };

  const pairs = String(header).split(',').map((p) => {
    const i = p.indexOf('=');
    return i < 0 ? null : [p.slice(0, i).trim(), p.slice(i + 1).trim()];
  }).filter(Boolean);

  const timestamp = pairs.find(([k]) => k === 't')?.[1];
  const signatures = pairs.filter(([k]) => k === 'v1').map(([, v]) => v);
  if (!timestamp || !signatures.length) return { ok: false, error: 'malformed Stripe-Signature header' };

  const age = Math.abs(now / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > toleranceSec) {
    return { ok: false, error: `signature timestamp is ${Math.round(age)}s out of date — replay rejected` };
  }

  const expected = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`, 'utf8').digest('hex');
  const expectedBuf = Buffer.from(expected, 'utf8');
  const matched = signatures.some((sig) => {
    const given = Buffer.from(sig, 'utf8');
    return given.length === expectedBuf.length && timingSafeEqual(given, expectedBuf);
  });
  return matched ? { ok: true } : { ok: false, error: 'signature does not match the signing secret' };
}

/** The webhook events worth acting on. Anything else is acknowledged and ignored. */
export const HANDLED_EVENTS = new Set([
  'charge.succeeded', 'charge.updated', 'charge.refunded',
  'refund.created', 'refund.updated', 'charge.refund.updated',
  'customer.subscription.created', 'customer.subscription.updated',
  'customer.subscription.deleted', 'customer.subscription.paused', 'customer.subscription.resumed',
]);

export { isoFrom, epochOf };

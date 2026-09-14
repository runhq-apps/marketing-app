import { all, get, run, tx, uid, now } from '../db.js';
import { seal, open } from '../crypto.js';
import { requireProject, projectStages } from '../store.js';
import { bad, notFound } from '../http.js';
import * as stripe from './stripe.js';

/**
 * Revenue sources answer the other half of the question channels ask.
 *
 * A channel is money leaving; a revenue source is money arriving, read from the system
 * that actually took it. Everything downstream — ROAS, CAC, the per-channel P&L — still
 * reads revenue out of `events`, so a payment imported here lands in exactly the same
 * place a `runhq.revenue()` call would have, attributed through the same lead.
 */
export const REVENUE_PROVIDERS = {
  stripe: {
    id: 'stripe',
    label: 'Stripe',
    blurb: 'Charges, refunds and subscriptions. Payments are matched to leads by email, so revenue lands on the channel that found the customer.',
    docs: 'https://dashboard.stripe.com/apikeys',
    fields: [
      {
        key: 'secret_key', label: 'Secret key', secret: true, required: true,
        help: 'sk_live_… — or, better, a restricted key (rk_live_…) with read access to Charges, Refunds, Subscriptions and Customers. This app never writes to Stripe.',
      },
      {
        key: 'webhook_secret', label: 'Webhook signing secret', secret: true, required: false,
        help: 'whsec_… — optional. Without it revenue only moves when a sync runs; with it, payments appear as they happen.',
      },
    ],
    verify: (creds) => stripe.verifyAccount(creds.secret_key),
    fetchPayments: async (creds, range) => [
      ...await stripe.fetchCharges(creds.secret_key, range),
      ...await stripe.fetchRefunds(creds.secret_key, range),
    ],
    fetchSubscriptions: (creds) => stripe.fetchSubscriptions(creds.secret_key),
  },
};

export const getRevenueProvider = (id) => REVENUE_PROVIDERS[id] ?? null;

/** UI-safe catalogue: field shapes and copy, no functions. */
export const revenueProviderCatalogue = () =>
  Object.values(REVENUE_PROVIDERS).map(({ id, label, blurb, docs, fields }) => ({ id, label, blurb, docs, fields }));

/* --------------------------------------------------------------- sources */

export const listRevenueSources = (projectId) =>
  all('SELECT * FROM revenue_sources WHERE project_id = :p ORDER BY created_at', { p: projectId });

export const getRevenueSource = (id) => get('SELECT * FROM revenue_sources WHERE id = :id', { id });

export function requireRevenueSource(id) {
  const s = getRevenueSource(id);
  if (!s) throw notFound('revenue source');
  return s;
}

export const sourceCredentials = (source) => (source.credentials ? open(source.credentials) : null);

export const sourceConfig = (source) => {
  try { return JSON.parse(source.config || '{}'); } catch { return {}; }
};

/**
 * Connecting verifies the key before storing it. A key that cannot read the account is
 * not worth keeping, and finding that out at connect time beats finding out at 3am when
 * the first scheduled sync fails.
 */
export async function createRevenueSource(projectId, { provider = 'stripe', name, credentials, config }) {
  const project = requireProject(projectId);
  const def = getRevenueProvider(provider);
  if (!def) throw bad(`unknown revenue provider "${provider}"`, { known: Object.keys(REVENUE_PROVIDERS) });

  const missing = def.fields.filter((f) => f.required && !credentials?.[f.key]);
  if (missing.length) throw bad(`missing: ${missing.map((f) => f.label).join(', ')}`);

  let account;
  try {
    account = await def.verify(credentials);
  } catch (e) {
    throw bad(`${def.label} rejected those credentials — ${e.message}`);
  }

  const duplicate = get(
    'SELECT id FROM revenue_sources WHERE project_id = :p AND provider = :prov AND account_ref = :acct',
    { p: project.id, prov: provider, acct: account.account_ref });
  if (duplicate) throw bad(`${def.label} account ${account.account_name} is already connected to this project`);

  const id = uid();
  run(`INSERT INTO revenue_sources (id, project_id, provider, name, credentials, config, status,
         account_ref, account_name, livemode, created_at)
       VALUES (:id, :p, :prov, :name, :creds, :config, 'ready', :acct, :acctname, :live, :ts)`, {
    id, p: project.id, prov: provider, name: name?.trim() || account.account_name || def.label,
    creds: seal(credentials), config: JSON.stringify(config ?? {}),
    acct: account.account_ref, acctname: account.account_name,
    live: account.livemode ? 1 : 0, ts: now(),
  });
  return getRevenueSource(id);
}

export function updateRevenueSource(id, patch) {
  const s = requireRevenueSource(id);
  const fields = {};
  if ('name' in patch) fields.name = patch.name;
  if ('config' in patch) fields.config = JSON.stringify(patch.config ?? {});
  if ('credentials' in patch) {
    // Merge, so the form can be resubmitted without re-typing every secret.
    const existing = s.credentials ? open(s.credentials) : {};
    const next = { ...existing, ...patch.credentials };
    for (const [k, v] of Object.entries(patch.credentials ?? {})) if (v === null || v === '') delete next[k];
    fields.credentials = Object.keys(next).length ? seal(next) : null;
    fields.status = Object.keys(next).length ? 'ready' : 'unconfigured';
  }
  if (!Object.keys(fields).length) return s;
  run(`UPDATE revenue_sources SET ${Object.keys(fields).map((k) => `${k} = :${k}`).join(', ')} WHERE id = :id`,
    { id: s.id, ...fields });
  return getRevenueSource(s.id);
}

/**
 * Disconnecting drops the ledger and the events it wrote, so revenue does not keep
 * being reported by a source nobody is talking to any more. Leads created from those
 * payments stay — they are real people, and their other history is not ours to delete.
 */
export function deleteRevenueSource(id) {
  const s = requireRevenueSource(id);
  return tx(() => {
    const payments = all('SELECT external_id, lead_id FROM payments WHERE source_id = :s', { s: s.id });
    for (const p of payments) run('DELETE FROM events WHERE dedupe_key = :k', { k: dedupeKey(s.id, p.external_id) });
    run('DELETE FROM revenue_sources WHERE id = :id', { id: s.id });
    recomputeLeadValues([...new Set(payments.map((p) => p.lead_id).filter(Boolean))]);
    return { deleted: s.id, payments: payments.length };
  });
}

const dedupeKey = (sourceId, externalId) => `rev:${sourceId}:${externalId}`;

/* ------------------------------------------------------------------ sync */

/**
 * A first sync reaches back a year, so the dashboard opens with history rather than
 * with whatever happened since lunchtime. Later syncs re-read the last two days as
 * well: a charge can settle, or be refunded, after the sync that first saw it.
 */
function resolveRange(source, from, to) {
  if (from && to) return { from, to };
  const end = to || new Date().toISOString().slice(0, 10);
  const backDays = source.last_sync_at ? 2 : 365;
  const start = from || new Date(
    Math.min(Date.parse(`${end}T00:00:00Z`),
      (source.last_sync_at ? Date.parse(source.last_sync_at) : Date.now()) - backDays * 86400_000),
  ).toISOString().slice(0, 10);
  return { from: start, to: end };
}

export async function syncRevenueSource(sourceId, { from, to } = {}) {
  const source = requireRevenueSource(sourceId);
  const project = requireProject(source.project_id);
  const def = getRevenueProvider(source.provider);
  if (!def) throw bad(`unknown revenue provider "${source.provider}"`);
  const creds = sourceCredentials(source);
  if (!creds) throw bad(`${source.name} has no stored credentials.`);

  const range = resolveRange(source, from, to);
  // Revenue syncs share the sync_runs table with channels: same idea, same history UI.
  const runId = uid();
  run(`INSERT INTO sync_runs (id, project_id, channel_id, started_at, status)
       VALUES (:id, :p, :c, :ts, 'running')`,
    { id: runId, p: project.id, c: source.id, ts: now() });

  try {
    const payments = await def.fetchPayments(creds, range);
    const subscriptions = await def.fetchSubscriptions(creds).catch(() => null);

    const written = recordPayments(project, source, payments);
    const subs = subscriptions ? recordSubscriptions(project, source, subscriptions) : 0;
    const warnings = subscriptions === null
      ? ['Payments synced, but subscriptions could not be read — MRR will be blank. The key may lack the Subscriptions read permission.']
      : [];

    finishRun(runId, 'ok', written.payments + subs, warnings.join(' ') || null);
    run(`UPDATE revenue_sources SET last_sync_at = :ts, last_sync_status = 'ok',
           last_sync_error = :warn, status = 'ready' WHERE id = :id`,
      { id: source.id, ts: now(), warn: warnings.join(' ') || null });

    return { source_id: source.id, range, ...written, subscriptions: subs, warnings };
  } catch (e) {
    finishRun(runId, 'error', 0, e.message);
    run(`UPDATE revenue_sources SET last_sync_at = :ts, last_sync_status = 'error',
           last_sync_error = :err, status = 'error' WHERE id = :id`,
      { id: source.id, ts: now(), err: e.message });
    throw e;
  }
}

function finishRun(runId, status, rows, error) {
  run(`UPDATE sync_runs SET finished_at = :ts, status = :s, rows_written = :n, error = :e WHERE id = :id`,
    { id: runId, ts: now(), s: status, n: rows, e: error ?? null });
}

export async function syncProjectRevenue(projectId, opts = {}) {
  const results = [];
  for (const s of listRevenueSources(projectId)) {
    if (!s.credentials) continue;
    try { results.push({ ok: true, ...(await syncRevenueSource(s.id, opts)) }); }
    catch (e) { results.push({ ok: false, source_id: s.id, name: s.name, error: e.message }); }
  }
  return results;
}

export const revenueSyncHistory = (sourceId, limit = 20) =>
  all('SELECT * FROM sync_runs WHERE channel_id = :c ORDER BY started_at DESC LIMIT :n', { c: sourceId, n: limit });

/* ------------------------------------------------------- payment records */

/**
 * Writes the ledger, matches each payment to a person, and mirrors it into `events`
 * so every existing metric picks it up without knowing Stripe exists.
 *
 * Re-running is free: rows key on the processor's own id, so a backfill that overlaps
 * a previous one updates in place instead of counting the same money twice.
 */
export function recordPayments(project, source, rows) {
  const stages = projectStages(project.id);
  const conversionKey = stages.find((s) => s.is_conversion)?.key ?? null;
  const cfg = sourceConfig(source);
  const createMissing = cfg.create_missing_leads !== false;

  let written = 0;
  let matched = 0;
  let unmatched = 0;
  const touchedLeads = new Set();

  tx(() => {
    for (const row of rows) {
      if (!row?.external_id || !row.occurred_at) continue;

      // A refund carries no customer of its own — it inherits the charge's identity.
      let { email, name, customer_ref } = row;
      if (row.kind === 'refund' && row.charge_ref) {
        const parent = get('SELECT * FROM payments WHERE source_id = :s AND external_id = :e',
          { s: source.id, e: row.charge_ref });
        email = email ?? parent?.email ?? null;
        name = name ?? parent?.name ?? null;
        customer_ref = customer_ref ?? parent?.customer_ref ?? null;
      }

      const lead = matchLead(project, { email, name, customer_ref, occurred_at: row.occurred_at, createMissing });
      if (lead) { matched++; touchedLeads.add(lead.id); } else unmatched++;

      run(`INSERT INTO payments (id, project_id, source_id, external_id, kind, customer_ref, email, name,
             lead_id, amount, currency, description, invoice_ref, subscription_ref, status, livemode,
             occurred_at, synced_at)
           VALUES (:id, :p, :s, :ext, :kind, :cust, :email, :name, :lead, :amount, :cur, :desc,
             :inv, :sub, :status, :live, :at, :synced)
           ON CONFLICT(source_id, external_id) DO UPDATE SET
             kind = excluded.kind, customer_ref = COALESCE(excluded.customer_ref, payments.customer_ref),
             email = COALESCE(excluded.email, payments.email), name = COALESCE(excluded.name, payments.name),
             lead_id = COALESCE(excluded.lead_id, payments.lead_id),
             amount = excluded.amount, currency = excluded.currency,
             description = COALESCE(excluded.description, payments.description),
             invoice_ref = COALESCE(excluded.invoice_ref, payments.invoice_ref),
             subscription_ref = COALESCE(excluded.subscription_ref, payments.subscription_ref),
             status = excluded.status, occurred_at = excluded.occurred_at, synced_at = excluded.synced_at`, {
        id: uid(), p: project.id, s: source.id, ext: row.external_id, kind: row.kind ?? 'payment',
        cust: customer_ref ?? null, email: email ?? null, name: name ?? null, lead: lead?.id ?? null,
        amount: Number(row.amount ?? 0), cur: row.currency ?? project.currency,
        desc: row.description ?? null, inv: row.invoice_ref ?? null, sub: row.subscription_ref ?? null,
        status: row.status ?? null, live: row.livemode === false ? 0 : 1,
        at: row.occurred_at, synced: now(),
      });

      writeRevenueEvent(project, source, { ...row, email, lead_id: lead?.id ?? null }, conversionKey);
      if (lead && row.kind !== 'refund' && conversionKey) promoteToCustomer(lead, conversionKey, stages, row.occurred_at);
      written++;
    }
    recomputeLeadValues([...touchedLeads]);
  });

  return { payments: written, matched, unmatched };
}

/**
 * The mirror into `events`. `dedupe_key` is what makes a re-sync idempotent — without
 * it, every backfill would add the same revenue again and ROAS would climb on its own.
 */
function writeRevenueEvent(project, source, row, conversionKey) {
  run(`INSERT INTO events (id, project_id, lead_id, name, stage, value, props, ts, dedupe_key)
       VALUES (:id, :p, :lead, :name, :stage, :value, :props, :ts, :key)
       ON CONFLICT(dedupe_key) DO UPDATE SET
         lead_id = COALESCE(excluded.lead_id, events.lead_id),
         value = excluded.value, stage = excluded.stage, props = excluded.props, ts = excluded.ts`, {
    id: uid(), p: project.id, lead: row.lead_id ?? null,
    name: row.kind === 'refund' ? 'refund' : 'payment',
    // A refund is not a conversion; crediting it to the conversion stage would count
    // the customer a second time on the day they asked for their money back.
    stage: row.kind === 'refund' ? null : conversionKey,
    value: Number(row.amount ?? 0),
    props: JSON.stringify({
      source: source.provider, source_id: source.id, external_id: row.external_id,
      currency: row.currency ?? project.currency,
      ...(row.invoice_ref ? { invoice: row.invoice_ref } : {}),
      ...(row.subscription_ref ? { subscription: row.subscription_ref } : {}),
      ...(row.customer_ref ? { customer: row.customer_ref } : {}),
    }),
    ts: row.occurred_at, key: dedupeKey(source.id, row.external_id),
  });
}

/**
 * Who paid?
 *
 *   1. the email on the payment, which is how a tracked lead who later pays is found
 *   2. the processor's customer id, for products that pass it to runhq.identify()
 *   3. nobody yet — so the payer becomes a lead with no channel
 *
 * Step 3 matters: a customer whose first touch was never tracked is a real hole in the
 * attribution, and the honest place to show it is the Unattributed row, not nowhere.
 */
export function matchLead(project, { email, name, customer_ref, occurred_at, createMissing = true }) {
  const normalised = email ? String(email).trim().toLowerCase() : null;

  if (normalised) {
    const byEmail = get('SELECT * FROM leads WHERE project_id = :p AND email = :e', { p: project.id, e: normalised });
    if (byEmail) return byEmail;
  }
  if (customer_ref) {
    const byCustomer = get('SELECT * FROM leads WHERE project_id = :p AND external_id = :x',
      { p: project.id, x: customer_ref });
    if (byCustomer) return byCustomer;
  }
  if (!createMissing || (!normalised && !customer_ref)) return null;

  const id = uid();
  const ts = occurred_at ?? now();
  run(`INSERT INTO leads (id, project_id, email, name, external_id, stage, value, status, first_seen, last_seen)
       VALUES (:id, :p, :email, :name, :ext, 'visit', 0, 'open', :ts, :ts)`, {
    id, p: project.id, email: normalised, name: name ?? null,
    ext: normalised ? null : customer_ref, ts,
  });
  return get('SELECT * FROM leads WHERE id = :id', { id });
}

/** Stages only move forward, exactly as they do for SDK events. */
function promoteToCustomer(lead, conversionKey, stages, ts) {
  const order = Object.fromEntries(stages.map((s, i) => [s.key, i]));
  const current = order[lead.stage] ?? -1;
  const target = order[conversionKey] ?? -1;
  if (target < 0) return;
  run(`UPDATE leads SET
         stage = CASE WHEN :advance = 1 THEN :stage ELSE stage END,
         status = 'won',
         last_seen = MAX(last_seen, :ts)
       WHERE id = :id`,
    { id: lead.id, advance: target > current ? 1 : 0, stage: conversionKey, ts });
}

/**
 * `leads.value` is a running total of the lead's events. Recomputing it — rather than
 * adding to it — is what keeps a re-synced payment from inflating the lead twice.
 */
function recomputeLeadValues(leadIds) {
  for (const id of leadIds) {
    if (!id) continue;
    run(`UPDATE leads SET value = COALESCE((SELECT SUM(value) FROM events WHERE lead_id = :id), 0)
         WHERE id = :id`, { id });
  }
}

/* -------------------------------------------------- subscription records */

export function recordSubscriptions(project, source, rows) {
  let written = 0;
  tx(() => {
    for (const row of rows) {
      if (!row?.external_id) continue;
      const lead = matchLead(project, {
        email: row.email, customer_ref: row.customer_ref,
        occurred_at: row.started_at, createMissing: false,
      });
      run(`INSERT INTO subscriptions (id, project_id, source_id, external_id, customer_ref, email, lead_id,
             status, plan, interval, quantity, amount, mrr, currency, started_at, current_period_end,
             canceled_at, synced_at)
           VALUES (:id, :p, :s, :ext, :cust, :email, :lead, :status, :plan, :interval, :qty, :amount,
             :mrr, :cur, :started, :period_end, :canceled, :synced)
           ON CONFLICT(source_id, external_id) DO UPDATE SET
             customer_ref = excluded.customer_ref, email = COALESCE(excluded.email, subscriptions.email),
             lead_id = COALESCE(excluded.lead_id, subscriptions.lead_id),
             status = excluded.status, plan = excluded.plan, interval = excluded.interval,
             quantity = excluded.quantity, amount = excluded.amount, mrr = excluded.mrr,
             currency = excluded.currency, current_period_end = excluded.current_period_end,
             canceled_at = excluded.canceled_at, synced_at = excluded.synced_at`, {
        id: uid(), p: project.id, s: source.id, ext: row.external_id,
        cust: row.customer_ref ?? null, email: row.email ?? null, lead: lead?.id ?? null,
        status: row.status ?? 'unknown', plan: row.plan ?? null, interval: row.interval ?? null,
        qty: Math.round(Number(row.quantity ?? 1)) || 1, amount: Number(row.amount ?? 0),
        mrr: Number(row.mrr ?? 0), cur: row.currency ?? project.currency,
        started: row.started_at ?? null, period_end: row.current_period_end ?? null,
        canceled: row.canceled_at ?? null, synced: now(),
      });
      written++;
    }
  });
  return written;
}

/* -------------------------------------------------------------- webhooks */

/**
 * Applies one verified Stripe event. Every handler re-derives the row from the object
 * in the payload, so an event that arrives twice — Stripe retries, and order is not
 * guaranteed — lands on the same ledger row as the sync would have written.
 */
export function applyStripeEvent(source, event) {
  const project = requireProject(source.project_id);
  const object = event?.data?.object ?? {};
  const type = String(event?.type ?? '');

  run('UPDATE revenue_sources SET last_hook_at = :ts WHERE id = :id', { id: source.id, ts: now() });

  if (type === 'charge.succeeded' || type === 'charge.updated' || type === 'charge.refunded') {
    if (object.status !== 'succeeded' || !object.paid) return { applied: false, reason: `charge is ${object.status}` };
    recordPayments(project, source, [stripe.normaliseCharge(object)]);
    return { applied: true, kind: 'payment' };
  }

  if (type === 'refund.created' || type === 'refund.updated' || type === 'charge.refund.updated') {
    recordPayments(project, source, [stripe.normaliseRefund(object)]);
    return { applied: true, kind: 'refund' };
  }

  if (type.startsWith('customer.subscription.')) {
    recordSubscriptions(project, source, [stripe.normaliseSubscription(object)]);
    return { applied: true, kind: 'subscription' };
  }

  return { applied: false, reason: `${type || 'event'} is not one this app acts on` };
}

export { stripe };

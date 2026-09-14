import { all, get } from '../db.js';
import { eachDate } from '../http.js';
import { listRevenueSources } from './index.js';
import { COUNTS_TO_MRR } from './stripe.js';

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const div = (a, b) => (b ? a / b : null);

/** The statuses whose money is actually arriving every month. */
const MRR_STATUSES = [...COUNTS_TO_MRR];
const mrrFilter = MRR_STATUSES.map((_, i) => `:st${i}`).join(',');
const mrrParams = Object.fromEntries(MRR_STATUSES.map((s, i) => [`st${i}`, s]));

/** Recurring revenue as it stands right now — a snapshot, not a range. */
export function recurringSnapshot(projectId) {
  const active = get(
    `SELECT COALESCE(SUM(mrr), 0) AS mrr, COUNT(*) AS n FROM subscriptions
     WHERE project_id = :p AND status IN (${mrrFilter})`,
    { p: projectId, ...mrrParams });

  const byStatus = Object.fromEntries(all(
    'SELECT status, COUNT(*) AS n FROM subscriptions WHERE project_id = :p GROUP BY status',
    { p: projectId }).map((r) => [r.status, r.n]));

  const mrr = round2(active.mrr);
  return {
    mrr,
    arr: round2(mrr * 12),
    active: active.n,
    trialing: byStatus.trialing ?? 0,
    past_due: byStatus.past_due ?? 0,
    canceled: byStatus.canceled ?? 0,
    by_status: byStatus,
    // ARPA over paying subscriptions, not over every row — a trial would drag it down
    // towards zero and make the number read as a price cut that never happened.
    arpa: active.n ? round2(div(mrr, active.n)) : null,
  };
}

export const projectMrr = (projectId) => recurringSnapshot(projectId).mrr;

/**
 * The money answer for one project over one window: what came in, what went back out,
 * who paid, and what it is worth per month from here.
 */
export function revenueSummary(projectId, { from, to, attribution = 'last' } = {}) {
  const sources = listRevenueSources(projectId);
  const range = { p: projectId, from, to };

  const totals = get(
    `SELECT COALESCE(SUM(CASE WHEN kind = 'payment' THEN amount ELSE 0 END), 0) AS gross,
            COALESCE(SUM(CASE WHEN kind = 'refund'  THEN amount ELSE 0 END), 0) AS refunds,
            COALESCE(SUM(amount), 0) AS net,
            SUM(CASE WHEN kind = 'payment' THEN 1 ELSE 0 END) AS payments,
            SUM(CASE WHEN kind = 'refund'  THEN 1 ELSE 0 END) AS refund_count
     FROM payments WHERE project_id = :p AND substr(occurred_at, 1, 10) BETWEEN :from AND :to`, range);

  const payers = get(
    `SELECT COUNT(DISTINCT COALESCE(lead_id, customer_ref, email)) AS n FROM payments
     WHERE project_id = :p AND kind = 'payment' AND amount > 0
       AND substr(occurred_at, 1, 10) BETWEEN :from AND :to`, range)?.n ?? 0;

  // "New" means their first ever payment landed inside the window — the ones this
  // period actually acquired, as opposed to the ones it merely billed again.
  const newPayers = get(
    `SELECT COUNT(*) AS n FROM (
       SELECT COALESCE(lead_id, customer_ref, email) AS who, MIN(occurred_at) AS first_paid
       FROM payments WHERE project_id = :p AND kind = 'payment' AND amount > 0
       GROUP BY who
     ) WHERE substr(first_paid, 1, 10) BETWEEN :from AND :to`, range)?.n ?? 0;

  const unmatched = get(
    `SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS amount FROM payments
     WHERE project_id = :p AND lead_id IS NULL
       AND substr(occurred_at, 1, 10) BETWEEN :from AND :to`, range);

  // Revenue the SDK reported directly. Both halves are real; both being present for the
  // same window is how a project ends up reporting its income twice.
  const sdkRevenue = get(
    `SELECT COALESCE(SUM(value), 0) AS revenue, COUNT(*) AS n FROM events
     WHERE project_id = :p AND value > 0 AND dedupe_key IS NULL
       AND substr(ts, 1, 10) BETWEEN :from AND :to`, range);

  const churn = churnOverRange(projectId, { from, to });
  const recurring = recurringSnapshot(projectId);
  const gross = round2(totals.gross);
  const refunds = round2(Math.abs(totals.refunds));

  return {
    connected: sources.length > 0,
    range: { from, to },
    gross,
    refunds,
    net: round2(totals.net),
    payments: totals.payments ?? 0,
    refund_count: totals.refund_count ?? 0,
    refund_rate_pct: gross ? round2((refunds / gross) * 100) : null,
    paying_customers: payers,
    new_customers: newPayers,
    returning_customers: Math.max(0, payers - newPayers),
    revenue_per_customer: payers ? round2(div(totals.net, payers)) : null,
    recurring,
    churn,
    unmatched: { count: unmatched.n ?? 0, amount: round2(unmatched.amount) },
    sdk_reported: { revenue: round2(sdkRevenue.revenue), events: sdkRevenue.n ?? 0 },
    currencies: all(
      `SELECT currency, COUNT(*) AS n FROM payments WHERE project_id = :p GROUP BY currency ORDER BY n DESC`,
      { p: projectId }).map((r) => r.currency),
    series: revenueSeries(projectId, { from, to }),
    by_channel: revenueByChannel(projectId, { attribution }),
    top_customers: topCustomers(projectId, { from, to, attribution }),
  };
}

/** One row per day in range, zeros included, so the chart has no invented gaps. */
export function revenueSeries(projectId, { from, to }) {
  const rows = Object.fromEntries(all(
    `SELECT substr(occurred_at, 1, 10) AS date,
            COALESCE(SUM(CASE WHEN kind = 'payment' THEN amount ELSE 0 END), 0) AS gross,
            COALESCE(SUM(CASE WHEN kind = 'refund'  THEN amount ELSE 0 END), 0) AS refunds,
            COALESCE(SUM(amount), 0) AS net
     FROM payments WHERE project_id = :p AND substr(occurred_at, 1, 10) BETWEEN :from AND :to
     GROUP BY date`, { p: projectId, from, to }).map((r) => [r.date, r]));

  return eachDate(from, to).map((date) => ({
    date,
    gross: round2(rows[date]?.gross ?? 0),
    refunds: round2(Math.abs(rows[date]?.refunds ?? 0)),
    net: round2(rows[date]?.net ?? 0),
  }));
}

/**
 * Churn over the window, by subscription count and by the monthly revenue those
 * subscriptions carried. The denominator is what was live at any point in the window —
 * still standing now, plus everything cancelled during it.
 */
function churnOverRange(projectId, { from, to }) {
  const lost = get(
    `SELECT COUNT(*) AS n, COALESCE(SUM(mrr), 0) AS mrr FROM subscriptions
     WHERE project_id = :p AND canceled_at IS NOT NULL
       AND substr(canceled_at, 1, 10) BETWEEN :from AND :to`, { p: projectId, from, to });

  const standing = get(
    `SELECT COUNT(*) AS n, COALESCE(SUM(mrr), 0) AS mrr FROM subscriptions
     WHERE project_id = :p AND status IN (${mrrFilter})`, { p: projectId, ...mrrParams });

  const started = get(
    `SELECT COUNT(*) AS n, COALESCE(SUM(mrr), 0) AS mrr FROM subscriptions
     WHERE project_id = :p AND started_at IS NOT NULL
       AND substr(started_at, 1, 10) BETWEEN :from AND :to`, { p: projectId, from, to });

  const base = (standing.n ?? 0) + (lost.n ?? 0);
  const baseMrr = round2(standing.mrr) + round2(lost.mrr);
  return {
    canceled: lost.n ?? 0,
    canceled_mrr: round2(lost.mrr),
    started: started.n ?? 0,
    started_mrr: round2(started.mrr),
    net_new_mrr: round2(started.mrr - lost.mrr),
    rate_pct: base ? round2((lost.n / base) * 100) : null,
    mrr_rate_pct: baseMrr ? round2((round2(lost.mrr) / baseMrr) * 100) : null,
  };
}

/**
 * What each channel has returned, over the whole history rather than the dashboard's
 * window: lifetime value only means anything measured over a lifetime, and a customer
 * acquired in March pays again in June. Spend is all-time for the same reason — a CAC
 * built from one window's cost and another's revenue is a ratio of two different things.
 */
export function revenueByChannel(projectId, { attribution = 'last' } = {}) {
  const col = attribution === 'first' ? 'first_channel_id' : 'channel_id';
  const channels = all('SELECT id, name, provider FROM channels WHERE project_id = :p ORDER BY name',
    { p: projectId });

  const index = (rows, key) => Object.fromEntries(rows.map((r) => [r[key] ?? 'null', r]));

  const spend = index(all(
    'SELECT channel_id, COALESCE(SUM(spend), 0) AS spend FROM spend_daily WHERE project_id = :p GROUP BY channel_id',
    { p: projectId }), 'channel_id');

  const revenue = index(all(
    `SELECT l.${col} AS cid, COALESCE(SUM(p.amount), 0) AS revenue,
            COUNT(DISTINCT CASE WHEN p.kind = 'payment' AND p.amount > 0 THEN p.lead_id END) AS customers
     FROM payments p JOIN leads l ON l.id = p.lead_id
     WHERE p.project_id = :p GROUP BY cid`, { p: projectId }), 'cid');

  const recurring = index(all(
    `SELECT l.${col} AS cid, COALESCE(SUM(s.mrr), 0) AS mrr, COUNT(*) AS subs
     FROM subscriptions s JOIN leads l ON l.id = s.lead_id
     WHERE s.project_id = :p AND s.status IN (${mrrFilter}) GROUP BY cid`,
    { p: projectId, ...mrrParams }), 'cid');

  const build = (id, name) => {
    const rev = round2(revenue[id ?? 'null']?.revenue ?? 0);
    const customers = revenue[id ?? 'null']?.customers ?? 0;
    const cost = round2(spend[id ?? 'null']?.spend ?? 0);
    const mrr = round2(recurring[id ?? 'null']?.mrr ?? 0);
    const subs = recurring[id ?? 'null']?.subs ?? 0;
    const ltv = customers ? round2(div(rev, customers)) : null;
    const cac = customers && cost ? round2(div(cost, customers)) : null;
    const monthlyPerCustomer = subs ? div(mrr, subs) : null;
    return {
      channel_id: id, name,
      spend: cost, revenue: rev, customers, mrr, subscriptions: subs,
      ltv, cac,
      // The number that decides whether a channel deserves more money.
      ltv_cac: ltv != null && cac ? round2(div(ltv, cac)) : null,
      // How many months of subscription it takes to earn the acquisition back.
      payback_months: cac && monthlyPerCustomer ? round2(div(cac, monthlyPerCustomer)) : null,
      profit: round2(rev - cost),
    };
  };

  const rows = channels.map((c) => build(c.id, c.name));
  const orphan = revenue.null;
  if (orphan?.revenue || orphan?.customers) rows.push(build(null, 'Unattributed'));
  return rows.sort((a, b) => b.revenue - a.revenue || b.spend - a.spend);
}

/** Who is actually paying, biggest first — with the channel that found each of them. */
export function topCustomers(projectId, { from, to, limit = 10, attribution = 'last' } = {}) {
  const col = attribution === 'first' ? 'first_channel_id' : 'channel_id';
  return all(
    `SELECT COALESCE(p.lead_id, p.customer_ref, p.email) AS key,
            MAX(p.lead_id) AS lead_id,
            MAX(COALESCE(l.email, p.email)) AS email,
            MAX(COALESCE(l.name, p.name)) AS name,
            MAX(c.name) AS channel_name,
            COALESCE(SUM(p.amount), 0) AS revenue,
            COUNT(CASE WHEN p.kind = 'payment' THEN 1 END) AS payments,
            MIN(p.occurred_at) AS first_paid, MAX(p.occurred_at) AS last_paid
     FROM payments p
     LEFT JOIN leads l ON l.id = p.lead_id
     LEFT JOIN channels c ON c.id = l.${col}
     WHERE p.project_id = :p AND substr(p.occurred_at, 1, 10) BETWEEN :from AND :to
     GROUP BY key HAVING revenue > 0 ORDER BY revenue DESC LIMIT :n`,
    { p: projectId, from, to, n: Math.min(Number(limit) || 10, 100) })
    .map((r) => ({ ...r, revenue: round2(r.revenue) }));
}

/** The raw ledger, newest first — the page that answers "what was that charge?". */
export function listPayments(projectId, { from, to, kind, leadId, limit = 100, offset = 0 } = {}) {
  const filters = ['p.project_id = :p', 'substr(p.occurred_at, 1, 10) BETWEEN :from AND :to'];
  const params = { p: projectId, from, to, limit: Math.min(Number(limit) || 100, 500), offset: Number(offset) || 0 };
  if (kind) { filters.push('p.kind = :kind'); params.kind = kind; }
  if (leadId) { filters.push('p.lead_id = :lead'); params.lead = leadId; }
  const where = filters.join(' AND ');

  const rows = all(
    `SELECT p.*, l.name AS lead_name, l.email AS lead_email, c.name AS channel_name
     FROM payments p
     LEFT JOIN leads l ON l.id = p.lead_id
     LEFT JOIN channels c ON c.id = l.channel_id
     WHERE ${where} ORDER BY p.occurred_at DESC LIMIT :limit OFFSET :offset`, params);

  const total = get(`SELECT COUNT(*) AS n FROM payments p WHERE ${where}`,
    Object.fromEntries(Object.entries(params).filter(([k]) => !['limit', 'offset'].includes(k))))?.n ?? 0;
  return { rows, total };
}

export { round2 };

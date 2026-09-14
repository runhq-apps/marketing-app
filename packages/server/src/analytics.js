import { all, get } from './db.js';
import { eachDate } from './http.js';
import { projectStages } from './store.js';

/**
 * Attribution model. `last` credits the most recent tagged touch (what most ad
 * platforms report); `first` credits the touch that originally found the lead
 * (kinder to top-of-funnel channels like review sites). Both are one column swap,
 * so the dashboard can offer the toggle and let you see the spread.
 */
const channelCol = (model) => (model === 'first' ? 'first_channel_id' : 'channel_id');

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const div = (a, b) => (b ? a / b : null);

export function projectTotals(projectId, { from, to, attribution = 'last' } = {}) {
  const col = channelCol(attribution);
  const spend = get(
    `SELECT COALESCE(SUM(spend), 0) AS spend, COALESCE(SUM(clicks), 0) AS clicks,
            COALESCE(SUM(impressions), 0) AS impressions
     FROM spend_daily WHERE project_id = :p AND date BETWEEN :from AND :to`,
    { p: projectId, from, to });

  const leads = get(
    `SELECT COUNT(*) AS leads,
            SUM(CASE WHEN ${col} IS NOT NULL THEN 1 ELSE 0 END) AS attributed,
            SUM(CASE WHEN email IS NOT NULL OR external_id IS NOT NULL THEN 1 ELSE 0 END) AS identified
     FROM leads WHERE project_id = :p AND substr(first_seen, 1, 10) BETWEEN :from AND :to`,
    { p: projectId, from, to });

  const conv = conversionStageKeys(projectId);
  const customers = conv.length ? get(
    `SELECT COUNT(DISTINCT lead_id) AS n FROM events
     WHERE project_id = :p AND substr(ts, 1, 10) BETWEEN :from AND :to
       AND stage IN (${conv.map((_, i) => `:s${i}`).join(',')})`,
    { p: projectId, from, to, ...Object.fromEntries(conv.map((k, i) => [`s${i}`, k])) })?.n ?? 0 : 0;

  const revenue = get(
    `SELECT COALESCE(SUM(value), 0) AS revenue FROM events
     WHERE project_id = :p AND substr(ts, 1, 10) BETWEEN :from AND :to`,
    { p: projectId, from, to })?.revenue ?? 0;

  return finishTotals({
    spend: spend.spend, clicks: spend.clicks, impressions: spend.impressions,
    leads: leads.leads, attributed_leads: leads.attributed ?? 0, identified_leads: leads.identified ?? 0,
    customers, revenue,
  });
}

function finishTotals(t) {
  const spend = round2(t.spend);
  const revenue = round2(t.revenue);
  return {
    ...t,
    spend, revenue,
    profit: round2(revenue - spend),
    cpl: t.leads ? round2(div(spend, t.leads)) : null,
    cac: t.customers ? round2(div(spend, t.customers)) : null,
    roas: spend ? round2(div(revenue, spend)) : null,
    roi_pct: spend ? round2(((revenue - spend) / spend) * 100) : null,
    lead_to_customer_pct: t.leads ? round2((t.customers / t.leads) * 100) : null,
    cpc: t.clicks ? round2(div(spend, t.clicks)) : null,
    click_to_lead_pct: t.clicks ? round2((t.leads / t.clicks) * 100) : null,
    unattributed_leads: Math.max(0, (t.leads ?? 0) - (t.attributed_leads ?? 0)),
  };
}

export const conversionStageKeys = (projectId) =>
  projectStages(projectId).filter((s) => s.is_conversion).map((s) => s.key);

/** Daily series for the charts: one row per day in range, zeros included. */
export function dailySeries(projectId, { from, to }) {
  const spend = indexBy(all(
    `SELECT date, SUM(spend) AS spend, SUM(clicks) AS clicks FROM spend_daily
     WHERE project_id = :p AND date BETWEEN :from AND :to GROUP BY date`,
    { p: projectId, from, to }), 'date');
  const leads = indexBy(all(
    `SELECT substr(first_seen, 1, 10) AS date, COUNT(*) AS leads FROM leads
     WHERE project_id = :p AND substr(first_seen, 1, 10) BETWEEN :from AND :to GROUP BY date`,
    { p: projectId, from, to }), 'date');
  // `value != 0`, not `value > 0`: a refund is a negative-value event, and skipping it
  // here would make this chart disagree with the revenue total drawn above it.
  const revenue = indexBy(all(
    `SELECT substr(ts, 1, 10) AS date, SUM(value) AS revenue FROM events
     WHERE project_id = :p AND substr(ts, 1, 10) BETWEEN :from AND :to AND value != 0 GROUP BY date`,
    { p: projectId, from, to }), 'date');

  return eachDate(from, to).map((date) => ({
    date,
    spend: round2(spend[date]?.spend ?? 0),
    clicks: spend[date]?.clicks ?? 0,
    leads: leads[date]?.leads ?? 0,
    revenue: round2(revenue[date]?.revenue ?? 0),
  }));
}

const indexBy = (rows, key) => Object.fromEntries(rows.map((r) => [r[key], r]));

/** Per-channel P&L: what went in, what came out, and the efficiency between them. */
export function channelBreakdown(projectId, { from, to, attribution = 'last' }) {
  const col = channelCol(attribution);
  const channels = all('SELECT * FROM channels WHERE project_id = :p ORDER BY name', { p: projectId });
  const conv = conversionStageKeys(projectId);

  const spend = indexBy(all(
    `SELECT channel_id, SUM(spend) AS spend, SUM(clicks) AS clicks, SUM(impressions) AS impressions
     FROM spend_daily WHERE project_id = :p AND date BETWEEN :from AND :to GROUP BY channel_id`,
    { p: projectId, from, to }), 'channel_id');

  const leads = indexBy(all(
    `SELECT ${col} AS cid, COUNT(*) AS leads,
            SUM(CASE WHEN email IS NOT NULL OR external_id IS NOT NULL THEN 1 ELSE 0 END) AS identified
     FROM leads WHERE project_id = :p AND substr(first_seen, 1, 10) BETWEEN :from AND :to GROUP BY cid`,
    { p: projectId, from, to }), 'cid');

  const revenue = indexBy(all(
    `SELECT l.${col} AS cid, SUM(e.value) AS revenue FROM events e
     JOIN leads l ON l.id = e.lead_id
     WHERE e.project_id = :p AND substr(e.ts, 1, 10) BETWEEN :from AND :to GROUP BY cid`,
    { p: projectId, from, to }), 'cid');

  const customers = conv.length ? indexBy(all(
    `SELECT l.${col} AS cid, COUNT(DISTINCT e.lead_id) AS customers FROM events e
     JOIN leads l ON l.id = e.lead_id
     WHERE e.project_id = :p AND substr(e.ts, 1, 10) BETWEEN :from AND :to
       AND e.stage IN (${conv.map((_, i) => `:s${i}`).join(',')}) GROUP BY cid`,
    { p: projectId, from, to, ...Object.fromEntries(conv.map((k, i) => [`s${i}`, k])) }), 'cid') : {};

  const rows = channels.map((c) => ({
    channel_id: c.id,
    name: c.name,
    provider: c.provider,
    auth_type: c.auth_type,
    status: c.status,
    last_sync_at: c.last_sync_at,
    last_sync_status: c.last_sync_status,
    ...finishTotals({
      spend: spend[c.id]?.spend ?? 0,
      clicks: spend[c.id]?.clicks ?? 0,
      impressions: spend[c.id]?.impressions ?? 0,
      leads: leads[c.id]?.leads ?? 0,
      attributed_leads: leads[c.id]?.leads ?? 0,
      identified_leads: leads[c.id]?.identified ?? 0,
      customers: customers[c.id]?.customers ?? 0,
      revenue: revenue[c.id]?.revenue ?? 0,
    }),
  }));

  // Untagged traffic is a real line item — hiding it would flatter every other channel.
  const un = leads['null'] ?? leads[null] ?? { leads: 0, identified: 0 };
  if (un.leads || revenue[null]?.revenue) {
    rows.push({
      channel_id: null,
      name: 'Unattributed',
      provider: null,
      auth_type: null,
      status: 'untracked',
      ...finishTotals({
        spend: 0, clicks: 0, impressions: 0,
        leads: un.leads ?? 0, attributed_leads: 0, identified_leads: un.identified ?? 0,
        customers: customers[null]?.customers ?? 0,
        revenue: revenue[null]?.revenue ?? 0,
      }),
    });
  }
  return rows.sort((a, b) => b.spend - a.spend || b.leads - a.leads);
}

/** Funnel counts: how many leads ever reached each stage, in stage order. */
export function funnel(projectId, { from, to, channelId, attribution = 'last' } = {}) {
  const col = channelCol(attribution);
  const stages = projectStages(projectId);
  // node:sqlite rejects named parameters the statement does not use, so :cid is
  // bound only when the query actually filters on it.
  const params = { p: projectId, from, to, ...(channelId ? { cid: channelId } : {}) };
  const where = `e.project_id = :p AND substr(e.ts, 1, 10) BETWEEN :from AND :to
                 ${channelId ? `AND l.${col} = :cid` : ''}`;

  const counts = indexBy(all(
    `SELECT e.stage AS stage, COUNT(DISTINCT e.lead_id) AS n, COALESCE(SUM(e.value), 0) AS value
     FROM events e JOIN leads l ON l.id = e.lead_id
     WHERE ${where} AND e.stage IS NOT NULL GROUP BY e.stage`, params), 'stage');

  let prev = null;
  return stages.map((s) => {
    const n = counts[s.key]?.n ?? 0;
    const row = {
      key: s.key, label: s.label, is_conversion: !!s.is_conversion,
      count: n,
      value: round2(counts[s.key]?.value ?? 0),
      // With nothing in the previous stage there is no rate to state — null, not 0%,
      // so the UI shows "—" instead of claiming a conversion rate collapsed.
      step_conversion_pct: prev ? round2((n / prev) * 100) : null,
      drop_off: prev == null ? null : Math.max(0, prev - n),
    };
    prev = n;
    return row;
  });
}

export function leadList(projectId, { from, to, channelId, stage, q, identified, limit = 100, offset = 0, attribution = 'last' }) {
  const col = channelCol(attribution);
  const filters = ['l.project_id = :p', 'substr(l.first_seen, 1, 10) BETWEEN :from AND :to'];
  const params = { p: projectId, from, to, limit: Math.min(Number(limit) || 100, 500), offset: Number(offset) || 0 };
  if (channelId === 'none') filters.push(`l.${col} IS NULL`);
  else if (channelId) { filters.push(`l.${col} = :cid`); params.cid = channelId; }
  if (stage) { filters.push('l.stage = :stage'); params.stage = stage; }
  if (identified === 'yes') filters.push('(l.email IS NOT NULL OR l.external_id IS NOT NULL)');
  if (identified === 'no') filters.push('l.email IS NULL AND l.external_id IS NULL');
  if (q) {
    filters.push('(l.email LIKE :q OR l.name LIKE :q OR l.company LIKE :q OR l.utm_campaign LIKE :q)');
    params.q = `%${q}%`;
  }
  const where = filters.join(' AND ');
  const rows = all(
    `SELECT l.*, c.name AS channel_name, c.provider AS channel_provider,
            (SELECT COUNT(*) FROM events e WHERE e.lead_id = l.id) AS event_count
     FROM leads l LEFT JOIN channels c ON c.id = l.${col}
     WHERE ${where} ORDER BY l.last_seen DESC LIMIT :limit OFFSET :offset`, params);
  const total = get(`SELECT COUNT(*) AS n FROM leads l WHERE ${where}`,
    Object.fromEntries(Object.entries(params).filter(([k]) => !['limit', 'offset'].includes(k))))?.n ?? 0;
  return { rows, total };
}

/** The same window, immediately before — used for the "vs previous period" deltas. */
export function previousRange(from, to) {
  const days = Math.round((Date.parse(to) - Date.parse(from)) / 86400_000) + 1;
  const prevTo = new Date(Date.parse(from) - 86400_000);
  const prevFrom = new Date(prevTo.getTime() - (days - 1) * 86400_000);
  return { from: prevFrom.toISOString().slice(0, 10), to: prevTo.toISOString().slice(0, 10) };
}

export { round2 };

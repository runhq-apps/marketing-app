import { Router, json, readJson, dateRange, bad, notFound, HttpError } from '../http.js';
import * as store from '../store.js';
import * as analytics from '../analytics.js';
import * as audit from '../audit.js';
import * as sync from '../sync.js';
import { scanSite, latestScan, scanHistory } from '../scanner.js';
import { providerCatalogue, AUTH_TYPES, getProvider } from '../connectors/index.js';
import * as revenue from '../revenue/index.js';
import * as revenueMetrics from '../revenue/metrics.js';
import { describeCredentials } from '../crypto.js';
import { hasPlaywright } from '../connectors/browser.js';
import { all, get, run, uid, now } from '../db.js';
import { listEventsForLead } from '../ingest.js';

export const api = new Router();

/* ------------------------------------------------------------- meta */

api.get('/api/health', async ({ res }) => json(res, 200, {
  ok: true,
  version: '0.1.0',
  projects: get('SELECT COUNT(*) AS n FROM projects')?.n ?? 0,
  browser_automation: await hasPlaywright(),
}));

api.get('/api/providers', ({ res }) => json(res, 200, {
  providers: providerCatalogue(),
  auth_types: AUTH_TYPES,
  revenue_providers: revenue.revenueProviderCatalogue(),
}));

/* ------------------------------------------- account-level dashboard */

/**
 * The account view: one card per project, each carrying its own money in / money out,
 * the daily series behind the card's sparkline, and its audit health.
 */
api.get('/api/overview', ({ res, query }) => {
  const { from, to } = dateRange(query, Number(query.days) || 30);
  const prev = analytics.previousRange(from, to);
  const attribution = query.attribution === 'first' ? 'first' : 'last';

  const projects = store.listProjects({ includeArchived: query.archived === '1' }).map((p) => {
    const totals = analytics.projectTotals(p.id, { from, to, attribution });
    const previous = analytics.projectTotals(p.id, { ...prev, attribution });
    return {
      id: p.id, name: p.name, slug: p.slug, website: p.website, currency: p.currency,
      target_cac: p.target_cac, archived: !!p.archived, created_at: p.created_at,
      totals,
      previous,
      deltas: deltas(totals, previous),
      series: analytics.dailySeries(p.id, { from, to }),
      health: audit.healthScore(p.id),
      channels: store.listChannels(p.id).length,
    };
  });

  const account = projects.reduce((acc, p) => ({
    spend: acc.spend + p.totals.spend,
    revenue: acc.revenue + p.totals.revenue,
    leads: acc.leads + p.totals.leads,
    customers: acc.customers + p.totals.customers,
  }), { spend: 0, revenue: 0, leads: 0, customers: 0 });

  json(res, 200, {
    range: { from, to }, previous: prev, attribution,
    account: {
      ...account,
      spend: round(account.spend), revenue: round(account.revenue),
      profit: round(account.revenue - account.spend),
      roas: account.spend ? round(account.revenue / account.spend) : null,
      cac: account.customers ? round(account.spend / account.customers) : null,
      open_findings: projects.reduce((n, p) => n + p.health.open, 0),
      critical_findings: projects.reduce((n, p) => n + p.health.counts.critical, 0),
    },
    projects,
  });
});

const round = (n) => Math.round((Number(n) || 0) * 100) / 100;

function deltas(current, previous) {
  const keys = ['spend', 'revenue', 'leads', 'customers', 'profit', 'cac', 'roas', 'cpl'];
  const out = {};
  for (const k of keys) {
    const a = current[k], b = previous[k];
    out[k] = (a == null || b == null || b === 0) ? null : round(((a - b) / Math.abs(b)) * 100);
  }
  return out;
}

/* --------------------------------------------------------- projects */

api.get('/api/projects', ({ res, query }) =>
  json(res, 200, store.listProjects({ includeArchived: query.archived === '1' })));

api.post('/api/projects', async ({ res, req }) => {
  const body = await readJson(req);
  const p = store.createProject(body);
  // Audit it straight away: a brand-new project has real gaps (no channels, no SDK
  // events) and should say so, rather than sit on an unearned clean bill of health.
  audit.runAudit(p);
  json(res, 201, p);
});

api.get('/api/projects/:id', ({ res, params }) => {
  const p = store.requireProject(params.id);
  json(res, 200, { ...p, stages: store.projectStages(p.id), channels: store.listChannels(p.id).length });
});

api.patch('/api/projects/:id', async ({ res, req, params }) =>
  json(res, 200, store.updateProject(params.id, await readJson(req))));

api.del('/api/projects/:id', ({ res, params }) => json(res, 200, store.deleteProject(params.id)));

api.get('/api/projects/:id/stages', ({ res, params }) =>
  json(res, 200, store.projectStages(store.requireProject(params.id).id)));

api.post('/api/projects/:id/stages', async ({ res, req, params }) => {
  const body = await readJson(req);
  json(res, 200, store.setStages(params.id, body.stages));
});

/** Everything the project dashboard needs, in one round trip. */
api.get('/api/projects/:id/summary', ({ res, params, query }) => {
  const p = store.requireProject(params.id);
  const { from, to } = dateRange(query, Number(query.days) || 30);
  const prev = analytics.previousRange(from, to);
  const attribution = query.attribution === 'first' ? 'first' : 'last';
  const totals = analytics.projectTotals(p.id, { from, to, attribution });
  const previous = analytics.projectTotals(p.id, { ...prev, attribution });

  json(res, 200, {
    project: { ...p, stages: store.projectStages(p.id) },
    range: { from, to }, previous: prev, attribution,
    totals, previous_totals: previous, deltas: deltas(totals, previous),
    series: analytics.dailySeries(p.id, { from, to }),
    channels: analytics.channelBreakdown(p.id, { from, to, attribution }),
    funnel: analytics.funnel(p.id, { from, to, attribution }),
    health: audit.healthScore(p.id),
    findings: audit.listFindings(p.id).slice(0, 6),
    scan: latestScan(p.id),
    revenue: revenueSnapshot(p.id),
  });
});

/** Just enough about connected revenue for the dashboard header — not the whole page. */
function revenueSnapshot(projectId) {
  const sources = revenue.listRevenueSources(projectId);
  if (!sources.length) return { connected: false };
  const recurring = revenueMetrics.recurringSnapshot(projectId);
  return {
    connected: true,
    providers: [...new Set(sources.map((s) => s.provider))],
    livemode: sources.every((s) => s.livemode === 1),
    mrr: recurring.mrr,
    arr: recurring.arr,
    active_subscriptions: recurring.active,
  };
}

api.get('/api/projects/:id/funnel', ({ res, params, query }) => {
  const p = store.requireProject(params.id);
  const { from, to } = dateRange(query, Number(query.days) || 30);
  json(res, 200, analytics.funnel(p.id, {
    from, to,
    channelId: query.channel_id || null,
    attribution: query.attribution === 'first' ? 'first' : 'last',
  }));
});

/* --------------------------------------------------------- channels */

const shapeChannel = (c) => {
  const provider = getProvider(c.provider);
  const fields = provider?.fields?.[c.auth_type] ?? [];
  return {
    ...c,
    credentials: undefined,
    config: safeParse(c.config),
    provider_label: provider?.label ?? c.provider,
    provider_blurb: provider?.blurb ?? '',
    category: provider?.category ?? 'other',
    can_sync: typeof provider?.fetchSpend === 'function' && c.auth_type !== 'manual',
    can_sync_leads: typeof provider?.fetchLeads === 'function',
    needs_browser: !!provider?.needsBrowser,
    checklist: provider?.checklist ?? [],
    fields,
    credential_state: describeCredentials(c.credentials, fields),
  };
};

const safeParse = (s) => { try { return JSON.parse(s || '{}'); } catch { return {}; } };

api.get('/api/projects/:id/channels', ({ res, params }) => {
  const p = store.requireProject(params.id);
  json(res, 200, store.listChannels(p.id).map(shapeChannel));
});

api.post('/api/projects/:id/channels', async ({ res, req, params }) => {
  const p = store.requireProject(params.id);
  json(res, 201, shapeChannel(store.createChannel(p.id, await readJson(req))));
});

api.get('/api/channels/:id', ({ res, params }) => {
  const c = store.requireChannel(params.id);
  json(res, 200, { ...shapeChannel(c), syncs: sync.syncHistory(c.id) });
});

api.patch('/api/channels/:id', async ({ res, req, params }) =>
  json(res, 200, shapeChannel(store.updateChannel(params.id, await readJson(req)))));

api.del('/api/channels/:id', ({ res, params }) => json(res, 200, store.deleteChannel(params.id)));

api.post('/api/channels/:id/sync', async ({ res, req, params }) => {
  const body = await readJson(req).catch(() => ({}));
  json(res, 200, await sync.syncChannel(params.id, body));
});

api.post('/api/projects/:id/sync', async ({ res, req, params }) => {
  const p = store.requireProject(params.id);
  json(res, 200, await sync.syncProject(p.id, await readJson(req).catch(() => ({}))));
});

/** Manual spend: either explicit daily rows, or a period total split evenly. */
api.post('/api/channels/:id/spend', async ({ res, req, params }) => {
  const c = store.requireChannel(params.id);
  const body = await readJson(req);
  let rows = body.rows;
  if (!rows && body.total != null && body.from && body.to) {
    const days = Math.round((Date.parse(body.to) - Date.parse(body.from)) / 86400_000) + 1;
    if (days < 1) throw bad('from must be on or before to');
    const per = Number(body.total) / days;
    rows = Array.from({ length: days }, (_, i) => ({
      date: new Date(Date.parse(body.from) + i * 86400_000).toISOString().slice(0, 10),
      spend: per, estimated: days > 1,
    }));
  }
  if (!Array.isArray(rows) || !rows.length) throw bad('provide rows[] or { from, to, total }');
  const written = store.upsertSpend(c.project_id, c.id, rows, 'manual');
  run(`UPDATE channels SET last_sync_at = :ts, last_sync_status = 'ok', last_sync_error = NULL WHERE id = :id`,
    { id: c.id, ts: now() });
  json(res, 200, { rows: written });
});

api.get('/api/channels/:id/spend', ({ res, params, query }) => {
  const c = store.requireChannel(params.id);
  const { from, to } = dateRange(query, Number(query.days) || 30);
  json(res, 200, all(
    'SELECT date, spend, impressions, clicks, currency, source FROM spend_daily WHERE channel_id = :c AND date BETWEEN :from AND :to ORDER BY date',
    { c: c.id, from, to }));
});

api.post('/api/channels/:id/import', async ({ res, req, params }) => {
  const c = store.requireChannel(params.id);
  const body = await readJson(req);
  if (!body.csv) throw bad('send { csv: "<file contents>" }');
  json(res, 200, sync.importSpendCsv(c, body.csv));
});

/* ------------------------------------------------------------ leads */

api.get('/api/projects/:id/leads', ({ res, params, query }) => {
  const p = store.requireProject(params.id);
  const { from, to } = dateRange(query, Number(query.days) || 30);
  json(res, 200, analytics.leadList(p.id, {
    from, to,
    channelId: query.channel_id || null,
    stage: query.stage || null,
    q: query.q || null,
    identified: query.identified || null,
    limit: query.limit, offset: query.offset,
    attribution: query.attribution === 'first' ? 'first' : 'last',
  }));
});

api.get('/api/leads/:id', ({ res, params }) => {
  const lead = get('SELECT * FROM leads WHERE id = :id', { id: params.id });
  if (!lead) throw notFound('lead');
  const channel = lead.channel_id ? store.getChannel(lead.channel_id) : null;
  const first = lead.first_channel_id ? store.getChannel(lead.first_channel_id) : null;
  json(res, 200, {
    ...lead,
    channel_name: channel?.name ?? null,
    first_channel_name: first?.name ?? null,
    events: listEventsForLead(lead.id).map((e) => ({ ...e, props: safeParse(e.props) })),
  });
});

api.patch('/api/leads/:id', async ({ res, req, params }) => {
  const body = await readJson(req);
  const allowed = ['email', 'name', 'company', 'stage', 'status', 'value', 'channel_id'];
  const sets = allowed.filter((k) => k in body);
  if (!sets.length) throw bad('nothing to update');
  run(`UPDATE leads SET ${sets.map((k) => `${k} = :${k}`).join(', ')} WHERE id = :id`,
    { id: params.id, ...Object.fromEntries(sets.map((k) => [k, body[k] ?? null])) });
  json(res, 200, get('SELECT * FROM leads WHERE id = :id', { id: params.id }));
});

/* ---------------------------------------------------------- revenue */

/** Credentials never leave the server; the UI sees which fields are set, masked. */
const shapeSource = (s) => {
  const provider = revenue.getRevenueProvider(s.provider);
  return {
    ...s,
    credentials: undefined,
    config: safeParse(s.config),
    provider_label: provider?.label ?? s.provider,
    provider_blurb: provider?.blurb ?? '',
    fields: provider?.fields ?? [],
    livemode: s.livemode === 1,
    credential_state: describeCredentials(s.credentials, provider?.fields ?? []),
    webhook_path: `/api/revenue/${s.provider}/${s.id}`,
  };
};

api.get('/api/projects/:id/revenue', ({ res, params, query }) => {
  const p = store.requireProject(params.id);
  const { from, to } = dateRange(query, Number(query.days) || 30);
  json(res, 200, {
    project: { id: p.id, slug: p.slug, name: p.name, currency: p.currency, target_cac: p.target_cac },
    attribution: query.attribution === 'first' ? 'first' : 'last',
    sources: revenue.listRevenueSources(p.id).map(shapeSource),
    ...revenueMetrics.revenueSummary(p.id, {
      from, to, attribution: query.attribution === 'first' ? 'first' : 'last',
    }),
  });
});

api.get('/api/projects/:id/revenue/sources', ({ res, params }) => {
  const p = store.requireProject(params.id);
  json(res, 200, revenue.listRevenueSources(p.id).map(shapeSource));
});

api.post('/api/projects/:id/revenue/sources', async ({ res, req, params }) => {
  const p = store.requireProject(params.id);
  const source = await revenue.createRevenueSource(p.id, await readJson(req));
  json(res, 201, shapeSource(source));
});

api.get('/api/revenue-sources/:id', ({ res, params }) => {
  const s = revenue.requireRevenueSource(params.id);
  json(res, 200, { ...shapeSource(s), syncs: revenue.revenueSyncHistory(s.id) });
});

api.patch('/api/revenue-sources/:id', async ({ res, req, params }) =>
  json(res, 200, shapeSource(revenue.updateRevenueSource(params.id, await readJson(req)))));

api.del('/api/revenue-sources/:id', ({ res, params }) =>
  json(res, 200, revenue.deleteRevenueSource(params.id)));

api.post('/api/revenue-sources/:id/sync', async ({ res, req, params }) => {
  const body = await readJson(req).catch(() => ({}));
  json(res, 200, await revenue.syncRevenueSource(params.id, body));
});

api.post('/api/projects/:id/revenue/sync', async ({ res, req, params }) => {
  const p = store.requireProject(params.id);
  json(res, 200, await revenue.syncProjectRevenue(p.id, await readJson(req).catch(() => ({}))));
});

api.get('/api/projects/:id/payments', ({ res, params, query }) => {
  const p = store.requireProject(params.id);
  const { from, to } = dateRange(query, Number(query.days) || 30);
  json(res, 200, revenueMetrics.listPayments(p.id, {
    from, to, kind: query.kind || null, leadId: query.lead_id || null,
    limit: query.limit, offset: query.offset,
  }));
});

/* ------------------------------------------------------------ audit */

api.get('/api/projects/:id/audit', ({ res, params, query }) => {
  const p = store.requireProject(params.id);
  json(res, 200, {
    findings: audit.listFindings(p.id, { status: query.status || 'open' }),
    health: audit.healthScore(p.id),
    scan: latestScan(p.id),
    scans: scanHistory(p.id),
  });
});

api.post('/api/projects/:id/audit', async ({ res, params, req }) => {
  const p = store.requireProject(params.id);
  const body = await readJson(req).catch(() => ({}));
  if (body.scan !== false && p.website) await scanSite(p).catch(() => null);
  json(res, 200, { findings: audit.runAudit(p), health: audit.healthScore(p.id), scan: latestScan(p.id) });
});

api.post('/api/projects/:id/scan', async ({ res, params, req }) => {
  const p = store.requireProject(params.id);
  const body = await readJson(req).catch(() => ({}));
  json(res, 200, await scanSite(p, { url: body.url }));
});

api.patch('/api/findings/:id', async ({ res, req, params }) => {
  const body = await readJson(req);
  if (!['open', 'dismissed', 'resolved'].includes(body.status)) throw bad('status must be open, dismissed or resolved');
  json(res, 200, audit.setFindingStatus(params.id, body.status));
});

/** Tick off a channel's manual checklist item (banner uploaded, leads routed…). */
api.post('/api/channels/:id/checklist', async ({ res, req, params }) => {
  const c = store.requireChannel(params.id);
  const { code, done } = await readJson(req);
  if (!code) throw bad('code is required');
  const cfg = safeParse(c.config);
  cfg.checklist = { ...(cfg.checklist ?? {}), [code]: !!done };
  json(res, 200, shapeChannel(store.updateChannel(c.id, { config: cfg })));
});

/* ----------------------------------------------------------- export */

api.get('/api/projects/:id/leads.csv', ({ res, params, query }) => {
  const p = store.requireProject(params.id);
  const { from, to } = dateRange(query, Number(query.days) || 90);
  const { rows } = analytics.leadList(p.id, { from, to, limit: 5000 });
  const cols = ['first_seen', 'last_seen', 'email', 'name', 'company', 'channel_name', 'stage', 'status', 'value',
    'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'click_id', 'landing_page', 'referrer'];
  const esc = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const csv = [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n');
  res.writeHead(200, {
    'content-type': 'text/csv; charset=utf-8',
    'content-disposition': `attachment; filename="${p.slug}-leads-${from}-to-${to}.csv"`,
  });
  res.end(csv);
});

export { HttpError };

import { all, get, run, uid, now } from './db.js';
import { getProvider } from './connectors/index.js';
import { requireChannel, channelCredentials, channelConfig, upsertSpend, listChannels, getProject } from './store.js';
import { bad } from './http.js';
import { resolveChannel } from './connectors/index.js';
import { syncProjectRevenue } from './revenue/index.js';

/** One sync run for one channel. Records the attempt whether or not it succeeds. */
export async function syncChannel(channelId, { from, to, withLeads = true } = {}) {
  const channel = requireChannel(channelId);
  const provider = getProvider(channel.provider);
  if (!provider) throw bad(`channel has an unknown provider "${channel.provider}"`);
  if (channel.auth_type === 'manual' || typeof provider.fetchSpend !== 'function') {
    throw bad(`${provider.label} has no automatic sync on this auth type — enter spend manually or import a CSV.`);
  }
  const creds = channelCredentials(channel);
  if (!creds) throw bad(`${channel.name} has no stored credentials.`);

  const range = {
    from: from || new Date(Date.now() - 29 * 86400_000).toISOString().slice(0, 10),
    to: to || new Date().toISOString().slice(0, 10),
  };
  const runId = uid();
  const startedAt = now();
  run(`INSERT INTO sync_runs (id, project_id, channel_id, started_at, status) VALUES (:id, :p, :c, :ts, 'running')`,
    { id: runId, p: channel.project_id, c: channel.id, ts: startedAt });

  try {
    const config = channelConfig(channel);
    const { rows = [], warnings = [] } = await provider.fetchSpend({ creds, config, ...range });
    const written = upsertSpend(channel.project_id, channel.id, rows, channel.auth_type === 'credentials' ? 'scrape' : 'api');

    let leadsWritten = 0;
    if (withLeads && typeof provider.fetchLeads === 'function') {
      const leads = await provider.fetchLeads({ creds, config, ...range }).catch((e) => {
        warnings.push(`Spend synced, but the lead export failed: ${e.message}`);
        return [];
      });
      leadsWritten = importLeads(channel, leads);
    }

    finish(runId, 'ok', written + leadsWritten, warnings.join(' ') || null);
    run(`UPDATE channels SET last_sync_at = :ts, last_sync_status = 'ok', last_sync_error = :warn, status = 'ready' WHERE id = :id`,
      { id: channel.id, ts: now(), warn: warnings.join(' ') || null });
    return { channel_id: channel.id, range, spend_rows: written, leads: leadsWritten, warnings };
  } catch (e) {
    finish(runId, 'error', 0, e.message);
    run(`UPDATE channels SET last_sync_at = :ts, last_sync_status = 'error', last_sync_error = :err, status = 'error' WHERE id = :id`,
      { id: channel.id, ts: now(), err: e.message });
    throw e;
  }
}

function finish(runId, status, rows, error) {
  run(`UPDATE sync_runs SET finished_at = :ts, status = :s, rows_written = :n, error = :e WHERE id = :id`,
    { id: runId, ts: now(), s: status, n: rows, e: error ?? null });
}

/**
 * Portal lead exports arrive as bare rows of contact details — no anonymous id, no
 * session. They are matched to an existing lead by email so a Capterra-delivered
 * contact who later signs up stays one person, not two.
 */
export function importLeads(channel, rows) {
  let n = 0;
  for (const r of rows) {
    const email = r.email ? String(r.email).trim().toLowerCase() : null;
    if (!email && !r.company) continue;
    const ts = r.date ? `${r.date}T12:00:00.000Z` : now();
    const existing = email
      ? get('SELECT * FROM leads WHERE project_id = :p AND email = :e', { p: channel.project_id, e: email })
      : null;
    if (existing) {
      run(`UPDATE leads SET channel_id = COALESCE(channel_id, :c), first_channel_id = COALESCE(first_channel_id, :c),
             name = COALESCE(name, :name), company = COALESCE(company, :company), last_seen = MAX(last_seen, :ts)
           WHERE id = :id`,
        { id: existing.id, c: channel.id, name: r.name ?? null, company: r.company ?? null, ts });
    } else {
      const id = uid();
      run(`INSERT INTO leads (id, project_id, email, name, company, channel_id, first_channel_id,
             utm_source, stage, value, status, first_seen, last_seen)
           VALUES (:id, :p, :e, :name, :company, :c, :c, :src, 'lead', 0, 'open', :ts, :ts)`, {
        id, p: channel.project_id, e: email, name: r.name ?? null, company: r.company ?? null,
        c: channel.id, src: channel.provider, ts,
      });
      run(`INSERT INTO events (id, project_id, lead_id, name, stage, value, props, ts)
           VALUES (:id, :p, :lid, 'lead_delivered', 'lead', 0, :props, :ts)`, {
        id: uid(), p: channel.project_id, lid: id,
        props: JSON.stringify({ source: channel.provider, import: 'portal_export' }), ts,
      });
    }
    n++;
  }
  return n;
}

export async function syncProject(projectId, opts = {}) {
  const results = [];
  for (const c of listChannels(projectId)) {
    const provider = getProvider(c.provider);
    if (c.auth_type === 'manual' || typeof provider?.fetchSpend !== 'function' || !c.credentials) continue;
    try { results.push({ ok: true, ...(await syncChannel(c.id, opts)) }); }
    catch (e) { results.push({ ok: false, channel_id: c.id, name: c.name, error: e.message }); }
  }
  return results;
}

export const syncHistory = (channelId, limit = 20) =>
  all('SELECT * FROM sync_runs WHERE channel_id = :c ORDER BY started_at DESC LIMIT :n', { c: channelId, n: limit });

/* ----------------------------------------------------------- CSV import */

/**
 * Accepts the shape every ad platform exports: a header row, one row per day.
 * Column names are matched loosely (Cost / Spend / Amount spent, Day / Date…) because
 * no two platforms agree on them.
 */
export function importSpendCsv(channel, text) {
  const rows = parseCsv(text);
  if (!rows.length) throw bad('the CSV has no data rows');
  const header = Object.keys(rows[0]).map((h) => h.toLowerCase().trim());
  const pick = (candidates) => {
    const hit = header.find((h) => candidates.some((c) => h === c)) ?? header.find((h) => candidates.some((c) => h.includes(c)));
    return hit ? Object.keys(rows[0])[header.indexOf(hit)] : null;
  };
  const dateCol = pick(['date', 'day', 'reporting starts', 'date_start']);
  const spendCol = pick(['spend', 'cost', 'amount spent', 'amount_spent', 'total spend']);
  if (!dateCol || !spendCol) {
    throw bad('could not find a date column and a spend column in the CSV', { columns: Object.keys(rows[0]) });
  }
  const impCol = pick(['impressions', 'impr.']);
  const clickCol = pick(['clicks', 'link clicks']);

  const parsed = rows.map((r) => ({
    date: normaliseCsvDate(r[dateCol]),
    spend: Number(String(r[spendCol] ?? '0').replace(/[^\d.-]/g, '')) || 0,
    impressions: impCol ? Number(String(r[impCol] ?? '0').replace(/[^\d]/g, '')) || 0 : 0,
    clicks: clickCol ? Number(String(r[clickCol] ?? '0').replace(/[^\d]/g, '')) || 0 : 0,
  })).filter((r) => r.date);

  if (!parsed.length) throw bad(`no row in the "${dateCol}" column parsed as a date`);
  const written = upsertSpend(channel.project_id, channel.id, parsed, 'csv');
  run(`UPDATE channels SET last_sync_at = :ts, last_sync_status = 'ok', last_sync_error = NULL WHERE id = :id`,
    { id: channel.id, ts: now() });
  return { rows: written, columns: { date: dateCol, spend: spendCol, impressions: impCol, clicks: clickCol } };
}

function normaliseCsvDate(v) {
  const s = String(v ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (us) return `${us[3]}-${us[1].padStart(2, '0')}-${us[2].padStart(2, '0')}`;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 10);
}

/** RFC-4180-ish parser: quoted fields, embedded commas, doubled quotes, CRLF. */
export function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  const src = String(text).replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((c) => c !== '')) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((c) => c !== '')) rows.push(row);
  if (rows.length < 2) return [];
  const header = rows[0].map((h) => h.trim());
  return rows.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}

/** Background sweep — every channel that can sync, on the configured interval. */
export function startScheduler() {
  const hours = Number(process.env.RUNHQ_SYNC_INTERVAL_HOURS ?? 6);
  if (!hours) return null;
  const tick = async () => {
    for (const p of all('SELECT id, name FROM projects WHERE archived = 0')) {
      // Spend and revenue on the same schedule: a dashboard where one side is six hours
      // fresher than the other reports a return on spend that was never true.
      const results = [
        ...await syncProject(p.id).catch(() => []),
        ...await syncProjectRevenue(p.id).catch(() => []),
      ];
      const failed = results.filter((r) => !r.ok);
      if (results.length) {
        console.log(`[runhq] scheduled sync ${p.name}: ${results.length - failed.length} ok, ${failed.length} failed`);
      }
    }
  };
  const timer = setInterval(() => { tick().catch((e) => console.error('[runhq] scheduler:', e.message)); }, hours * 3600_000);
  timer.unref();
  return timer;
}

export { resolveChannel, getProject };

import { all, get, run, tx, uid, now } from './db.js';
import { seal, open, newKey } from './crypto.js';
import { getProvider, PROVIDERS } from './connectors/index.js';
import { HttpError, bad, notFound } from './http.js';

export const DEFAULT_STAGES = [
  { key: 'visit',       label: 'Visit',        position: 0, is_conversion: 0 },
  { key: 'lead',        label: 'Lead',         position: 1, is_conversion: 0 },
  { key: 'qualified',   label: 'Qualified',    position: 2, is_conversion: 0 },
  { key: 'trial',       label: 'Trial',        position: 3, is_conversion: 0 },
  { key: 'opportunity', label: 'Opportunity',  position: 4, is_conversion: 0 },
  { key: 'customer',    label: 'Customer',     position: 5, is_conversion: 1 },
];

const slugify = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'project';

export function createProject({ name, website, currency = 'USD', target_cac = null, stages }) {
  if (!name?.trim()) throw bad('name is required');
  const base = slugify(name);
  let slug = base;
  for (let i = 2; get('SELECT id FROM projects WHERE slug = :slug', { slug }); i++) slug = `${base}-${i}`;

  const id = uid();
  return tx(() => {
    run(`INSERT INTO projects (id, name, slug, website, currency, sdk_key, sdk_secret, target_cac, created_at)
         VALUES (:id, :name, :slug, :website, :currency, :key, :secret, :cac, :ts)`, {
      id, name: name.trim(), slug, website: website || null, currency,
      key: newKey('run_pk'), secret: newKey('run_sk'), cac: target_cac, ts: now(),
    });
    for (const s of stages?.length ? normaliseStages(stages) : DEFAULT_STAGES) {
      run(`INSERT INTO stages (id, project_id, key, label, position, is_conversion)
           VALUES (:id, :pid, :key, :label, :pos, :conv)`,
        { id: uid(), pid: id, key: s.key, label: s.label, pos: s.position, conv: s.is_conversion });
    }
    return getProject(id);
  });
}

function normaliseStages(stages) {
  return stages.map((s, i) => ({
    key: slugify(s.key || s.label),
    label: s.label || s.key,
    position: i,
    is_conversion: s.is_conversion ? 1 : 0,
  }));
}

export const getProject = (id) =>
  get('SELECT * FROM projects WHERE id = :id OR slug = :id', { id });

export function requireProject(id) {
  const p = getProject(id);
  if (!p) throw notFound('project');
  return p;
}

export const listProjects = ({ includeArchived = false } = {}) =>
  all(`SELECT * FROM projects ${includeArchived ? '' : 'WHERE archived = 0'} ORDER BY created_at DESC`);

export function updateProject(id, patch) {
  const p = requireProject(id);
  const allowed = ['name', 'website', 'currency', 'target_cac', 'archived'];
  const sets = allowed.filter((k) => k in patch);
  if (!sets.length) return p;
  run(`UPDATE projects SET ${sets.map((k) => `${k} = :${k}`).join(', ')} WHERE id = :id`,
    { id: p.id, ...Object.fromEntries(sets.map((k) => [k, patch[k] ?? null])) });
  return getProject(p.id);
}

export function deleteProject(id) {
  const p = requireProject(id);
  run('DELETE FROM projects WHERE id = :id', { id: p.id });
  return { deleted: p.id };
}

export const projectStages = (projectId) =>
  all('SELECT * FROM stages WHERE project_id = :p ORDER BY position', { p: projectId });

export function setStages(projectId, stages) {
  const p = requireProject(projectId);
  if (!Array.isArray(stages) || !stages.length) throw bad('stages must be a non-empty array');
  return tx(() => {
    run('DELETE FROM stages WHERE project_id = :p', { p: p.id });
    for (const s of normaliseStages(stages)) {
      run(`INSERT INTO stages (id, project_id, key, label, position, is_conversion)
           VALUES (:id, :pid, :key, :label, :pos, :conv)`,
        { id: uid(), pid: p.id, key: s.key, label: s.label, pos: s.position, conv: s.is_conversion });
    }
    return projectStages(p.id);
  });
}

/* ------------------------------------------------------------- channels */

export function createChannel(projectId, { provider, name, auth_type, credentials, config }) {
  const p = requireProject(projectId);
  const def = getProvider(provider);
  if (!def) throw bad(`unknown provider "${provider}"`, { known: Object.keys(PROVIDERS) });
  const authType = auth_type || def.authTypes[0];
  if (!def.authTypes.includes(authType)) {
    throw bad(`${def.label} does not support auth type "${authType}"`, { supported: def.authTypes });
  }
  const id = uid();
  const merged = { ...(def.defaultConfig ?? {}), ...(config ?? {}) };
  run(`INSERT INTO channels (id, project_id, provider, name, auth_type, status, credentials, config, created_at)
       VALUES (:id, :pid, :provider, :name, :auth, :status, :creds, :config, :ts)`, {
    id, pid: p.id, provider, name: name?.trim() || def.label, auth: authType,
    status: credentials ? 'ready' : (authType === 'manual' ? 'ready' : 'unconfigured'),
    creds: credentials ? seal(credentials) : null,
    config: JSON.stringify(merged), ts: now(),
  });
  return getChannel(id);
}

export const getChannel = (id) => get('SELECT * FROM channels WHERE id = :id', { id });

export function requireChannel(id) {
  const c = getChannel(id);
  if (!c) throw notFound('channel');
  return c;
}

export const listChannels = (projectId) =>
  all('SELECT * FROM channels WHERE project_id = :p ORDER BY created_at', { p: projectId });

export function updateChannel(id, patch) {
  const c = requireChannel(id);
  const fields = {};
  if ('name' in patch) fields.name = patch.name;
  if ('auth_type' in patch) fields.auth_type = patch.auth_type;
  if ('config' in patch) fields.config = JSON.stringify(patch.config ?? {});
  if ('status' in patch) fields.status = patch.status;
  if ('credentials' in patch) {
    // Merge, so the UI can resubmit a form without re-typing every secret.
    const existing = c.credentials ? open(c.credentials) : {};
    const next = { ...existing, ...patch.credentials };
    for (const [k, v] of Object.entries(patch.credentials ?? {})) if (v === null || v === '') delete next[k];
    fields.credentials = Object.keys(next).length ? seal(next) : null;
    fields.status = Object.keys(next).length ? 'ready' : 'unconfigured';
  }
  if (!Object.keys(fields).length) return c;
  run(`UPDATE channels SET ${Object.keys(fields).map((k) => `${k} = :${k}`).join(', ')} WHERE id = :id`,
    { id: c.id, ...fields });
  return getChannel(c.id);
}

export function deleteChannel(id) {
  const c = requireChannel(id);
  run('DELETE FROM channels WHERE id = :id', { id: c.id });
  return { deleted: c.id };
}

export const channelCredentials = (channel) => (channel.credentials ? open(channel.credentials) : null);

export const channelConfig = (channel) => {
  try { return JSON.parse(channel.config || '{}'); } catch { return {}; }
};

/* ---------------------------------------------------------------- spend */

export function upsertSpend(projectId, channelId, rows, source = 'api') {
  let written = 0;
  tx(() => {
    for (const r of rows) {
      if (!r?.date) continue;
      run(`INSERT INTO spend_daily (id, project_id, channel_id, date, spend, impressions, clicks, currency, source)
           VALUES (:id, :pid, :cid, :date, :spend, :imp, :clicks, :cur, :src)
           ON CONFLICT(channel_id, date) DO UPDATE SET
             spend = excluded.spend, impressions = excluded.impressions,
             clicks = excluded.clicks, currency = excluded.currency, source = excluded.source`, {
        id: uid(), pid: projectId, cid: channelId, date: r.date,
        spend: Number(r.spend ?? 0), imp: Math.round(Number(r.impressions ?? 0)),
        clicks: Math.round(Number(r.clicks ?? 0)), cur: r.currency || 'USD',
        src: r.estimated ? `${source}_estimated` : source,
      });
      written++;
    }
  });
  return written;
}

export { HttpError };

import { all, get, run, tx, uid, now } from './db.js';
import { listChannels, projectStages } from './store.js';
import { resolveChannel } from './connectors/index.js';
import { bad, notFound } from './http.js';

const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'];
const CLICK_ID_KEYS = ['gclid', 'wbraid', 'gbraid', 'fbclid', 'msclkid', 'twclid', 'li_fat_id', 'rdt_cid', 'ttclid'];

export const projectByKey = (key) => get('SELECT * FROM projects WHERE sdk_key = :k', { k: key });

/**
 * The SDK posts a batch; everything a batch does to one visitor happens in one
 * transaction, so a half-applied identify can never split a person in two.
 */
export function ingestBatch({ key, anon_id, events, context = {} }) {
  const project = projectByKey(key);
  if (!project) throw notFound('project for that SDK key');
  if (!Array.isArray(events) || !events.length) throw bad('events must be a non-empty array');
  if (events.length > 200) throw bad('batch too large (max 200 events)');

  const channels = listChannels(project.id);
  const stages = projectStages(project.id);

  return tx(() => {
    let leadId = null;
    let accepted = 0;
    for (const ev of events) {
      const r = ingestOne({ project, channels, stages, anon_id, event: ev, context });
      if (r) { leadId = r; accepted++; }
    }
    return { project_id: project.id, lead_id: leadId, accepted };
  });
}

function ingestOne({ project, channels, stages, anon_id, event, context }) {
  const ts = validTs(event.ts);
  const url = event.url ?? context.url ?? null;
  const referrer = event.referrer ?? context.referrer ?? null;
  const touch = touchFrom(url, referrer, event.props ?? {});
  const anon = event.anon_id || anon_id;
  if (!anon && !event.traits?.email && !event.user_id) return null;

  // Resolve by session first: this batch's anonymous history belongs to whoever the
  // batch turns out to be, and applyIdentity() below folds it into the known person.
  let lead = findLead(project.id, { anon, email: event.traits?.email, external_id: event.user_id });
  if (!lead) lead = createLead(project, channels, { anon, ts, touch, url, referrer, country: context.country });

  // A later tagged touch replaces last-touch attribution; an untagged one never does.
  if (touch.tagged) {
    const { channel } = resolveChannel(channels, touch);
    run(`UPDATE leads SET channel_id = COALESCE(:cid, channel_id),
           utm_source = COALESCE(:s, utm_source), utm_medium = COALESCE(:m, utm_medium),
           utm_campaign = COALESCE(:c, utm_campaign), utm_term = COALESCE(:t, utm_term),
           utm_content = COALESCE(:ct, utm_content), click_id = COALESCE(:k, click_id)
         WHERE id = :id`, {
      id: lead.id, cid: channel?.id ?? null, s: touch.utm_source, m: touch.utm_medium,
      c: touch.utm_campaign, t: touch.utm_term, ct: touch.utm_content,
      k: firstClickId(touch.params),
    });
  }

  if (event.name === 'identify' || event.traits || event.user_id) {
    lead = applyIdentity(project, lead, { user_id: event.user_id, traits: event.traits ?? {} });
  }

  const stageKey = event.stage ?? stageForEvent(event.name, stages);
  const value = Number(event.value ?? event.props?.value ?? 0) || 0;

  run(`INSERT INTO events (id, project_id, lead_id, anon_id, name, stage, value, url, referrer, props, ts)
       VALUES (:id, :pid, :lid, :anon, :name, :stage, :value, :url, :ref, :props, :ts)`, {
    id: uid(), pid: project.id, lid: lead.id, anon: anon ?? null,
    name: String(event.name || 'track').slice(0, 120), stage: stageKey ?? null, value,
    url, ref: referrer, props: JSON.stringify(event.props ?? {}), ts,
  });

  advance(lead, stageKey, stages, ts, value);
  return lead.id;
}

function validTs(ts) {
  const t = ts ? Date.parse(ts) : NaN;
  // Client clocks are wrong often enough; refuse anything in the future or absurdly old.
  if (Number.isNaN(t) || t > Date.now() + 60_000 || t < Date.now() - 365 * 86400_000) return now();
  return new Date(t).toISOString();
}

export function touchFrom(url, referrer, props = {}) {
  const params = {};
  try {
    if (url) for (const [k, v] of new URL(url).searchParams) params[k.toLowerCase()] = v;
  } catch { /* a malformed URL simply contributes no params */ }
  for (const k of [...UTM_KEYS, ...CLICK_ID_KEYS, 'run_channel']) {
    if (props[k] != null && params[k] == null) params[k] = String(props[k]);
  }
  const t = { params, referrer, run_channel: params.run_channel };
  for (const k of UTM_KEYS) t[k] = params[k] ?? null;
  t.tagged = UTM_KEYS.some((k) => t[k]) || CLICK_ID_KEYS.some((k) => params[k]) || !!params.run_channel;
  return t;
}

const firstClickId = (params) => CLICK_ID_KEYS.map((k) => params[k]).find(Boolean) ?? null;

function findLead(projectId, { anon, email, external_id }) {
  // Session identity comes first — the visitor in front of us is this browser, and any
  // email on the event is a claim about who that browser belongs to, resolved in merge.
  if (anon) {
    const byAnon = get('SELECT * FROM leads WHERE project_id = :p AND anon_id = :a', { p: projectId, a: anon });
    if (byAnon) return byAnon;
  }
  if (external_id) {
    const byExt = get('SELECT * FROM leads WHERE project_id = :p AND external_id = :e', { p: projectId, e: external_id });
    if (byExt) return byExt;
  }
  if (email) {
    const byEmail = get('SELECT * FROM leads WHERE project_id = :p AND email = :e', { p: projectId, e: normEmail(email) });
    if (byEmail) return byEmail;
  }
  return null;
}

function createLead(project, channels, { anon, ts, touch, url, referrer, country }) {
  const { channel } = resolveChannel(channels, touch);
  const id = uid();
  run(`INSERT INTO leads (id, project_id, anon_id, channel_id, first_channel_id, campaign,
        utm_source, utm_medium, utm_campaign, utm_term, utm_content, click_id, referrer, landing_page,
        stage, value, status, country, first_seen, last_seen)
       VALUES (:id, :pid, :anon, :cid, :cid, :camp, :s, :m, :c, :t, :ct, :k, :ref, :url,
        'visit', 0, 'open', :country, :ts, :ts)`, {
    id, pid: project.id, anon: anon ?? null, cid: channel?.id ?? null, camp: touch.utm_campaign ?? null,
    s: touch.utm_source, m: touch.utm_medium, c: touch.utm_campaign, t: touch.utm_term, ct: touch.utm_content,
    k: firstClickId(touch.params), ref: referrer ?? null, url: url ?? null, country: country ?? null, ts,
  });
  return get('SELECT * FROM leads WHERE id = :id', { id });
}

const normEmail = (e) => String(e).trim().toLowerCase();

/**
 * identify() turns an anonymous visitor into a person. If that person already exists
 * (they signed up on another device), the two records are merged rather than duplicated —
 * the older record wins, because its first touch is the one that actually earned the lead.
 */
function applyIdentity(project, lead, { user_id, traits }) {
  const email = traits.email ? normEmail(traits.email) : null;
  const existing = email || user_id
    ? get(`SELECT * FROM leads WHERE project_id = :p AND id != :id AND (email = :e OR (external_id IS NOT NULL AND external_id = :u))`,
        { p: project.id, id: lead.id, e: email, u: user_id ?? null })
    : null;

  let target = lead;
  if (existing) {
    const [keep, drop] = existing.first_seen <= lead.first_seen ? [existing, lead] : [lead, existing];
    run('UPDATE events SET lead_id = :keep WHERE lead_id = :drop', { keep: keep.id, drop: drop.id });
    run(`UPDATE leads SET
           anon_id = COALESCE(anon_id, :anon),
           value = value + :val,
           last_seen = MAX(last_seen, :ls),
           channel_id = COALESCE(channel_id, :dropchan),
           first_channel_id = COALESCE(first_channel_id, :dropfirst)
         WHERE id = :id`,
      { id: keep.id, anon: drop.anon_id, val: drop.value, ls: drop.last_seen,
        dropchan: drop.channel_id, dropfirst: drop.first_channel_id });
    run('DELETE FROM leads WHERE id = :id', { id: drop.id });
    target = get('SELECT * FROM leads WHERE id = :id', { id: keep.id });
  }

  run(`UPDATE leads SET
         email = COALESCE(:email, email), name = COALESCE(:name, name),
         company = COALESCE(:company, company), external_id = COALESCE(:ext, external_id),
         country = COALESCE(:country, country)
       WHERE id = :id`, {
    id: target.id, email, name: traits.name ?? null, company: traits.company ?? null,
    ext: user_id ?? null, country: traits.country ?? null,
  });
  return get('SELECT * FROM leads WHERE id = :id', { id: target.id });
}

/** Conventional event names map onto the funnel without the customer wiring anything. */
const EVENT_STAGE_HINTS = {
  page: 'visit', pageview: 'visit', page_view: 'visit',
  signup: 'lead', sign_up: 'lead', lead: 'lead', form_submit: 'lead', demo_request: 'lead',
  qualified: 'qualified', mql: 'qualified',
  trial_started: 'trial', trial: 'trial', activated: 'trial',
  opportunity: 'opportunity', demo_booked: 'opportunity',
  purchase: 'customer', subscribed: 'customer', converted: 'customer', closed_won: 'customer',
};

function stageForEvent(name, stages) {
  const hint = EVENT_STAGE_HINTS[String(name ?? '').toLowerCase()];
  return hint && stages.some((s) => s.key === hint) ? hint : null;
}

/** Stages only move forward: a returning customer viewing the pricing page is still a customer. */
function advance(lead, stageKey, stages, ts, value) {
  const order = Object.fromEntries(stages.map((s, i) => [s.key, i]));
  const current = order[lead.stage] ?? -1;
  const next = stageKey != null ? (order[stageKey] ?? -1) : -1;
  const isConversion = stages.find((s) => s.key === stageKey)?.is_conversion === 1;
  run(`UPDATE leads SET
         stage = CASE WHEN :adv = 1 THEN :stage ELSE stage END,
         value = value + :value,
         status = CASE WHEN :won = 1 THEN 'won' ELSE status END,
         last_seen = MAX(last_seen, :ts)
       WHERE id = :id`, {
    id: lead.id, adv: next > current ? 1 : 0, stage: stageKey ?? lead.stage,
    value, won: isConversion ? 1 : 0, ts,
  });
}

export function listEventsForLead(leadId, limit = 200) {
  return all('SELECT * FROM events WHERE lead_id = :l ORDER BY ts DESC LIMIT :n', { l: leadId, n: limit });
}

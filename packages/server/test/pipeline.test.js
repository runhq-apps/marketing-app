import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDb, atDay, daysAgo, today } from './helpers.js';

useTempDb();
const store = await import('../src/store.js');
const { ingestBatch } = await import('../src/ingest.js');
const analytics = await import('../src/analytics.js');
const audit = await import('../src/audit.js');
const { all, get } = await import('../src/db.js');

function scenario() {
  const project = store.createProject({ name: `P${Math.random().toString(36).slice(2, 8)}`, website: 'https://example.com', target_cac: 100 });
  const capterra = store.createChannel(project.id, { provider: 'capterra', name: 'Capterra', auth_type: 'manual' });
  const meta = store.createChannel(project.id, { provider: 'meta_ads', name: 'Meta', auth_type: 'manual' });
  return { project, capterra, meta };
}

const send = (project, anon, events) => ingestBatch({ key: project.sdk_key, anon_id: anon, events });

test('a visit, a signup and a purchase become one lead with one channel', () => {
  const { project, capterra } = scenario();
  send(project, 'v1', [{ name: 'page', url: 'https://example.com/?utm_source=capterra&utm_medium=referral', ts: atDay(3) }]);
  send(project, 'v1', [{ name: 'signup', traits: { email: 'A@Corp.com', name: 'A' }, ts: atDay(2) }]);
  send(project, 'v1', [{ name: 'purchase', value: 500, ts: atDay(1) }]);

  const leads = all('SELECT * FROM leads WHERE project_id = :p', { p: project.id });
  assert.equal(leads.length, 1);
  assert.equal(leads[0].email, 'a@corp.com', 'email is normalised to lower case');
  assert.equal(leads[0].channel_id, capterra.id);
  assert.equal(leads[0].stage, 'customer');
  assert.equal(leads[0].value, 500);
  assert.equal(leads[0].status, 'won');
});

test('an anonymous session on a second device merges into the person who already exists', () => {
  const { project } = scenario();
  send(project, 'deviceA', [{ name: 'page', url: 'https://example.com/?utm_source=capterra', ts: atDay(9) }]);
  send(project, 'deviceA', [{ name: 'signup', traits: { email: 'b@corp.com' }, ts: atDay(9) }]);

  send(project, 'deviceB', [{ name: 'page', url: 'https://example.com/', ts: atDay(2) }]);
  send(project, 'deviceB', [{ name: 'purchase', value: 900, traits: { email: 'b@corp.com' }, ts: atDay(2) }]);

  const leads = all('SELECT * FROM leads WHERE project_id = :p', { p: project.id });
  assert.equal(leads.length, 1, 'the two sessions are one person');
  assert.equal(leads[0].value, 900);
  const events = all('SELECT * FROM events WHERE lead_id = :l', { l: leads[0].id });
  assert.equal(events.length, 4, 'the merged record keeps every event from both devices');
  assert.ok(leads[0].first_channel_id, 'first touch survives the merge');
});

test('stages only move forward', () => {
  const { project } = scenario();
  send(project, 'v3', [{ name: 'purchase', value: 100, traits: { email: 'c@corp.com' }, ts: atDay(5) }]);
  send(project, 'v3', [{ name: 'page', url: 'https://example.com/pricing', ts: atDay(1) }]);
  const lead = get('SELECT * FROM leads WHERE project_id = :p', { p: project.id });
  assert.equal(lead.stage, 'customer', 'a returning customer viewing a page is still a customer');
});

test('a client clock in the future does not create events in the future', () => {
  const { project } = scenario();
  const future = new Date(Date.now() + 86400_000 * 5).toISOString();
  send(project, 'v4', [{ name: 'page', url: 'https://example.com/', ts: future }]);
  const ev = get('SELECT * FROM events WHERE project_id = :p', { p: project.id });
  assert.ok(Date.parse(ev.ts) <= Date.now() + 60_000);
});

test('an unknown SDK key is rejected', () => {
  assert.throws(() => ingestBatch({ key: 'run_pk_nope', anon_id: 'x', events: [{ name: 'page' }] }), /not found/);
});

test('an empty batch is rejected', () => {
  const { project } = scenario();
  assert.throws(() => ingestBatch({ key: project.sdk_key, anon_id: 'x', events: [] }), /non-empty/);
});

test('unit economics: CAC, cost per lead and ROAS come out of spend and events', () => {
  const { project, capterra } = scenario();
  store.upsertSpend(project.id, capterra.id, [
    { date: daysAgo(2), spend: 400, clicks: 100, impressions: 5000 },
    { date: daysAgo(1), spend: 600, clicks: 150, impressions: 7000 },
  ], 'manual');

  for (let i = 0; i < 10; i++) {
    send(project, `lead${i}`, [{ name: 'page', url: 'https://example.com/?utm_source=capterra', ts: atDay(2) }]);
    send(project, `lead${i}`, [{ name: 'signup', traits: { email: `l${i}@corp.com` }, ts: atDay(2) }]);
  }
  send(project, 'lead0', [{ name: 'purchase', value: 2500, traits: { email: 'l0@corp.com' }, ts: atDay(1) }]);
  send(project, 'lead1', [{ name: 'purchase', value: 1500, traits: { email: 'l1@corp.com' }, ts: atDay(1) }]);

  const t = analytics.projectTotals(project.id, { from: daysAgo(5), to: today() });
  assert.equal(t.spend, 1000);
  assert.equal(t.leads, 10);
  assert.equal(t.customers, 2);
  assert.equal(t.revenue, 4000);
  assert.equal(t.cpl, 100);
  assert.equal(t.cac, 500);
  assert.equal(t.roas, 4);
  assert.equal(t.roi_pct, 300);
  assert.equal(t.cpc, 4);

  const rows = analytics.channelBreakdown(project.id, { from: daysAgo(5), to: today() });
  const cap = rows.find((r) => r.channel_id === capterra.id);
  assert.equal(cap.spend, 1000);
  assert.equal(cap.customers, 2);
  assert.equal(cap.roas, 4);
});

test('untagged leads are reported as Unattributed rather than folded into a channel', () => {
  const { project, capterra } = scenario();
  store.upsertSpend(project.id, capterra.id, [{ date: daysAgo(1), spend: 100 }], 'manual');
  send(project, 'anon1', [{ name: 'page', url: 'https://example.com/', ts: atDay(1) }]);
  send(project, 'anon1', [{ name: 'signup', traits: { email: 'z@corp.com' }, ts: atDay(1) }]);

  const rows = analytics.channelBreakdown(project.id, { from: daysAgo(5), to: today() });
  const un = rows.find((r) => r.channel_id === null);
  assert.ok(un, 'an Unattributed row exists');
  assert.equal(un.leads, 1);
  assert.equal(un.spend, 0);

  const totals = analytics.projectTotals(project.id, { from: daysAgo(5), to: today() });
  assert.equal(totals.unattributed_leads, 1);
});

test('first-touch and last-touch attribution credit different channels', () => {
  const { project, capterra, meta } = scenario();
  send(project, 'multi', [{ name: 'page', url: 'https://example.com/?utm_source=capterra', ts: atDay(6) }]);
  send(project, 'multi', [{ name: 'page', url: 'https://example.com/?utm_source=facebook', ts: atDay(3) }]);
  send(project, 'multi', [{ name: 'purchase', value: 1000, traits: { email: 'm@corp.com' }, ts: atDay(2) }]);

  const range = { from: daysAgo(10), to: today() };
  const last = analytics.channelBreakdown(project.id, { ...range, attribution: 'last' });
  const first = analytics.channelBreakdown(project.id, { ...range, attribution: 'first' });
  assert.equal(last.find((r) => r.channel_id === meta.id).revenue, 1000);
  assert.equal(first.find((r) => r.channel_id === capterra.id).revenue, 1000);
});

test('the funnel reports a null step rate when the stage above is empty', () => {
  const { project } = scenario();
  send(project, 'f1', [{ name: 'page', url: 'https://example.com/?utm_source=capterra', ts: atDay(2) }]);
  send(project, 'f1', [{ name: 'purchase', value: 10, traits: { email: 'f@corp.com' }, ts: atDay(1) }]);

  const stages = analytics.funnel(project.id, { from: daysAgo(5), to: today() });
  const qualified = stages.find((s) => s.key === 'qualified');
  const trial = stages.find((s) => s.key === 'trial');
  assert.equal(qualified.count, 0);
  assert.equal(trial.step_conversion_pct, null, 'no rate is stated when the previous stage is empty');
});

test('the audit reports spend with no leads, and stops reporting it once fixed', () => {
  const { project, meta } = scenario();
  store.upsertSpend(project.id, meta.id, [{ date: daysAgo(1), spend: 750 }], 'manual');
  send(project, 'other', [{ name: 'page', url: 'https://example.com/?utm_source=capterra', ts: atDay(1) }]);

  let findings = audit.runAudit(project);
  const dead = findings.find((f) => f.code === 'spend_no_leads' && f.scope_id === meta.id);
  assert.ok(dead, 'a channel that spends and produces nothing is a critical finding');
  assert.equal(dead.severity, 'critical');

  send(project, 'metavisit', [{ name: 'page', url: 'https://example.com/?utm_source=facebook', ts: atDay(1) }]);
  findings = audit.runAudit(project);
  assert.ok(!findings.some((f) => f.code === 'spend_no_leads' && f.scope_id === meta.id),
    'the finding closes once the channel produces leads');
});

test('a dismissed finding stays dismissed across re-runs', () => {
  const { project, meta } = scenario();
  store.upsertSpend(project.id, meta.id, [{ date: daysAgo(1), spend: 900 }], 'manual');
  const findings = audit.runAudit(project);
  const target = findings.find((f) => f.code === 'spend_no_leads');
  audit.setFindingStatus(target.id, 'dismissed');

  audit.runAudit(project);
  const open = audit.listFindings(project.id).map((f) => f.id);
  assert.ok(!open.includes(target.id), 'it does not come back as open');
  assert.equal(get('SELECT status FROM audit_findings WHERE id = :id', { id: target.id }).status, 'dismissed');
});

test('health score degrades with severity but never collapses to zero', () => {
  const { project } = scenario();
  audit.runAudit(project);
  const h = audit.healthScore(project.id);
  assert.ok(h.score >= 1 && h.score <= 100);
  assert.equal(h.open, audit.listFindings(project.id).length);
});

test('deleting a project takes its leads, events and spend with it', () => {
  const { project, capterra } = scenario();
  store.upsertSpend(project.id, capterra.id, [{ date: daysAgo(1), spend: 10 }], 'manual');
  send(project, 'gone', [{ name: 'page', url: 'https://example.com/', ts: atDay(1) }]);
  store.deleteProject(project.id);
  assert.equal(get('SELECT COUNT(*) AS n FROM leads WHERE project_id = :p', { p: project.id }).n, 0);
  assert.equal(get('SELECT COUNT(*) AS n FROM events WHERE project_id = :p', { p: project.id }).n, 0);
  assert.equal(get('SELECT COUNT(*) AS n FROM spend_daily WHERE project_id = :p', { p: project.id }).n, 0);
});

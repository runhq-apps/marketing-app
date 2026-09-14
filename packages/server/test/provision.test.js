import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDb } from './helpers.js';

useTempDb();
const { provision, loadSpec } = await import('../src/provision.js');
const store = await import('../src/store.js');
const { ingestBatch } = await import('../src/ingest.js');
const { get } = await import('../src/db.js');

const SPEC = {
  project: { name: 'Spec Co', website: 'https://spec.test', currency: 'USD', target_cac: 40 },
  stages: [
    { key: 'visit', label: 'Landed', is_conversion: false },
    { key: 'lead', label: 'Signed up', is_conversion: false },
    { key: 'customer', label: 'Paid', is_conversion: true },
  ],
  channels: [
    { provider: 'x_ads', name: 'X Ads', auth_type: 'manual', config: { match: { utm_source: ['x'] } } },
    { provider: 'content_seo', name: 'Organic', auth_type: 'manual' },
  ],
};

test('a spec creates the project, its funnel and its channels', () => {
  const plan = provision(SPEC);
  assert.equal(plan.created, true);
  assert.equal(plan.slug, 'spec-co');
  assert.deepEqual(plan.stages, ['visit', 'lead', 'customer']);
  assert.deepEqual(plan.channels.map((c) => c.created), [true, true]);

  const project = store.getProject('spec-co');
  assert.equal(project.website, 'https://spec.test');
  assert.equal(project.target_cac, 40);
  assert.match(project.sdk_key, /^run_pk_/);
});

test('applying the same spec again changes nothing that is running', () => {
  const before = store.getProject('spec-co');
  const channel = store.listChannels(before.id).find((c) => c.provider === 'x_ads');
  store.updateChannel(channel.id, { credentials: { token: 'secret-token' } });
  store.upsertSpend(before.id, channel.id, [{ date: '2026-01-01', spend: 12.5 }], 'manual');

  const plan = provision(SPEC);

  assert.equal(plan.created, false);
  assert.deepEqual(plan.channels.map((c) => c.created), [false, false],
    'a channel already there is matched, not duplicated');
  assert.equal(store.listChannels(before.id).length, 2);

  const after = store.getProject('spec-co');
  assert.equal(after.sdk_key, before.sdk_key, 'the key is the one already installed on the site');
  assert.equal(after.id, before.id);

  const reloaded = store.getChannel(channel.id);
  assert.equal(store.channelCredentials(reloaded).token, 'secret-token', 'credentials are not the spec\'s business');
  assert.equal(store.channelConfig(reloaded).match.utm_source[0], 'x');
  assert.equal(get('SELECT COUNT(*) AS n FROM spend_daily WHERE channel_id = :c', { c: channel.id }).n, 1,
    'and the spend recorded against it survives');
});

test('a re-applied funnel keeps the stage a lead had already reached', () => {
  const project = store.getProject('spec-co');
  ingestBatch({ key: project.sdk_key, anon_id: 'anon-1', events: [
    { name: 'signup', traits: { email: 'someone@spec.test' } },
  ] });
  const before = get('SELECT * FROM leads WHERE project_id = :p', { p: project.id });
  assert.equal(before.stage, 'lead');

  provision(SPEC);

  const after = get('SELECT * FROM leads WHERE id = :id', { id: before.id });
  assert.equal(after.stage, 'lead');
  assert.equal(store.projectStages(project.id).length, 3, 'the stages are replaced, not appended to');
});

test('a spec is refused before anything is written when it cannot be applied', () => {
  assert.throws(() => provision({ project: { name: 'Nope' }, channels: [{ provider: 'not_a_platform' }] }),
    /unknown provider/);
  assert.equal(store.getProject('nope'), null, 'and no half-made project is left behind');

  assert.throws(() => provision({
    project: { name: 'Nope' },
    stages: [{ key: 'visit', label: 'Landed' }],
  }), /conversion/);
  assert.throws(() => provision({ project: {} }), /project.name/);
});

test('a dry run reports what it would do and touches nothing', () => {
  const plan = provision({ ...SPEC, project: { ...SPEC.project, name: 'Dry Co' } }, { dryRun: true });
  assert.equal(plan.created, true);
  assert.deepEqual(plan.channels.map((c) => c.created), [true, true]);
  assert.equal(store.getProject('dry-co'), null);
});

test('the rooftop spec in this repo is one the provisioner accepts', async () => {
  const spec = await loadSpec(new URL('../../../projects/rooftop.mjs', import.meta.url).pathname);
  const plan = provision(spec, { dryRun: true });

  assert.equal(plan.slug, 'rooftop');
  assert.ok(spec.stages.some((s) => s.is_conversion), 'something has to count as a sale');
  // The keys public/js/marketing.js in the rooftop checkout sends with runhq.stage().
  assert.deepEqual(plan.stages, ['visit', 'verified', 'lead', 'player', 'customer']);
});

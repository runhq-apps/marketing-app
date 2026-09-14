import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDb } from './helpers.js';

useTempDb();
process.env.PORT = '0';

const { server } = await import('../src/index.js');
const { provision, installSnippet } = await import('../scripts/provision.mjs');

let host;
before(async () => {
  if (!server.listening) await new Promise((r) => server.once('listening', r));
  host = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const SPEC = {
  project: { name: 'Arrr Fun', website: 'https://www.arrr.fun', currency: 'USD' },
  stages: [
    { key: 'visit', label: 'Visit' },
    { key: 'played', label: 'Played a match' },
    { key: 'customer', label: 'Paid', is_conversion: true },
  ],
  channels: [
    { provider: 'manual', name: 'Creator payouts', config: { match: { utm_medium: ['affiliate'] } } },
  ],
};

test('a spec creates the project, its funnel and its channels', async () => {
  const { project, changes, created } = await provision(SPEC, { host });
  assert.equal(created, true);
  assert.equal(project.slug, 'arrr-fun');
  assert.match(project.sdk_key, /^run_pk_/);
  assert.deepEqual(project.stages.map((s) => s.key), ['visit', 'played', 'customer']);
  assert.equal(project.stages.at(-1).is_conversion, 1);
  assert.ok(changes.some((c) => c.includes('create project')));
  assert.ok(changes.some((c) => c.includes('Creator payouts')));
});

test('re-running the same spec changes nothing and keeps the SDK key', async () => {
  const first = await provision(SPEC, { host });
  const again = await provision(SPEC, { host });
  assert.deepEqual(again.changes, []);
  assert.equal(again.created, false);
  // The key is what is pasted into every site; a re-run that rotated it would
  // silently stop collecting from all of them.
  assert.equal(again.project.sdk_key, first.project.sdk_key);
});

test('an edited spec is applied in place', async () => {
  const edited = {
    ...SPEC,
    project: { ...SPEC.project, target_cac: 12 },
    stages: [...SPEC.stages.slice(0, 2), { key: 'store', label: 'Opened checkout' }, SPEC.stages[2]],
    channels: [...SPEC.channels, { provider: 'x_ads', name: 'X Ads' }],
  };
  const { project, changes } = await provision(edited, { host });
  assert.equal(project.target_cac, 12);
  assert.deepEqual(project.stages.map((s) => s.key), ['visit', 'played', 'store', 'customer']);
  assert.ok(changes.some((c) => c.includes('funnel stages')));
  assert.ok(changes.some((c) => c.includes('X Ads')));

  const channels = await (await fetch(`${host}/api/projects/${project.id}/channels`)).json();
  assert.equal(channels.length, 2);
});

test('a channel dropped from the spec is reported, never deleted', async () => {
  const withoutXAds = {
    ...SPEC,
    project: { ...SPEC.project, target_cac: 12 },
    stages: [...SPEC.stages.slice(0, 2), { key: 'store', label: 'Opened checkout' }, SPEC.stages[2]],
  };
  const { project, changes } = await provision(withoutXAds, { host });
  assert.ok(changes.some((c) => c.includes('left alone') && c.includes('X Ads')));

  const channels = await (await fetch(`${host}/api/projects/${project.id}/channels`)).json();
  assert.equal(channels.length, 2, 'spend history survives a spec edit');
});

test('a spec key the server will slugify does not re-post the funnel forever', async () => {
  // The API slugifies stage keys on the way in, so `signed_in` is stored as `signed-in`.
  // Comparing raw spec keys made a settled project look permanently out of date.
  const spec = {
    project: { name: 'Slug Keys' },
    stages: [{ key: 'visit', label: 'Visit' }, { key: 'signed_in', label: 'Signed in' },
      { key: 'customer', label: 'Paid', is_conversion: true }],
  };
  const first = await provision(spec, { host });
  assert.deepEqual(first.project.stages.map((s) => s.key), ['visit', 'signed-in', 'customer']);
  // The create call carries the stages, so no follow-up funnel write is needed at all.
  assert.equal(first.changes.filter((c) => c.includes('funnel stages')).length, 0);

  const again = await provision(spec, { host });
  assert.deepEqual(again.changes, []);
});

test('a dry run reports the work without doing it', async () => {
  const spec = { project: { name: 'Nothing Doing' }, stages: SPEC.stages };
  const { changes } = await provision(spec, { host, dryRun: true });
  assert.ok(changes.some((c) => c.includes('create project nothing-doing')));

  const projects = await (await fetch(`${host}/api/projects`)).json();
  assert.equal(projects.some((p) => p.slug === 'nothing-doing'), false);
});

test('the printed snippet carries the real key and collector host', async () => {
  const { project } = await provision(SPEC, { host: host });
  const snippet = installSnippet(project, 'https://run.example.com/');
  assert.equal(
    snippet,
    `<script async src="https://run.example.com/sdk.js" data-runhq-key="${project.sdk_key}"></script>`,
  );
});

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { useTempDb, daysAgo, today } from './helpers.js';

useTempDb();
process.env.PORT = '0'; // let the OS pick a free port

const { server } = await import('../src/index.js');
let base;

before(async () => {
  if (!server.listening) await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const call = async (path, init) => {
  const res = await fetch(base + path, {
    ...init,
    headers: init?.body ? { 'content-type': 'application/json' } : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, res };
};
const post = (path, body) => call(path, { method: 'POST', body: JSON.stringify(body) });

test('health reports the service is up', async () => {
  const { status, body } = await call('/api/health');
  assert.equal(status, 200);
  assert.equal(body.ok, true);
});

test('the provider catalogue is served without leaking function internals', async () => {
  const { body } = await call('/api/providers');
  assert.ok(body.providers.length >= 10);
  assert.ok(body.auth_types.credentials.help.length > 10);
  assert.equal(JSON.stringify(body).includes('function'), false);
});

test('a project can be created, read, listed and reached by slug', async () => {
  const created = await post('/api/projects', { name: 'Acme Rockets', website: 'https://example.com', target_cac: 250 });
  assert.equal(created.status, 201);
  assert.equal(created.body.slug, 'acme-rockets');
  assert.match(created.body.sdk_key, /^run_pk_/);

  const bySlug = await call('/api/projects/acme-rockets');
  assert.equal(bySlug.body.id, created.body.id);
  assert.equal(bySlug.body.stages.length, 6);

  const list = await call('/api/projects');
  assert.ok(list.body.some((p) => p.id === created.body.id));
});

test('a second project with the same name gets a distinct slug', async () => {
  const a = await post('/api/projects', { name: 'Duplicate' });
  const b = await post('/api/projects', { name: 'Duplicate' });
  assert.notEqual(a.body.slug, b.body.slug);
});

test('a project without a name is rejected with a message, not a stack trace', async () => {
  const { status, body } = await post('/api/projects', { website: 'https://x.io' });
  assert.equal(status, 400);
  assert.match(body.error, /name is required/);
});

test('an unknown project is a 404', async () => {
  const { status, body } = await call('/api/projects/does-not-exist');
  assert.equal(status, 404);
  assert.match(body.error, /not found/);
});

test('the full loop: channel, spend, SDK events, dashboard, audit', async () => {
  const project = (await post('/api/projects', { name: 'Loop Co', website: 'https://example.com', target_cac: 200 })).body;

  const channel = (await post(`/api/projects/${project.slug}/channels`, {
    provider: 'capterra', name: 'Capterra', auth_type: 'manual',
  })).body;
  assert.equal(channel.credentials, undefined, 'credentials are never returned');
  assert.equal(channel.provider_label, 'Capterra');

  const spend = await post(`/api/channels/${channel.id}/spend`, { from: daysAgo(4), to: daysAgo(1), total: 800 });
  assert.equal(spend.body.rows, 4);

  // Five visitors arrive from Capterra; three sign up; one buys.
  for (let i = 0; i < 5; i++) {
    await post('/api/collect', {
      key: project.sdk_key, anon_id: `visitor${i}`,
      events: [{ name: 'page', url: 'https://example.com/?utm_source=capterra&utm_medium=referral' }],
    });
  }
  for (let i = 0; i < 3; i++) {
    await post('/api/collect', {
      key: project.sdk_key, anon_id: `visitor${i}`,
      events: [{ name: 'signup', traits: { email: `buyer${i}@corp.com`, company: 'Corp' } }],
    });
  }
  const purchase = await post('/api/collect', {
    key: project.sdk_key, anon_id: 'visitor0',
    events: [{ name: 'purchase', value: 1200, traits: { email: 'buyer0@corp.com' } }],
  });
  assert.equal(purchase.status, 202);

  const summary = (await call(`/api/projects/${project.slug}/summary?days=30`)).body;
  assert.equal(summary.totals.leads, 5);
  assert.equal(summary.totals.customers, 1);
  assert.equal(summary.totals.revenue, 1200);
  assert.equal(summary.totals.spend, 800);
  assert.equal(summary.totals.cac, 800);
  assert.equal(summary.totals.roas, 1.5);
  assert.equal(summary.channels[0].name, 'Capterra');
  assert.equal(summary.channels[0].leads, 5);
  assert.equal(summary.series.length, 30);

  const leads = (await call(`/api/projects/${project.slug}/leads?days=30`)).body;
  assert.equal(leads.total, 5);
  const buyer = leads.rows.find((l) => l.email === 'buyer0@corp.com');
  assert.equal(buyer.channel_name, 'Capterra');
  assert.equal(buyer.stage, 'customer');

  const detail = (await call(`/api/leads/${buyer.id}`)).body;
  assert.ok(detail.events.length >= 3);
  assert.equal(detail.utm_source, 'capterra');

  const audited = (await post(`/api/projects/${project.slug}/audit`, { scan: false })).body;
  assert.ok(audited.findings.length > 0);
  assert.ok(audited.health.score <= 100);

  const csv = await fetch(`${base}/api/projects/${project.slug}/leads.csv?days=30`);
  const text = await csv.text();
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  assert.match(text.split('\n')[0], /^first_seen,last_seen,email/);
  assert.equal(text.trim().split('\n').length, 6, 'a header row and five leads');
});

test('the account overview totals every project and carries each one its own series', async () => {
  const { body } = await call('/api/overview?days=30');
  assert.ok(body.projects.length >= 3);
  for (const p of body.projects) {
    assert.equal(p.series.length, 30);
    assert.ok('score' in p.health);
    assert.ok('roas' in p.totals);
  }
  assert.equal(
    Math.round(body.account.spend),
    Math.round(body.projects.reduce((n, p) => n + p.totals.spend, 0)),
  );
});

test('collect rejects an unknown key and a missing key', async () => {
  assert.equal((await post('/api/collect', { key: 'run_pk_nope', anon_id: 'a', events: [{ name: 'page' }] })).status, 404);
  assert.equal((await post('/api/collect', { anon_id: 'a', events: [{ name: 'page' }] })).status, 400);
});

test('the tracking pixel fallback always returns a GIF, even on bad input', async () => {
  const res = await fetch(`${base}/api/collect.gif?d=not-valid-base64`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/gif');
});

test('the pixel fallback ingests a base64url payload', async () => {
  const project = (await post('/api/projects', { name: 'Pixel Co' })).body;
  const payload = Buffer.from(JSON.stringify({
    key: project.sdk_key, anon_id: 'pixel1', events: [{ name: 'page', url: 'https://x.io/?utm_source=capterra' }],
  })).toString('base64url');
  await fetch(`${base}/api/collect.gif?d=${payload}`);
  const leads = (await call(`/api/projects/${project.slug}/leads?days=7`)).body;
  assert.equal(leads.total, 1);
});

test('collect verify answers for a real key and a fake one', async () => {
  const project = (await post('/api/projects', { name: 'Verify Co' })).body;
  assert.equal((await call(`/api/collect/verify?key=${project.sdk_key}`)).body.ok, true);
  assert.equal((await call('/api/collect/verify?key=run_pk_fake')).status, 404);
});

test('the collector is CORS-open and the admin API is not', async () => {
  const collect = await fetch(`${base}/api/collect/verify?key=x`);
  assert.equal(collect.headers.get('access-control-allow-origin'), '*');
  const admin = await fetch(`${base}/api/projects`);
  assert.equal(admin.headers.get('access-control-allow-origin'), null);
});

test('a wrong method on a real route is 405, an unknown API path is 404', async () => {
  assert.equal((await call('/api/health', { method: 'DELETE' })).status, 405);
  assert.equal((await call('/api/nope')).status, 404);
});

test('funnel stages can be redefined and the conversion stage drives customers', async () => {
  const project = (await post('/api/projects', { name: 'Stage Co' })).body;
  const stages = await post(`/api/projects/${project.slug}/stages`, {
    stages: [
      { key: 'visit', label: 'Visit' },
      { key: 'demo', label: 'Demo' },
      { key: 'paid', label: 'Paid', is_conversion: 1 },
    ],
  });
  assert.equal(stages.body.length, 3);
  assert.equal(stages.body[2].is_conversion, 1);

  await post('/api/collect', {
    key: project.sdk_key, anon_id: 'stage1',
    events: [{ name: 'went_paid', stage: 'paid', value: 300, traits: { email: 's@corp.com' } }],
  });
  const summary = (await call(`/api/projects/${project.slug}/summary?days=7`)).body;
  assert.equal(summary.totals.customers, 1);
  assert.equal(summary.funnel.at(-1).count, 1);
});

test('a finding can be dismissed through the API', async () => {
  const project = (await post('/api/projects', { name: 'Dismiss Co' })).body;
  const { findings } = (await post(`/api/projects/${project.slug}/audit`, { scan: false })).body;
  const target = findings[0];
  const patched = await call(`/api/findings/${target.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'dismissed' }) });
  assert.equal(patched.body.status, 'dismissed');
  const open = (await call(`/api/projects/${project.slug}/audit`)).body.findings.map((f) => f.id);
  assert.ok(!open.includes(target.id));
});

test('an invalid finding status is refused', async () => {
  const { status } = await call('/api/findings/whatever', { method: 'PATCH', body: JSON.stringify({ status: 'lol' }) });
  assert.equal(status, 400);
});

test('the SPA entry point is served for unknown non-API paths', async () => {
  const res = await fetch(`${base}/p/some-project/leads`);
  // 200 with the built index.html, or a clear 404 explaining the UI is not built yet.
  assert.ok([200, 404].includes(res.status));
  if (res.status === 200) assert.match(res.headers.get('content-type'), /text\/html/);
});

/* ----------------------------------------------------------------- revenue */

/**
 * Stripe is stubbed at the network edge; every other host — including this test's own
 * requests back into the server — goes through untouched.
 */
function withStripeStub(handler) {
  const real = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const s = String(url);
    if (!s.startsWith('https://api.stripe.com')) return real(url, opts);
    const path = new URL(s).pathname;
    const body = handler(path, opts);
    return new Response(JSON.stringify(body ?? {}), {
      status: body ? 200 : 404, headers: { 'content-type': 'application/json' },
    });
  };
  return () => { globalThis.fetch = real; };
}

const stripeAccount = { id: 'acct_api', settings: { dashboard: { display_name: 'API Test Co' } }, default_currency: 'usd' };

async function connectStripe(slug) {
  const restore = withStripeStub((path) => (
    path === '/v1/account' ? stripeAccount
    : path === '/v1/charges' || path === '/v1/refunds' || path === '/v1/subscriptions' ? { data: [], has_more: false }
    : null));
  try {
    return await post(`/api/projects/${slug}/revenue/sources`, {
      provider: 'stripe',
      credentials: { secret_key: 'sk_test_api', webhook_secret: 'whsec_apitest' },
    });
  } finally { restore(); }
}

test('a Stripe account can be connected, and the key never comes back out', async () => {
  await post('/api/projects', { name: 'Revenue Co' });
  const created = await connectStripe('revenue-co');

  assert.equal(created.status, 201);
  assert.equal(created.body.account_name, 'API Test Co');
  assert.equal(created.body.livemode, false, 'sk_test_ is a test-mode connection');
  assert.equal(JSON.stringify(created.body).includes('sk_test_api'), false);
  assert.equal(created.body.credential_state.fields.secret_key, '••••_api', 'masked to the last four');
  assert.match(created.body.webhook_path, /^\/api\/revenue\/stripe\//);

  const catalogue = await call('/api/providers');
  assert.ok(catalogue.body.revenue_providers.some((p) => p.id === 'stripe'));
});

test('the revenue endpoint reports an empty but connected account honestly', async () => {
  await post('/api/projects', { name: 'Quiet Books' });
  await connectStripe('quiet-books');

  const { status, body } = await call('/api/projects/quiet-books/revenue?days=30');
  assert.equal(status, 200);
  assert.equal(body.connected, true);
  assert.equal(body.gross, 0);
  assert.equal(body.recurring.mrr, 0);
  assert.equal(body.sources.length, 1);
  assert.equal(body.series.length, 30, 'a day per day in range, zeros included');
});

test('a Stripe webhook is applied only when its signature checks out', async () => {
  const project = await post('/api/projects', { name: 'Hooked Up' });
  const source = await connectStripe('hooked-up');
  const path = source.body.webhook_path;

  const event = JSON.stringify({
    id: 'evt_api', type: 'charge.succeeded',
    data: { object: {
      id: 'ch_api', status: 'succeeded', paid: true, amount: 12300, currency: 'usd', livemode: true,
      created: Math.floor(Date.now() / 1000), billing_details: { email: 'hook@example.com' }, customer: 'cus_api',
    } },
  });
  const sign = (secret) => {
    const t = Math.floor(Date.now() / 1000);
    return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${event}`).digest('hex')}`;
  };

  const forged = await fetch(base + path, {
    method: 'POST', body: event, headers: { 'stripe-signature': sign('whsec_wrong') },
  });
  assert.equal(forged.status, 400, 'a body signed with the wrong secret is refused');

  const unsigned = await fetch(base + path, { method: 'POST', body: event });
  assert.equal(unsigned.status, 400);

  const stranger = await fetch(`${base}/api/revenue/stripe/does-not-exist`, {
    method: 'POST', body: event, headers: { 'stripe-signature': sign('whsec_apitest') },
  });
  assert.equal(stranger.status, 400, 'an unknown source id answers like a bad signature, not a 404');

  const real = await fetch(base + path, {
    method: 'POST', body: event, headers: { 'stripe-signature': sign('whsec_apitest') },
  });
  assert.equal(real.status, 200);
  assert.equal((await real.json()).applied, true);

  const revenue = await call(`/api/projects/${project.body.slug}/revenue?days=7`);
  assert.equal(revenue.body.gross, 123);
  assert.equal(revenue.body.paying_customers, 1);

  const summary = await call(`/api/projects/${project.body.slug}/summary?days=7`);
  assert.equal(summary.body.totals.revenue, 123, 'the payment is revenue everywhere, not just on its own tab');
  assert.equal(summary.body.revenue.connected, true);
});

test('the webhook endpoint is reachable without the admin token the API requires', async () => {
  const routes = await call('/api/revenue/stripe/anything', { method: 'POST', body: '{}' });
  assert.notEqual(routes.status, 401, 'Stripe cannot present an admin token and must not need one');
  assert.notEqual(routes.status, 404, 'the route exists');
});

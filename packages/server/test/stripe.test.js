import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { useTempDb, atDay, daysAgo, today } from './helpers.js';

useTempDb();
const store = await import('../src/store.js');
const { ingestBatch } = await import('../src/ingest.js');
const analytics = await import('../src/analytics.js');
const audit = await import('../src/audit.js');
const revenue = await import('../src/revenue/index.js');
const metrics = await import('../src/revenue/metrics.js');
const stripe = await import('../src/revenue/stripe.js');
const { all, get } = await import('../src/db.js');

/* ------------------------------------------------------------- unit bits */

test('amounts convert out of the smallest unit the currency actually has', () => {
  assert.equal(stripe.fromMinor(4999, 'usd'), 49.99);
  assert.equal(stripe.fromMinor(500, 'jpy'), 500, 'yen has no cents — 500 is ¥500, not ¥5');
  assert.equal(stripe.fromMinor(1500, 'kwd'), 1.5, 'the dinar is quoted in thousandths');
  assert.equal(stripe.fromMinor(0, 'eur'), 0);
});

test('a price is normalised to a month whatever it is billed on', () => {
  assert.equal(stripe.monthlyValue(100, 'month'), 100);
  assert.equal(stripe.monthlyValue(1200, 'year'), 100);
  assert.equal(stripe.monthlyValue(600, 'month', 6), 100, 'billed every 6 months');
  assert.ok(Math.abs(stripe.monthlyValue(25, 'week') - 108.71) < 0.02);
  assert.equal(stripe.monthlyValue(100, 'fortnight'), 0, 'an interval Stripe does not have contributes nothing');
});

/* --------------------------------------------------------- webhook auth */

const signed = (body, secret, { at = Date.now(), scheme = 'v1' } = {}) => {
  const t = Math.floor(at / 1000);
  const sig = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  return `t=${t},${scheme}=${sig}`;
};

test('a webhook signature is accepted only when it matches the body it was made for', () => {
  const body = JSON.stringify({ id: 'evt_1', type: 'charge.succeeded' });
  const secret = 'whsec_testsecret';

  assert.equal(stripe.verifyWebhookSignature(body, signed(body, secret), secret).ok, true);
  assert.equal(stripe.verifyWebhookSignature(body, signed(body, 'whsec_other'), secret).ok, false);
  assert.equal(stripe.verifyWebhookSignature(`${body} `, signed(body, secret), secret).ok, false,
    'one extra byte in the body invalidates the signature');
  assert.equal(stripe.verifyWebhookSignature(body, signed(body, secret), null).ok, false);
  assert.equal(stripe.verifyWebhookSignature(body, 'garbage', secret).ok, false);
  assert.equal(stripe.verifyWebhookSignature(body, '', secret).ok, false);
});

test('a replayed webhook is rejected once it falls outside the tolerance', () => {
  const body = '{"id":"evt_2"}';
  const secret = 'whsec_testsecret';
  const old = signed(body, secret, { at: Date.now() - 20 * 60_000 });
  const result = stripe.verifyWebhookSignature(body, old, secret);
  assert.equal(result.ok, false);
  assert.match(result.error, /replay/);
  assert.equal(stripe.verifyWebhookSignature(body, old, secret, { toleranceSec: 3600 }).ok, true,
    'a wider tolerance accepts the same header');
});

test('a header carrying several v1 signatures passes if any one of them matches', () => {
  const body = '{"id":"evt_3"}';
  const secret = 'whsec_rotating';
  const t = Math.floor(Date.now() / 1000);
  const good = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  const header = `t=${t},v1=${'0'.repeat(64)},v1=${good}`;
  assert.equal(stripe.verifyWebhookSignature(body, header, secret).ok, true);
});

/* ------------------------------------------------------- payload shapes */

test('a charge becomes a payment with the payer, the money and the moment', () => {
  const row = stripe.normaliseCharge({
    id: 'ch_x', status: 'succeeded', paid: true, amount: 49900, currency: 'usd',
    created: 1_700_000_000, description: 'Pro plan', invoice: 'in_x', livemode: true,
    billing_details: { email: 'Payer@Example.com', name: 'Payer' },
    customer: { id: 'cus_x', email: 'other@example.com' },
  });
  assert.equal(row.amount, 499);
  assert.equal(row.kind, 'payment');
  assert.equal(row.email, 'Payer@Example.com', 'the address that paid wins over the one on file');
  assert.equal(row.customer_ref, 'cus_x');
  assert.equal(row.invoice_ref, 'in_x');
  assert.equal(row.occurred_at, new Date(1_700_000_000_000).toISOString());
});

test("a charge carries the product's own id for the payer when it was stamped on it", () => {
  assert.equal(stripe.userRefFrom({ user_id: 'x:4417' }), 'x:4417');
  assert.equal(stripe.userRefFrom({ run_user_id: 'x:1', user_id: 'x:2' }), 'x:1', 'the explicit key wins');
  assert.equal(stripe.userRefFrom({ user: 99 }), '99', 'a number is still an id');
  assert.equal(stripe.userRefFrom({ gold: '500' }), null, 'metadata that names no user is not one');
  assert.equal(stripe.userRefFrom(null), null);

  const row = stripe.normaliseCharge({
    id: 'ch_m', status: 'succeeded', paid: true, amount: 499, currency: 'usd', created: 1_700_000_000,
    metadata: { user: 'x:4417', gold: '500' },
    billing_details: { email: null, name: null },
  });
  assert.equal(row.user_ref, 'x:4417');
  assert.equal(row.customer_ref, null, 'a one-off Checkout session creates no Stripe customer');
});

test('a refund is a negative payment dated when the refund happened', () => {
  const row = stripe.normaliseRefund({
    id: 're_x', charge: 'ch_x', amount: 2000, currency: 'usd', created: 1_700_100_000, status: 'succeeded',
  });
  assert.equal(row.amount, -20);
  assert.equal(row.kind, 'refund');
  assert.equal(row.charge_ref, 'ch_x');
});

test('a multi-item subscription sums to one monthly figure', () => {
  const row = stripe.normaliseSubscription({
    id: 'sub_x', status: 'active', currency: 'usd', start_date: 1_700_000_000,
    customer: { id: 'cus_x', email: 'a@example.com' },
    items: { data: [
      { quantity: 3, price: { unit_amount: 2000, currency: 'usd', nickname: 'Seat', recurring: { interval: 'month', interval_count: 1 } } },
      { quantity: 1, price: { unit_amount: 120000, currency: 'usd', nickname: 'Support', recurring: { interval: 'year', interval_count: 1 } } },
    ] },
  });
  assert.equal(row.mrr, 160, '3 seats at $20 plus $1200/yr of support');
  assert.equal(row.plan, 'Seat + Support');
  assert.equal(row.email, 'a@example.com');
});

/* ------------------------------------------------------ the sync, end to end */

const ACCOUNT = { id: 'acct_123', settings: { dashboard: { display_name: 'Acme Inc' } }, default_currency: 'usd', charges_enabled: true };

const charge = (id, email, amount, day, extra = {}) => ({
  id, status: 'succeeded', paid: true, amount, currency: 'usd', livemode: true,
  created: Math.floor(Date.parse(atDay(day)) / 1000),
  billing_details: { email, name: null }, customer: `cus_${email.split('@')[0]}`, ...extra,
});

let stripeData;
let realFetch;

/** Stands in for Stripe: the four endpoints this integration reads, and nothing else. */
function stubStripe(data) {
  stripeData = data;
  globalThis.fetch = async (url, opts) => {
    const u = new URL(String(url));
    assert.equal(opts.headers.authorization, 'Bearer sk_test_key');
    const body =
      u.pathname === '/v1/account' ? ACCOUNT
      : u.pathname === '/v1/charges' ? { data: stripeData.charges ?? [], has_more: false }
      : u.pathname === '/v1/refunds' ? { data: stripeData.refunds ?? [], has_more: false }
      : u.pathname === '/v1/subscriptions' ? { data: stripeData.subscriptions ?? [], has_more: false }
      : null;
    if (!body) return new Response(JSON.stringify({ error: { message: `no stub for ${u.pathname}` } }), { status: 404 });
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
}

beforeEach(() => { realFetch = globalThis.fetch; });
afterEach(() => { globalThis.fetch = realFetch; });

async function connected(data, { name = 'Stripe' } = {}) {
  const project = store.createProject({ name: `S${Math.random().toString(36).slice(2, 8)}`, target_cac: 100 });
  const google = store.createChannel(project.id, { provider: 'google_ads', name: 'Google Ads', auth_type: 'manual' });
  stubStripe(data);
  const source = await revenue.createRevenueSource(project.id, {
    provider: 'stripe', name,
    credentials: { secret_key: 'sk_test_key', webhook_secret: 'whsec_testsecret' },
  });
  return { project, google, source };
}

test('connecting verifies the key and records which account it belongs to', async () => {
  const { source } = await connected({});
  assert.equal(source.account_ref, 'acct_123');
  assert.equal(source.account_name, 'Acme Inc');
  assert.equal(source.livemode, 0, 'an sk_test_ key is a test-mode connection and is stored as one');
  assert.equal(source.status, 'ready');
  assert.equal(String(source.credentials).includes('sk_test_key'), false, 'the key is sealed, not stored in the clear');
});

test('a key the API rejects is reported, not stored', async () => {
  const project = store.createProject({ name: `Bad${Math.random().toString(36).slice(2, 6)}` });
  globalThis.fetch = async () => new Response(
    JSON.stringify({ error: { message: 'Invalid API Key provided: sk_test_***' } }), { status: 401 });
  await assert.rejects(
    () => revenue.createRevenueSource(project.id, { provider: 'stripe', credentials: { secret_key: 'sk_test_key' } }),
    /Invalid API Key/);
  assert.equal(revenue.listRevenueSources(project.id).length, 0);
});

test('the same Stripe account cannot be connected to one project twice', async () => {
  const { project } = await connected({});
  await assert.rejects(
    () => revenue.createRevenueSource(project.id, {
      provider: 'stripe', credentials: { secret_key: 'sk_test_key' },
    }), /already connected/);
});

test('payments land on the channel that found the customer, refunds come back off it', async () => {
  const { project, google, source } = await connected({
    charges: [charge('ch_1', 'alice@example.com', 10000, 5), charge('ch_2', 'bob@example.com', 5000, 4)],
    refunds: [{ id: 're_1', charge: 'ch_1', amount: 2000, currency: 'usd', status: 'succeeded',
      created: Math.floor(Date.parse(atDay(3)) / 1000), livemode: true }],
    subscriptions: [],
  });

  // Alice was tracked before she paid; Bob was never seen.
  ingestBatch({ key: project.sdk_key, anon_id: 'a1', events: [
    { name: 'page', url: 'https://x.test/?utm_source=google&gclid=abc', ts: atDay(9) },
    { name: 'signup', traits: { email: 'alice@example.com' }, ts: atDay(8) },
  ] });

  const result = await revenue.syncRevenueSource(source.id, { from: daysAgo(30), to: today() });
  assert.equal(result.payments, 3);
  assert.equal(result.matched, 3, 'the refund inherits the identity of the charge it reverses');

  const range = { from: daysAgo(30), to: today() };
  const totals = analytics.projectTotals(project.id, range);
  assert.equal(totals.revenue, 130, '$100 + $50 less a $20 refund');

  const rows = analytics.channelBreakdown(project.id, range);
  const byName = Object.fromEntries(rows.map((r) => [r.name, r]));
  assert.equal(byName['Google Ads'].revenue, 80, "Alice's payment, less her refund");
  assert.equal(byName.Unattributed.revenue, 50, 'Bob paid, but nothing knows what brought him');
  assert.equal(byName['Google Ads'].channel_id, google.id);

  const alice = get('SELECT * FROM leads WHERE project_id = :p AND email = :e',
    { p: project.id, e: 'alice@example.com' });
  assert.equal(alice.stage, 'customer');
  assert.equal(alice.status, 'won');
  assert.equal(alice.value, 80);

  const bob = get('SELECT * FROM leads WHERE project_id = :p AND email = :e', { p: project.id, e: 'bob@example.com' });
  assert.ok(bob, 'a customer nobody tracked still becomes a lead — an unattributed one');
  assert.equal(bob.channel_id, null);
});

test('a payment stamped with the product\'s user id reaches the lead that id identified', async () => {
  // The shape of a social login: the product knows who this is and never learns an
  // email, and the payer types whatever address they like into Stripe's card form.
  const { project, google, source } = await connected({
    charges: [charge('ch_u', 'card-holder@elsewhere.test', 49900, 5, { metadata: { user: 'x:4417', gold: '500' } })],
    refunds: [], subscriptions: [],
  });

  ingestBatch({ key: project.sdk_key, anon_id: 'anon-x', events: [
    { name: 'page', url: 'https://rooftop.test/?utm_source=google&gclid=abc', ts: atDay(9) },
    { name: 'identify', user_id: 'x:4417', traits: { name: 'someone' }, ts: atDay(8) },
  ] });

  const result = await revenue.syncRevenueSource(source.id, { from: daysAgo(30), to: today() });
  assert.equal(result.matched, 1);

  const range = { from: daysAgo(30), to: today() };
  const rows = analytics.channelBreakdown(project.id, range);
  const byName = Object.fromEntries(rows.map((r) => [r.name, r]));
  assert.equal(byName['Google Ads'].revenue, 499,
    'the sale is credited to the ad that found them, not to Unattributed');
  assert.equal(byName.Unattributed, undefined);

  const lead = get('SELECT * FROM leads WHERE project_id = :p AND external_id = :x',
    { p: project.id, x: 'x:4417' });
  assert.equal(lead.stage, 'customer');
  assert.equal(lead.first_channel_id, google.id);
  assert.equal(all('SELECT id FROM leads WHERE project_id = :p', { p: project.id }).length, 1,
    'and no second lead is invented for the address on the card');

  const payment = get('SELECT * FROM payments WHERE external_id = :e', { e: 'ch_u' });
  assert.equal(payment.user_ref, 'x:4417');
  assert.equal(payment.lead_id, lead.id);
});

test('a stamped payment nobody tracked still becomes a lead, keyed by that id', async () => {
  const { project, source } = await connected({
    charges: [charge('ch_v', 'someone@elsewhere.test', 999, 4, { metadata: { user_id: 'g:7' } })],
    refunds: [], subscriptions: [],
  });
  await revenue.syncRevenueSource(source.id, { from: daysAgo(30), to: today() });

  const lead = get('SELECT * FROM leads WHERE project_id = :p AND external_id = :x', { p: project.id, x: 'g:7' });
  assert.ok(lead, 'the id is what a later identify() from the product will meet this record on');
  assert.equal(lead.email, 'someone@elsewhere.test', 'the address they paid with is kept too');
  assert.equal(lead.channel_id, null);
});

test('re-syncing the same window does not count the same money again', async () => {
  const { project, source } = await connected({
    charges: [charge('ch_a', 'carol@example.com', 25000, 6)],
    refunds: [], subscriptions: [],
  });
  const range = { from: daysAgo(30), to: today() };

  await revenue.syncRevenueSource(source.id, range);
  const first = analytics.projectTotals(project.id, range).revenue;

  await revenue.syncRevenueSource(source.id, range);
  await revenue.syncRevenueSource(source.id, range);

  assert.equal(analytics.projectTotals(project.id, range).revenue, first);
  assert.equal(first, 250);
  assert.equal(all('SELECT id FROM payments WHERE project_id = :p', { p: project.id }).length, 1);
  assert.equal(all(`SELECT id FROM events WHERE project_id = :p AND value > 0`, { p: project.id }).length, 1);

  const carol = get('SELECT * FROM leads WHERE project_id = :p AND email = :e', { p: project.id, e: 'carol@example.com' });
  assert.equal(carol.value, 250, 'the lead total is recomputed, not accumulated');
});

test('a charge that later gets refunded moves net revenue on the refund date, not the charge date', async () => {
  const { project, source } = await connected({
    charges: [charge('ch_b', 'dave@example.com', 30000, 20)],
    refunds: [], subscriptions: [],
  });
  await revenue.syncRevenueSource(source.id, { from: daysAgo(30), to: today() });

  stripeData.refunds = [{ id: 're_b', charge: 'ch_b', amount: 30000, currency: 'usd', status: 'succeeded',
    created: Math.floor(Date.parse(atDay(2)) / 1000), livemode: true }];
  await revenue.syncRevenueSource(source.id, { from: daysAgo(30), to: today() });

  const recent = metrics.revenueSummary(project.id, { from: daysAgo(7), to: today() });
  assert.equal(recent.gross, 0, 'the charge is outside this window');
  assert.equal(recent.refunds, 300, 'the refund is inside it');
  assert.equal(recent.net, -300);

  const all30 = metrics.revenueSummary(project.id, { from: daysAgo(30), to: today() });
  assert.equal(all30.net, 0, 'over a window holding both, they cancel out');
  assert.equal(all30.refund_rate_pct, 100);
});

test('MRR counts subscriptions that are paying, and reports the rest separately', async () => {
  const { project, source } = await connected({
    charges: [], refunds: [],
    subscriptions: [
      { id: 'sub_1', status: 'active', currency: 'usd', start_date: Math.floor(Date.parse(atDay(40)) / 1000),
        customer: { id: 'cus_e', email: 'erin@example.com' },
        items: { data: [{ quantity: 1, price: { unit_amount: 9900, currency: 'usd', recurring: { interval: 'month', interval_count: 1 } } }] } },
      { id: 'sub_2', status: 'active', currency: 'usd', start_date: Math.floor(Date.parse(atDay(200)) / 1000),
        customer: { id: 'cus_f', email: 'frank@example.com' },
        items: { data: [{ quantity: 1, price: { unit_amount: 120000, currency: 'usd', recurring: { interval: 'year', interval_count: 1 } } }] } },
      { id: 'sub_3', status: 'trialing', currency: 'usd', start_date: Math.floor(Date.parse(atDay(3)) / 1000),
        customer: { id: 'cus_g', email: 'gina@example.com' },
        items: { data: [{ quantity: 1, price: { unit_amount: 9900, currency: 'usd', recurring: { interval: 'month', interval_count: 1 } } }] } },
      { id: 'sub_4', status: 'canceled', currency: 'usd', start_date: Math.floor(Date.parse(atDay(90)) / 1000),
        canceled_at: Math.floor(Date.parse(atDay(5)) / 1000),
        customer: { id: 'cus_h', email: 'hank@example.com' },
        items: { data: [{ quantity: 2, price: { unit_amount: 2500, currency: 'usd', recurring: { interval: 'month', interval_count: 1 } } }] } },
    ],
  });
  await revenue.syncRevenueSource(source.id, { from: daysAgo(30), to: today() });

  const summary = metrics.revenueSummary(project.id, { from: daysAgo(30), to: today() });
  assert.equal(summary.recurring.mrr, 199, '$99 monthly plus $1200 a year');
  assert.equal(summary.recurring.arr, 2388);
  assert.equal(summary.recurring.active, 2);
  assert.equal(summary.recurring.trialing, 1, 'a trial has paid nothing yet and is not in MRR');
  assert.equal(summary.recurring.canceled, 1);
  assert.equal(summary.churn.canceled, 1);
  assert.equal(summary.churn.canceled_mrr, 50, 'what the cancellation actually cost per month');
  assert.equal(summary.churn.rate_pct, 33.33);
});

test('a verified webhook applies a payment the sync has never seen', async () => {
  const { project, source } = await connected({ charges: [], refunds: [], subscriptions: [] });
  const event = {
    id: 'evt_live', type: 'charge.succeeded',
    data: { object: charge('ch_hook', 'iris@example.com', 7500, 0) },
  };
  const applied = revenue.applyStripeEvent(revenue.getRevenueSource(source.id), event);
  assert.equal(applied.applied, true);

  const totals = analytics.projectTotals(project.id, { from: daysAgo(1), to: today() });
  assert.equal(totals.revenue, 75);
  assert.ok(revenue.getRevenueSource(source.id).last_hook_at, 'the source records that it heard from Stripe');
});

test('a webhook event the app has no use for is acknowledged rather than failed', async () => {
  const { source } = await connected({ charges: [], refunds: [], subscriptions: [] });
  const result = revenue.applyStripeEvent(revenue.getRevenueSource(source.id),
    { id: 'evt_z', type: 'payout.paid', data: { object: { id: 'po_1' } } });
  assert.equal(result.applied, false);
  assert.match(result.reason, /payout.paid/);
});

test('a webhook and a sync describing the same charge produce one payment', async () => {
  const { project, source } = await connected({
    charges: [charge('ch_both', 'jane@example.com', 4000, 1)], refunds: [], subscriptions: [],
  });
  revenue.applyStripeEvent(revenue.getRevenueSource(source.id),
    { id: 'evt_b', type: 'charge.succeeded', data: { object: charge('ch_both', 'jane@example.com', 4000, 1) } });
  await revenue.syncRevenueSource(source.id, { from: daysAgo(30), to: today() });

  assert.equal(all('SELECT id FROM payments WHERE project_id = :p', { p: project.id }).length, 1);
  assert.equal(analytics.projectTotals(project.id, { from: daysAgo(30), to: today() }).revenue, 40);
});

test('disconnecting takes the revenue with it, and leaves the people', async () => {
  const { project, source } = await connected({
    charges: [charge('ch_d', 'kim@example.com', 8000, 3)], refunds: [], subscriptions: [],
  });
  const range = { from: daysAgo(30), to: today() };
  await revenue.syncRevenueSource(source.id, range);
  assert.equal(analytics.projectTotals(project.id, range).revenue, 80);

  revenue.deleteRevenueSource(source.id);
  assert.equal(analytics.projectTotals(project.id, range).revenue, 0,
    'revenue from a disconnected source stops being reported');
  assert.equal(all('SELECT id FROM payments WHERE project_id = :p', { p: project.id }).length, 0);
  const kim = get('SELECT * FROM leads WHERE project_id = :p AND email = :e', { p: project.id, e: 'kim@example.com' });
  assert.ok(kim, 'the customer is still a person we know about');
  assert.equal(kim.value, 0);
});

test('lifetime value is set against acquisition cost per channel', async () => {
  const { project, google, source } = await connected({
    charges: [charge('ch_l1', 'liam@example.com', 20000, 10), charge('ch_l2', 'liam@example.com', 20000, 4)],
    refunds: [],
    subscriptions: [{ id: 'sub_l', status: 'active', currency: 'usd',
      start_date: Math.floor(Date.parse(atDay(10)) / 1000),
      customer: { id: 'cus_liam', email: 'liam@example.com' },
      items: { data: [{ quantity: 1, price: { unit_amount: 20000, currency: 'usd', recurring: { interval: 'month', interval_count: 1 } } }] } }],
  });
  ingestBatch({ key: project.sdk_key, anon_id: 'l1', events: [
    { name: 'page', url: 'https://x.test/?utm_source=google', ts: atDay(12) },
    { name: 'signup', traits: { email: 'liam@example.com' }, ts: atDay(11) },
  ] });
  store.upsertSpend(project.id, google.id, [{ date: daysAgo(12), spend: 400 }], 'manual');
  await revenue.syncRevenueSource(source.id, { from: daysAgo(30), to: today() });

  const row = metrics.revenueByChannel(project.id).find((r) => r.channel_id === google.id);
  assert.equal(row.customers, 1);
  assert.equal(row.revenue, 400, 'two $200 charges');
  assert.equal(row.ltv, 400);
  assert.equal(row.cac, 400);
  assert.equal(row.ltv_cac, 1, 'earned back exactly what it cost — so far');
  assert.equal(row.mrr, 200);
  assert.equal(row.payback_months, 2, '$400 to acquire, $200 a month back');
});

/* ------------------------------------------------------------- the audit */

test('the audit names a test-mode connection before anyone trusts the numbers', async () => {
  const { project, source } = await connected({ charges: [], refunds: [], subscriptions: [] });
  await revenue.syncRevenueSource(source.id, { from: daysAgo(30), to: today() });
  const findings = audit.runAudit(project);
  const testMode = findings.find((x) => x.code === 'revenue_test_mode');
  assert.ok(testMode, 'a test key must be called out');
  assert.equal(testMode.severity, 'warning');
  assert.match(testMode.detail, /not money anyone paid/);
});

test('the audit catches revenue being reported twice', async () => {
  const { project, source } = await connected({
    charges: [charge('ch_dup', 'mia@example.com', 15000, 2)], refunds: [], subscriptions: [],
  });
  ingestBatch({ key: project.sdk_key, anon_id: 'm1', events: [
    { name: 'signup', traits: { email: 'mia@example.com' }, ts: atDay(3) },
    { name: 'purchase', value: 150, ts: atDay(2) },
  ] });
  await revenue.syncRevenueSource(source.id, { from: daysAgo(30), to: today() });

  const findings = audit.runAudit(project);
  const dup = findings.find((x) => x.code === 'revenue_double_counted');
  assert.ok(dup, 'the SDK and Stripe both reporting $150 is worth saying out loud');
  assert.equal(dup.severity, 'serious');
});

test('the audit says so when nobody has connected a processor at all', () => {
  const project = store.createProject({ name: `NoRev${Math.random().toString(36).slice(2, 6)}` });
  const findings = audit.runAudit(project);
  assert.ok(findings.find((x) => x.code === 'revenue_not_connected'));
});

test('the audit flags payments it could not tie to anyone', async () => {
  const { project, source } = await connected({
    charges: Array.from({ length: 6 }, (_, i) => charge(`ch_u${i}`, `u${i}@example.com`, 1000, i + 1)),
    refunds: [], subscriptions: [],
  });
  await revenue.updateRevenueSource(source.id, { config: { create_missing_leads: false } });
  await revenue.syncRevenueSource(source.id, { from: daysAgo(30), to: today() });

  const summary = metrics.revenueSummary(project.id, { from: daysAgo(30), to: today() });
  assert.equal(summary.unmatched.count, 6);

  const findings = audit.runAudit(project);
  const unmatched = findings.find((x) => x.code === 'revenue_unmatched');
  assert.ok(unmatched);
  assert.match(unmatched.title, /100%/);
});

test('the revenue chart and the revenue total describe the same money', async () => {
  const { project, source } = await connected({
    charges: [charge('ch_s1', 'nora@example.com', 60000, 9), charge('ch_s2', 'omar@example.com', 10000, 5)],
    refunds: [{ id: 're_s', charge: 'ch_s1', amount: 25000, currency: 'usd', status: 'succeeded',
      created: Math.floor(Date.parse(atDay(2)) / 1000), livemode: true }],
    subscriptions: [],
  });
  const range = { from: daysAgo(30), to: today() };
  await revenue.syncRevenueSource(source.id, range);

  const totals = analytics.projectTotals(project.id, range);
  const charted = analytics.dailySeries(project.id, range).reduce((n, d) => n + d.revenue, 0);
  assert.equal(Math.round(charted * 100) / 100, totals.revenue,
    'a refund is a negative event — the daily series has to carry it too, or the chart overstates');
  assert.equal(totals.revenue, 450);
});

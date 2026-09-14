import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDb, daysAgo, today } from './helpers.js';

useTempDb();
const store = await import('../src/store.js');
const sync = await import('../src/sync.js');
const { parseCsv, importSpendCsv, importLeads } = sync;
const { seal, open, describeCredentials } = await import('../src/crypto.js');
const { parseMoney, parseCount } = await import('../src/connectors/browser.js');
const { normaliseDate } = await import('../src/connectors/portal-providers.js');
const { all, get } = await import('../src/db.js');

const project = store.createProject({ name: 'CSV Co' });
const channel = store.createChannel(project.id, { provider: 'bing_ads', name: 'Bing', auth_type: 'manual' });

test('the CSV parser handles quotes, embedded commas and CRLF', () => {
  const rows = parseCsv('Day,Cost,Note\r\n2026-01-01,"1,234.56","says ""hi"", twice"\r\n');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].Cost, '1,234.56');
  assert.equal(rows[0].Note, 'says "hi", twice');
});

test('CSV import matches column names loosely across platform exports', () => {
  const r = importSpendCsv(channel, 'Day,Cost,Impressions,Clicks\n2026-01-01,"1,234.56",10000,250\n1/2/2026,$99.00,900,30\n');
  assert.equal(r.rows, 2);
  assert.equal(r.columns.date, 'Day');
  assert.equal(r.columns.spend, 'Cost');
  const rows = all('SELECT * FROM spend_daily WHERE channel_id = :c ORDER BY date', { c: channel.id });
  assert.equal(rows[0].spend, 1234.56);
  assert.equal(rows[1].date, '2026-01-02', 'US-format dates are normalised');
  assert.equal(rows[1].spend, 99);
});

test('an export with the Meta column names also imports', () => {
  const r = importSpendCsv(channel, 'Reporting starts,Amount spent (USD),Impressions,Link clicks\n2026-02-01,55.10,2000,40\n');
  assert.equal(r.rows, 1);
  assert.equal(r.columns.spend, 'Amount spent (USD)');
});

test('a CSV with no recognisable spend column fails loudly', () => {
  assert.throws(() => importSpendCsv(channel, 'Day,Widgets\n2026-01-01,5\n'), /spend column/);
});

test('re-importing the same day replaces it instead of double-counting', () => {
  importSpendCsv(channel, 'Day,Cost\n2026-03-01,100\n');
  importSpendCsv(channel, 'Day,Cost\n2026-03-01,250\n');
  assert.equal(get('SELECT spend FROM spend_daily WHERE channel_id = :c AND date = :d', { c: channel.id, d: '2026-03-01' }).spend, 250);
});

test('a portal lead export attaches to the lead that already exists', () => {
  const cap = store.createChannel(project.id, { provider: 'capterra', name: 'Capterra', auth_type: 'manual' });
  assert.equal(importLeads(cap, [{ email: 'new@corp.com', name: 'New', company: 'Corp', date: daysAgo(2) }]), 1);
  assert.equal(importLeads(cap, [{ email: 'new@corp.com', name: 'New', company: 'Corp', date: daysAgo(1) }]), 1);
  assert.equal(all('SELECT * FROM leads WHERE email = :e', { e: 'new@corp.com' }).length, 1, 'the same contact is one lead');
});

test('scraped money parses across formats', () => {
  assert.equal(parseMoney('$1,234.56'), 1234.56);
  assert.equal(parseMoney('1.234,56 €'), 1234.56);
  assert.equal(parseMoney('USD 12'), 12);
  assert.equal(parseMoney(''), 0);
  assert.equal(parseMoney(null), 0);
  assert.equal(parseCount('12,345 clicks'), 12345);
});

test('scraped dates parse or are rejected, never guessed wrong', () => {
  assert.equal(normaliseDate('2026-04-05'), '2026-04-05');
  assert.equal(normaliseDate('April 5, 2026'), '2026-04-05');
  assert.equal(normaliseDate('gibberish'), null);
  assert.equal(normaliseDate(''), null);
});

test('credentials round-trip through encryption and are never echoed back', () => {
  const blob = seal({ username: 'a@b.co', password: 'hunter2' });
  assert.ok(!blob.includes('hunter2'), 'the stored blob does not contain the plaintext');
  assert.equal(open(blob).password, 'hunter2');

  const described = describeCredentials(blob, [
    { key: 'username', secret: false }, { key: 'password', secret: true },
  ]);
  assert.equal(described.fields.username, 'a@b.co');
  assert.equal(described.fields.password, '••••ter2', 'secrets come back masked');
  assert.ok(!JSON.stringify(described).includes('hunter2'));
});

test('a tampered credential blob fails to decrypt rather than returning junk', () => {
  const blob = seal({ password: 'hunter2' });
  const parts = blob.split(':');
  parts[3] = Buffer.from('tampered').toString('base64url');
  assert.throws(() => open(parts.join(':')));
});

test('a manual channel refuses an automatic sync with an actionable message', async () => {
  await assert.rejects(() => sync.syncChannel(channel.id), /no automatic sync|manually/);
});

test('a configured channel with no credentials refuses to sync', async () => {
  const meta = store.createChannel(project.id, { provider: 'meta_ads', name: 'Meta', auth_type: 'api' });
  await assert.rejects(() => sync.syncChannel(meta.id), /no stored credentials/);
});

test('a failing sync is recorded on the channel and in its history', async () => {
  const meta = store.createChannel(project.id, {
    provider: 'meta_ads', name: 'Meta 2', auth_type: 'api',
    credentials: { ad_account_id: '1', access_token: 'invalid' },
  });
  await assert.rejects(() => sync.syncChannel(meta.id, { from: '2026-01-01', to: '2026-01-02' }));
  const after = store.getChannel(meta.id);
  assert.equal(after.last_sync_status, 'error');
  assert.ok(after.last_sync_error);
  assert.equal(sync.syncHistory(meta.id)[0].status, 'error');
});

test('updating credentials merges, so a form can be resubmitted without retyping secrets', () => {
  const c = store.createChannel(project.id, {
    provider: 'google_ads', name: 'G', auth_type: 'oauth',
    credentials: { customer_id: '123', developer_token: 'dev', refresh_token: 'r' },
  });
  store.updateChannel(c.id, { credentials: { customer_id: '999' } });
  const creds = store.channelCredentials(store.getChannel(c.id));
  assert.equal(creds.customer_id, '999');
  assert.equal(creds.developer_token, 'dev', 'untouched secrets survive the update');
});

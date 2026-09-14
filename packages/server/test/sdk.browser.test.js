import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDb } from './helpers.js';

useTempDb();
process.env.PORT = '0';

// Playwright is optional; without it this file reports as skipped rather than failing.
const pw = await import('playwright').catch(() => null);
const { server } = await import('../src/index.js');

let base, browser, project;

before(async () => {
  if (!server.listening) await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const res = await fetch(`${base}/api/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Browser Co', website: 'http://127.0.0.1:9931' }),
  });
  project = await res.json();
  await fetch(`${base}/api/projects/${project.slug}/channels`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider: 'capterra', name: 'Capterra', auth_type: 'manual' }),
  });
  if (pw) browser = await pw.chromium.launch();
});

after(async () => {
  await browser?.close();
  server.close();
});

const leads = async () => (await (await fetch(`${base}/api/projects/${project.slug}/leads?days=7`)).json());

/**
 * A fake customer site on its own origin, so the SDK is exercised cross-origin exactly
 * as it runs on a real marketing site. The origin is a loopback port with no server
 * behind it — every request to it is fulfilled from here — because Chrome's Local
 * Network Access gate blocks a public-origin page from reaching a loopback API, which
 * is a property of this test rig, not of a real deployment.
 */
async function shopPage(ctx, { path = '/' } = {}) {
  await ctx.grantPermissions(['local-network-access']).catch(() => {});
  const page = await ctx.newPage();
  await page.route('http://127.0.0.1:9931/**', (route) => route.fulfill({
    status: 200,
    contentType: 'text/html',
    body: `<!doctype html><html><head><title>Shop</title></head><body>
      <h1>Shop</h1>
      <script async src="${base}/sdk.js" data-runhq-key="${project.sdk_key}" data-runhq-host="${base}"></script>
    </body></html>`,
  }));
  await page.goto('http://127.0.0.1:9931' + path);
  await page.waitForFunction(() => window.runhq && window.runhq.__loaded);
  return page;
}

describe('the SDK in a real browser', { skip: pw ? false : 'playwright is not installed' }, () => {
  test('a tagged landing becomes an attributed, identified, converted lead', async () => {
    const ctx = await browser.newContext();
    const page = await shopPage(ctx, { path: '/?utm_source=capterra&utm_medium=referral&gclid=xyz' });

    await page.evaluate(() => window.runhq.identify('user-7', { email: 'Browser@Corp.com', name: 'Browser Person' }));
    await page.evaluate(() => window.runhq.revenue(750, { plan: 'pro' }));
    await page.evaluate(() => window.runhq.flush());
    await page.waitForTimeout(600);

    const { rows, total } = await leads();
    assert.equal(total, 1);
    assert.equal(rows[0].email, 'browser@corp.com');
    assert.equal(rows[0].name, 'Browser Person');
    assert.equal(rows[0].external_id, 'user-7');
    assert.equal(rows[0].channel_name, 'Capterra');
    assert.equal(rows[0].utm_source, 'capterra');
    assert.equal(rows[0].click_id, 'xyz');
    assert.equal(rows[0].stage, 'customer');
    assert.equal(rows[0].value, 750);
    await ctx.close();
  });

  test('the anonymous id and first touch survive a navigation', async () => {
    const ctx = await browser.newContext();
    const page = await shopPage(ctx, { path: '/?utm_source=capterra&utm_campaign=listing' });
    const first = await page.evaluate(() => window.runhq.anonymousId);
    const firstTouch = await page.evaluate(() => window.runhq.firstTouch);
    assert.equal(firstTouch.utm_source, 'capterra');

    await page.goto('http://127.0.0.1:9931/pricing');       // untagged second page
    await page.waitForFunction(() => window.runhq && window.runhq.__loaded);
    assert.equal(await page.evaluate(() => window.runhq.anonymousId), first, 'the same browser is the same visitor');
    assert.equal(
      (await page.evaluate(() => window.runhq.firstTouch)).utm_source,
      'capterra',
      'first touch is never overwritten by a later untagged visit',
    );
    await ctx.close();
  });

  test('an SPA route change sends a page view without a reload', async () => {
    const ctx = await browser.newContext();
    const page = await shopPage(ctx, { path: '/?utm_source=capterra' });
    await page.evaluate(() => window.runhq.identify('spa-user', { email: 'spa@corp.com' }));
    await page.evaluate(() => { window.history.pushState({}, '', '/features'); });
    await page.waitForTimeout(200);
    await page.evaluate(() => window.runhq.flush());
    await page.waitForTimeout(600);

    const { rows } = await leads();
    const lead = rows.find((l) => l.email === 'spa@corp.com');
    const detail = await (await fetch(`${base}/api/leads/${lead.id}`)).json();
    const urls = detail.events.filter((e) => e.name === 'page').map((e) => e.url);
    assert.ok(urls.some((u) => u.includes('/features')), 'the pushState navigation was recorded');
    await ctx.close();
  });

  test('reset() forgets the visitor', async () => {
    const ctx = await browser.newContext();
    const page = await shopPage(ctx);
    const before = await page.evaluate(() => window.runhq.anonymousId);
    await page.evaluate(() => window.runhq.reset());
    const after = await page.evaluate(() => window.runhq.anonymousId);
    assert.notEqual(before, after);
    assert.equal(await page.evaluate(() => window.runhq.firstTouch), null);
    await ctx.close();
  });

  test('the page never sees the project secret, only the publishable key', async () => {
    const ctx = await browser.newContext();
    const page = await shopPage(ctx);
    const sdkSource = await (await fetch(`${base}/sdk.js`)).text();
    assert.ok(!sdkSource.includes(project.sdk_secret));
    const config = await page.evaluate(() => window.runhq.config);
    assert.match(config.key, /^run_pk_.{0,8}…$/, 'even the key is truncated in the debug view');
    await ctx.close();
  });
});

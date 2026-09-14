import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDb } from './helpers.js';

useTempDb();
const { resolveChannel, PROVIDERS, providerCatalogue } = await import('../src/connectors/index.js');
const { touchFrom } = await import('../src/ingest.js');

const channel = (id, provider, config = {}) => ({ id, provider, config: JSON.stringify(config) });

test('a platform click ID beats UTM tags, because the platform sets it', () => {
  const channels = [channel('meta', 'meta_ads'), channel('google', 'google_ads')];
  const { channel: hit, basis } = resolveChannel(channels, {
    utm_source: 'facebook',
    params: { gclid: 'abc', utm_source: 'facebook' },
  });
  assert.equal(hit.id, 'google');
  assert.match(basis, /gclid/);
});

test('utm_source matches case-insensitively', () => {
  const channels = [channel('cap', 'capterra')];
  assert.equal(resolveChannel(channels, { utm_source: 'CAPTERRA', params: {} }).channel.id, 'cap');
});

test('a channel-level campaign rule splits one ad account into two channels', () => {
  const channels = [
    channel('brand', 'google_ads', { match: { utm_source: ['google'], utm_campaign: ['brand'] } }),
    channel('nonbrand', 'google_ads', { match: { utm_source: ['google'], utm_campaign: ['nonbrand'] } }),
  ];
  assert.equal(resolveChannel(channels, { utm_source: 'google', utm_campaign: 'nonbrand', params: {} }).channel.id, 'nonbrand');
  assert.equal(resolveChannel(channels, { utm_source: 'google', utm_campaign: 'brand', params: {} }).channel.id, 'brand');
});

test('an unmatched visit resolves to no channel rather than the first one', () => {
  const channels = [channel('meta', 'meta_ads')];
  const { channel: hit, basis } = resolveChannel(channels, { referrer: 'https://news.ycombinator.com/', params: {} });
  assert.equal(hit, null);
  assert.match(basis, /no channel rule matched/);
});

test('a bare visit with nothing at all reads as direct, not as a failure', () => {
  assert.match(resolveChannel([], { params: {} }).basis, /direct/);
});

test('the referrer is a fallback for untagged links', () => {
  const channels = [channel('seo', 'content_seo')];
  assert.equal(resolveChannel(channels, { referrer: 'https://www.google.com/search?q=x', params: {} }).channel.id, 'seo');
});

test('an explicit run_channel parameter overrides every rule', () => {
  const channels = [channel('meta', 'meta_ads'), channel('cap', 'capterra')];
  const hit = resolveChannel(channels, { utm_source: 'facebook', run_channel: 'cap', params: { utm_source: 'facebook' } });
  assert.equal(hit.channel.id, 'cap');
});

test('touchFrom reads UTM and click IDs out of the landing URL', () => {
  const t = touchFrom('https://x.io/pricing?utm_source=Capterra&utm_medium=referral&gclid=9', null);
  assert.equal(t.utm_source, 'Capterra');
  assert.equal(t.params.gclid, '9');
  assert.equal(t.tagged, true);
});

test('touchFrom marks an untagged landing as untagged', () => {
  assert.equal(touchFrom('https://x.io/', 'https://x.io/blog').tagged, false);
});

test('touchFrom survives a malformed URL', () => {
  assert.doesNotThrow(() => touchFrom('not a url', null));
  assert.equal(touchFrom('not a url', null).tagged, false);
});

test('every provider offers a manual fallback and a usable catalogue entry', () => {
  for (const p of providerCatalogue()) {
    assert.ok(p.authTypes.includes('manual'), `${p.id} should allow manual entry`);
    assert.ok(p.label && p.category, `${p.id} needs a label and category`);
    for (const auth of p.authTypes) assert.ok(p.fields[auth], `${p.id} is missing fields for ${auth}`);
  }
  assert.ok(Object.keys(PROVIDERS).length >= 10);
});

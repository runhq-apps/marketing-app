import { apiProviders } from './api-providers.js';
import { portalProviders } from './portal-providers.js';
import { manualProviders } from './manual-providers.js';

/**
 * Every channel can always fall back to manual/CSV spend entry — an expired token or a
 * portal redesign should degrade to typing last month's number in, never to a blind spot.
 */
const withManualFallback = (p) => ({
  ...p,
  authTypes: p.authTypes.includes('manual') ? p.authTypes : [...p.authTypes, 'manual'],
  fields: { manual: [], ...p.fields },
});

export const PROVIDERS = Object.fromEntries(
  [...apiProviders, ...portalProviders, ...manualProviders]
    .map(withManualFallback)
    .map((p) => [p.id, p]),
);

export const getProvider = (id) => PROVIDERS[id] ?? null;

export const AUTH_TYPES = {
  api: { label: 'API key / token', help: 'The platform issues a long-lived token. Cleanest option — use it when offered.' },
  oauth: { label: 'OAuth (refresh token)', help: 'You authorise once; the app refreshes access tokens per sync.' },
  credentials: { label: 'Portal login', help: 'No API exists. The app signs into the vendor portal in a headless browser and reads the numbers. Credentials are encrypted at rest; MFA-protected accounts will not work.' },
  manual: { label: 'Manual / CSV', help: 'Enter spend by hand or import a CSV export. Attribution still works from UTMs.' },
};

/** UI-safe catalogue: descriptions and field shapes, no functions. */
export function providerCatalogue() {
  return Object.values(PROVIDERS).map((p) => ({
    id: p.id,
    label: p.label,
    blurb: p.blurb ?? '',
    category: p.category ?? 'other',
    authTypes: p.authTypes,
    fields: p.fields ?? {},
    match: p.match ?? {},
    checklist: p.checklist ?? [],
    canSync: typeof p.fetchSpend === 'function',
    canSyncLeads: typeof p.fetchLeads === 'function',
    needsBrowser: !!p.needsBrowser,
    manualOnly: !!p.manualOnly,
    defaultConfig: p.defaultConfig ?? {},
  }));
}

const lower = (v) => (v == null ? '' : String(v).toLowerCase().trim());

/**
 * Which channel does a touch belong to?
 *
 * Resolution order, most to least trustworthy:
 *   1. an explicit ?run_channel=<id> override on the landing URL
 *   2. a platform click ID (gclid, fbclid…) — set by the ad platform, not by a human
 *   3. utm_source, then utm_source+medium rules
 *   4. the referring host
 *
 * Channel-level rules (config.match) always beat the provider defaults, so two Meta
 * channels — say brand and performance — can be separated by utm_campaign.
 */
export function resolveChannel(channels, touch) {
  const utmSource = lower(touch.utm_source);
  const utmMedium = lower(touch.utm_medium);
  const utmCampaign = lower(touch.utm_campaign);
  const params = touch.params ?? {};
  const refHost = hostOf(touch.referrer);

  if (touch.run_channel) {
    const forced = channels.find((c) => c.id === touch.run_channel);
    if (forced) return { channel: forced, basis: 'explicit run_channel parameter' };
  }

  const rules = channels.map((c) => ({ channel: c, rule: mergedRules(c) }));

  for (const { channel, rule } of rules) {
    for (const cid of rule.clickIds ?? []) {
      if (params[cid]) return { channel, basis: `${cid} click ID` };
    }
  }
  // A campaign rule is narrower than a bare source rule, so it gets first refusal.
  for (const { channel, rule } of rules) {
    if (!rule.utm_campaign?.length) continue;
    if (rule.utm_campaign.map(lower).includes(utmCampaign) && matchesSource(rule, utmSource)) {
      return { channel, basis: `utm_campaign=${utmCampaign}` };
    }
  }
  for (const { channel, rule } of rules) {
    if (!utmSource || !rule.utm_source?.length) continue;
    if (!rule.utm_source.map(lower).includes(utmSource)) continue;
    if (rule.utm_medium?.length && utmMedium && !rule.utm_medium.map(lower).includes(utmMedium)) continue;
    return { channel, basis: `utm_source=${utmSource}` };
  }
  for (const { channel, rule } of rules) {
    if (!utmMedium || !rule.utm_medium?.length) continue;
    if (rule.utm_medium.map(lower).includes(utmMedium)) return { channel, basis: `utm_medium=${utmMedium}` };
  }
  for (const { channel, rule } of rules) {
    for (const r of rule.referrers ?? []) {
      if (refHost && refHost.includes(lower(r))) return { channel, basis: `referrer ${refHost}` };
    }
  }
  return { channel: null, basis: utmSource || refHost ? 'no channel rule matched' : 'direct / untagged' };
}

function mergedRules(channel) {
  const provider = PROVIDERS[channel.provider];
  const base = provider?.match ?? {};
  let override = {};
  try { override = JSON.parse(channel.config || '{}').match ?? {}; } catch { /* keep defaults */ }
  return { ...base, ...override };
}

function matchesSource(rule, utmSource) {
  if (!rule.utm_source?.length || !utmSource) return true;
  return rule.utm_source.map(lower).includes(utmSource);
}

export function hostOf(url) {
  if (!url) return '';
  try { return new URL(url).hostname.toLowerCase(); } catch { return ''; }
}

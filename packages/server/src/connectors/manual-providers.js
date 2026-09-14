/**
 * Channels with no machine-readable source of truth: agency retainers, conference
 * booths, newsletter sponsorships, and the platforms whose reporting APIs are not
 * worth the integration. Spend is entered by hand or imported from CSV; attribution
 * still works, because attribution keys off UTMs and click IDs, not off the API.
 */
function manualProvider({ id, label, blurb, category, match, checklist = [], cadence = 'monthly' }) {
  return {
    id, label, blurb, category, match, checklist,
    authTypes: ['manual'],
    manualOnly: true,
    cadence,
    fields: { manual: [] },
  };
}

export const manualProviders = [
  manualProvider({
    id: 'manual',
    label: 'Custom channel',
    blurb: 'Anything else. Name it, set its UTM rules, enter spend by hand or import a CSV.',
    category: 'other',
    match: {},
  }),
  manualProvider({
    id: 'bing_ads',
    label: 'Microsoft Ads',
    blurb: 'Bing/Microsoft Advertising. Reporting is SOAP-only; export a daily CSV and import it here.',
    category: 'paid_search',
    match: { utm_source: ['bing', 'msn', 'microsoft'], utm_medium: ['cpc', 'ppc'], clickIds: ['msclkid'] },
    checklist: [
      { code: 'uet', label: 'UET tag on the site', detects: 'bing_uet' },
      { code: 'utm', label: 'Ad URLs carry utm_source=bing', detects: 'utm' },
    ],
    cadence: 'weekly',
  }),
  manualProvider({
    id: 'x_ads',
    label: 'X Ads',
    blurb: 'X (Twitter) Ads. OAuth 1.0a only — enter spend manually or import the CSV export.',
    category: 'paid_social',
    match: { utm_source: ['twitter', 'x'], utm_medium: ['paid_social', 'cpc'], clickIds: ['twclid'] },
    checklist: [{ code: 'utm', label: 'Ad URLs carry utm_source=twitter', detects: 'utm' }],
    cadence: 'weekly',
  }),
  manualProvider({
    id: 'conference',
    label: 'Conference / event',
    blurb: 'Booth fee, travel, swag. One lumpy spend line; leads come in by badge scan or a landing page.',
    category: 'events',
    match: { utm_medium: ['event', 'conference'] },
    checklist: [
      { code: 'landing', label: 'Dedicated landing page with a QR code', detects: 'manual' },
      { code: 'utm', label: 'QR/booth URL carries utm_medium=event', detects: 'utm' },
      { code: 'followup', label: 'Scanned badges imported within 48h', detects: 'manual' },
    ],
    cadence: 'per-event',
  }),
  manualProvider({
    id: 'sponsorship',
    label: 'Newsletter / podcast sponsorship',
    blurb: 'Flat-fee placements. Give each placement its own utm_content so you can tell them apart.',
    category: 'sponsorship',
    match: { utm_medium: ['sponsorship', 'newsletter'] },
    checklist: [
      { code: 'utm', label: 'Each placement has a unique utm_content', detects: 'utm' },
      { code: 'vanity', label: 'Vanity URL or promo code for attribution', detects: 'manual' },
    ],
  }),
  manualProvider({
    id: 'agency',
    label: 'Agency / contractor retainer',
    blurb: 'Retainer cost that should be counted against the channels it produces.',
    category: 'other',
    match: {},
  }),
  manualProvider({
    id: 'content_seo',
    label: 'Content & SEO',
    blurb: 'Writer and tooling cost against organic search arrivals.',
    category: 'organic',
    match: { utm_medium: ['organic'], referrers: ['google.', 'bing.com', 'duckduckgo.com'] },
    checklist: [
      { code: 'analytics', label: 'Analytics or the Run SDK recording organic landings', detects: 'sdk' },
    ],
  }),
  manualProvider({
    id: 'email',
    label: 'Lifecycle email',
    blurb: 'ESP cost against email-sourced signups.',
    category: 'owned',
    match: { utm_medium: ['email'], utm_source: ['mailchimp', 'customerio', 'klaviyo', 'sendgrid', 'loops'] },
    checklist: [{ code: 'utm', label: 'Every campaign link carries utm_medium=email', detects: 'utm' }],
  }),
  manualProvider({
    id: 'affiliate',
    label: 'Affiliate / partner',
    blurb: 'Revenue-share or referral partners. Spend is the payout.',
    category: 'partner',
    match: { utm_medium: ['affiliate', 'partner'] },
    checklist: [{ code: 'utm', label: 'Partner links carry utm_medium=affiliate', detects: 'utm' }],
  }),
];

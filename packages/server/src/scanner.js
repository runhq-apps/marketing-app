import { all, get, run, uid, now } from './db.js';

/**
 * What we look for in a page's HTML. Detection is signature-based on the markup the
 * tag actually ships — script hosts and the global each one installs — so it survives
 * minification and tag managers, and is honest about what it cannot see (anything
 * injected client-side after load, which a static fetch never runs).
 */
export const TRACKER_SIGNATURES = [
  { key: 'gtag',             label: 'Google tag (gtag.js)',   patterns: [/googletagmanager\.com\/gtag\/js/i, /gtag\(\s*['"]js['"]/i] },
  { key: 'gtm',              label: 'Google Tag Manager',     patterns: [/googletagmanager\.com\/gtm\.js/i, /GTM-[A-Z0-9]{4,}/] },
  { key: 'ga4',              label: 'GA4 measurement ID',     patterns: [/\bG-[A-Z0-9]{6,}\b/] },
  { key: 'google_ads_conv',  label: 'Google Ads conversion',  patterns: [/\bAW-\d{6,}\b/] },
  { key: 'meta_pixel',       label: 'Meta Pixel',             patterns: [/connect\.facebook\.net\/[^"']*fbevents\.js/i, /\bfbq\(\s*['"]init['"]/] },
  { key: 'linkedin_insight', label: 'LinkedIn Insight Tag',   patterns: [/snap\.licdn\.com\/li\.lms-analytics/i, /_linkedin_partner_id/] },
  { key: 'bing_uet',         label: 'Microsoft UET tag',      patterns: [/bat\.bing\.com\/bat\.js/i, /\buetq\b/] },
  { key: 'reddit_pixel',     label: 'Reddit Pixel',           patterns: [/www\.redditstatic\.com\/ads\/pixel\.js/i, /\brdt\(\s*['"]init['"]/] },
  { key: 'x_pixel',          label: 'X (Twitter) Pixel',      patterns: [/static\.ads-twitter\.com\/uwt\.js/i, /\btwq\(/] },
  { key: 'tiktok_pixel',     label: 'TikTok Pixel',           patterns: [/analytics\.tiktok\.com/i, /\bttq\./] },
  { key: 'segment',          label: 'Segment',                patterns: [/cdn\.segment\.(com|io)/i, /analytics\.load\(/] },
  { key: 'posthog',          label: 'PostHog',                patterns: [/posthog\.com\/static\/array\.js/i, /posthog\.init\(/] },
  { key: 'mixpanel',         label: 'Mixpanel',               patterns: [/cdn\.mxpnl\.com/i, /mixpanel\.init\(/] },
  { key: 'amplitude',        label: 'Amplitude',              patterns: [/amplitude\.com\/libs/i, /amplitude\.getInstance/] },
  { key: 'hubspot',          label: 'HubSpot',                patterns: [/js\.hs-scripts\.com/i, /hs-analytics/i] },
  { key: 'hotjar',           label: 'Hotjar',                 patterns: [/static\.hotjar\.com/i, /\bhjid\b/] },
  { key: 'clarity',          label: 'Microsoft Clarity',      patterns: [/clarity\.ms\/tag/i] },
  { key: 'plausible',        label: 'Plausible',              patterns: [/plausible\.io\/js/i] },
  { key: 'intercom',         label: 'Intercom',               patterns: [/widget\.intercom\.io/i, /intercomSettings/] },
  { key: 'runhq_sdk',         label: 'Run Marketing SDK',     patterns: [/runhq(-marketing)?\.(min\.)?js/i, /\brun_pk_[A-Za-z0-9_-]{10,}/, /window\.runhq\b/] },
];

/** Page furniture that ad platforms and link unfurls actually read. */
const PAGE_CHECKS = [
  { key: 'og_image',        label: 'Open Graph image (link preview banner)', test: (h) => /<meta[^>]+property=["']og:image["']/i.test(h) },
  { key: 'og_title',        label: 'Open Graph title',                      test: (h) => /<meta[^>]+property=["']og:title["']/i.test(h) },
  { key: 'meta_description',label: 'Meta description',                      test: (h) => /<meta[^>]+name=["']description["']/i.test(h) },
  { key: 'favicon',         label: 'Favicon',                               test: (h) => /<link[^>]+rel=["'][^"']*icon/i.test(h) },
  { key: 'title',           label: 'Page title',                            test: (h) => /<title[^>]*>\s*\S/i.test(h) },
  { key: 'canonical',       label: 'Canonical URL',                         test: (h) => /<link[^>]+rel=["']canonical["']/i.test(h) },
];

export async function scanSite(project, { url } = {}) {
  const target = normaliseUrl(url || project.website);
  const id = uid();
  const scannedAt = now();

  if (!target) {
    const rec = { id, project_id: project.id, url: '', scanned_at: scannedAt, ok: 0, detected: '{}', error: 'No website URL is set for this project.' };
    saveScan(rec);
    return { ...rec, detected: {} };
  }

  let html = '';
  let error = null;
  try {
    const res = await fetch(target, {
      redirect: 'follow',
      headers: { 'user-agent': 'RunMarketing-SiteAudit/0.1 (+tracker detection)' },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) error = `Site responded ${res.status} ${res.statusText}`;
    html = (await res.text()).slice(0, 2_000_000);
  } catch (e) {
    error = `Could not fetch ${target}: ${e.message}`;
  }

  const trackers = {};
  for (const sig of TRACKER_SIGNATURES) trackers[sig.key] = sig.patterns.some((p) => p.test(html));
  const page = {};
  for (const c of PAGE_CHECKS) page[c.key] = c.test(html);

  const detected = {
    trackers, page,
    bytes: html.length,
    // A static fetch never runs the page's JS, so a tag injected by a client-side
    // router or a consent gate can be present and still read as missing here.
    caveat: 'Detected from server-rendered HTML only; client-injected tags may not appear.',
  };
  const rec = { id, project_id: project.id, url: target, scanned_at: scannedAt, ok: error ? 0 : 1, detected: JSON.stringify(detected), error };
  saveScan(rec);
  return { ...rec, detected };
}

function saveScan(rec) {
  run(`INSERT INTO site_scans (id, project_id, url, scanned_at, ok, detected, error)
       VALUES (:id, :project_id, :url, :scanned_at, :ok, :detected, :error)`, rec);
  // Keep the last 20 scans per project; the history is for trend, not forever.
  run(`DELETE FROM site_scans WHERE project_id = :p AND id NOT IN (
         SELECT id FROM site_scans WHERE project_id = :p ORDER BY scanned_at DESC LIMIT 20)`,
    { p: rec.project_id });
}

export function latestScan(projectId) {
  const row = get('SELECT * FROM site_scans WHERE project_id = :p ORDER BY scanned_at DESC LIMIT 1', { p: projectId });
  if (!row) return null;
  try { return { ...row, detected: JSON.parse(row.detected) }; } catch { return { ...row, detected: {} }; }
}

export const scanHistory = (projectId) =>
  all('SELECT id, url, scanned_at, ok, error FROM site_scans WHERE project_id = :p ORDER BY scanned_at DESC', { p: projectId });

export function normaliseUrl(url) {
  if (!url) return null;
  const s = String(url).trim();
  if (!s) return null;
  try { return new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`).toString(); } catch { return null; }
}

export const TRACKER_LABELS = Object.fromEntries(TRACKER_SIGNATURES.map((s) => [s.key, s.label]));

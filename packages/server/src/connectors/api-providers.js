import { parseMoney } from './browser.js';

/** Small fetch wrapper that turns API errors into messages an operator can act on. */
async function apiFetch(url, opts = {}, label = 'API') {
  let res;
  try {
    res = await fetch(url, { ...opts, signal: AbortSignal.timeout(60_000) });
  } catch (e) {
    throw new Error(`${label} request failed: ${e.message}`);
  }
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  if (!res.ok) {
    const detail = body?.error?.message || body?.error_description || body?.message
      || (Array.isArray(body) && body[0]?.error?.message) || body?.raw?.slice?.(0, 300) || res.statusText;
    throw new Error(`${label} returned ${res.status}: ${detail}`);
  }
  return body;
}

const iso = (d) => new Date(d).toISOString().slice(0, 10);

/* ------------------------------------------------------------------ Meta */

export const metaAds = {
  id: 'meta_ads',
  label: 'Meta Ads',
  category: 'paid_social',
  blurb: 'Facebook + Instagram ads. Daily spend, impressions and clicks from the Marketing API.',
  authTypes: ['api'],
  fields: {
    api: [
      { key: 'ad_account_id', label: 'Ad account ID', help: 'Digits only — the part after act_', secret: false, required: true },
      { key: 'access_token', label: 'System user access token', help: 'Needs ads_read. Long-lived tokens last ~60 days.', secret: true, required: true },
      { key: 'api_version', label: 'API version', help: 'Defaults to v21.0', secret: false, required: false },
    ],
  },
  match: { utm_source: ['facebook', 'fb', 'meta', 'instagram', 'ig'], utm_medium: ['paid_social', 'cpc'], clickIds: ['fbclid'] },
  checklist: [
    { code: 'pixel', label: 'Meta Pixel present on the site', detects: 'fbq' },
    { code: 'utm', label: 'Ad URLs carry utm_source=facebook', detects: 'utm' },
    { code: 'capi', label: 'Conversions API sending server-side events', detects: 'manual' },
  ],
  async fetchSpend({ creds, from, to }) {
    const v = creds.api_version || 'v21.0';
    const acct = String(creds.ad_account_id).replace(/^act_/, '');
    const url = new URL(`https://graph.facebook.com/${v}/act_${acct}/insights`);
    url.searchParams.set('fields', 'spend,impressions,clicks,account_currency');
    url.searchParams.set('time_increment', '1');
    url.searchParams.set('level', 'account');
    url.searchParams.set('time_range', JSON.stringify({ since: from, until: to }));
    url.searchParams.set('limit', '500');
    url.searchParams.set('access_token', creds.access_token);

    const rows = [];
    let next = url.toString();
    while (next) {
      const body = await apiFetch(next, {}, 'Meta Marketing API');
      for (const r of body.data ?? []) {
        rows.push({
          date: r.date_start,
          spend: parseMoney(r.spend),
          impressions: Number(r.impressions ?? 0),
          clicks: Number(r.clicks ?? 0),
          currency: r.account_currency || 'USD',
        });
      }
      next = body.paging?.next ?? null;
    }
    return { rows };
  },
};

/* ---------------------------------------------------------------- Google */

export const googleAds = {
  id: 'google_ads',
  label: 'Google Ads',
  category: 'paid_search',
  blurb: 'Search, Display, YouTube and Performance Max spend via the Google Ads API.',
  authTypes: ['oauth'],
  fields: {
    oauth: [
      { key: 'customer_id', label: 'Customer ID', help: '10 digits, no dashes', secret: false, required: true },
      { key: 'login_customer_id', label: 'Manager (MCC) ID', help: 'Only if you access through a manager account', secret: false, required: false },
      { key: 'developer_token', label: 'Developer token', secret: true, required: true },
      { key: 'client_id', label: 'OAuth client ID', secret: false, required: true },
      { key: 'client_secret', label: 'OAuth client secret', secret: true, required: true },
      { key: 'refresh_token', label: 'Refresh token', help: 'Generated once against the adwords scope', secret: true, required: true },
    ],
  },
  match: { utm_source: ['google', 'adwords', 'googleads', 'youtube'], utm_medium: ['cpc', 'ppc', 'paid_search'], clickIds: ['gclid', 'wbraid', 'gbraid'] },
  checklist: [
    { code: 'gtag', label: 'Google tag (gtag.js / GTM) on the site', detects: 'gtag' },
    { code: 'utm', label: 'Auto-tagging or manual utm_source=google', detects: 'utm' },
    { code: 'offline_conv', label: 'Offline conversion import for closed-won deals', detects: 'manual' },
  ],
  async accessToken(creds) {
    const body = new URLSearchParams({
      client_id: creds.client_id,
      client_secret: creds.client_secret,
      refresh_token: creds.refresh_token,
      grant_type: 'refresh_token',
    });
    const tok = await apiFetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    }, 'Google OAuth');
    return tok.access_token;
  },
  async fetchSpend({ creds, from, to }) {
    const token = await googleAds.accessToken(creds);
    const cid = String(creds.customer_id).replace(/\D/g, '');
    const query = `SELECT segments.date, metrics.cost_micros, metrics.impressions, metrics.clicks, customer.currency_code
                   FROM customer WHERE segments.date BETWEEN '${from}' AND '${to}'`;
    const body = await apiFetch(`https://googleads.googleapis.com/v18/customers/${cid}/googleAds:searchStream`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'developer-token': creds.developer_token,
        ...(creds.login_customer_id ? { 'login-customer-id': String(creds.login_customer_id).replace(/\D/g, '') } : {}),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ query }),
    }, 'Google Ads API');

    const chunks = Array.isArray(body) ? body : [body];
    const rows = [];
    for (const chunk of chunks) {
      for (const r of chunk.results ?? []) {
        rows.push({
          date: r.segments.date,
          spend: Number(r.metrics.costMicros ?? 0) / 1e6,
          impressions: Number(r.metrics.impressions ?? 0),
          clicks: Number(r.metrics.clicks ?? 0),
          currency: r.customer?.currencyCode || 'USD',
        });
      }
    }
    return { rows };
  },
};

/* -------------------------------------------------------------- LinkedIn */

export const linkedinAds = {
  id: 'linkedin_ads',
  label: 'LinkedIn Ads',
  category: 'paid_social',
  blurb: 'Sponsored content spend from the LinkedIn Marketing API. Strong B2B channel, expensive clicks.',
  authTypes: ['oauth'],
  fields: {
    oauth: [
      { key: 'account_id', label: 'Sponsored account ID', help: 'Digits only', secret: false, required: true },
      { key: 'access_token', label: 'Access token', help: 'Scope r_ads_reporting. Expires every 60 days.', secret: true, required: true },
    ],
  },
  match: { utm_source: ['linkedin', 'li'], utm_medium: ['paid_social', 'cpc'], clickIds: ['li_fat_id'] },
  checklist: [
    { code: 'insight_tag', label: 'LinkedIn Insight Tag on the site', detects: 'linkedin_insight' },
    { code: 'utm', label: 'Ad URLs carry utm_source=linkedin', detects: 'utm' },
  ],
  async fetchSpend({ creds, from, to }) {
    const [fy, fm, fd] = from.split('-').map(Number);
    const [ty, tm, td] = to.split('-').map(Number);
    const url = new URL('https://api.linkedin.com/rest/adAnalytics');
    url.searchParams.set('q', 'analytics');
    url.searchParams.set('pivot', 'ACCOUNT');
    url.searchParams.set('timeGranularity', 'DAILY');
    url.searchParams.set('dateRange',
      `(start:(year:${fy},month:${fm},day:${fd}),end:(year:${ty},month:${tm},day:${td}))`);
    url.searchParams.set('accounts', `List(urn%3Ali%3AsponsoredAccount%3A${String(creds.account_id).replace(/\D/g, '')})`);
    url.searchParams.set('fields', 'costInLocalCurrency,impressions,clicks,dateRange');

    const body = await apiFetch(url.toString().replace(/%253A/g, '%3A'), {
      headers: {
        authorization: `Bearer ${creds.access_token}`,
        'LinkedIn-Version': '202405',
        'X-Restli-Protocol-Version': '2.0.0',
      },
    }, 'LinkedIn Marketing API');

    const rows = (body.elements ?? []).map((r) => {
      const s = r.dateRange?.start ?? {};
      return {
        date: iso(Date.UTC(s.year, (s.month ?? 1) - 1, s.day ?? 1)),
        spend: parseMoney(r.costInLocalCurrency),
        impressions: Number(r.impressions ?? 0),
        clicks: Number(r.clicks ?? 0),
        currency: 'USD',
      };
    });
    return { rows };
  },
};

/* ---------------------------------------------------------------- Reddit */

export const redditAds = {
  id: 'reddit_ads',
  label: 'Reddit Ads',
  category: 'paid_social',
  blurb: 'Reddit Ads API daily report by ad account.',
  authTypes: ['oauth'],
  fields: {
    oauth: [
      { key: 'account_id', label: 'Ad account ID', help: 'Starts with t2_ or a2_', secret: false, required: true },
      { key: 'access_token', label: 'Access token', secret: true, required: true },
    ],
  },
  match: { utm_source: ['reddit'], utm_medium: ['paid_social', 'cpc'], clickIds: ['rdt_cid'] },
  checklist: [
    { code: 'pixel', label: 'Reddit Pixel on the site', detects: 'reddit_pixel' },
    { code: 'utm', label: 'Ad URLs carry utm_source=reddit', detects: 'utm' },
  ],
  async fetchSpend({ creds, from, to }) {
    const body = await apiFetch(
      `https://ads-api.reddit.com/api/v3/ad_accounts/${encodeURIComponent(creds.account_id)}/reports`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${creds.access_token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          data: {
            breakdowns: ['DATE'],
            fields: ['spend', 'impressions', 'clicks'],
            starts_at: `${from}T00:00:00Z`,
            ends_at: `${to}T23:59:59Z`,
            time_zone_id: 'UTC',
            group_by: ['DATE'],
          },
        }),
      }, 'Reddit Ads API');
    const rows = (body.data ?? []).map((r) => ({
      date: String(r.date ?? r.DATE ?? '').slice(0, 10),
      spend: Number(r.spend ?? 0) / 1e6, // Reddit reports microcurrency
      impressions: Number(r.impressions ?? 0),
      clicks: Number(r.clicks ?? 0),
      currency: 'USD',
    })).filter((r) => r.date);
    return { rows };
  },
};

export const apiProviders = [metaAds, googleAds, linkedinAds, redditAds];

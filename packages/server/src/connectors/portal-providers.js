import { withPage, login, parseMoney, parseCount } from './browser.js';

/**
 * Review sites and directories (Capterra, G2, GetApp…) bill real money but publish no
 * spend API. For those we log into the vendor portal with stored credentials and read
 * the numbers off the page.
 *
 * The selectors are *data*, not code: every one lives in the channel's `config.scrape`
 * and is editable from the UI, so a portal redesign is a settings change rather than a
 * release. The defaults below are a starting point to adjust against the live portal.
 */
function portalProvider({ id, label, blurb, category = 'marketplace', match, checklist, scrape, leadScrape }) {
  return {
    id, label, blurb, category, match, checklist,
    authTypes: ['credentials'],
    needsBrowser: true,
    defaultConfig: { scrape, ...(leadScrape ? { leadScrape } : {}) },
    fields: {
      credentials: [
        { key: 'username', label: 'Portal email', secret: false, required: true },
        { key: 'password', label: 'Portal password', secret: true, required: true },
      ],
    },

    async fetchSpend({ creds, config, from, to }) {
      const r = { ...scrape, ...(config.scrape ?? {}) };
      const warnings = [];
      const rows = await withPage(async (page) => {
        await login(page, r, creds);
        await page.goto(fill(r.reportUrl, { from, to }), { waitUntil: 'networkidle' });

        const daily = await readRows(page, r);
        if (daily.length) return daily;

        if (!r.totalSpendSelector) {
          throw new Error(`No rows matched \`${r.rowSelector}\` on ${r.reportUrl}. Open the channel's Scrape recipe and update the selectors against the live portal.`);
        }
        const total = parseMoney(await page.textContent(r.totalSpendSelector));
        warnings.push(`${label} exposed only a range total (${total}); it has been split evenly across the ${dayCount(from, to)} days in range.`);
        return spreadTotal(total, from, to);
      });
      return { rows, warnings };
    },

    ...(leadScrape ? {
      async fetchLeads({ creds, config, from, to }) {
        const r = { ...scrape, ...(config.scrape ?? {}) };
        const l = { ...leadScrape, ...(config.leadScrape ?? {}) };
        return withPage(async (page) => {
          await login(page, r, creds);
          await page.goto(fill(l.url, { from, to }), { waitUntil: 'networkidle' });
          const rows = await page.$$eval(l.rowSelector, (els, sel) => els.map((el) => {
            const pick = (s) => (s ? el.querySelector(s)?.textContent?.trim() ?? null : null);
            return { email: pick(sel.email), name: pick(sel.name), company: pick(sel.company), date: pick(sel.date) };
          }), l);
          return rows
            .filter((x) => x.email || x.company)
            .map((x) => ({ ...x, date: normaliseDate(x.date) }));
        });
      },
    } : {}),
  };
}

const fill = (tpl, vars) => String(tpl).replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');
const dayCount = (from, to) => Math.round((Date.parse(to) - Date.parse(from)) / 86400_000) + 1;

async function readRows(page, r) {
  const raw = await page.$$eval(r.rowSelector, (els, sel) => els.map((el) => {
    const pick = (s) => (s ? el.querySelector(s)?.textContent?.trim() ?? null : null);
    return {
      date: pick(sel.dateSelector),
      spend: pick(sel.spendSelector),
      clicks: pick(sel.clicksSelector),
      impressions: pick(sel.impressionsSelector),
    };
  }), r).catch(() => []);

  return raw
    .map((x) => ({
      date: normaliseDate(x.date),
      spend: parseMoney(x.spend),
      clicks: parseCount(x.clicks),
      impressions: parseCount(x.impressions),
      currency: r.currency || 'USD',
    }))
    .filter((x) => x.date);
}

function spreadTotal(total, from, to) {
  const days = dayCount(from, to);
  const per = days > 0 ? total / days : 0;
  const out = [];
  for (let i = 0; i < days; i++) {
    out.push({
      date: new Date(Date.parse(from + 'T00:00:00Z') + i * 86400_000).toISOString().slice(0, 10),
      spend: per, clicks: 0, impressions: 0, currency: 'USD', estimated: true,
    });
  }
  return out;
}

/** Portals render dates every which way; accept the common shapes, reject the rest. */
export function normaliseDate(text) {
  if (!text) return null;
  const s = String(text).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const t = Date.parse(s);
  if (!Number.isNaN(t)) return new Date(t).toISOString().slice(0, 10);
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s); // US M/D/YYYY
  if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  return null;
}

export const capterra = portalProvider({
  id: 'capterra',
  label: 'Capterra',
  blurb: 'Gartner Digital Markets PPC listing. No public API — signs into the vendor portal and reads spend and delivered leads.',
  match: { utm_source: ['capterra', 'gartner_digital_markets'], utm_medium: ['referral', 'listing', 'ppc'] },
  checklist: [
    { code: 'banner', label: 'Listing banner / hero image uploaded', detects: 'manual' },
    { code: 'screenshots', label: 'At least 5 product screenshots', detects: 'manual' },
    { code: 'utm', label: 'Listing website URL carries utm_source=capterra', detects: 'utm' },
    { code: 'lead_routing', label: 'Delivered leads routed into the CRM', detects: 'manual' },
    { code: 'reviews', label: 'Review count growing month over month', detects: 'manual' },
  ],
  scrape: {
    loginUrl: 'https://www.capterra.com/vendors/sign-in',
    userSelector: 'input[name="email"]',
    passSelector: 'input[name="password"]',
    submitSelector: 'button[type="submit"]',
    readySelector: '[data-testid="dashboard"], nav',
    reportUrl: 'https://www.capterra.com/vendors/ppc/performance?start={from}&end={to}',
    rowSelector: 'table tbody tr',
    dateSelector: 'td:nth-child(1)',
    spendSelector: 'td:nth-child(4)',
    clicksSelector: 'td:nth-child(3)',
    impressionsSelector: 'td:nth-child(2)',
    totalSpendSelector: '[data-testid="total-spend"]',
  },
  leadScrape: {
    url: 'https://www.capterra.com/vendors/leads?start={from}&end={to}',
    rowSelector: 'table tbody tr',
    email: 'td:nth-child(3)',
    name: 'td:nth-child(2)',
    company: 'td:nth-child(4)',
    date: 'td:nth-child(1)',
  },
});

export const g2 = portalProvider({
  id: 'g2',
  label: 'G2',
  blurb: 'G2 Marketing Solutions / Buyer Intent. Signs into my.g2.com and reads campaign spend and lead exports.',
  match: { utm_source: ['g2', 'g2crowd'], utm_medium: ['referral', 'listing'] },
  checklist: [
    { code: 'banner', label: 'Profile banner and media uploaded', detects: 'manual' },
    { code: 'utm', label: 'Profile website URL carries utm_source=g2', detects: 'utm' },
    { code: 'intent', label: 'Buyer-intent feed wired into outbound', detects: 'manual' },
    { code: 'reviews', label: 'Review campaign running', detects: 'manual' },
  ],
  scrape: {
    loginUrl: 'https://my.g2.com/login',
    userSelector: 'input[name="user[email]"]',
    passSelector: 'input[name="user[password]"]',
    submitSelector: 'button[type="submit"]',
    readySelector: 'nav',
    reportUrl: 'https://my.g2.com/campaigns/performance?from={from}&to={to}',
    rowSelector: 'table tbody tr',
    dateSelector: 'td:nth-child(1)',
    spendSelector: 'td:nth-child(4)',
    clicksSelector: 'td:nth-child(3)',
    impressionsSelector: 'td:nth-child(2)',
    totalSpendSelector: '.summary-total',
  },
});

export const getapp = portalProvider({
  id: 'getapp',
  label: 'GetApp',
  blurb: 'Gartner Digital Markets sister listing to Capterra — same vendor portal, separate budget line.',
  match: { utm_source: ['getapp'], utm_medium: ['referral', 'listing', 'ppc'] },
  checklist: [
    { code: 'banner', label: 'Listing banner uploaded', detects: 'manual' },
    { code: 'utm', label: 'Listing website URL carries utm_source=getapp', detects: 'utm' },
  ],
  scrape: {
    loginUrl: 'https://www.getapp.com/vendors/sign-in',
    userSelector: 'input[name="email"]',
    passSelector: 'input[name="password"]',
    submitSelector: 'button[type="submit"]',
    readySelector: 'nav',
    reportUrl: 'https://www.getapp.com/vendors/ppc/performance?start={from}&end={to}',
    rowSelector: 'table tbody tr',
    dateSelector: 'td:nth-child(1)',
    spendSelector: 'td:nth-child(4)',
    clicksSelector: 'td:nth-child(3)',
    impressionsSelector: 'td:nth-child(2)',
    totalSpendSelector: '[data-testid="total-spend"]',
  },
});

export const portalProviders = [capterra, g2, getapp];
export { portalProvider };

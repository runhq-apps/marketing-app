/**
 * Credential-login channels (Capterra, G2, most review/listing portals) have no public
 * spend API, so we drive a real browser session and read the numbers off the page.
 *
 * Playwright is an optional peer dependency: the app runs fine without it, and any
 * credentials-based sync reports a clear, actionable error instead of crashing.
 */
let playwrightPromise;

export async function loadPlaywright() {
  playwrightPromise ??= import('playwright').catch(() => null);
  const pw = await playwrightPromise;
  if (!pw) {
    throw new Error(
      'Credential-login sync needs Playwright, which is not installed. ' +
      'Run `npm i -D playwright && npx playwright install chromium` in the repo root, then retry the sync.'
    );
  }
  return pw;
}

export const hasPlaywright = async () => !!(await (playwrightPromise ??= import('playwright').catch(() => null)));

/**
 * Runs `fn(page)` inside a fresh, isolated browser context.
 * Storage state is per-run: credentials never touch disk.
 */
export async function withPage(fn, { headless = true, timeout = 45_000 } = {}) {
  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch({ headless });
  try {
    const ctx = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    });
    ctx.setDefaultTimeout(timeout);
    const page = await ctx.newPage();
    return await fn(page);
  } finally {
    await browser.close();
  }
}

/**
 * A declarative login: fill the user/password selectors, submit, wait for a
 * post-login marker. Selectors live in the channel's config so an operator can
 * repair a portal redesign from the UI without a code change.
 */
export async function login(page, { loginUrl, userSelector, passSelector, submitSelector, readySelector }, creds) {
  await page.goto(loginUrl, { waitUntil: 'domcontentloaded' });
  await page.fill(userSelector, creds.username);
  await page.fill(passSelector, creds.password);
  await Promise.all([
    page.waitForLoadState('networkidle').catch(() => {}),
    page.click(submitSelector),
  ]);
  if (readySelector) {
    await page.waitForSelector(readySelector, { timeout: 30_000 }).catch(() => {
      throw new Error('Logged in but the expected dashboard element never appeared — the portal may be asking for MFA, or the `readySelector` needs updating in channel settings.');
    });
  }
}

/** Money out of scraped text: "$1,234.56", "1 234,56 €", "USD 12.00". */
export function parseMoney(text) {
  if (text == null) return 0;
  const s = String(text).replace(/[^\d.,-]/g, '').trim();
  if (!s) return 0;
  // Last separator with <=2 trailing digits is the decimal mark.
  const m = /[.,](\d{1,2})$/.exec(s);
  const normalised = m
    ? s.slice(0, m.index).replace(/[.,]/g, '') + '.' + m[1]
    : s.replace(/[.,]/g, '');
  const n = Number.parseFloat(normalised);
  return Number.isFinite(n) ? n : 0;
}

export function parseCount(text) {
  const n = Number.parseInt(String(text ?? '').replace(/[^\d]/g, ''), 10);
  return Number.isFinite(n) ? n : 0;
}

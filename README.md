# Run Marketing

A multi-project marketing dashboard that answers one question per channel: **what did it
cost, and what did it return?** — and then tells you what is missing from the setup that
would make that answer wrong.

It covers channels with a real API (Google Ads, Meta, LinkedIn, Reddit), channels with no
API at all (Capterra, G2, GetApp — signed into with stored credentials and read off the
page), and channels that are just money leaving a bank account (a conference booth, a
newsletter placement, an agency retainer). A tracking SDK closes the loop from the ad
click through to the named person who paid, and Stripe supplies what they actually paid.

```
ad platforms ─┐
portals ──────┼─→ spend per channel per day ─┐
manual/CSV ───┘                              ├─→ dashboard: CAC · CPL · ROAS · LTV · funnel
                                             │   audit: what's missing
your product ─→ SDK ─→ visits · leads · ──────┤
                       identities            │
Stripe ───────────→ charges · refunds · ──────┘
                    subscriptions · MRR
```

## Quick start

```bash
npm install
cp .env.example .env          # set RUNHQ_SECRET before storing real credentials
npm run build                 # builds the SDK and the dashboard
npm start                     # http://localhost:4000
```

It starts empty. Create a project, add the channels you actually spend on, and install the
SDK — there is no demo data.

For development, `npm run dev` runs the API on :4000 and Vite on :5173 with a proxy.

Requires Node 22.13+ (it uses the built-in `node:sqlite`). There is no database server to
install — the whole thing is one SQLite file at `packages/server/data/marketing.db`.

## What's in the box

| Screen | What it answers |
|---|---|
| **Projects** | Every project as a card: spend, revenue, return, and a running-total chart. One row of account totals on top. |
| **Dashboard** | One project: return on spend, CAC, cost per lead, the funnel, and a per-channel P&L table. |
| **Channels** | Add and authenticate channels, sync them, enter spend by hand, import CSVs, edit attribution rules and scrape recipes. |
| **Leads** | Every person, what brought them, how far they got, and a full event timeline per lead. |
| **Revenue** | Stripe: MRR, ARR, churn, refunds, the payment ledger, and LTV against CAC per channel. |
| **Audit** | The gap list — missing pixels, untagged channels, anonymous leads, CAC over target — plus a live scan of your site's HTML. |
| **Setup** | SDK key, install snippets, funnel stage editor, project settings. |

## How attribution works

Every visit is matched to a channel in this order, most trustworthy first:

1. an explicit `?run_channel=<id>` on the landing URL
2. a platform **click ID** — `gclid`, `fbclid`, `msclkid`, `li_fat_id`… (set by the
   platform, not by a human, so it cannot be mistyped)
3. `utm_campaign` + `utm_source`, which is how two channels on one ad account stay apart
4. `utm_source`, then `utm_medium`
5. the referring host

Anything that matches nothing lands in **Unattributed**, visible as its own row on the
channel table. That is deliberate: hiding untagged traffic would flatter the cost per lead
of every channel that *is* tagged.

Both **first touch** (the ad that found them) and **last touch** (the most recent tagged
visit) are stored per lead; the toggle in the header switches the whole dashboard between
them. Review sites tend to look much better under first touch, and that difference is
usually worth knowing.

Channel-level rules override the provider defaults, so `utm_campaign=brand` and
`utm_campaign=nonbrand` can be two separate channels on one Google Ads account.

## Channel types

| Auth type | How spend arrives | Examples |
|---|---|---|
| **API token** | The platform issues a long-lived token. | Meta Ads |
| **OAuth** | Refresh token exchanged per sync. | Google Ads, LinkedIn, Reddit |
| **Portal login** | Headless browser signs in and reads the numbers off the page. | Capterra, G2, GetApp |
| **Manual / CSV** | Typed in, or imported from any platform's daily export. | Conferences, sponsorships, retainers, Microsoft Ads, X Ads |

Every channel can fall back to manual entry — an expired token should degrade to typing
last month's number in, never to a blind spot.

**Portal logins** need Playwright. It ships as an optional dev dependency, so only the
browser binary has to be fetched: `npx playwright install chromium`. Everything else in
the app runs fine without it, and a credentials-based sync reports a clear error instead
of crashing. The selectors used to log in and read the report are stored in the channel's
config and editable from the UI, so a portal redesign is a settings change rather than a
release. Use a dedicated read-only account without MFA.

### Adding a provider

Add an object to `packages/server/src/connectors/`:

```js
export const myPlatform = {
  id: 'my_platform',
  label: 'My Platform',
  category: 'paid_social',
  authTypes: ['api'],
  fields: { api: [{ key: 'token', label: 'API token', secret: true, required: true }] },
  match: { utm_source: ['myplatform'], clickIds: ['mpclid'] },
  checklist: [{ code: 'pixel', label: 'Pixel installed', detects: 'my_pixel' }],
  async fetchSpend({ creds, from, to }) {
    return { rows: [{ date: '2026-09-01', spend: 12.34, clicks: 10, impressions: 900 }] };
  },
};
```

Register it in `connectors/index.js`. Everything else — the add-channel UI, credential
encryption, sync history, attribution, the audit — picks it up from that declaration.

## Revenue

Spend is only half a ratio. The **Revenue** tab connects Stripe and reads what customers
actually paid, so ROAS, CAC and LTV stop depending on the product remembering to report
its own income.

```
Stripe charge → matched to a lead by email → credited to that lead's channel
```

A connected account backfills a year of charges, refunds and subscriptions on its first
sync, then keeps up on the same schedule as the channels. Every payment is mirrored into
the event stream, so it reaches the dashboard, the funnel and the per-channel P&L through
exactly the same path a `runhq.revenue()` call would have taken — nothing downstream needs
to know Stripe exists.

**Connecting.** Paste a secret key, or better a restricted key (`rk_live_…`) with **read**
access to Charges, Refunds, Subscriptions and Customers. The key is verified against the
API before it is stored, then encrypted at rest under `RUNHQ_SECRET` like any other
credential; the UI only ever sees its last four characters. Nothing in this app writes to
Stripe.

**Webhooks.** Optional but worth it: without one, revenue moves only when a sync runs.
Add an endpoint in the Stripe dashboard pointing at the URL shown on the source's settings
(`/api/revenue/stripe/<source id>`), subscribe it to the charge, refund and subscription
events, and paste the signing secret back in. Deliveries are verified against the raw
request bytes with a timing-safe comparison and a five-minute replay window; anything that
fails verification is rejected before the payload is parsed. The endpoint sits outside the
admin-token gate, because Stripe cannot present a token — the signature is the auth.

**Matching.** Payments join to leads on the email the customer paid with, then on the
Stripe customer id if your product passes it to `runhq.identify()`. A payer who matches
nothing still becomes a lead — an unattributed one — because a customer whose first touch
was never tracked is a real hole in the attribution, and the honest place to show it is
the Unattributed row rather than nowhere. The audit reports the share of revenue in that
state.

**Counting it once.** If the product already calls `runhq.revenue()`, remove those calls
once Stripe is connected: the two describe the same money, and the audit raises
`revenue_double_counted` when it sees both in one window. Stripe also knows about refunds,
proration and failed renewals, which a `track()` call generally does not.

| Number | How it is counted |
|---|---|
| **Gross / net** | Charges, less refunds. A refund is dated when it happened, not backdated to the charge — last month's revenue does not move because someone refunded today. |
| **MRR** | `active` subscriptions only, each price normalised to a month. Trials have paid nothing and `past_due` has stopped paying; both are reported as their own counts rather than folded in. |
| **Churn** | Subscriptions cancelled in the window over everything live at any point in it, by count and by the MRR those subscriptions carried. |
| **LTV : CAC** | Lifetime, all dates, on both sides — a ratio of one window's spend to another's revenue is not a ratio of anything. Under 1× means the channel has not paid for itself yet. |
| **Payback** | Acquisition cost divided by that channel's monthly recurring revenue per customer. |

Re-syncing is free: rows key on Stripe's own ids, so an overlapping backfill updates in
place instead of counting the same money twice. Disconnecting removes the account, its
payments and the revenue they contributed; the leads stay, because they are real people.

Amounts are stored in the currency they were charged in and summed as-is, with no
conversion — the audit flags it when that differs from the project currency.

## The SDK

```html
<script async src="https://your-host/sdk.js" data-runhq-key="run_pk_…"></script>
```

```js
import runhq from '@runhq/sdk';
runhq.init({ key: 'run_pk_…', host: 'https://your-host' });

runhq.identify(user.id, { email: user.email, company: user.company });
runhq.stage('trial');
runhq.track('demo_booked');
runhq.revenue(499, { plan: 'pro' });
```

Automatic: page views (including SPA route changes), UTM and click-ID capture, a stable
anonymous id cookie that survives a subdomain hop, a first-touch record that is written
once and never overwritten, batching, retry, and a `sendBeacon` flush on page hide.

Put it on the **marketing site as well as the product**. On the marketing site it captures
the touch that found the person; in the product it reports who they became. Only having
the second half is the most common reason a dashboard like this reports nothing useful.

Identities merge: an anonymous session that later identifies as an existing person is
folded into that person's record, events included, with the earlier first touch kept.

## Provisioning a project from a file

Clicking a project together in the UI is fine once. It is not a good *record* of how one
is set up: nobody can review it, nothing reproduces it on a second install, and a
channel's UTM rules — the thing attribution actually turns on — end up known only to
whoever typed them. So a project can also be declared:

```bash
npm run provision projects/arrr-fun.json          # against http://localhost:4000
npm run provision -- projects/arrr-fun.json --host https://run.example.com --dry-run
```

```json
{
  "project": { "name": "arrr.fun", "website": "https://www.arrr.fun", "currency": "USD" },
  "stages":  [{ "key": "visit", "label": "Visit" },
              { "key": "customer", "label": "Paid", "is_conversion": true }],
  "channels": [{ "provider": "manual", "name": "Creator payouts",
                 "config": { "match": { "utm_medium": ["affiliate"] } } }]
}
```

It talks to the HTTP API, not the database, so the same command provisions a local install
and a deployed one. **Re-running is the point**: the project is matched by slug and
reconciled in place, so a spec edit is applied by running it again, and the SDK key never
rotates underneath the sites that carry it. It never deletes — a channel dropped from the
spec is reported and left alone, because removing one takes its spend history with it.

`projects/` holds the specs that are live. `projects/arrr-fun.json` is the arrr.fun game
platform (`www.arrr.fun`, `play.arrr.fun`), whose funnel runs
visit → played a match → signed in → engaged → opened checkout → paid, with revenue read
from Stripe rather than reported by the game.

## The audit

Re-runnable from the Audit tab; it re-fetches your site each time. It checks:

- **Tracking** — SDK events arriving at all; the tag present on the homepage, not only in the app
- **Pixels** — each channel's required tag (Meta Pixel, Google tag, LinkedIn Insight, UET…) actually present in your HTML
- **Attribution** — share of leads with no channel; channels that spend but receive no UTM-tagged arrivals; share of leads with no identity
- **Channels** — never synced, stale, failing, or configured with no credentials; manual channels with no spend entered
- **Economics** — CAC against the project target, per-channel CAC outliers, spend with no revenue, negative ROAS
- **Revenue** — no processor connected, a test-mode key, a failing or stale sync, payments matched to nobody, revenue arriving from both the SDK and Stripe, a currency that is not the project's
- **Assets** — `og:image` (the link-preview banner), Open Graph title, meta description, favicon, canonical
- **Setup checklists** — the per-channel steps no API can confirm: a Capterra listing banner, screenshots, lead routing into the CRM

The site scan reads **server-rendered HTML only**. A tag injected client-side by a tag
manager or held behind a consent gate will read as missing; confirm it in the browser and
dismiss the finding. Dismissed findings stay dismissed; fixed ones close on the next run.

## Security

- Channel credentials are encrypted at rest with AES-256-GCM under `RUNHQ_SECRET`. Set it
  before entering anything real — without it, a well-known development key is used and the
  server says so on boot. Rotating it means re-entering credentials.
- Credential values are never returned to the browser: the UI only ever sees which fields
  are set, with secrets masked to their last four characters.
- `/api/collect` is public by design — it is called from your own site with a
  *publishable* key that identifies a project and grants nothing else.
- `/api/revenue/stripe/<source id>` is public for the same reason — Stripe cannot present
  an admin token. It authenticates on the signature instead: HMAC-SHA256 over the raw
  request bytes, compared in constant time, within a five-minute window. An unknown source
  id is refused exactly like a bad signature, so the endpoint cannot be enumerated.
- Stripe keys are sealed with the same AES-256-GCM envelope as channel credentials and are
  never returned to the browser. Use a restricted, read-only key: nothing here needs write
  access, and a leaked read key cannot move money.
- The admin API is unauthenticated by default, which is fine on localhost. Set
  `RUNHQ_ADMIN_TOKEN` to require `Authorization: Bearer …` before exposing it anywhere else.
  There is no user model or per-user permissions yet.

## Tests

```bash
npm test          # tests: attribution, ingest, analytics, audit, CSV, Stripe, HTTP API, SDK-in-a-browser
```

The browser tests drive the real SDK in headless Chromium against the real server and skip
themselves if Playwright is not installed.

## Layout

```
packages/
  server/   Node 22 + node:sqlite, no framework. Connectors, revenue, ingest, analytics, audit, HTTP API.
  sdk/      Dependency-free tracking SDK; builds to a script tag and an ES module.
  web/      React + Vite dashboard. Charts are hand-rolled SVG.
projects/   Declarative project specs — see "Provisioning a project from a file".
```

## Known limits

- Attribution is single-touch (first or last), not multi-touch or time-decayed.
- Revenue is counted on the day the payment (or event) lands; a long sales cycle can push
  a deal outside the window that paid for it. Widen the range before cutting a channel.
- Currency is per project; multi-currency channels and payments are stored in their own
  currency and summed as-is rather than converted at a dated rate.
- Stripe is the only revenue source so far. It reads charges, refunds and subscriptions —
  not disputes, payouts, or invoice line items, so tax and fees are not separated out.
- Portal scrapers depend on selectors that vendors change without warning.
- Single-tenant, no login. Run it behind your own auth if it is not on localhost.

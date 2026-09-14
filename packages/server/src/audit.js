import { all, get, run, uid, now } from './db.js';
import { listChannels, projectStages, channelConfig } from './store.js';
import { getProvider } from './connectors/index.js';
import { latestScan, TRACKER_LABELS } from './scanner.js';
import { listRevenueSources, sourceCredentials } from './revenue/index.js';
import { projectTotals, channelBreakdown } from './analytics.js';

/**
 * The gap audit — "what am I lacking".
 *
 * Every check returns findings with a stable `code` + `scope_id`, so re-running the
 * audit updates the same row rather than growing a pile of duplicates, and a finding
 * you dismissed stays dismissed until it genuinely goes away and comes back.
 *
 * Severity: critical = you are losing data or money right now; serious = attribution is
 * unreliable; warning = worth fixing this week; info = a setup step nobody confirmed.
 */
const SEVERITY_RANK = { critical: 0, serious: 1, warning: 2, info: 3 };

export function runAudit(project, { days = 30 } = {}) {
  const to = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - (days - 1) * 86400_000).toISOString().slice(0, 10);
  const range = { from, to };

  const channels = listChannels(project.id);
  const totals = projectTotals(project.id, range);
  const breakdown = channelBreakdown(project.id, range);
  const scan = latestScan(project.id);
  const stages = projectStages(project.id);

  const findings = [
    ...checkTracking(project, totals, scan),
    ...checkChannels(project, channels, breakdown, scan),
    ...checkAttribution(project, totals, breakdown),
    ...checkRevenueSources(project, totals, range),
    ...checkEconomics(project, totals, breakdown),
    ...checkFunnel(project, stages),
    ...checkAssets(project, scan),
  ];

  persist(project.id, findings);
  return listFindings(project.id);
}

const f = (code, severity, title, detail, fix, scope = 'project', scope_id = null) =>
  ({ code, severity, title, detail, fix, scope, scope_id });

/* ------------------------------------------------------ end-to-end tracking */

function checkTracking(project, totals, scan) {
  const out = [];
  const recentEvents = get(
    `SELECT COUNT(*) AS n FROM events WHERE project_id = :p AND ts > :since`,
    { p: project.id, since: new Date(Date.now() - 7 * 86400_000).toISOString() })?.n ?? 0;

  if (!recentEvents) {
    out.push(f('sdk_no_events', 'critical',
      'The SDK has sent no events in 7 days',
      'Without product events there is no funnel: spend can be measured, but nothing downstream of the click can be. Every conversion number on this project is currently zero by absence, not by fact.',
      'Install @runhq/sdk in the product and call runhq.init() with this project\'s key — the snippet is on the Setup tab.'));
  }

  if (!project.website) {
    out.push(f('no_website', 'warning',
      'No website URL on this project',
      'The site audit cannot check for missing pixels or link-preview assets until it knows where to look.',
      'Add the website URL in project settings, then run a site scan.'));
  } else if (!scan) {
    out.push(f('never_scanned', 'info',
      'The site has never been scanned',
      'A scan reads your live HTML and reports which ad pixels and preview assets are actually present.',
      'Run a site scan from the Audit tab.'));
  } else if (!scan.ok) {
    out.push(f('site_unreachable', 'serious',
      'The site could not be fetched',
      scan.error || 'The last scan failed.',
      'Check the URL, and that the site answers an unauthenticated request from this server.'));
  } else if (!scan.detected?.trackers?.runhq_sdk && recentEvents) {
    out.push(f('sdk_not_on_homepage', 'info',
      'SDK events arrive, but the tag is not on the homepage',
      'Events are being received, yet the homepage HTML contains no SDK snippet. That usually means tracking starts inside the app and anonymous first touches on the marketing site are being lost.',
      'Add the SDK snippet to the marketing site as well, so the first touch is captured before signup.'));
  }
  return out;
}

/* -------------------------------------------------------- per-channel gaps */

function checkChannels(project, channels, breakdown, scan) {
  const out = [];
  if (!channels.length) {
    out.push(f('no_channels', 'critical',
      'No channels configured',
      'This project has no spend sources, so there is nothing to divide leads and revenue against.',
      'Add your channels — Google Ads, Meta, Capterra, conferences — on the Channels tab.'));
    return out;
  }

  const byId = Object.fromEntries(breakdown.map((r) => [r.channel_id, r]));
  const trackers = scan?.detected?.trackers ?? {};
  const scanUsable = !!scan?.ok;

  for (const c of channels) {
    const provider = getProvider(c.provider);
    const row = byId[c.id] ?? { spend: 0, leads: 0, revenue: 0, customers: 0 };
    const cfg = channelConfig(c);

    if (c.status === 'unconfigured' && c.auth_type !== 'manual') {
      out.push(f('channel_unconfigured', 'serious',
        `${c.name} has no credentials`,
        `The channel is set to ${c.auth_type} authentication but nothing has been entered, so it will never sync.`,
        'Open the channel and enter its credentials, or switch it to manual entry.', 'channel', c.id));
    }

    if (c.last_sync_status === 'error') {
      out.push(f('channel_sync_error', 'critical',
        `${c.name} sync is failing`,
        c.last_sync_error || 'The last sync returned an error.',
        'Re-check the credentials; for portal logins, confirm MFA is off for this account and the scrape selectors still match.', 'channel', c.id));
    } else if (c.auth_type !== 'manual' && provider?.fetchSpend && !c.last_sync_at) {
      out.push(f('channel_never_synced', 'warning',
        `${c.name} has never synced`,
        'Spend for this channel is entirely absent, which flatters every cost-per-lead number on the dashboard.',
        'Run a sync from the channel row.', 'channel', c.id));
    } else if (c.last_sync_at && Date.parse(c.last_sync_at) < Date.now() - 3 * 86400_000) {
      out.push(f('channel_stale', 'warning',
        `${c.name} last synced ${daysAgo(c.last_sync_at)} days ago`,
        'Recent days are missing spend, so cost per lead reads lower than it is.',
        'Sync the channel, or enable the scheduled sync.', 'channel', c.id));
    }

    if (c.auth_type === 'manual' && !row.spend) {
      out.push(f('manual_spend_missing', 'warning',
        `No spend entered for ${c.name}`,
        'This is a manual channel and no cost has been recorded for the period, so its leads look free.',
        'Enter the period\'s cost on the channel, or import a CSV.', 'channel', c.id));
    }

    if (row.spend > 0 && row.leads === 0) {
      out.push(f('spend_no_leads', 'critical',
        `${c.name} spent ${money(row.spend, project.currency)} and produced no tracked leads`,
        'Either the channel genuinely is not working, or its landing URLs are untagged and the leads are landing in Unattributed. Those two have very different fixes, and the difference is visible on the Leads tab.',
        `Check that ad URLs carry utm_source for this channel${provider?.match?.utm_source?.length ? ` (expected: ${provider.match.utm_source.join(', ')})` : ''}.`, 'channel', c.id));
    } else if (row.spend > 0 && row.customers === 0 && row.leads > 0) {
      out.push(f('spend_no_customers', 'warning',
        `${c.name} produced leads but no conversions`,
        `${row.leads} lead${row.leads === 1 ? '' : 's'} and ${money(row.spend, project.currency)} spent, with nothing reaching a conversion stage in this window.`,
        'Long sales cycle, or the conversion event is not firing — check the funnel for this channel.', 'channel', c.id));
    }

    // Provider checklists: the pixel/banner/setup items each channel is supposed to have.
    for (const item of provider?.checklist ?? []) {
      if (item.detects === 'manual') {
        if (cfg.checklist?.[item.code] === true) continue;
        out.push(f(`checklist_${item.code}`, 'info',
          `${c.name}: ${item.label}`,
          'Nobody has confirmed this setup step. It is not something the app can detect on its own.',
          'Confirm it on the channel, or tick it off once done.', 'channel', c.id));
      } else if (item.detects === 'utm') {
        // Verified against real traffic below, in checkAttribution.
      } else if (scanUsable && trackers[item.detects] === false) {
        const sev = row.spend > 0 ? 'critical' : 'warning';
        out.push(f(`missing_tracker_${item.detects}`, sev,
          `${TRACKER_LABELS[item.detects] ?? item.detects} is missing from the site`,
          `${c.name} is ${row.spend > 0 ? `spending ${money(row.spend, project.currency)}` : 'configured'}, but the tag it needs to optimise and report conversions was not found in your homepage HTML. The scan reads server-rendered HTML only — if this tag is injected by a tag manager or a consent gate, confirm it in the browser and dismiss this finding.`,
          `Install ${TRACKER_LABELS[item.detects] ?? item.detects} — without it the platform optimises blind and its own reporting will disagree with this dashboard.`, 'channel', c.id));
      }
    }
  }
  return out;
}

/* ----------------------------------------------------- attribution quality */

function checkAttribution(project, totals, breakdown) {
  const out = [];
  if (totals.leads >= 10) {
    const pct = Math.round((totals.unattributed_leads / totals.leads) * 100);
    if (pct >= 40) {
      out.push(f('unattributed_high', 'critical',
        `${pct}% of leads have no channel`,
        `${totals.unattributed_leads} of ${totals.leads} leads arrived with no UTM parameters and no recognisable click ID, so no spend can be charged against them. Cost per lead for every other channel is overstated by exactly this much.`,
        'Tag every outbound link and ad destination with utm_source/utm_medium. The Leads tab, filtered to Unattributed, shows the referrers they actually came from.'));
    } else if (pct >= 15) {
      out.push(f('unattributed_moderate', 'serious',
        `${pct}% of leads have no channel`,
        `${totals.unattributed_leads} of ${totals.leads} leads could not be attributed to any channel.`,
        'Review the Unattributed rows on the Leads tab and add UTM rules or tags for the referrers you see there.'));
    }

    const idPct = Math.round((totals.identified_leads / totals.leads) * 100);
    if (idPct < 50) {
      out.push(f('identity_low', 'serious',
        `Only ${idPct}% of leads have an identity`,
        'The rest are anonymous browsers. They can be counted, but never matched to a customer, a deal, or revenue — so the funnel below "Lead" is guesswork for most of your traffic.',
        'Call runhq.identify() as soon as an email is known — signup, demo form, trial start — and pass the CRM id as user_id.'));
    }
  }

  // A channel whose provider expects UTMs, that has spend but no UTM-tagged arrivals.
  for (const row of breakdown) {
    if (!row.channel_id || row.spend <= 0) continue;
    const tagged = get(
      `SELECT COUNT(*) AS n FROM leads WHERE project_id = :p AND channel_id = :c AND utm_source IS NOT NULL`,
      { p: project.id, c: row.channel_id })?.n ?? 0;
    const viaClickId = get(
      `SELECT COUNT(*) AS n FROM leads WHERE project_id = :p AND channel_id = :c AND click_id IS NOT NULL`,
      { p: project.id, c: row.channel_id })?.n ?? 0;
    if (!tagged && !viaClickId) {
      out.push(f('channel_no_utm', 'serious',
        `${row.name}: no UTM-tagged arrivals`,
        'Money is going out on this channel and not one visitor has arrived carrying its UTM parameters or click ID. Whatever it produces is currently being credited to Unattributed or to another channel.',
        'Add utm_source (and utm_medium) to every destination URL for this channel.', 'channel', row.channel_id));
    }
  }
  return out;
}

/* -------------------------------------------------------- revenue sources */

/**
 * Revenue is the one number on this dashboard nobody can sanity-check by eye, and it is
 * the denominator of every ratio here. These checks are about whether the figure came
 * from somewhere that knows — and whether it is being counted exactly once.
 */
function checkRevenueSources(project, totals, range) {
  const out = [];
  const sources = listRevenueSources(project.id);
  const cur = project.currency;

  if (!sources.length) {
    out.push(f('revenue_not_connected', totals.spend > 0 ? 'warning' : 'info',
      'No payment processor is connected',
      'Revenue is whatever the SDK was told to report. That is fine when the product sends it faithfully, and silently wrong when a plan change, a refund or an annual upgrade never makes it into a track() call. Connecting the processor makes revenue something measured rather than something declared.',
      'Connect Stripe on the Revenue tab. It backfills a year of charges and matches them to leads by email.'));
    return out;
  }

  const paymentsInRange = get(
    `SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS amount,
            SUM(CASE WHEN lead_id IS NULL THEN 1 ELSE 0 END) AS unmatched,
            COALESCE(SUM(CASE WHEN lead_id IS NULL THEN amount ELSE 0 END), 0) AS unmatched_amount
     FROM payments WHERE project_id = :p AND substr(occurred_at, 1, 10) BETWEEN :from AND :to`,
    { p: project.id, from: range.from, to: range.to });

  for (const s of sources) {
    const label = s.name || s.provider;

    if (s.livemode === 0) {
      out.push(f('revenue_test_mode', 'warning',
        `${label} is connected in test mode`,
        'The key is a test key, so every figure on the Revenue tab — and the revenue half of every ROAS and LTV number on this dashboard — is Stripe test data, not money anyone paid.',
        'Replace the key with a live one (sk_live_… or a live restricted key) once you are done testing.', 'revenue_source', s.id));
    }

    if (s.last_sync_status === 'error') {
      out.push(f('revenue_sync_error', 'critical',
        `${label} sync is failing`,
        s.last_sync_error || 'The last sync returned an error.',
        'Check the key is still valid and has read access to Charges, Refunds, Subscriptions and Customers. A restricted key that lost a permission fails exactly like this.', 'revenue_source', s.id));
    } else if (!s.last_sync_at) {
      out.push(f('revenue_never_synced', 'warning',
        `${label} has never synced`,
        'The account is connected but no payments have been read from it yet, so revenue is still whatever the SDK reported.',
        'Run a sync from the Revenue tab. The first one reaches back a year.', 'revenue_source', s.id));
    } else {
      const quiet = Math.max(Date.parse(s.last_sync_at), Date.parse(s.last_hook_at ?? 0) || 0);
      if (quiet < Date.now() - 2 * 86400_000) {
        out.push(f('revenue_stale', 'warning',
          `${label} last updated ${daysAgo(s.last_sync_at)} days ago`,
          'Recent payments are missing, so revenue reads low and every return-on-spend number with it.',
          'Sync it, or leave the scheduled sync enabled (RUNHQ_SYNC_INTERVAL_HOURS).', 'revenue_source', s.id));
      }
    }

    if (!sourceCredentials(s)?.webhook_secret) {
      out.push(f('revenue_no_webhook', 'info',
        `${label} has no webhook configured`,
        `Revenue only moves when a sync runs, so the dashboard lags real payments by up to ${process.env.RUNHQ_SYNC_INTERVAL_HOURS || 6} hours.`,
        'Add an endpoint in the Stripe dashboard pointing at this app, and paste its signing secret into the source settings — the exact URL is shown there.', 'revenue_source', s.id));
    }
  }

  // Both halves reporting the same money is the failure this integration can cause that
  // the old setup could not, so it gets checked explicitly rather than left to be noticed.
  const sdk = get(
    `SELECT COALESCE(SUM(value), 0) AS revenue FROM events
     WHERE project_id = :p AND value > 0 AND dedupe_key IS NULL
       AND substr(ts, 1, 10) BETWEEN :from AND :to`,
    { p: project.id, from: range.from, to: range.to })?.revenue ?? 0;

  if (sdk > 0 && paymentsInRange.n > 0) {
    out.push(f('revenue_double_counted', 'serious',
      'Revenue is arriving from both the SDK and the processor',
      `${money(sdk, cur)} came from runhq.revenue() calls and ${money(paymentsInRange.amount, cur)} from the connected processor, over the same period. If those describe the same transactions, every revenue, ROAS and LTV figure here is roughly double what it should be.`,
      'Remove the runhq.revenue() calls and let the processor be the source of truth — it already knows about refunds, proration and failed renewals. Keep them only for revenue Stripe never sees.'));
  }

  if (paymentsInRange.n >= 5) {
    const pct = Math.round((paymentsInRange.unmatched / paymentsInRange.n) * 100);
    if (pct >= 20) {
      out.push(f('revenue_unmatched', 'serious',
        `${pct}% of payments are not matched to a tracked lead`,
        `${money(Math.abs(paymentsInRange.unmatched_amount), cur)} was paid by people this app has no lead record for, so that money is credited to no channel. Payments are matched on the email the customer paid with — a checkout that collects a different address from the signup form breaks the join for everyone.`,
        'Pass the same email to runhq.identify() that the customer pays with, or set the Stripe customer id as user_id so the two records meet on that instead.'));
    }
  }

  const currencies = all(
    'SELECT DISTINCT currency FROM payments WHERE project_id = :p', { p: project.id }).map((r) => r.currency);
  const foreign = currencies.filter((c) => c && c !== project.currency);
  if (foreign.length) {
    out.push(f('revenue_currency_mismatch', 'warning',
      `Payments arrive in ${foreign.join(', ')}, but this project reports in ${project.currency}`,
      'Amounts are stored in the currency they were charged in and summed as-is, with no conversion. Revenue totals here are therefore a sum of different units, and any channel whose customers pay in a foreign currency is misreported by the exchange rate.',
      `Either set the project currency to the one you actually bill in, or split the foreign-currency business into its own project.`));
  }

  return out;
}

/* ---------------------------------------------------------- unit economics */

function checkEconomics(project, totals, breakdown) {
  const out = [];
  const cur = project.currency;

  if (project.target_cac && totals.cac && totals.cac > project.target_cac) {
    out.push(f('cac_over_target', 'serious',
      `Blended CAC is ${money(totals.cac, cur)} against a ${money(project.target_cac, cur)} target`,
      `${money(totals.spend, cur)} spent for ${totals.customers} customer${totals.customers === 1 ? '' : 's'} in the period.`,
      'Cut or pause the channels above target on the channel table, and move the budget to the ones under it.'));
  }

  if (totals.spend > 0 && totals.revenue === 0) {
    out.push(f('no_revenue_recorded', 'serious',
      'Spend is recorded but revenue is not',
      `${money(totals.spend, cur)} went out and no event carried a value, so ROI cannot be computed for any channel.`,
      'Connect Stripe on the Revenue tab — it reads what customers actually paid. Failing that, send a value with your conversion events: runhq.revenue(499).'));
  }

  for (const row of breakdown) {
    if (!row.channel_id || row.spend < 50) continue;
    if (row.roas != null && row.roas < 1 && row.revenue > 0) {
      out.push(f('channel_negative_roas', 'warning',
        `${row.name} is returning ${row.roas.toFixed(2)}× on spend`,
        `${money(row.spend, cur)} in, ${money(row.revenue, cur)} out over the period.`,
        'Either the channel is unprofitable, or its revenue lands outside this window because of a long sales cycle — widen the date range before cutting it.', 'channel', row.channel_id));
    }
    if (project.target_cac && row.cac && row.cac > project.target_cac * 1.5) {
      out.push(f('channel_cac_over', 'warning',
        `${row.name} costs ${money(row.cac, cur)} per customer`,
        `That is ${(row.cac / project.target_cac).toFixed(1)}× the project target of ${money(project.target_cac, cur)}.`,
        'Review the creative and targeting, or shift this budget to a channel under target.', 'channel', row.channel_id));
    }
  }
  return out;
}

function checkFunnel(project, stages) {
  const out = [];
  if (!stages.some((s) => s.is_conversion)) {
    out.push(f('no_conversion_stage', 'serious',
      'No funnel stage is marked as the conversion',
      'Without a conversion stage the app cannot count customers, so CAC and conversion rate stay empty.',
      'Mark the closing stage as the conversion in project settings.'));
  }
  const unused = stages.filter((s) => !get(
    'SELECT 1 AS x FROM events WHERE project_id = :p AND stage = :s LIMIT 1', { p: project.id, s: s.key }));
  if (unused.length && unused.length < stages.length) {
    out.push(f('unused_stages', 'info',
      `${unused.length} funnel stage${unused.length === 1 ? ' never fires' : 's never fire'}`,
      `No event has ever carried ${unused.map((s) => `"${s.label}"`).join(', ')}. The funnel will always show a cliff there.`,
      'Either send an event for that stage from the product, or remove the stage.'));
  }
  return out;
}

function checkAssets(project, scan) {
  const out = [];
  const page = scan?.detected?.page;
  if (!scan?.ok || !page) return out;

  if (!page.og_image) {
    out.push(f('missing_og_image', 'warning',
      'No link-preview banner (og:image)',
      'Every share of your URL — ads, Slack, LinkedIn, X — renders as a bare text link. This is the single cheapest click-through fix on the list.',
      'Add <meta property="og:image" content="..."> with a 1200×630 image.'));
  }
  if (!page.meta_description) {
    out.push(f('missing_meta_description', 'info',
      'No meta description',
      'Search and social previews will pull an arbitrary sentence from the page instead of your pitch.',
      'Add a 150–160 character <meta name="description">.'));
  }
  if (!page.og_title) {
    out.push(f('missing_og_title', 'info',
      'No Open Graph title',
      'Shared links fall back to the page title, which is usually written for search, not for a feed.',
      'Add <meta property="og:title">.'));
  }
  if (!page.favicon) {
    out.push(f('missing_favicon', 'info', 'No favicon',
      'Tabs and bookmarks show a blank page icon.', 'Add a <link rel="icon">.'));
  }
  return out;
}

/* ------------------------------------------------------------- persistence */

function persist(projectId, findings) {
  const ts = now();
  const seen = new Set();
  for (const x of findings) {
    const key = `${x.code}|${x.scope_id ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    run(`INSERT INTO audit_findings (id, project_id, code, scope, scope_id, severity, title, detail, fix, status, first_detected, last_detected)
         VALUES (:id, :p, :code, :scope, :sid, :sev, :title, :detail, :fix, 'open', :ts, :ts)
         ON CONFLICT(project_id, code, scope_id) DO UPDATE SET
           severity = excluded.severity, title = excluded.title, detail = excluded.detail,
           fix = excluded.fix, last_detected = excluded.last_detected,
           -- a dismissed finding stays dismissed; a resolved one that recurs reopens
           status = CASE WHEN audit_findings.status = 'dismissed' THEN 'dismissed' ELSE 'open' END`, {
      id: uid(), p: projectId, code: x.code, scope: x.scope, sid: x.scope_id, sev: x.severity,
      title: x.title, detail: x.detail, fix: x.fix, ts,
    });
  }
  // Anything not re-detected this run is fixed.
  run(`UPDATE audit_findings SET status = 'resolved' WHERE project_id = :p AND last_detected < :ts AND status = 'open'`,
    { p: projectId, ts });
}

export function listFindings(projectId, { status = 'open' } = {}) {
  const rows = status === 'all'
    ? all('SELECT * FROM audit_findings WHERE project_id = :p', { p: projectId })
    : all('SELECT * FROM audit_findings WHERE project_id = :p AND status = :s', { p: projectId, s: status });
  return rows.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.title.localeCompare(b.title));
}

export function setFindingStatus(id, status) {
  run('UPDATE audit_findings SET status = :s WHERE id = :id', { id, s: status });
  return get('SELECT * FROM audit_findings WHERE id = :id', { id });
}

/**
 * One number for the project card: 100 minus weighted open findings.
 *
 * A project the audit has never run against scores `null`, not 100 — an empty findings
 * table means "nothing has been checked", and reporting that as a perfect score is the
 * one thing an audit must never do.
 */
export function healthScore(projectId) {
  const everRun = (get('SELECT COUNT(*) AS n FROM audit_findings WHERE project_id = :p', { p: projectId })?.n ?? 0) > 0;
  if (!everRun) return { score: null, audited: false, open: 0, counts: { critical: 0, serious: 0, warning: 0, info: 0 } };
  const open = listFindings(projectId);
  // Info findings are mostly unconfirmed setup steps — a new project starts with a
  // pile of them, and they should nag without burying the score, so they are capped.
  const weight = { critical: 18, serious: 8, warning: 3 };
  const infoCount = open.filter((x) => x.severity === 'info').length;
  const penalty = open.reduce((sum, x) => sum + (weight[x.severity] ?? 0), 0) + Math.min(6, infoCount);
  // Decay rather than subtract: a project with fifteen problems is in worse shape than one
  // with five, and a flat subtraction would flatten both to 0 and stop saying so.
  return {
    score: Math.max(1, Math.round(100 * Math.exp(-penalty / 55))),
    audited: true,
    open: open.length,
    counts: {
      critical: open.filter((x) => x.severity === 'critical').length,
      serious: open.filter((x) => x.severity === 'serious').length,
      warning: open.filter((x) => x.severity === 'warning').length,
      info: open.filter((x) => x.severity === 'info').length,
    },
  };
}

const daysAgo = (iso) => Math.floor((Date.now() - Date.parse(iso)) / 86400_000);
const money = (n, cur = 'USD') => {
  try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: cur, maximumFractionDigits: 0 }).format(n); }
  catch { return `${cur} ${Math.round(n)}`; }
};

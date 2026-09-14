import { useState } from 'react';
import { Link, useOutletContext } from 'react-router-dom';
import { api } from '../lib/api.js';
import { money, count, ratio, pct, ago, dateTime, shortDate } from '../lib/format.js';
import { MoneyLineChart, toCumulative } from '../components/charts.jsx';
import { channelColors } from '../lib/palette.js';
import {
  Card, Stat, Badge, Field, Modal, Drawer, Empty, Loading, ErrorNote,
  Segmented, Spinner, useAsync, useToast,
} from '../components/ui.jsx';

export default function Revenue() {
  const { project, days, attribution } = useOutletContext();
  const toast = useToast();
  const [connecting, setConnecting] = useState(false);
  const [openSource, setOpenSource] = useState(null);
  const [chartMode, setChartMode] = useState('daily');
  const [syncing, setSyncing] = useState(false);

  const state = useAsync(() => api.revenue(project.slug, { days, attribution }),
    [project.slug, days, attribution]);
  const ledger = useAsync(() => api.payments(project.slug, { days, limit: 25 }), [project.slug, days]);

  const reload = () => { state.reload(); ledger.reload(); };

  const syncAll = async () => {
    setSyncing(true);
    try {
      const results = await api.syncRevenue(project.slug);
      const failed = results.filter((r) => !r.ok);
      toast(failed.length
        ? `${failed[0].name}: ${failed[0].error}`
        : `${results.reduce((n, r) => n + (r.payments ?? 0), 0)} payments up to date`,
        failed.length ? 'err' : 'ok');
      reload();
    } catch (e) { toast(e.message, 'err'); }
    finally { setSyncing(false); }
  };

  if (state.loading) return <main className="page"><Loading what="revenue" /></main>;
  if (state.error) return <main className="page"><ErrorNote error={state.error} onRetry={state.reload} /></main>;

  const d = state.data;
  const cur = project.currency;

  if (!d.sources.length) {
    return (
      <main className="page">
        <div className="page-head"><h1>Revenue</h1></div>
        <Card>
          <Empty title="No payment processor connected"
            action={<button className="btn primary" onClick={() => setConnecting(true)}>Connect Stripe</button>}>
            Revenue is currently whatever the SDK reports. Connect the processor and it becomes
            what customers actually paid — refunds, renewals and plan changes included — matched
            back to the channel that found each of them.
          </Empty>
        </Card>
        {connecting && (
          <ConnectStripe project={project} onClose={() => setConnecting(false)}
            onConnected={() => { setConnecting(false); reload(); }} />
        )}
      </main>
    );
  }

  const testMode = d.sources.some((s) => !s.livemode);
  const hasRefunds = d.refunds > 0;
  // Refunds are plotted as their own positive magnitude rather than folded into a net
  // line: the chart floors at zero, so a day that was net negative would simply vanish.
  const chartSeries = [
    { key: 'gross', label: 'Paid', color: 'var(--series-2)' },
    ...(hasRefunds ? [{ key: 'refunds', label: 'Refunded', color: 'var(--critical)' }] : []),
  ];

  return (
    <main className="page">
      <div className="page-head">
        <h1>Revenue</h1>
        <p className="meta">{d.range.from} to {d.range.to}</p>
        <span className="spacer" />
        <button className="btn" onClick={syncAll} disabled={syncing}>{syncing ? <Spinner /> : 'Sync'}</button>
        <button className="btn primary" onClick={() => setConnecting(true)}>Connect another</button>
      </div>

      {testMode && (
        <Card bodyStyle={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <Badge tone="warning">test mode</Badge>
          <span style={{ color: 'var(--text-secondary)' }}>
            This account is connected with a test key, so every figure below — and the revenue half of
            every return and CAC number on the dashboard — is Stripe test data.
          </span>
        </Card>
      )}

      <div className="stat-row" style={{ margin: '14px 0' }}>
        <Stat hero label="Monthly recurring" value={money(d.recurring.mrr, cur, { compact: true })}
          foot={`${money(d.recurring.arr, cur, { compact: true })} a year · ${count(d.recurring.active)} subscriptions`} />
        <Stat label="Net revenue" value={money(d.net, cur, { compact: true })}
          foot={`${count(d.payments)} payment${d.payments === 1 ? '' : 's'} in range`} />
        <Stat label="Refunded" value={money(d.refunds, cur, { compact: true })} upIsGood={false}
          foot={d.refund_rate_pct != null ? `${pct(d.refund_rate_pct)} of gross` : 'nothing refunded'} />
        <Stat label="Paying customers" value={count(d.paying_customers)}
          foot={`${count(d.new_customers)} new, ${count(d.returning_customers)} returning`} />
        <Stat label="Revenue per customer" value={money(d.revenue_per_customer, cur)}
          foot={d.recurring.arpa != null ? `${money(d.recurring.arpa, cur)} / month on plan` : 'no active plans'} />
        <Stat label="Net new MRR" value={money(d.churn.net_new_mrr, cur)}
          foot={`${count(d.churn.started)} started, ${count(d.churn.canceled)} cancelled`}
          title="Monthly revenue from subscriptions that started in this window, less what cancelled ones were paying." />
      </div>

      {d.unmatched.count > 0 && (
        <UnmatchedNote project={project} unmatched={d.unmatched} currency={cur} />
      )}

      <div className="grid cols-2" style={{ marginBottom: 14, alignItems: 'start' }}>
        <Card title="Money in"
          actions={<Segmented value={chartMode} onChange={setChartMode} ariaLabel="Chart mode"
            options={[{ value: 'daily', label: 'Daily' }, { value: 'cumulative', label: 'Running total' }]} />}>
          <MoneyLineChart height={250} currency={cur} series={chartSeries}
            data={chartMode === 'cumulative' ? toCumulative(d.series, ['gross', 'refunds']) : d.series} />
        </Card>

        <Card title="Subscriptions" sub={`${money(d.recurring.mrr, cur)} / month`}>
          <SubscriptionState recurring={d.recurring} churn={d.churn} currency={cur} />
        </Card>
      </div>

      <Card title="What each channel returned" sub="lifetime, all dates"
        actions={<Link className="btn small" to={`/p/${project.slug}/channels`}>Channels</Link>}
        bodyStyle={{ padding: 0 }}>
        <ChannelReturn rows={d.by_channel} project={project} attribution={d.attribution} />
      </Card>

      <div className="grid cols-2" style={{ marginTop: 14, alignItems: 'start' }}>
        <Card title="Biggest customers" sub={`in the last ${days} days`} bodyStyle={{ padding: 0 }}>
          <TopCustomers rows={d.top_customers} project={project} currency={cur} />
        </Card>

        <Card title="Payments" sub={ledger.data ? `${count(ledger.data.total)} entries, refunds included` : ''} bodyStyle={{ padding: 0 }}>
          <Ledger state={ledger} project={project} />
        </Card>
      </div>

      <Card title="Connected accounts" bodyStyle={{ padding: 0 }} style={{ marginTop: 14 }}>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Account</th><th>Mode</th><th>Live updates</th><th>Last sync</th><th />
              </tr>
            </thead>
            <tbody>
              {d.sources.map((s) => (
                <SourceRow key={s.id} source={s} onOpen={() => setOpenSource(s.id)} onChanged={reload} />
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {connecting && (
        <ConnectStripe project={project} onClose={() => setConnecting(false)}
          onConnected={() => { setConnecting(false); reload(); }} />
      )}
      {openSource && (
        <SourceDrawer id={openSource} onClose={() => setOpenSource(null)}
          onChanged={reload} onGone={() => { setOpenSource(null); reload(); }} />
      )}
    </main>
  );
}

/* ------------------------------------------------------------------ parts */

function UnmatchedNote({ project, unmatched, currency }) {
  return (
    <Card bodyStyle={{ display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap' }}>
      <Badge tone="serious">{count(unmatched.count)} unmatched</Badge>
      <span style={{ color: 'var(--text-secondary)', flex: 1, minWidth: 260 }}>
        {money(Math.abs(unmatched.amount), currency)} was paid by people with no tracked first touch, so
        it is credited to no channel. Payments join to leads on the email the customer paid with.
      </span>
      <Link className="btn small" to={`/p/${project.slug}/leads?channel_id=none`}>See who</Link>
    </Card>
  );
}

function SubscriptionState({ recurring, churn, currency }) {
  const rows = [
    ['Active', recurring.active, 'Paying every period — the subscriptions MRR is counted from.'],
    ['Trialing', recurring.trialing, 'Not counted in MRR: a trial has paid nothing yet.'],
    ['Past due', recurring.past_due, 'A payment has failed. This is MRR that is already leaking.'],
    ['Cancelled', recurring.canceled, 'All time.'],
  ];
  return (
    <>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginBottom: 14 }}>
        {rows.map(([label, value, help]) => (
          <div key={label} title={help}>
            <div style={{ color: 'var(--text-secondary)', fontSize: 11.5 }}>{label}</div>
            <div style={{ fontWeight: 600, fontSize: 18, fontVariantNumeric: 'tabular-nums' }}>{count(value)}</div>
          </div>
        ))}
      </div>
      <dl className="kv">
        <dt>Cancelled in range</dt>
        <dd>{count(churn.canceled)} · {money(churn.canceled_mrr, currency)} / month lost</dd>
        <dt>Started in range</dt>
        <dd>{count(churn.started)} · {money(churn.started_mrr, currency)} / month added</dd>
        <dt title="Cancellations as a share of everything live at any point in the window.">Churn</dt>
        <dd>{churn.rate_pct == null ? '—' : pct(churn.rate_pct)}
          {churn.mrr_rate_pct != null && <span className="muted"> · {pct(churn.mrr_rate_pct)} by revenue</span>}</dd>
      </dl>
    </>
  );
}

/**
 * The table this whole integration exists for: acquisition cost against what the
 * customer went on to pay. Both columns are lifetime, because a ratio built from one
 * window's spend and another's revenue is not a ratio of anything.
 */
function ChannelReturn({ rows, project, attribution }) {
  const colors = channelColors(rows);
  const cur = project.currency;
  if (!rows.length) {
    return <Empty title="No revenue attributed yet">
      Once a payment matches a lead, the channel that found that lead appears here.
    </Empty>;
  }
  return (
    <div className="table-wrap">
      <table className="data">
        <thead>
          <tr>
            <th>Channel</th>
            <th className="num">Spend</th>
            <th className="num">Customers</th>
            <th className="num">Revenue</th>
            <th className="num" title="Revenue per paying customer, all time">LTV</th>
            <th className="num" title="Spend per paying customer, all time">CAC</th>
            <th className="num" title="Lifetime value against acquisition cost. Under 1× means the channel has not paid for itself yet.">LTV : CAC</th>
            <th className="num" title="Months of subscription needed to earn the acquisition cost back">Payback</th>
            <th className="num">MRR</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.channel_id ?? 'none'}>
              <td className="name">
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
                  <span className="swatch" style={{ background: colors.get(r.channel_id) ?? 'var(--text-muted)' }} />
                  <Link to={`/p/${project.slug}/leads?channel_id=${r.channel_id ?? 'none'}&attribution=${attribution}`}>
                    {r.name}
                  </Link>
                </span>
              </td>
              <td className="num">{r.spend ? money(r.spend, cur) : <span className="muted">—</span>}</td>
              <td className="num">{count(r.customers)}</td>
              <td className="num">{r.revenue ? money(r.revenue, cur) : <span className="muted">—</span>}</td>
              <td className="num">{r.ltv != null ? money(r.ltv, cur) : <span className="muted">—</span>}</td>
              <td className="num">{r.cac != null ? money(r.cac, cur) : <span className="muted">—</span>}</td>
              <td className="num" style={r.ltv_cac != null && r.ltv_cac < 1 ? { color: 'var(--critical)', fontWeight: 600 } : undefined}>
                {r.ltv_cac != null ? ratio(r.ltv_cac) : <span className="muted">—</span>}
              </td>
              <td className="num">{r.payback_months != null
                ? `${r.payback_months.toFixed(1)} mo` : <span className="muted">—</span>}</td>
              <td className="num">{r.mrr ? money(r.mrr, cur) : <span className="muted">—</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TopCustomers({ rows, project, currency }) {
  if (!rows.length) return <Empty title="Nobody has paid in this window" />;
  return (
    <div className="table-wrap">
      <table className="data">
        <thead>
          <tr><th>Customer</th><th>Channel</th><th className="num">Paid</th></tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <td className="name">
                {r.lead_id
                  ? <Link to={`/p/${project.slug}/leads?lead=${r.lead_id}`}>{r.name || r.email || 'Unnamed'}</Link>
                  : (r.name || r.email || 'Unnamed')}
                <div className="muted" style={{ fontSize: 11.5 }}>
                  {r.payments} payment{r.payments === 1 ? '' : 's'} · since {shortDate(r.first_paid)}
                </div>
              </td>
              <td>{r.channel_name ?? <span className="muted">Unattributed</span>}</td>
              <td className="num">{money(r.revenue, currency)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Ledger({ state, project }) {
  if (state.loading) return <Loading what="payments" />;
  if (state.error) return <ErrorNote error={state.error} onRetry={state.reload} />;
  if (!state.data.rows.length) return <Empty title="No payments in this window" />;
  return (
    <div className="table-wrap">
      <table className="data">
        <thead>
          <tr><th>When</th><th>Who</th><th>What</th><th className="num">Amount</th></tr>
        </thead>
        <tbody>
          {state.data.rows.map((p) => (
            <tr key={p.id}>
              <td className="muted" style={{ whiteSpace: 'nowrap' }}>{dateTime(p.occurred_at)}</td>
              <td className="name">
                {p.lead_id
                  ? <Link to={`/p/${project.slug}/leads?lead=${p.lead_id}`}>{p.lead_name || p.lead_email || p.email || 'Unnamed'}</Link>
                  : <span title="No lead matched this payment">{p.email || <span className="muted">unknown</span>}</span>}
              </td>
              <td className="muted">{p.description || (p.kind === 'refund' ? 'Refund' : 'Payment')}</td>
              <td className="num" style={p.amount < 0 ? { color: 'var(--critical)' } : undefined}>
                {money(p.amount, p.currency, { cents: true })}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SourceRow({ source, onOpen, onChanged }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  const sync = async () => {
    setBusy(true);
    try {
      const r = await api.syncRevenueSource(source.id);
      toast(`${source.name}: ${r.payments} payment${r.payments === 1 ? '' : 's'}, ${r.subscriptions} subscription${r.subscriptions === 1 ? '' : 's'}${r.warnings?.length ? ` — ${r.warnings[0]}` : ''}`);
      onChanged();
    } catch (e) { toast(`${source.name}: ${e.message}`, 'err'); }
    finally { setBusy(false); }
  };

  const hasWebhook = !!source.credential_state?.fields?.webhook_secret;
  return (
    <tr>
      <td className="name">
        {source.account_name || source.name}
        <div className="muted" style={{ fontSize: 11.5 }}>{source.provider_label} · {source.account_ref}</div>
      </td>
      <td>{source.livemode ? <Badge tone="good" dot={false}>live</Badge> : <Badge tone="warning">test</Badge>}</td>
      <td>{hasWebhook
        ? (source.last_hook_at
          ? <Badge tone="good">heard {ago(source.last_hook_at)}</Badge>
          : <Badge tone="info">webhook set, nothing yet</Badge>)
        : <Badge tone="info" dot={false}>sync only</Badge>}</td>
      <td>{source.last_sync_status === 'error'
        ? <Badge tone="critical">failing</Badge>
        : source.last_sync_at ? <span className="muted">{ago(source.last_sync_at)}</span> : <Badge tone="warning">never</Badge>}</td>
      <td className="num">
        <button className="btn small" onClick={sync} disabled={busy}>{busy ? <Spinner /> : 'Sync'}</button>
        {' '}
        <button className="btn small ghost" onClick={onOpen}>Settings</button>
      </td>
    </tr>
  );
}

/* --------------------------------------------------------------- connect */

function ConnectStripe({ project, onClose, onConnected }) {
  const toast = useToast();
  const [creds, setCreds] = useState({ secret_key: '', webhook_secret: '' });
  const [busy, setBusy] = useState(false);

  const connect = async () => {
    setBusy(true);
    try {
      const source = await api.connectRevenue(project.slug, { provider: 'stripe', credentials: creds });
      toast(`Connected ${source.account_name}. Run a sync to backfill the last year.`);
      onConnected(source);
    } catch (e) { toast(e.message, 'err'); }
    finally { setBusy(false); }
  };

  return (
    <Modal title="Connect Stripe" onClose={onClose} footer={
      <>
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn primary" onClick={connect} disabled={busy || !creds.secret_key.trim()}>
          {busy ? <Spinner /> : 'Connect'}
        </button>
      </>
    }>
      <p style={{ marginTop: 0, color: 'var(--text-secondary)' }}>
        The key is checked against Stripe before it is stored, and encrypted at rest. This app only
        ever reads — nothing here can create a charge or move money.
      </p>
      <Field label="Secret key"
        help="sk_live_… — or better, a restricted key (rk_live_…) with read access to Charges, Refunds, Subscriptions and Customers.">
        <input value={creds.secret_key} autoFocus placeholder="sk_live_…"
          onChange={(e) => setCreds({ ...creds, secret_key: e.target.value })} />
      </Field>
      <Field label="Webhook signing secret"
        help="Optional. Without it, revenue only moves when a sync runs. The endpoint URL to paste into Stripe appears here once the account is connected.">
        <input value={creds.webhook_secret} placeholder="whsec_…"
          onChange={(e) => setCreds({ ...creds, webhook_secret: e.target.value })} />
      </Field>
      <p style={{ color: 'var(--text-muted)', fontSize: 12, marginBottom: 0 }}>
        Payments are matched to leads by the email the customer pays with. If your checkout collects a
        different address from your signup form, that join is where revenue goes missing.
      </p>
    </Modal>
  );
}

function SourceDrawer({ id, onClose, onChanged, onGone }) {
  const toast = useToast();
  const state = useAsync(() => api.revenueSource(id), [id]);
  const [creds, setCreds] = useState({});
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  if (state.loading) return <Drawer title="Loading" onClose={onClose}><Loading /></Drawer>;
  if (state.error) return <Drawer title="Error" onClose={onClose}><ErrorNote error={state.error} /></Drawer>;

  const s = state.data;
  const webhookUrl = `${window.location.origin}${s.webhook_path}`;

  const save = async () => {
    setBusy(true);
    try {
      await api.updateRevenueSource(s.id, { credentials: creds });
      toast('Saved');
      setCreds({});
      state.reload();
      onChanged();
    } catch (e) { toast(e.message, 'err'); }
    finally { setBusy(false); }
  };

  const disconnect = async () => {
    setBusy(true);
    try {
      const r = await api.disconnectRevenue(s.id);
      toast(`Disconnected. ${r.payments} payment${r.payments === 1 ? '' : 's'} removed from reporting.`);
      onGone();
    } catch (e) { toast(e.message, 'err'); }
    finally { setBusy(false); }
  };

  return (
    <Drawer title={s.account_name || s.name} onClose={onClose} footer={
      <>
        <button className="btn ghost" onClick={onClose}>Close</button>
        <button className="btn primary" onClick={save} disabled={busy || !Object.keys(creds).length}>
          {busy ? <Spinner /> : 'Save credentials'}
        </button>
      </>
    }>
      <dl className="kv">
        <dt>Account</dt><dd>{s.account_ref}</dd>
        <dt>Mode</dt><dd>{s.livemode ? 'live' : 'test — these numbers are not real money'}</dd>
        <dt>Last sync</dt>
        <dd>{s.last_sync_at ? `${dateTime(s.last_sync_at)} (${s.last_sync_status})` : 'never'}</dd>
        {s.last_sync_error && <><dt>Last error</dt><dd style={{ color: 'var(--critical)' }}>{s.last_sync_error}</dd></>}
        <dt>Last webhook</dt><dd>{s.last_hook_at ? ago(s.last_hook_at) : 'none received'}</dd>
      </dl>

      <h3 style={{ fontSize: 13, marginBottom: 6 }}>Webhook endpoint</h3>
      <p style={{ color: 'var(--text-secondary)', marginTop: 0 }}>
        Add this URL in Stripe → Developers → Webhooks, subscribe it to charge, refund and
        subscription events, then paste the signing secret below. Stripe must be able to reach this
        host from the internet.
      </p>
      <pre className="snippet">{webhookUrl}</pre>

      {s.fields.map((f) => (
        <Field key={f.key} label={f.label} help={f.help}>
          <input type={f.secret ? 'password' : 'text'}
            placeholder={s.credential_state?.fields?.[f.key] ?? (f.required ? 'required' : 'not set')}
            value={creds[f.key] ?? ''}
            onChange={(e) => setCreds({ ...creds, [f.key]: e.target.value })} />
        </Field>
      ))}

      <h3 style={{ fontSize: 13, margin: '18px 0 6px' }}>Recent syncs</h3>
      {s.syncs?.length ? (
        <div className="timeline">
          {s.syncs.slice(0, 8).map((r) => (
            <div className="ev" key={r.id}>
              <Badge tone={r.status === 'ok' ? 'good' : r.status === 'error' ? 'critical' : 'info'}>{r.status}</Badge>
              {' '}{dateTime(r.started_at)} · {r.rows_written} row{r.rows_written === 1 ? '' : 's'}
              {r.error && <div style={{ color: 'var(--critical)', fontSize: 12 }}>{r.error}</div>}
            </div>
          ))}
        </div>
      ) : <p className="muted">Never synced.</p>}

      <h3 style={{ fontSize: 13, margin: '18px 0 6px' }}>Disconnect</h3>
      <p style={{ color: 'var(--text-secondary)', marginTop: 0 }}>
        Removes the account, its payment history and the revenue it contributed. Leads created from
        those payments stay — they are real people. This cannot be undone.
      </p>
      {confirming ? (
        <div className="row">
          <button className="btn danger" onClick={disconnect} disabled={busy}>
            {busy ? <Spinner /> : 'Yes, disconnect and delete the revenue'}
          </button>
          <button className="btn ghost" onClick={() => setConfirming(false)}>Keep it</button>
        </div>
      ) : (
        <button className="btn danger" onClick={() => setConfirming(true)}>Disconnect</button>
      )}
    </Drawer>
  );
}

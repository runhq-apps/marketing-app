import { useState } from 'react';
import { Link, useOutletContext } from 'react-router-dom';
import { api } from '../lib/api.js';
import { money, count, ratio, pct, ago } from '../lib/format.js';
import { MoneyLineChart, ColumnChart, Funnel, MixBar, toCumulative } from '../components/charts.jsx';
import { channelColors } from '../lib/palette.js';
import { Card, Stat, Badge, Loading, ErrorNote, Empty, useAsync, Segmented } from '../components/ui.jsx';

export default function Dashboard() {
  const { project, days, attribution } = useOutletContext();
  const [chartMode, setChartMode] = useState('cumulative');
  const state = useAsync(() => api.summary(project.slug, { days, attribution }), [project.slug, days, attribution]);

  if (state.loading) return <main className="page"><Loading what="dashboard" /></main>;
  if (state.error) return <main className="page"><ErrorNote error={state.error} onRetry={state.reload} /></main>;

  const { totals, deltas, series, channels, funnel, findings, range, health, revenue } = state.data;
  const cur = project.currency;
  const colors = channelColors(channels);
  const paid = channels.filter((c) => c.spend > 0);

  return (
    <main className="page">
      <div className="page-head">
        <h1 className="sr">{project.name}</h1>
        <p className="meta">
          {range.from} to {range.to} · {attribution === 'first' ? 'first touch' : 'last touch'}
        </p>
        <span className="spacer" />
        <Link className="btn" to={`/p/${project.slug}/audit`}>
          {health.open ? `${health.open} findings` : 'Audit'}
        </Link>
        <Link className="btn primary" to={`/p/${project.slug}/channels`}>Channels</Link>
      </div>

      <div className="stat-row" style={{ marginBottom: 14 }}>
        <Stat hero label="Return on spend" value={ratio(totals.roas)} delta={deltas.roas}
          foot={`${money(totals.revenue, cur, { compact: true })} from ${money(totals.spend, cur, { compact: true })}`} />
        <Stat label="Spend" value={money(totals.spend, cur, { compact: true })} delta={deltas.spend} upIsGood={false}
          foot={`${count(totals.clicks)} clicks`} />
        <Stat label="Leads" value={count(totals.leads)} delta={deltas.leads}
          foot={`${money(totals.cpl, cur)} each`} />
        <Stat label="Customers" value={count(totals.customers)} delta={deltas.customers}
          foot={`${pct(totals.lead_to_customer_pct)} of leads`} />
        <Stat label="CAC" value={money(totals.cac, cur)} delta={deltas.cac} upIsGood={false}
          foot={project.target_cac ? `target ${money(project.target_cac, cur)}` : 'no target set'} />
        <Stat label="Identified" value={pct(totals.leads ? (totals.identified_leads / totals.leads) * 100 : null, 0)}
          foot={`${count(totals.unattributed_leads)} with no channel`}
          title="Share of leads with an email or a user id — the rest can never be tied to a customer." />
        {revenue?.connected && (
          <Stat label="Monthly recurring" value={money(revenue.mrr, cur, { compact: true })}
            foot={revenue.livemode
              ? `${count(revenue.active_subscriptions)} subscriptions`
              : 'test mode — not real money'}
            title="Active subscriptions at the connected payment processor, normalised to a month." />
        )}
      </div>

      <div className="grid cols-2" style={{ marginBottom: 14 }}>
        <Card title="Spend and revenue"
          actions={<Segmented value={chartMode} onChange={setChartMode} ariaLabel="Chart mode"
            options={[{ value: 'cumulative', label: 'Running total' }, { value: 'daily', label: 'Daily' }]} />}>
          <MoneyLineChart data={chartMode === 'cumulative' ? toCumulative(series) : series} currency={cur} height={250} />
        </Card>

        <Card title="Funnel" sub={`${count(funnel[0]?.count ?? 0)} entered the top`}>
          {funnel.some((f) => f.count) ? (
            <Funnel stages={funnel} currency={cur} />
          ) : (
            <Empty title="No funnel data yet"
              action={<Link className="btn primary" to={`/p/${project.slug}/setup`}>Install the SDK</Link>}>
              Funnel stages come from product events. Once the SDK is sending them, every stage below
              shows its count and where people drop out.
            </Empty>
          )}
        </Card>
      </div>

      <Card title="Channels"
        sub={revenue?.connected ? 'revenue from the connected processor' : 'revenue as reported by the SDK'}
        actions={<Link className="btn small" to={`/p/${project.slug}/channels`}>Manage</Link>}
        bodyStyle={{ padding: 0 }}>
        {channels.length === 0 ? (
          <Empty title="No channels yet"
            action={<Link className="btn primary" to={`/p/${project.slug}/channels`}>Add a channel</Link>}>
            Add the places you spend — ad platforms, review portals, a conference booth.
          </Empty>
        ) : (
        <>
        {paid.length > 0 && (
          <div style={{ padding: '14px 16px 4px' }}>
            <MixBar currency={cur} colors={colors}
              items={paid.map((c) => ({ id: c.channel_id, label: c.name, value: c.spend }))} />
          </div>
        )}
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Channel</th>
                <th className="num">Spend</th>
                <th className="num">Leads</th>
                <th className="num">Cost / lead</th>
                <th className="num">Customers</th>
                <th className="num">CAC</th>
                <th className="num">Revenue</th>
                <th className="num">Return</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {channels.map((c) => (
                <tr key={c.channel_id ?? 'none'}>
                  <td className="name">
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
                      <span className="swatch" style={{ background: colors.get(c.channel_id) ?? 'var(--text-muted)' }} />
                      {c.channel_id
                        ? <Link to={`/p/${project.slug}/leads?channel_id=${c.channel_id}`}>{c.name}</Link>
                        : <Link to={`/p/${project.slug}/leads?channel_id=none`} title="Leads that arrived with no UTM and no click ID">{c.name}</Link>}
                    </span>
                  </td>
                  <td className="num">{c.spend ? money(c.spend, cur) : <span className="muted">—</span>}</td>
                  <td className="num">{count(c.leads)}</td>
                  <td className="num">{c.leads && c.spend ? money(c.cpl, cur) : <span className="muted">—</span>}</td>
                  <td className="num">{count(c.customers)}</td>
                  <td className="num" style={overTarget(c, project) ? { color: 'var(--critical)', fontWeight: 600 } : undefined}>
                    {c.cac != null && c.spend ? money(c.cac, cur) : <span className="muted">—</span>}
                  </td>
                  <td className="num">{c.revenue ? money(c.revenue, cur) : <span className="muted">—</span>}</td>
                  <td className="num">{c.spend ? ratio(c.roas) : <span className="muted">—</span>}</td>
                  <td><ChannelStatus c={c} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        </>
        )}
      </Card>

      <div className="grid cols-2" style={{ marginTop: 14, alignItems: 'start' }}>
        <Card title="Leads per day" sub={`${count(totals.leads)} in range`}>
          <ColumnChart data={series} valueKey="leads" label="Leads" />
        </Card>

        <Card title="Findings" sub={health.score == null ? 'not audited yet' : health.open ? `${health.open} open` : 'nothing open'}
          actions={<Link className="btn small" to={`/p/${project.slug}/audit`}>Full audit</Link>}>
          {findings.length === 0 ? (
            <Empty title={health.score == null ? 'Not audited yet' : 'Nothing outstanding'} />
          ) : findings.map((f) => (
            <div className="finding" key={f.id}>
              <Badge tone={f.severity}>{f.severity}</Badge>
              <div style={{ minWidth: 0 }}>
                <h4>{f.title}</h4>
                <p>{f.detail}</p>
              </div>
            </div>
          ))}
        </Card>
      </div>
    </main>
  );
}

const overTarget = (c, project) => project.target_cac && c.cac != null && c.spend > 0 && c.cac > project.target_cac;

function ChannelStatus({ c }) {
  if (c.channel_id == null) return <Badge tone="warning">untracked</Badge>;
  if (c.last_sync_status === 'error') return <Badge tone="critical">sync failing</Badge>;
  if (c.status === 'unconfigured') return <Badge tone="warning">needs credentials</Badge>;
  if (c.auth_type === 'manual') return <Badge tone="info" dot={false}>manual</Badge>;
  if (!c.last_sync_at) return <Badge tone="warning">never synced</Badge>;
  return <Badge tone="good">synced {ago(c.last_sync_at)}</Badge>;
}

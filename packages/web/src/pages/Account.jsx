import { useState } from 'react';
import { Link, useOutletContext } from 'react-router-dom';
import { api } from '../lib/api.js';
import { money, count, ratio, pct, deltaClass, deltaLabel } from '../lib/format.js';
import { MiniChart } from '../components/charts.jsx';
import { Card, Stat, Badge, Modal, Field, Loading, ErrorNote, Empty, useAsync, useToast, Spinner } from '../components/ui.jsx';

export default function Account() {
  const { days, attribution } = useOutletContext();
  const [adding, setAdding] = useState(false);
  const state = useAsync(() => api.overview({ days, attribution }), [days, attribution]);

  if (state.loading) return <main className="page"><Loading what="projects" /></main>;
  if (state.error) return <main className="page"><ErrorNote error={state.error} onRetry={state.reload} /></main>;

  const { account, projects, range } = state.data;
  const hasProjects = projects.length > 0;

  return (
    <main className="page">
      <div className="page-head">
        <h1>Projects</h1>
        <p className="meta">{range.from} to {range.to}</p>
        <span className="spacer" />
        <button className="btn primary" onClick={() => setAdding(true)}>New project</button>
      </div>

      {hasProjects && (
        <div className="stat-row" style={{ marginBottom: 18 }}>
          <Stat hero label="Return on spend" value={ratio(account.roas)}
            foot={account.roas != null ? `${money(account.revenue, 'USD', { compact: true })} back on ${money(account.spend, 'USD', { compact: true })}` : 'No revenue recorded yet'} />
          <Stat label="Total spend" value={money(account.spend, 'USD', { compact: true })} />
          <Stat label="Attributed revenue" value={money(account.revenue, 'USD', { compact: true })} />
          <Stat label="Net" value={money(account.profit, 'USD', { compact: true })} />
          <Stat label="Leads" value={count(account.leads)} foot={`${count(account.customers)} converted`} />
          <Stat label="Open findings" value={count(account.open_findings)}
            foot={account.critical_findings ? `${account.critical_findings} critical` : 'nothing critical'} />
        </div>
      )}

      {!hasProjects ? (
        <Card>
          <Empty title="No projects yet"
            action={<button className="btn primary" onClick={() => setAdding(true)}>Create your first project</button>}>
            A project is one product you market. Each one gets its own channels, its own SDK key,
            and its own funnel.
          </Empty>
        </Card>
      ) : (
        <div className="grid cards">
          {projects.map((p) => <ProjectCard key={p.id} p={p} />)}
        </div>
      )}

      {adding && <NewProject onClose={() => setAdding(false)} onCreated={state.reload} />}
    </main>
  );
}

function ProjectCard({ p }) {
  const t = p.totals;
  const health = p.health;
  const tone = health.score == null ? 'info'
    : health.counts.critical ? 'critical' : health.counts.serious ? 'serious' : health.open ? 'warning' : 'good';

  return (
    <Link to={`/p/${p.slug}`} className="card" style={{ display: 'block' }}>
      <div className="card-body">
        <div className="row" style={{ justifyContent: 'space-between', marginBottom: 12 }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 16, fontWeight: 620, letterSpacing: '-0.01em' }}>{p.name}</div>
            <div style={{ color: 'var(--text-muted)', fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {p.website?.replace(/^https?:\/\//, '') ?? 'No website set'} · {p.channels} channel{p.channels === 1 ? '' : 's'}
            </div>
          </div>
          <Badge tone={tone}>{health.score == null ? 'not audited' : health.open ? `${health.open} to fix` : 'all clear'}</Badge>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, marginBottom: 6 }}>
          <Figure label="Spend" value={money(t.spend, p.currency, { compact: true })} delta={p.deltas.spend} upIsGood={false} />
          <Figure label="Revenue" value={money(t.revenue, p.currency, { compact: true })} delta={p.deltas.revenue} />
          <Figure label="Return" value={ratio(t.roas)} delta={p.deltas.roas} />
        </div>

        <MiniChart data={p.series} currency={p.currency} />

        <div className="legend" style={{ marginTop: 8, justifyContent: 'space-between' }}>
          <span className="item"><span className="key" style={{ background: 'var(--series-1)' }} />Spend</span>
          <span className="item"><span className="key" style={{ background: 'var(--series-2)' }} />Revenue</span>
          <span style={{ color: 'var(--text-muted)' }}>
            {count(t.leads)} leads · {count(t.customers)} customers · CAC {money(t.cac, p.currency)}
          </span>
        </div>
      </div>
    </Link>
  );
}

function Figure({ label, value, delta, upIsGood = true }) {
  return (
    <div>
      <div style={{ color: 'var(--text-secondary)', fontSize: 12 }}>{label}</div>
      <div style={{ fontSize: 19, fontWeight: 600, letterSpacing: '-0.015em' }}>{value}</div>
      {delta != null && (
        <div className={`delta ${deltaClass(delta, { upIsGood })}`} style={{ fontSize: 12 }}>
          {deltaLabel(delta)} <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>vs prev</span>
        </div>
      )}
    </div>
  );
}

function NewProject({ onClose, onCreated }) {
  const toast = useToast();
  const [form, setForm] = useState({ name: '', website: '', currency: 'USD', target_cac: '' });
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  const submit = async () => {
    if (!form.name.trim()) return toast('Give the project a name', 'err');
    setBusy(true);
    try {
      const created = await api.createProject({
        name: form.name.trim(),
        website: form.website.trim() || null,
        currency: form.currency || 'USD',
        target_cac: form.target_cac ? Number(form.target_cac) : null,
      });
      toast(`Created ${created.name}`);
      onCreated();
      onClose();
    } catch (e) {
      toast(e.message, 'err');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="New project" onClose={onClose} footer={
      <>
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn primary" onClick={submit} disabled={busy}>{busy ? <Spinner /> : 'Create project'}</button>
      </>
    }>
      <Field label="Name"><input value={form.name} onChange={set('name')} placeholder="Acme CRM" autoFocus /></Field>
      <Field label="Website" help="Used by the audit to check which pixels and preview assets are actually on your site.">
        <input value={form.website} onChange={set('website')} placeholder="https://acme.com" />
      </Field>
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <div style={{ flex: 1 }}>
          <Field label="Currency">
            <select value={form.currency} onChange={set('currency')}>
              {['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'KRW', 'INR', 'BRL'].map((c) => <option key={c}>{c}</option>)}
            </select>
          </Field>
        </div>
        <div style={{ flex: 1 }}>
          <Field label="Target CAC" help="Optional. The audit flags channels that run above it.">
            <input value={form.target_cac} onChange={set('target_cac')} inputMode="decimal" placeholder="250" />
          </Field>
        </div>
      </div>
      <p style={{ color: 'var(--text-secondary)', margin: 0 }}>
        A default funnel — visit → lead → qualified → trial → opportunity → customer — is created with the
        project, and you can change the stages later.
      </p>
    </Modal>
  );
}

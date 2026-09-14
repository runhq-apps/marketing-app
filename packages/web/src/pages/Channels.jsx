import { useMemo, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { api } from '../lib/api.js';
import { money, count, ago, titleCase, authLabel, dateTime } from '../lib/format.js';
import { Card, Badge, Modal, Drawer, Field, Loading, ErrorNote, Empty, useAsync, useToast, Spinner } from '../components/ui.jsx';
import { channelColors } from '../lib/palette.js';

const CATEGORY_LABEL = {
  paid_search: 'Paid search', paid_social: 'Paid social', marketplace: 'Review sites & directories',
  events: 'Events', sponsorship: 'Sponsorships', organic: 'Organic', owned: 'Owned', partner: 'Partners', other: 'Other',
};

export default function Channels() {
  const { project, days, attribution } = useOutletContext();
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const [openId, setOpenId] = useState(null);
  const [syncingAll, setSyncingAll] = useState(false);

  const channels = useAsync(() => api.channels(project.slug), [project.slug]);
  const summary = useAsync(() => api.summary(project.slug, { days, attribution }), [project.slug, days, attribution]);
  const catalogue = useAsync(() => api.providers(), []);

  const colors = useMemo(() => channelColors(channels.data ?? []), [channels.data]);

  const perf = useMemo(() => {
    const map = new Map();
    for (const row of summary.data?.channels ?? []) map.set(row.channel_id, row);
    return map;
  }, [summary.data]);

  const reload = () => { channels.reload(); summary.reload(); };

  const syncAll = async () => {
    setSyncingAll(true);
    try {
      const results = await api.syncProject(project.slug);
      const ok = results.filter((r) => r.ok).length;
      const failed = results.filter((r) => !r.ok);
      toast(results.length === 0
        ? 'No channels are set up for automatic sync yet.'
        : `${ok} synced${failed.length ? `, ${failed.length} failed: ${failed[0].error}` : ''}`,
        failed.length ? 'err' : 'ok');
      reload();
    } catch (e) { toast(e.message, 'err'); }
    finally { setSyncingAll(false); }
  };

  if (channels.loading || catalogue.loading) return <main className="page"><Loading what="channels" /></main>;
  if (channels.error) return <main className="page"><ErrorNote error={channels.error} onRetry={channels.reload} /></main>;

  const rows = channels.data;
  const providers = catalogue.data.providers;

  return (
    <main className="page">
      <div className="page-head">
        <h1>Channels</h1>
        <span className="spacer" />
        <button className="btn" onClick={syncAll} disabled={syncingAll}>
          {syncingAll ? <Spinner /> : 'Sync all'}
        </button>
        <button className="btn primary" onClick={() => setAdding(true)}>Add channel</button>
      </div>

      {rows.length === 0 ? (
        <Card>
          <Empty title="No channels yet" action={<button className="btn primary" onClick={() => setAdding(true)}>Add your first channel</button>}>
            Add Google Ads, Meta, Capterra, a conference booth — anything you spend on.
          </Empty>
        </Card>
      ) : (
        <div className="grid cards">
          {rows.map((c) => (
            <ChannelCard key={c.id} c={c} perf={perf.get(c.id)} currency={project.currency}
              color={colors.get(c.id)} onOpen={() => setOpenId(c.id)} onChanged={reload} />
          ))}
        </div>
      )}

      {adding && (
        <AddChannel providers={providers} authTypes={catalogue.data.auth_types} project={project}
          onClose={() => setAdding(false)} onCreated={(c) => { reload(); setOpenId(c.id); }} />
      )}
      {openId && (
        <ChannelDrawer id={openId} project={project} onClose={() => setOpenId(null)} onChanged={reload} />
      )}
    </main>
  );
}

function ChannelCard({ c, perf, currency, color, onOpen, onChanged }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  const sync = async (e) => {
    e.stopPropagation();
    setBusy(true);
    try {
      const r = await api.syncChannel(c.id);
      toast(`${c.name}: ${r.spend_rows} day${r.spend_rows === 1 ? '' : 's'} of spend${r.leads ? `, ${r.leads} leads` : ''}${r.warnings?.length ? ` — ${r.warnings[0]}` : ''}`);
      onChanged();
    } catch (err) { toast(`${c.name}: ${err.message}`, 'err'); }
    finally { setBusy(false); }
  };

  return (
    <div className="card" style={{ cursor: 'pointer' }} onClick={onOpen}>
      <div className="card-body">
        <div className="row" style={{ justifyContent: 'space-between', marginBottom: 10 }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 600, fontSize: 15, display: 'flex', alignItems: 'center', gap: 7 }}>
              <span className="swatch" style={{ background: color ?? 'var(--text-muted)' }} />{c.name}
            </div>
            <div style={{ color: 'var(--text-muted)', fontSize: 12.5 }}>
              {c.provider_label} · {authLabel(c.auth_type)}
            </div>
          </div>
          <SyncBadge c={c} />
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, marginBottom: 10 }}>
          <Mini label="Spend" value={money(perf?.spend ?? 0, currency, { compact: true })} />
          <Mini label="Leads" value={count(perf?.leads ?? 0)} />
          <Mini label="CAC" value={perf?.cac != null && perf?.spend ? money(perf.cac, currency) : '—'} />
          <Mini label="Return" value={perf?.roas != null ? `${perf.roas.toFixed(2)}×` : '—'} />
        </div>

        <div className="row">
          {c.can_sync && <button className="btn small" onClick={sync} disabled={busy}>{busy ? <Spinner /> : 'Sync now'}</button>}
          <button className="btn small ghost" onClick={(e) => { e.stopPropagation(); onOpen(); }}>Settings</button>
          {c.needs_browser && <Badge tone="info" dot={false}>browser login</Badge>}
        </div>
      </div>
    </div>
  );
}

const Mini = ({ label, value }) => (
  <div>
    <div style={{ color: 'var(--text-secondary)', fontSize: 11.5 }}>{label}</div>
    <div style={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
  </div>
);

function SyncBadge({ c }) {
  if (c.last_sync_status === 'error') return <Badge tone="critical">sync failing</Badge>;
  if (c.status === 'unconfigured' && c.auth_type !== 'manual') return <Badge tone="warning">no credentials</Badge>;
  if (c.auth_type === 'manual') return <Badge tone="info" dot={false}>manual</Badge>;
  if (!c.last_sync_at) return <Badge tone="warning">never synced</Badge>;
  return <Badge tone="good">{ago(c.last_sync_at)}</Badge>;
}

/* ------------------------------------------------------------ add channel */

function AddChannel({ providers, authTypes, project, onClose, onCreated }) {
  const toast = useToast();
  const [provider, setProvider] = useState(null);
  const [authType, setAuthType] = useState(null);
  const [name, setName] = useState('');
  const [creds, setCreds] = useState({});
  const [busy, setBusy] = useState(false);

  const grouped = useMemo(() => {
    const out = {};
    for (const p of providers) (out[p.category] ??= []).push(p);
    return out;
  }, [providers]);

  const fields = provider && authType ? (provider.fields[authType] ?? []) : [];

  const create = async () => {
    setBusy(true);
    try {
      const missing = fields.filter((f) => f.required && !creds[f.key]?.trim());
      if (missing.length) throw new Error(`Missing: ${missing.map((f) => f.label).join(', ')}`);
      const channel = await api.createChannel(project.slug, {
        provider: provider.id,
        auth_type: authType,
        name: name.trim() || provider.label,
        credentials: fields.length ? creds : null,
      });
      toast(`Added ${channel.name}`);
      onCreated(channel);
      onClose();
    } catch (e) { toast(e.message, 'err'); }
    finally { setBusy(false); }
  };

  return (
    <Modal wide title={provider ? `Add ${provider.label}` : 'Add a channel'} onClose={onClose} footer={
      provider ? (
        <>
          <button className="btn ghost" onClick={() => { setProvider(null); setAuthType(null); setCreds({}); }}>Back</button>
          <button className="btn primary" onClick={create} disabled={busy || !authType}>{busy ? <Spinner /> : 'Add channel'}</button>
        </>
      ) : <button className="btn ghost" onClick={onClose}>Cancel</button>
    }>
      {!provider ? (
        Object.entries(grouped).map(([cat, list]) => (
          <div key={cat} style={{ marginBottom: 18 }}>
            <div style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-muted)', marginBottom: 8 }}>
              {CATEGORY_LABEL[cat] ?? titleCase(cat)}
            </div>
            <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 8 }}>
              {list.map((p) => (
                <button key={p.id} className="btn" style={{ display: 'block', textAlign: 'left', padding: '10px 12px', height: '100%' }}
                  onClick={() => { setProvider(p); setAuthType(p.authTypes[0]); setName(p.label); }}>
                  <div className="row" style={{ justifyContent: 'space-between' }}>
                    <strong>{p.label}</strong>
                    {p.canSync ? <Badge tone="good" dot={false}>auto</Badge> : <Badge tone="info" dot={false}>manual</Badge>}
                  </div>
                  <div style={{ color: 'var(--text-secondary)', fontWeight: 400, whiteSpace: 'normal', fontSize: 12.5, marginTop: 3 }}>
                    {p.blurb}
                  </div>
                </button>
              ))}
            </div>
          </div>
        ))
      ) : (
        <>
          <p style={{ marginTop: 0, color: 'var(--text-secondary)' }}>{provider.blurb}</p>

          <Field label="Channel name" help="Name it for how you think about the budget — “Google Ads — Brand” and “Google Ads — Nonbrand” can be two channels on the same account.">
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>

          <Field label="How should this channel be read?">
            <select value={authType ?? ''} onChange={(e) => { setAuthType(e.target.value); setCreds({}); }}>
              {provider.authTypes.map((a) => (
                <option key={a} value={a}>{authTypes[a]?.label ?? a}</option>
              ))}
            </select>
          </Field>
          {authType && <p style={{ color: 'var(--text-secondary)', marginTop: -6 }}>{authTypes[authType]?.help}</p>}

          {authType === 'credentials' && (
            <div className="badge warning" style={{ display: 'block', padding: '8px 10px', whiteSpace: 'normal', marginBottom: 12 }}>
              Portal logins run a headless browser against the vendor's site. Use a dedicated read-only
              account without MFA, and expect to adjust the scrape selectors when the portal changes.
            </div>
          )}

          {fields.map((f) => (
            <Field key={f.key} label={`${f.label}${f.required ? '' : ' (optional)'}`} help={f.help}>
              <input type={f.secret ? 'password' : 'text'} autoComplete="off"
                value={creds[f.key] ?? ''} onChange={(e) => setCreds({ ...creds, [f.key]: e.target.value })} />
            </Field>
          ))}

          {authType === 'manual' && (
            <p style={{ color: 'var(--text-secondary)' }}>
              Nothing to authenticate. After adding the channel you can enter spend by period or import a CSV export.
            </p>
          )}
        </>
      )}
    </Modal>
  );
}

/* --------------------------------------------------------- channel drawer */

function ChannelDrawer({ id, project, onClose, onChanged }) {
  const toast = useToast();
  const state = useAsync(() => api.channel(id), [id]);
  const [tab, setTab] = useState('spend');
  const [busy, setBusy] = useState(false);

  if (state.loading) return <Drawer title="Channel" onClose={onClose}><Loading what="channel" /></Drawer>;
  if (state.error) return <Drawer title="Channel" onClose={onClose}><ErrorNote error={state.error} onRetry={state.reload} /></Drawer>;

  const c = state.data;
  const refresh = () => { state.reload(); onChanged(); };

  const remove = async () => {
    if (!confirm(`Delete ${c.name}? Its spend history and lead attribution are deleted with it.`)) return;
    setBusy(true);
    try { await api.deleteChannel(c.id); toast(`Deleted ${c.name}`); onChanged(); onClose(); }
    catch (e) { toast(e.message, 'err'); }
    finally { setBusy(false); }
  };

  const tabs = [
    ['spend', 'Spend'],
    ['auth', 'Connection'],
    ['rules', 'Attribution rules'],
    c.auth_type === 'credentials' && ['scrape', 'Scrape recipe'],
    c.checklist?.length && ['checklist', 'Checklist'],
    ['history', 'History'],
  ].filter(Boolean);

  return (
    <Drawer title={c.name} onClose={onClose} footer={
      <>
        <button className="btn danger" onClick={remove} disabled={busy}>Delete channel</button>
        <span style={{ flex: 1 }} />
        <button className="btn" onClick={onClose}>Done</button>
      </>
    }>
      <div className="row" style={{ marginBottom: 14, gap: 6 }}>
        <Badge tone="info" dot={false}>{c.provider_label}</Badge>
        <SyncBadge c={c} />
        {c.last_sync_error && <span style={{ color: 'var(--critical)', fontSize: 12.5 }}>{c.last_sync_error}</span>}
      </div>

      <div className="tabs" style={{ padding: 0, marginBottom: 14, background: 'transparent' }}>
        {tabs.map(([key, label]) => (
          <a key={key} href="#" className={tab === key ? 'active' : ''}
            onClick={(e) => { e.preventDefault(); setTab(key); }}>{label}</a>
        ))}
      </div>

      {tab === 'spend' && <SpendTab c={c} project={project} onChanged={refresh} />}
      {tab === 'auth' && <AuthTab c={c} onChanged={refresh} />}
      {tab === 'rules' && <RulesTab c={c} onChanged={refresh} />}
      {tab === 'scrape' && <ScrapeTab c={c} onChanged={refresh} />}
      {tab === 'checklist' && <ChecklistTab c={c} onChanged={refresh} />}
      {tab === 'history' && <HistoryTab c={c} />}
    </Drawer>
  );
}

function SpendTab({ c, project, onChanged }) {
  const toast = useToast();
  const today = new Date().toISOString().slice(0, 10);
  const monthStart = `${today.slice(0, 7)}-01`;
  const [form, setForm] = useState({ from: monthStart, to: today, total: '' });
  const [csv, setCsv] = useState('');
  const [busy, setBusy] = useState(false);
  const rows = useAsync(() => api.channelSpend(c.id, { days: 30 }), [c.id]);

  const addSpend = async () => {
    if (!form.total) return toast('Enter an amount', 'err');
    setBusy(true);
    try {
      const r = await api.addSpend(c.id, { from: form.from, to: form.to, total: Number(form.total) });
      toast(`Recorded ${money(Number(form.total), project.currency)} across ${r.rows} day${r.rows === 1 ? '' : 's'}`);
      setForm({ ...form, total: '' });
      rows.reload(); onChanged();
    } catch (e) { toast(e.message, 'err'); }
    finally { setBusy(false); }
  };

  const importCsv = async () => {
    if (!csv.trim()) return toast('Paste the CSV first', 'err');
    setBusy(true);
    try {
      const r = await api.importCsv(c.id, csv);
      toast(`Imported ${r.rows} rows (date: ${r.columns.date}, spend: ${r.columns.spend})`);
      setCsv(''); rows.reload(); onChanged();
    } catch (e) { toast(e.message, 'err'); }
    finally { setBusy(false); }
  };

  return (
    <>
      <h3 style={{ margin: '0 0 8px', fontSize: 13.5 }}>Record spend</h3>
      <p style={{ color: 'var(--text-secondary)', marginTop: 0 }}>
        A period total is split evenly across its days, which is right for retainers and flat fees and
        close enough for everything else. Daily detail arrives on its own for synced channels.
      </p>
      <div className="row" style={{ alignItems: 'flex-end' }}>
        <div style={{ flex: 1 }}><Field label="From"><input type="date" value={form.from} onChange={(e) => setForm({ ...form, from: e.target.value })} /></Field></div>
        <div style={{ flex: 1 }}><Field label="To"><input type="date" value={form.to} onChange={(e) => setForm({ ...form, to: e.target.value })} /></Field></div>
        <div style={{ flex: 1 }}><Field label={`Total (${project.currency})`}><input inputMode="decimal" value={form.total} onChange={(e) => setForm({ ...form, total: e.target.value })} placeholder="2500" /></Field></div>
        <button className="btn primary" onClick={addSpend} disabled={busy} style={{ marginBottom: 12 }}>Record</button>
      </div>

      <h3 style={{ margin: '16px 0 8px', fontSize: 13.5 }}>Import a CSV export</h3>
      <p style={{ color: 'var(--text-secondary)', marginTop: 0 }}>
        Paste any platform's daily export. Date and cost columns are matched by name — Day/Date,
        Cost/Spend/Amount spent — so most exports import unedited.
      </p>
      <textarea rows={4} value={csv} onChange={(e) => setCsv(e.target.value)}
        placeholder="Day,Cost,Impressions,Clicks&#10;2026-09-01,1234.56,10000,250" style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12 }} />
      <div className="row" style={{ marginTop: 8 }}>
        <button className="btn" onClick={importCsv} disabled={busy}>{busy ? <Spinner /> : 'Import CSV'}</button>
      </div>

      <h3 style={{ margin: '18px 0 8px', fontSize: 13.5 }}>Last 30 days</h3>
      {rows.loading ? <Loading what="spend" /> : rows.data?.length ? (
        <div className="table-wrap" style={{ maxHeight: 240, overflowY: 'auto' }}>
          <table className="data">
            <thead><tr><th>Date</th><th className="num">Spend</th><th className="num">Clicks</th><th>Source</th></tr></thead>
            <tbody>
              {rows.data.slice().reverse().map((r) => (
                <tr key={r.date}>
                  <td>{r.date}</td>
                  <td className="num">{money(r.spend, r.currency)}</td>
                  <td className="num">{count(r.clicks)}</td>
                  <td className="muted">{r.source.replace('_', ' ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <p style={{ color: 'var(--text-muted)' }}>No spend recorded in the last 30 days.</p>}
    </>
  );
}

function AuthTab({ c, onChanged }) {
  const toast = useToast();
  const [values, setValues] = useState({});
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      await api.updateChannel(c.id, { credentials: values });
      toast('Credentials saved');
      setValues({});
      onChanged();
    } catch (e) { toast(e.message, 'err'); }
    finally { setBusy(false); }
  };

  const sync = async () => {
    setBusy(true);
    try {
      const r = await api.syncChannel(c.id);
      toast(`${r.spend_rows} days of spend${r.leads ? `, ${r.leads} leads` : ''}${r.warnings?.length ? ` — ${r.warnings[0]}` : ''}`);
      onChanged();
    } catch (e) { toast(e.message, 'err'); }
    finally { setBusy(false); }
  };

  if (!c.fields.length) {
    return (
      <p style={{ color: 'var(--text-secondary)' }}>
        This channel is set to <strong>{authLabel(c.auth_type)}</strong> and has nothing to authenticate.
        Record spend on the Spend tab.
      </p>
    );
  }

  return (
    <>
      <p style={{ color: 'var(--text-secondary)', marginTop: 0 }}>
        Stored encrypted with AES-256-GCM under <code>RUNHQ_SECRET</code>. Values are never sent back to this
        screen — leave a field blank to keep what is already stored.
      </p>
      {c.fields.map((f) => (
        <Field key={f.key} label={f.label} help={f.help}>
          <input type={f.secret ? 'password' : 'text'} autoComplete="off"
            placeholder={c.credential_state?.fields?.[f.key] ?? (f.required ? 'required' : 'optional')}
            value={values[f.key] ?? ''} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} />
        </Field>
      ))}
      <div className="row">
        <button className="btn primary" onClick={save} disabled={busy || !Object.keys(values).length}>Save credentials</button>
        {c.can_sync && <button className="btn" onClick={sync} disabled={busy}>{busy ? <Spinner /> : 'Sync now'}</button>}
      </div>
    </>
  );
}

function RulesTab({ c, onChanged }) {
  const toast = useToast();
  const match = c.config.match ?? {};
  const [form, setForm] = useState({
    utm_source: (match.utm_source ?? []).join(', '),
    utm_medium: (match.utm_medium ?? []).join(', '),
    utm_campaign: (match.utm_campaign ?? []).join(', '),
    clickIds: (match.clickIds ?? []).join(', '),
    referrers: (match.referrers ?? []).join(', '),
  });
  const [busy, setBusy] = useState(false);
  const list = (s) => s.split(',').map((x) => x.trim()).filter(Boolean);

  const save = async () => {
    setBusy(true);
    try {
      const next = {};
      for (const [k, v] of Object.entries(form)) if (list(v).length) next[k] = list(v);
      await api.updateChannel(c.id, { config: { ...c.config, match: next } });
      toast('Attribution rules saved');
      onChanged();
    } catch (e) { toast(e.message, 'err'); }
    finally { setBusy(false); }
  };

  return (
    <>
      <p style={{ color: 'var(--text-secondary)', marginTop: 0 }}>
        How a visit is recognised as this channel's. Leave blank to use the provider's defaults. These
        rules beat the defaults, which is how two channels on one ad account stay separate — give each
        one its own <code>utm_campaign</code>.
      </p>
      <Field label="utm_source values" help="Comma separated. e.g. facebook, fb, meta">
        <input value={form.utm_source} onChange={(e) => setForm({ ...form, utm_source: e.target.value })} />
      </Field>
      <Field label="utm_medium values"><input value={form.utm_medium} onChange={(e) => setForm({ ...form, utm_medium: e.target.value })} /></Field>
      <Field label="utm_campaign values" help="Set this to split one ad account across several channels.">
        <input value={form.utm_campaign} onChange={(e) => setForm({ ...form, utm_campaign: e.target.value })} />
      </Field>
      <Field label="Click ID parameters" help="gclid, fbclid, msclkid… Most trustworthy signal — the platform sets it, not a human.">
        <input value={form.clickIds} onChange={(e) => setForm({ ...form, clickIds: e.target.value })} />
      </Field>
      <Field label="Referring hosts" help="Fallback for untagged links. e.g. capterra.com">
        <input value={form.referrers} onChange={(e) => setForm({ ...form, referrers: e.target.value })} />
      </Field>
      <button className="btn primary" onClick={save} disabled={busy}>Save rules</button>
    </>
  );
}

function ScrapeTab({ c, onChanged }) {
  const toast = useToast();
  const recipe = c.config.scrape ?? {};
  const [form, setForm] = useState(recipe);
  const [busy, setBusy] = useState(false);

  const FIELDS = [
    ['loginUrl', 'Login URL'],
    ['userSelector', 'Username field selector'],
    ['passSelector', 'Password field selector'],
    ['submitSelector', 'Submit button selector'],
    ['readySelector', 'Post-login marker selector'],
    ['reportUrl', 'Report URL', 'Supports {from} and {to} tokens'],
    ['rowSelector', 'Daily row selector'],
    ['dateSelector', 'Date cell (within row)'],
    ['spendSelector', 'Spend cell (within row)'],
    ['clicksSelector', 'Clicks cell (within row)'],
    ['impressionsSelector', 'Impressions cell (within row)'],
    ['totalSpendSelector', 'Range-total fallback selector'],
  ];

  const save = async () => {
    setBusy(true);
    try {
      await api.updateChannel(c.id, { config: { ...c.config, scrape: form } });
      toast('Scrape recipe saved');
      onChanged();
    } catch (e) { toast(e.message, 'err'); }
    finally { setBusy(false); }
  };

  return (
    <>
      <p style={{ color: 'var(--text-secondary)', marginTop: 0 }}>
        This portal has no spend API, so the sync signs in and reads the numbers off the page. The
        selectors are settings rather than code — when the portal is redesigned, fix it here.
      </p>
      {FIELDS.map(([key, label, help]) => (
        <Field key={key} label={label} help={help}>
          <input value={form[key] ?? ''} onChange={(e) => setForm({ ...form, [key]: e.target.value })}
            style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12 }} />
        </Field>
      ))}
      <button className="btn primary" onClick={save} disabled={busy}>Save recipe</button>
    </>
  );
}

function ChecklistTab({ c, onChanged }) {
  const toast = useToast();
  const state = c.config.checklist ?? {};
  const [busy, setBusy] = useState(null);

  const toggle = async (code, done) => {
    setBusy(code);
    try { await api.checklist(c.id, code, done); onChanged(); }
    catch (e) { toast(e.message, 'err'); }
    finally { setBusy(null); }
  };

  return (
    <>
      <p style={{ color: 'var(--text-secondary)', marginTop: 0 }}>
        Setup steps this channel needs that no API can confirm — a listing banner, screenshots, lead
        routing. Anything left unticked shows up in the audit.
      </p>
      {c.checklist.map((item) => {
        const detectable = item.detects !== 'manual';
        return (
          <label key={item.code} className="row" style={{ padding: '9px 0', borderBottom: '1px solid var(--grid)', alignItems: 'flex-start', gap: 9 }}>
            <input type="checkbox" style={{ width: 'auto', marginTop: 3 }}
              disabled={detectable || busy === item.code}
              checked={detectable ? undefined : !!state[item.code]}
              onChange={(e) => toggle(item.code, e.target.checked)} />
            <span style={{ flex: 1 }}>
              {item.label}
              {detectable && (
                <span style={{ display: 'block', color: 'var(--text-muted)', fontSize: 12 }}>
                  Detected automatically by the site scan — not something to tick by hand.
                </span>
              )}
            </span>
          </label>
        );
      })}
    </>
  );
}

function HistoryTab({ c }) {
  if (!c.syncs?.length) return <p style={{ color: 'var(--text-muted)' }}>No sync has run yet.</p>;
  return (
    <div className="table-wrap">
      <table className="data">
        <thead><tr><th>Started</th><th>Status</th><th className="num">Rows</th><th>Note</th></tr></thead>
        <tbody>
          {c.syncs.map((s) => (
            <tr key={s.id}>
              <td>{dateTime(s.started_at)}</td>
              <td>{s.status === 'ok' ? <Badge tone="good">ok</Badge> : <Badge tone="critical">{s.status}</Badge>}</td>
              <td className="num">{s.rows_written}</td>
              <td style={{ whiteSpace: 'normal', maxWidth: 260 }} className="muted">{s.error ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

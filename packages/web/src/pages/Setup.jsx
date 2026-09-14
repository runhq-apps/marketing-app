import { useState } from 'react';
import { useNavigate, useOutletContext } from 'react-router-dom';
import { api } from '../lib/api.js';
import { Card, Field, Badge, Loading, useAsync, useToast, Spinner, Empty } from '../components/ui.jsx';

export default function Setup() {
  const { project, reloadProject } = useOutletContext();
  const origin = window.location.origin;

  return (
    <main className="page">
      <div className="page-head">
        <h1>Setup</h1>
      </div>

      <div className="grid cols-2" style={{ alignItems: 'start' }}>
        <div className="grid" style={{ alignContent: 'start' }}>
          <Install project={project} origin={origin} />
          <Verify project={project} />
        </div>
        <div className="grid" style={{ alignContent: 'start' }}>
          <Settings project={project} onSaved={reloadProject} />
          <Stages project={project} onSaved={reloadProject} />
          <Danger project={project} />
        </div>
      </div>
    </main>
  );
}

function Snippet({ code, label }) {
  const toast = useToast();
  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between', margin: '12px 0 6px' }}>
        <strong style={{ fontSize: 12.5 }}>{label}</strong>
        <button className="btn small ghost" onClick={() => {
          navigator.clipboard?.writeText(code).then(() => toast('Copied'), () => toast('Copy failed', 'err'));
        }}>Copy</button>
      </div>
      <pre className="snippet">{code}</pre>
    </>
  );
}

function Install({ project, origin }) {
  return (
    <Card title="Install the SDK" sub={`key ${project.sdk_key}`}>
      <Snippet label="1 · Marketing site" code={
`<script async src="${origin}/sdk.js"
  data-runhq-key="${project.sdk_key}"></script>`} />

      <Snippet label="2 · Product — npm" code={
`import runhq from '@runhq/sdk';

runhq.init({ key: '${project.sdk_key}', host: '${origin}' });`} />

      <Snippet label="3 · Identify" code={
`// signup, demo request, invite accept — anywhere an email appears
runhq.identify(user.id, {
  email: user.email,
  name: user.name,
  company: user.company,
});`} />

      <Snippet label="4 · Stages and revenue" code={
`runhq.stage('trial');                       // a funnel stage by key
runhq.track('demo_booked');                 // or a named event mapped to a stage
runhq.revenue(499, { plan: 'pro' });        // only for revenue Stripe never sees`} />

      <p style={{ color: 'var(--text-muted)', fontSize: 12, margin: '10px 0 0' }}>
        If Stripe is connected on the Revenue tab, leave <code>revenue()</code> out — the processor
        already reports what was paid, and sending both counts the same money twice.
      </p>

      <p style={{ color: 'var(--text-muted)', fontSize: 12, marginBottom: 0 }}>
        Page views, UTM and click-ID capture, the anonymous id and the first touch are automatic.
      </p>
    </Card>
  );
}

function Verify({ project }) {
  const [state, setState] = useState(null);
  const [busy, setBusy] = useState(false);

  const check = async () => {
    setBusy(true);
    try {
      const summary = await api.summary(project.slug, { days: 7 });
      const events = summary.series.reduce((n, d) => n + d.leads, 0);
      const scan = summary.scan;
      setState({
        events,
        sdkOnSite: scan?.detected?.trackers?.runhq_sdk ?? null,
        scanned: !!scan,
      });
    } finally { setBusy(false); }
  };

  return (
    <Card title="Verify the install"
      actions={<button className="btn small" onClick={check} disabled={busy}>{busy ? <Spinner /> : 'Check'}</button>}>
      {!state ? (
        <p style={{ color: 'var(--text-secondary)', margin: 0 }}>
          Checks whether events are arriving and whether the tag is visible on your homepage.
        </p>
      ) : (
        <ul style={{ margin: 0, paddingLeft: 18, color: 'var(--text-secondary)' }}>
          <li style={{ marginBottom: 6 }}>
            {state.events > 0
              ? <><Badge tone="good">receiving</Badge> {state.events} new leads in the last 7 days.</>
              : <><Badge tone="critical">nothing</Badge> No leads in the last 7 days — the SDK may not be installed.</>}
          </li>
          <li>
            {state.sdkOnSite === null
              ? <><Badge tone="info">unknown</Badge> The site has not been scanned yet.</>
              : state.sdkOnSite
                ? <><Badge tone="good">found</Badge> The tag is in your homepage HTML.</>
                : <><Badge tone="warning">not on homepage</Badge> Events may be coming from the app only, which loses the first touch.</>}
          </li>
        </ul>
      )}
    </Card>
  );
}

function Settings({ project, onSaved }) {
  const toast = useToast();
  const [form, setForm] = useState({
    name: project.name,
    website: project.website ?? '',
    currency: project.currency,
    target_cac: project.target_cac ?? '',
  });
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      await api.updateProject(project.slug, {
        name: form.name.trim(),
        website: form.website.trim() || null,
        currency: form.currency,
        target_cac: form.target_cac === '' ? null : Number(form.target_cac),
      });
      toast('Project saved');
      onSaved();
    } catch (e) { toast(e.message, 'err'); }
    finally { setBusy(false); }
  };

  return (
    <Card title="Project">
      <Field label="Name"><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
      <Field label="Website" help="What the site scan checks for pixels and preview assets.">
        <input value={form.website} onChange={(e) => setForm({ ...form, website: e.target.value })} placeholder="https://…" />
      </Field>
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <div style={{ flex: 1 }}>
          <Field label="Currency">
            <select value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value })}>
              {['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'KRW', 'INR', 'BRL'].map((c) => <option key={c}>{c}</option>)}
            </select>
          </Field>
        </div>
        <div style={{ flex: 1 }}>
          <Field label="Target CAC" help="Channels above it get flagged.">
            <input inputMode="decimal" value={form.target_cac} onChange={(e) => setForm({ ...form, target_cac: e.target.value })} />
          </Field>
        </div>
      </div>
      <button className="btn primary" onClick={save} disabled={busy}>{busy ? <Spinner /> : 'Save'}</button>
    </Card>
  );
}

function Stages({ project, onSaved }) {
  const toast = useToast();
  const [stages, setStages] = useState(project.stages ?? []);
  const [busy, setBusy] = useState(false);

  const update = (i, patch) => setStages(stages.map((s, j) => (i === j ? { ...s, ...patch } : s)));
  const move = (i, dir) => {
    const next = [...stages];
    const j = i + dir;
    if (j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j], next[i]];
    setStages(next);
  };

  const save = async () => {
    setBusy(true);
    try {
      await api.setStages(project.slug, stages.map((s, i) => ({ key: s.key, label: s.label, position: i, is_conversion: s.is_conversion })));
      toast('Funnel saved');
      onSaved();
    } catch (e) { toast(e.message, 'err'); }
    finally { setBusy(false); }
  };

  return (
    <Card title="Funnel stages" sub="in order">
      <p style={{ marginTop: 0, color: 'var(--text-secondary)' }}>
        A lead only ever moves forward. Mark the stage that means "paying" as the conversion — CAC and
        conversion rate are counted from it.
      </p>
      {stages.map((s, i) => (
        <div className="row" key={s.key} style={{ marginBottom: 7, flexWrap: 'nowrap' }}>
          <input value={s.label} onChange={(e) => update(i, { label: e.target.value })} style={{ flex: 1 }} />
          <code style={{ color: 'var(--text-muted)', minWidth: 84 }}>{s.key}</code>
          <label className="row" style={{ gap: 5, whiteSpace: 'nowrap' }} title="Counts as a customer">
            <input type="checkbox" style={{ width: 'auto' }} checked={!!s.is_conversion}
              onChange={(e) => update(i, { is_conversion: e.target.checked ? 1 : 0 })} />
            <span style={{ fontSize: 12.5 }}>conversion</span>
          </label>
          <button className="btn small ghost" onClick={() => move(i, -1)} disabled={i === 0} aria-label="Move up">↑</button>
          <button className="btn small ghost" onClick={() => move(i, 1)} disabled={i === stages.length - 1} aria-label="Move down">↓</button>
          <button className="btn small ghost" onClick={() => setStages(stages.filter((_, j) => j !== i))} aria-label="Remove">✕</button>
        </div>
      ))}
      <div className="row" style={{ marginTop: 10 }}>
        <button className="btn" onClick={() => setStages([...stages, { key: `stage_${stages.length + 1}`, label: 'New stage', is_conversion: 0 }])}>Add stage</button>
        <button className="btn primary" onClick={save} disabled={busy}>{busy ? <Spinner /> : 'Save funnel'}</button>
      </div>
      <p style={{ color: 'var(--text-muted)', fontSize: 12, marginBottom: 0 }}>
        Saving replaces the stage list. Events already recorded keep the stage key they were sent with.
      </p>
    </Card>
  );
}

function Danger({ project }) {
  const toast = useToast();
  const navigate = useNavigate();
  const [confirmText, setConfirmText] = useState('');
  const [busy, setBusy] = useState(false);

  const remove = async () => {
    setBusy(true);
    try {
      await api.deleteProject(project.slug);
      toast(`Deleted ${project.name}`);
      navigate('/');
    } catch (e) { toast(e.message, 'err'); }
    finally { setBusy(false); }
  };

  return (
    <Card title="Delete project">
      <p style={{ marginTop: 0, color: 'var(--text-secondary)' }}>
        Deletes the project and everything under it — channels, spend history, leads, events and findings.
        This cannot be undone.
      </p>
      <Field label={`Type ${project.name} to confirm`}>
        <input value={confirmText} onChange={(e) => setConfirmText(e.target.value)} />
      </Field>
      <button className="btn danger" disabled={confirmText !== project.name || busy} onClick={remove}>
        {busy ? <Spinner /> : 'Delete this project'}
      </button>
    </Card>
  );
}

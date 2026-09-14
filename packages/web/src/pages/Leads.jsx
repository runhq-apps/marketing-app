import { useState } from 'react';
import { useOutletContext, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api.js';
import { money, count, dateTime, shortDate, titleCase } from '../lib/format.js';
import { Card, Badge, Drawer, Loading, ErrorNote, Empty, useAsync, useToast } from '../components/ui.jsx';

const PAGE = 50;

export default function Leads() {
  const { project, days, attribution } = useOutletContext();
  const [params, setParams] = useSearchParams();
  const [offset, setOffset] = useState(0);
  const [openId, setOpenId] = useState(null);

  const filters = {
    channel_id: params.get('channel_id') ?? '',
    stage: params.get('stage') ?? '',
    identified: params.get('identified') ?? '',
    q: params.get('q') ?? '',
  };
  const setFilter = (key, value) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value); else next.delete(key);
    setParams(next, { replace: true });
    setOffset(0);
  };

  const channels = useAsync(() => api.channels(project.slug), [project.slug]);
  const leads = useAsync(
    () => api.leads(project.slug, { days, attribution, ...filters, limit: PAGE, offset }),
    [project.slug, days, attribution, filters.channel_id, filters.stage, filters.identified, filters.q, offset],
  );

  const stages = project.stages ?? [];
  const rows = leads.data?.rows ?? [];
  const total = leads.data?.total ?? 0;

  return (
    <main className="page">
      <div className="page-head">
        <h1>Leads</h1>
        <span className="spacer" />
        <a className="btn" href={api.leadsCsvUrl(project.slug, { days, ...filters })} download>Export CSV</a>
      </div>

      <Card bodyStyle={{ padding: 0 }}>
        <div className="row" style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
          <input style={{ maxWidth: 240 }} placeholder="Search email, name, company, campaign"
            defaultValue={filters.q}
            onKeyDown={(e) => e.key === 'Enter' && setFilter('q', e.currentTarget.value)}
            onBlur={(e) => e.target.value !== filters.q && setFilter('q', e.target.value)} />
          <select style={{ maxWidth: 190 }} value={filters.channel_id} onChange={(e) => setFilter('channel_id', e.target.value)}>
            <option value="">All channels</option>
            <option value="none">Unattributed only</option>
            {(channels.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <select style={{ maxWidth: 160 }} value={filters.stage} onChange={(e) => setFilter('stage', e.target.value)}>
            <option value="">Any stage</option>
            {stages.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
          </select>
          <select style={{ maxWidth: 160 }} value={filters.identified} onChange={(e) => setFilter('identified', e.target.value)}>
            <option value="">Known and anonymous</option>
            <option value="yes">Identified only</option>
            <option value="no">Anonymous only</option>
          </select>
          <span style={{ flex: 1 }} />
          <span style={{ color: 'var(--text-muted)', fontSize: 12.5 }}>{count(total)} leads</span>
        </div>

        {leads.loading ? <Loading what="leads" />
          : leads.error ? <ErrorNote error={leads.error} onRetry={leads.reload} />
          : rows.length === 0 ? (
            <Empty title="No leads match">
              {filters.channel_id === 'none'
                ? 'Nothing untracked in this window — every lead carried a UTM or a click ID.'
                : 'Try a wider date range, or clear the filters.'}
            </Empty>
          ) : (
            <>
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>Identity</th>
                      <th>Channel</th>
                      <th>Campaign</th>
                      <th>Stage</th>
                      <th className="num">Value</th>
                      <th>First seen</th>
                      <th>Last seen</th>
                      <th className="num">Events</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((l) => (
                      <tr key={l.id} className="clickable" onClick={() => setOpenId(l.id)}>
                        <td className="name">
                          {l.email ?? l.name ?? <span className="muted">anonymous · {l.anon_id?.slice(0, 10)}</span>}
                          {l.company && <div style={{ color: 'var(--text-muted)', fontWeight: 400 }}>{l.company}</div>}
                        </td>
                        <td>{l.channel_name ?? <Badge tone="warning">unattributed</Badge>}</td>
                        <td className="muted">{l.utm_campaign ?? l.utm_source ?? '—'}</td>
                        <td>{titleCase(l.stage ?? '—')}</td>
                        <td className="num">{l.value ? money(l.value, project.currency) : <span className="muted">—</span>}</td>
                        <td className="muted">{shortDate(l.first_seen)}</td>
                        <td className="muted">{shortDate(l.last_seen)}</td>
                        <td className="num muted">{l.event_count}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="row" style={{ padding: '10px 16px', borderTop: '1px solid var(--border)' }}>
                <button className="btn small" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>Previous</button>
                <span style={{ color: 'var(--text-muted)', fontSize: 12.5 }}>
                  {offset + 1}–{Math.min(offset + PAGE, total)} of {count(total)}
                </span>
                <button className="btn small" disabled={offset + PAGE >= total} onClick={() => setOffset(offset + PAGE)}>Next</button>
              </div>
            </>
          )}
      </Card>

      {openId && <LeadDrawer id={openId} project={project} onClose={() => setOpenId(null)} onChanged={leads.reload} />}
    </main>
  );
}

function LeadDrawer({ id, project, onClose, onChanged }) {
  const toast = useToast();
  const state = useAsync(() => api.lead(id), [id]);
  const [busy, setBusy] = useState(false);

  if (state.loading) return <Drawer title="Lead" onClose={onClose}><Loading what="lead" /></Drawer>;
  if (state.error) return <Drawer title="Lead" onClose={onClose}><ErrorNote error={state.error} /></Drawer>;

  const l = state.data;
  const title = l.email ?? l.name ?? `Anonymous ${l.anon_id?.slice(0, 10) ?? ''}`;

  const setStage = async (stage) => {
    setBusy(true);
    try { await api.updateLead(l.id, { stage }); state.reload(); onChanged(); toast(`Moved to ${stage}`); }
    catch (e) { toast(e.message, 'err'); }
    finally { setBusy(false); }
  };

  return (
    <Drawer title={title} onClose={onClose}>
      <dl className="kv" style={{ marginBottom: 16 }}>
        <dt>Identity</dt>
        <dd>{l.email ?? <span style={{ color: 'var(--text-muted)' }}>anonymous — no email captured</span>}
          {l.external_id && <div style={{ color: 'var(--text-muted)' }}>user id {l.external_id}</div>}</dd>
        {l.name && <><dt>Name</dt><dd>{l.name}</dd></>}
        {l.company && <><dt>Company</dt><dd>{l.company}</dd></>}
        <dt>Last touch</dt><dd>{l.channel_name ?? 'Unattributed'}</dd>
        <dt>First touch</dt><dd>{l.first_channel_name ?? 'Unattributed'}</dd>
        <dt>Campaign</dt><dd>{l.utm_campaign ?? '—'}</dd>
        <dt>UTM</dt>
        <dd style={{ color: 'var(--text-secondary)' }}>
          {[l.utm_source && `source=${l.utm_source}`, l.utm_medium && `medium=${l.utm_medium}`,
            l.utm_content && `content=${l.utm_content}`, l.click_id && `click id=${l.click_id}`]
            .filter(Boolean).join(' · ') || 'none — this visit arrived untagged'}
        </dd>
        <dt>Landing page</dt><dd>{l.landing_page ?? '—'}</dd>
        <dt>Referrer</dt><dd>{l.referrer ?? 'direct'}</dd>
        <dt>Value</dt><dd>{money(l.value, project.currency)}</dd>
        <dt>Seen</dt><dd>{dateTime(l.first_seen)} → {dateTime(l.last_seen)}</dd>
      </dl>

      <div className="row" style={{ marginBottom: 16 }}>
        <span style={{ color: 'var(--text-secondary)', fontSize: 12.5 }}>Stage</span>
        <select style={{ maxWidth: 190 }} value={l.stage ?? ''} disabled={busy} onChange={(e) => setStage(e.target.value)}>
          {(project.stages ?? []).map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
        </select>
      </div>

      <h3 style={{ fontSize: 13.5, margin: '0 0 10px' }}>Timeline · {l.events.length} events</h3>
      <div className="timeline">
        {l.events.map((e) => (
          <div className="ev" key={e.id}>
            <div className="row" style={{ justifyContent: 'space-between', gap: 10 }}>
              <strong style={{ fontWeight: 560 }}>{e.name}</strong>
              <span className="when">{dateTime(e.ts)}</span>
            </div>
            <div style={{ color: 'var(--text-secondary)', fontSize: 12.5 }}>
              {e.stage && <span>stage {e.stage}</span>}
              {e.value > 0 && <span> · {money(e.value, project.currency)}</span>}
              {e.url && <div style={{ color: 'var(--text-muted)', overflowWrap: 'anywhere' }}>{e.url}</div>}
            </div>
          </div>
        ))}
      </div>
    </Drawer>
  );
}

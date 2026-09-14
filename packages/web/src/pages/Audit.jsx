import { useState } from 'react';
import { Link, useOutletContext } from 'react-router-dom';
import { api } from '../lib/api.js';
import { ago } from '../lib/format.js';
import { Card, Badge, Loading, ErrorNote, Empty, useAsync, useToast, Spinner, Segmented } from '../components/ui.jsx';

const TRACKER_GROUPS = [
  { title: 'Ad platforms', keys: ['gtag', 'gtm', 'ga4', 'google_ads_conv', 'meta_pixel', 'linkedin_insight', 'bing_uet', 'reddit_pixel', 'x_pixel', 'tiktok_pixel'] },
  { title: 'Product & CRM', keys: ['runhq_sdk', 'segment', 'posthog', 'mixpanel', 'amplitude', 'hubspot', 'intercom'] },
  { title: 'Behaviour', keys: ['hotjar', 'clarity', 'plausible'] },
];

const TRACKER_NAME = {
  gtag: 'Google tag', gtm: 'Tag Manager', ga4: 'GA4 ID', google_ads_conv: 'Ads conversion',
  meta_pixel: 'Meta Pixel', linkedin_insight: 'LinkedIn Insight', bing_uet: 'Microsoft UET',
  reddit_pixel: 'Reddit Pixel', x_pixel: 'X Pixel', tiktok_pixel: 'TikTok Pixel',
  runhq_sdk: 'Run SDK', segment: 'Segment', posthog: 'PostHog', mixpanel: 'Mixpanel',
  amplitude: 'Amplitude', hubspot: 'HubSpot', intercom: 'Intercom',
  hotjar: 'Hotjar', clarity: 'Clarity', plausible: 'Plausible',
};

const PAGE_NAME = {
  og_image: 'Link preview banner (og:image)', og_title: 'Open Graph title', meta_description: 'Meta description',
  favicon: 'Favicon', title: 'Page title', canonical: 'Canonical URL',
};

export default function Audit() {
  const { project } = useOutletContext();
  const toast = useToast();
  const [status, setStatus] = useState('open');
  const [busy, setBusy] = useState(false);
  const state = useAsync(() => api.audit(project.slug, { status }), [project.slug, status]);

  const rerun = async () => {
    setBusy(true);
    try {
      await api.runAudit(project.slug, { scan: true });
      toast('Audit re-run against the live site');
      state.reload();
    } catch (e) { toast(e.message, 'err'); }
    finally { setBusy(false); }
  };

  const setFinding = async (id, next) => {
    try { await api.setFinding(id, next); state.reload(); }
    catch (e) { toast(e.message, 'err'); }
  };

  if (state.loading) return <main className="page"><Loading what="audit" /></main>;
  if (state.error) return <main className="page"><ErrorNote error={state.error} onRetry={state.reload} /></main>;

  const { findings, health, scan } = state.data;
  const grouped = ['critical', 'serious', 'warning', 'info'].map((sev) => [sev, findings.filter((f) => f.severity === sev)]);

  return (
    <main className="page">
      <div className="page-head">
        <h1>Audit</h1>
        <span className="spacer" />
        <Segmented value={status} onChange={setStatus} ariaLabel="Finding status"
          options={[{ value: 'open', label: 'Open' }, { value: 'dismissed', label: 'Dismissed' }, { value: 'resolved', label: 'Fixed' }]} />
        <button className="btn primary" onClick={rerun} disabled={busy}>{busy ? <Spinner /> : 'Re-run audit'}</button>
      </div>

      <div className="grid cols-2" style={{ marginBottom: 14, gridTemplateColumns: 'minmax(0, 2fr) minmax(280px, 1fr)' }}>
        <Card title="Findings" sub={`${findings.length} ${status}`}>
          {findings.length === 0 ? (
            <Empty title={status === 'open'
                ? (health.score == null ? 'Not audited yet' : 'Nothing outstanding')
                : `No ${status} findings`}
              action={status === 'open' && health.score == null
                ? <button className="btn primary" onClick={rerun} disabled={busy}>{busy ? <Spinner /> : 'Run the audit'}</button>
                : null} />
          ) : grouped.map(([sev, list]) => (list.length === 0 ? null : (
            <div key={sev} style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 11.5, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-muted)', marginBottom: 4 }}>
                {sev} · {list.length}
              </div>
              {list.map((f) => (
                <div className="finding" key={f.id}>
                  <Badge tone={f.severity}>{f.severity}</Badge>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <h4>{f.title}</h4>
                    <p>{f.detail}</p>
                    {f.fix && <div className="fix">{f.fix}</div>}
                    <div className="acts">
                      {f.status === 'open'
                        ? <button className="btn small ghost" onClick={() => setFinding(f.id, 'dismissed')}>Dismiss</button>
                        : <button className="btn small ghost" onClick={() => setFinding(f.id, 'open')}>Reopen</button>}
                      {f.scope === 'channel' && (
                        <Link className="btn small ghost" to={`/p/${project.slug}/channels`}>Open channel</Link>
                      )}
                      <span style={{ color: 'var(--text-muted)', fontSize: 12, alignSelf: 'center' }}>
                        first seen {ago(f.first_detected)}
                      </span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )))}
        </Card>

        <div className="grid" style={{ alignContent: 'start' }}>
          <Card title="Health">
            <div style={{ fontSize: 38, fontWeight: 640, letterSpacing: '-0.02em', lineHeight: 1.1 }}>
              {health.score ?? '—'}
              {health.score != null && <span style={{ fontSize: 18, color: 'var(--text-muted)', fontWeight: 500 }}>/100</span>}
            </div>
            <div style={{ color: 'var(--text-secondary)', marginTop: 2 }}>
              {health.score == null ? 'Not audited yet.'
                : health.open === 0 ? 'No open findings.' : `${health.open} open findings.`}
            </div>
            <div className="row" style={{ marginTop: 10 }}>
              {['critical', 'serious', 'warning', 'info'].map((sev) => (
                health.counts[sev] ? <Badge key={sev} tone={sev}>{health.counts[sev]} {sev}</Badge> : null
              ))}
            </div>
          </Card>

          <SiteScan project={project} scan={scan} onScanned={state.reload} />
        </div>
      </div>
    </main>
  );
}

function SiteScan({ project, scan, onScanned }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  const rescan = async () => {
    setBusy(true);
    try { await api.scan(project.slug); toast('Site scanned'); onScanned(); }
    catch (e) { toast(e.message, 'err'); }
    finally { setBusy(false); }
  };

  if (!project.website) {
    return (
      <Card title="Site scan">
        <Empty title="No website set" action={<Link className="btn" to={`/p/${project.slug}/setup`}>Add one</Link>}>
          The scan reads your live HTML to find which pixels and preview assets are actually there.
        </Empty>
      </Card>
    );
  }

  const trackers = scan?.detected?.trackers ?? {};
  const page = scan?.detected?.page ?? {};

  return (
    <Card title="Site scan" sub={scan ? ago(scan.scanned_at) : 'never run'}
      actions={<button className="btn small" onClick={rescan} disabled={busy}>{busy ? <Spinner /> : 'Scan now'}</button>}>
      {!scan ? (
        <p style={{ color: 'var(--text-secondary)', margin: 0 }}>Run a scan to see which tags are live on {project.website}.</p>
      ) : !scan.ok ? (
        <p style={{ color: 'var(--critical)', margin: 0 }}>{scan.error}</p>
      ) : (
        <>
          {TRACKER_GROUPS.map((g) => (
            <div key={g.title} style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 11.5, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-muted)', marginBottom: 5 }}>
                {g.title}
              </div>
              <div className="row" style={{ gap: 5 }}>
                {g.keys.map((k) => (
                  <Badge key={k} tone={trackers[k] ? 'good' : 'info'} dot={false}>
                    {trackers[k] ? '✓' : '·'} {TRACKER_NAME[k] ?? k}
                  </Badge>
                ))}
              </div>
            </div>
          ))}
          <div style={{ fontSize: 11.5, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-muted)', marginBottom: 5 }}>
            Page assets
          </div>
          <div className="row" style={{ gap: 5, marginBottom: 10 }}>
            {Object.entries(PAGE_NAME).map(([k, label]) => (
              <Badge key={k} tone={page[k] ? 'good' : 'warning'} dot={false}>{page[k] ? '✓' : '✗'} {label}</Badge>
            ))}
          </div>
          <p style={{ color: 'var(--text-muted)', fontSize: 12, margin: 0 }}>
            Server-rendered HTML only — tags injected by JavaScript read as missing.
          </p>
        </>
      )}
    </Card>
  );
}

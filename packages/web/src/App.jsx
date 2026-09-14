import { NavLink, Navigate, Outlet, Route, Routes, useOutletContext, useParams, useSearchParams } from 'react-router-dom';
import { ToastHost, useTheme, useAsync, Loading, ErrorNote, Segmented } from './components/ui.jsx';
import { api } from './lib/api.js';
import Account from './pages/Account.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Channels from './pages/Channels.jsx';
import Leads from './pages/Leads.jsx';
import Revenue from './pages/Revenue.jsx';
import Audit from './pages/Audit.jsx';
import Setup from './pages/Setup.jsx';

const RANGES = [
  { value: '7', label: '7d' },
  { value: '30', label: '30d' },
  { value: '90', label: '90d' },
];

export default function App() {
  return (
    <ToastHost>
      <div className="shell">
        <Routes>
          <Route element={<Shell />}>
            <Route index element={<Account />} />
            <Route path="p/:slug" element={<ProjectShell />}>
              <Route index element={<Dashboard />} />
              <Route path="channels" element={<Channels />} />
              <Route path="leads" element={<Leads />} />
              <Route path="revenue" element={<Revenue />} />
              <Route path="audit" element={<Audit />} />
              <Route path="setup" element={<Setup />} />
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </div>
    </ToastHost>
  );
}

function Shell() {
  const [theme, setTheme] = useTheme();
  const [params, setParams] = useSearchParams();
  const days = params.get('days') ?? '30';
  const attribution = params.get('attribution') ?? 'last';

  const update = (key, value) => {
    const next = new URLSearchParams(params);
    next.set(key, value);
    setParams(next, { replace: true });
  };

  return (
    <>
      <header className="topbar">
        <NavLink to="/" className="brand">
          <svg width="22" height="22" viewBox="0 0 32 32" aria-hidden="true">
            <rect width="32" height="32" rx="7" fill="var(--series-1)" />
            <path d="M8 21l5-9 4 6 3-4 4 7" stroke="#fff" strokeWidth="2.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Run <span className="brand-sub">Marketing</span>
        </NavLink>
        <div className="topbar-right">
          <Segmented options={RANGES} value={days} onChange={(v) => update('days', v)} ariaLabel="Date range" />
          <Segmented
            options={[{ value: 'last', label: 'Last touch' }, { value: 'first', label: 'First touch' }]}
            value={attribution} onChange={(v) => update('attribution', v)} ariaLabel="Attribution model" />
          <button className="btn ghost" title={`Theme: ${theme}`}
            onClick={() => setTheme(theme === 'dark' ? 'light' : theme === 'light' ? 'system' : 'dark')}>
            {theme === 'dark' ? '☾' : theme === 'light' ? '☀' : '◐'}
          </button>
        </div>
      </header>
      <Outlet context={{ days, attribution }} />
    </>
  );
}

/** Loads the project once and shares it (plus the global range) with every tab. */
function ProjectShell() {
  const { slug } = useParams();
  const { days, attribution } = useOutletContext();
  const state = useAsync(() => api.project(slug), [slug]);

  if (state.loading) return <main className="page"><Loading what="project" /></main>;
  if (state.error) return <main className="page"><ErrorNote error={state.error} onRetry={state.reload} /></main>;

  const project = state.data;
  const tab = (to, label, end = false) => (
    <NavLink to={to} end={end} className={({ isActive }) => (isActive ? 'active' : '')}>{label}</NavLink>
  );

  return (
    <>
      <nav className="tabs">
        <div className="crumbs">
          <NavLink to="/">Projects</NavLink>
          <span className="sep">/</span>
          <strong>{project.name}</strong>
        </div>
        {tab(`/p/${slug}`, 'Dashboard', true)}
        {tab(`/p/${slug}/channels`, 'Channels')}
        {tab(`/p/${slug}/leads`, 'Leads')}
        {tab(`/p/${slug}/revenue`, 'Revenue')}
        {tab(`/p/${slug}/audit`, 'Audit')}
        {tab(`/p/${slug}/setup`, 'Setup')}
      </nav>
      <Outlet context={{ project, days, attribution, reloadProject: state.reload }} />
    </>
  );
}

export { RANGES };

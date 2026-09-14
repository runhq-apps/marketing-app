import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { deltaClass, deltaLabel } from '../lib/format.js';

export function Card({ title, sub, actions, children, bodyStyle, ...rest }) {
  return (
    <section className="card" {...rest}>
      {(title || actions) && (
        <div className="card-head">
          {title && <h2>{title}</h2>}
          {sub && <span className="sub">{sub}</span>}
          <span className="spacer" />
          {actions}
        </div>
      )}
      <div className="card-body" style={bodyStyle}>{children}</div>
    </section>
  );
}

/**
 * Stat tile: label · value · optional delta against a named period.
 * `upIsGood: false` for costs — a rising CAC is not good news dressed in green.
 */
export function Stat({ label, value, delta, upIsGood = true, foot, hero = false, title }) {
  return (
    <div className="stat" title={title}>
      <div className="label">{label}</div>
      <div className={`value${hero ? ' hero' : ''}`}>{value}</div>
      {(delta != null || foot) && (
        <div className="foot">
          {delta != null && (
            <span className={`delta ${deltaClass(delta, { upIsGood })}`}>{deltaLabel(delta)}</span>
          )}
          {foot && <span>{foot}</span>}
        </div>
      )}
    </div>
  );
}

export function Badge({ tone = 'info', children, dot = true }) {
  return <span className={`badge ${tone}`}>{dot && <span className="dot" />}{children}</span>;
}

export function Segmented({ options, value, onChange, ariaLabel }) {
  return (
    <div className="seg" role="group" aria-label={ariaLabel}>
      {options.map((o) => (
        <button key={o.value} className={o.value === value ? 'on' : ''}
          onClick={() => onChange(o.value)} type="button">{o.label}</button>
      ))}
    </div>
  );
}

export function Field({ label, help, children }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {help && <span className="help">{help}</span>}
    </label>
  );
}

export function Modal({ title, onClose, children, footer, wide = false }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <div className="modal" style={wide ? { width: 'min(860px, calc(100vw - 32px))' } : undefined}
        role="dialog" aria-modal="true" aria-label={title}>
        <div className="panel-head">
          <h2>{title}</h2>
          <span style={{ flex: 1 }} />
          <button className="btn ghost" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="panel-body">{children}</div>
        {footer && <div className="panel-foot">{footer}</div>}
      </div>
    </>
  );
}

export function Drawer({ title, onClose, children, footer }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-modal="true" aria-label={title}>
        <div className="panel-head">
          <h2>{title}</h2>
          <span style={{ flex: 1 }} />
          <button className="btn ghost" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="panel-body" style={{ flex: 1 }}>{children}</div>
        {footer && <div className="panel-foot">{footer}</div>}
      </aside>
    </>
  );
}

export function Empty({ title, children, action }) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

export const Spinner = () => <span className="spinner" aria-hidden="true" />;

export function Loading({ what = 'data' }) {
  return (
    <div className="empty" style={{ padding: 28 }}>
      <Spinner /> <span style={{ marginLeft: 8, color: 'var(--text-secondary)' }}>Loading {what}…</span>
    </div>
  );
}

export function ErrorNote({ error, onRetry }) {
  return (
    <div className="empty">
      <h3>Something went wrong</h3>
      <p style={{ color: 'var(--critical)' }}>{error?.message ?? String(error)}</p>
      {onRetry && <button className="btn" onClick={onRetry}>Try again</button>}
    </div>
  );
}

/* ------------------------------------------------------------------ toast */

const ToastContext = createContext(() => {});
export const useToast = () => useContext(ToastContext);

export function ToastHost({ children }) {
  const [toast, setToast] = useState(null);
  const push = useCallback((message, tone = 'ok') => {
    setToast({ message, tone, id: Math.random() });
  }, []);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), toast.tone === 'err' ? 8000 : 4000);
    return () => clearTimeout(t);
  }, [toast]);
  return (
    <ToastContext.Provider value={push}>
      {children}
      {toast && (
        <div className={`toast${toast.tone === 'err' ? ' err' : ''}`} role="status" onClick={() => setToast(null)}>
          {toast.message}
        </div>
      )}
    </ToastContext.Provider>
  );
}

/* ----------------------------------------------------------------- theme */

export function useTheme() {
  const [theme, setTheme] = useState(() => localStorage.getItem('runhq.theme') || 'system');
  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', theme);
    localStorage.setItem('runhq.theme', theme);
  }, [theme]);
  return [theme, setTheme];
}

/** Data fetching with the three states every screen needs: loading, error, value. */
export function useAsync(fn, deps, { skip = false } = {}) {
  const [state, setState] = useState({ loading: !skip, data: null, error: null });
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    if (skip) return;
    let live = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    fn()
      .then((data) => live && setState({ loading: false, data, error: null }))
      .catch((error) => live && setState({ loading: false, data: null, error }));
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce, skip]);
  return { ...state, reload: () => setNonce((n) => n + 1), setData: (data) => setState((s) => ({ ...s, data })) };
}

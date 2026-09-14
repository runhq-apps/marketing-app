export function money(n, currency = 'USD', { compact = false, cents = false } = {}) {
  if (n == null || Number.isNaN(Number(n))) return '—';
  const v = Number(n);
  const opts = {
    style: 'currency', currency,
    maximumFractionDigits: cents ? 2 : (Math.abs(v) < 100 && v !== 0 ? 2 : 0),
    minimumFractionDigits: cents ? 2 : 0,
  };
  if (compact && Math.abs(v) >= 10_000) { opts.notation = 'compact'; opts.maximumFractionDigits = 1; }
  try { return new Intl.NumberFormat('en-US', opts).format(v); }
  catch { return `${currency} ${Math.round(v)}`; }
}

export function count(n, { compact = false } = {}) {
  if (n == null) return '—';
  const v = Number(n);
  if (compact && Math.abs(v) >= 10_000) return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(v);
  return new Intl.NumberFormat('en-US').format(v);
}

export const pct = (n, digits = 1) => (n == null ? '—' : `${Number(n).toFixed(digits)}%`);
export const ratio = (n) => (n == null ? '—' : `${Number(n).toFixed(2)}×`);

export function shortDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso.length <= 10 ? `${iso}T00:00:00Z` : iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

export function dateTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function ago(iso) {
  if (!iso) return 'never';
  const ms = Date.now() - Date.parse(iso);
  if (Number.isNaN(ms)) return 'never';
  const mins = Math.round(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return days < 30 ? `${days}d ago` : `${Math.round(days / 30)}mo ago`;
}

/** A delta is only good or bad once you say which direction you wanted. */
export function deltaClass(value, { upIsGood = true } = {}) {
  if (value == null || Math.abs(value) < 0.5) return 'flat';
  return (value > 0) === upIsGood ? 'up' : 'down';
}

export function deltaLabel(value) {
  if (value == null) return '—';
  const rounded = Math.round(Number(value));
  // A change that rounds to nothing is "0%", never "-0%".
  return `${rounded > 0 ? '+' : ''}${rounded === 0 ? 0 : rounded}%`;
}

export const titleCase = (s) => String(s ?? '').replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

const AUTH_LABEL = { api: 'API token', oauth: 'OAuth', credentials: 'Portal login', manual: 'Manual entry' };
export const authLabel = (t) => AUTH_LABEL[t] ?? titleCase(t);

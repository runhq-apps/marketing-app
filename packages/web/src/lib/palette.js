/**
 * Chart colors come from CSS custom properties, so every mark re-themes with the page
 * and light/dark stay a single source of truth in styles.css.
 *
 * The eight categorical slots are assigned in fixed order and never cycled: a ninth
 * channel folds into "Other" rather than borrowing slot 1's identity.
 */
export const SERIES_VARS = [
  'var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)',
  'var(--series-5)', 'var(--series-6)', 'var(--series-7)', 'var(--series-8)',
];

export const MAX_SERIES = SERIES_VARS.length;

/** Colour follows the entity, not its current rank — a filter must not repaint survivors. */
export function channelColors(channels) {
  const map = new Map();
  const ordered = channels
    .map((c) => c.channel_id ?? c.id)
    .filter(Boolean)                               // "Unattributed" is a gap, not a channel
    .sort((a, b) => String(a).localeCompare(String(b)));  // stable across filters and re-sorts
  ordered.forEach((id, i) => {
    map.set(id, i < MAX_SERIES ? SERIES_VARS[i] : 'var(--text-muted)');
  });
  return map;
}

export const SPEND_COLOR = 'var(--series-1)';
export const REVENUE_COLOR = 'var(--series-2)';
export const LEADS_COLOR = 'var(--series-1)';

export const SEVERITY_COLOR = {
  critical: 'var(--critical)',
  serious: 'var(--serious)',
  warning: 'var(--warning)',
  info: 'var(--text-muted)',
  good: 'var(--good)',
};

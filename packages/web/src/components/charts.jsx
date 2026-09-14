import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { money, count as fmtCount, shortDate } from '../lib/format.js';

/** Charts render at real pixel width so stroke weights stay honest at any size. */
function useSize(ref, fallback = 640) {
  const [width, setWidth] = useState(fallback);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const w = entry.contentRect.width;
      if (w > 0) setWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return width;
}

/** Axis ticks land on round numbers — 0 / 1,000 / 2,000, never 1,733. */
function niceTicks(max, targetCount = 4) {
  if (!(max > 0)) return [0, 1];
  const raw = max / targetCount;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  const top = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = 0; v <= top + step / 2; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
  return ticks;
}

function useNearestPoint(svgRef, data, plot) {
  const [index, setIndex] = useState(null);
  const onMove = useCallback((e) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect || !data.length) return;
    const x = e.clientX - rect.left - plot.left;
    const ratio = plot.width > 0 ? x / plot.width : 0;
    const i = Math.round(ratio * (data.length - 1));
    setIndex(Math.max(0, Math.min(data.length - 1, i)));
  }, [svgRef, data.length, plot.left, plot.width]);
  return [index, onMove, () => setIndex(null)];
}

/**
 * Two money series on ONE axis. Spend and revenue share a unit, so a single scale is
 * truthful; a second y-axis would invent a relationship that is not in the data.
 */
export function MoneyLineChart({ data, currency = 'USD', height = 240, series, showLegend = true }) {
  const wrapRef = useRef(null);
  const svgRef = useRef(null);
  const width = useSize(wrapRef);
  const lines = series ?? [
    { key: 'spend', label: 'Spend', color: 'var(--series-1)' },
    { key: 'revenue', label: 'Revenue', color: 'var(--series-2)' },
  ];

  const pad = { top: 12, right: 56, bottom: 24, left: 52 };
  const plot = {
    left: pad.left, top: pad.top,
    width: Math.max(10, width - pad.left - pad.right),
    height: Math.max(10, height - pad.top - pad.bottom),
  };

  const max = Math.max(1, ...data.flatMap((d) => lines.map((l) => Number(d[l.key]) || 0)));
  const ticks = niceTicks(max);
  const top = ticks[ticks.length - 1];
  const x = (i) => plot.left + (data.length <= 1 ? plot.width / 2 : (i / (data.length - 1)) * plot.width);
  const y = (v) => plot.top + plot.height - (Math.max(0, Number(v) || 0) / top) * plot.height;

  const [hover, onMove, onLeave] = useNearestPoint(svgRef, data, plot);
  const point = hover != null ? data[hover] : null;

  const path = (key) => data.map((d, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(d[key]).toFixed(1)}`).join(' ');
  const area = (key) => `${path(key)} L${x(data.length - 1).toFixed(1)},${(plot.top + plot.height).toFixed(1)} L${x(0).toFixed(1)},${(plot.top + plot.height).toFixed(1)} Z`;

  const labelEvery = Math.max(1, Math.ceil(data.length / Math.max(3, Math.floor(plot.width / 74))));

  return (
    <div className="chart" ref={wrapRef}>
      {showLegend && (
        <div className="legend" style={{ marginBottom: 8 }}>
          {lines.map((l) => (
            <span className="item" key={l.key}>
              <span className="key" style={{ background: l.color }} />{l.label}
            </span>
          ))}
        </div>
      )}
      <svg ref={svgRef} height={height} width="100%" viewBox={`0 0 ${width} ${height}`}
        onMouseMove={onMove} onMouseLeave={onLeave} role="img"
        aria-label={`${lines.map((l) => l.label).join(' and ')} over time`}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={plot.left} x2={plot.left + plot.width} y1={y(t)} y2={y(t)}
              stroke={t === 0 ? 'var(--baseline)' : 'var(--grid)'} strokeWidth="1" />
            <text x={plot.left - 8} y={y(t) + 4} textAnchor="end" fontSize="11" fill="var(--text-muted)"
              style={{ fontVariantNumeric: 'tabular-nums' }}>
              {money(t, currency, { compact: true })}
            </text>
          </g>
        ))}

        {data.map((d, i) => (i % labelEvery === 0 ? (
          <text key={d.date} x={x(i)} y={height - 6} textAnchor="middle" fontSize="11" fill="var(--text-muted)">
            {shortDate(d.date)}
          </text>
        ) : null))}

        {lines.map((l) => (
          <path key={`a-${l.key}`} d={area(l.key)} fill={l.color} opacity="0.10" />
        ))}
        {lines.map((l) => (
          <path key={l.key} d={path(l.key)} fill="none" stroke={l.color} strokeWidth="2"
            strokeLinejoin="round" strokeLinecap="round" />
        ))}

        {/* Direct end-labels: the endpoint is the one value worth stating on the plot. */}
        {data.length > 1 && lines.map((l) => (
          <text key={`e-${l.key}`} x={x(data.length - 1) + 8} y={y(data[data.length - 1][l.key]) + 4}
            fontSize="11.5" fill="var(--text-secondary)" style={{ fontVariantNumeric: 'tabular-nums' }}>
            {money(data[data.length - 1][l.key], currency, { compact: true })}
          </text>
        ))}

        {point && (
          <g pointerEvents="none">
            <line x1={x(hover)} x2={x(hover)} y1={plot.top} y2={plot.top + plot.height} stroke="var(--baseline)" strokeWidth="1" />
            {lines.map((l) => (
              <circle key={`h-${l.key}`} cx={x(hover)} cy={y(point[l.key])} r="4.5"
                fill={l.color} stroke="var(--surface-1)" strokeWidth="2" />
            ))}
          </g>
        )}
      </svg>

      {point && (
        <div className="tip" style={tipStyle(x(hover), width)}>
          <div className="t-date">{shortDate(point.date)}</div>
          {lines.map((l) => (
            <div className="t-row" key={l.key}>
              <span className="k"><span className="swatch" style={{ background: l.color }} />{l.label}</span>
              <span className="v">{money(point[l.key], currency)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const tipStyle = (px, width) => ({
  left: Math.min(Math.max(px - 70, 0), Math.max(0, width - 160)),
  top: 4,
});

/** One series of counts. Columns capped at 24px with a 2px surface gap between them. */
export function ColumnChart({ data, valueKey = 'leads', label = 'Leads', height = 190, color = 'var(--series-1)' }) {
  const wrapRef = useRef(null);
  const svgRef = useRef(null);
  const width = useSize(wrapRef);
  const pad = { top: 12, right: 12, bottom: 24, left: 44 };
  const plot = {
    left: pad.left, top: pad.top,
    width: Math.max(10, width - pad.left - pad.right),
    height: Math.max(10, height - pad.top - pad.bottom),
  };
  const max = Math.max(1, ...data.map((d) => Number(d[valueKey]) || 0));
  const ticks = niceTicks(max, 3);
  const top = ticks[ticks.length - 1];
  const slot = plot.width / Math.max(1, data.length);
  const barW = Math.max(2, Math.min(24, slot - 2)); // the 2px gap is the separator
  const x = (i) => plot.left + i * slot + (slot - barW) / 2;
  const y = (v) => plot.top + plot.height - (Math.max(0, v) / top) * plot.height;

  const [hover, onMove, onLeave] = useNearestPoint(svgRef, data, plot);
  const point = hover != null ? data[hover] : null;
  const labelEvery = Math.max(1, Math.ceil(data.length / Math.max(3, Math.floor(plot.width / 74))));
  const r = Math.min(4, barW / 2);

  return (
    <div className="chart" ref={wrapRef}>
      <svg ref={svgRef} height={height} width="100%" viewBox={`0 0 ${width} ${height}`}
        onMouseMove={onMove} onMouseLeave={onLeave} role="img" aria-label={`${label} per day`}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={plot.left} x2={plot.left + plot.width} y1={y(t)} y2={y(t)}
              stroke={t === 0 ? 'var(--baseline)' : 'var(--grid)'} strokeWidth="1" />
            <text x={plot.left - 8} y={y(t) + 4} textAnchor="end" fontSize="11" fill="var(--text-muted)"
              style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtCount(t, { compact: true })}</text>
          </g>
        ))}
        {data.map((d, i) => {
          const v = Number(d[valueKey]) || 0;
          const h = plot.top + plot.height - y(v);
          if (h <= 0) return null;
          // Rounded at the data end, square at the baseline.
          const rr = Math.min(r, h);
          return (
            <path key={d.date}
              d={`M${x(i)},${plot.top + plot.height} L${x(i)},${y(v) + rr} Q${x(i)},${y(v)} ${x(i) + rr},${y(v)} L${x(i) + barW - rr},${y(v)} Q${x(i) + barW},${y(v)} ${x(i) + barW},${y(v) + rr} L${x(i) + barW},${plot.top + plot.height} Z`}
              fill={color} opacity={hover == null || hover === i ? 1 : 0.45} />
          );
        })}
        {data.map((d, i) => (i % labelEvery === 0 ? (
          <text key={d.date} x={x(i) + barW / 2} y={height - 6} textAnchor="middle" fontSize="11" fill="var(--text-muted)">
            {shortDate(d.date)}
          </text>
        ) : null))}
      </svg>
      {point && (
        <div className="tip" style={tipStyle(x(hover), width)}>
          <div className="t-date">{shortDate(point.date)}</div>
          <div className="t-row">
            <span className="k"><span className="swatch" style={{ background: color }} />{label}</span>
            <span className="v">{fmtCount(point[valueKey])}</span>
          </div>
        </div>
      )}
    </div>
  );
}

/** Card-sized two-series plot: no axes, direct end values, hover still available. */
export function MiniChart({ data: raw, currency = 'USD', height = 74, cumulative = true }) {
  const wrapRef = useRef(null);
  const svgRef = useRef(null);
  const width = useSize(wrapRef, 320);
  const data = useMemo(() => (cumulative ? toCumulative(raw) : raw), [raw, cumulative]);
  const lines = [
    { key: 'spend', label: 'Spend', color: 'var(--series-1)' },
    { key: 'revenue', label: 'Revenue', color: 'var(--series-2)' },
  ];
  const plot = { left: 2, top: 6, width: Math.max(10, width - 4), height: Math.max(8, height - 12) };
  const max = Math.max(1, ...data.flatMap((d) => lines.map((l) => Number(d[l.key]) || 0)));
  const x = (i) => plot.left + (data.length <= 1 ? plot.width / 2 : (i / (data.length - 1)) * plot.width);
  const y = (v) => plot.top + plot.height - (Math.max(0, Number(v) || 0) / max) * plot.height;
  const [hover, onMove, onLeave] = useNearestPoint(svgRef, data, plot);
  const point = hover != null ? data[hover] : null;

  return (
    <div className="chart" ref={wrapRef}>
      <svg ref={svgRef} height={height} width="100%" viewBox={`0 0 ${width} ${height}`}
        onMouseMove={onMove} onMouseLeave={onLeave} role="img" aria-label="Spend and revenue trend">
        <line x1={plot.left} x2={plot.left + plot.width} y1={plot.top + plot.height} y2={plot.top + plot.height}
          stroke="var(--grid)" strokeWidth="1" />
        {lines.map((l) => (
          <path key={`a-${l.key}`} fill={l.color} opacity="0.10"
            d={`${data.map((d, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(d[l.key]).toFixed(1)}`).join(' ')} L${x(data.length - 1)},${plot.top + plot.height} L${x(0)},${plot.top + plot.height} Z`} />
        ))}
        {lines.map((l) => (
          <path key={l.key} fill="none" stroke={l.color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round"
            d={data.map((d, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(d[l.key]).toFixed(1)}`).join(' ')} />
        ))}
        {point && (
          <g pointerEvents="none">
            <line x1={x(hover)} x2={x(hover)} y1={plot.top} y2={plot.top + plot.height} stroke="var(--baseline)" strokeWidth="1" />
            {lines.map((l) => (
              <circle key={l.key} cx={x(hover)} cy={y(point[l.key])} r="4" fill={l.color} stroke="var(--surface-1)" strokeWidth="2" />
            ))}
          </g>
        )}
      </svg>
      {point && (
        <div className="tip" style={{ left: Math.min(Math.max(x(hover) - 70, 0), Math.max(0, width - 150)), top: -6 }}>
          <div className="t-date">{shortDate(point.date)}</div>
          {lines.map((l) => (
            <div className="t-row" key={l.key}>
              <span className="k"><span className="swatch" style={{ background: l.color }} />{l.label}</span>
              <span className="v">{money(point[l.key], currency)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The funnel. One hue for every stage on purpose: bar length already encodes the
 * count, so colouring by value would double-encode it and burn the identity channel.
 */
export function Funnel({ stages, currency = 'USD', onPick, activeKey }) {
  const first = stages[0]?.count ?? 0;
  const max = Math.max(1, ...stages.map((s) => s.count));
  return (
    <div>
      {stages.map((s, i) => {
        const width = (s.count / max) * 100;
        const overall = first ? (s.count / first) * 100 : null;
        const on = activeKey === s.key;
        return (
          <div key={s.key} style={{ padding: '7px 0', cursor: onPick ? 'pointer' : 'default' }}
            onClick={() => onPick?.(s.key)}
            title={onPick ? `Filter leads to ${s.label}` : undefined}>
            <div className="row" style={{ justifyContent: 'space-between', marginBottom: 4, gap: 8 }}>
              <span style={{ fontWeight: on ? 640 : 540, display: 'flex', alignItems: 'center', gap: 6 }}>
                {s.label}
                {s.is_conversion && <span className="badge good"><span className="dot" />conversion</span>}
              </span>
              <span style={{ color: 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums' }}>
                {fmtCount(s.count)}
                {overall != null && i > 0 && <span style={{ color: 'var(--text-muted)' }}> · {overall.toFixed(0)}% of top</span>}
              </span>
            </div>
            <div style={{ height: 14, background: 'var(--surface-2)', borderRadius: 3, overflow: 'hidden' }}>
              <div style={{
                width: `${Math.max(width, s.count ? 1.5 : 0)}%`, height: '100%',
                background: 'var(--series-1)', borderRadius: '0 4px 4px 0',
                opacity: on ? 1 : 0.92,
              }} />
            </div>
            {i > 0 && (
              <div style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 3 }}>
                {s.step_conversion_pct == null
                  ? '— no rate: the stage above is empty'
                  : `${s.step_conversion_pct.toFixed(1)}% of ${stages[i - 1].label} · ${fmtCount(s.drop_off)} dropped`}
                {s.value > 0 && ` · ${money(s.value, currency, { compact: true })}`}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Spend mix: one stacked bar, 2px surface gaps doing the separating. */
export function MixBar({ items, colors, total, currency = 'USD' }) {
  const sum = total ?? items.reduce((n, i) => n + i.value, 0);
  if (!sum) return <div style={{ color: 'var(--text-muted)', fontSize: 12.5 }}>No spend in this period.</div>;
  return (
    <>
      <div style={{ display: 'flex', height: 12, borderRadius: 3, overflow: 'hidden', gap: 2 }}>
        {items.map((it) => (
          <div key={it.id ?? it.label} title={`${it.label}: ${money(it.value, currency)}`}
            style={{ width: `${(it.value / sum) * 100}%`, background: colors.get(it.id) ?? 'var(--text-muted)' }} />
        ))}
      </div>
      <div className="legend" style={{ marginTop: 9 }}>
        {items.map((it) => (
          <span className="item" key={it.id ?? it.label}>
            <span className="swatch" style={{ background: colors.get(it.id) ?? 'var(--text-muted)' }} />
            {it.label}
            <span style={{ color: 'var(--text-muted)' }}>{((it.value / sum) * 100).toFixed(0)}%</span>
          </span>
        ))}
      </div>
    </>
  );
}

/**
 * Running totals. Daily revenue is lumpy — one deal can be twenty times a day's spend —
 * which squashes the spend line into the axis and hides the thing you came to see.
 * Cumulative keeps both series legible and answers the actual question: across this
 * period, has what came back passed what went out?
 */
export function toCumulative(data, keys = ['spend', 'revenue']) {
  const running = Object.fromEntries(keys.map((k) => [k, 0]));
  return data.map((d) => {
    const row = { ...d };
    for (const k of keys) { running[k] += Number(d[k]) || 0; row[k] = Math.round(running[k] * 100) / 100; }
    return row;
  });
}

export { niceTicks };

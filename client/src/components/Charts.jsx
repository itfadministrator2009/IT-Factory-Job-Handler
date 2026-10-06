import { useEffect, useRef, useState } from 'react';

// Small, dependency-free charts (SVG + HTML) for report pages: a donut, horizontal
// bars (plain or stacked) and a column chart. Every mark has a hover tooltip and
// can link somewhere; values are always written next to the colour so nothing is
// read from colour alone.
//
// Colours: a colour-blind-checked categorical set, used in this fixed order —
// never cycled. Lighter slots (aqua, yellow, magenta) always carry a text label.
export const CHART_COLORS = {
  blue: '#2a78d6',
  orange: '#eb6834',
  aqua: '#1baf7a',
  yellow: '#eda100',
  magenta: '#e87ba4',
  green: '#008300',
  violet: '#4a3aa7',
  red: '#e34948',
  neutral: '#c9c7bd', // "not set" / "other" — deliberately not a series colour
};
export const SERIES = [CHART_COLORS.blue, CHART_COLORS.orange, CHART_COLORS.aqua, CHART_COLORS.yellow, CHART_COLORS.magenta, CHART_COLORS.green, CHART_COLORS.violet, CHART_COLORS.red];

const INK = '#16241f';
const MUTED = '#6b7570';
const GRID = '#e8e6df';
const SURFACE = '#ffffff';
const fmt = (n) => Number(n || 0).toLocaleString('en-AU');
const pct = (n, total) => (total ? `${Math.round((n / total) * 1000) / 10}%` : '0%');

// Tooltip that follows the pointer.
function useTip() {
  const [tip, setTip] = useState(null);
  const show = (e, content) => setTip({ x: e.clientX, y: e.clientY, content });
  const hide = () => setTip(null);
  const node = tip && (
    <div role="tooltip" style={{
      position: 'fixed', left: tip.x + 14, top: tip.y + 14, zIndex: 2000, pointerEvents: 'none',
      background: '#16241f', color: '#fff', fontSize: 12, lineHeight: 1.45, padding: '7px 10px', borderRadius: 6,
      boxShadow: '0 4px 14px rgba(0,0,0,0.18)', maxWidth: 260,
    }}>{tip.content}</div>
  );
  return { show, hide, node };
}

// ---------------------------------------------------------------------------
// Donut — part of a whole (keep it to a handful of slices).
// data: [{ label, value, color, to? }]
// ---------------------------------------------------------------------------
export function Donut({ data, centerValue, centerLabel, size = 190, onSelect, navigate }) {
  const tip = useTip();
  const [hover, setHover] = useState(null);
  const rows = data.filter((d) => d.value > 0);
  const total = rows.reduce((t, d) => t + d.value, 0);
  const r = size / 2; const stroke = size * 0.17; const rad = r - stroke / 2 - 4;
  const C = 2 * Math.PI * rad;
  const gap = rows.length > 1 ? 2 : 0; // 2px surface gap between slices
  let offset = 0;
  const click = (d) => (onSelect ? onSelect(d) : d.to && navigate?.(d.to));

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 22, flexWrap: 'wrap' }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={rows.map((d) => `${d.label}: ${fmt(d.value)}`).join(', ')} style={{ flex: 'none' }}>
        <circle cx={r} cy={r} r={rad} fill="none" stroke={GRID} strokeWidth={stroke} />
        {total > 0 && rows.map((d, i) => {
          const len = (d.value / total) * C;
          const dash = Math.max(0, len - gap);
          const el = (
            <circle key={d.label} cx={r} cy={r} r={rad} fill="none" stroke={d.color}
              strokeWidth={hover === i ? stroke + 6 : stroke}
              strokeDasharray={`${dash} ${C - dash}`} strokeDashoffset={-offset}
              transform={`rotate(-90 ${r} ${r})`}
              style={{ cursor: d.to || onSelect ? 'pointer' : 'default', transition: 'stroke-width 120ms' }}
              onMouseMove={(e) => { setHover(i); tip.show(e, <><strong>{d.label}</strong><br />{fmt(d.value)} · {pct(d.value, total)}</>); }}
              onMouseLeave={() => { setHover(null); tip.hide(); }}
              onClick={() => click(d)} />
          );
          offset += len;
          return el;
        })}
        <text pointerEvents="none" x={r} y={r - 2} textAnchor="middle" fontSize={size * 0.15} fontWeight="700" fill={INK}>{fmt(centerValue ?? total)}</text>
        <text pointerEvents="none" x={r} y={r + size * 0.1} textAnchor="middle" fontSize={11} fill={MUTED}>{centerLabel}</text>
      </svg>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0, flex: 1, minWidth: 160, fontSize: 13 }}>
        {data.map((d, i) => (
          <li key={d.label}
            onMouseEnter={() => setHover(rows.indexOf(d))} onMouseLeave={() => setHover(null)}
            onClick={() => d.value > 0 && click(d)}
            style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 6px', borderRadius: 6, cursor: d.value > 0 && (d.to || onSelect) ? 'pointer' : 'default', background: hover === rows.indexOf(d) && d.value > 0 ? '#f4f3ef' : 'transparent', opacity: d.value > 0 ? 1 : 0.5 }}>
            <span style={{ width: 11, height: 11, borderRadius: 3, background: d.color, flex: 'none' }} />
            <span style={{ flex: 1, color: INK }}>{d.label}</span>
            <span style={{ fontWeight: 600, color: INK, fontVariantNumeric: 'tabular-nums' }}>{fmt(d.value)}</span>
            <span style={{ width: 48, textAlign: 'right', color: MUTED, fontVariantNumeric: 'tabular-nums' }}>{pct(d.value, total)}</span>
          </li>
        ))}
      </ul>
      {tip.node}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Horizontal bars — compare categories. Plain: [{ label, value, to? }] with one
// colour. Stacked: give `segments` ([{ key, label, color }]) and each row
// `parts: { [key]: n }`; a legend is drawn above.
// ---------------------------------------------------------------------------
export function BarList({ data, color = CHART_COLORS.blue, segments, onSelect, navigate, emptyText = 'No data yet.', labelWidth = 150 }) {
  const tip = useTip();
  if (!data.length) return <p style={{ fontSize: 13, color: MUTED }}>{emptyText}</p>;
  const max = Math.max(...data.map((d) => d.value), 1);
  const click = (d) => (onSelect ? onSelect(d) : d.to && navigate?.(d.to));

  return (
    <div>
      {segments && (
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 12, color: MUTED, marginBottom: 10 }}>
          {segments.map((s) => (
            <span key={s.key} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <span style={{ width: 10, height: 10, borderRadius: 3, background: s.color }} />{s.label}
            </span>
          ))}
        </div>
      )}
      <div style={{ display: 'grid', gap: 7 }}>
        {data.map((d) => (
          <div key={d.label} style={{ display: 'grid', gridTemplateColumns: `${labelWidth}px 1fr 52px`, alignItems: 'center', gap: 10, fontSize: 13 }}>
            <span title={d.label} style={{ color: INK, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: d.to || onSelect ? 'pointer' : 'default' }} onClick={() => click(d)}>{d.label}</span>
            <div style={{ display: 'flex', gap: 2, height: 16, width: `${Math.max((d.value / max) * 100, 0.5)}%`, cursor: d.to || onSelect ? 'pointer' : 'default' }}
              onClick={() => click(d)}>
              {(segments ? segments.map((s) => ({ ...s, n: d.parts?.[s.key] || 0 })).filter((s) => s.n > 0) : [{ key: 'v', label: d.label, color, n: d.value }]).map((s, i, arr) => (
                <div key={s.key}
                  onMouseMove={(e) => tip.show(e, <><strong>{d.label}</strong>{segments ? <> — {s.label}</> : null}<br />{fmt(s.n)}{segments ? ` of ${fmt(d.value)} (${pct(s.n, d.value)})` : ''}</>)}
                  onMouseLeave={tip.hide}
                  style={{
                    flex: `${s.n} 0 0`, minWidth: 3, background: s.color, height: '100%',
                    borderRadius: `${i === 0 ? 4 : 0}px ${i === arr.length - 1 ? 4 : 0}px ${i === arr.length - 1 ? 4 : 0}px ${i === 0 ? 4 : 0}px`,
                  }} />
              ))}
            </div>
            <span style={{ textAlign: 'right', fontWeight: 600, color: INK, fontVariantNumeric: 'tabular-nums' }}>{fmt(d.value)}</span>
          </div>
        ))}
      </div>
      {tip.node}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Columns — a value over time. data: [{ label, short?, value, to? }]
// ---------------------------------------------------------------------------
// Width of an element in real pixels, so chart text stays the same size at any width.
function useWidth() {
  const ref = useRef(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    if (!ref.current) return undefined;
    const ro = new ResizeObserver(([e]) => setW(Math.round(e.contentRect.width)));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

export function ColumnChart({ data, color = CHART_COLORS.blue, height = 200, onSelect, navigate }) {
  const tip = useTip();
  const [hover, setHover] = useState(null);
  const [boxRef, boxW] = useWidth();
  if (!data.length) return <p style={{ fontSize: 13, color: MUTED }}>No data yet.</p>;
  const max = Math.max(...data.map((d) => d.value), 1);
  // A tidy axis top: 1, 2 or 5 × a power of ten.
  const mag = 10 ** Math.floor(Math.log10(max));
  const top = [1, 2, 5, 10].map((m) => m * mag).find((v) => v >= max) || max;
  // Counts are whole numbers — only show a middle gridline when it is one.
  const ticks = Number.isInteger(top / 2) ? [0, top / 2, top] : [0, top];
  const W = boxW || 600; const padL = 34; const padB = 26; const padT = 18;
  const plotW = W - padL - 8; const plotH = height - padB - padT;
  const slot = plotW / data.length; const barW = Math.min(44, slot * 0.62);
  const click = (d) => (onSelect ? onSelect(d) : d.to && navigate?.(d.to));
  const showValue = data.length <= 16;

  return (
    <div ref={boxRef} style={{ width: '100%' }}>
      <svg viewBox={`0 0 ${W} ${height}`} width={W} height={height} role="img" aria-label={data.map((d) => `${d.label}: ${fmt(d.value)}`).join(', ')} style={{ display: 'block' }}>
        {ticks.map((t) => {
          const y = padT + plotH - (t / top) * plotH;
          return (
            <g key={t}>
              <line x1={padL} x2={W - 8} y1={y} y2={y} stroke={GRID} strokeWidth={1} />
              <text x={padL - 6} y={y + 4} textAnchor="end" fontSize={11} fill={MUTED}>{fmt(t)}</text>
            </g>
          );
        })}
        {data.map((d, i) => {
          const h = (d.value / top) * plotH;
          const x = padL + i * slot + (slot - barW) / 2;
          const y = padT + plotH - h;
          const rr = Math.min(4, h / 2, barW / 2);
          return (
            <g key={d.label} style={{ cursor: d.to || onSelect ? 'pointer' : 'default' }}
              onMouseMove={(e) => { setHover(i); tip.show(e, <><strong>{d.label}</strong><br />{fmt(d.value)} asset{d.value === 1 ? '' : 's'}</>); }}
              onMouseLeave={() => { setHover(null); tip.hide(); }}
              onClick={() => d.value && click(d)}>
              {/* Bigger invisible hit target than the bar itself */}
              <rect x={padL + i * slot} y={padT} width={slot} height={plotH} fill={hover === i ? 'rgba(0,0,0,0.035)' : 'transparent'} />
              {h > 0 && <path d={`M${x},${y + h} V${y + rr} Q${x},${y} ${x + rr},${y} H${x + barW - rr} Q${x + barW},${y} ${x + barW},${y + rr} V${y + h} Z`} fill={color} />}
              {showValue && d.value > 0 && <text x={x + barW / 2} y={y - 5} textAnchor="middle" fontSize={11} fontWeight="600" fill={INK}>{fmt(d.value)}</text>}
              <text x={padL + i * slot + slot / 2} y={height - 8} textAnchor="middle" fontSize={11} fill={MUTED}>{slot < 46 ? (d.short || d.label).split(" ")[0] : (d.short || d.label)}</text>
            </g>
          );
        })}
        <line x1={padL} x2={W - 8} y1={padT + plotH} y2={padT + plotH} stroke="#c9c7bd" strokeWidth={1} />
      </svg>
      {tip.node}
    </div>
  );
}

export function StatTile({ label, value, sub, accent = CHART_COLORS.blue, onClick }) {
  return (
    <div onClick={onClick} role={onClick ? 'button' : undefined}
      style={{ background: SURFACE, border: '1px solid #e2e0d8', borderRadius: 12, padding: '14px 16px', borderTop: `4px solid ${accent}`, cursor: onClick ? 'pointer' : 'default', minWidth: 0 }}>
      <div style={{ fontSize: 12, color: MUTED, textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 28, fontWeight: 700, color: INK, lineHeight: 1.1, fontVariantNumeric: 'tabular-nums' }}>{fmt(value)}</div>
      {sub && <div style={{ fontSize: 12, color: MUTED, marginTop: 4 }}>{sub}</div>}
    </div>
  );
}

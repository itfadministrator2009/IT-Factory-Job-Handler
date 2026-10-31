import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus, ShoppingBag } from 'lucide-react';
import api from '../api';
import Layout from '../components/Layout';
import { CHART_COLORS } from '../components/Charts';
import useSalesData from '../sales/useSalesData';
import { fmt, fmtInt, pct, auDate, num, toISODate, platformClass } from '../sales/calc';

// ITF Sales Manager dashboard — the old app's Dashboard tab.
export default function SalesDashboard() {
  const { sales, calc, loading, error } = useSalesData({ sales: true });
  const [pending, setPending] = useState(0);
  useEffect(() => { api.get('/sales/shopify/pending').then((r) => setPending(r.data.orders.length)).catch(() => {}); }, []);

  const t = useMemo(() => calc.totals(sales || []), [sales, calc]);
  const platforms = useMemo(() => {
    const p = {};
    (sales || []).forEach((e) => { const k = e.platform || 'Other'; p[k] = (p[k] || 0) + num(e.sellprice); });
    return Object.entries(p).sort((a, b) => b[1] - a[1]);
  }, [sales]);
  const months = useMemo(() => {
    const now = new Date();
    return Array.from({ length: 12 }, (_, k) => {
      const i = 11 - k;
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const s = toISODate(d);
      const e = toISODate(new Date(d.getFullYear(), d.getMonth() + 1, 0));
      const list = (sales || []).filter((x) => x.selldate && x.selldate >= s && x.selldate <= e);
      return { label: d.toLocaleDateString('en-AU', { month: 'short' }), year: d.getFullYear(), net: list.reduce((a, x) => a + calc.net(x), 0), count: list.length };
    });
  }, [sales, calc]);
  const recent = useMemo(() => [...(sales || [])].sort((a, b) => String(b.selldate || '').localeCompare(String(a.selldate || ''))).slice(0, 15), [sales]);

  // Where each dollar of revenue went.
  const breakdown = [
    { label: 'Product cost', value: t.cost, color: CHART_COLORS.yellow },
    { label: 'Postage', value: t.postage, color: CHART_COLORS.blue },
    { label: 'Platform fees', value: t.fees, color: CHART_COLORS.red },
    { label: 'Pack / handle', value: t.packhandle, color: CHART_COLORS.violet },
    { label: 'Labour', value: t.labour, color: '#64748b' },
    { label: 'Google Ads', value: t.ads, color: CHART_COLORS.magenta },
    { label: 'Net profit', value: t.net, color: '#0f4e45' },
  ];

  return (
    <Layout>
      <div className="page-header">
        <div>
          <h1>Sales Manager</h1>
          <div className="subtitle">Sales, inventory and Shopify orders for IT Factory Australia.</div>
        </div>
        <Link to="/sales/add" className="btn btn-accent"><Plus size={16} /> Add a sale</Link>
      </div>
      {error && <div className="error-banner">{error}</div>}
      {pending > 0 && (
        <Link to="/sales/shopify" className="panel attention-box" style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16, textDecoration: 'none', color: 'inherit' }}>
          <ShoppingBag size={18} /> <span><strong>{pending}</strong> Shopify order line{pending === 1 ? '' : 's'} waiting for review — open Shopify Orders</span>
        </Link>
      )}
      {loading ? <div className="panel panel-pad">Loading…</div> : (
        <>
          <div className="stat-grid stat-grid-7">
            <StatCard accent="accent-ink" value={fmtInt(t.count)} label="Items sold" to="/sales/all" />
            <StatCard accent="accent-blue" value={fmt(t.revenue)} label="Total revenue" to="/sales/reports" />
            <StatCard accent="accent-yellow" value={fmt(t.cost)} label="Product cost" />
            <StatCard accent="accent-orange" value={fmt(t.postageFees)} label="Postage + fees" />
            <StatCard accent="accent-neutral" value={fmt(t.other)} label="Pack / labour / ads" />
            <StatCard accent="accent-green" value={fmt(t.net)} label="Net profit" />
            <StatCard accent="accent-aqua" value={pct(t.avgMargin)} label="Avg. margin" />
          </div>

          <div className="sales-dash-grid">
            <div className="panel panel-pad">
              <h3 className="sales-form-h">Net profit — last 12 months</h3>
              <TrendChart months={months} />
            </div>
            <div className="panel panel-pad">
              <h3 className="sales-form-h">Where the revenue goes</h3>
              <MoneyBars rows={breakdown} total={t.revenue} />
            </div>
            <div className="panel panel-pad">
              <h3 className="sales-form-h">Sales by platform</h3>
              <MoneyBars rows={platforms.map(([label, value]) => ({ label, value, color: CHART_COLORS.blue }))} total={platforms.reduce((a, [, v]) => a + v, 0)} />
            </div>
            <div className="panel panel-pad">
              <h3 className="sales-form-h">Recent sales</h3>
              {recent.length === 0 ? <div className="muted">Nothing logged yet — add your first sale to see it here.</div> : (
                <div className="sales-recent">
                  {recent.map((e) => {
                    const n = calc.net(e);
                    return (
                      <Link key={e.id} to={`/sales/edit/${e.id}`} className="sales-recent-row">
                        <span className="mono sku">{e.sku || '—'}</span>
                        <span className="mid"><span className="item">{e.make} {e.model || 'Unnamed item'}</span>
                          <span className="meta"><span className={`plat-badge ${platformClass(e.platform)}`}>{e.platform}</span> {e.selldate ? auDate(e.selldate) : ''} {e.customer ? `· ${e.customer}` : ''}</span></span>
                        <span className={`amt ${n < 0 ? 'neg' : 'pos'}`}>{fmt(n)}</span>
                      </Link>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </Layout>
  );
}

function StatCard({ accent, value, label, to }) {
  const inner = <><div className="num">{value}</div><div className="label">{label}</div></>;
  return to ? <Link to={to} className={`stat-card ${accent}`}>{inner}</Link> : <div className={`stat-card ${accent}`}>{inner}</div>;
}

// Horizontal bars with $ amounts and % of the total.
function MoneyBars({ rows, total }) {
  if (!rows.length || !total) return <div className="muted">No sales yet.</div>;
  const max = Math.max(...rows.map((r) => Math.abs(r.value)), 1);
  return (
    <div className="money-bars">
      {rows.map((r) => (
        <div key={r.label} className="money-bar" title={`${r.label}: ${fmt(r.value)} (${total ? Math.round((r.value / total) * 1000) / 10 : 0}%)`}>
          <span className="lbl">{r.label}</span>
          <span className="track"><span className="fill" style={{ width: `${(Math.max(r.value, 0) / max) * 100}%`, background: r.value < 0 ? CHART_COLORS.red : r.color }} /></span>
          <span className="val">{fmt(r.value)}</span>
          <span className="pc">{total ? `${Math.round((r.value / total) * 1000) / 10}%` : ''}</span>
        </div>
      ))}
    </div>
  );
}

// Monthly net profit line, with a zero line; hover a point for the month's figures.
function TrendChart({ months }) {
  const [hover, setHover] = useState(null);
  const W = 640; const H = 220; const L = 64; const R = 14; const T = 14; const B = 28;
  const vals = months.map((m) => m.net);
  const max = Math.max(...vals, 0);
  const min = Math.min(...vals, 0);
  const range = max - min || 1;
  const x = (i) => L + (i * (W - L - R)) / (months.length - 1);
  const y = (v) => T + (H - T - B) - ((v - min) / range) * (H - T - B);
  const line = months.map((m, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(m.net).toFixed(1)}`).join(' ');
  const area = `${line} L${x(months.length - 1).toFixed(1)} ${y(0).toFixed(1)} L${x(0).toFixed(1)} ${y(0).toFixed(1)} Z`;
  const short = (v) => `${v < 0 ? '-' : ''}$${Math.abs(v) >= 1000 ? `${Math.round(Math.abs(v) / 100) / 10}k` : Math.round(Math.abs(v))}`;
  return (
    <div style={{ position: 'relative' }}>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block' }} role="img" aria-label="Net profit by month for the last 12 months">
        {[max, 0, min].filter((v, i, a) => a.indexOf(v) === i).map((v) => (
          <g key={v}><line x1={L} x2={W - R} y1={y(v)} y2={y(v)} stroke="#e8e6df" />
            <text x={L - 8} y={y(v) + 4} fontSize="11" fill="#6b7570" textAnchor="end">{short(v)}</text></g>
        ))}
        <path d={area} fill="rgba(21,94,107,0.08)" />
        <path d={line} fill="none" stroke="#155e6b" strokeWidth="2" />
        {months.map((m, i) => (
          <g key={m.label + m.year} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
            <rect x={x(i) - 22} y={T} width={44} height={H - T - B} fill="transparent" />
            <circle cx={x(i)} cy={y(m.net)} r={hover === i ? 5 : 3.5} fill={m.net < 0 ? '#c23f1c' : '#155e6b'} stroke="#fff" strokeWidth="1.5" />
            <text x={x(i)} y={H - 8} fontSize="11" fill="#6b7570" textAnchor="middle">{m.label}</text>
          </g>
        ))}
      </svg>
      {hover != null && (
        <div className="chart-tip" style={{ left: `${(x(hover) / W) * 100}%` }}>
          <b>{months[hover].label} {months[hover].year}</b><br />Net {fmt(months[hover].net)} · {fmtInt(months[hover].count)} sale{months[hover].count === 1 ? '' : 's'}
        </div>
      )}
    </div>
  );
}

import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Search, Printer, Download } from 'lucide-react';
import Layout from '../components/Layout';
import useSalesData from '../sales/useSalesData';
import {
  fmt, fmtInt, pct, auDate, periodRange, weeksIn, last52Weeks, matches, sortItems, num, exportSales, downloadCSV, printTable,
} from '../sales/calc';

const PERIODS = [
  ['week', 'Last week'], ['month', 'Last month'], ['quarter', 'Last quarter'], ['year', 'Last year'],
  ['fy', 'Last financial year'], ['all', 'All time'], ['custom', 'Custom range'], ['weekly52', 'Last 52 weeks'],
];
const inRange = (e, r) => !r || (e.selldate && e.selldate >= r.startISO && e.selldate <= r.endISO);

// Reports — totals for a period, the sales in it, and weekly breakdowns.
export default function SalesReports() {
  const { sales, calc, loading, error } = useSalesData({ sales: true });
  const [period, setPeriod] = useState('month');
  const [custom, setCustom] = useState({ start: '', end: '' });
  const [q, setQ] = useState('');
  const [sort, setSort] = useState({ col: 'selldate', dir: 'desc' });

  const range = useMemo(() => (period === 'weekly52' ? null : periodRange(period, custom)), [period, custom]);
  const list = useMemo(() => (sales || []).filter((e) => inRange(e, range)), [sales, range]);
  const t = useMemo(() => calc.totals(list), [list, calc]);
  const shown = useMemo(() => {
    const ql = q.trim().toLowerCase();
    const f = list.filter((e) => matches(e, ql, 'all', ['itemtype', 'platform']));
    return sortItems(f, sort.col, sort.dir, (e, c) => {
      if (c === 'net') return calc.net(e);
      if (c === 'margin') return calc.margin(e);
      if (c === 'sellprice' || c === 'cost') return num(e[c]);
      return String(e[c] || '').toLowerCase();
    });
  }, [list, q, sort, calc]);

  const weekRows = (weeks) => weeks.map((w) => {
    const wl = (sales || []).filter((e) => inRange(e, w));
    return { ...w, ...calc.totals(wl) };
  });
  const weekly = useMemo(() => {
    if (period === 'weekly52') return weekRows(last52Weeks());
    if (period === 'custom' && range) return weekRows(weeksIn(range));
    return null;
  }, [period, range, sales, calc]);

  const label = PERIODS.find(([k]) => k === period)?.[1];
  const sub = range ? `${auDate(range.startISO)} – ${auDate(range.endISO)}` : period === 'weekly52' ? 'Last 52 weeks (Mon–Sun)' : 'All time';
  const stats = [['Items sold', fmtInt(t.count)], ['Revenue', fmt(t.revenue)], ['Product cost', fmt(t.cost)], ['Postage + fees', fmt(t.postageFees)],
    ['Pack / labour / ads', fmt(t.other)], ['Net profit', fmt(t.net)], ['Avg. margin', pct(t.avgMargin)]];

  const weekCols = [{ label: 'Week' }, { label: 'Sold', num: true }, { label: 'Revenue', num: true }, { label: 'Cost', num: true }, { label: 'Postage + fees', num: true }, { label: 'Pack / labour / ads', num: true }, { label: 'Net profit', num: true }, { label: 'Avg. margin', num: true }];
  const weekCells = (w) => [`${auDate(w.startISO)} – ${auDate(w.endISO)}`, fmtInt(w.count), fmt(w.revenue), fmt(w.cost), fmt(w.postageFees), fmt(w.other), fmt(w.net), pct(w.avgMargin)];
  const saleCols = [{ label: 'Sell date' }, { label: 'SKU' }, { label: 'Item' }, { label: 'Make / model' }, { label: 'Platform' }, { label: 'Customer' }, { label: 'Sell price', num: true }, { label: 'Cost', num: true }, { label: 'Net', num: true }, { label: 'Margin', num: true }];
  const saleCells = (e) => [auDate(e.selldate), e.sku, e.itemtype, `${e.make || ''} ${e.model || ''}`.trim(), e.platform, e.customer, fmt(num(e.sellprice)), fmt(num(e.cost)), fmt(calc.net(e)), pct(calc.margin(e))];

  const doPrint = () => {
    if (weekly) printTable(`Sales report — ${label}`, sub, weekCols, weekly.map(weekCells), { stats });
    else printTable(`Sales report — ${label}`, sub, saleCols, shown.map(saleCells), { stats, footer: ['Total', '', '', '', '', '', fmt(t.revenue), fmt(t.cost), fmt(t.net), pct(t.avgMargin)] });
  };
  const doCSV = () => {
    const name = `sales-report-${period}.csv`;
    if (weekly) downloadCSV(weekCols.map((c) => c.label), weekly.map(weekCells), name);
    else exportSales(shown, calc, name);
  };
  const th = (col, text, isNum) => (
    <th key={col} className={`${isNum ? 'num' : ''} sortable`}
      onClick={() => setSort((s) => (s.col === col ? { col, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { col, dir: isNum ? 'desc' : 'asc' }))}>
      {text}{sort.col === col ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ''}</th>
  );

  return (
    <Layout>
      <div className="page-header">
        <div><h1>Reports</h1><div className="subtitle">{label} · {sub}</div></div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" className="btn btn-ghost btn-sm" onClick={doCSV}><Download size={14} /> CSV</button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={doPrint}><Printer size={14} /> Print</button>
        </div>
      </div>
      {error && <div className="error-banner">{error}</div>}
      <div className="period-tabs">
        {PERIODS.map(([k, l]) => (
          <button key={k} type="button" className={`btn btn-sm ${period === k ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setPeriod(k)}>{l}</button>
        ))}
      </div>
      {period === 'custom' && (
        <div className="filters">
          <label className="inline-field">From <input placeholder="dd/mm/yyyy" value={custom.start} onChange={(e) => setCustom((c) => ({ ...c, start: e.target.value }))} /></label>
          <label className="inline-field">To <input placeholder="dd/mm/yyyy" value={custom.end} onChange={(e) => setCustom((c) => ({ ...c, end: e.target.value }))} /></label>
          <span className="muted">Leave “To” empty for up to today.</span>
        </div>
      )}
      {loading ? <div className="panel panel-pad">Loading…</div> : (
        <>
          {period !== 'weekly52' && (
            <div className="stat-grid stat-grid-7">
              {stats.map(([k, v], i) => (
                <div key={k} className={`stat-card ${['accent-ink', 'accent-blue', 'accent-yellow', 'accent-orange', 'accent-neutral', 'accent-green', 'accent-aqua'][i]}`}>
                  <div className="num">{v}</div><div className="label">{k}</div>
                </div>
              ))}
            </div>
          )}
          {weekly && (
            <div className="panel sales-table-wrap" style={{ marginBottom: 16 }}>
              <table className="ticket-table">
                <thead><tr>{weekCols.map((c) => <th key={c.label} className={c.num ? 'num' : ''}>{c.label}</th>)}</tr></thead>
                <tbody>
                  {weekly.map((w) => (
                    <tr key={w.startISO} className={w.count ? '' : 'muted-row'}>
                      <td className="nowrap">{auDate(w.startISO)} – {auDate(w.endISO)}</td><td className="num">{fmtInt(w.count)}</td>
                      <td className="num">{fmt(w.revenue)}</td><td className="num">{fmt(w.cost)}</td><td className="num">{fmt(w.postageFees)}</td>
                      <td className="num">{fmt(w.other)}</td><td className={`num ${w.net < 0 ? 'neg' : 'pos'}`}>{fmt(w.net)}</td><td className="num">{pct(w.avgMargin)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {period !== 'weekly52' && (
            <>
              <div className="filters">
                <div className="search-input" style={{ flex: '1 1 260px' }}><Search size={15} /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search sales in this period…" /></div>
                <span className="muted">{fmtInt(shown.length)} sale{shown.length === 1 ? '' : 's'}</span>
              </div>
              <div className="panel sales-table-wrap">
                <table className="ticket-table">
                  <thead><tr>
                    {th('selldate', 'Sell date')}{th('sku', 'SKU')}{th('itemtype', 'Item')}{th('model', 'Make / model')}{th('platform', 'Platform')}
                    {th('customer', 'Customer')}{th('sellprice', 'Sell price', true)}{th('cost', 'Cost', true)}{th('net', 'Net', true)}{th('margin', 'Margin', true)}
                  </tr></thead>
                  <tbody>
                    {shown.slice(0, 1000).map((e) => {
                      const n = calc.net(e);
                      return (
                        <tr key={e.id}>
                          <td className="nowrap">{auDate(e.selldate)}</td>
                          <td className="mono"><Link to={`/sales/edit/${e.id}`}>{e.sku || '—'}</Link></td>
                          <td>{e.itemtype}</td><td>{e.make} {e.model}</td><td>{e.platform}</td><td>{e.customer}</td>
                          <td className="num">{fmt(num(e.sellprice))}</td><td className="num">{fmt(num(e.cost))}</td>
                          <td className={`num ${n < 0 ? 'neg' : 'pos'}`}>{fmt(n)}</td><td className="num">{pct(calc.margin(e))}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {!shown.length && <div className="empty-state" style={{ padding: 30 }}>No sales in this period.</div>}
                {shown.length > 1000 && <div className="muted" style={{ padding: 12 }}>Showing the first 1,000 — use CSV for the full list.</div>}
              </div>
            </>
          )}
        </>
      )}
    </Layout>
  );
}

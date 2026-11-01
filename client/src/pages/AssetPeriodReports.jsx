import { useEffect, useMemo, useState } from 'react';
import { Download, Printer } from 'lucide-react';
import Layout from '../components/Layout';
import api from '../api';
import { StatTile, CHART_COLORS as C } from '../components/Charts';

// ITF Asset Tracker → Reports: pick a period (yesterday, last week, last month,
// last quarter, last year, last financial year or your own dates) and see the
// assets added in it — the total, and broken down by where they were sent, asset
// class, customer, technician, buyer, location and status (sold). Dates are
// Sydney dates; imported assets count on their original date.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const iso = (d) => d.toISOString().slice(0, 10);
const day = (y, m, d) => new Date(Date.UTC(y, m, d)); // m is 0-11; overflow rolls over
const nice = (s) => { const [y, m, d] = s.split('-').map(Number); return `${d} ${MONTHS[m - 1]} ${y}`; };

// Today in Sydney, as a UTC-midnight date.
function sydneyToday() {
  const [y, m, d] = new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date()).split('-').map(Number);
  return day(y, m - 1, d);
}

// The periods, worked out from today (Sydney).
function periodRange(key) {
  const t = sydneyToday();
  const y = t.getUTCFullYear(); const m = t.getUTCMonth(); const d = t.getUTCDate();
  switch (key) {
    case 'yesterday': return [day(y, m, d - 1), day(y, m, d - 1)];
    case 'week': { // last full week, Monday–Sunday
      const sinceMonday = (t.getUTCDay() + 6) % 7;
      return [day(y, m, d - sinceMonday - 7), day(y, m, d - sinceMonday - 1)];
    }
    case 'month': return [day(y, m - 1, 1), day(y, m, 0)];
    case 'quarter': { const q = Math.floor(m / 3); return [day(y, (q - 1) * 3, 1), day(y, q * 3, 0)]; }
    case 'year': return [day(y - 1, 0, 1), day(y - 1, 11, 31)];
    case 'fy': { // Australian financial year, 1 July – 30 June
      const startYear = m >= 6 ? y - 1 : y - 2;
      return [day(startYear, 6, 1), day(startYear + 1, 5, 30)];
    }
    default: return null;
  }
}

const PERIODS = [
  { key: 'yesterday', label: 'Yesterday' },
  { key: 'week', label: 'Last week' },
  { key: 'month', label: 'Last month' },
  { key: 'quarter', label: 'Last quarter' },
  { key: 'year', label: 'Last year' },
  { key: 'fy', label: 'Last financial year' },
  { key: 'custom', label: 'Custom dates' },
];

const SECTIONS = [
  { key: 'bySentTo', title: 'Where assets were sent', color: C.blue },
  { key: 'byClass', title: 'By asset class', color: C.aqua },
  { key: 'byCustomer', title: 'By customer', color: C.violet },
  { key: 'byTechnician', title: 'By technician', color: C.orange },
  { key: 'byBuyer', title: 'By buyer', color: C.magenta },
  { key: 'byLocation', title: 'By location', color: C.green },
  { key: 'byStatus', title: 'By status (sold / available)', color: C.yellow },
  { key: 'soldByCustomer', title: 'Sold — by customer', color: C.orange },
  { key: 'soldByBuyer', title: 'Sold — by buyer', color: C.magenta },
];

const fmt = (n) => Number(n || 0).toLocaleString('en-AU');
const pct = (n, of) => (of ? `${Math.round((n / of) * 1000) / 10}%` : '—');

// One breakdown: label, a bar, the count and its share. The top 10 show; the rest open with "Show all".
function Breakdown({ title, rows, total, color }) {
  const [all, setAll] = useState(false);
  const max = Math.max(1, ...rows.map((r) => r.count));
  const shown = all ? rows : rows.slice(0, 10);
  return (
    <section className="panel report-card" style={{ padding: 18, minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 12 }}>
        <h3 style={{ fontSize: 15, flex: 1 }}>{title}</h3>
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>{rows.length} {rows.length === 1 ? 'entry' : 'entries'}</span>
      </div>
      {!rows.length ? <div className="muted" style={{ fontSize: 13 }}>Nothing in this period.</div> : (
        <table className="report-table">
          <tbody>
            {shown.map((r) => (
              <tr key={r.label}>
                <td className="report-label" title={r.label} style={r.label === 'Not set' ? { color: 'var(--muted)', fontStyle: 'italic' } : undefined}>{r.label}</td>
                <td className="report-bar"><span style={{ width: `${Math.max((r.count / max) * 100, 1.5)}%`, background: color }} /></td>
                <td className="num">{fmt(r.count)}</td>
                <td className="num muted">{pct(r.count, total)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {rows.length > 10 && (
        <button type="button" className="btn btn-ghost btn-sm report-more" style={{ marginTop: 10 }} onClick={() => setAll((v) => !v)}>
          {all ? 'Show top 10' : `Show all ${rows.length}`}
        </button>
      )}
    </section>
  );
}

function csvCell(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export default function AssetPeriodReports() {
  const [period, setPeriod] = useState('month');
  const [custom, setCustom] = useState(() => { const r = periodRange('month'); return { from: iso(r[0]), to: iso(r[1]) }; });
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const range = useMemo(() => {
    if (period === 'custom') return custom.from && custom.to ? custom : null;
    const r = periodRange(period);
    return { from: iso(r[0]), to: iso(r[1]) };
  }, [period, custom]);

  useEffect(() => {
    if (!range) return;
    if (range.to < range.from) { setError('The end date is before the start date.'); setData(null); return; }
    let stale = false;
    setLoading(true);
    setError('');
    api.get('/assets/period-report', { params: range })
      .then((r) => { if (!stale) setData(r.data); })
      .catch((err) => { if (!stale) { setData(null); setError(err.response?.data?.error || 'Could not load the report'); } })
      .finally(() => { if (!stale) setLoading(false); });
    return () => { stale = true; };
  }, [range]);

  const periodText = range ? (range.from === range.to ? nice(range.from) : `${nice(range.from)} – ${nice(range.to)}`) : '';
  const count = (key, label) => data?.[key]?.find((r) => r.label.toLowerCase() === label)?.count || 0;

  function downloadCsv() {
    if (!data) return;
    const lines = [['ITF Asset Tracker report', periodText], [], ['Total assets added', data.total], ['Sold', data.sold], []];
    SECTIONS.forEach((s) => {
      lines.push([s.title, 'Count', 'Share']);
      (data[s.key] || []).forEach((r) => lines.push([r.label, r.count, pct(r.count, s.key.startsWith('sold') ? data.sold : data.total)]));
      lines.push([]);
    });
    const blob = new Blob([`﻿${lines.map((l) => l.map(csvCell).join(',')).join('\r\n')}`], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `asset-report-${range.from}-to-${range.to}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  return (
    <Layout>
      <div className="page-header">
        <div>
          <h1>Asset Tracker reports</h1>
          <div className="subtitle">Assets added in a period{periodText ? ` · ${periodText}` : ''} (Sydney time).</div>
        </div>
        <div style={{ display: 'flex', gap: 8 }} className="no-print">
          <button type="button" className="btn btn-ghost btn-sm" onClick={downloadCsv} disabled={!data}><Download size={14} /> Download CSV</button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => window.print()} disabled={!data}><Printer size={14} /> Print</button>
        </div>
      </div>

      <div className="panel report-periods no-print">
        <div className="report-period-buttons" role="tablist" aria-label="Period">
          {PERIODS.map((p) => (
            <button key={p.key} type="button" role="tab" aria-selected={period === p.key}
              className={`report-period${period === p.key ? ' active' : ''}`} onClick={() => setPeriod(p.key)}>{p.label}</button>
          ))}
        </div>
        {period === 'custom' && (
          <div className="report-custom">
            <label>From <input type="date" value={custom.from} max={custom.to || undefined} onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))} /></label>
            <label>To <input type="date" value={custom.to} min={custom.from || undefined} onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))} /></label>
          </div>
        )}
      </div>

      {error && <div className="error-banner">{error}</div>}
      {!data ? (!error && <div className="panel panel-pad">Loading…</div>) : (
        <div style={{ opacity: loading ? 0.55 : 1, transition: 'opacity .15s' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 14, margin: '18px 0' }}>
            <StatTile label="Total assets" value={data.total} accent="#16241f" sub={periodText} />
            <StatTile label="Sold" value={data.sold} accent={C.orange} sub={pct(data.sold, data.total)} />
            <StatTile label="Available" value={count('byStatus', 'available')} accent={C.blue} />
            <StatTile label="In Storage" value={count('byStatus', 'in storage')} accent={C.aqua} />
            <StatTile label="Customers" value={(data.byCustomer || []).filter((r) => r.label !== 'Not set').length} accent={C.violet} />
          </div>
          <div className="report-grid">
            {SECTIONS.map((s) => (
              <Breakdown key={`${s.key}-${range.from}-${range.to}`} title={s.title} rows={data[s.key] || []} color={s.color}
                total={s.key.startsWith('sold') ? data.sold : data.total} />
            ))}
          </div>
        </div>
      )}
    </Layout>
  );
}

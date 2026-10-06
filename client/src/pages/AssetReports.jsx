import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import Layout from '../components/Layout';
import api from '../api';

export default function AssetReports() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get('/assets/reports/summary').then((res) => setData(res.data)).catch((err) => {
      setError(err.response?.data?.error || 'Could not load reports');
    });
  }, []);

  return (
    <Layout>
      <Link to="/assets" className="back-link">&larr; Back to Asset Tracker</Link>
      <div className="page-header">
        <div>
          <h1>Asset Reports</h1>
          <div className="subtitle">Totals across every asset on file.</div>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}
      {!data && !error && <div className="empty-state">Loading…</div>}

      {data && (
        <>
          <div className="stat-grid" style={{ gridTemplateColumns: 'repeat(1, 1fr)', maxWidth: 260 }}>
            <div className="stat-card">
              <div className="num">{data.total}</div>
              <div className="label">Total Assets</div>
            </div>
          </div>

          <AssetClassReport rows={data.classRows || []} />

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 18 }}>
            <ReportPanel title="By Technician" rows={data.byTech.map((r) => [r.name, r.count])} color="var(--purple)" />
            <ReportPanel title="By Customer" rows={data.byCompany.map((r) => [r.company, r.count])} color="var(--blue)" />
            <ReportPanel title="By Month" rows={data.byMonth.map((r) => [r.period, r.count])} color="var(--teal)" />
            <ReportPanel title="By Quarter" rows={data.byQuarter.map((r) => [r.period, r.count])} color="var(--amber)" />
            <ReportPanel title="By Year" rows={data.byYear.map((r) => [r.period, r.count])} color="var(--green)" />
          </div>
        </>
      )}
    </Layout>
  );
}

function ReportPanel({ title, rows, color }) {
  return (
    <div className="panel" style={{ padding: 18, marginBottom: 18, borderLeft: `4px solid ${color}` }}>
      <h3 style={{ fontSize: 15, marginBottom: 12 }}>{title}</h3>
      {rows.length === 0 ? (
        <p style={{ fontSize: 13, color: 'var(--muted)' }}>No data yet.</p>
      ) : (
        <table className="ticket-table">
          <tbody>
            {rows.map(([label, count]) => (
              <tr key={label}>
                <td>{label}</td>
                <td style={{ textAlign: 'right', fontWeight: 600 }}>{count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// By asset class (the Category field): how many of each, how many are Available /
// Sold, and where they were sent — for every customer, or one picked from the list.
const SENT_ORDER = ['ITF Australia', 'Wholesale', 'Return to Client', 'E-Waste'];
const STATUS_ORDER = ['Available', 'Sold'];

function AssetClassReport({ rows }) {
  const [customer, setCustomer] = useState('');
  const customers = useMemo(() => {
    const m = new Map();
    rows.forEach((r) => m.set(r.customer, (m.get(r.customer) || 0) + r.count));
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true, sensitivity: 'base' }));
  }, [rows]);
  const picked = customer ? rows.filter((r) => r.customer === customer) : rows;
  const statuses = [...STATUS_ORDER, ...new Set(picked.map((r) => r.status).filter((v) => v && !STATUS_ORDER.includes(v)))];
  const sentTos = [...SENT_ORDER.filter((v) => picked.some((r) => r.sentTo === v)), ...new Set(picked.map((r) => r.sentTo).filter((v) => v && !SENT_ORDER.includes(v)))];
  const classes = useMemo(() => {
    const m = new Map();
    picked.forEach((r) => {
      const c = m.get(r.assetClass) || { name: r.assetClass, total: 0, status: {}, sent: {} };
      c.total += r.count;
      if (r.status) c.status[r.status] = (c.status[r.status] || 0) + r.count;
      if (r.sentTo) c.sent[r.sentTo] = (c.sent[r.sentTo] || 0) + r.count;
      m.set(r.assetClass, c);
    });
    return [...m.values()].sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
  }, [picked]);
  const sum = (fn) => classes.reduce((t, c) => t + (fn(c) || 0), 0);
  const cell = { textAlign: 'right' };

  return (
    <div className="panel" style={{ padding: 18, marginBottom: 18, borderLeft: '4px solid var(--teal)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
        <h3 style={{ fontSize: 15, flex: 1 }}>By Asset Class</h3>
        <select value={customer} onChange={(e) => setCustomer(e.target.value)} aria-label="Customer" style={{ minWidth: 220 }}>
          <option value="">All customers ({rows.reduce((t, r) => t + r.count, 0)})</option>
          {customers.map(([c, n]) => <option key={c} value={c}>{c} ({n})</option>)}
        </select>
      </div>
      {classes.length === 0 ? <p style={{ fontSize: 13, color: 'var(--muted)' }}>No data yet.</p> : (
        <div style={{ overflowX: 'auto' }}>
          <table className="ticket-table">
            <thead>
              <tr>
                <th>Asset class</th>
                <th style={cell}>Total</th>
                {statuses.map((s) => <th key={s} style={cell}>{s}</th>)}
                {sentTos.map((s) => <th key={s} style={cell}>Sent to {s}</th>)}
              </tr>
            </thead>
            <tbody>
              {classes.map((c) => (
                <tr key={c.name}>
                  <td>{c.name}</td>
                  <td style={{ ...cell, fontWeight: 600 }}>{c.total}</td>
                  {statuses.map((s) => <td key={s} style={cell}>{c.status[s] || '—'}</td>)}
                  {sentTos.map((s) => <td key={s} style={cell}>{c.sent[s] || '—'}</td>)}
                </tr>
              ))}
              <tr style={{ fontWeight: 700 }}>
                <td>Total</td>
                <td style={cell}>{sum((c) => c.total)}</td>
                {statuses.map((s) => <td key={s} style={cell}>{sum((c) => c.status[s])}</td>)}
                {sentTos.map((s) => <td key={s} style={cell}>{sum((c) => c.sent[s])}</td>)}
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

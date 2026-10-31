import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { RefreshCw } from 'lucide-react';
import api from '../api';
import Layout from '../components/Layout';
import { Donut, BarList, ColumnChart, StatTile, CHART_COLORS as C, SERIES } from '../components/Charts';

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayLabel = (iso) => { const [y, m, d] = iso.split('-').map(Number); return `${DAY_NAMES[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]} ${d} ${MONTHS[m - 1]}`; };
const monthLabel = (iso) => { const [y, m] = iso.split('-').map(Number); return `${MONTHS[m - 1]} ${y}`; };
// Real values take series colours in order (most common first); beyond 7 they
// fold into "Other". "(not graded)" / "(not set)" and "Other" are neutral grey.
const colourise = (rows) => {
  const real = rows.filter((r) => !r.label.startsWith('('));
  const blank = rows.filter((r) => r.label.startsWith('('));
  const shown = real.slice(0, 7).map((r, i) => ({ ...r, color: SERIES[i] }));
  const rest = real.slice(7).reduce((t, r) => t + r.value, 0);
  return [...shown, ...(rest ? [{ label: 'Other', value: rest, color: C.neutral }] : []), ...blank.map((r) => ({ ...r, color: C.neutral }))];
};

function Card({ title, subtitle, children, span = 1 }) {
  return (
    <section className="panel" style={{ padding: 18, gridColumn: span === 2 ? '1 / -1' : undefined, minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
        <h3 style={{ fontSize: 15, flex: 1 }}>{title}</h3>
        {subtitle && <span style={{ fontSize: 12, color: 'var(--muted)' }}>{subtitle}</span>}
      </div>
      {children}
    </section>
  );
}

// Dashboard — totals and charts across every saved checklist.
export default function ChecklistDashboard() {
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const load = () => {
    setError('');
    api.get('/checklist/summary').then((r) => setData(r.data)).catch((err) => setError(err.response?.data?.error || 'Could not load the dashboard'));
  };
  useEffect(load, []);
  const pending = data?.deviceTypes.filter((d) => d.pending > 0) || [];

  // On a phone there isn't room to label all 30 days, so label every 5th (the tooltip still names each day).
  const narrow = typeof window !== 'undefined' && window.innerWidth < 700;
  const daily = data ? data.daily.map((d, i, all) => ({ label: dayLabel(d.day), short: !narrow || (all.length - 1 - i) % 5 === 0 ? String(Number(d.day.slice(8))) : ' ', value: d.count })) : [];
  const today = data ? data.daily[data.daily.length - 1]?.count || 0 : 0;
  const last7 = data ? data.daily.slice(-7).reduce((t, d) => t + d.count, 0) : 0;
  const last30 = data ? data.daily.reduce((t, d) => t + d.count, 0) : 0;
  const monthly = data ? data.monthly.map((m) => ({ label: monthLabel(m.month), short: MONTHS[Number(m.month.slice(5)) - 1], value: m.count })) : [];
  const monthsTotal = monthly.reduce((t, m) => t + m.value, 0);
  const devices = data ? data.deviceTypes.map((d, i) => ({ label: d.label, value: d.total, color: SERIES[i % SERIES.length], to: `/checklist/history?device=${d.key}` })) : [];
  const grades = data ? colourise(data.grades.map((g) => ({ label: g.label, value: g.count }))) : [];
  const platforms = data ? colourise(data.platforms.map((p) => ({ label: p.label, value: p.count }))) : [];
  const techs = data ? data.technicians.slice(0, 12).map((t) => ({ label: t.username, value: t.total })) : [];

  return (
    <Layout>
      <div className="page-header">
        <div><h1>Asset Checklist dashboard</h1><div className="subtitle">Totals and charts across every saved checklist.</div></div>
        <button type="button" className="btn btn-ghost btn-sm" onClick={load}><RefreshCw size={14} /> Refresh</button>
      </div>
      {error && <div className="error-banner">{error}</div>}
      {!data ? <div className="panel panel-pad">Loading…</div> : (
        <>
          {data.totalPending > 0 && (
            <div className="panel attention-box" style={{ marginBottom: 16 }}>
              {data.totalPending} {data.totalPending === 1 ? 'entry is' : 'entries are'} set to ITF Australia but not in Sales Manager yet ({pending.map((d) => `${d.label}: ${d.pending}`).join(', ')}).{' '}
              <Link to={`/checklist/history?device=${pending[0].key}`}>Open Saved History</Link> and use Retry.
            </div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 14, marginBottom: 18 }}>
            <StatTile label="Total checklists" value={data.grandTotal} accent="#16241f" sub={`${data.technicians.length} technician${data.technicians.length === 1 ? '' : 's'}`} />
            <StatTile label="Today" value={today} accent={C.blue} />
            <StatTile label="Last 7 days" value={last7} accent={C.aqua} />
            <StatTile label="In Sales Manager" value={data.totalSynced} accent={C.green} />
            <StatTile label="Waiting to sync" value={data.totalPending} accent={C.orange} sub={data.totalPending ? 'use Retry in Saved History' : 'all caught up'} />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(420px, 100%), 1fr))', gap: 18, marginBottom: 18 }}>
            <Card title="Checklists per day" subtitle={`last 30 days · ${last30.toLocaleString('en-AU')} in total`} span={2}>
              <ColumnChart data={daily} color={C.blue} height={220} unit="checklist" />
            </Card>
            <Card title="By device type" subtitle="click to open Saved History">
              <Donut data={devices} centerLabel="checklists" navigate={navigate} />
            </Card>
            <Card title="Cosmetic grade">
              <Donut data={grades} centerLabel="checklists" />
            </Card>
            <Card title="By technician" subtitle={data.technicians.length > 12 ? 'top 12 · all time' : 'all time'}>
              <BarList data={techs} color={C.violet} emptyText="No checklists yet." />
            </Card>
            <Card title="Platform">
              <Donut data={platforms} centerLabel="checklists" />
            </Card>
            <Card title="Checklists per month" subtitle={`last 12 months · ${monthsTotal.toLocaleString('en-AU')} in total`} span={2}>
              <ColumnChart data={monthly} color={C.aqua} height={200} unit="checklist" />
            </Card>
          </div>

          <div className="sales-dash-grid">
            <div className="panel panel-pad">
              <h3 className="sales-form-h">By device type</h3>
              <table className="ticket-table">
                <thead><tr><th>Device type</th><th className="num">Total</th><th className="num">In Sales Mgr</th><th className="num">Waiting</th></tr></thead>
                <tbody>{data.deviceTypes.map((d) => (
                  <tr key={d.key}><td><Link to={`/checklist/history?device=${d.key}`}>{d.label}</Link></td><td className="num">{d.total}</td><td className="num">{d.synced}</td><td className={`num ${d.pending ? 'neg' : ''}`}>{d.pending}</td></tr>
                ))}</tbody>
              </table>
            </div>
            <div className="panel panel-pad">
              <h3 className="sales-form-h">By technician</h3>
              {!data.technicians.length ? <div className="muted">No checklists yet.</div> : (
                <table className="ticket-table">
                  <thead><tr><th>Technician</th><th className="num">Total</th><th className="num">Today</th><th className="num">Last 7 days</th></tr></thead>
                  <tbody>{data.technicians.map((t) => <tr key={t.username}><td>{t.username}</td><td className="num">{t.total}</td><td className="num">{t.today}</td><td className="num">{t.last7Days}</td></tr>)}</tbody>
                </table>
              )}
            </div>
            <div className="panel panel-pad" style={{ gridColumn: '1 / -1' }}>
              <h3 className="sales-form-h">Model breakdown</h3>
              {data.deviceTypes.filter((d) => d.total > 0).map((d) => (
                <details key={d.key} className="ck-models">
                  <summary>{d.label} ({d.total})</summary>
                  <table className="ticket-table">
                    <thead><tr><th>Model</th><th className="num">Count</th></tr></thead>
                    <tbody>{d.models.map((m) => <tr key={m.model}><td>{m.model}</td><td className="num">{m.count}</td></tr>)}</tbody>
                  </table>
                </details>
              ))}
              {!data.grandTotal && <div className="muted">No checklists yet.</div>}
            </div>
          </div>
        </>
      )}
    </Layout>
  );
}

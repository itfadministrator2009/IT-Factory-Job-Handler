import { useEffect, useState } from 'react';
import api from '../api';
import Layout from '../components/Layout';
import { BarList, ColumnChart, CHART_COLORS } from '../components/Charts';

// Colours from the shared chart palette (same as Asset Reports), one per chart.
const CATEGORY_COLORS = {
  completedPerWeek: CHART_COLORS.aqua,
  state: CHART_COLORS.blue,
  vehicle: CHART_COLORS.yellow,
  account: CHART_COLORS.orange,
};

export default function Reports() {
  const [data, setData] = useState(null);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [activePreset, setActivePreset] = useState('');

  function load(range) {
    const params = {};
    if (range?.from && range?.to) {
      params.from = range.from;
      params.to = range.to;
    }
    api.get('/reports/summary', { params }).then((res) => setData(res.data));
  }

  useEffect(() => { load(); }, []);

  function applyRange() {
    setActivePreset('');
    if (from && to) load({ from, to });
  }

  function clearRange() {
    setFrom('');
    setTo('');
    setActivePreset('');
    load();
  }

  // YYYY-MM-DD using the browser's local date, not UTC — so "today" matches what the
  // person actually sees on their own clock, same as picking it manually would.
  function toLocalISODate(d) {
    const offset = d.getTimezoneOffset();
    return new Date(d.getTime() - offset * 60000).toISOString().slice(0, 10);
  }

  function applyPreset(preset) {
    const today = new Date();
    let start;
    if (preset === 'week') {
      start = new Date(today);
      const day = start.getDay(); // 0 = Sunday
      const diffToMonday = day === 0 ? 6 : day - 1;
      start.setDate(start.getDate() - diffToMonday);
    } else if (preset === 'month') {
      start = new Date(today.getFullYear(), today.getMonth(), 1);
    } else if (preset === 'last30') {
      start = new Date(today);
      start.setDate(start.getDate() - 29);
    }
    const newFrom = toLocalISODate(start);
    const newTo = toLocalISODate(today);
    setFrom(newFrom);
    setTo(newTo);
    setActivePreset(preset);
    load({ from: newFrom, to: newTo });
  }

  if (!data) return <Layout><div className="empty-state">Loading…</div></Layout>;

  const weekTotal = data.completedPerWeek.reduce((t, w) => t + w.count, 0);
  const assignedTotal = data.perTechnician.reduce((t, r) => t + r.total, 0);
  const hasRange = !!(from && to);

  return (
    <Layout>
      <div className="page-header">
        <div>
          <h1>Reports</h1>
          <div className="subtitle">How the team is tracking over time.</div>
        </div>
      </div>

      <div className="panel" style={{ padding: 18, marginBottom: 20, display: 'flex', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap' }}>
        <div className="field" style={{ marginBottom: 0 }}>
          <label htmlFor="report-from">From</label>
          <input id="report-from" type="date" value={from} onChange={(e) => { setFrom(e.target.value); setActivePreset(''); }} />
        </div>
        <div className="field" style={{ marginBottom: 0 }}>
          <label htmlFor="report-to">To</label>
          <input id="report-to" type="date" value={to} onChange={(e) => { setTo(e.target.value); setActivePreset(''); }} />
        </div>
        <button type="button" className="btn btn-primary btn-sm" onClick={applyRange} disabled={!from || !to}>
          Apply
        </button>
        {hasRange && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={clearRange}>
            Clear
          </button>
        )}
        <div style={{ display: 'flex', gap: 6, marginLeft: 'auto' }}>
          <button type="button" className={'btn btn-sm ' + (activePreset === 'week' ? 'btn-primary' : 'btn-ghost')} onClick={() => applyPreset('week')}>
            This week
          </button>
          <button type="button" className={'btn btn-sm ' + (activePreset === 'month' ? 'btn-primary' : 'btn-ghost')} onClick={() => applyPreset('month')}>
            This month
          </button>
          <button type="button" className={'btn btn-sm ' + (activePreset === 'last30' ? 'btn-primary' : 'btn-ghost')} onClick={() => applyPreset('last30')}>
            Last 30 days
          </button>
        </div>
      </div>

      <div className="stat-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))', marginBottom: 18 }}>
        <div className="stat-card accent-aqua">
          <div className="num">{weekTotal}</div>
          <div className="label">Jobs completed</div>
          <div className="sub">{hasRange ? 'in the selected period' : 'last 8 weeks'}</div>
        </div>
        <div className="stat-card accent-blue">
          <div className="num">{assignedTotal}</div>
          <div className="label">Assigned jobs</div>
          <div className="sub">{data.perTechnician.length} technician{data.perTechnician.length === 1 ? '' : 's'}</div>
        </div>
        <div className="stat-card accent-orange">
          <div className="num">{data.unassignedCount}</div>
          <div className="label">Unassigned jobs</div>
          <div className="sub">waiting for a Ticket Owner</div>
        </div>
      </div>

      <ReportCard title="Jobs completed per week" subtitle={hasRange ? 'by resolution date, selected period' : 'last 8 weeks, by resolution date'}>
        <ColumnChart unit="job" color={CATEGORY_COLORS.completedPerWeek}
          data={data.completedPerWeek.map((w) => ({ label: `Week of ${formatWeek(w.weekStart)}`, short: formatWeek(w.weekStart), value: w.count }))} />
      </ReportCard>

      <div className="report-grid">
        <ReportCard title="Jobs per technician" subtitle="completed and still open">
          {data.perTechnician.length === 0 ? (
            <p style={{ fontSize: 13, color: 'var(--muted)' }}>No assigned jobs {hasRange ? 'in this period' : 'yet'}. Assign jobs to a Ticket Owner to see the breakdown here.</p>
          ) : (
            <BarList labelWidth={140}
              segments={[{ key: 'done', label: 'Completed', color: CHART_COLORS.aqua }, { key: 'open', label: 'Not completed yet', color: CHART_COLORS.blue }]}
              data={data.perTechnician.map((t) => ({ label: t.name, value: t.total, parts: { done: t.completed, open: Math.max(0, t.total - t.completed) } }))} />
          )}
        </ReportCard>
        {data.byState && data.byState.length > 0 && (
          <ReportCard title="Jobs by state">
            <BarList labelWidth={140} color={CATEGORY_COLORS.state} data={data.byState.map((r) => ({ label: r.state, value: r.count }))} />
          </ReportCard>
        )}
        {data.byVehicle && data.byVehicle.length > 0 && (
          <ReportCard title="Jobs by vehicle">
            <BarList labelWidth={140} color={CATEGORY_COLORS.vehicle} data={data.byVehicle.map((r) => ({ label: r.vehicle, value: r.count }))} />
          </ReportCard>
        )}
        {data.byAccount && data.byAccount.length > 0 && (
          <ReportCard title="Jobs by account">
            <BarList labelWidth={140} color={CATEGORY_COLORS.account} data={data.byAccount.map((r) => ({ label: r.account, value: r.count }))} />
          </ReportCard>
        )}
      </div>
    </Layout>
  );
}

// A white card with a heading — same look as the Asset Reports cards.
function ReportCard({ title, subtitle, children }) {
  return (
    <section className="panel" style={{ padding: 18, marginBottom: 18, minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
        <h3 style={{ fontSize: 15, flex: 1 }}>{title}</h3>
        {subtitle && <span style={{ fontSize: 12, color: 'var(--muted)' }}>{subtitle}</span>}
      </div>
      {children}
    </section>
  );
}

function formatWeek(dateStr) {
  const d = new Date(dateStr);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

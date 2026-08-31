import { useEffect, useState } from 'react';
import api from '../api';
import Layout from '../components/Layout';

// One consistent color per report category — replaces the old "everything is teal"
// look, which read as "all green" since var(--teal) is a dark blue-green.
const CATEGORY_COLORS = {
  completedPerWeek: 'var(--teal)',
  technician: 'var(--purple)',
  state: 'var(--blue)',
  vehicle: 'var(--amber)',
  account: 'var(--coral)',
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

  const maxWeek = Math.max(1, ...data.completedPerWeek.map((w) => w.count));
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

      <div className="panel" style={{ padding: 24, marginBottom: 20 }}>
        <h3 style={{ marginBottom: 4 }}>Jobs completed per week</h3>
        <div className="subtitle" style={{ marginBottom: 18 }}>
          {hasRange ? 'By resolution date, across the selected period.' : 'Last 8 weeks, by resolution date.'}
        </div>
        <div className="bar-chart">
          {data.completedPerWeek.map((w) => (
            <div key={w.weekStart} className="bar-chart-col">
              <div
                className="bar-chart-bar"
                style={{ height: `${(w.count / maxWeek) * 100}%`, background: CATEGORY_COLORS.completedPerWeek }}
                title={`${w.count} completed`}
              >
                {w.count > 0 && <span className="bar-chart-count">{w.count}</span>}
              </div>
              <div className="bar-chart-label">{formatWeek(w.weekStart)}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="stat-grid" style={{ gridTemplateColumns: 'repeat(1, minmax(0, 220px))', marginBottom: 20 }}>
        <div className="stat-card">
          <div className="num">{data.unassignedCount}</div>
          <div className="label">Unassigned jobs</div>
        </div>
      </div>

      <div className="panel" style={{ padding: 20, borderLeft: `4px solid ${CATEGORY_COLORS.technician}` }}>
        <h3 style={{ marginBottom: 14 }}>Jobs per technician</h3>
        {data.perTechnician.length === 0 ? (
          <div className="empty-state">
            <h3>No assigned jobs {hasRange ? 'in this period' : 'yet'}</h3>
            <p>Assign jobs to a Ticket Owner to see the breakdown here.</p>
          </div>
        ) : (
          <table className="ticket-table">
            <thead>
              <tr>
                <th>Technician</th>
                <th>Total jobs</th>
                <th>Completed</th>
              </tr>
            </thead>
            <tbody>
              {data.perTechnician.map((t) => (
                <tr key={t.name}>
                  <td>{t.name}</td>
                  <td>{t.total}</td>
                  <td>{t.completed}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {data.byState && data.byState.length > 0 && (
        <BreakdownPanel title="Jobs by state" rows={data.byState} labelKey="state" color={CATEGORY_COLORS.state} />
      )}

      {data.byVehicle && data.byVehicle.length > 0 && (
        <BreakdownPanel title="Jobs by vehicle" rows={data.byVehicle} labelKey="vehicle" color={CATEGORY_COLORS.vehicle} />
      )}

      {data.byAccount && data.byAccount.length > 0 && (
        <BreakdownPanel title="Jobs by account" rows={data.byAccount} labelKey="account" color={CATEGORY_COLORS.account} />
      )}
    </Layout>
  );
}

// A simple horizontal bar list — used for the state, vehicle, and account
// breakdowns. Each panel gets its own color (passed in) so the categories read as
// visually distinct sections rather than one uniform color throughout.
function BreakdownPanel({ title, rows, labelKey, color }) {
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <div className="panel" style={{ padding: 20, marginTop: 20, borderLeft: `4px solid ${color}` }}>
      <h3 style={{ marginBottom: 14 }}>{title}</h3>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {rows.map((r) => (
          <div key={r[labelKey]} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ width: 160, fontSize: 13, color: 'var(--ink)', flexShrink: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r[labelKey]}>
              {r[labelKey]}
            </div>
            <div style={{ flex: 1, background: 'var(--paper)', borderRadius: 4, overflow: 'hidden' }}>
              <div style={{ width: `${(r.count / max) * 100}%`, background: color, height: 18, borderRadius: 4 }} />
            </div>
            <div style={{ width: 28, fontSize: 13, fontWeight: 600, textAlign: 'right', flexShrink: 0 }}>{r.count}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function formatWeek(dateStr) {
  const d = new Date(dateStr);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

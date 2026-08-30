import { useEffect, useState } from 'react';
import api from '../api';
import Layout from '../components/Layout';

export default function Reports() {
  const [data, setData] = useState(null);

  useEffect(() => {
    api.get('/reports/summary').then((res) => setData(res.data));
  }, []);

  if (!data) return <Layout><div className="empty-state">Loading…</div></Layout>;

  const maxWeek = Math.max(1, ...data.completedPerWeek.map((w) => w.count));

  return (
    <Layout>
      <div className="page-header">
        <div>
          <h1>Reports</h1>
          <div className="subtitle">How the team is tracking over time.</div>
        </div>
      </div>

      <div className="panel" style={{ padding: 24, marginBottom: 20 }}>
        <h3 style={{ marginBottom: 4 }}>Jobs completed per week</h3>
        <div className="subtitle" style={{ marginBottom: 18 }}>Last 8 weeks, by resolution date.</div>
        <div className="bar-chart">
          {data.completedPerWeek.map((w) => (
            <div key={w.weekStart} className="bar-chart-col">
              <div className="bar-chart-bar" style={{ height: `${(w.count / maxWeek) * 100}%` }} title={`${w.count} completed`}>
                {w.count > 0 && <span className="bar-chart-count">{w.count}</span>}
              </div>
              <div className="bar-chart-label">{formatWeek(w.weekStart)}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="stat-grid" style={{ gridTemplateColumns: 'repeat(2, 1fr)', marginBottom: 20 }}>
        <div className="stat-card">
          <div className="num">{data.avgResolutionHours != null ? formatHours(data.avgResolutionHours) : '—'}</div>
          <div className="label">Avg. time to resolution</div>
        </div>
        <div className="stat-card">
          <div className="num">{data.unassignedCount}</div>
          <div className="label">Unassigned jobs</div>
        </div>
      </div>

      <div className="panel" style={{ padding: 20 }}>
        <h3 style={{ marginBottom: 14 }}>Jobs per technician</h3>
        {data.perTechnician.length === 0 ? (
          <div className="empty-state">
            <h3>No assigned jobs yet</h3>
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
        <BreakdownPanel title="Jobs by state" rows={data.byState} labelKey="state" />
      )}

      {data.byVehicle && data.byVehicle.length > 0 && (
        <BreakdownPanel title="Jobs by vehicle" rows={data.byVehicle} labelKey="vehicle" />
      )}

      {data.byAccount && data.byAccount.length > 0 && (
        <BreakdownPanel title="Jobs by account" rows={data.byAccount} labelKey="account" />
      )}
    </Layout>
  );
}

// A simple horizontal bar list — used for both the state and vehicle breakdowns so
// they read consistently with each other.
function BreakdownPanel({ title, rows, labelKey }) {
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <div className="panel" style={{ padding: 20, marginTop: 20 }}>
      <h3 style={{ marginBottom: 14 }}>{title}</h3>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {rows.map((r) => (
          <div key={r[labelKey]} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ width: 160, fontSize: 13, color: 'var(--ink)', flexShrink: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r[labelKey]}>
              {r[labelKey]}
            </div>
            <div style={{ flex: 1, background: 'var(--paper)', borderRadius: 4, overflow: 'hidden' }}>
              <div style={{ width: `${(r.count / max) * 100}%`, background: 'var(--teal)', height: 18, borderRadius: 4 }} />
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

function formatHours(hours) {
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  if (hours < 48) return `${hours.toFixed(1)}h`;
  return `${(hours / 24).toFixed(1)}d`;
}

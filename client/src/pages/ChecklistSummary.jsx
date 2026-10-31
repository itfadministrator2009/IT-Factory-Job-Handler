import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { RefreshCw } from 'lucide-react';
import api from '../api';
import Layout from '../components/Layout';

// Summary — totals across every saved checklist.
export default function ChecklistSummary() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const load = () => {
    setError('');
    api.get('/checklist/summary').then((r) => setData(r.data)).catch((err) => setError(err.response?.data?.error || 'Could not load the summary'));
  };
  useEffect(load, []);
  const pending = data?.deviceTypes.filter((d) => d.pending > 0) || [];
  return (
    <Layout>
      <div className="page-header">
        <div><h1>Asset Checklist summary</h1><div className="subtitle">Totals across every saved checklist.</div></div>
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
          <div className="stat-grid">
            <div className="stat-card accent-ink"><div className="num">{data.grandTotal}</div><div className="label">Total checklists</div></div>
            <div className="stat-card accent-green"><div className="num">{data.totalSynced}</div><div className="label">In Sales Manager</div></div>
            <div className="stat-card accent-orange"><div className="num">{data.totalPending}</div><div className="label">Waiting to sync</div></div>
            <div className="stat-card accent-blue"><div className="num">{data.technicians.length}</div><div className="label">Technicians</div></div>
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

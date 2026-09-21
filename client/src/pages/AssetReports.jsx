import { useEffect, useState } from 'react';
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

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 18 }}>
            <ReportPanel title="By Technician" rows={data.byTech.map((r) => [r.name, r.count])} color="var(--purple)" />
            <ReportPanel title="By Company" rows={data.byCompany.map((r) => [r.company, r.count])} color="var(--blue)" />
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

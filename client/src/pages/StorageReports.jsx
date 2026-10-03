import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Boxes, Package, Users, ClipboardList, Truck } from 'lucide-react';
import api from '../api';
import Layout from '../components/Layout';

function lastWeekRange() {
  const today = new Date();
  const dow = today.getDay();
  const daysSinceMonday = (dow + 6) % 7;
  const thisMonday = new Date(today); thisMonday.setDate(today.getDate() - daysSinceMonday);
  const lastMonday = new Date(thisMonday); lastMonday.setDate(thisMonday.getDate() - 7);
  const lastSunday = new Date(thisMonday); lastSunday.setDate(thisMonday.getDate() - 1);
  const fmt = (d) => d.toISOString().slice(0, 10);
  return { from: fmt(lastMonday), to: fmt(lastSunday) };
}

export default function StorageReports() {
  const defaultRange = lastWeekRange();
  const [from, setFrom] = useState(defaultRange.from);
  const [to, setTo] = useState(defaultRange.to);
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function runReport(e) {
    e?.preventDefault();
    setLoading(true);
    setError('');
    try {
      const { data } = await api.get('/storage/reports/summary', { params: { from, to } });
      setReport(data);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not generate report');
    } finally {
      setLoading(false);
    }
  }

  return (
    <Layout>
      <div className="page-header">
        <div>
          <h1>Storage Centre — Reports</h1>
          <div className="subtitle">Storage + receiving/dispatch fees per client, by date range</div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <Link to="/storage" className="btn btn-ghost btn-sm"><Boxes size={14} /> Manifest</Link>
          <Link to="/storage/pallets" className="btn btn-ghost btn-sm"><Package size={14} /> Pallets</Link>
          <Link to="/storage/clients" className="btn btn-ghost btn-sm"><Users size={14} /> Clients</Link>
          <Link to="/storage/orders" className="btn btn-ghost btn-sm"><ClipboardList size={14} /> Orders</Link>
          <Link to="/storage/receiving" className="btn btn-ghost btn-sm"><Truck size={14} /> Receiving/Dispatch</Link>
        </div>
      </div>

      <form onSubmit={runReport} className="panel" style={{ display: 'flex', gap: 12, alignItems: 'end', marginBottom: 16 }}>
        <div className="field"><label>From</label><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} required /></div>
        <div className="field"><label>To</label><input type="date" value={to} onChange={(e) => setTo(e.target.value)} required /></div>
        <button className="btn btn-accent" type="submit" disabled={loading}>{loading ? 'Calculating…' : 'Run report'}</button>
      </form>

      {error && <div className="error-banner">{error}</div>}

      {report && (
        <div className="panel" style={{ padding: 0 }}>
          <table className="ticket-table">
            <thead><tr><th>Client</th><th>Storage Cost</th><th>Receiving/Dispatch Fees</th><th>Total</th></tr></thead>
            <tbody>
              {report.summary.map((s) => (
                <tr key={s.client}>
                  <td>{s.client}</td>
                  <td>${s.storageCost.toFixed(2)}</td>
                  <td>${s.receivingDispatchFees.toFixed(2)}</td>
                  <td style={{ fontWeight: 700 }}>${s.total.toFixed(2)}</td>
                </tr>
              ))}
              {report.summary.length === 0 && (
                <tr><td colSpan={4} style={{ textAlign: 'center', color: 'var(--muted)', padding: 24 }}>No clients with storage items.</td></tr>
              )}
            </tbody>
            {report.summary.length > 0 && (
              <tfoot>
                <tr><td colSpan={3} style={{ textAlign: 'right', fontWeight: 700 }}>Grand total</td><td style={{ fontWeight: 700 }}>${report.grandTotal.toFixed(2)}</td></tr>
              </tfoot>
            )}
          </table>
        </div>
      )}
    </Layout>
  );
}

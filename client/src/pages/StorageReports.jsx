import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Boxes, Package, Users, ClipboardList, Truck, FileText, Download, Mail, Printer, RotateCcw } from 'lucide-react';
import api from '../api';
import { openPdf, downloadFile } from '../utils/pdf';
import Layout from '../components/Layout';
import RangePicker from '../storage/RangePicker';
import { presetRange, downloadCsv, dmy, money } from '../storage/common';

// Previous Monday–Sunday, in local (Sydney) dates.
const lastWeekRange = () => presetRange('lastWeek');

// Old Invoicing tab, "Receiving / Dispatch" section: fees per client for a
// period, with CSV export, print and a per-client PDF.
function RdInvoicing({ clients }) {
  const [client, setClient] = useState('');
  const [range, setRange] = useState(null);
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function run() {
    if (!range) { alert('Choose a date range above first.'); return; }
    setLoading(true); setError('');
    try {
      const { data } = await api.get('/storage/reports/rd', { params: { from: range.from, to: range.to, client: client || undefined } });
      setResult(data);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not calculate');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="panel panel-pad" style={{ marginTop: 24 }}>
      <h3 style={{ fontSize: 16, marginBottom: 4 }}>Receiving / Dispatch invoicing — {client || 'all clients'}</h3>
      <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 12 }}>Receiving fees by date received, dispatch fees by date dispatched.</div>
      <div className="no-print" style={{ marginBottom: 12 }}>
        <div className="field" style={{ maxWidth: 280 }}>
          <label>Client</label>
          <select value={client} onChange={(e) => { setClient(e.target.value); setResult(null); }}>
            <option value="">— All Clients —</option>
            {clients.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <RangePicker value={range} onChange={(r) => { setRange(r); setResult(null); }} />
        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <button type="button" className="btn btn-accent" onClick={run} disabled={loading}>{loading ? 'Calculating…' : 'Calculate'}</button>
          <button type="button" className="btn btn-ghost" disabled={!result} onClick={() => downloadCsv('receiving-dispatch-fees.csv', [
            [`Period: ${dmy(result.from)} – ${dmy(result.to)}`],
            ['Client', 'Receiving fee (ex GST)', 'Dispatch fee (ex GST)', 'Total (ex GST)'],
            ...result.clients.map((c) => [c.client, c.receiving.toFixed(2), c.dispatch.toFixed(2), c.total.toFixed(2)]),
            ['Total', result.receiving.toFixed(2), result.dispatch.toFixed(2), result.total.toFixed(2)],
          ])}><Download size={14} /> Export CSV</button>
          <button type="button" className="btn btn-ghost" disabled={!result} onClick={() => window.print()}><Printer size={14} /> Print</button>
          <button type="button" className="btn btn-ghost" onClick={() => { setClient(''); setRange(null); setResult(null); }}>Clear</button>
        </div>
      </div>
      {error && <div className="error-banner">{error}</div>}
      {result && (result.clients.length === 0 ? <div className="empty-state">No receiving/dispatch fees found for this period.</div> : (
        <table className="ticket-table">
          <thead><tr><th>Client</th><th style={{ textAlign: 'right' }}>Receiving fee (ex GST)</th><th style={{ textAlign: 'right' }}>Dispatch fee (ex GST)</th><th style={{ textAlign: 'right' }}>Total (ex GST)</th><th className="no-print"></th></tr></thead>
          <tbody>
            {result.clients.map((c) => (
              <tr key={c.client}>
                <td>{c.client}</td>
                <td style={{ textAlign: 'right' }}>{money(c.receiving)}</td>
                <td style={{ textAlign: 'right' }}>{money(c.dispatch)}</td>
                <td style={{ textAlign: 'right', fontWeight: 700 }}>{money(c.total)}</td>
                <td className="no-print">
                  <button type="button" className="btn btn-ghost btn-sm" title="Receiving / dispatch invoice PDF"
                    onClick={() => openPdf(api, '/storage/reports/rd-invoice.pdf', { client: c.client, from: result.from, to: result.to }).catch((err) => alert(err.message))}>
                    <FileText size={13} /> PDF
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr><td style={{ fontWeight: 700 }}>Total</td><td style={{ textAlign: 'right', fontWeight: 700 }}>{money(result.receiving)}</td><td style={{ textAlign: 'right', fontWeight: 700 }}>{money(result.dispatch)}</td><td style={{ textAlign: 'right', fontWeight: 700 }}>{money(result.total)}</td><td className="no-print"></td></tr>
          </tfoot>
        </table>
      ))}
    </div>
  );
}

export default function StorageReports() {
  const defaultRange = lastWeekRange();
  const [from, setFrom] = useState(defaultRange.from);
  const [to, setTo] = useState(defaultRange.to);
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [clients, setClients] = useState([]);
  useEffect(() => { api.get('/storage/lists').then((r) => setClients(r.data.clients)).catch(() => {}); }, []);

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
          <button type="button" className="btn btn-ghost btn-sm" title="All Storage Centre data as CSV files (opens in Excel)"
            onClick={() => downloadFile(api, '/storage/export.zip', 'storage-centre.zip').catch(() => alert('Could not download the export'))}>
            <Download size={14} /> Download backup
          </button>
          <Link to="/storage/restore" className="btn btn-ghost btn-sm" title="Put the Storage Centre data back from a backup"><RotateCcw size={14} /> Restore</Link>
          <button type="button" className="btn btn-ghost btn-sm" title="Email last week's invoicing summary now (the Monday email)"
            onClick={async () => {
              if (!confirm("Email last week's invoicing summary now?")) return;
              try {
                const { data } = await api.post('/storage/reports/weekly-reminder');
                alert(`Sent to ${data.sentTo.join(', ')} — ${data.clients} client(s), $${data.grandTotal.toFixed(2)}.`);
              } catch (err) { alert(err.response?.data?.error || 'Could not send'); }
            }}>
            <Mail size={14} /> Email weekly summary
          </button>
        </div>
      </div>

      <form onSubmit={runReport} className="panel panel-pad" style={{ display: 'flex', gap: 12, alignItems: 'end', marginBottom: 16 }}>
        <div className="field"><label>From</label><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} required /></div>
        <div className="field"><label>To</label><input type="date" value={to} onChange={(e) => setTo(e.target.value)} required /></div>
        <button className="btn btn-accent" type="submit" disabled={loading}>{loading ? 'Calculating…' : 'Run report'}</button>
      </form>

      {error && <div className="error-banner">{error}</div>}

      {report && (
        <div className="panel" style={{ padding: 0 }}>
          <table className="ticket-table">
            <thead><tr><th>Client</th><th>Storage Cost</th><th>Receiving</th><th>Dispatch</th><th>Total</th><th></th></tr></thead>
            <tbody>
              {report.summary.map((s) => (
                <tr key={s.client}>
                  <td>{s.client}</td>
                  <td>${s.storageCost.toFixed(2)}</td>
                  <td>${(s.receivingFees ?? 0).toFixed(2)}</td>
                  <td>${(s.dispatchFees ?? 0).toFixed(2)}</td>
                  <td style={{ fontWeight: 700 }}>${s.total.toFixed(2)}</td>
                  <td>
                    <button type="button" className="btn btn-ghost btn-sm" title="Invoice PDF for this client and period"
                      onClick={() => openPdf(api, '/storage/reports/invoice.pdf', { client: s.client, from: report.from, to: report.to }).catch((err) => alert(err.message))}>
                      <FileText size={13} /> Invoice
                    </button>
                  </td>
                </tr>
              ))}
              {report.summary.length === 0 && (
                <tr><td colSpan={6} style={{ textAlign: 'center', color: 'var(--muted)', padding: 24 }}>No clients with storage items.</td></tr>
              )}
            </tbody>
            {report.summary.length > 0 && (
              <tfoot>
                <tr><td colSpan={4} style={{ textAlign: 'right', fontWeight: 700 }}>Grand total</td><td style={{ fontWeight: 700 }}>${report.grandTotal.toFixed(2)}</td><td></td></tr>
              </tfoot>
            )}
          </table>
        </div>
      )}

      <RdInvoicing clients={clients} />
    </Layout>
  );
}

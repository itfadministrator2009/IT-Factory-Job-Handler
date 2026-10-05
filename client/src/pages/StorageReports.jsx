import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { FileText, Download, Mail, Printer, RotateCcw } from 'lucide-react';
import api from '../api';
import { openPdf, downloadFile } from '../utils/pdf';
import Layout from '../components/Layout';
import RangePicker from '../storage/RangePicker';
import { presetRange, downloadCsv, dmy, money, sameText } from '../storage/common';

// Previous Monday–Sunday, in local (Sydney) dates.
const lastWeekRange = () => presetRange('lastWeek');

// Old Invoicing tab, "Storage" section: storage cost (+ receiving/dispatch fees)
// per client for a period, laid out like the Receiving / Dispatch section below.
function StorageInvoicing({ clients }) {
  const [client, setClient] = useState('');
  const [range, setRange] = useState(() => ({ preset: 'lastWeek', ...lastWeekRange() }));
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function run() {
    if (!range) { alert('Choose a date range first.'); return; }
    setLoading(true); setError('');
    try {
      const { data } = await api.get('/storage/reports/summary', { params: { from: range.from, to: range.to } });
      setReport(data);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not generate report');
    } finally {
      setLoading(false);
    }
  }

  const rows = report ? report.summary.filter((s) => !client || sameText(s.client, client)) : [];
  const totals = rows.reduce((t, s) => ({
    storage: t.storage + s.storageCost, receiving: t.receiving + (s.receivingFees ?? 0), dispatch: t.dispatch + (s.dispatchFees ?? 0), total: t.total + s.total,
  }), { storage: 0, receiving: 0, dispatch: 0, total: 0 });

  return (
    <div className="panel panel-pad">
      <h3 style={{ fontSize: 16, marginBottom: 4 }}>Storage — {client || 'All Clients'}</h3>
      <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 12 }}>Storage cost for the period (pallet rates or per-item rates), plus receiving/dispatch fees. Invoice PDF per client.</div>
      <div className="no-print" style={{ marginBottom: 12 }}>
        <div className="field" style={{ maxWidth: 280 }}>
          <label>Client</label>
          <select value={client} onChange={(e) => setClient(e.target.value)}>
            <option value="">— All Clients —</option>
            {clients.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <RangePicker value={range} onChange={(r) => { setRange(r); setReport(null); }} />
        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <button type="button" className="btn btn-accent" onClick={run} disabled={loading}>{loading ? 'Calculating…' : 'Calculate'}</button>
          <button type="button" className="btn btn-ghost" disabled={!report || !rows.length} onClick={() => downloadCsv('storage-invoicing.csv', [
            [`Period: ${dmy(report.from)} – ${dmy(report.to)}`],
            ['Client', 'Storage cost (ex GST)', 'Receiving (ex GST)', 'Dispatch (ex GST)', 'Total (ex GST)'],
            ...rows.map((s) => [s.client, s.storageCost.toFixed(2), (s.receivingFees ?? 0).toFixed(2), (s.dispatchFees ?? 0).toFixed(2), s.total.toFixed(2)]),
            ['Total', totals.storage.toFixed(2), totals.receiving.toFixed(2), totals.dispatch.toFixed(2), totals.total.toFixed(2)],
          ])}><Download size={14} /> Export CSV</button>
          <button type="button" className="btn btn-ghost" disabled={!report} onClick={() => window.print()}><Printer size={14} /> Print</button>
          <button type="button" className="btn btn-ghost" onClick={() => { setClient(''); setRange(null); setReport(null); }}>Clear</button>
        </div>
      </div>
      {error && <div className="error-banner">{error}</div>}
      {report && (rows.length === 0 ? <div className="empty-state">{client ? `Nothing to bill for ${client} in this period.` : 'No clients with storage or fees in this period.'}</div> : (
        <table className="ticket-table">
          <thead><tr>
            <th>Client</th><th style={{ textAlign: 'right' }}>Storage cost (ex GST)</th><th style={{ textAlign: 'right' }}>Receiving (ex GST)</th>
            <th style={{ textAlign: 'right' }}>Dispatch (ex GST)</th><th style={{ textAlign: 'right' }}>Total (ex GST)</th><th className="no-print"></th>
          </tr></thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.client}>
                <td>{s.client}</td>
                <td style={{ textAlign: 'right' }}>{money(s.storageCost)}</td>
                <td style={{ textAlign: 'right' }}>{money(s.receivingFees ?? 0)}</td>
                <td style={{ textAlign: 'right' }}>{money(s.dispatchFees ?? 0)}</td>
                <td style={{ textAlign: 'right', fontWeight: 700 }}>{money(s.total)}</td>
                <td className="no-print">
                  <button type="button" className="btn btn-ghost btn-sm" title="Invoice PDF for this client and period"
                    onClick={() => openPdf(api, '/storage/reports/invoice.pdf', { client: s.client, from: report.from, to: report.to }).catch((err) => alert(err.message))}>
                    <FileText size={13} /> Invoice
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td style={{ fontWeight: 700 }}>Total</td>
              <td style={{ textAlign: 'right', fontWeight: 700 }}>{money(totals.storage)}</td>
              <td style={{ textAlign: 'right', fontWeight: 700 }}>{money(totals.receiving)}</td>
              <td style={{ textAlign: 'right', fontWeight: 700 }}>{money(totals.dispatch)}</td>
              <td style={{ textAlign: 'right', fontWeight: 700 }}>{money(totals.total)}</td>
              <td className="no-print"></td>
            </tr>
          </tfoot>
        </table>
      ))}
    </div>
  );
}

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
      <h3 style={{ fontSize: 16, marginBottom: 4 }}>Receiving / Dispatch invoicing — {client || 'All Clients'}</h3>
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
  const [clients, setClients] = useState([]);
  useEffect(() => { api.get('/storage/lists').then((r) => setClients(r.data.clients)).catch(() => {}); }, []);

  return (
    <Layout>
      <div className="page-header">
        <div>
          <h1>Storage Centre — Reports</h1>
          <div className="subtitle">Storage + receiving/dispatch fees per client, by date range</div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
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

      <StorageInvoicing clients={clients} />

      <RdInvoicing clients={clients} />
    </Layout>
  );
}

import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Upload, Mail, Printer } from 'lucide-react';
import api from '../api';
import Layout from '../components/Layout';
import useSalesData from '../sales/useSalesData';
import { rowsToRecords, allDuplicateSerials, printTable, auDate, toISODate, fmtInt } from '../sales/calc';
import { utcYmd } from '../storage/sheetReader';

const tabKey = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const cellText = (v) => (v instanceof Date ? utcYmd(v) : v);
const CHUNK = 2000;

// Tools — the move from the Google Sheet, the activity log, duplicate serials,
// and a test send of the Monday summary email.
export default function SalesTools() {
  const { sales, inventory, isAdmin, reload, loading } = useSalesData({ sales: true, inventory: true });
  const [activity, setActivity] = useState(null);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState('');

  useEffect(() => { api.get('/sales/activity').then((r) => setActivity(r.data.entries)).catch(() => setActivity([])); }, []);
  const dups = useMemo(() => (sales && inventory ? allDuplicateSerials(sales, inventory) : []), [sales, inventory]);

  const importSheet = async (file) => {
    if (!file) return;
    setError(''); setMsg('');
    if (!/\.xlsx$/i.test(file.name)) { setError('Choose the .xlsx download of the Google Sheet (File → Download → Microsoft Excel).'); return; }
    setBusy('Reading the spreadsheet…');
    try {
      const mod = await import('read-excel-file/browser');
      const sheets = await mod.default(file);
      const find = (name) => sheets.find((s) => tabKey(s.sheet) === tabKey(name));
      const parts = [];
      const results = [];
      for (const [tab, kind] of [['Sales', 'sale'], ['Inventory', 'inventory']]) {
        const s = find(tab);
        if (!s) continue;
        const rows = s.data.map((r) => r.map(cellText));
        const recs = rowsToRecords(rows[0] || [], rows.slice(1)) || [];
        parts.push(tab);
        let added = 0; let updated = 0;
        for (let i = 0; i < recs.length; i += CHUNK) {
          setBusy(`Importing ${tab}: ${fmtInt(Math.min(i + CHUNK, recs.length))} of ${fmtInt(recs.length)}…`);
          const r = await api.post('/sales/import', { kind, records: recs.slice(i, i + CHUNK), keepIds: true });
          added += r.data.added; updated += r.data.updated;
        }
        results.push(`${tab}: ${fmtInt(added)} added, ${fmtInt(updated)} updated`);
      }
      const p = find('ShopifyPending');
      if (p && p.data.length > 1) {
        setBusy('Importing waiting Shopify orders…');
        const head = p.data[0].map((h) => String(h || '').trim());
        const rows = p.data.slice(1).filter((r) => r.some((c) => String(c ?? '').trim() !== '')).map((r) => {
          const o = {};
          head.forEach((h, i) => { o[h] = cellText(r[i]); });
          if (o.stagedAt && !Number(o.stagedAt)) o.stagedAt = Date.parse(o.stagedAt) || '';
          return o;
        });
        const r = await api.post('/sales/import-shopify-pending', { rows });
        results.push(`Shopify orders waiting: ${fmtInt(r.data.added)} added`);
        parts.push('ShopifyPending');
      }
      if (!parts.length) throw new Error('No "Sales", "Inventory" or "ShopifyPending" tab found in that file.');
      setMsg(`Imported from the Google Sheet — ${results.join(' · ')}. Running it again only updates the same rows, so it's safe to re-import.`);
      await reload();
      api.get('/sales/activity').then((r) => setActivity(r.data.entries)).catch(() => {});
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Import failed');
    }
    setBusy('');
  };

  const testEmail = async () => {
    setError(''); setMsg(''); setBusy('Sending…');
    try {
      const r = await api.post('/sales/weekly-summary/test');
      setMsg(r.data.ok === false ? 'Email is not set up on the server yet.' : 'Sent last week\'s summary to your email address.');
    } catch (err) { setError(err.response?.data?.error || 'Could not send'); }
    setBusy('');
  };

  const printDups = () => printTable('Duplicate serial numbers', `Printed ${auDate(toISODate(new Date()))}`,
    [{ label: 'Serial' }, { label: 'Where' }, { label: 'SKU' }, { label: 'Make / model' }],
    dups.flatMap((g) => g.records.map((r, i) => [i ? '' : g.serial, r.sheet, r.sku, r.model])));

  return (
    <Layout>
      <div className="page-header"><div><h1>Sales Tools</h1><div className="subtitle">Import, activity and checks.</div></div></div>
      {error && <div className="error-banner">{error}</div>}
      {msg && <div className="success-banner">{msg}</div>}

      {isAdmin && (
        <div className="panel panel-pad" style={{ marginBottom: 16 }}>
          <h3 className="sales-form-h">Import from the Google Sheet</h3>
          <p className="muted" style={{ marginTop: 0 }}>
            In the old Sales Manager sheet choose <b>File → Download → Microsoft Excel (.xlsx)</b>, then pick that file here.
            The Sales, Inventory and ShopifyPending tabs come across with their original IDs, so importing again later
            just refreshes the same rows instead of making copies.
          </p>
          <label className={`btn btn-primary btn-sm ${busy ? 'disabled' : ''}`}>
            <Upload size={14} /> {busy || 'Choose .xlsx file'}
            <input type="file" accept=".xlsx" hidden disabled={!!busy} onChange={(e) => { importSheet(e.target.files[0]); e.target.value = ''; }} />
          </label>
        </div>
      )}

      <div className="sales-dash-grid">
        <div className="panel panel-pad">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h3 className="sales-form-h">Duplicate serial numbers</h3>
            {dups.length > 0 && <button type="button" className="btn btn-ghost btn-sm" onClick={printDups}><Printer size={14} /> Print</button>}
          </div>
          {loading ? <div className="muted">Loading…</div> : !dups.length ? <div className="muted">No serial number appears more than once.</div> : (
            <table className="ticket-table">
              <thead><tr><th>Serial</th><th>Where</th><th>SKU</th><th>Make / model</th></tr></thead>
              <tbody>
                {dups.flatMap((g) => g.records.map((r, i) => (
                  <tr key={`${g.serial}-${r.id}`}>
                    <td className="mono">{i ? '' : g.serial}</td><td>{r.sheet}</td>
                    <td className="mono"><Link to={r.sheet === 'All Sales' ? `/sales/edit/${r.id}` : `/sales/inventory/edit/${r.id}`}>{r.sku}</Link></td>
                    <td>{r.model}</td>
                  </tr>
                )))}
              </tbody>
            </table>
          )}
        </div>

        <div className="panel panel-pad">
          <h3 className="sales-form-h">Monday summary email</h3>
          <p className="muted" style={{ marginTop: 0 }}>
            Each Monday morning a summary of the previous week (items sold, revenue, net profit after the weekly labour and
            ads costs, and stock older than 60 days) is emailed to the addresses set on the server.
          </p>
          {isAdmin && <button type="button" className="btn btn-ghost btn-sm" onClick={testEmail} disabled={!!busy}><Mail size={14} /> Send me a test</button>}
        </div>

        <div className="panel panel-pad" style={{ gridColumn: '1 / -1' }}>
          <h3 className="sales-form-h">Activity (last 90 days)</h3>
          {!activity ? <div className="muted">Loading…</div> : !activity.length ? <div className="muted">Nothing yet.</div> : (
            <div className="sales-table-wrap" style={{ maxHeight: 480 }}>
              <table className="ticket-table">
                <thead><tr><th>When</th><th>Who</th><th>What</th><th>List</th><th>Details</th></tr></thead>
                <tbody>
                  {activity.map((a, i) => (
                    <tr key={i}>
                      <td className="nowrap">{new Date(a.at).toLocaleString('en-AU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</td>
                      <td>{a.username}</td><td>{a.action}</td><td>{a.kind === 'sale' ? 'All Sales' : a.kind === 'inventory' ? 'Inventory' : ''}</td><td>{a.detail}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </Layout>
  );
}

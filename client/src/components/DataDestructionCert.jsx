import { useRef, useState } from 'react';
import { ShieldCheck, X, Upload } from 'lucide-react';
import { readSpreadsheet } from '../storage/sheetReader';

// "Data Destruction Certificate" on a job: pick the customer's spreadsheet,
// check what was read, then download the PDF certificate. The columns are found
// by their headings (Category / Model Name / Model Number / Serial Number, or
// the usual alternatives like Item, Make, Model, Serial).
const COLS = [
  { key: 'item', label: 'Item', names: ['category', 'item', 'itemtype', 'type', 'devicetype', 'device', 'assetclass', 'class'] },
  { key: 'make', label: 'Make', names: ['modelname', 'make', 'manufacturer', 'brand', 'vendor'] },
  { key: 'model', label: 'Model', names: ['modelnumber', 'modelno', 'model', 'modelnum', 'partnumber'] },
  { key: 'serial', label: 'Serial number', names: ['serialnumber', 'serial', 'serialno', 'sn', 'sno', 'servicetag'] },
];
const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

export function matchColumns(headers) {
  const keys = headers.map(norm);
  const used = new Set();
  const map = {};
  COLS.forEach((c) => {
    // Exact name first (so "Model Name" goes to Make, not Model), in priority order.
    for (const n of c.names) {
      const i = keys.findIndex((k, j) => k === n && !used.has(j));
      if (i >= 0) { map[c.key] = i; used.add(i); return; }
    }
  });
  return map;
}

const cellText = (v) => {
  if (v == null) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).trim();
};

function todayYmd() {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Sydney', day: '2-digit', month: '2-digit', year: 'numeric' })
    .formatToParts(new Date()).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

export default function DataDestructionCert({ api, job }) {
  const fileRef = useRef(null);
  const [sheet, setSheet] = useState(null); // { fileName, headers, map, rows }
  const [customer, setCustomer] = useState('');
  const [issueDate, setIssueDate] = useState(todayYmd());
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function onFile(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setError('');
    try {
      const { headers, data } = await readSpreadsheet(file);
      const map = matchColumns(headers);
      const rows = data.map((r) => Object.fromEntries(COLS.map((c) => [c.key, map[c.key] != null ? cellText(r[map[c.key]]) : ''])))
        .filter((r) => r.item || r.make || r.model || r.serial);
      setSheet({ fileName: file.name, headers, map, rows });
      setCustomer(job.account_name || job.contact_name || '');
      setIssueDate(todayYmd());
    } catch (err) {
      setSheet(null);
      alert(err.message || 'Could not read that file');
    }
  }

  const missing = sheet ? COLS.filter((c) => sheet.map[c.key] == null) : [];

  async function create() {
    setBusy(true);
    setError('');
    try {
      const res = await api.post(`/jobs/${job.id}/data-destruction-certificate`, { rows: sheet.rows, customer, issueDate }, { responseType: 'blob' });
      const name = res.headers['x-filename'] || `${job.job_number}_Certificate_of_Data_Destruction.pdf`;
      const url = window.URL.createObjectURL(new Blob([res.data], { type: 'application/pdf' }));
      const a = document.createElement('a');
      a.href = url; a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => window.URL.revokeObjectURL(url), 10000);
      setSheet(null);
    } catch (err) {
      let msg = 'Could not create the certificate';
      try { msg = JSON.parse(await err.response.data.text()).error || msg; } catch { /* not JSON */ }
      setError(msg);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button className="btn btn-ghost btn-sm" onClick={() => fileRef.current?.click()} title="Make a Certificate of Data Destruction from the customer's spreadsheet">
        <ShieldCheck size={14} /> Data Destruction Certificate
      </button>
      <input ref={fileRef} type="file" accept=".xlsx,.csv" style={{ display: 'none' }} onChange={onFile} />

      {sheet && (
        <div className="modal-overlay" onClick={() => !busy && setSheet(null)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 680 }}>
            <div className="modal-header">
              <h3>Certificate of Data Destruction — Job #{job.job_number}</h3>
              {!busy && <button type="button" onClick={() => setSheet(null)}><X size={18} /></button>}
            </div>
            {error && <div className="error-banner">{error}</div>}
            <p style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 12 }}>
              Read <strong>{sheet.rows.length}</strong> device{sheet.rows.length === 1 ? '' : 's'} from <strong>{sheet.fileName}</strong>. Check the details, then create the PDF.
            </p>
            {missing.length > 0 && (
              <div className="error-banner" style={{ background: '#fdf1d6', color: '#8a5d00' }}>
                Couldn't find a column for: {missing.map((c) => c.label).join(', ')}. Those will show as N/A.
                The headings found were: {sheet.headers.filter(Boolean).join(', ') || '(none)'}.
              </div>
            )}
            <div className="form-grid">
              <div className="field"><label>Customer</label><input value={customer} onChange={(e) => setCustomer(e.target.value)} maxLength={120} /></div>
              <div className="field"><label>Date of issue</label><input type="date" value={issueDate} onChange={(e) => setIssueDate(e.target.value)} /></div>
            </div>
            <div style={{ maxHeight: 260, overflow: 'auto', border: '1px solid var(--line)', borderRadius: 8, marginTop: 4 }}>
              <table className="ticket-table" style={{ fontSize: 12 }}>
                <thead><tr>{COLS.map((c) => <th key={c.key}>{c.label}</th>)}</tr></thead>
                <tbody>
                  {sheet.rows.slice(0, 200).map((r, i) => (
                    <tr key={i}>{COLS.map((c) => <td key={c.key}>{r[c.key] || <span style={{ color: 'var(--muted)' }}>N/A</span>}</td>)}</tr>
                  ))}
                </tbody>
              </table>
              {sheet.rows.length > 200 && <div style={{ fontSize: 12, color: 'var(--muted)', padding: 8 }}>…and {sheet.rows.length - 200} more (all are included in the PDF).</div>}
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
              <button type="button" className="btn btn-ghost" onClick={() => fileRef.current?.click()} disabled={busy} style={{ flex: 1 }}><Upload size={14} /> Choose a different file</button>
              <button type="button" className="btn btn-accent" onClick={create} disabled={busy || !sheet.rows.length || !customer.trim()} style={{ flex: 1 }}>
                {busy ? 'Creating…' : 'Create PDF certificate'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

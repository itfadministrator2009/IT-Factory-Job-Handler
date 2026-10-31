import { useState } from 'react';
import { Upload } from 'lucide-react';
import api from '../api';
import Layout from '../components/Layout';
import { useChecklistConfig } from '../checklist/common';

const tabKey = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const pad = (n) => String(n).padStart(2, '0');
// Excel dates come through as Dates at UTC midnight/time; keep the wall-clock values.
const cellText = (v) => (v instanceof Date
  ? `${v.getUTCFullYear()}-${pad(v.getUTCMonth() + 1)}-${pad(v.getUTCDate())} ${pad(v.getUTCHours())}:${pad(v.getUTCMinutes())}`
  : v === null || v === undefined ? '' : String(v));
const CHUNK = 1500;

// Tools — bring the old Google Sheet across (admins).
export default function ChecklistTools() {
  const { config, isAdmin, error: cfgError } = useChecklistConfig();
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');

  const importSheet = async (file) => {
    if (!file) return;
    setError(''); setMsg('');
    if (!/\.xlsx$/i.test(file.name)) { setError('Choose the .xlsx download of the Google Sheet (File → Download → Microsoft Excel).'); return; }
    setBusy('Reading the spreadsheet…');
    try {
      const mod = await import('read-excel-file/browser');
      const sheets = await mod.default(file);
      const results = [];
      for (const [key, device] of Object.entries(config.deviceTypes)) {
        const s = sheets.find((x) => tabKey(x.sheet) === tabKey(device.sheetName));
        if (!s || s.data.length < 2) continue;
        const headers = s.data[0].map(cellText);
        const rows = s.data.slice(1).map((r) => r.map(cellText)).filter((r) => r.some((c) => c.trim() !== ''));
        let added = 0; let updated = 0;
        for (let i = 0; i < rows.length; i += CHUNK) {
          setBusy(`Importing ${device.label}: ${Math.min(i + CHUNK, rows.length)} of ${rows.length}…`);
          const r = await api.post('/checklist/import', { deviceKey: key, headers, rows: rows.slice(i, i + CHUNK) });
          added += r.data.added; updated += r.data.updated;
        }
        results.push(`${device.label}: ${added} added, ${updated} updated`);
      }
      if (!results.length) throw new Error('No checklist tabs (Laptop, Desktop, iPhone, iPad, Monitor, AIO, Other IT Equipment) found in that file.');
      setMsg(`Imported from the Google Sheet — ${results.join(' · ')}. Importing again only updates the same Asset IDs, so it's safe to repeat.`);
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Import failed');
    }
    setBusy('');
  };

  return (
    <Layout>
      <div className="page-header"><div><h1>Asset Checklist tools</h1><div className="subtitle">Bring the old Google Sheet across.</div></div></div>
      {(cfgError || error) && <div className="error-banner">{cfgError || error}</div>}
      {msg && <div className="success-banner"><span>{msg}</span></div>}
      {config && !isAdmin && <div className="panel panel-pad muted">Only admins can import the Google Sheet.</div>}
      {config && isAdmin && (
        <div className="panel panel-pad">
          <h3 className="sales-form-h">Import from the Google Sheet</h3>
          <p className="muted" style={{ marginTop: 0 }}>
            In the old Asset Checklist sheet choose <b>File → Download → Microsoft Excel (.xlsx)</b>, then pick that file here.
            Every device tab comes across with its Asset IDs, technicians, ticked items, grades and platforms. Entries already
            in Sales Manager stay linked, and old photos stay in Google Drive with a link on each entry. New Asset IDs carry on
            from the highest number imported.
          </p>
          <label className={`btn btn-primary btn-sm ${busy ? 'disabled' : ''}`}>
            <Upload size={14} /> {busy || 'Choose .xlsx file'}
            <input type="file" accept=".xlsx" hidden disabled={!!busy} onChange={(e) => { importSheet(e.target.files[0]); e.target.value = ''; }} />
          </label>
        </div>
      )}
    </Layout>
  );
}

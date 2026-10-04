import { useState } from 'react';
import { Upload } from 'lucide-react';
import api from '../api';
import Drawer from './Drawer';
import { readSpreadsheet, utcYmd } from './sheetReader';

// The old app's "Match & update from spreadsheet": upload a sheet, pick its
// serial column and the column holding the new values, choose which field to
// fill, preview what matches, then apply. Every item with that serial (any
// client, ignoring case) gets the value; blank values are skipped.
const TARGETS = [
  ['referenceNumber', 'Reference number'], ['jobNumber', 'Job number'], ['poNumber', 'PO number'], ['orderNumber', 'Order number'],
  ['assetTag', 'Asset tag'], ['client', 'Client'], ['storageCentre', 'ITF storage centre'], ['location', 'Location'],
  ['condition', 'Condition'], ['item', 'Item'], ['make', 'Make'], ['model', 'Model'], ['quantity', 'Quantity'],
  ['priceWeek', 'Storage price per week (ex GST)'], ['startDate', 'Storage start date'], ['endDate', 'Storage end date'],
];
const squash = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const cell = (v) => (v instanceof Date ? utcYmd(v) : v == null ? '' : String(v).trim());

export default function MatchUpdateDrawer({ onClose, onDone }) {
  const [file, setFile] = useState(null);
  const [sheet, setSheet] = useState(null);
  const [serialCol, setSerialCol] = useState(-1);
  const [valueCol, setValueCol] = useState(-1);
  const [field, setField] = useState('referenceNumber');
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);

  async function pick(e) {
    const f = e.target.files?.[0];
    if (!f) return;
    setFile(f); setError(''); setSheet(null); setPreview(null); setResult(null);
    try {
      const s = await readSpreadsheet(f);
      if (!s.data.length) { setError('No data rows found under the header row.'); return; }
      setSheet(s);
      const sIdx = s.headers.findIndex((h) => squash(h).includes('serial'));
      const vIdx = s.headers.findIndex((h, i) => i !== sIdx && squash(h).includes('reference'));
      setSerialCol(sIdx); setValueCol(vIdx);
    } catch (err) {
      setError(`Could not read that file: ${err.message}`);
    }
  }

  const rows = () => sheet.data.map((r) => ({ serial: cell(r[serialCol]), value: cell(r[valueCol]) }));
  const ready = sheet && serialCol >= 0 && valueCol >= 0 && serialCol !== valueCol;
  const fieldLabel = TARGETS.find(([k]) => k === field)?.[1];

  async function run(dryRun) {
    setBusy(true); setError('');
    try {
      const { data } = await api.post('/storage/items/match-update', { field, rows: rows(), dryRun });
      if (dryRun) setPreview(data); else { setResult(data); onDone(); }
    } catch (err) {
      setError(err.response?.data?.error || 'Could not match the sheet');
    } finally {
      setBusy(false);
    }
  }

  if (result) {
    return (
      <Drawer title="Match & update — done" onClose={onClose} width={560}>
        <p>Updated <strong>{fieldLabel}</strong> on <strong>{result.updated}</strong> item(s).</p>
        {result.unmatchedCount > 0 && <p style={{ fontSize: 13, color: 'var(--muted)', marginTop: 8 }}>{result.unmatchedCount} serial(s) in the sheet didn't match any item.</p>}
      </Drawer>
    );
  }

  return (
    <Drawer title="Match & update from spreadsheet" subtitle="Fill one field on existing items, matched by serial number. Nothing is added or deleted." onClose={onClose} busy={busy} width={760}>
      {error && <div className="error-banner">{error}</div>}
      <label className="btn btn-ghost" style={{ cursor: 'pointer', marginBottom: 12 }}>
        <Upload size={14} /> {file ? file.name : 'Choose file (.xlsx or .csv)…'}
        <input type="file" accept=".xlsx,.csv" onChange={pick} style={{ display: 'none' }} />
      </label>
      {sheet && (
        <>
          <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 12 }}>{sheet.data.length} data row(s).</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))', gap: 10, marginBottom: 14 }}>
            <div className="field" style={{ margin: 0 }}><label>Serial column</label>
              <select value={serialCol} onChange={(e) => { setSerialCol(Number(e.target.value)); setPreview(null); }}>
                <option value={-1}>— choose —</option>
                {sheet.headers.map((h, i) => <option key={i} value={i}>{h || `(column ${i + 1})`}</option>)}
              </select>
            </div>
            <div className="field" style={{ margin: 0 }}><label>Column with the new values</label>
              <select value={valueCol} onChange={(e) => { setValueCol(Number(e.target.value)); setPreview(null); }}>
                <option value={-1}>— choose —</option>
                {sheet.headers.map((h, i) => <option key={i} value={i}>{h || `(column ${i + 1})`}</option>)}
              </select>
            </div>
            <div className="field" style={{ margin: 0 }}><label>Field to update</label>
              <select value={field} onChange={(e) => { setField(e.target.value); setPreview(null); }}>
                {TARGETS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
            </div>
          </div>
          <button type="button" className="btn btn-ghost" disabled={!ready || busy} onClick={() => run(true)}>{busy && !preview ? 'Checking…' : 'Preview matches'}</button>

          {preview && (
            <div className="panel panel-pad" style={{ marginTop: 14 }}>
              <div style={{ fontSize: 14, marginBottom: 8 }}>
                <strong>{preview.matchedRows}</strong> row(s) match <strong>{preview.itemsToUpdate}</strong> item(s), which will get a new <strong>{fieldLabel}</strong>.
              </div>
              <ul style={{ fontSize: 13, margin: '0 0 10px 18px', color: 'var(--muted)' }}>
                {preview.blank > 0 && <li>{preview.blank} row(s) have a blank value and will be skipped.</li>}
                {preview.noSerial > 0 && <li>{preview.noSerial} row(s) have no serial and will be skipped.</li>}
                {preview.unmatchedCount > 0 && <li>{preview.unmatchedCount} serial(s) don't match any item{preview.unmatched.length ? `: ${preview.unmatched.slice(0, 10).join(', ')}${preview.unmatchedCount > 10 ? '…' : ''}` : ''}.</li>}
                {preview.multiCount > 0 && <li>{preview.multiCount} serial(s) match more than one item, and all of them will be updated: {preview.multi.slice(0, 8).map((m) => `${m.serial} (${m.count})`).join(', ')}{preview.multiCount > 8 ? '…' : ''}.</li>}
                {preview.badValueCount > 0 && <li>{preview.badValueCount} value(s) aren't valid for this field and will be skipped: {preview.badValues.slice(0, 5).join('; ')}.</li>}
              </ul>
              <button type="button" className="btn btn-accent" disabled={busy || !preview.itemsToUpdate}
                onClick={() => { if (confirm(`Update ${fieldLabel} on ${preview.itemsToUpdate} item(s)?`)) run(false); }}>
                {busy ? 'Updating…' : `Update ${preview.itemsToUpdate} item(s)`}
              </button>
            </div>
          )}
        </>
      )}
    </Drawer>
  );
}

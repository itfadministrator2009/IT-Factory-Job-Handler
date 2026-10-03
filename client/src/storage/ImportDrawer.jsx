import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Upload, AlertTriangle } from 'lucide-react';
import api from '../api';
import Drawer from './Drawer';
import { ITEM_FIELDS, dedupeKey, isInStorage } from './common';

// Old "Import stock": read the first sheet of an .xlsx or a .csv, match its
// columns to manifest fields (editable), preview, warn about duplicates, then
// insert every row in one go. A hint matches when the header contains it
// (spaces and symbols ignored); hints starting with "=" must match exactly, so
// a short one like "po" doesn't catch "Depot".
const HINTS = {
  client: ['client', 'customer'], jobNumber: ['job'], referenceNumber: ['ref'], poNumber: ['po number', 'purchase order', '=po', '=pono', '=po#'],
  orderNumber: ['order number', '=order', '=orderno', '=order#'], storageCentre: ['centre', 'center', 'warehouse', 'branch', 'depot'],
  location: ['location', 'bay', 'shelf', 'rack'], quantity: ['qty', 'quantity'], condition: ['condition'],
  item: ['item', 'description', 'desc'], make: ['make', 'brand'], model: ['model'], serial: ['serial'],
  assetTag: ['asset tag', 'asset', '=tag'], priceWeek: ['price', 'rate'], startDate: ['start date', '=start'], endDate: ['end date', '=end'],
};
const squash = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

function guessMapping(headers) {
  const used = new Set();
  const mapping = {};
  ITEM_FIELDS.forEach(([field]) => {
    const hints = HINTS[field] || [];
    const hit = (h, hint) => (hint.startsWith('=') ? squash(h) === squash(hint.slice(1)) : squash(h).includes(squash(hint)));
    const idx = headers.findIndex((h, i) => !used.has(i) && hints.some((hint) => hit(h, hint)));
    mapping[field] = idx;
    if (idx >= 0) used.add(idx);
  });
  return mapping;
}

// Excel stores dates as day numbers; the reader turns them into Dates at UTC
// midnight, so the calendar date is read from the UTC parts.
const utcYmd = (d) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;

function cellValue(field, v) {
  if (v instanceof Date) return utcYmd(v);
  if (v == null) return '';
  return typeof v === 'number' && !['quantity', 'priceWeek', 'startDate', 'endDate'].includes(field) ? String(v) : (typeof v === 'string' ? v.trim() : v);
}

// Plain CSV (quoted fields, "" escapes, commas/newlines inside quotes). Values
// stay as typed text, so "3/8/2026" reaches the server as day/month.
function parseCsv(text) {
  const rows = []; let row = []; let field = ''; let quoted = false;
  const t = text.replace(/^\ufeff/, '');
  for (let i = 0; i < t.length; i += 1) {
    const c = t[i];
    if (quoted) {
      if (c === '"' && t[i + 1] === '"') { field += '"'; i += 1; } else if (c === '"') quoted = false; else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; } else if (c === '\n' || c === '\r') {
      if (c === '\r' && t[i + 1] === '\n') i += 1;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

async function readFileRows(file) {
  if (/\.csv$/i.test(file.name)) return { sheet: file.name, rows: parseCsv(await file.text()) };
  if (!/\.xlsx$/i.test(file.name)) throw new Error('Use an .xlsx or .csv file (old .xls files: open in Excel and Save As .xlsx).');
  const { readSheet } = await import('read-excel-file/browser');
  return { sheet: 'first sheet', rows: await readSheet(file) };
}

async function readSpreadsheet(file) {
  const { sheet, rows: all } = await readFileRows(file);
  const rows = all.filter((r) => r.some((v) => String(v ?? '').trim() !== ''));
  return { sheet, headers: (rows[0] || []).map((h) => String(h ?? '').trim()), data: rows.slice(1) };
}

export default function ImportDrawer({ items, onClose, onImported }) {
  const [file, setFile] = useState(null);
  const [parsed, setParsed] = useState(null);
  const [mapping, setMapping] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);

  async function pick(e) {
    const f = e.target.files?.[0];
    if (!f) return;
    setFile(f); setError(''); setParsed(null); setResult(null);
    try {
      const p = await readSpreadsheet(f);
      if (!p.data.length) { setError('No data rows found under the header row.'); return; }
      setParsed(p);
      setMapping(guessMapping(p.headers));
    } catch (err) {
      setError(`Could not read that file: ${err.message}`);
    }
  }

  const mapped = useMemo(() => {
    if (!parsed) return [];
    return parsed.data.map((row) => {
      const o = {};
      ITEM_FIELDS.forEach(([field]) => { const idx = mapping[field]; o[field] = idx >= 0 ? cellValue(field, row[idx]) : ''; });
      return o;
    });
  }, [parsed, mapping]);

  // Duplicates: rows matching an item already in storage, and rows repeated in the file.
  const dupes = useMemo(() => {
    const existing = new Set(items.filter(isInStorage).map(dedupeKey).filter(Boolean));
    const seen = new Map();
    const vsExisting = []; const inFile = [];
    mapped.forEach((r, i) => {
      const k = dedupeKey(r);
      if (!k) return;
      const label = `Row ${i + 2}: ${r.serial ? `serial ${r.serial}` : [r.client, r.item].filter(Boolean).join(' — ')}`;
      if (existing.has(k)) vsExisting.push(label);
      if (seen.has(k)) inFile.push(label); else seen.set(k, i);
    });
    return { vsExisting, inFile };
  }, [mapped, items]);

  async function doImport() {
    if (!(mapping.client >= 0) && !(mapping.item >= 0)) { alert('Map at least the Client or Item column before importing.'); return; }
    if ((dupes.vsExisting.length || dupes.inFile.length) && !confirm('Possible duplicates were found (see the warning). Import anyway?')) return;
    setBusy(true); setError('');
    try {
      const { data } = await api.post('/storage/items/import', { items: mapped });
      // Follow-up checks from the old app: imported locations with no pallet
      // rate, and locations nobody has classified as pallet / not pallet yet.
      const [pal, reg] = await Promise.all([api.get('/storage/pallets'), api.get('/storage/locations-registry')]);
      const lc = (v) => String(v || '').trim().toLowerCase();
      const norm = (v) => String(v || '').trim().replace(/\s+/g, ' ').toLowerCase();
      const covered = (r) => pal.data.pallets.some((p) => lc(p.client) === lc(r.client) && (
        (lc(p.storageCentre) === lc(r.storageCentre) && (lc(p.location) === lc(r.location) || p.location === '__ALL_AT_CENTRE__')) || p.location === '__ALL__'));
      const noRate = {};
      mapped.filter((r) => r.location && !(Number(r.priceWeek) > 0) && !covered(r)).forEach((r) => {
        (noRate[r.client || '(no client)'] ||= new Set()).add(r.location);
      });
      const classified = new Set(reg.data.locations.map((l) => norm(l.location)));
      const unclassified = new Set(mapped.map((r) => norm(r.location)).filter((l) => l && !classified.has(l)));
      setResult({ imported: data.imported, noRate: Object.entries(noRate).map(([c, s]) => [c, [...s]]), unclassified: unclassified.size });
      onImported();
    } catch (err) {
      setError(err.response?.data?.error || 'Import failed');
    } finally {
      setBusy(false);
    }
  }

  if (result) {
    return (
      <Drawer title="Import complete" onClose={onClose} width={640}>
        <p style={{ marginBottom: 14 }}>Imported <strong>{result.imported}</strong> item(s).</p>
        {result.noRate.length > 0 && (
          <div className="panel panel-pad" style={{ background: '#fbf1dc', marginBottom: 12 }}>
            <strong>Locations with no rate yet</strong>
            <p style={{ fontSize: 13, margin: '4px 0 8px' }}>These imported items have no weekly rate and no pallet rate covers their location, so they'd bill $0:</p>
            <ul style={{ fontSize: 13, margin: '0 0 8px 18px' }}>{result.noRate.map(([c, locs]) => <li key={c}><strong>{c}</strong>: {locs.join(', ')}</li>)}</ul>
            <Link to="/storage/pallets" className="btn btn-ghost btn-sm">Set pallet rates</Link>
          </div>
        )}
        {result.unclassified > 0 && (
          <div className="panel panel-pad" style={{ background: '#e6edf9' }}>
            <strong>{result.unclassified} location(s) not classified</strong>
            <p style={{ fontSize: 13, margin: '4px 0 8px' }}>Mark them as pallets (or not) so the client portal's pallet count is right.</p>
            <Link to="/storage/locations" className="btn btn-ghost btn-sm">Classify now</Link>
          </div>
        )}
      </Drawer>
    );
  }

  return (
    <Drawer title="Import stock" subtitle="Upload an Excel (.xlsx) or CSV file. The first sheet is used and its first row must be the column headers." onClose={onClose} busy={busy} width={1000}>
      {error && <div className="error-banner">{error}</div>}
      <label className="btn btn-ghost" style={{ cursor: 'pointer', marginBottom: 12 }}>
        <Upload size={14} /> {file ? file.name : 'Choose file…'}
        <input type="file" accept=".xlsx,.csv" onChange={pick} style={{ display: 'none' }} />
      </label>
      {parsed && (
        <>
          <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 12 }}>
            {parsed.headers.length} columns, {parsed.data.length} data row(s).
          </div>
          <h4 style={{ fontSize: 14, marginBottom: 8 }}>Match columns</h4>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', gap: 10, marginBottom: 16 }}>
            {ITEM_FIELDS.map(([field, label]) => (
              <div className="field" key={field} style={{ margin: 0 }}>
                <label>{label}</label>
                <select value={mapping[field] ?? -1} onChange={(e) => setMapping((m) => ({ ...m, [field]: Number(e.target.value) }))}>
                  <option value={-1}>— not in file —</option>
                  {parsed.headers.map((h, i) => <option key={i} value={i}>{h || `(column ${i + 1})`}</option>)}
                </select>
              </div>
            ))}
          </div>

          {(dupes.vsExisting.length > 0 || dupes.inFile.length > 0) && (
            <div className="error-banner" style={{ display: 'block' }}>
              <AlertTriangle size={14} style={{ verticalAlign: -2, marginRight: 6 }} />
              {dupes.vsExisting.length > 0 && <div><strong>{dupes.vsExisting.length}</strong> row(s) match items already in storage: {dupes.vsExisting.slice(0, 6).join('; ')}{dupes.vsExisting.length > 6 ? '…' : ''}</div>}
              {dupes.inFile.length > 0 && <div><strong>{dupes.inFile.length}</strong> row(s) repeat within the file: {dupes.inFile.slice(0, 6).join('; ')}{dupes.inFile.length > 6 ? '…' : ''}</div>}
            </div>
          )}

          <h4 style={{ fontSize: 14, marginBottom: 8 }}>Preview (first 5 rows)</h4>
          <div style={{ overflowX: 'auto', marginBottom: 16 }}>
            <table className="ticket-table">
              <thead><tr>{ITEM_FIELDS.filter(([f]) => mapping[f] >= 0).map(([f, l]) => <th key={f}>{l}</th>)}</tr></thead>
              <tbody>{mapped.slice(0, 5).map((r, i) => <tr key={i}>{ITEM_FIELDS.filter(([f]) => mapping[f] >= 0).map(([f]) => <td key={f}>{String(r[f] ?? '')}</td>)}</tr>)}</tbody>
            </table>
          </div>
          <button type="button" className="btn btn-accent" onClick={doImport} disabled={busy}>{busy ? 'Importing…' : `Import ${mapped.length} row(s)`}</button>
        </>
      )}
    </Drawer>
  );
}

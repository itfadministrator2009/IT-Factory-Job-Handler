import { useState } from 'react';
import { Upload } from 'lucide-react';
import api from '../api';
import Drawer from './Drawer';
import { readSpreadsheet } from './sheetReader';

// Brings across the classifications already made in the old Apps Script app
// (its "LocationsRegistry" tab: Location | Is Pallet | Classified By | Classified On).
const squash = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const cell = (v) => (v == null ? '' : String(v).trim());

export default function LocationsImportDrawer({ onClose, onDone }) {
  const [file, setFile] = useState(null);
  const [rows, setRows] = useState(null);
  const [sheetName, setSheetName] = useState('');
  const [overwrite, setOverwrite] = useState(false);
  const [preview, setPreview] = useState(null);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function check(list, ow) {
    setBusy(true); setError('');
    try {
      const { data } = await api.post('/storage/locations-registry/import', { rows: list, overwrite: ow, dryRun: true });
      setPreview(data);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not check the file');
    } finally {
      setBusy(false);
    }
  }

  async function pick(e) {
    const f = e.target.files?.[0];
    if (!f) return;
    setFile(f); setError(''); setRows(null); setPreview(null); setResult(null);
    try {
      const s = await readSpreadsheet(f, 'LocationsRegistry');
      const keys = s.headers.map(squash);
      const locCol = keys.findIndex((k) => k === 'location');
      const palletCol = keys.findIndex((k) => k === 'ispallet');
      const byCol = keys.findIndex((k) => k === 'classifiedby');
      if (locCol < 0 || palletCol < 0) {
        setError(`That doesn't look like the LocationsRegistry tab — it needs "Location" and "Is Pallet" columns (found: ${s.headers.filter(Boolean).join(', ') || 'none'}).`);
        return;
      }
      const list = s.data.map((r) => ({ location: cell(r[locCol]), isPallet: r[palletCol] === true ? true : cell(r[palletCol]), classifiedBy: byCol >= 0 ? cell(r[byCol]) : '' }));
      setSheetName(s.sheet); setRows(list);
      check(list, overwrite);
    } catch (err) {
      setError(`Could not read that file: ${err.message}`);
    }
  }

  async function save() {
    setBusy(true); setError('');
    try {
      const { data } = await api.post('/storage/locations-registry/import', { rows, overwrite });
      setResult(data); onDone();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not import');
    } finally {
      setBusy(false);
    }
  }

  if (result) {
    return (
      <Drawer title="Classifications imported" onClose={onClose} width={600}>
        <div>
          <p>Saved <strong>{result.saved}</strong> location classification(s) from the old app.</p>
          {result.stillUnclassifiedCount > 0 ? (
            <p style={{ fontSize: 13, color: 'var(--muted)', marginTop: 8 }}>
              {result.stillUnclassifiedCount} location(s) in use still need classifying (they weren't classified in the old app either): {result.stillUnclassified.slice(0, 20).join(', ')}{result.stillUnclassifiedCount > 20 ? '…' : ''}. Use the Unclassified filter to mark them.
            </p>
          ) : <p style={{ fontSize: 13, color: 'var(--muted)', marginTop: 8 }}>Every location in use is now classified.</p>}
        </div>
      </Drawer>
    );
  }

  return (
    <Drawer title="Import classifications from the old app" onClose={onClose} busy={busy} width={680}
      subtitle="Copies the pallet / not-pallet answers you already gave in the old Storage Centre app.">
      <div>
        <ol style={{ fontSize: 13, margin: '0 0 14px 18px', lineHeight: 1.6 }}>
          <li>Open the old Storage Centre Google Sheet and click the <strong>LocationsRegistry</strong> tab.</li>
          <li><strong>File → Download → Comma-separated values (.csv)</strong> (downloads just that tab). A whole-workbook .xlsx download also works.</li>
          <li>Choose that file below.</li>
        </ol>
        {error && <div className="error-banner">{error}</div>}
        <label className="btn btn-ghost" style={{ cursor: 'pointer', marginBottom: 12 }}>
          <Upload size={14} /> {file ? file.name : 'Choose file (.csv or .xlsx)…'}
          <input type="file" accept=".xlsx,.csv" onChange={pick} style={{ display: 'none' }} />
        </label>
        {rows && <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 12 }}>Read {rows.length} row(s) from {sheetName}.</div>}

        {preview && (
          <div className="panel panel-pad" style={{ marginTop: 6 }}>
            <div style={{ fontSize: 14, marginBottom: 8 }}>
              <strong>{preview.locations}</strong> location(s) in the file ({preview.pallets} pallet{preview.pallets === 1 ? '' : 's'}). <strong>{preview.toAdd + preview.toChange}</strong> will be saved.
            </div>
            <ul style={{ fontSize: 13, margin: '0 0 10px 18px', color: 'var(--muted)' }}>
              {preview.toAdd > 0 && <li>{preview.toAdd} aren't classified here yet and will be added.</li>}
              {preview.same > 0 && <li>{preview.same} are already classified the same way here.</li>}
              {preview.keptHere > 0 && <li>{preview.keptHere} were classified differently here; {overwrite ? 'they will be changed to the old app’s answer' : 'the Work Desk answer is kept'}.</li>}
              {preview.toChange > 0 && <li>{preview.toChange} will be changed to the old app's answer.</li>}
              {preview.blank > 0 && <li>{preview.blank} row(s) have no location and are skipped.</li>}
              <li>{preview.stillUnclassifiedCount === 0 ? 'Afterwards every location in use will be classified.' : `Afterwards ${preview.stillUnclassifiedCount} location(s) in use will still need classifying.`}</li>
            </ul>
            {(preview.keptHere > 0 || overwrite) && (
              <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13, marginBottom: 10 }}>
                <input type="checkbox" checked={overwrite} onChange={(e) => { setOverwrite(e.target.checked); check(rows, e.target.checked); }} />
                Use the old app's answer where they differ
              </label>
            )}
            <button type="button" className="btn btn-accent" disabled={busy || preview.toAdd + preview.toChange === 0} onClick={save}>
              {busy ? 'Saving…' : `Save ${preview.toAdd + preview.toChange} classification(s)`}
            </button>
          </div>
        )}
      </div>
    </Drawer>
  );
}

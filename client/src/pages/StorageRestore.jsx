import { useEffect, useState } from 'react';
import { RotateCcw, Upload, Download, Save, X } from 'lucide-react';
import api from '../api';
import { downloadFile } from '../utils/pdf';
import Layout from '../components/Layout';
import { noteTime } from '../storage/common';

// Restore Storage Centre data only (the old app's "Restore Backup"). Jobs,
// projects, users and the rest of Work Desk are not touched — for a full
// restore of everything, use Settings → Backup.
const fileToBase64 = (file) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(',')[1] || '');
  r.onerror = () => reject(new Error('Could not read the file'));
  r.readAsDataURL(file);
});
const kb = (n) => `${Math.max(1, Math.round((n || 0) / 1024))} KB`;

export default function StorageRestore() {
  const [sources, setSources] = useState(null);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(null); // { label, body, preview }
  const [confirmText, setConfirmText] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);

  function load() {
    api.get('/storage/restore/sources').then((r) => setSources(r.data)).catch((err) => setError(err.response?.data?.error || 'Could not load backups'));
  }
  useEffect(() => { load(); }, []);

  async function choose(label, body) {
    setError(''); setDone(null); setBusy(true);
    try {
      const { data } = await api.post('/storage/restore/preview', body);
      setPending({ label, body, preview: data }); setConfirmText('');
    } catch (err) {
      setError(err.response?.data?.error || 'Could not open that backup');
    } finally {
      setBusy(false);
    }
  }

  async function pickFile(e) {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    try { choose(`file “${f.name}”`, { source: 'upload', zipBase64: await fileToBase64(f) }); } catch (err) { setError(err.message); }
  }

  async function restoreNow() {
    setBusy(true); setError('');
    try {
      const { data } = await api.post('/storage/restore', { ...pending.body, confirm: 'RESTORE' });
      setDone({ label: pending.label, restored: data.restored });
      setPending(null);
      load();
    } catch (err) {
      setError(err.response?.data?.error || 'Restore failed');
    } finally {
      setBusy(false);
    }
  }

  async function savePoint() {
    setBusy(true);
    try { await api.post('/storage/restore/points', { reason: 'Saved by hand' }); load(); } catch (err) { setError(err.response?.data?.error || 'Could not save'); } finally { setBusy(false); }
  }

  return (
    <Layout>
      <div className="page-header">
        <div>
          <h1>Restore Storage Centre data</h1>
          <div className="subtitle">Puts the Storage Centre back to how it was in a backup. Jobs, projects, users and the rest of Work Desk are not touched.</div>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}
      {done && (
        <div className="success-banner" style={{ marginBottom: 16 }}>
          Restored from {done.label}: {Object.entries(done.restored).map(([f, n]) => `${f.replace('.csv', '')} ${n}`).join(', ')}.
          The data from just before the restore was saved as a restore point below, so this can be undone.
        </div>
      )}

      <div className="panel panel-pad" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 10 }}>
          <h3 style={{ fontSize: 15, flex: 1 }}>Restore points</h3>
          <button type="button" className="btn btn-ghost btn-sm" onClick={savePoint} disabled={busy}><Save size={14} /> Save a restore point now</button>
        </div>
        <p style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 10 }}>Saved automatically before every restore (the last 10 are kept), or by hand before a big change such as an import.</p>
        {!sources ? <div className="empty-state">Loading…</div> : sources.restorePoints.length === 0 ? (
          <div style={{ fontSize: 13, color: 'var(--muted)' }}>None yet.</div>
        ) : (
          <table className="ticket-table">
            <thead><tr><th>Saved</th><th>Why</th><th>By</th><th style={{ textAlign: 'right' }}>Items</th><th></th></tr></thead>
            <tbody>
              {sources.restorePoints.map((p) => (
                <tr key={p.id}>
                  <td style={{ whiteSpace: 'nowrap' }}>{noteTime(p.createdAt)}</td>
                  <td>{p.reason}</td>
                  <td>{p.createdBy || '—'}</td>
                  <td style={{ textAlign: 'right' }}>{p.counts?.['items.csv'] ?? '—'}</td>
                  <td style={{ whiteSpace: 'nowrap', textAlign: 'right' }}>
                    <button type="button" className="btn btn-ghost btn-sm" title="Download as a zip of CSVs"
                      onClick={() => downloadFile(api, `/storage/restore/points/${p.id}/download`, 'storage-centre-restore-point.zip').catch(() => alert('Could not download'))}><Download size={13} /></button>
                    <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => choose(`the restore point from ${noteTime(p.createdAt)}`, { source: 'point', pointId: p.id })}><RotateCcw size={13} /> Restore</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="panel panel-pad" style={{ marginBottom: 16 }}>
        <h3 style={{ fontSize: 15, marginBottom: 6 }}>Nightly backups on OneDrive</h3>
        {!sources ? null : sources.oneDriveError ? (
          <div style={{ fontSize: 13, color: 'var(--muted)' }}>{sources.oneDriveError}</div>
        ) : sources.oneDrive.length === 0 ? (
          <div style={{ fontSize: 13, color: 'var(--muted)' }}>No Storage Centre backups found yet. They upload each night as storage-centre-YYYY-MM-DD.zip.</div>
        ) : (
          <table className="ticket-table">
            <thead><tr><th>File</th><th>Uploaded</th><th style={{ textAlign: 'right' }}>Size</th><th></th></tr></thead>
            <tbody>
              {sources.oneDrive.map((b) => (
                <tr key={b.id}>
                  <td>{b.name}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>{new Date(b.lastModified).toLocaleString('en-AU', { timeZone: 'Australia/Sydney', dateStyle: 'medium', timeStyle: 'short' })}</td>
                  <td style={{ textAlign: 'right' }}>{kb(b.size)}</td>
                  <td style={{ textAlign: 'right' }}><button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => choose(b.name, { source: 'onedrive', backupId: b.id })}><RotateCcw size={13} /> Restore</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="panel panel-pad">
        <h3 style={{ fontSize: 15, marginBottom: 6 }}>From a file</h3>
        <p style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 10 }}>A Storage Centre backup zip: the nightly file from OneDrive, or one from Reports → Download backup.</p>
        <label className="btn btn-ghost" style={{ cursor: 'pointer' }}>
          <Upload size={14} /> Choose backup zip…
          <input type="file" accept=".zip" onChange={pickFile} style={{ display: 'none' }} />
        </label>
      </div>

      {pending && (
        <div className="modal-overlay" onClick={() => !busy && setPending(null)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 620 }}>
            <div className="modal-header">
              <h3>Restore from {pending.label}?</h3>
              {!busy && <button type="button" onClick={() => setPending(null)}><X size={18} /></button>}
            </div>
            {pending.preview.exportedAt && <p style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 10 }}>Backup taken {new Date(pending.preview.exportedAt).toLocaleString('en-AU', { timeZone: 'Australia/Sydney', dateStyle: 'medium', timeStyle: 'short' })}.</p>}
            <table className="ticket-table" style={{ marginBottom: 12 }}>
              <thead><tr><th>Data</th><th style={{ textAlign: 'right' }}>Now</th><th style={{ textAlign: 'right' }}>After restore</th></tr></thead>
              <tbody>
                {pending.preview.tables.map((t) => (
                  <tr key={t.file}>
                    <td>{t.label}</td>
                    <td style={{ textAlign: 'right' }}>{t.currentRows}</td>
                    <td style={{ textAlign: 'right', fontWeight: t.inBackup && t.backupRows !== t.currentRows ? 700 : 400 }}>{t.inBackup ? t.backupRows : 'unchanged'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p style={{ fontSize: 13, marginBottom: 10 }}>
              Everything in the Storage Centre is replaced with the backup, so changes made since then are lost. Portal logins are kept.
              The current data is saved as a restore point first, so you can undo this.
            </p>
            <div className="field"><label>Type RESTORE to confirm</label><input value={confirmText} onChange={(e) => setConfirmText(e.target.value)} autoFocus /></div>
            {error && <div className="error-banner">{error}</div>}
            <button type="button" className="btn btn-accent" disabled={busy || confirmText.trim().toUpperCase() !== 'RESTORE'} onClick={restoreNow}>
              {busy ? 'Restoring…' : 'Restore Storage Centre data'}
            </button>
          </div>
        </div>
      )}
    </Layout>
  );
}

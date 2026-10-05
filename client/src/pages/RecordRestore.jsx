import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { RotateCcw, Upload, Search, X, Undo2 } from 'lucide-react';
import api from '../api';
import Layout from '../components/Layout';
import { noteTime } from '../storage/common';

// Restore individual records — one job, one asset, one Storage Centre item… —
// from a backup, without rolling back anything else. Pick a backup, pick what
// kind of record, tick the ones to bring back. Every restore can be undone.
const STATUS = {
  deleted: { text: 'Deleted since', color: '#b42318', bg: '#fdecea' },
  changed: { text: 'Changed since', color: '#9a5b00', bg: '#fff4e0' },
  same: { text: 'Same as now', color: 'var(--muted)', bg: 'var(--surface-2, #f2f2f2)' },
};
const FIELD_NAMES = { fields_json: 'details', answers_json: 'answers', template_json: 'form', items_json: 'items' };
const fieldName = (f) => FIELD_NAMES[f] || f.replace(/_/g, ' ');
const when = (s) => new Date(s).toLocaleString('en-AU', { timeZone: 'Australia/Sydney', dateStyle: 'medium', timeStyle: 'short' });
const errText = (err, fallback) => err.response?.data?.error || fallback;

function Badge({ status }) {
  const s = STATUS[status];
  return <span style={{ display: 'inline-block', padding: '2px 8px', borderRadius: 10, fontSize: 12, fontWeight: 600, color: s.color, background: s.bg, whiteSpace: 'nowrap' }}>{s.text}</span>;
}

export default function RecordRestore() {
  const [params] = useSearchParams();
  const [sources, setSources] = useState(null);
  const [source, setSource] = useState(null); // { body, label }
  const [type, setType] = useState(params.get('type') || 'job');
  const [q, setQ] = useState('');
  const [show, setShow] = useState('changed');
  const [result, setResult] = useState(null);
  const [selected, setSelected] = useState(() => new Set());
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [done, setDone] = useState(null);
  const [log, setLog] = useState([]);

  const loadLog = () => api.get('/record-restore/log').then((r) => setLog(r.data.restores)).catch(() => {});
  useEffect(() => {
    api.get('/record-restore/sources').then((r) => setSources(r.data)).catch((err) => setError(errText(err, 'Could not load backups')));
    loadLog();
  }, []);

  const sections = useMemo(() => {
    const out = [];
    (sources?.types || []).forEach((t) => {
      let s = out.find((x) => x.name === t.section);
      if (!s) { s = { name: t.section, types: [] }; out.push(s); }
      s.types.push(t);
    });
    return out;
  }, [sources]);
  const typeLabel = sources?.types.find((t) => t.id === type)?.label || 'record';

  async function runSearch(src = source, { keepDone = false } = {}) {
    if (!src) return;
    setBusy('search'); setError('');
    if (!keepDone) setDone(null);
    try {
      const { data } = await api.post('/record-restore/search', { ...src.body, type, q, show });
      setResult(data);
      setSelected(new Set());
    } catch (err) {
      setError(errText(err, 'Could not read that backup'));
      setResult(null);
    } finally {
      setBusy('');
    }
  }
  // Re-run when the record type or filter changes.
  useEffect(() => { if (source) runSearch(); }, [type, show]); // eslint-disable-line react-hooks/exhaustive-deps

  function chooseOneDrive(b) {
    const src = { body: { source: 'onedrive', backupId: b.id, backupName: b.name }, label: `${b.name} (${when(b.lastModified)})` };
    setSource(src);
    runSearch(src);
  }

  async function pickFile(e) {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    setBusy('upload'); setError(''); setDone(null);
    try {
      const { data } = await api.post(`/record-restore/upload?name=${encodeURIComponent(f.name)}`, f, { headers: { 'Content-Type': 'application/octet-stream' } });
      const src = { body: { source: 'upload', uploadId: data.uploadId }, label: f.name };
      setSource(src);
      setBusy('');
      runSearch(src);
    } catch (err) {
      setError(errText(err, 'Could not open that file'));
      setBusy('');
    }
  }

  const records = result?.records || [];
  const allChosen = records.length > 0 && records.every((r) => selected.has(r.id));
  const toggle = (id) => setSelected((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const chosen = records.filter((r) => selected.has(r.id));

  async function restoreNow() {
    setBusy('restore'); setError('');
    try {
      const { data } = await api.post('/record-restore/restore', { ...source.body, type, ids: chosen.map((r) => r.id) });
      setDone(data);
      setConfirming(false);
      loadLog();
      runSearch(source, { keepDone: true });
    } catch (err) {
      setError(errText(err, 'Restore failed'));
    } finally {
      setBusy('');
    }
  }

  async function undo(entry) {
    if (!window.confirm(`Undo the restore of “${entry.label}”? ${entry.wasDeleted ? 'It will be removed again.' : 'It goes back to how it was just before the restore.'}`)) return;
    setError('');
    try {
      await api.post(`/record-restore/log/${entry.id}/undo`);
      loadLog();
      if (source) runSearch();
    } catch (err) {
      setError(errText(err, 'Could not undo'));
    }
  }

  return (
    <Layout>
      <div className="page-header">
        <div>
          <h1>Restore individual records</h1>
          <div className="subtitle">Bring back a job, asset, Storage Centre item and so on from a backup. Only the records you tick are changed — everything else stays as it is now.</div>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      {/* 1. Backup */}
      <div className="panel panel-pad" style={{ marginBottom: 16 }}>
        <h3 style={{ fontSize: 15, marginBottom: 8 }}>1. Choose a backup</h3>
        {source && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 14, marginBottom: 10 }}>
            <span>Using <strong>{source.label}</strong></span>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setSource(null); setResult(null); setDone(null); }}>Change</button>
          </div>
        )}
        {!source && (
          <>
            {!sources ? <div className="empty-state">Loading…</div> : sources.oneDriveError ? (
              <p style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 10 }}>{sources.oneDriveError}</p>
            ) : sources.backups.length === 0 ? (
              <p style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 10 }}>No nightly backups on OneDrive yet.</p>
            ) : (
              <div style={{ maxHeight: 260, overflowY: 'auto', marginBottom: 12 }}>
                <table className="ticket-table">
                  <thead><tr><th>Nightly backup</th><th>Taken</th><th></th></tr></thead>
                  <tbody>
                    {sources.backups.map((b) => (
                      <tr key={b.id}>
                        <td>{b.name}</td>
                        <td style={{ color: 'var(--muted)', whiteSpace: 'nowrap' }}>{when(b.lastModified)}</td>
                        <td style={{ textAlign: 'right' }}><button type="button" className="btn btn-ghost btn-sm" disabled={!!busy} onClick={() => chooseOneDrive(b)}>Use this backup</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <label className="btn btn-ghost btn-sm" style={{ cursor: 'pointer' }}>
              <Upload size={14} /> {busy === 'upload' ? 'Opening…' : 'Or choose a .db backup file…'}
              <input type="file" accept=".db,.sqlite" onChange={pickFile} style={{ display: 'none' }} disabled={!!busy} />
            </label>
            <p style={{ fontSize: 12, color: 'var(--muted)', marginTop: 8 }}>Opening a OneDrive backup downloads it first, which can take a little while.</p>
          </>
        )}
      </div>

      {/* 2. Records */}
      {source && (
        <div className="panel panel-pad" style={{ marginBottom: 16 }}>
          <h3 style={{ fontSize: 15, marginBottom: 8 }}>2. Find what to bring back</h3>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
            <select value={type} onChange={(e) => setType(e.target.value)} aria-label="Record type" style={{ minWidth: 240 }}>
              {sections.map((s) => (
                <optgroup key={s.name} label={s.name}>
                  {s.types.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
                </optgroup>
              ))}
            </select>
            <form onSubmit={(e) => { e.preventDefault(); runSearch(); }} style={{ display: 'flex', gap: 6, flex: 1, minWidth: 220 }}>
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search — job number, client, serial, name…" style={{ flex: 1 }} />
              <button type="submit" className="btn btn-ghost btn-sm" disabled={!!busy}><Search size={14} /> Search</button>
            </form>
            <select value={show} onChange={(e) => setShow(e.target.value)} aria-label="Show">
              <option value="changed">Only deleted or changed since</option>
              <option value="all">Everything in the backup</option>
            </select>
          </div>

          {done && (
            <div className="success-banner" style={{ marginBottom: 12, display: 'block' }}>
              Restored {done.restored} of {done.results.length}.
              {done.results.filter((r) => r.ok && r.missingFiles).length > 0 && ' Some photos or attachments could not come back because their files are no longer on the server.'}
              {done.results.filter((r) => !r.ok).map((r) => <div key={r.id} style={{ marginTop: 4 }}>✗ {r.title || r.id}: {r.error}</div>)}
              <div style={{ marginTop: 4, fontSize: 12 }}>Changed your mind? Use Undo under Recent restores below.</div>
            </div>
          )}

          {busy === 'search' ? <div className="empty-state">Reading the backup…</div> : !result ? null : result.note ? (
            <div className="empty-state">{result.note}</div>
          ) : records.length === 0 ? (
            <div className="empty-state">{show === 'changed' ? `No ${typeLabel.toLowerCase()} records have been deleted or changed since this backup${q ? ' that match your search' : ''}.` : 'Nothing found.'}</div>
          ) : (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 13, color: 'var(--muted)' }}>
                  {result.total > records.length ? `Showing the first ${records.length} of ${result.total} — search to narrow down` : `${records.length} record${records.length === 1 ? '' : 's'}`}
                  {chosen.length ? ` · ${chosen.length} ticked` : ''}
                </span>
                <button type="button" className="btn btn-accent btn-sm" style={{ marginLeft: 'auto' }} disabled={!chosen.length || !!busy} onClick={() => setConfirming(true)}>
                  <RotateCcw size={14} /> Restore {chosen.length ? `${chosen.length} ticked` : 'ticked'}
                </button>
              </div>
              <table className="ticket-table">
                <thead><tr>
                  <th style={{ width: 32 }}><input type="checkbox" checked={allChosen} onChange={() => setSelected(allChosen ? new Set() : new Set(records.map((r) => r.id)))} title="Tick all" /></th>
                  <th>{typeLabel}</th><th>Since the backup</th>
                </tr></thead>
                <tbody>
                  {records.map((r) => (
                    <tr key={r.id} className="clickable" onClick={() => toggle(r.id)} style={selected.has(r.id) ? { background: 'var(--accent-soft, #fdf0e8)' } : undefined}>
                      <td><input type="checkbox" checked={selected.has(r.id)} onChange={() => toggle(r.id)} onClick={(e) => e.stopPropagation()} /></td>
                      <td>
                        <div style={{ fontWeight: 600 }}>{r.title}</div>
                        {r.detail && <div style={{ fontSize: 12, color: 'var(--muted)' }}>{r.detail}</div>}
                      </td>
                      <td>
                        <Badge status={r.status} />
                        {r.status === 'changed' && <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 3 }}>{r.changed.map(fieldName).join(', ')}</div>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </div>
      )}

      {/* Recent restores */}
      <div className="panel panel-pad">
        <h3 style={{ fontSize: 15, marginBottom: 8 }}>Recent restores</h3>
        {log.length === 0 ? <div style={{ fontSize: 13, color: 'var(--muted)' }}>None yet.</div> : (
          <table className="ticket-table">
            <thead><tr><th>When</th><th>Record</th><th>From</th><th>By</th><th></th></tr></thead>
            <tbody>
              {log.map((l) => (
                <tr key={l.id} style={l.undone_at ? { opacity: 0.55 } : undefined}>
                  <td style={{ whiteSpace: 'nowrap' }}>{noteTime(l.restored_at)}</td>
                  <td><div>{l.label}</div><div style={{ fontSize: 12, color: 'var(--muted)' }}>{l.typeLabel}{l.wasDeleted ? ' · was deleted' : ''}</div></td>
                  <td style={{ fontSize: 12 }}>{l.backup_name}</td>
                  <td>{l.restored_by || '—'}</td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    {l.undone_at ? <span style={{ fontSize: 12 }}>Undone {noteTime(l.undone_at)}</span> : (
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => undo(l)}><Undo2 size={13} /> Undo</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {confirming && (
        <div className="modal-overlay" onClick={() => busy !== 'restore' && setConfirming(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 560 }}>
            <div className="modal-header">
              <h3>Restore {chosen.length} record{chosen.length === 1 ? '' : 's'}?</h3>
              {busy !== 'restore' && <button type="button" onClick={() => setConfirming(false)}><X size={18} /></button>}
            </div>
            <ul style={{ fontSize: 13, margin: '0 0 12px 18px', maxHeight: 200, overflowY: 'auto' }}>
              {chosen.slice(0, 50).map((r) => <li key={r.id}>{r.title} — <em>{STATUS[r.status].text.toLowerCase()}</em></li>)}
              {chosen.length > 50 && <li>…and {chosen.length - 50} more</li>}
            </ul>
            <p style={{ fontSize: 13, marginBottom: 12 }}>
              Each one goes back to exactly how it was in <strong>{source.label}</strong>, including its notes, line items and history.
              Changes made to these records since then are replaced. Nothing else in the app is touched, and you can undo this afterwards.
            </p>
            {error && <div className="error-banner">{error}</div>}
            <button type="button" className="btn btn-accent" disabled={busy === 'restore'} onClick={restoreNow}>
              {busy === 'restore' ? 'Restoring…' : `Restore ${chosen.length}`}
            </button>
          </div>
        </div>
      )}
    </Layout>
  );
}

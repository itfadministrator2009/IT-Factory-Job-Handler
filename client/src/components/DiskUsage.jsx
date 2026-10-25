import { useEffect, useState } from 'react';
import { HardDrive, RefreshCw, Minimize2 } from 'lucide-react';
import api from '../api';

// Settings → Disk usage: what is filling the server's disk. Read-only.
export function formatBytes(n) {
  const b = Number(n) || 0;
  if (b >= 1024 ** 3) return `${(b / 1024 ** 3).toFixed(2)} GB`;
  if (b >= 1024 ** 2) return `${(b / 1024 ** 2).toFixed(1)} MB`;
  if (b >= 1024) return `${Math.round(b / 1024)} KB`;
  return `${b} B`;
}

const BAR = 'var(--accent, #1d6b73)';

// One row per thing: label, a thin bar scaled to the biggest row, size and share.
function Bars({ rows, total, sub }) {
  const max = Math.max(...rows.map((r) => r.bytes), 1);
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(120px, 34%) 1fr', rowGap: 8, columnGap: 12, alignItems: 'center' }}>
      {rows.map((r) => (
        <div key={r.label} style={{ display: 'contents' }}>
          <div style={{ fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.label}>
            {r.label}{sub && sub(r) ? <span style={{ color: 'var(--muted)', fontSize: 12 }}> · {sub(r)}</span> : null}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }} title={`${r.label}: ${formatBytes(r.bytes)}`}>
            <div style={{ height: 14, width: `${Math.max((r.bytes / max) * 100, 0.5)}%`, maxWidth: 'calc(100% - 120px)', background: BAR, borderRadius: 4 }} />
            <span style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
              {formatBytes(r.bytes)}
              {total ? <span style={{ color: 'var(--muted)' }}> ({Math.round((r.bytes / total) * 100)}%)</span> : null}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

const card = { padding: 20, marginBottom: 18 };

// Shrinks the photos already on the server (new uploads are shrunk anyway).
function ShrinkPhotos({ onDone }) {
  const [status, setStatus] = useState(null);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get('/backup/shrink-photos').then((res) => setStatus(res.data)).catch(() => {});
  }, []);

  useEffect(() => {
    if (!status?.running) return undefined;
    const t = setTimeout(() => {
      api.get('/backup/shrink-photos').then((res) => {
        setStatus(res.data);
        if (!res.data.running) onDone();
      }).catch(() => {});
    }, 2000);
    return () => clearTimeout(t);
  }, [status, onDone]);

  async function start() {
    setConfirming(false); setError('');
    try { setStatus((await api.post('/backup/shrink-photos')).data); } catch (err) { setError(err.response?.data?.error || 'Could not start'); }
  }

  const saved = status ? status.before - status.after : 0;
  const pct = status?.total ? Math.round((status.done / status.total) * 100) : 0;

  return (
    <div className="panel" style={card}>
      <h3 style={{ fontSize: 15, marginBottom: 6 }}><Minimize2 size={14} style={{ verticalAlign: -2, marginRight: 6 }} />Shrink photos</h3>
      <p style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 12, lineHeight: 1.5 }}>
        New photos are now shrunk automatically when they're uploaded (to fit 1600 px, about 200–400 KB each — still sharp on screen and on job sheets).
        This shrinks the photos already stored the same way. It replaces the full-size files on the server; the nightly OneDrive backups keep the originals, so run <strong>Back up now</strong> on the Backup tab first if today's backup hasn't run.
      </p>
      {error && <div className="error-banner" style={{ marginBottom: 10 }}>{error}</div>}
      {status?.running ? (
        <div>
          <div style={{ fontSize: 13, marginBottom: 6 }}>Shrinking… {status.done} of {status.total} photos · {formatBytes(saved)} saved so far</div>
          <div style={{ height: 8, background: 'var(--border, #e2e0d8)', borderRadius: 4, overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${pct}%`, background: BAR }} />
          </div>
          <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 6 }}>You can leave this page — it keeps going on the server.</div>
        </div>
      ) : (
        <>
          {status?.finishedAt && (
            <div className="success-banner" style={{ marginBottom: 12 }}>
              Done: {status.shrunk} photo(s) shrunk, {formatBytes(saved)} freed{status.skipped ? ` · ${status.skipped} already small or not readable, left as they were` : ''}{status.failed ? ` · ${status.failed} failed` : ''}.
            </div>
          )}
          {confirming ? (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <span style={{ fontSize: 13 }}>Shrink all stored photos now?</span>
              <button type="button" className="btn btn-accent btn-sm" onClick={start}>Yes, shrink them</button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirming(false)}>Cancel</button>
            </div>
          ) : (
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirming(true)}>Shrink existing photos</button>
          )}
        </>
      )}
    </div>
  );
}
const h3 = { fontSize: 15, marginBottom: 12 };

export default function DiskUsage() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  function load() {
    setLoading(true); setError('');
    api.get('/backup/disk-usage').then((res) => setData(res.data))
      .catch((err) => setError(err.response?.data?.error || 'Could not measure disk usage'))
      .finally(() => setLoading(false));
  }
  useEffect(load, []);

  if (error) return <div className="error-banner">{error}</div>;
  if (!data) return <div className="empty-state"><h3>Measuring the disk…</h3><p>This can take a few seconds when there are lots of photos.</p></div>;

  const { disk, database, uploads, restorePoints, besideDatabase, tempFiles } = data;
  const uploadsTotal = uploads.byArea.reduce((t, a) => t + a.bytes, 0);
  const restoreBytes = (restorePoints.storage?.bytes || 0) + (restorePoints.records?.bytes || 0);
  const otherBytes = besideDatabase.items.reduce((t, i) => t + i.bytes, 0);
  const counted = database.total + uploadsTotal + otherBytes;
  const leftover = uploads.byArea.find((a) => a.name.startsWith('Not linked'));

  const overview = [
    { label: 'Uploaded files (photos & attachments)', bytes: uploadsTotal },
    { label: 'Database', bytes: database.total },
    ...(otherBytes ? [{ label: 'Other files on the disk', bytes: otherBytes }] : []),
  ].sort((a, b) => b.bytes - a.bytes);

  return (
    <div style={{ maxWidth: 860 }}>
      <div className="panel" style={card}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
          <h3 style={{ fontSize: 16, margin: 0 }}><HardDrive size={15} style={{ verticalAlign: -2, marginRight: 6 }} />Disk usage</h3>
          <button type="button" className="btn btn-ghost btn-sm" onClick={load} disabled={loading}><RefreshCw size={13} /> {loading ? 'Measuring…' : 'Measure again'}</button>
        </div>
        {disk && (
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 28, fontWeight: 700 }}>{formatBytes(disk.used)} <span style={{ fontSize: 15, fontWeight: 400, color: 'var(--muted)' }}>used of {formatBytes(disk.total)} · {formatBytes(disk.free)} free</span></div>
            <div style={{ height: 10, background: 'var(--border, #e2e0d8)', borderRadius: 5, marginTop: 8, overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${Math.min((disk.used / disk.total) * 100, 100)}%`, background: disk.used / disk.total > 0.85 ? 'var(--danger, #b42318)' : BAR }} />
            </div>
          </div>
        )}
        <Bars rows={overview} total={counted} />
        <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 10 }}>Measured {new Date(data.measuredAt).toLocaleString('en-AU')}. The disk is checked every hour: at 90% full the Super Admin is emailed, with a reminder each day it stays that full.</div>
      </div>

      <ShrinkPhotos onDone={load} />

      <div className="panel" style={card}>
        <h3 style={h3}>Uploaded files — {formatBytes(uploadsTotal)} in {uploads.byArea.reduce((t, a) => t + a.files, 0)} files</h3>
        <Bars rows={uploads.byArea.map((a) => ({ label: a.name, bytes: a.bytes, files: a.files }))} total={uploadsTotal} sub={(r) => `${r.files} files`} />
        {leftover && leftover.bytes > 0 && (
          <p style={{ fontSize: 12, color: 'var(--muted)', marginTop: 10 }}>"Not linked to anything" files are on the disk but no job or project uses them any more (for example left behind when something was deleted or restored).</p>
        )}
        <h4 style={{ fontSize: 13, margin: '18px 0 10px' }}>By type</h4>
        <Bars rows={uploads.byKind.map((k) => ({ label: k.name, bytes: k.bytes, files: k.files }))} total={uploadsTotal} sub={(r) => `${r.files} files`} />
        {uploads.byMonth.length > 0 && (<>
          <h4 style={{ fontSize: 13, margin: '18px 0 10px' }}>Added per month</h4>
          <Bars rows={uploads.byMonth.map((m) => ({ label: m.month, bytes: m.bytes, files: m.files }))} sub={(r) => `${r.files} files`} />
        </>)}
      </div>

      {uploads.topOwners.length > 0 && (
        <div className="panel" style={card}>
          <h3 style={h3}>Biggest jobs and projects</h3>
          <Bars rows={uploads.topOwners.map((o) => ({ label: o.owner, bytes: o.bytes, files: o.files }))} total={uploadsTotal} sub={(r) => `${r.files} files`} />
        </div>
      )}

      {uploads.largestFiles.length > 0 && (
        <div className="panel" style={{ ...card, padding: 0 }}>
          <h3 style={{ ...h3, padding: '20px 20px 0' }}>Largest files</h3>
          <div style={{ overflowX: 'auto' }}>
            <table className="ticket-table">
              <thead><tr><th>File</th><th>Belongs to</th><th>Added</th><th style={{ textAlign: 'right' }}>Size</th></tr></thead>
              <tbody>
                {uploads.largestFiles.map((f, i) => (
                  <tr key={i}>
                    <td style={{ maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={f.name}>{f.name}</td>
                    <td>{f.owner || <span style={{ color: 'var(--muted)' }}>{f.area}</span>}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{f.createdAt ? String(f.createdAt).slice(0, 10).split('-').reverse().join('/') : ''}</td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>{formatBytes(f.bytes)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="panel" style={card}>
        <h3 style={h3}>Database — {formatBytes(database.total)}</h3>
        {database.tables
          ? <Bars rows={database.tables.slice(0, 12).map((t) => ({ label: t.label, bytes: t.bytes }))} total={database.file} />
          : <p style={{ fontSize: 13, color: 'var(--muted)' }}>Table sizes aren't available on this server.</p>}
        <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 10, lineHeight: 1.6 }}>
          File {formatBytes(database.file)}{database.wal ? ` · write-ahead log ${formatBytes(database.wal)}` : ''}
          {database.reclaimable > 0 ? ` · ${formatBytes(database.reclaimable)} is empty space inside the file` : ''}
          {restoreBytes > 0 ? ` · restore points ${formatBytes(restoreBytes)} (${(restorePoints.storage?.count || 0)} Storage Centre, ${(restorePoints.records?.count || 0)} record restores)` : ''}
        </div>
      </div>

      {besideDatabase.items.length > 0 && (
        <div className="panel" style={card}>
          <h3 style={h3}>Other files on the disk — {formatBytes(otherBytes)}</h3>
          <Bars rows={besideDatabase.items.map((i) => ({ label: i.name, bytes: i.bytes, files: i.files }))} total={otherBytes} />
          <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 10 }}>Next to the database in {besideDatabase.dir}.</div>
        </div>
      )}

      {(tempFiles.files > 0 || uploads.missingFiles > 0) && (
        <div style={{ fontSize: 12, color: 'var(--muted)' }}>
          {tempFiles.files > 0 && <div>{tempFiles.files} temporary backup file(s), {formatBytes(tempFiles.bytes)}, left in the server's temp folder.</div>}
          {uploads.missingFiles > 0 && <div>{uploads.missingFiles} attachment/photo record(s) point to files that aren't on the disk.</div>}
        </div>
      )}
    </div>
  );
}

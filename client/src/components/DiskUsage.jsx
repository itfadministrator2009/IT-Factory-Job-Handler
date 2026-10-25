import { useEffect, useState } from 'react';
import { HardDrive, RefreshCw, Minimize2, Cloud, Server } from 'lucide-react';
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

// Render charges for the disk's full size every month, whether it's used or not.
const RENDER_USD_PER_GB = 0.25;

function RenderCost({ disk }) {
  // The disk is bought in whole GB; the filesystem reports a little less than that.
  const sizeGb = Math.max(1, Math.round(disk.total / 1024 ** 3));
  const cost = sizeGb * RENDER_USD_PER_GB;
  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 13, flexWrap: 'wrap' }}>
        <span><strong>{sizeGb} GB disk</strong> on Render</span>
        <span>About <strong>US${cost.toFixed(2)} a month</strong></span>
      </div>
      <p style={{ fontSize: 12, color: 'var(--muted)', margin: '4px 0 0' }}>
        Render charges US${RENDER_USD_PER_GB.toFixed(2)} per GB a month for the full disk size, used or not. Not included: the Render server plan itself. Your Render billing page shows the exact bill.
      </p>
    </div>
  );
}

// Cloudflare R2's free allowance and price above it (Standard storage, per month).
const R2_FREE_BYTES = 10 * 1024 ** 3;
const R2_USD_PER_GB = 0.015;

// How much of the free 10 GB is used, and what it costs once over.
function R2Allowance({ bytes }) {
  const used = Number(bytes) || 0;
  const pct = Math.min((used / R2_FREE_BYTES) * 100, 100);
  const over = Math.max(used - R2_FREE_BYTES, 0);
  const cost = (over / 1024 ** 3) * R2_USD_PER_GB;
  const colour = pct >= 90 ? 'var(--danger, #b42318)' : pct >= 75 ? 'var(--warning, #b54708)' : BAR;
  return (
    <div style={{ marginTop: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 13, marginBottom: 6, flexWrap: 'wrap' }}>
        <span><strong>{formatBytes(used)}</strong> of 10 GB free used</span>
        <span style={{ color: over ? 'var(--danger, #b42318)' : 'var(--muted)' }}>{over ? `About US$${cost.toFixed(2)} a month` : `${Math.round(pct)}% · US$0.00 a month`}</span>
      </div>
      <div style={{ height: 10, background: 'var(--border, #e2e0d8)', borderRadius: 5, overflow: 'hidden' }} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)} aria-label="Cloudflare R2 free allowance used">
        <div style={{ height: '100%', width: `${Math.max(pct, used ? 0.5 : 0)}%`, background: colour }} />
      </div>
      <p style={{ fontSize: 12, color: 'var(--muted)', margin: '6px 0 0' }}>
        {over
          ? `${formatBytes(over)} over the free 10 GB, charged at US$${R2_USD_PER_GB} per GB a month.`
          : `Free up to 10 GB. Above that it's US$${R2_USD_PER_GB} per GB a month (for example, 20 GB would be about US$0.15).`}
        {' '}Estimate from the files Work Desk keeps there; your Cloudflare dashboard shows the exact bill.
      </p>
    </div>
  );
}

// Where uploaded files live: the server disk, or Cloudflare R2 once it's set up.
function CloudFiles({ cloud }) {
  if (!cloud) return null;
  if (!cloud.enabled) {
    return (
      <div className="panel" style={card}>
        <h3 style={h3}><Cloud size={15} style={{ verticalAlign: -2, marginRight: 6 }} />Cloudflare R2</h3>
        <p style={{ fontSize: 13, color: 'var(--muted)', margin: 0 }}>Not set up — uploaded files are kept on the server disk. Add the R2 settings on Render to move them to Cloudflare R2.</p>
      </div>
    );
  }
  const when = cloud.lastSyncAt ? new Date(cloud.lastSyncAt).toLocaleString('en-AU') : null;
  return (
    <div className="panel" style={card}>
      <h3 style={h3}><Cloud size={15} style={{ verticalAlign: -2, marginRight: 6 }} />Cloudflare R2 <span style={{ fontSize: 12, fontWeight: 500, color: cloud.lastError ? 'var(--danger, #b42318)' : 'var(--success, #1f7a4d)', marginLeft: 6 }}>{cloud.lastError ? 'Problem' : 'Connected'}</span></h3>
      <div style={{ fontSize: 22, fontWeight: 700 }}>{formatBytes(cloud.bytes || 0)} <span style={{ fontSize: 14, fontWeight: 400, color: 'var(--muted)' }}>in {cloud.files || 0} file{cloud.files === 1 ? '' : 's'} (bucket {cloud.bucket})</span></div>
      <p style={{ fontSize: 13, color: 'var(--muted)', margin: '8px 0 0' }}>
        {cloud.waiting ? `${cloud.waiting} file${cloud.waiting === 1 ? '' : 's'} still to copy across — this happens in the background every 10 minutes. ` : 'Every file is in R2. '}
        New uploads go to R2 straight away; the copy on the server disk is removed an hour later.{when ? ` Last checked ${when}.` : ''}
      </p>
      <R2Allowance bytes={cloud.bytes} />
      {cloud.lastError && <div className="error-banner" style={{ marginTop: 10 }}>{cloud.lastError.message}. Files stay safely on the server disk until this is fixed.</div>}
    </div>
  );
}

export default function DiskUsage() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [view, setView] = useState('all');

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
  // The file breakdowns can show the Render disk, Cloudflare R2, or every file.
  const breakdowns = uploads.breakdowns || { render: uploads };
  const hasCloud = !!(data.cloud?.enabled || breakdowns.cloud?.files);
  const shown = hasCloud ? view : 'render';
  const bd = breakdowns[shown] || uploads;
  const bdTotal = bd.total ?? bd.byArea.reduce((t, a) => t + a.bytes, 0);
  const bdFiles = bd.files ?? bd.byArea.reduce((t, a) => t + a.files, 0);
  const placeLabel = { all: 'Render and Cloudflare R2', render: 'on the Render disk', cloud: 'in Cloudflare R2' }[shown];
  const leftover = bd.byArea.find((a) => a.name.startsWith('Not linked'));
  const VIEWS = [['all', 'Everything'], ['render', 'Render'], ['cloud', 'Cloudflare R2']];

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
        <h4 style={{ fontSize: 15, margin: '0 0 8px' }}><Server size={14} style={{ verticalAlign: -2, marginRight: 6 }} />Render <span style={{ fontSize: 12, fontWeight: 400, color: 'var(--muted)' }}>· server disk</span></h4>
        {disk && (
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 28, fontWeight: 700 }}>{formatBytes(disk.used)} <span style={{ fontSize: 15, fontWeight: 400, color: 'var(--muted)' }}>used of {formatBytes(disk.total)} · {formatBytes(disk.free)} free</span></div>
            <div style={{ height: 10, background: 'var(--border, #e2e0d8)', borderRadius: 5, marginTop: 8, overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${Math.min((disk.used / disk.total) * 100, 100)}%`, background: disk.used / disk.total > 0.85 ? 'var(--danger, #b42318)' : BAR }} />
            </div>
            <RenderCost disk={disk} />
          </div>
        )}
        <Bars rows={overview} total={counted} />
        <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 10 }}>Measured {new Date(data.measuredAt).toLocaleString('en-AU')}. The disk is checked every hour: at 90% full the Super Admin is emailed, with a reminder each day it stays that full.</div>
      </div>

      <CloudFiles cloud={data.cloud} />

      <ShrinkPhotos onDone={load} />

      <div className="panel" style={card}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
          <h3 style={{ ...h3, marginBottom: 0 }}>Uploaded files — {formatBytes(bdTotal)} in {bdFiles} file{bdFiles === 1 ? '' : 's'} <span style={{ fontSize: 13, fontWeight: 400, color: 'var(--muted)' }}>{placeLabel}</span></h3>
          {hasCloud && (
            <div className="mu-filters" role="tablist" aria-label="Show files">
              {VIEWS.map(([k, label]) => (
                <button key={k} type="button" role="tab" aria-selected={shown === k} className={'mu-filter' + (shown === k ? ' active' : '')} onClick={() => setView(k)}>
                  {label} <span className="mu-count">{breakdowns[k]?.files ?? 0}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        {bd.byArea.length ? (
          <Bars rows={bd.byArea.map((a) => ({ label: a.name, bytes: a.bytes, files: a.files }))} total={bdTotal} sub={(r) => `${r.files} files`} />
        ) : <p style={{ fontSize: 13, color: 'var(--muted)', margin: 0 }}>No uploaded files {placeLabel}.</p>}
        {leftover && leftover.bytes > 0 && (
          <p style={{ fontSize: 12, color: 'var(--muted)', marginTop: 10 }}>"Not linked to anything" files are stored but no job or project uses them any more (for example left behind when something was deleted or restored).</p>
        )}
        {bd.byKind.length > 0 && (<>
          <h4 style={{ fontSize: 13, margin: '18px 0 10px' }}>By type</h4>
          <Bars rows={bd.byKind.map((k) => ({ label: k.name, bytes: k.bytes, files: k.files }))} total={bdTotal} sub={(r) => `${r.files} files`} />
        </>)}
        {bd.byMonth.length > 0 && (<>
          <h4 style={{ fontSize: 13, margin: '18px 0 10px' }}>Added per month</h4>
          <Bars rows={bd.byMonth.map((m) => ({ label: m.month, bytes: m.bytes, files: m.files }))} sub={(r) => `${r.files} files`} />
        </>)}
      </div>

      {bd.topOwners.length > 0 && (
        <div className="panel" style={card}>
          <h3 style={h3}>Biggest jobs and projects <span style={{ fontSize: 13, fontWeight: 400, color: 'var(--muted)' }}>{placeLabel}</span></h3>
          <Bars rows={bd.topOwners.map((o) => ({ label: o.owner, bytes: o.bytes, files: o.files }))} total={bdTotal} sub={(r) => `${r.files} files`} />
        </div>
      )}

      {bd.largestFiles.length > 0 && (
        <div className="panel" style={{ ...card, padding: 0 }}>
          <h3 style={{ ...h3, padding: '20px 20px 0' }}>Largest files <span style={{ fontSize: 13, fontWeight: 400, color: 'var(--muted)' }}>{placeLabel}</span></h3>
          <div style={{ overflowX: 'auto' }}>
            <table className="ticket-table">
              <thead><tr><th>File</th><th>Belongs to</th>{hasCloud && <th>Where</th>}<th>Added</th><th style={{ textAlign: 'right' }}>Size</th></tr></thead>
              <tbody>
                {bd.largestFiles.map((f, i) => (
                  <tr key={i}>
                    <td style={{ maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={f.name}>{f.name}</td>
                    <td>{f.owner || <span style={{ color: 'var(--muted)' }}>{f.area}</span>}</td>
                    {hasCloud && <td style={{ whiteSpace: 'nowrap' }}>{f.where === 'Cloudflare R2' ? <><Cloud size={12} style={{ verticalAlign: -1, marginRight: 4 }} />R2</> : f.where === 'Both' ? 'Both' : <><Server size={12} style={{ verticalAlign: -1, marginRight: 4 }} />Render</>}</td>}
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
          {uploads.missingFiles > 0 && <div>{uploads.missingFiles} attachment/photo record(s) point to files that aren't on the disk or in Cloudflare R2.</div>}
        </div>
      )}
    </div>
  );
}

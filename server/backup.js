const fs = require('fs');
const os = require('os');
const path = require('path');
const archiver = require('archiver');
const { getAccessToken, configured: graphConfigured } = require('./calendar');
const { db } = require('./db');
const { buildStorageCentreZip } = require('./storageExport');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'helpdesk.db');
// Same folder every uploaded photo (job attachments and project entry photos alike)
// actually lives in — must match UPLOAD_DIR in routes/attachments.js and
// routes/projects.js exactly, or backups would silently miss real files.
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');
// Which mailbox's OneDrive holds the backups, and which folder within it. Reuses the
// same Azure AD app already set up for the calendar — just needs one more permission
// granted (Files.ReadWrite.All) in that same app registration.
const BACKUP_USER = process.env.BACKUP_ONEDRIVE_USER || process.env.MS_CALENDAR_USER;
const BACKUP_FOLDER = process.env.BACKUP_ONEDRIVE_FOLDER || 'WorkDeskBackups';
const BACKUP_TIMEZONE = process.env.BACKUP_TIMEZONE || 'Australia/Sydney';
const BACKUP_HOUR = Number(process.env.BACKUP_HOUR || 2); // local hour, in BACKUP_TIMEZONE

const configured = graphConfigured && !!BACKUP_USER;
if (!configured) {
  console.log('[backup] Cloud backups are not configured — needs the same Microsoft 365 setup as the calendar, plus BACKUP_ONEDRIVE_USER (or MS_CALENDAR_USER) set.');
}

function currentHourInTimezone(tz) {
  const parts = new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: tz }).formatToParts(new Date());
  let hour = parseInt(parts.find((p) => p.type === 'hour').value, 10);
  if (hour === 24) hour = 0;
  return hour;
}

function currentDateInTimezone(tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date()); // en-CA -> YYYY-MM-DD
}

let lastBackupDate = null;

// Uploads to OneDrive via a Graph "upload session" — the resumable-upload
// endpoint, which has no practical size ceiling. Graph caps each request at 60 MiB,
// so the file goes up in 10 MiB pieces (a multiple of 320 KiB, as Graph requires).
// `source` is a Buffer or a path to a file on disk; a file is read one piece at a
// time, so a large photo archive never has to fit in memory.
const CHUNK = 32 * 320 * 1024;
async function uploadBackupToOneDrive(source, filename) {
  const token = await getAccessToken();
  const filePath = `${BACKUP_FOLDER}/${filename}`;

  const sessionRes = await fetch(
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(BACKUP_USER)}/drive/root:/${filePath}:/createUploadSession`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': 'replace' } }),
    }
  );
  if (!sessionRes.ok) {
    throw new Error(`Could not create upload session (${sessionRes.status}): ${await sessionRes.text()}`);
  }
  const { uploadUrl } = await sessionRes.json();

  const isBuffer = Buffer.isBuffer(source);
  const size = isBuffer ? source.length : fs.statSync(source).size;
  if (size === 0) throw new Error(`${filename} is empty`);
  const fh = isBuffer ? null : await fs.promises.open(source, 'r');
  try {
    for (let start = 0; start < size; start += CHUNK) {
      const len = Math.min(CHUNK, size - start);
      let piece;
      if (isBuffer) piece = source.subarray(start, start + len);
      else {
        piece = Buffer.alloc(len);
        await fh.read(piece, 0, len, start);
      }
      const uploadRes = await fetch(uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Length': String(len), 'Content-Range': `bytes ${start}-${start + len - 1}/${size}` },
        body: piece,
      });
      if (!uploadRes.ok) {
        throw new Error(`Upload failed (${uploadRes.status}): ${await uploadRes.text()}`);
      }
    }
  } finally {
    if (fh) await fh.close();
  }
}

// Zips every file in a directory (attachments and photos are stored flat, one level
// deep) into a temporary file on disk — not into memory, which could run the
// server out of memory once there are a lot of photos.
function zipDirectoryToFile(sourceDir, outFile) {
  return new Promise((resolve, reject) => {
    const archive = archiver('zip', { zlib: { level: 6 } });
    const out = fs.createWriteStream(outFile);
    out.on('close', resolve);
    out.on('error', reject);
    archive.on('warning', (err) => { if (err.code !== 'ENOENT') reject(err); });
    archive.on('error', reject);
    archive.pipe(out);
    archive.directory(sourceDir, false);
    archive.finalize();
  });
}

// Progress of the current/last backup, so "Back up now" can run in the background
// and still report how it went — and, if the server restarted part-way, which step
// it was on. Kept in storage_meta so it survives a restart.
let running = null;
function meta() { return require('./storageTools'); }
function saveStatus(status) {
  try { meta().setMeta('backup_status', JSON.stringify(status)); } catch (err) { /* status only */ }
}
function backupStatus() {
  let last = null;
  try { const row = meta().getMeta('backup_status'); last = row ? JSON.parse(row.value) : null; } catch (err) { last = null; }
  if (last && last.state === 'running' && !running) {
    // Saved as running, but nothing is running in this process: the server
    // stopped (restart, redeploy or out of memory) during that step.
    last = { ...last, state: 'interrupted' };
  }
  return { running: !!running, last };
}

// Used by both the nightly scheduler and the admin "Back up now" button. Backs up
// the database, every uploaded photo/attachment, and the Storage Centre tables.
// Only one backup runs at a time; a second call while one is running shares it.
function runBackup(filenameOverride) {
  if (running) return running;
  running = doBackup(filenameOverride).finally(() => { running = null; });
  return running;
}

async function doBackup(filenameOverride) {
  const status = { state: 'running', step: 'database', startedAt: new Date().toISOString() };
  const early = !configured ? 'not_configured' : !fs.existsSync(DB_PATH) ? 'db_not_found' : null;
  if (early) {
    const result = { ok: false, reason: early };
    saveStatus({ ...status, state: 'failed', finishedAt: status.startedAt, result });
    return result;
  }
  const step = (name) => { status.step = name; saveStatus(status); console.log(`[backup] ${name}…`); };
  step('database');
  try {
    const buffer = await snapshotDatabase();
    const dateStr = currentDateInTimezone(BACKUP_TIMEZONE);
    const filename = filenameOverride || `helpdesk-backup-${dateStr}.db`;
    await uploadBackupToOneDrive(buffer, filename);
    // The database is the part that matters most — record it as soon as it's safe.
    try { meta().setMeta('last_backup_at', new Date().toISOString()); } catch (err) { /* status only */ }

    const warnings = [];
    let uploadsFilename = null;
    const hasUploads = fs.existsSync(UPLOAD_DIR) && fs.readdirSync(UPLOAD_DIR).length > 0;
    if (hasUploads) {
      step('photos');
      const tmpZip = path.join(os.tmpdir(), `workdesk-uploads-${process.pid}-${Date.now()}.zip`);
      try {
        await zipDirectoryToFile(UPLOAD_DIR, tmpZip);
        uploadsFilename = filenameOverride
          ? filenameOverride.replace(/\.db$/, '-uploads.zip')
          : `helpdesk-uploads-${dateStr}.zip`;
        await uploadBackupToOneDrive(tmpZip, uploadsFilename);
      } catch (err) {
        // The database backup already succeeded — don't fail the whole backup
        // because the (larger, slower) photo archive had a problem.
        console.error('[backup] Database backed up, but photo/attachment backup failed:', err.message);
        warnings.push(`Photos were not backed up: ${err.message}`);
        uploadsFilename = null;
      } finally {
        try { fs.unlinkSync(tmpZip); } catch (e) { /* already gone */ }
      }
    }

    // Storage Centre tables as CSVs, readable in Excel. Same rule as photos.
    step('storage centre');
    let storageFilename = null;
    try {
      const { buffer: zipBuffer } = await buildStorageCentreZip();
      storageFilename = filenameOverride
        ? filenameOverride.replace(/\.db$/, '-storage-centre.zip')
        : `storage-centre-${dateStr}.zip`;
      await uploadBackupToOneDrive(zipBuffer, storageFilename);
    } catch (err) {
      console.error('[backup] Database backed up, but the Storage Centre export failed:', err.message);
      warnings.push(`Storage Centre export was not backed up: ${err.message}`);
      storageFilename = null;
    }

    console.log(`[backup] Uploaded ${[filename, uploadsFilename, storageFilename].filter(Boolean).join(', ')} to ${BACKUP_USER}'s OneDrive (/${BACKUP_FOLDER})`);
    const result = { ok: true, folder: BACKUP_FOLDER, filename, uploadsFilename, storageFilename, warnings };
    saveStatus({ ...status, state: 'done', finishedAt: new Date().toISOString(), result });
    return result;
  } catch (err) {
    console.error('[backup] Failed:', err.message);
    const result = { ok: false, reason: 'upload_failed', error: err.message };
    saveStatus({ ...status, state: 'failed', finishedAt: new Date().toISOString(), result });
    return result;
  }
}

// A consistent copy of the live database. The database runs in WAL mode, so the
// newest changes can sit in the -wal file rather than the main file — copying the
// main file alone could miss them (or catch it mid-write). SQLite's online backup
// API copies a complete, consistent snapshot while the app keeps running.
async function snapshotDatabase() {
  const tmp = path.join(os.tmpdir(), `workdesk-snapshot-${process.pid}-${Date.now()}.db`);
  try {
    await db.backup(tmp);
    return fs.readFileSync(tmp);
  } finally {
    try { fs.unlinkSync(tmp); } catch (e) { /* already gone */ }
  }
}

// Lists every backup currently sitting in the OneDrive folder, newest first — used
// by the "Restore from backup" screen so an admin can see and pick one.
async function listBackups() {
  if (!configured) return { ok: false, reason: 'not_configured' };
  try {
    const token = await getAccessToken();
    const res = await fetch(
      `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(BACKUP_USER)}/drive/root:/${BACKUP_FOLDER}:/children?$orderby=lastModifiedDateTime desc&$top=200`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!res.ok) throw new Error(`Graph list failed (${res.status}): ${await res.text()}`);
    const data = await res.json();
    const backups = (data.value || [])
      .filter((f) => f.name.toLowerCase().endsWith('.db'))
      .map((f) => ({ id: f.id, name: f.name, size: f.size, lastModified: f.lastModifiedDateTime }));
    return { ok: true, backups };
  } catch (err) {
    console.error('[backup] Could not list backups:', err.message);
    return { ok: false, reason: 'list_failed', error: err.message };
  }
}

// Downloads one specific backup by its OneDrive item id (as returned by listBackups).
async function downloadBackup(itemId) {
  const token = await getAccessToken();
  const res = await fetch(
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(BACKUP_USER)}/drive/items/${itemId}/content`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) throw new Error(`Download failed (${res.status}): ${await res.text()}`);
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

// Checks once an hour whether it's the configured local hour in BACKUP_TIMEZONE and
// today's backup hasn't run yet. Timezone-aware (via Intl, no extra dependency) so
// "2am" means 2am in Sydney, not 2am UTC, and it stays correct across daylight saving.
function startBackupScheduler() {
  if (!configured) {
    console.log('[backup] Automated backups disabled.');
    return;
  }
  console.log(`[backup] Automated daily backups enabled — uploading to OneDrive around ${BACKUP_HOUR}:00 (${BACKUP_TIMEZONE}) each day.`);
  setInterval(() => {
    const today = currentDateInTimezone(BACKUP_TIMEZONE);
    if (currentHourInTimezone(BACKUP_TIMEZONE) === BACKUP_HOUR && lastBackupDate !== today) {
      lastBackupDate = today;
      runBackup();
    }
  }, 60 * 60 * 1000);
}

module.exports = { runBackup, backupStatus, listBackups, downloadBackup, startBackupScheduler, snapshotDatabase, DB_PATH };

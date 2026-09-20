const fs = require('fs');
const path = require('path');
const archiver = require('archiver');
const { getAccessToken, configured: graphConfigured } = require('./calendar');

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

// Uploads the live SQLite file to OneDrive via a Graph "upload session" — the
// resumable-upload endpoint, which (unlike the simple <4MB upload endpoint) has no
// practical size ceiling, so this keeps working as the database grows over the years.
async function uploadBackupToOneDrive(buffer, filename) {
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

  const uploadRes = await fetch(uploadUrl, {
    method: 'PUT',
    headers: {
      'Content-Length': String(buffer.length),
      'Content-Range': `bytes 0-${buffer.length - 1}/${buffer.length}`,
    },
    body: buffer,
  });
  if (!uploadRes.ok) {
    throw new Error(`Upload failed (${uploadRes.status}): ${await uploadRes.text()}`);
  }
}

// Used by both the nightly scheduler and the admin "Back up now" button.
// Zips every file in a directory (non-recursive concerns aside — attachments and
// photos are all stored flat, one level deep) into an in-memory buffer, ready to
// upload the same way the database file already is.
function zipDirectory(sourceDir) {
  return new Promise((resolve, reject) => {
    const archive = archiver('zip', { zlib: { level: 6 } });
    const chunks = [];
    archive.on('data', (chunk) => chunks.push(chunk));
    archive.on('end', () => resolve(Buffer.concat(chunks)));
    archive.on('warning', (err) => { if (err.code !== 'ENOENT') reject(err); });
    archive.on('error', reject);
    archive.directory(sourceDir, false);
    archive.finalize();
  });
}

// Used by both the nightly scheduler and the admin "Back up now" button. Backs up
// the database AND every uploaded photo/attachment — the database alone used to be
// the only thing backed up, which meant a lost disk would silently take every photo
// with it even though the database restored fine.
async function runBackup(filenameOverride) {
  if (!configured) return { ok: false, reason: 'not_configured' };
  if (!fs.existsSync(DB_PATH)) return { ok: false, reason: 'db_not_found' };

  try {
    const buffer = fs.readFileSync(DB_PATH);
    const dateStr = currentDateInTimezone(BACKUP_TIMEZONE);
    const filename = filenameOverride || `helpdesk-backup-${dateStr}.db`;
    await uploadBackupToOneDrive(buffer, filename);

    let uploadsFilename = null;
    const hasUploads = fs.existsSync(UPLOAD_DIR) && fs.readdirSync(UPLOAD_DIR).length > 0;
    if (hasUploads) {
      try {
        const zipBuffer = await zipDirectory(UPLOAD_DIR);
        uploadsFilename = filenameOverride
          ? filenameOverride.replace(/\.db$/, '-uploads.zip')
          : `helpdesk-uploads-${dateStr}.zip`;
        await uploadBackupToOneDrive(zipBuffer, uploadsFilename);
      } catch (err) {
        // The database backup already succeeded above — don't fail the whole
        // operation just because the (larger, slower) photo archive had a problem.
        // Callers can tell a photo backup didn't happen because uploadsFilename
        // comes back null.
        console.error('[backup] Database backed up, but photo/attachment backup failed:', err.message);
        uploadsFilename = null;
      }
    }

    console.log(`[backup] Uploaded ${filename}${uploadsFilename ? ` and ${uploadsFilename}` : ''} to ${BACKUP_USER}'s OneDrive (/${BACKUP_FOLDER})`);
    return { ok: true, folder: BACKUP_FOLDER, filename, uploadsFilename };
  } catch (err) {
    console.error('[backup] Failed:', err.message);
    return { ok: false, reason: 'upload_failed', error: err.message };
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

module.exports = { runBackup, listBackups, downloadBackup, startBackupScheduler, DB_PATH };

const fs = require('fs');
const path = require('path');
const { getAccessToken, configured: graphConfigured } = require('./calendar');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'helpdesk.db');
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
async function runBackup() {
  if (!configured) return { ok: false, reason: 'not_configured' };
  if (!fs.existsSync(DB_PATH)) return { ok: false, reason: 'db_not_found' };

  try {
    const buffer = fs.readFileSync(DB_PATH);
    const dateStr = currentDateInTimezone(BACKUP_TIMEZONE);
    const filename = `helpdesk-backup-${dateStr}.db`;
    await uploadBackupToOneDrive(buffer, filename);
    console.log(`[backup] Uploaded ${filename} to ${BACKUP_USER}'s OneDrive (/${BACKUP_FOLDER})`);
    return { ok: true, folder: BACKUP_FOLDER, filename };
  } catch (err) {
    console.error('[backup] Failed:', err.message);
    return { ok: false, reason: 'upload_failed', error: err.message };
  }
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

module.exports = { runBackup, startBackupScheduler };

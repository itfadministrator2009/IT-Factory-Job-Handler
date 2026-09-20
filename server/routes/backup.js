const express = require('express');
const fs = require('fs');
const path = require('path');
const { db } = require('../db');
const { authRequired } = require('../auth');
const { runBackup, listBackups, downloadBackup, DB_PATH } = require('../backup');

const router = express.Router();
router.use(authRequired);

function adminRequired(req, res, next) {
  const user = db.prepare('SELECT role FROM users WHERE id = ?').get(req.user.id);
  const isAdmin = user && (user.role === 'admin' || user.role === 'agent');
  if (!isAdmin) return res.status(403).json({ error: 'Admin access required' });
  next();
}

router.post('/now', adminRequired, async (req, res) => {
  const result = await runBackup();
  if (!result.ok) {
    const messages = {
      not_configured: 'Cloud backups are not set up — this needs the same Microsoft 365 connection as the calendar, plus BACKUP_ONEDRIVE_USER set.',
      db_not_found: 'Could not find the database file to back up.',
      upload_failed: `Could not upload the backup to OneDrive: ${result.error || 'unknown error'}`,
    };
    return res.status(400).json({ error: messages[result.reason] || 'Backup failed' });
  }
  res.json({ ok: true, folder: result.folder, filename: result.filename, uploadsFilename: result.uploadsFilename });
});

router.get('/list', adminRequired, async (req, res) => {
  const result = await listBackups();
  if (!result.ok) {
    const messages = {
      not_configured: 'Cloud backups are not set up.',
      list_failed: `Could not list backups: ${result.error || 'unknown error'}`,
    };
    return res.status(400).json({ error: messages[result.reason] || 'Could not list backups' });
  }
  res.json({ backups: result.backups });
});

// The actual restore work, separated from the route handler so it can be exercised
// directly in tests without needing to trigger the process exit that follows a real
// restore. Always takes a safety backup of the CURRENT database first — under a
// clearly distinct filename so it never collides with (or gets confused for) a
// normal scheduled backup — so a restore can itself be undone if it was a mistake.
async function performRestore(backupId) {
  const buffer = await downloadBackup(backupId);

  const safetyName = `pre-restore-safety-${new Date().toISOString().replace(/[:.]/g, '-')}.db`;
  const safetyResult = await runBackup(safetyName);
  if (!safetyResult.ok) {
    // Refuse to proceed if we couldn't even confirm the current state is safely
    // captured first — better to block the restore than risk losing data with no way back.
    throw new Error(`Could not take a safety backup before restoring (${safetyResult.reason}) — restore cancelled.`);
  }

  db.close();

  // WAL/SHM sidecar files reflect the OLD database's uncommitted state — they must
  // not carry over onto the restored file, or SQLite could apply stale, mismatched
  // journal data to it on next open.
  ['-wal', '-shm'].forEach((suffix) => {
    try { fs.unlinkSync(DB_PATH + suffix); } catch (e) { /* fine if it doesn't exist */ }
  });

  fs.writeFileSync(DB_PATH, buffer);
  return { safetyBackupName: safetyName };
}

router.post('/restore', adminRequired, async (req, res) => {
  const { backupId } = req.body;
  if (!backupId) return res.status(400).json({ error: 'backupId is required' });

  try {
    const result = await performRestore(backupId);
    res.json({ ok: true, safetyBackupName: result.safetyBackupName, message: 'Restored. The app will restart in a few seconds.' });
    // Give the response time to actually reach the browser before the process exits.
    // Render (or any process manager) restarts the service automatically, which is
    // the safest way to get a totally fresh, correctly-opened connection to the
    // restored file rather than trying to hot-swap the live connection in place.
    setTimeout(() => process.exit(0), 1000);
  } catch (err) {
    console.error('[backup] Restore failed:', err.message);
    res.status(500).json({ error: err.message || 'Restore failed' });
  }
});

module.exports = router;
module.exports.performRestore = performRestore; // exposed for testing only

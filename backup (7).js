const express = require('express');
const { db } = require('../db');
const { authRequired } = require('../auth');
const { runBackup } = require('../backup');

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
  res.json({ ok: true, folder: result.folder, filename: result.filename });
});

module.exports = router;

// Admin: restore individual records (a job, an asset, a Storage Centre item…)
// from a nightly backup without rolling back anything else. See recordRestore.js.
const express = require('express');
const { db } = require('../db');
const { authRequired } = require('../auth');
const { isAdminRole } = require('../permissions');
const { listBackups, downloadBackup } = require('../backup');
const rr = require('../recordRestore');

const router = express.Router();
router.use(authRequired);
router.use((req, res, next) => {
  const row = db.prepare('SELECT role FROM users WHERE id = ?').get(req.user.id);
  if (!row || !isAdminRole(row.role)) return res.status(403).json({ error: 'Only admins can restore records' });
  next();
});

const fail = (res, err) => res.status(err.status || 400).json({ error: err.message });

// The backup to read from: a OneDrive nightly backup (by id) or an upload.
async function openSource(body) {
  const { source, backupId, backupName, uploadId } = body || {};
  if (source === 'upload') {
    const c = rr.cached(uploadId);
    if (!c) throw Object.assign(new Error('That uploaded backup has expired — choose the file again.'), { status: 400 });
    return c;
  }
  if (source === 'onedrive') {
    if (!backupId) throw Object.assign(new Error('Choose a backup'), { status: 400 });
    const key = `onedrive:${backupId}`;
    return rr.cached(key) || rr.openBuffer(key, await downloadBackup(backupId), backupName || 'OneDrive backup');
  }
  throw Object.assign(new Error('Choose a backup'), { status: 400 });
}

router.get('/sources', async (req, res) => {
  let backups = []; let oneDriveError = null;
  try {
    const r = await listBackups();
    if (r.ok) backups = r.backups;
    else oneDriveError = r.reason === 'not_configured' ? 'OneDrive backups are not set up on this server — upload a .db backup file instead.' : (r.error || 'Could not list OneDrive backups');
  } catch (err) { oneDriveError = err.message; }
  res.json({ types: rr.typeList(), backups, oneDriveError });
});

// The .db file is sent as-is (not JSON) — backups are often bigger than the JSON limit.
router.post('/upload', express.raw({ type: 'application/octet-stream', limit: '500mb' }), (req, res) => {
  try {
    if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'Choose a backup file' });
    res.json({ uploadId: rr.registerUpload(req.body, String(req.query.name || '').slice(0, 200) || 'Uploaded backup') });
  } catch (err) { fail(res, err); }
});

router.post('/search', async (req, res) => {
  try {
    const src = await openSource(req.body);
    res.json({ backupName: src.name, ...rr.search(src.db, req.body.type, { q: req.body.q, show: req.body.show }) });
  } catch (err) { fail(res, err); }
});

router.post('/restore', async (req, res) => {
  try {
    const src = await openSource(req.body);
    const result = rr.restore(src.db, src.name, req.body.type, req.body.ids, req.user.name);
    console.log(`[record-restore] ${req.user.name} restored ${result.restored} ${req.body.type} record(s) from ${src.name}`);
    res.json(result);
  } catch (err) { fail(res, err); }
});

router.get('/log', (req, res) => res.json({ restores: rr.recentRestores() }));

router.post('/log/:id/undo', (req, res) => {
  try { res.json(rr.undo(req.params.id, req.user.name)); } catch (err) { fail(res, err); }
});

module.exports = router;

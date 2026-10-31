// ITF Asset Checklist API. Everyone with ITF Asset Checklist switched on (admins
// unless the Super Admin turned it off) can fill in, edit and delete checklists;
// the Google Sheet import is admin-only.
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { randomUUID } = require('crypto');
const { db } = require('../db');
const { authRequired } = require('../auth');
const { isAdminRole, currentRole, requireModule } = require('../permissions');
const { shrinkUpload } = require('../photoShrink');
const fileStore = require('../fileStore');
const checklist = require('../checklist');

const router = express.Router();
router.use(authRequired);
router.use(requireModule('checklist'));

const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => cb(null, `${randomUUID()}${path.extname(file.originalname || '') || '.jpg'}`),
  }),
  limits: { fileSize: 20 * 1024 * 1024, files: 20 },
  fileFilter: (req, file, cb) => cb(null, /^image\//.test(file.mimetype)),
});

const isAdmin = (req) => isAdminRole(currentRole(req.user.id));
const userName = (req) => db.prepare('SELECT name FROM users WHERE id = ?').get(req.user.id)?.name || req.user.name || 'Unknown';
// Multipart requests carry the form as a JSON "data" field; plain JSON requests as the body.
function formData(req) {
  if (req.body && typeof req.body.data === 'string') {
    try { return JSON.parse(req.body.data); } catch { return null; }
  }
  return req.body || {};
}
function discard(files) {
  (files || []).forEach((f) => { try { fs.unlinkSync(f.path); } catch { /* already gone */ } });
}
async function savePhotos(entryId, files, who) {
  for (const raw of files || []) {
    const file = await shrinkUpload(raw);
    db.prepare(`INSERT INTO checklist_photos (id, entry_id, stored_name, original_name, mime_type, size, created_at, uploaded_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(randomUUID(), entryId, file.filename, file.originalname, file.mimetype, file.size, Date.now(), who);
    fileStore.offloadSoon(file.filename, { dir: UPLOAD_DIR, contentType: file.mimetype }); // to Cloudflare R2, when set up
  }
}
function removePhoto(p) {
  db.prepare('DELETE FROM checklist_photos WHERE id = ?').run(p.id);
  try { fileStore.remove(p.stored_name, UPLOAD_DIR); } catch { /* best effort */ }
}
// Saving with "ITF Australia" adds it to Sales Manager; a problem there never loses the checklist.
function trySync(entryId) {
  try { return !!checklist.syncToSales(entryId); } catch (err) {
    console.error('[checklist] Sales Manager sync failed:', err.message);
    return false;
  }
}

router.get('/config', (req, res) => {
  res.json({ config: checklist.CONFIG, isAdmin: isAdmin(req), me: userName(req) });
});

router.get('/entries', (req, res) => {
  const key = String(req.query.device || '');
  if (!checklist.deviceOf(key)) return res.status(400).json({ error: 'Unknown device type' });
  res.json({ entries: checklist.listEntries(key) });
});

router.get('/entries/:id', (req, res) => {
  const entry = checklist.getEntry(req.params.id);
  if (!entry) return res.status(404).json({ error: 'This checklist no longer exists.' });
  res.json({ entry });
});

router.get('/check-serial', (req, res) => {
  const hit = checklist.findSerial(String(req.query.device || ''), req.query.serial, req.query.exclude || null);
  res.json(hit ? { duplicate: true, ...hit } : { duplicate: false });
});

router.post('/entries', upload.array('photos', 20), async (req, res) => {
  const data = formData(req);
  const device = data && checklist.deviceOf(data.deviceKey);
  if (!device) { discard(req.files); return res.status(400).json({ error: 'Unknown device type' }); }
  if (!String(data.grade || '').trim()) { discard(req.files); return res.status(400).json({ error: 'Please select a cosmetic grade.' }); }
  const who = userName(req);
  const id = checklist.createEntry(data.deviceKey, data, who);
  await savePhotos(id, req.files, who);
  const salesSynced = trySync(id);
  const entry = checklist.getEntry(id);
  res.status(201).json({ entry, salesSynced });
});

router.patch('/entries/:id', upload.array('photos', 20), async (req, res) => {
  const before = checklist.getEntry(req.params.id);
  if (!before) { discard(req.files); return res.status(404).json({ error: 'This checklist no longer exists.' }); }
  const data = formData(req);
  if (!data) { discard(req.files); return res.status(400).json({ error: 'Invalid form' }); }
  if (!String(data.grade || '').trim()) { discard(req.files); return res.status(400).json({ error: 'Please select a cosmetic grade.' }); }
  const who = userName(req);
  checklist.updateEntry(before.id, data, who);
  // Photos: keep the ones still listed, remove the rest, add the new ones.
  if (Array.isArray(data.keepPhotoIds)) {
    const keep = new Set(data.keepPhotoIds.map(String));
    db.prepare('SELECT * FROM checklist_photos WHERE entry_id = ?').all(before.id).filter((p) => !keep.has(p.id)).forEach(removePhoto);
  }
  if (Array.isArray(data.keepDrivePhotoIds)) {
    const keep = new Set(data.keepDrivePhotoIds.map(String));
    db.prepare('UPDATE checklist_entries SET drive_photo_ids = ? WHERE id = ?').run(before.drivePhotoIds.filter((x) => keep.has(x)).join(','), before.id);
  }
  await savePhotos(before.id, req.files, who);
  const salesSynced = trySync(before.id);
  res.json({ entry: checklist.getEntry(before.id), salesSynced });
});

// Send an "ITF Australia" entry to Sales Manager again (if it didn't go through).
router.post('/entries/:id/sync', (req, res) => {
  const entry = checklist.getEntry(req.params.id);
  if (!entry) return res.status(404).json({ error: 'This checklist no longer exists.' });
  if (entry.platform !== 'ITF Australia') return res.status(400).json({ error: "This entry isn't set to ITF Australia, so it's not meant to go to Sales Manager." });
  if (entry.salesItemId) return res.json({ ok: true, alreadySynced: true });
  try {
    checklist.syncToSales(entry.id);
    res.json({ ok: true, salesSynced: true });
  } catch (err) {
    res.status(500).json({ error: `Could not add it to Sales Manager: ${err.message}` });
  }
});

router.post('/entries/bulk-platform', (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : [];
  const platform = String(req.body?.platform || '').trim();
  let updated = 0;
  let synced = 0;
  const who = userName(req);
  ids.forEach((id) => {
    const changed = db.prepare('UPDATE checklist_entries SET platform = ?, last_edited_by = ?, updated_at = ? WHERE id = ?').run(platform, who, Date.now(), id).changes;
    if (!changed) return;
    updated += 1;
    const had = db.prepare('SELECT sales_item_id FROM checklist_entries WHERE id = ?').get(id).sales_item_id;
    if (platform === 'ITF Australia' && !had && trySync(id)) synced += 1;
  });
  res.json({ ok: true, updated, synced });
});

router.post('/entries/delete', (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : [];
  let deleted = 0;
  db.transaction(() => {
    ids.forEach((id) => {
      db.prepare('SELECT * FROM checklist_photos WHERE entry_id = ?').all(id).forEach(removePhoto);
      deleted += db.prepare('DELETE FROM checklist_entries WHERE id = ?').run(id).changes;
    });
  })();
  res.json({ ok: true, deleted });
});

router.get('/photos/:id', async (req, res) => {
  const p = db.prepare('SELECT * FROM checklist_photos WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Photo not found' });
  return fileStore.send(res, p.stored_name, { dir: UPLOAD_DIR, downloadName: p.original_name, contentType: p.mime_type });
});

router.get('/summary', (req, res) => {
  res.json(checklist.summary());
});

// The old Google Sheet: one call per tab, { deviceKey, headers, rows } (admins).
router.post('/import', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Only admins can import the Google Sheet.' });
  const { deviceKey, headers, rows } = req.body || {};
  if (!checklist.deviceOf(deviceKey)) return res.status(400).json({ error: 'Unknown device type' });
  if (!Array.isArray(headers) || !Array.isArray(rows)) return res.status(400).json({ error: 'No rows to import' });
  if (rows.length > 50000) return res.status(400).json({ error: 'Too many rows in one go' });
  try {
    res.json(checklist.importSheetRows(deviceKey, headers, rows, userName(req)));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;

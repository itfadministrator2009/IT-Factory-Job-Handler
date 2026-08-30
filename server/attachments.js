const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuid } = require('uuid');
const { db } = require('../db');
const { authRequired } = require('../auth');
const { canAccessJob } = require('../permissions');

const router = express.Router();
router.use(authRequired);

const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => cb(null, `${uuid()}${path.extname(file.originalname)}`),
});

const upload = multer({ storage, limits: { fileSize: 20 * 1024 * 1024 } });

router.post('/jobs/:jobId/attachments', upload.array('files', 10), (req, res) => {
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.jobId);
  if (!job || !canAccessJob(req.user, job)) return res.status(404).json({ error: 'Job not found' });
  if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'No files uploaded' });

  const inserted = req.files.map((file) => {
    const id = uuid();
    db.prepare(`
      INSERT INTO attachments (id, job_id, stored_name, original_name, mime_type, size, uploaded_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, req.params.jobId, file.filename, file.originalname, file.mimetype, file.size, req.user.id);
    return db.prepare('SELECT id, original_name, mime_type, size, created_at, uploaded_by FROM attachments WHERE id = ?').get(id);
  });

  res.status(201).json({ attachments: inserted });
});

router.get('/attachments/:id/download', (req, res) => {
  const att = db.prepare('SELECT * FROM attachments WHERE id = ?').get(req.params.id);
  if (!att) return res.status(404).json({ error: 'Attachment not found' });
  const job = db.prepare('SELECT owner_id FROM jobs WHERE id = ?').get(att.job_id);
  if (!job || !canAccessJob(req.user, job)) return res.status(404).json({ error: 'Attachment not found' });

  const filePath = path.join(UPLOAD_DIR, att.stored_name);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File missing on disk' });

  res.download(filePath, att.original_name);
});

router.delete('/attachments/:id', (req, res) => {
  const att = db.prepare('SELECT * FROM attachments WHERE id = ?').get(req.params.id);
  if (!att) return res.status(404).json({ error: 'Attachment not found' });
  const job = db.prepare('SELECT owner_id FROM jobs WHERE id = ?').get(att.job_id);
  if (!job || !canAccessJob(req.user, job)) return res.status(404).json({ error: 'Attachment not found' });

  const filePath = path.join(UPLOAD_DIR, att.stored_name);
  fs.unlink(filePath, () => {});
  db.prepare('DELETE FROM attachments WHERE id = ?').run(req.params.id);

  res.json({ ok: true });
});

module.exports = router;

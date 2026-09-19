const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuid } = require('uuid');
const { db } = require('../db');
const { authRequired } = require('../auth');
const { isAdminRole, currentRole } = require('../permissions');

const router = express.Router();
router.use(authRequired);

const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => cb(null, `${uuid()}${path.extname(file.originalname)}`),
  }),
  limits: { fileSize: 20 * 1024 * 1024 },
});

function isAdmin(userId) {
  return isAdminRole(currentRole(userId));
}

function isAssigned(projectId, userId) {
  return !!db.prepare('SELECT 1 FROM project_assignments WHERE project_id = ? AND user_id = ?').get(projectId, userId);
}

// A tech can see/act on a project only if assigned to it; an admin always can.
function canAccessProject(req, projectId) {
  return isAdmin(req.user.id) || isAssigned(projectId, req.user.id);
}

function canAccessEntry(req, entry) {
  return isAdmin(req.user.id) || entry.created_by === req.user.id;
}

function withAssignedUsers(project) {
  const assigned = db.prepare(`
    SELECT u.id, u.name, u.email FROM project_assignments pa
    JOIN users u ON u.id = pa.user_id
    WHERE pa.project_id = ?
    ORDER BY u.name
  `).all(project.id);
  return { ...project, template: JSON.parse(project.template_json), assignedUsers: assigned };
}

// ---------------------------------------------------------------------------
// Conditional logic engine — shared shape used both here (for submit validation)
// and on the frontend (for live show/hide while filling the form). A field's
// visibleIf/requiredIf both look like { field: 'other_field_id', equals: 'No' }
// or { field: 'other_field_id', notEmpty: true } or { field: 'other_field_id', empty: true },
// always scoped to fields within the same section (and same repeat instance, for
// repeatable sections) — that covers every real case in a form like this one.
// ---------------------------------------------------------------------------
function matchesCondition(cond, instanceAnswers) {
  if (!cond) return true;
  const val = instanceAnswers[cond.field];
  if (cond.equals !== undefined) return val === cond.equals;
  if (cond.notEmpty) return val !== undefined && val !== null && val !== '';
  if (cond.empty) return val === undefined || val === null || val === '';
  return true;
}

function isFieldVisible(field, instanceAnswers) {
  return matchesCondition(field.visibleIf, instanceAnswers);
}

function isFieldRequired(field, instanceAnswers) {
  if (field.required) return true;
  if (field.requiredIf) return matchesCondition(field.requiredIf, instanceAnswers);
  return false;
}

// Validates a full submission against the template — walks every section/field,
// respecting visibility (a hidden field is never required) and photo fields
// (checked against actual uploaded photos, not answers_json). Returns a list of
// human-readable problems; empty list means the entry is complete.
function validateSubmission(template, answers, entryId) {
  const problems = [];

  function hasPhoto(fieldId, repeatIndex) {
    const row = repeatIndex === undefined
      ? db.prepare('SELECT 1 FROM project_entry_photos WHERE entry_id = ? AND field_id = ? AND repeat_index IS NULL').get(entryId, fieldId)
      : db.prepare('SELECT 1 FROM project_entry_photos WHERE entry_id = ? AND field_id = ? AND repeat_index = ?').get(entryId, fieldId, repeatIndex);
    return !!row;
  }

  function hasValue(field, instanceAnswers, repeatIndex) {
    if (field.type === 'photo') return hasPhoto(field.id, repeatIndex);
    const v = instanceAnswers[field.id];
    return v !== undefined && v !== null && v !== '';
  }

  template.sections.forEach((section) => {
    if (section.repeatable) {
      const instances = Array.isArray(answers[section.id]) ? answers[section.id] : [];
      if (instances.length === 0) {
        problems.push(`"${section.title}" needs at least one entry.`);
        return;
      }
      instances.forEach((instanceAnswers, idx) => {
        section.fields.forEach((field) => {
          if (field.type === 'instruction') return;
          if (!isFieldVisible(field, instanceAnswers)) return;
          if (isFieldRequired(field, instanceAnswers) && !hasValue(field, instanceAnswers, idx)) {
            problems.push(`"${section.title}" #${idx + 1}: "${field.label}" is required.`);
          }
        });
      });
    } else {
      const instanceAnswers = answers[section.id] || {};
      section.fields.forEach((field) => {
        if (field.type === 'instruction') return;
        if (!isFieldVisible(field, instanceAnswers)) return;
        if (isFieldRequired(field, instanceAnswers) && !hasValue(field, instanceAnswers, undefined)) {
          problems.push(`"${section.title}": "${field.label}" is required.`);
        }
      });
    }
  });

  return problems;
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

router.get('/', (req, res) => {
  const projects = isAdmin(req.user.id)
    ? db.prepare('SELECT * FROM projects ORDER BY created_at DESC').all()
    : db.prepare(`
        SELECT p.* FROM projects p
        JOIN project_assignments pa ON pa.project_id = p.id
        WHERE pa.user_id = ?
        ORDER BY p.created_at DESC
      `).all(req.user.id);

  const withCounts = projects.map((p) => {
    const entryCount = db.prepare('SELECT COUNT(*) as c FROM project_entries WHERE project_id = ?').get(p.id).c;
    const assignedCount = db.prepare('SELECT COUNT(*) as c FROM project_assignments WHERE project_id = ?').get(p.id).c;
    return { id: p.id, name: p.name, description: p.description, created_at: p.created_at, entryCount, assignedCount };
  });
  res.json({ projects: withCounts });
});

router.post('/', (req, res) => {
  if (!isAdmin(req.user.id)) return res.status(403).json({ error: 'Only admins can create projects' });
  const { name, description, template } = req.body;
  if (!name || !template || !Array.isArray(template.sections)) {
    return res.status(400).json({ error: 'name and a template with sections are required' });
  }
  const id = uuid();
  db.prepare('INSERT INTO projects (id, name, description, template_json, created_by) VALUES (?, ?, ?, ?, ?)')
    .run(id, name, description || null, JSON.stringify(template), req.user.id);
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
  res.status(201).json({ project: withAssignedUsers(project) });
});

router.get('/:id', (req, res) => {
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!project || !canAccessProject(req, project.id)) return res.status(404).json({ error: 'Project not found' });
  res.json({ project: withAssignedUsers(project) });
});

router.patch('/:id', (req, res) => {
  if (!isAdmin(req.user.id)) return res.status(403).json({ error: 'Only admins can edit projects' });
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const { name, description, template } = req.body;
  const updates = [];
  const params = [];
  if (name !== undefined) { updates.push('name = ?'); params.push(name); }
  if (description !== undefined) { updates.push('description = ?'); params.push(description); }
  if (template !== undefined) { updates.push('template_json = ?'); params.push(JSON.stringify(template)); }
  if (updates.length === 0) return res.status(400).json({ error: 'Nothing to update' });
  updates.push("updated_at = datetime('now')");
  params.push(req.params.id);
  db.prepare(`UPDATE projects SET ${updates.join(', ')} WHERE id = ?`).run(...params);

  const updated = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  res.json({ project: withAssignedUsers(updated) });
});

router.delete('/:id', (req, res) => {
  if (!isAdmin(req.user.id)) return res.status(403).json({ error: 'Only admins can delete projects' });
  const result = db.prepare('DELETE FROM projects WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Project not found' });
  res.json({ ok: true });
});

router.post('/:id/assign', (req, res) => {
  if (!isAdmin(req.user.id)) return res.status(403).json({ error: 'Only admins can assign users' });
  const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const { user_id } = req.body;
  const targetUser = db.prepare('SELECT id FROM users WHERE id = ?').get(user_id);
  if (!targetUser) return res.status(400).json({ error: 'User not found' });

  try {
    db.prepare('INSERT INTO project_assignments (id, project_id, user_id) VALUES (?, ?, ?)').run(uuid(), req.params.id, user_id);
  } catch (e) {
    if (!/UNIQUE/i.test(e.message)) throw e; // already assigned — treat as success
  }
  const updated = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  res.json({ project: withAssignedUsers(updated) });
});

router.delete('/:id/assign/:userId', (req, res) => {
  if (!isAdmin(req.user.id)) return res.status(403).json({ error: 'Only admins can unassign users' });
  db.prepare('DELETE FROM project_assignments WHERE project_id = ? AND user_id = ?').run(req.params.id, req.params.userId);
  const updated = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!updated) return res.status(404).json({ error: 'Project not found' });
  res.json({ project: withAssignedUsers(updated) });
});

// ---------------------------------------------------------------------------
// Entries — one per site-visit / filled-out copy of the project's form
// ---------------------------------------------------------------------------

router.get('/:id/entries', (req, res) => {
  const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(req.params.id);
  if (!project || !canAccessProject(req, project.id)) return res.status(404).json({ error: 'Project not found' });

  const entries = isAdmin(req.user.id)
    ? db.prepare('SELECT * FROM project_entries WHERE project_id = ? ORDER BY entry_number DESC').all(req.params.id)
    : db.prepare('SELECT * FROM project_entries WHERE project_id = ? AND created_by = ? ORDER BY entry_number DESC').all(req.params.id, req.user.id);

  const withNames = entries.map((e) => ({
    ...e,
    answers: JSON.parse(e.answers_json),
    creator: db.prepare('SELECT id, name FROM users WHERE id = ?').get(e.created_by),
  }));
  res.json({ entries: withNames });
});

router.post('/:id/entries', (req, res) => {
  const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(req.params.id);
  if (!project || !canAccessProject(req, project.id)) return res.status(404).json({ error: 'Project not found' });

  const maxNum = db.prepare('SELECT MAX(entry_number) as m FROM project_entries WHERE project_id = ?').get(req.params.id).m;
  const entryNumber = (maxNum || 0) + 1;
  const id = uuid();
  db.prepare('INSERT INTO project_entries (id, project_id, entry_number, site_name, created_by) VALUES (?, ?, ?, ?, ?)')
    .run(id, req.params.id, entryNumber, req.body.site_name || null, req.user.id);

  const entry = db.prepare('SELECT * FROM project_entries WHERE id = ?').get(id);
  res.status(201).json({ entry: { ...entry, answers: JSON.parse(entry.answers_json) } });
});

router.get('/:id/entries/:entryId', (req, res) => {
  const entry = db.prepare('SELECT * FROM project_entries WHERE id = ? AND project_id = ?').get(req.params.entryId, req.params.id);
  if (!entry || !canAccessEntry(req, entry)) return res.status(404).json({ error: 'Entry not found' });

  const photos = db.prepare('SELECT id, field_id, repeat_index, original_name, mime_type, created_at FROM project_entry_photos WHERE entry_id = ?').all(entry.id);
  res.json({ entry: { ...entry, answers: JSON.parse(entry.answers_json) }, photos });
});

router.patch('/:id/entries/:entryId', (req, res) => {
  const entry = db.prepare('SELECT * FROM project_entries WHERE id = ? AND project_id = ?').get(req.params.entryId, req.params.id);
  if (!entry || !canAccessEntry(req, entry)) return res.status(404).json({ error: 'Entry not found' });
  if (entry.status === 'Submitted' && !isAdmin(req.user.id)) {
    return res.status(400).json({ error: 'This entry has already been submitted' });
  }

  const { answers, site_name, submit } = req.body;
  const updates = [];
  const params = [];
  if (answers !== undefined) { updates.push('answers_json = ?'); params.push(JSON.stringify(answers)); }
  if (site_name !== undefined) { updates.push('site_name = ?'); params.push(site_name); }

  if (submit) {
    const project = db.prepare('SELECT template_json FROM projects WHERE id = ?').get(req.params.id);
    const template = JSON.parse(project.template_json);
    const finalAnswers = answers !== undefined ? answers : JSON.parse(entry.answers_json);
    const problems = validateSubmission(template, finalAnswers, entry.id);
    if (problems.length > 0) {
      return res.status(400).json({ error: 'This entry is incomplete', problems });
    }
    updates.push("status = 'Submitted'", "submitted_at = datetime('now')");
  }

  if (updates.length === 0) return res.status(400).json({ error: 'Nothing to update' });
  updates.push("updated_at = datetime('now')");
  params.push(req.params.entryId);
  db.prepare(`UPDATE project_entries SET ${updates.join(', ')} WHERE id = ?`).run(...params);

  const updated = db.prepare('SELECT * FROM project_entries WHERE id = ?').get(req.params.entryId);
  res.json({ entry: { ...updated, answers: JSON.parse(updated.answers_json) } });
});

router.delete('/:id/entries/:entryId', (req, res) => {
  const entry = db.prepare('SELECT * FROM project_entries WHERE id = ? AND project_id = ?').get(req.params.entryId, req.params.id);
  if (!entry) return res.status(404).json({ error: 'Entry not found' });
  const isCreator = entry.created_by === req.user.id;
  if (!isAdmin(req.user.id) && !(isCreator && entry.status !== 'Submitted')) {
    return res.status(403).json({ error: 'Only an admin can delete a submitted entry' });
  }
  const photos = db.prepare('SELECT stored_name FROM project_entry_photos WHERE entry_id = ?').all(entry.id);
  photos.forEach((p) => fs.unlink(path.join(UPLOAD_DIR, p.stored_name), () => {}));
  db.prepare('DELETE FROM project_entries WHERE id = ?').run(req.params.entryId);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Photo evidence — one endpoint to upload/list/delete, tagged by field (and
// repeat instance index, for photos inside a repeatable section)
// ---------------------------------------------------------------------------

router.post('/:id/entries/:entryId/photos', upload.single('file'), (req, res) => {
  const entry = db.prepare('SELECT * FROM project_entries WHERE id = ? AND project_id = ?').get(req.params.entryId, req.params.id);
  if (!entry || !canAccessEntry(req, entry)) return res.status(404).json({ error: 'Entry not found' });
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const { field_id, repeat_index } = req.body;
  if (!field_id) return res.status(400).json({ error: 'field_id is required' });

  const id = uuid();
  db.prepare(`
    INSERT INTO project_entry_photos (id, entry_id, field_id, repeat_index, stored_name, original_name, mime_type)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, entry.id, field_id, repeat_index !== undefined && repeat_index !== '' ? Number(repeat_index) : null, req.file.filename, req.file.originalname, req.file.mimetype);

  const photo = db.prepare('SELECT id, field_id, repeat_index, original_name, mime_type, created_at FROM project_entry_photos WHERE id = ?').get(id);
  res.status(201).json({ photo });
});

router.get('/photos/:photoId/download', (req, res) => {
  const photo = db.prepare('SELECT * FROM project_entry_photos WHERE id = ?').get(req.params.photoId);
  if (!photo) return res.status(404).json({ error: 'Photo not found' });
  const entry = db.prepare('SELECT * FROM project_entries WHERE id = ?').get(photo.entry_id);
  if (!entry || !canAccessEntry(req, entry)) return res.status(404).json({ error: 'Photo not found' });

  const filePath = path.join(UPLOAD_DIR, photo.stored_name);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File missing on disk' });
  res.sendFile(filePath);
});

router.delete('/photos/:photoId', (req, res) => {
  const photo = db.prepare('SELECT * FROM project_entry_photos WHERE id = ?').get(req.params.photoId);
  if (!photo) return res.status(404).json({ error: 'Photo not found' });
  const entry = db.prepare('SELECT * FROM project_entries WHERE id = ?').get(photo.entry_id);
  if (!entry || !canAccessEntry(req, entry)) return res.status(404).json({ error: 'Photo not found' });

  fs.unlink(path.join(UPLOAD_DIR, photo.stored_name), () => {});
  db.prepare('DELETE FROM project_entry_photos WHERE id = ?').run(req.params.photoId);
  res.json({ ok: true });
});

module.exports = router;

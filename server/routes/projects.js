const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuid } = require('uuid');
const { db } = require('../db');
const { authRequired } = require('../auth');
const { isAdminRole, currentRole } = require('../permissions');
const { buildProjectEntryPdf } = require('../projectPdfBuilder');
const { notifyProjectEntryComplete, notifyProjectEntryAssigned } = require('../email');

// Fixed internal distribution list notified whenever a project entry is submitted —
// configurable via env var without a code change, defaulting to the addresses given.
const PROJECT_COMPLETE_EMAILS = (process.env.PROJECT_COMPLETE_EMAILS
  || 'sam@itfactory.com.au,tom@itfactory.com.au,rnahas@itfactory.com.au,michael@itfactory.com.au,admin@itfactory.com.au,elina@itfactory.com.au')
  .split(',').map((s) => s.trim()).filter(Boolean);

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

// A tech can see/act on an entry only if it's assigned to them; an admin always can.
// Projects themselves work the same way — a tech's Projects list only shows a
// project once at least one entry inside it has been assigned to them, matching
// exactly how the existing Jobs feature scopes techs to their own assigned work.
function canAccessEntry(req, entry) {
  return isAdmin(req.user.id) || entry.assigned_to === req.user.id;
}

function canAccessProject(req, projectId) {
  if (isAdmin(req.user.id)) return true;
  const row = db.prepare('SELECT 1 FROM project_entries WHERE project_id = ? AND assigned_to = ?').get(projectId, req.user.id);
  return !!row;
}

function withParsedTemplate(project) {
  return { ...project, template: JSON.parse(project.template_json) };
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
        SELECT DISTINCT p.* FROM projects p
        JOIN project_entries pe ON pe.project_id = p.id
        WHERE pe.assigned_to = ?
        ORDER BY p.created_at DESC
      `).all(req.user.id);

  const withCounts = projects.map((p) => {
    const entryCount = isAdmin(req.user.id)
      ? db.prepare('SELECT COUNT(*) as c FROM project_entries WHERE project_id = ?').get(p.id).c
      : db.prepare('SELECT COUNT(*) as c FROM project_entries WHERE project_id = ? AND assigned_to = ?').get(p.id, req.user.id).c;
    return { id: p.id, name: p.name, description: p.description, created_at: p.created_at, entryCount };
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
  res.status(201).json({ project: withParsedTemplate(project) });
});

router.get('/:id', (req, res) => {
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!project || !canAccessProject(req, project.id)) return res.status(404).json({ error: 'Project not found' });
  res.json({ project: withParsedTemplate(project) });
});

// Before a template update actually removes a question, checks whether any existing
// entry has a real answer sitting under it — if so, that answer would silently stop
// appearing anywhere (the entry view, the PDF) the moment the template changes,
// since both render strictly from the CURRENT template's list of questions. This
// doesn't block the change; it just tells the caller what's at stake so an admin
// can decide, rather than finding out by accident later.
function findAnsweredRemovedFields(oldTemplate, newTemplate, projectId) {
  const newFieldKeys = new Set();
  (newTemplate.sections || []).forEach((s) => (s.fields || []).forEach((f) => newFieldKeys.add(`${s.id}::${f.id}`)));

  const removedFields = [];
  (oldTemplate.sections || []).forEach((s) => {
    (s.fields || []).forEach((f) => {
      if (f.type === 'instruction') return; // never holds an answerable value
      if (!newFieldKeys.has(`${s.id}::${f.id}`)) {
        removedFields.push({ sectionId: s.id, sectionTitle: s.title, fieldId: f.id, fieldLabel: f.label, fieldType: f.type });
      }
    });
  });
  if (removedFields.length === 0) return [];

  const entries = db.prepare('SELECT id, answers_json FROM project_entries WHERE project_id = ?').all(projectId);
  const photosByEntry = new Map();
  function hasPhotoAnswer(entryId, fieldId) {
    if (!photosByEntry.has(entryId)) {
      photosByEntry.set(entryId, db.prepare('SELECT field_id FROM project_entry_photos WHERE entry_id = ?').all(entryId));
    }
    return photosByEntry.get(entryId).some((p) => p.field_id === fieldId);
  }

  function isAnswered(value) {
    return value !== undefined && value !== null && value !== '';
  }

  return removedFields.filter(({ sectionId, fieldId, fieldType }) => {
    return entries.some((entry) => {
      if (fieldType === 'photo') return hasPhotoAnswer(entry.id, fieldId);
      const answers = JSON.parse(entry.answers_json || '{}');
      const sectionAnswers = answers[sectionId];
      if (Array.isArray(sectionAnswers)) return sectionAnswers.some((instance) => isAnswered(instance?.[fieldId]));
      return isAnswered(sectionAnswers?.[fieldId]);
    });
  });
}

router.patch('/:id', (req, res) => {
  if (!isAdmin(req.user.id)) return res.status(403).json({ error: 'Only admins can edit projects' });
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const { name, description, template, force } = req.body;

  if (template !== undefined && !force) {
    const oldTemplate = JSON.parse(project.template_json);
    const answeredRemoved = findAnsweredRemovedFields(oldTemplate, template, req.params.id);
    if (answeredRemoved.length > 0) {
      return res.status(409).json({
        requiresConfirmation: true,
        warnings: answeredRemoved.map((f) => `"${f.sectionTitle}" → "${f.fieldLabel}"`),
      });
    }
  }

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
  res.json({ project: withParsedTemplate(updated) });
});

router.delete('/:id', (req, res) => {
  if (!isAdmin(req.user.id)) return res.status(403).json({ error: 'Only admins can delete projects' });
  const result = db.prepare('DELETE FROM projects WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Project not found' });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Entries — one per site-visit, created by an admin and assigned to a tech
// (or admin), matching how Jobs already works: admin logs it, assigns an owner,
// the assigned person is the only non-admin who can see or work it.
// ---------------------------------------------------------------------------

router.get('/:id/entries', (req, res) => {
  const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(req.params.id);
  if (!project || !canAccessProject(req, project.id)) return res.status(404).json({ error: 'Project not found' });

  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const offset = (page - 1) * limit;

  const scoped = !isAdmin(req.user.id);
  const whereClause = scoped ? 'WHERE project_id = ? AND assigned_to = ?' : 'WHERE project_id = ?';
  const whereParams = scoped ? [req.params.id, req.user.id] : [req.params.id];

  const total = db.prepare(`SELECT COUNT(*) as c FROM project_entries ${whereClause}`).get(...whereParams).c;
  const entries = db.prepare(`SELECT * FROM project_entries ${whereClause} ORDER BY entry_number DESC LIMIT ? OFFSET ?`).all(...whereParams, limit, offset);

  const withNames = entries.map((e) => ({
    ...e,
    answers: JSON.parse(e.answers_json),
    assignee: e.assigned_to ? db.prepare('SELECT id, name FROM users WHERE id = ?').get(e.assigned_to) : null,
  }));
  res.json({ entries: withNames, total, page, totalPages: Math.max(1, Math.ceil(total / limit)) });
});

// Admin-only: create a new entry with just a site name and who it's assigned to —
// the assigned person fills in the rest of the form themselves later.
function userName(userId) {
  if (!userId) return null;
  return db.prepare('SELECT name FROM users WHERE id = ?').get(userId)?.name || null;
}

function logEntryAudit(entryId, field, oldValue, newValue, changedBy) {
  db.prepare('INSERT INTO project_entry_audit (id, entry_id, field, old_value, new_value, changed_by) VALUES (?, ?, ?, ?, ?, ?)')
    .run(uuid(), entryId, field, oldValue ?? null, newValue ?? null, changedBy);
}

// Notifies whoever a project entry is newly assigned to — fires only when there's
// an actual new assignee (clearing to unassigned sends nothing), matching the same
// pattern already used for Jobs. Fire-and-forget with its own .catch, since a mail
// hiccup here should never affect the actual assignment succeeding.
function notifyEntryAssignment(newAssignedTo, projectName, entry) {
  if (!newAssignedTo) return;
  const target = db.prepare('SELECT email FROM users WHERE id = ?').get(newAssignedTo);
  if (!target?.email) return;
  notifyProjectEntryAssigned({
    toEmail: target.email,
    projectName,
    entryNumber: entry.entry_number,
    siteName: entry.site_name,
  }).catch((err) => {
    console.error('[projects] Could not send entry-assigned email:', err.message);
  });
}

router.post('/:id/entries', (req, res) => {
  if (!isAdmin(req.user.id)) return res.status(403).json({ error: 'Only admins can create entries' });
  const project = db.prepare('SELECT id, name FROM projects WHERE id = ?').get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const { site_name, assigned_to } = req.body;
  if (assigned_to) {
    const target = db.prepare('SELECT id FROM users WHERE id = ?').get(assigned_to);
    if (!target) return res.status(400).json({ error: 'Assigned user not found' });
  }

  const maxNum = db.prepare('SELECT MAX(entry_number) as m FROM project_entries WHERE project_id = ?').get(req.params.id).m;
  const entryNumber = (maxNum || 0) + 1;
  const id = uuid();
  db.prepare('INSERT INTO project_entries (id, project_id, entry_number, site_name, assigned_to, created_by) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, req.params.id, entryNumber, site_name || null, assigned_to || null, req.user.id);

  const entry = db.prepare('SELECT * FROM project_entries WHERE id = ?').get(id);
  if (assigned_to) logEntryAudit(id, 'assigned_to', null, userName(assigned_to), req.user.id);
  notifyEntryAssignment(assigned_to, project.name, entry);
  res.status(201).json({ entry: { ...entry, answers: JSON.parse(entry.answers_json) } });
});

// ---------------------------------------------------------------------------
// Bulk actions on entries — all admin-only, matching how bulk actions work on
// the main Jobs list (select several, reassign/delete/email them at once).
// Deliberately placed BEFORE the /:id/entries/:entryId routes below: Express
// matches routes in the order they're declared, and :entryId would otherwise
// swallow "bulk" as if it were a literal entry id.
// ---------------------------------------------------------------------------

function validateRecipients(recipients) {
  if (recipients === undefined) return null;
  if (!Array.isArray(recipients) || recipients.length === 0) return 'At least one recipient is required';
  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const invalid = recipients.find((r) => typeof r !== 'string' || !emailPattern.test(r.trim()));
  if (invalid !== undefined) return `"${invalid}" doesn't look like a valid email address`;
  return null;
}

// Not tied to one specific entry — used to pre-fill the bulk-email dialog before
// any particular entries are even known to have been selected.
router.get('/:id/email-defaults', (req, res) => {
  const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(req.params.id);
  if (!project || !canAccessProject(req, project.id)) return res.status(404).json({ error: 'Project not found' });
  res.json({ recipients: PROJECT_COMPLETE_EMAILS });
});

router.patch('/:id/entries/bulk', (req, res) => {
  if (!isAdmin(req.user.id)) return res.status(403).json({ error: 'Only admins can bulk-edit entries' });
  const { ids, assigned_to } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'ids array is required' });
  if (assigned_to === undefined) return res.status(400).json({ error: 'assigned_to is required' });
  if (assigned_to) {
    const target = db.prepare('SELECT id FROM users WHERE id = ?').get(assigned_to);
    if (!target) return res.status(400).json({ error: 'Assigned user not found' });
  }
  const project = db.prepare('SELECT name FROM projects WHERE id = ?').get(req.params.id);

  let updated = 0;
  ids.forEach((entryId) => {
    const entry = db.prepare('SELECT * FROM project_entries WHERE id = ? AND project_id = ?').get(entryId, req.params.id);
    if (!entry) return; // silently skip anything not actually in this project
    db.prepare("UPDATE project_entries SET assigned_to = ?, updated_at = datetime('now') WHERE id = ?").run(assigned_to || null, entryId);
    updated++;
    if ((assigned_to || null) !== entry.assigned_to) {
      logEntryAudit(entryId, 'assigned_to', userName(entry.assigned_to), userName(assigned_to), req.user.id);
    }
    if (assigned_to && assigned_to !== entry.assigned_to) {
      notifyEntryAssignment(assigned_to, project.name, entry);
    }
  });
  res.json({ ok: true, updated });
});

router.post('/:id/entries/bulk-delete', (req, res) => {
  if (!isAdmin(req.user.id)) return res.status(403).json({ error: 'Only admins can bulk-delete entries' });
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'ids array is required' });

  let deleted = 0;
  ids.forEach((entryId) => {
    const entry = db.prepare('SELECT id FROM project_entries WHERE id = ? AND project_id = ?').get(entryId, req.params.id);
    if (!entry) return;
    const entryPhotos = db.prepare('SELECT stored_name FROM project_entry_photos WHERE entry_id = ?').all(entryId);
    entryPhotos.forEach((p) => fs.unlink(path.join(UPLOAD_DIR, p.stored_name), () => {}));
    db.prepare('DELETE FROM project_entries WHERE id = ?').run(entryId);
    deleted++;
  });
  res.json({ ok: true, deleted });
});

// Sequential (not parallel) on purpose — each one generates a full PDF, so running
// many at once in parallel could spike memory on a large batch. A partial failure
// (one bad photo file, say) doesn't stop the rest — every result is reported back.
router.post('/:id/entries/bulk-email-pdf', async (req, res) => {
  if (!isAdmin(req.user.id)) return res.status(403).json({ error: 'Only admins can bulk-email entries' });
  const { ids, recipients } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'ids array is required' });
  const recipientError = validateRecipients(recipients);
  if (recipientError) return res.status(400).json({ error: recipientError });

  const results = [];
  for (const entryId of ids) {
    const entry = db.prepare('SELECT * FROM project_entries WHERE id = ? AND project_id = ?').get(entryId, req.params.id);
    if (!entry) { results.push({ entryId, ok: false, error: 'Not found' }); continue; }
    try {
      const sentTo = await sendCompletionEmail(req.params.id, entryId, recipients);
      results.push({ entryId, entryNumber: entry.entry_number, ok: true, sentTo });
    } catch (err) {
      results.push({ entryId, entryNumber: entry.entry_number, ok: false, error: err.message });
    }
  }
  const failed = results.filter((r) => !r.ok);
  res.json({ ok: failed.length === 0, results, sentCount: results.length - failed.length, failedCount: failed.length });
});

router.get('/:id/entries/:entryId', (req, res) => {
  const entry = db.prepare('SELECT * FROM project_entries WHERE id = ? AND project_id = ?').get(req.params.entryId, req.params.id);
  if (!entry || !canAccessEntry(req, entry)) return res.status(404).json({ error: 'Entry not found' });

  const photos = db.prepare('SELECT id, field_id, repeat_index, original_name, mime_type, created_at FROM project_entry_photos WHERE entry_id = ?').all(entry.id);
  const assignee = entry.assigned_to ? db.prepare('SELECT id, name FROM users WHERE id = ?').get(entry.assigned_to) : null;
  const audit = db.prepare('SELECT * FROM project_entry_audit WHERE entry_id = ? ORDER BY changed_at DESC').all(entry.id)
    .map((a) => ({ ...a, user: a.changed_by ? db.prepare('SELECT id, name FROM users WHERE id = ?').get(a.changed_by) : null }));
  res.json({ entry: { ...entry, answers: JSON.parse(entry.answers_json), assignee }, photos, audit });
});

// Builds the PDF and emails it to the fixed distribution list — shared by the
// automatic send-on-submit below and the manual "Email PDF" button, so both stay
// identical in what they generate and send. An explicit recipients list (from the
// "Email PDF" dialog, where someone can add/remove addresses before sending)
// overrides the default distribution list; the automatic send-on-submit never
// passes one, so it always uses the default.
async function sendCompletionEmail(projectId, entryId, recipients) {
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
  const entry = db.prepare('SELECT * FROM project_entries WHERE id = ?').get(entryId);
  const photos = db.prepare('SELECT * FROM project_entry_photos WHERE entry_id = ?').all(entryId);
  const pdfBuffer = await buildProjectEntryPdf(
    { ...project, template: JSON.parse(project.template_json) },
    { ...entry, answers: JSON.parse(entry.answers_json) },
    photos,
    UPLOAD_DIR,
  );
  const toEmails = Array.isArray(recipients) && recipients.length > 0 ? recipients : PROJECT_COMPLETE_EMAILS;
  await notifyProjectEntryComplete({
    toEmails,
    projectName: project.name,
    siteName: entry.site_name,
    entryNumber: entry.entry_number,
    pdfBuffer,
  });
  return toEmails;
}

router.patch('/:id/entries/:entryId', (req, res) => {
  const entry = db.prepare('SELECT * FROM project_entries WHERE id = ? AND project_id = ?').get(req.params.entryId, req.params.id);
  if (!entry || !canAccessEntry(req, entry)) return res.status(404).json({ error: 'Entry not found' });
  if (entry.status === 'Submitted' && !isAdmin(req.user.id)) {
    return res.status(400).json({ error: 'This entry has already been submitted' });
  }

  const { answers, site_name, assigned_to, submit } = req.body;
  const updates = [];
  const params = [];
  if (answers !== undefined) { updates.push('answers_json = ?'); params.push(JSON.stringify(answers)); }
  if (site_name !== undefined) { updates.push('site_name = ?'); params.push(site_name); }
  // Only an admin can reassign an entry — a tech shouldn't be able to hand their own
  // work off to someone else.
  if (assigned_to !== undefined) {
    if (!isAdmin(req.user.id)) return res.status(403).json({ error: 'Only admins can reassign an entry' });
    if (assigned_to) {
      const target = db.prepare('SELECT id FROM users WHERE id = ?').get(assigned_to);
      if (!target) return res.status(400).json({ error: 'Assigned user not found' });
    }
    updates.push('assigned_to = ?');
    params.push(assigned_to || null);
    if ((assigned_to || null) !== entry.assigned_to) {
      logEntryAudit(req.params.entryId, 'assigned_to', userName(entry.assigned_to), userName(assigned_to), req.user.id);
    }
    if (assigned_to && assigned_to !== entry.assigned_to) {
      const project = db.prepare('SELECT name FROM projects WHERE id = ?').get(req.params.id);
      notifyEntryAssignment(assigned_to, project.name, entry);
    }
  }

  if (submit) {
    const project = db.prepare('SELECT template_json FROM projects WHERE id = ?').get(req.params.id);
    const template = JSON.parse(project.template_json);
    const finalAnswers = answers !== undefined ? answers : JSON.parse(entry.answers_json);
    const problems = validateSubmission(template, finalAnswers, entry.id);
    if (problems.length > 0) {
      return res.status(400).json({ error: 'This entry is incomplete', problems });
    }
    updates.push("status = 'Submitted'", "submitted_at = datetime('now')");
    logEntryAudit(req.params.entryId, 'status', entry.status, 'Submitted', req.user.id);
  }

  if (updates.length === 0) return res.status(400).json({ error: 'Nothing to update' });
  updates.push("updated_at = datetime('now')");
  params.push(req.params.entryId);
  db.prepare(`UPDATE project_entries SET ${updates.join(', ')} WHERE id = ?`).run(...params);

  const updated = db.prepare('SELECT * FROM project_entries WHERE id = ?').get(req.params.entryId);
  const assignee = updated.assigned_to ? db.prepare('SELECT id, name FROM users WHERE id = ?').get(updated.assigned_to) : null;

  // Fire-and-forget: never block the response on email/PDF generation, and never let
  // a mail hiccup here undo a submission that already succeeded.
  if (submit) {
    sendCompletionEmail(req.params.id, req.params.entryId).catch((err) => {
      console.error('[projects] Could not send completion email:', err.message);
    });
  }

  res.json({ entry: { ...updated, answers: JSON.parse(updated.answers_json), assignee } });
});

router.delete('/:id/entries/:entryId', (req, res) => {
  if (!isAdmin(req.user.id)) return res.status(403).json({ error: 'Only admins can delete entries' });
  const entry = db.prepare('SELECT * FROM project_entries WHERE id = ? AND project_id = ?').get(req.params.entryId, req.params.id);
  if (!entry) return res.status(404).json({ error: 'Entry not found' });

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

// ---------------------------------------------------------------------------
// PDF — view/download the completed entry, or manually (re)send the completion
// email. Both available once an entry exists; the PDF naturally looks sparse for
// a still-in-progress (Draft) entry since it just reflects whatever's saved so far.
// ---------------------------------------------------------------------------

router.get('/:id/entries/:entryId/pdf', async (req, res) => {
  const entry = db.prepare('SELECT * FROM project_entries WHERE id = ? AND project_id = ?').get(req.params.entryId, req.params.id);
  if (!entry || !canAccessEntry(req, entry)) return res.status(404).json({ error: 'Entry not found' });
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  const photos = db.prepare('SELECT * FROM project_entry_photos WHERE entry_id = ?').all(entry.id);

  console.log(`[pdf] Generating PDF for entry #${entry.entry_number} (${entry.id}) — ${photos.length} photo(s) found. pdfkit version: ${require('pdfkit/package.json').version}`);

  try {
    const pdfBuffer = await buildProjectEntryPdf(
      { ...project, template: JSON.parse(project.template_json) },
      { ...entry, answers: JSON.parse(entry.answers_json) },
      photos,
      UPLOAD_DIR,
    );
    const pageCount = (pdfBuffer.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
    console.log(`[pdf] Generated successfully — ${pdfBuffer.length} bytes, approx ${pageCount} page(s).`);
    res.setHeader('Content-Type', 'application/pdf');
    const rawName = `${project.name} - ${entry.site_name || `Entry ${entry.entry_number}`}`;
    const safeName = rawName.replace(/[\\/:*?"<>|]/g, '').trim();
    res.setHeader('Content-Disposition', `inline; filename="${safeName}.pdf"`);
    res.send(pdfBuffer);
  } catch (err) {
    console.error('[projects] Could not generate PDF:', err.message, err.stack);
    res.status(500).json({ error: 'Could not generate PDF' });
  }
});

router.get('/:id/entries/:entryId/email-defaults', (req, res) => {
  const entry = db.prepare('SELECT * FROM project_entries WHERE id = ? AND project_id = ?').get(req.params.entryId, req.params.id);
  if (!entry || !canAccessEntry(req, entry)) return res.status(404).json({ error: 'Entry not found' });
  res.json({ recipients: PROJECT_COMPLETE_EMAILS });
});

router.post('/:id/entries/:entryId/email-pdf', async (req, res) => {
  const entry = db.prepare('SELECT * FROM project_entries WHERE id = ? AND project_id = ?').get(req.params.entryId, req.params.id);
  if (!entry || !canAccessEntry(req, entry)) return res.status(404).json({ error: 'Entry not found' });

  const { recipients } = req.body;
  if (recipients !== undefined) {
    if (!Array.isArray(recipients) || recipients.length === 0) {
      return res.status(400).json({ error: 'At least one recipient is required' });
    }
    const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const invalid = recipients.find((r) => typeof r !== 'string' || !emailPattern.test(r.trim()));
    if (invalid !== undefined) {
      return res.status(400).json({ error: `"${invalid}" doesn't look like a valid email address` });
    }
  }

  try {
    const sentTo = await sendCompletionEmail(req.params.id, req.params.entryId, recipients);
    res.json({ ok: true, sentTo });
  } catch (err) {
    console.error('[projects] Could not send completion email:', err.message);
    res.status(500).json({ error: 'Could not generate or send the PDF' });
  }
});

// ---------------------------------------------------------------------------
// Bulk actions live earlier in this file, right after entry creation — see the
// comment there explaining why they must come before /:id/entries/:entryId.
// ---------------------------------------------------------------------------

module.exports = router;

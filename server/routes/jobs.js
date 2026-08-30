const express = require('express');
const { v4: uuid } = require('uuid');
const { db, nextJobNumber, peekNextJobNumber } = require('../db');
const { authRequired } = require('../auth');
const { notifyNewReply, notifyStatusChange, notifyTicketCreated, notifyJobComplete, notifyJobClosed } = require('../email');
const { createCalendarEvent, syncCalendarEvent, deleteCalendarEvent } = require('../calendar');
const { canAccessJob, isAdminRole, currentRole } = require('../permissions');
const { buildJobSheetBuffer } = require('../pdfBuilder');

const router = express.Router();
router.use(authRequired);

const FIELDS = [
  'contact_name', 'account_name', 'email', 'phone', 'subject', 'description',
  'status', 'owner_id', 'product_name', 'due_date', 'scheduled_time', 'language', 'priority',
  'channel', 'classifications', 'site_address', 'access_notes', 'customer_reference',
];

const OPEN_STATUSES = ['Open', 'In Progress', 'On Hold'];
// "Complete" and "Collected" both mean the job is done and the client should be
// told — "Closed" is a separate final/archival state that's staff-only (no client
// email). All three count as "closed" for overdue and resolution-time purposes.
const COMPLETION_STATUSES = ['Complete', 'Collected'];
const CLOSED_STATUSES = [...COMPLETION_STATUSES, 'Closed'];
const COLLECTIONS_EMAIL = process.env.COLLECTIONS_EMAIL || 'collections@itfactory.com.au';

function withNames(job) {
  const owner = job.owner_id ? db.prepare('SELECT id, name, email FROM users WHERE id = ?').get(job.owner_id) : null;
  const creator = job.created_by ? db.prepare('SELECT id, name FROM users WHERE id = ?').get(job.created_by) : null;
  const attachmentCount = db.prepare('SELECT COUNT(*) as c FROM attachments WHERE job_id = ?').get(job.id).c;
  const today = new Date().toISOString().slice(0, 10);
  const overdue = !!(job.due_date && job.due_date < today && OPEN_STATUSES.includes(job.status));
  return { ...job, owner, creator, attachmentCount, overdue };
}

function userName(userId) {
  if (!userId) return null;
  return db.prepare('SELECT name FROM users WHERE id = ?').get(userId)?.name || null;
}

function logAudit(jobId, field, oldValue, newValue, userId) {
  db.prepare('INSERT INTO job_audit (id, job_id, field, old_value, new_value, changed_by) VALUES (?, ?, ?, ?, ?, ?)')
    .run(uuid(), jobId, field, oldValue ?? null, newValue ?? null, userId);
}

// Sends the right email(s) for a status transition. Complete/Collected go to the
// client (if one's on file) AND to the collections inbox, with the signed job sheet
// attached when available. Closed goes to collections only — clients never see a
// "Closed" transition, since it's an internal archival state. Anything else falls
// back to the plain "status updated" notice, same as before. Always fire-and-forget.
function sendStatusTransitionEmails(oldStatus, updated) {
  const newStatus = updated.status;
  if (newStatus === oldStatus) return;

  if (COMPLETION_STATUSES.includes(newStatus) && !COMPLETION_STATUSES.includes(oldStatus)) {
    (async () => {
      try {
        const pdfBuffer = updated.signature_data ? await buildJobSheetBuffer(updated.id) : null;
        if (updated.email) {
          await notifyJobComplete({ toEmail: updated.email, ticketNumber: updated.job_number, subject: updated.subject, pdfBuffer });
        }
        await notifyJobComplete({ toEmail: COLLECTIONS_EMAIL, ticketNumber: updated.job_number, subject: updated.subject, pdfBuffer });
      } catch (err) {
        console.error('[jobs] Could not send job-complete email:', err.message);
      }
    })();
    return;
  }

  if (newStatus === 'Closed' && oldStatus !== 'Closed') {
    notifyJobClosed({ toEmail: COLLECTIONS_EMAIL, ticketNumber: updated.job_number, subject: updated.subject }).catch((err) => {
      console.error('[jobs] Could not send job-closed email:', err.message);
    });
    return;
  }

  if (updated.email) {
    notifyStatusChange({ toEmail: updated.email, ticketNumber: updated.job_number, subject: updated.subject, status: updated.status });
  }
}

// Applied to every route that operates on a specific job. Fetches it once, and 404s
// (not 403) if the requester can't access it — a non-admin User shouldn't even learn
// that a job they're not assigned to exists. Attaches the row to req.job so handlers
// don't need to re-fetch it.
function loadJobAndCheckAccess(req, res, next) {
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.id);
  if (!job || !canAccessJob(req.user, job)) {
    return res.status(404).json({ error: 'Job not found' });
  }
  req.job = job;
  next();
}

// List jobs — Users only ever see jobs assigned to them; Admins see everything.
router.get('/', (req, res) => {
  const { sql, params } = buildJobQuery(req.query, req.user);
  const jobs = db.prepare(sql).all(...params).map(withNames);
  res.json({ jobs });
});

// Shared by the JSON list endpoint and the CSV export below, so the two never drift
// out of sync on what "matches the current filters" means.
function buildJobQuery(query, requestingUser) {
  const { status, priority, owner_id, q, overdue } = query;
  let sql = 'SELECT * FROM jobs WHERE 1=1';
  const params = [];

  // A non-admin's own id always wins here — even if they pass a different owner_id
  // in the query string, they can only ever see their own jobs. This is the same
  // rule enforced on every single-job route via loadJobAndCheckAccess.
  if (requestingUser && !isAdminRole(currentRole(requestingUser.id))) {
    sql += ' AND owner_id = ?';
    params.push(requestingUser.id);
  } else if (owner_id) {
    sql += ' AND owner_id = ?';
    params.push(owner_id);
  }

  if (status) { sql += ' AND status = ?'; params.push(status); }
  if (priority) { sql += ' AND priority = ?'; params.push(priority); }
  if (q) {
    sql += ' AND (subject LIKE ? OR contact_name LIKE ? OR account_name LIKE ? OR description LIKE ?)';
    params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
  }
  if (overdue === '1') {
    const today = new Date().toISOString().slice(0, 10);
    sql += ` AND due_date IS NOT NULL AND due_date < ? AND status IN (${OPEN_STATUSES.map(() => '?').join(',')})`;
    params.push(today, ...OPEN_STATUSES);
  }
  sql += ' ORDER BY created_at DESC';
  return { sql, params };
}

function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  // Quote any field containing a comma, quote, or newline — and double up internal quotes.
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

router.get('/export.csv', (req, res) => {
  if (!isAdminRole(currentRole(req.user.id))) {
    return res.status(403).json({ error: 'Only admins can export jobs to CSV' });
  }
  const { sql, params } = buildJobQuery(req.query, req.user);
  const jobs = db.prepare(sql).all(...params).map(withNames);

  const columns = [
    ['job_number', 'Job #'], ['subject', 'Subject'], ['contact_name', 'Contact'],
    ['account_name', 'Account'], ['email', 'Email'], ['phone', 'Phone'],
    ['status', 'Status'], ['priority', 'Priority'], ['due_date', 'Due Date'],
    ['scheduled_time', 'Time'], ['language', 'Vehicle'], ['classifications', 'Classification'],
    ['site_address', 'Site Address'], ['customer_reference', 'Reference'],
    ['created_at', 'Created'],
  ];

  const header = columns.map(([, label]) => label);
  header.push('Owner');
  const csvLines = [header.map(csvEscape).join(',')];
  jobs.forEach((j) => {
    const row = columns.map(([key]) => j[key]);
    row.push(j.owner?.name || 'Unassigned');
    csvLines.push(row.map(csvEscape).join(','));
  });

  const dateStr = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="jobs-export-${dateStr}.csv"`);
  res.send(csvLines.join('\r\n'));
});

router.get('/stats/summary', (req, res) => {
  // Same scoping rule as the list: a non-admin's stats only ever reflect their own jobs.
  const scoped = !isAdminRole(currentRole(req.user.id));
  const ownerFilter = scoped ? 'AND owner_id = ?' : '';
  const ownerParam = scoped ? [req.user.id] : [];

  const rows = db.prepare(`SELECT status, COUNT(*) as count FROM jobs WHERE 1=1 ${ownerFilter} GROUP BY status`).all(...ownerParam);
  const byStatus = { Open: 0, 'In Progress': 0, 'On Hold': 0, Complete: 0, Collected: 0, Closed: 0 };
  rows.forEach((r) => { byStatus[r.status] = r.count; });
  const unassigned = scoped ? 0 : db.prepare('SELECT COUNT(*) as c FROM jobs WHERE owner_id IS NULL').get().c;
  const total = db.prepare(`SELECT COUNT(*) as c FROM jobs WHERE 1=1 ${ownerFilter}`).get(...ownerParam).c;
  const today = new Date().toISOString().slice(0, 10);
  const overdue = db.prepare(`
    SELECT COUNT(*) as c FROM jobs
    WHERE due_date IS NOT NULL AND due_date < ? AND status IN (${OPEN_STATUSES.map(() => '?').join(',')}) ${ownerFilter}
  `).get(today, ...OPEN_STATUSES, ...ownerParam).c;
  res.json({ byStatus, unassigned, total, overdue });
});

router.get('/next-number', (req, res) => {
  res.json({ next: peekNextJobNumber() });
});

router.patch('/bulk', (req, res) => {
  const { ids, status, owner_id } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'ids array is required' });
  if (status === undefined && owner_id === undefined) return res.status(400).json({ error: 'status or owner_id is required' });

  const isAdmin = isAdminRole(currentRole(req.user.id));

  let updated = 0;
  ids.forEach((jobId) => {
    const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
    if (!job) return;
    if (!isAdmin && job.owner_id !== req.user.id) return; // silently skip jobs this user can't touch

    const updates = [];
    const params = [];
    if (status !== undefined && status !== job.status) {
      updates.push('status = ?');
      params.push(status);
      logAudit(jobId, 'status', job.status, status, req.user.id);
      if (CLOSED_STATUSES.includes(status) && !CLOSED_STATUSES.includes(job.status)) {
        updates.push("resolved_at = datetime('now')");
      } else if (!CLOSED_STATUSES.includes(status)) {
        updates.push('resolved_at = NULL');
      }
    }
    if (owner_id !== undefined && owner_id !== job.owner_id) {
      updates.push('owner_id = ?');
      params.push(owner_id || null);
      logAudit(jobId, 'owner_id', userName(job.owner_id), userName(owner_id), req.user.id);
    }
    if (updates.length === 0) return;

    updates.push("updated_at = datetime('now')");
    params.push(jobId);
    db.prepare(`UPDATE jobs SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    updated += 1;

    const fresh = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
    if (status !== undefined && status !== job.status) {
      sendStatusTransitionEmails(job.status, fresh);
    }
  });

  res.json({ ok: true, updated });
});

router.get('/:id', loadJobAndCheckAccess, (req, res) => {
  const job = req.job;

  const notes = db.prepare('SELECT * FROM job_notes WHERE job_id = ? ORDER BY created_at ASC').all(req.params.id)
    .map((n) => ({ ...n, author: db.prepare('SELECT id, name FROM users WHERE id = ?').get(n.author_id) }));

  const attachments = db.prepare('SELECT id, original_name, mime_type, size, created_at, uploaded_by FROM attachments WHERE job_id = ? ORDER BY created_at DESC').all(req.params.id)
    .map((a) => ({ ...a, uploader: db.prepare('SELECT id, name FROM users WHERE id = ?').get(a.uploaded_by) }));

  const items = db.prepare('SELECT * FROM job_items WHERE job_id = ? ORDER BY sort_order ASC').all(req.params.id);

  const audit = db.prepare('SELECT * FROM job_audit WHERE job_id = ? ORDER BY changed_at DESC').all(req.params.id)
    .map((a) => ({ ...a, user: a.changed_by ? db.prepare('SELECT id, name FROM users WHERE id = ?').get(a.changed_by) : null }));

  res.json({ job: withNames(job), notes, attachments, items, audit });
});

// Only Admins log new jobs — Users (techs) work the jobs they're assigned, not create them.
router.post('/', (req, res) => {
  if (!isAdminRole(currentRole(req.user.id))) {
    return res.status(403).json({ error: 'Only admins can create new jobs' });
  }
  const { contact_name, subject } = req.body;
  if (!contact_name || !subject) {
    return res.status(400).json({ error: 'contact_name and subject are required' });
  }

  const id = uuid();
  const jobNumber = nextJobNumber();
  const cols = ['id', 'job_number', 'created_by'];
  const vals = [id, jobNumber, req.user.id];

  FIELDS.forEach((f) => {
    if (req.body[f] !== undefined && req.body[f] !== '') {
      cols.push(f);
      vals.push(req.body[f]);
    }
  });

  db.prepare(`INSERT INTO jobs (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...vals);

  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
  if (job.email) {
    notifyTicketCreated({ toEmail: job.email, ticketNumber: jobNumber, subject: job.subject });
  }

  // Fire-and-forget: sync to the Microsoft 365 calendar if configured. Never blocks or
  // fails the job-creation response — a calendar hiccup shouldn't stop a job being logged.
  createCalendarEvent(job).then((eventId) => {
    if (eventId) db.prepare('UPDATE jobs SET ms_event_id = ? WHERE id = ?').run(eventId, id);
  }).catch((err) => {
    // Defensive: syncCalendarEvent/createCalendarEvent already catch their own errors
    // and shouldn't reject, but an uncaught rejection here could crash the whole
    // process in modern Node — this guarantees that can never happen.
    console.error('[jobs] Unexpected error syncing new job to calendar:', err.message);
  });

  res.status(201).json({ job: withNames(job) });
});

router.patch('/:id', loadJobAndCheckAccess, (req, res) => {
  const job = req.job;

  const updates = [];
  const params = [];
  FIELDS.forEach((f) => {
    if (req.body[f] !== undefined) {
      const newVal = req.body[f] === '' ? null : req.body[f];
      if ((f === 'status' || f === 'owner_id') && newVal !== job[f]) {
        if (f === 'owner_id') {
          logAudit(req.params.id, f, userName(job[f]), userName(newVal), req.user.id);
        } else {
          logAudit(req.params.id, f, job[f], newVal, req.user.id);
        }
      }
      updates.push(`${f} = ?`);
      params.push(newVal);
    }
  });
  if (updates.length === 0) return res.status(400).json({ error: 'No valid fields to update' });

  if (req.body.status !== undefined && req.body.status !== job.status) {
    if (CLOSED_STATUSES.includes(req.body.status) && !CLOSED_STATUSES.includes(job.status)) {
      updates.push("resolved_at = datetime('now')");
    } else if (!CLOSED_STATUSES.includes(req.body.status)) {
      updates.push('resolved_at = NULL');
    }
  }

  updates.push("updated_at = datetime('now')");
  params.push(req.params.id);
  db.prepare(`UPDATE jobs SET ${updates.join(', ')} WHERE id = ?`).run(...params);

  const updated = db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.id);
  if (req.body.status && req.body.status !== job.status) {
    sendStatusTransitionEmails(job.status, updated);
  }

  // Keep the Microsoft 365 calendar in sync with whatever just changed — creates an
  // event if the job just got a due date, updates it if one already exists, or removes
  // it if the due date was cleared. Fire-and-forget, never blocks the response.
  syncCalendarEvent(updated).then((eventId) => {
    if (eventId !== updated.ms_event_id) {
      db.prepare('UPDATE jobs SET ms_event_id = ? WHERE id = ?').run(eventId, req.params.id);
    }
  }).catch((err) => {
    console.error('[jobs] Unexpected error syncing job update to calendar:', err.message);
  });

  res.json({ job: withNames(updated) });
});

router.delete('/:id', loadJobAndCheckAccess, (req, res) => {
  const job = req.job;
  db.prepare('DELETE FROM jobs WHERE id = ?').run(req.params.id);
  if (job?.ms_event_id) deleteCalendarEvent(job.ms_event_id);
  res.json({ ok: true });
});

router.post('/:id/notes', loadJobAndCheckAccess, (req, res) => {
  const job = req.job;

  const { body, notify_contact } = req.body;
  if (!body) return res.status(400).json({ error: 'body is required' });

  const id = uuid();
  db.prepare('INSERT INTO job_notes (id, job_id, author_id, body) VALUES (?, ?, ?, ?)').run(id, req.params.id, req.user.id, body);

  if (job.status === 'Open') {
    logAudit(req.params.id, 'status', 'Open', 'In Progress', req.user.id);
    db.prepare("UPDATE jobs SET status = 'In Progress', updated_at = datetime('now') WHERE id = ?").run(req.params.id);
  } else {
    db.prepare("UPDATE jobs SET updated_at = datetime('now') WHERE id = ?").run(req.params.id);
  }

  if (notify_contact && job.email) {
    notifyNewReply({ toEmail: job.email, ticketNumber: job.job_number, subject: job.subject, authorName: req.user.name, body, isAgentReply: true });
  }

  const note = db.prepare('SELECT * FROM job_notes WHERE id = ?').get(id);
  const freshJob = db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.id);
  res.status(201).json({
    note: { ...note, author: { id: req.user.id, name: req.user.name } },
    job: withNames(freshJob),
  });
});

router.post('/:id/items', loadJobAndCheckAccess, (req, res) => {
  const { description, qty, reference } = req.body;
  if (!description) return res.status(400).json({ error: 'description is required' });

  const maxOrder = db.prepare('SELECT MAX(sort_order) as m FROM job_items WHERE job_id = ?').get(req.params.id).m;
  const id = uuid();
  db.prepare('INSERT INTO job_items (id, job_id, description, qty, reference, sort_order) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, req.params.id, description, qty || 1, reference || null, (maxOrder ?? -1) + 1);

  const item = db.prepare('SELECT * FROM job_items WHERE id = ?').get(id);
  res.status(201).json({ item });
});

router.patch('/:id/items/:itemId', loadJobAndCheckAccess, (req, res) => {
  const item = db.prepare('SELECT * FROM job_items WHERE id = ? AND job_id = ?').get(req.params.itemId, req.params.id);
  if (!item) return res.status(404).json({ error: 'Item not found' });

  const { description, qty, reference } = req.body;
  db.prepare('UPDATE job_items SET description = ?, qty = ?, reference = ? WHERE id = ?')
    .run(description ?? item.description, qty ?? item.qty, reference !== undefined ? reference : item.reference, req.params.itemId);

  res.json({ item: db.prepare('SELECT * FROM job_items WHERE id = ?').get(req.params.itemId) });
});

router.delete('/:id/items/:itemId', loadJobAndCheckAccess, (req, res) => {
  const result = db.prepare('DELETE FROM job_items WHERE id = ? AND job_id = ?').run(req.params.itemId, req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Item not found' });
  res.json({ ok: true });
});

router.post('/:id/signature', loadJobAndCheckAccess, (req, res) => {
  const { name, dataUrl, comments } = req.body;
  if (!name || !dataUrl) return res.status(400).json({ error: 'name and dataUrl are required' });

  db.prepare(`
    UPDATE jobs SET signature_name = ?, signature_data = ?, signature_at = datetime('now'), comments = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(name, dataUrl, comments || null, req.params.id);

  res.json({ job: withNames(db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.id)) });
});

router.delete('/:id/signature', loadJobAndCheckAccess, (req, res) => {
  db.prepare("UPDATE jobs SET signature_name = NULL, signature_data = NULL, signature_at = NULL, updated_at = datetime('now') WHERE id = ?").run(req.params.id);
  res.json({ job: withNames(db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.id)) });
});

module.exports = router;

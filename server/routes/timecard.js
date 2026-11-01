// ITF Time Card API. Contractors use /my/*; Work Desk admins use /admin/*.
const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { randomUUID } = require('crypto');
const { db } = require('../db');
const fileStore = require('../fileStore');
const { shrinkUpload } = require('../photoShrink');
const { authRequired } = require('../auth');
const { isAdminRole, logsTime, isSuperAdmin, adminHasTimecard } = require('../permissions');
const tc = require('../timecard');
const mail = require('../timecardEmail');
const { sendReminders, contractorsToRemind } = require('../timecardReminders');
const { logActivity } = require('../activity');

const router = express.Router();
router.use(authRequired);

const me = (req) => db.prepare('SELECT id, name, email, role, access_timecard FROM users WHERE id = ?').get(req.user.id);

function contractorOnly(req, res, next) {
  const u = me(req);
  // Contractors, and staff with ITF Time Card ticked in Settings.
  if (!logsTime(u)) return res.status(403).json({ error: "You don't have a timesheet. Ask an admin to turn on ITF Time Card for you in Settings." });
  req.contractor = u;
  next();
}
function adminOnly(req, res, next) {
  const u = me(req);
  if (!u || !isAdminRole(u.role)) return res.status(403).json({ error: 'Admin access required' });
  if (!adminHasTimecard(u.id)) return res.status(403).json({ error: "You don't have access to ITF Time Card. Ask the Super Admin to turn it on in Settings.", code: 'no_module_access' });
  req.admin = u;
  next();
}

// Runs a handler, turning TimecardErrors into friendly 4xx replies.
const handle = (fn) => async (req, res) => {
  try { await fn(req, res); } catch (err) {
    if (err instanceof tc.TimecardError) return res.status(err.status).json({ error: err.message });
    console.error('[timecard]', err);
    res.status(500).json({ error: 'Something went wrong — please try again.' });
  }
};
// Email failures never undo the action; they're just logged.
const quietly = (p) => Promise.resolve(p).catch((err) => console.error('[timecard] Email failed:', err.message));

// ---- Contractor ----------------------------------------------------------------

router.get('/my', contractorOnly, handle((req, res) => {
  res.json(tc.contractorState(req.contractor, tc.currentWeek(req.contractor)));
}));

// Open (or start) the week ending on a given date.
router.get('/my/week', contractorOnly, handle((req, res) => {
  const ending = String(req.query.ending || '').trim();
  if (!tc.YMD.test(ending)) throw new tc.TimecardError('Choose a week ending date.');
  res.json(tc.contractorState(req.contractor, tc.findOrCreateWeek(req.contractor, ending)));
}));

const contractorAction = (fn) => [contractorOnly, handle((req, res) => {
  const week = fn(req);
  res.json(tc.contractorState(req.contractor, week));
})];

router.post('/my/weeks/:id/entries', ...contractorAction((req) => tc.addEntry(req.contractor, req.params.id, req.body)));
router.delete('/my/weeks/:id/entries/:entryId', ...contractorAction((req) => tc.deleteEntry(req.contractor, req.params.id, req.params.entryId)));
// Receipt/invoice for an expense: a photo (taken on the phone or picked) or a PDF, up to 20 MB.
if (!fs.existsSync(tc.UPLOAD_DIR)) fs.mkdirSync(tc.UPLOAD_DIR, { recursive: true });
const receiptUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, tc.UPLOAD_DIR),
    filename: (req, file, cb) => cb(null, `${randomUUID()}${(path.extname(file.originalname || '') || (file.mimetype === 'application/pdf' ? '.pdf' : '.jpg')).toLowerCase()}`),
  }),
  limits: { fileSize: 20 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => cb(null, /^image\//.test(file.mimetype) || file.mimetype === 'application/pdf'),
});
const receiptField = (req, res, next) => receiptUpload.single('receipt')(req, res, (err) => {
  if (!err) return next();
  res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'That receipt file is too big (20 MB max).' : 'Could not read the receipt file.' });
});

router.post('/my/weeks/:id/expenses', contractorOnly, receiptField, handle(async (req, res) => {
  let receipt = null;
  try {
    if (req.file) receipt = await shrinkUpload(req.file); // big phone photos are made smaller
    const week = tc.addExpense(req.contractor, req.params.id, req.body, receipt);
    if (receipt) fileStore.offloadSoon(receipt.filename, { dir: tc.UPLOAD_DIR, contentType: receipt.mimetype }); // to Cloudflare R2, when set up
    res.json(tc.contractorState(req.contractor, week));
  } catch (err) {
    const name = receipt?.filename || req.file?.filename;
    if (name) { try { fs.unlinkSync(path.join(tc.UPLOAD_DIR, name)); } catch (e) { /* already gone */ } }
    throw err;
  }
}));

// View a receipt: the person who claimed it, or a Time Card admin.
router.get('/expenses/:expenseId/receipt', handle(async (req, res) => {
  const u = me(req);
  const canSeeAll = !!u && isAdminRole(u.role) && adminHasTimecard(u.id);
  const r = tc.expenseReceipt(u, req.params.expenseId, canSeeAll);
  // Shown in the browser (not downloaded) so a photo or PDF opens straight away.
  await fileStore.send(res, r.storedName, { dir: r.dir, contentType: r.mime });
}));
router.delete('/my/weeks/:id/expenses/:expenseId', ...contractorAction((req) => tc.deleteExpense(req.contractor, req.params.id, req.params.expenseId)));
router.post('/my/weeks/:id/clear', ...contractorAction((req) => tc.clearWeek(req.contractor, req.params.id)));

// Send for approval: emails every Work Desk admin. Afterwards the contractor
// moves on to their next week (a declined one first, else a fresh week).
router.post('/my/weeks/:id/submit', contractorOnly, handle((req, res) => {
  const week = tc.submitWeek(req.contractor, req.params.id);
  const sum = tc.weekSummary(week);
  logActivity('timecard.submitted', { req, target: { type: 'timesheet', id: sum.id, name: `${sum.fullName} — week ending ${tc.dmy(sum.weekEnding)}` }, details: `${sum.total} hrs` });
  quietly(mail.notifySubmitted(sum));
  res.json(tc.contractorState(req.contractor, tc.currentWeek(req.contractor)));
}));

// ---- Admin ---------------------------------------------------------------------

router.get('/admin', adminOnly, handle((req, res) => {
  res.json({
    pending: tc.pendingWeeks(),
    recent: tc.recentDecisions(),
    contractors: tc.contractors(),
    hoursSummary: tc.hoursSummary(),
    projects: tc.approvedProjects(),
    projectBreakdown: tc.projectBreakdown(),
    people: tc.peopleSummary(),
    // Paid to each person: the Super Admin only.
    ...(isSuperAdmin(req.user.id) ? { pay: tc.paySummary() } : {}),
    today: tc.todayYmd(),
  });
}));

router.get('/admin/pending-count', adminOnly, handle((req, res) => {
  res.json({ count: db.prepare("SELECT COUNT(*) AS c FROM timecard_weeks WHERE status = 'Waiting on approval'").get().c });
}));

router.get('/admin/range', adminOnly, handle((req, res) => {
  const { from, to } = req.query;
  if (!tc.YMD.test(from || '') || !tc.YMD.test(to || '')) throw new tc.TimecardError('Pick a start and end date.');
  if (from > to) throw new tc.TimecardError('Start date must be before end date.');
  res.json({ from, to, totalHours: tc.approvedHoursInRange(from, to) });
}));

// Approved hours per person for a custom date range (by week-ending date).
router.get('/admin/hours', adminOnly, handle((req, res) => {
  const { from, to } = req.query;
  if (!tc.YMD.test(from || '') || !tc.YMD.test(to || '')) throw new tc.TimecardError('Pick a start and end date.');
  if (from > to) throw new tc.TimecardError('Start date must be before end date.');
  const pay = tc.payInRange(from, to);
  res.json({ from, to, hours: Object.fromEntries(Object.entries(pay).map(([id, v]) => [id, v.hours])) });
}));

// Pay per person for a custom date range (by week-ending date): the Super Admin only.
router.get('/admin/pay', adminOnly, handle((req, res) => {
  if (!isSuperAdmin(req.user.id)) return res.status(403).json({ error: 'Only the Super Admin can see what people were paid.' });
  const { from, to } = req.query;
  if (!tc.YMD.test(from || '') || !tc.YMD.test(to || '')) throw new tc.TimecardError('Pick a start and end date.');
  if (from > to) throw new tc.TimecardError('Start date must be before end date.');
  res.json({ from, to, pay: tc.payInRange(from, to) });
}));

router.get('/admin/project-weekly', adminOnly, handle((req, res) => {
  res.json({ rows: tc.projectWeeklyHours(req.query.project) });
}));

const logWeek = (req, action, week, extra = '') => logActivity(action, {
  req, target: { type: 'timesheet', id: week.id, name: `${week.fullName} — week ending ${tc.dmy(week.weekEnding)}` },
  details: [`${week.total} hrs`, extra].filter(Boolean).join('. '),
});

router.post('/admin/weeks/:id/approve', adminOnly, handle((req, res) => {
  const week = tc.approveWeek(req.admin, req.params.id);
  logWeek(req, 'timecard.approved', week);
  quietly(mail.notifyApproved(week));
  res.json({ week });
}));

router.post('/admin/weeks/:id/decline', adminOnly, handle((req, res) => {
  const week = tc.declineWeek(req.admin, req.params.id, req.body?.reason);
  logWeek(req, 'timecard.declined', week, week.declineReason ? `Reason: ${week.declineReason}` : '');
  quietly(mail.notifyDeclined(week));
  res.json({ week });
}));

// Approve several at once; any that can't be approved come back as failures.
router.post('/admin/approve-bulk', adminOnly, handle((req, res) => {
  const ids = Array.isArray(req.body?.weekIds) ? req.body.weekIds : [];
  const approved = []; const failures = [];
  ids.forEach((id) => {
    try {
      const week = tc.approveWeek(req.admin, id);
      logWeek(req, 'timecard.approved', week);
      quietly(mail.notifyApproved(week));
      approved.push(id);
    } catch (err) { failures.push({ weekId: id, message: err.message }); }
  });
  res.json({ approved, failures });
}));

const filters = (q) => ({ userId: q.userId || undefined, from: q.from || undefined, to: q.to || undefined });

router.get('/admin/approved', adminOnly, handle((req, res) => {
  res.json({ weeks: tc.approvedWeeksDetailed(filters(req.query)) });
}));

router.get('/admin/approved.csv', adminOnly, handle((req, res) => {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="approved-timesheets-${tc.todayYmd()}.csv"`);
  res.send(tc.approvedCsv(filters(req.query)));
}));

// Who the Friday reminder would go to right now, and a button to send it.
router.get('/admin/reminders', adminOnly, handle((req, res) => {
  res.json({ contractors: contractorsToRemind().map((u) => ({ id: u.id, name: u.name, email: u.email })), automatic: /^(on|true|1|yes)$/i.test(process.env.TIMECARD_REMINDERS || '') });
}));
router.post('/admin/reminders/send', adminOnly, handle(async (req, res) => {
  res.json(await sendReminders());
}));

module.exports = router;

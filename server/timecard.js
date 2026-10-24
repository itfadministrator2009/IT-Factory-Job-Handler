// ITF Time Card — the old Time Card app (Apps Script + Google Sheet) rebuilt on
// Work Desk. Contractors log hours and expenses for a week (ending Sunday) and
// send it for approval; Work Desk admins approve or decline it.
const { v4: uuid } = require('uuid');
const { db } = require('./db');

const TZ = process.env.BACKUP_TIMEZONE || 'Australia/Sydney';
const EDITABLE = ['Not sent', 'Declined'];
const EXPENSE_TYPES = ['Fuel', 'Parking', 'Tolls', 'Travel', 'Materials', 'Meals', 'Other'];
const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const HHMM = /^([01]?\d|2[0-3]):[0-5]\d$/;

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

class TimecardError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

// Today as YYYY-MM-DD in the business timezone.
function todayYmd(date = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

function addDays(ymd, n) {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const weekdayOf = (ymd) => new Date(`${ymd}T12:00:00Z`).getUTCDay(); // 0 = Sunday

// The Sunday that ends the week containing `ymd` (today if it's a Sunday).
function sundayOnOrAfter(ymd) {
  const wd = weekdayOf(ymd);
  return wd === 0 ? ymd : addDays(ymd, 7 - wd);
}

// Same maths as the old app: a finish at or before the start runs past midnight.
function computeHours(start, finish, breakMins) {
  if (!start || !finish) return 0;
  const [sh, sm] = String(start).split(':').map(Number);
  const [fh, fm] = String(finish).split(':').map(Number);
  let diff = (fh * 60 + fm) - (sh * 60 + sm);
  if (diff <= 0) diff += 24 * 60;
  diff -= Number(breakMins) || 0;
  if (diff < 0) diff = 0;
  return Math.round((diff / 60) * 100) / 100;
}

const entryOut = (e) => ({
  id: e.id, day: e.day || '', date: e.date || '', clientProject: e.client_project || '',
  start: e.start_time || '', finish: e.finish_time || '', breakMins: e.break_mins || 0,
  hours: round2(e.hours), task: e.task || '',
});
const expenseOut = (x) => ({
  id: x.id, date: x.date || '', type: x.type || '', description: x.description || '', amount: round2(x.amount),
});

function weekEntries(weekId) {
  return db.prepare('SELECT * FROM timecard_entries WHERE week_id = ? ORDER BY date, start_time, created_at').all(weekId).map(entryOut);
}
function weekExpenses(weekId) {
  return db.prepare('SELECT * FROM timecard_expenses WHERE week_id = ? ORDER BY date, created_at').all(weekId).map(expenseOut);
}

// A week with its entries, expenses and totals — the shape every screen and email uses.
function weekSummary(w) {
  if (!w) return null;
  const user = db.prepare('SELECT name, email FROM users WHERE id = ?').get(w.user_id);
  const entries = weekEntries(w.id);
  const expenses = weekExpenses(w.id);
  return {
    id: w.id, userId: w.user_id,
    fullName: user?.name || w.full_name || '', email: user?.email || w.email || '',
    weekEnding: w.week_ending, status: w.status || 'Not sent',
    submittedDate: w.submitted_date || '', approvedBy: w.approved_by || '',
    approvalDate: w.approval_date || '', declineReason: w.decline_reason || '',
    entries, total: round2(entries.reduce((s, e) => s + e.hours, 0)),
    expenses, expenseTotal: round2(expenses.reduce((s, x) => s + x.amount, 0)),
  };
}

const getWeek = (id) => db.prepare('SELECT * FROM timecard_weeks WHERE id = ?').get(id);

function createWeek(user, weekEnding) {
  const id = uuid();
  db.prepare(`INSERT INTO timecard_weeks (id, user_id, full_name, email, week_ending, status)
    VALUES (?, ?, ?, ?, ?, 'Not sent')`).run(id, user.id, user.name || '', user.email || '', weekEnding);
  return getWeek(id);
}

function findOrCreateWeek(user, weekEnding) {
  return db.prepare('SELECT * FROM timecard_weeks WHERE user_id = ? AND week_ending = ?').get(user.id, weekEnding)
    || createWeek(user, weekEnding);
}

// The contractor's own weeks waiting on approval / approved, newest first.
function historyLists(userId) {
  const list = (status) => db.prepare('SELECT * FROM timecard_weeks WHERE user_id = ? AND status = ? ORDER BY week_ending DESC')
    .all(userId, status).map(weekSummary);
  return { pendingWeeks: list('Waiting on approval'), approvedWeeks: list('Approved') };
}

// Every client / project name this contractor has used — for the entry form's suggestions.
function myProjects(userId) {
  return db.prepare(`SELECT DISTINCT client_project FROM timecard_entries
    WHERE user_id = ? AND client_project IS NOT NULL AND client_project != '' ORDER BY client_project`)
    .all(userId).map((r) => r.client_project);
}

function contractorState(user, week) {
  return { week: weekSummary(week), ...historyLists(user.id), projects: myProjects(user.id), today: todayYmd() };
}

// The week a contractor lands on: a declined week to fix first, then their latest
// unsent week, otherwise a new one for this coming Sunday (or the next free one).
function currentWeek(user) {
  const pick = (status) => db.prepare('SELECT * FROM timecard_weeks WHERE user_id = ? AND status = ? ORDER BY week_ending DESC LIMIT 1').get(user.id, status);
  const existing = pick('Declined') || pick('Not sent');
  if (existing) return existing;
  const taken = new Set(db.prepare('SELECT week_ending FROM timecard_weeks WHERE user_id = ?').all(user.id).map((r) => r.week_ending));
  let ending = sundayOnOrAfter(todayYmd());
  while (taken.has(ending)) ending = addDays(ending, 7);
  return createWeek(user, ending);
}

function myEditableWeek(user, weekId) {
  const week = getWeek(weekId);
  if (!week || week.user_id !== user.id) throw new TimecardError('Week not found.', 404);
  if (!EDITABLE.includes(week.status)) throw new TimecardError('This week has been sent and can no longer be changed.');
  return week;
}

function addEntry(user, weekId, body = {}) {
  const week = myEditableWeek(user, weekId);
  const start = String(body.start || '').trim();
  const finish = String(body.finish || '').trim();
  if (!start || !finish) throw new TimecardError('Enter a start and finish time.');
  if (!HHMM.test(start) || !HHMM.test(finish)) throw new TimecardError('Times must look like 08:30.');
  const date = String(body.date || '').trim();
  if (date && !YMD.test(date)) throw new TimecardError('Choose a valid date.');
  const breakMins = Math.max(0, Math.min(24 * 60, parseInt(body.breakMins, 10) || 0));
  let day = String(body.day || '').trim();
  if (!DAYS.includes(day)) day = date ? DAYS[(weekdayOf(date) + 6) % 7] : 'Monday';
  db.prepare(`INSERT INTO timecard_entries (id, week_id, user_id, day, date, client_project, start_time, finish_time, break_mins, hours, task)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    uuid(), week.id, user.id, day, date || null, String(body.clientProject || '').trim().slice(0, 200),
    start, finish, breakMins, computeHours(start, finish, breakMins), String(body.task || '').trim().slice(0, 500),
  );
  return week;
}

function deleteEntry(user, weekId, entryId) {
  const week = myEditableWeek(user, weekId);
  const gone = db.prepare('DELETE FROM timecard_entries WHERE id = ? AND week_id = ?').run(entryId, week.id).changes;
  if (!gone) throw new TimecardError('Entry not found.', 404);
  return week;
}

function addExpense(user, weekId, body = {}) {
  const week = myEditableWeek(user, weekId);
  const amount = round2(body.amount);
  if (!(amount > 0)) throw new TimecardError('Enter an expense amount greater than zero.');
  if (amount > 100000) throw new TimecardError('That amount looks too large — please check it.');
  const date = String(body.date || '').trim();
  if (!YMD.test(date)) throw new TimecardError('Choose the date of the expense.');
  const type = EXPENSE_TYPES.includes(String(body.type || '').trim()) ? String(body.type).trim() : 'Other';
  db.prepare(`INSERT INTO timecard_expenses (id, week_id, user_id, date, type, description, amount) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(uuid(), week.id, user.id, date, type, String(body.description || '').trim().slice(0, 200), amount);
  return week;
}

function deleteExpense(user, weekId, expenseId) {
  const week = myEditableWeek(user, weekId);
  const gone = db.prepare('DELETE FROM timecard_expenses WHERE id = ? AND week_id = ?').run(expenseId, week.id).changes;
  if (!gone) throw new TimecardError('Expense not found.', 404);
  return week;
}

const clearWeek = db.transaction((user, weekId) => {
  const week = myEditableWeek(user, weekId);
  db.prepare('DELETE FROM timecard_entries WHERE week_id = ?').run(week.id);
  db.prepare('DELETE FROM timecard_expenses WHERE week_id = ?').run(week.id);
  db.prepare("UPDATE timecard_weeks SET status = 'Not sent', decline_reason = NULL WHERE id = ?").run(week.id);
  return getWeek(week.id);
});

function submitWeek(user, weekId) {
  const week = myEditableWeek(user, weekId);
  const count = db.prepare('SELECT COUNT(*) AS c FROM timecard_entries WHERE week_id = ?').get(week.id).c;
  if (!count) throw new TimecardError('Add at least one entry before sending for approval.');
  db.prepare(`UPDATE timecard_weeks SET status = 'Waiting on approval', submitted_date = ?, decline_reason = NULL,
    full_name = ?, email = ? WHERE id = ?`).run(todayYmd(), user.name || '', user.email || '', week.id);
  return getWeek(week.id);
}

// ---- Admin -----------------------------------------------------------------

function pendingWeeks() {
  return db.prepare("SELECT * FROM timecard_weeks WHERE status = 'Waiting on approval' ORDER BY week_ending DESC, full_name").all().map(weekSummary);
}

function recentDecisions(limit = 15) {
  return db.prepare(`SELECT * FROM timecard_weeks WHERE status IN ('Approved','Declined')
    ORDER BY approval_date DESC, week_ending DESC LIMIT ?`).all(limit).map((w) => {
    const s = weekSummary(w);
    return { id: s.id, fullName: s.fullName, weekEnding: s.weekEnding, status: s.status, approvedBy: s.approvedBy, approvalDate: s.approvalDate, total: s.total, declineReason: s.declineReason };
  });
}

function contractors() {
  const { TIMESHEET_USERS_SQL } = require('./permissions');
  return db.prepare(`SELECT id, name, email, hourly_rate FROM users WHERE ${TIMESHEET_USERS_SQL} ORDER BY name`).all()
    .map((u) => ({ id: u.id, name: u.name, email: u.email, hourlyRate: u.hourly_rate > 0 ? u.hourly_rate : null }));
}

// Approved hours for weeks ending within [from, to] (inclusive), like the old dashboard.
function approvedHoursInRange(from, to) {
  const row = db.prepare(`SELECT COALESCE(SUM(e.hours), 0) AS h FROM timecard_entries e
    JOIN timecard_weeks w ON w.id = e.week_id
    WHERE w.status = 'Approved' AND w.week_ending >= ? AND w.week_ending <= ?`).get(from, to);
  return round2(row.h);
}

const pad2 = (n) => String(n).padStart(2, '0');
const ymdOf = (y, m, d) => { const dt = new Date(Date.UTC(y, m, d, 12)); return dt.toISOString().slice(0, 10); };

function hoursSummary(today = todayYmd()) {
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7)) - 1;
  const q = Math.floor(m / 3);
  let lqm = (q - 1) * 3; let lqy = y;
  if (lqm < 0) { lqm += 12; lqy -= 1; }
  const fyStart = m >= 6 ? y : y - 1; // Australian financial year: 1 July – 30 June
  return {
    thisMonth: approvedHoursInRange(`${y}-${pad2(m + 1)}-01`, ymdOf(y, m + 1, 0)),
    lastMonth: approvedHoursInRange(ymdOf(y, m - 1, 1), ymdOf(y, m, 0)),
    lastQuarter: approvedHoursInRange(ymdOf(lqy, lqm, 1), ymdOf(lqy, lqm + 3, 0)),
    lastYear: approvedHoursInRange(`${y - 1}-01-01`, `${y - 1}-12-31`),
    lastFinancialYear: approvedHoursInRange(`${fyStart - 1}-07-01`, `${fyStart}-06-30`),
  };
}

// Hours per person for the dashboard: approved hours this month, last month, this
// financial year and all time, plus hours waiting on approval. Everyone who logs time
// is listed (even with no hours yet), along with anyone who has timesheets but no
// longer logs time (e.g. a removed contractor).
function peopleSummary(today = todayYmd()) {
  const { TIMESHEET_USERS_SQL } = require('./permissions');
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7)) - 1;
  const fyStart = m >= 6 ? y : y - 1;
  const ranges = {
    thisMonth: [`${y}-${pad2(m + 1)}-01`, ymdOf(y, m + 1, 0)],
    lastMonth: [ymdOf(y, m - 1, 1), ymdOf(y, m, 0)],
    thisFy: [`${fyStart}-07-01`, `${fyStart + 1}-06-30`],
  };
  const sum = (k) => `SUM(CASE WHEN w.status = 'Approved' AND w.week_ending BETWEEN '${ranges[k][0]}' AND '${ranges[k][1]}' THEN COALESCE(e.hours, 0) ELSE 0 END) AS ${k}`;
  const hours = db.prepare(`SELECT w.user_id AS id, MAX(w.full_name) AS fullName, MAX(w.email) AS email,
      ${sum('thisMonth')}, ${sum('lastMonth')}, ${sum('thisFy')},
      SUM(CASE WHEN w.status = 'Approved' THEN COALESCE(e.hours, 0) ELSE 0 END) AS allTime,
      SUM(CASE WHEN w.status = 'Waiting on approval' THEN COALESCE(e.hours, 0) ELSE 0 END) AS waiting
    FROM timecard_weeks w LEFT JOIN timecard_entries e ON e.week_id = w.id GROUP BY w.user_id`).all();
  const weeks = db.prepare(`SELECT user_id AS id, MAX(submitted_date) AS lastSent,
      SUM(CASE WHEN status = 'Approved' THEN 1 ELSE 0 END) AS approvedWeeks,
      SUM(CASE WHEN status = 'Declined' THEN 1 ELSE 0 END) AS declinedWeeks
    FROM timecard_weeks GROUP BY user_id`).all();
  const byId = new Map();
  db.prepare(`SELECT id, name, email, role, hourly_rate FROM users WHERE ${TIMESHEET_USERS_SQL}`).all().forEach((u) => {
    byId.set(u.id, { id: u.id, name: u.name, email: u.email, role: u.role, hourlyRate: u.hourly_rate > 0 ? u.hourly_rate : null, active: true });
  });
  hours.forEach((h) => {
    if (!byId.has(h.id)) {
      const u = db.prepare('SELECT name, email, role, hourly_rate FROM users WHERE id = ?').get(h.id);
      byId.set(h.id, { id: h.id, name: u?.name || h.fullName || 'Unknown', email: u?.email || h.email || '', role: u?.role || null, hourlyRate: u?.hourly_rate > 0 ? u.hourly_rate : null, active: false });
    }
    Object.assign(byId.get(h.id), { thisMonth: round2(h.thisMonth), lastMonth: round2(h.lastMonth), thisFy: round2(h.thisFy), allTime: round2(h.allTime), waiting: round2(h.waiting) });
  });
  weeks.forEach((w) => { const p = byId.get(w.id); if (p) Object.assign(p, { lastSent: w.lastSent || '', approvedWeeks: w.approvedWeeks, declinedWeeks: w.declinedWeeks }); });
  return [...byId.values()].map((p) => ({
    thisMonth: 0, lastMonth: 0, thisFy: 0, allTime: 0, waiting: 0, lastSent: '', approvedWeeks: 0, declinedWeeks: 0, ...p,
    estPayThisMonth: p.hourlyRate ? round2(p.hourlyRate * (p.thisMonth || 0)) : null,
  })).sort((a, b) => a.name.localeCompare(b.name));
}

// Approved hours per client / project, all time — the dashboard's pie chart.
function projectBreakdown() {
  return db.prepare(`SELECT COALESCE(NULLIF(e.client_project, ''), '(No project)') AS clientProject, SUM(e.hours) AS totalHours
    FROM timecard_entries e JOIN timecard_weeks w ON w.id = e.week_id
    WHERE w.status = 'Approved' GROUP BY 1 ORDER BY 2 DESC`).all()
    .map((r) => ({ clientProject: r.clientProject, totalHours: round2(r.totalHours) }));
}

// Approved hours per week ending, all contractors — optionally for one project.
function projectWeeklyHours(clientProject) {
  const p = String(clientProject || '').trim();
  return db.prepare(`SELECT w.week_ending AS weekEnding, SUM(e.hours) AS totalHours
    FROM timecard_entries e JOIN timecard_weeks w ON w.id = e.week_id
    WHERE w.status = 'Approved' ${p ? 'AND e.client_project = ?' : ''}
    GROUP BY w.week_ending ORDER BY w.week_ending DESC`).all(...(p ? [p] : []))
    .map((r) => ({ weekEnding: r.weekEnding, totalHours: round2(r.totalHours) }));
}

function approvedProjects() {
  return db.prepare(`SELECT DISTINCT e.client_project AS p FROM timecard_entries e JOIN timecard_weeks w ON w.id = e.week_id
    WHERE w.status = 'Approved' AND e.client_project IS NOT NULL AND e.client_project != '' ORDER BY 1`).all().map((r) => r.p);
}

function pendingWeek(weekId) {
  const week = getWeek(weekId);
  if (!week) throw new TimecardError('Week not found.', 404);
  if (week.status !== 'Waiting on approval') throw new TimecardError('This week is not awaiting approval.');
  return week;
}

function approveWeek(admin, weekId) {
  const week = pendingWeek(weekId);
  db.prepare(`UPDATE timecard_weeks SET status = 'Approved', approved_by = ?, approval_date = ?, decline_reason = NULL WHERE id = ?`)
    .run(admin.name || '', todayYmd(), week.id);
  return weekSummary(getWeek(week.id));
}

function declineWeek(admin, weekId, reason) {
  const why = String(reason || '').trim();
  if (!why) throw new TimecardError('Enter a reason for declining.');
  const week = pendingWeek(weekId);
  db.prepare(`UPDATE timecard_weeks SET status = 'Declined', approved_by = ?, approval_date = ?, decline_reason = ? WHERE id = ?`)
    .run(admin.name || '', todayYmd(), why.slice(0, 1000), week.id);
  return weekSummary(getWeek(week.id));
}

// Approved weeks in full (entries, expenses, rate, estimated pay) — the Approved
// tab, its printout and the payroll CSV. Optionally for one contractor.
function approvedWeeksDetailed({ userId, from, to } = {}) {
  const where = ["w.status = 'Approved'"]; const args = [];
  if (userId) { where.push('w.user_id = ?'); args.push(userId); }
  if (from && YMD.test(from)) { where.push('w.week_ending >= ?'); args.push(from); }
  if (to && YMD.test(to)) { where.push('w.week_ending <= ?'); args.push(to); }
  return db.prepare(`SELECT w.*, u.hourly_rate FROM timecard_weeks w LEFT JOIN users u ON u.id = w.user_id
    WHERE ${where.join(' AND ')} ORDER BY w.week_ending DESC, w.full_name`).all(...args).map((w) => {
    const s = weekSummary(w);
    const rate = w.hourly_rate > 0 ? w.hourly_rate : null;
    return { ...s, hourlyRate: rate, estPay: rate ? round2(rate * s.total) : null };
  });
}

const dmy = (ymd) => { const m = String(ymd || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[3]}/${m[2]}/${m[1]}` : (ymd || ''); };
function csvCell(v) {
  let s = String(v ?? '');
  // Don't let a spreadsheet treat a name as a formula.
  if (/^[=+\-@]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// Same columns as the old "Download CSV".
function approvedCsv(opts) {
  const lines = ['Contractor,Email,Week Ending,Approved By,Approval Date,Total Hours,Hourly Rate,Est. Pay,Expenses'];
  approvedWeeksDetailed(opts).forEach((w) => {
    lines.push([
      csvCell(w.fullName), csvCell(w.email), dmy(w.weekEnding), csvCell(w.approvedBy), dmy(w.approvalDate),
      w.total.toFixed(2), w.hourlyRate ? w.hourlyRate.toFixed(2) : '', w.estPay != null ? w.estPay.toFixed(2) : '', w.expenseTotal.toFixed(2),
    ].join(','));
  });
  return lines.join('\r\n') + '\r\n';
}

module.exports = {
  TimecardError, EXPENSE_TYPES, DAYS, todayYmd, addDays, sundayOnOrAfter, computeHours, weekSummary, getWeek,
  findOrCreateWeek, currentWeek, contractorState, addEntry, deleteEntry, addExpense, deleteExpense, clearWeek, submitWeek,
  pendingWeeks, recentDecisions, contractors, approvedHoursInRange, hoursSummary, projectBreakdown, projectWeeklyHours,
  approvedProjects, peopleSummary, approveWeek, declineWeek, approvedWeeksDetailed, approvedCsv, dmy, YMD,
};

// Brings the old Time Card Google Sheet (downloaded as .xlsx) into ITF Time Card:
// contractor logins, weeks, entries and expenses.
//
// • Contractors get a Work Desk login (role Contractor) with their sheet email and
//   hourly rate, and can sign in with their existing Time Card password.
// • Admin rows in the sheet are not imported — Work Desk admins already exist.
// • Weeks keep the dates the old app showed (including its habit of changing
//   "week ending" to the date sent).
// • The old app left an empty "Not sent" copy of some weeks that shared an ID with
//   a sent week (and so showed that week's entries) — those copies are dropped,
//   as are "Not sent" weeks with nothing in them.
// • Safe to run again: weeks are matched on the old WeekId and refreshed from the
//   sheet, unless they've since been approved/declined/changed in Work Desk.
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { v4: uuid } = require('uuid');
const { db } = require('./db');
const { readZip } = require('./zipRead');
const { computeHours } = require('./timecard');

const STATUSES = ['Not sent', 'Waiting on approval', 'Approved', 'Declined'];
const EXPENSE_TYPES = ['Fuel', 'Parking', 'Tolls', 'Travel', 'Materials', 'Meals', 'Other'];

// ---- Minimal .xlsx reader --------------------------------------------------
const unxml = (s) => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&amp;/g, '&');
const textOf = (xml) => [...String(xml).matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((m) => unxml(m[1])).join('');
const colIndex = (ref) => [...ref.replace(/\d+/g, '')].reduce((n, c) => n * 26 + (c.charCodeAt(0) - 64), 0) - 1;

function readXlsx(buffer) {
  let files;
  try { files = readZip(buffer); } catch (err) { throw new Error('That file isn’t an Excel (.xlsx) file.'); }
  const str = (name) => (files[name] ? files[name].toString('utf8') : '');
  const workbook = str('xl/workbook.xml');
  if (!workbook) throw new Error('That file isn’t an Excel (.xlsx) file.');
  const rels = {};
  for (const m of str('xl/_rels/workbook.xml.rels').matchAll(/<Relationship\b[^>]*>/g)) {
    const id = m[0].match(/\bId="([^"]+)"/)?.[1]; const target = m[0].match(/\bTarget="([^"]+)"/)?.[1];
    if (id && target) rels[id] = target.replace(/^\/?(xl\/)?/, 'xl/');
  }
  const shared = [...str('xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1]));
  const sheets = {};
  for (const m of workbook.matchAll(/<sheet\b[^>]*>/g)) {
    const name = unxml(m[0].match(/\bname="([^"]+)"/)?.[1] || '');
    const rid = m[0].match(/\br:id="([^"]+)"/)?.[1];
    const xml = str(rels[rid] || '');
    const rows = [];
    for (const r of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const rowNum = Number(r[0].match(/\br="(\d+)"/)?.[1] || rows.length + 1);
      const cells = [];
      for (const c of r[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const ref = c[1].match(/\br="([A-Z]+\d+)"/)?.[1];
        const t = c[1].match(/\bt="([^"]+)"/)?.[1];
        const body = c[2] || '';
        const v = body.match(/<v>([\s\S]*?)<\/v>/)?.[1];
        let val = null;
        if (t === 's') val = shared[Number(v)] ?? '';
        else if (t === 'inlineStr') val = textOf(body);
        else if (t === 'str' || t === 'e') val = v != null ? unxml(v) : '';
        else if (t === 'b') val = v === '1';
        else if (v != null) val = Number(v);
        cells[ref ? colIndex(ref) : cells.length] = val;
      }
      rows[rowNum - 1] = cells;
    }
    sheets[name] = rows;
  }
  return sheets;
}

// Rows under the header row (found by its first column name) as objects.
function table(sheets, name, firstHeader) {
  const rows = sheets[Object.keys(sheets).find((n) => n.toLowerCase() === name.toLowerCase())] || [];
  const h = rows.findIndex((r) => r && String(r[0] ?? '').trim() === firstHeader);
  if (h < 0) return null;
  const headers = rows[h].map((x) => String(x ?? '').trim());
  return rows.slice(h + 1).filter((r) => r && r[0] != null && String(r[0]).trim() !== '')
    .map((r) => Object.fromEntries(headers.map((k, i) => [k, r[i]])));
}

// Dates and times may arrive as text ("2026-09-14", "08:30") or as Excel numbers.
const pad = (n) => String(n).padStart(2, '0');
function ymd(v) {
  if (v == null || v === '') return '';
  if (typeof v === 'number') { const d = new Date(Math.round((v - 25569) * 86400000)); return d.toISOString().slice(0, 10); }
  const s = String(v).trim();
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/); if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const au = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/); if (au) return `${au[3]}-${pad(au[2])}-${pad(au[1])}`;
  return '';
}
function hhmm(v) {
  if (v == null || v === '') return '';
  if (typeof v === 'number') { const mins = Math.round((v % 1) * 1440); return `${pad(Math.floor(mins / 60) % 24)}:${pad(mins % 60)}`; }
  const m = String(v).trim().match(/^(\d{1,2}):(\d{2})/); return m ? `${pad(m[1])}:${m[2]}` : '';
}
const txt = (v) => (v == null ? '' : String(v).trim());
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

// ---- Plan --------------------------------------------------------------------
function plan(buffer) {
  const sheets = readXlsx(buffer);
  const users = table(sheets, 'Users', 'Username');
  const weeks = table(sheets, 'Weeks', 'WeekId');
  const entries = table(sheets, 'Entries', 'EntryId') || [];
  const expenses = table(sheets, 'Expenses', 'ExpenseId') || [];
  if (!users || !weeks) throw new Error('This doesn’t look like the Time Card sheet — it needs Users and Weeks tabs.');

  const warnings = [];
  const byEmail = db.prepare('SELECT id, name, email, role, hourly_rate FROM users WHERE lower(email) = lower(?)');

  // Contractors
  const contractors = new Map(); // username(lower) -> plan
  for (const u of users) {
    const username = txt(u.Username);
    if (txt(u.Role).toLowerCase() !== 'contractor') continue;
    const name = txt(u.FullName) || username;
    const email = txt(u.Email);
    const rate = num(u.HourlyRate) > 0 ? Math.round(num(u.HourlyRate) * 100) / 100 : null;
    const c = { username, name, email, hourlyRate: rate, passwordHash: txt(u.PasswordHash), salt: txt(u.Salt) };
    if (!email) { c.action = 'skip'; warnings.push(`${name} has no email in the sheet, so no login was set up (and their weeks are skipped).`); }
    else {
      const existing = byEmail.all(email);
      const contractor = existing.find((x) => x.role === 'contractor');
      if (contractor) { c.action = 'existing'; c.userId = contractor.id; }
      else if (existing.length) {
        c.action = 'staff'; c.userId = existing[0].id;
        warnings.push(`${name}'s email (${email}) belongs to the Work Desk login “${existing[0].name}”, which isn't a Contractor. Their weeks are imported under that login; change its role to Contractor in Settings if they should see My Timesheet.`);
      } else c.action = 'create';
    }
    contractors.set(username.toLowerCase(), c);
  }

  // Weeks: drop the old app's empty duplicates and empty unsent weeks.
  const entriesBy = new Map(); for (const e of entries) { const k = txt(e.WeekId); if (!entriesBy.has(k)) entriesBy.set(k, []); entriesBy.get(k).push(e); }
  const expensesBy = new Map(); for (const x of expenses) { const k = txt(x.WeekId); if (!expensesBy.has(k)) expensesBy.set(k, []); expensesBy.get(k).push(x); }
  const groups = new Map(); for (const w of weeks) { const k = txt(w.WeekId); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(w); }

  const out = []; const skipped = { emptyDrafts: 0, duplicates: 0, notContractor: 0 };
  for (const [weekId, rows] of groups) {
    let keep = rows;
    if (rows.length > 1) {
      const sent = rows.filter((r) => txt(r.Status) !== 'Not sent');
      keep = sent.length ? sent : [rows[rows.length - 1]];
      skipped.duplicates += rows.length - keep.length;
      if (keep.length > 1) {
        keep.sort((a, b) => ymd(b.SubmittedDate).localeCompare(ymd(a.SubmittedDate)));
        skipped.duplicates += keep.length - 1;
        warnings.push(`Week ${weekId} appears ${keep.length} times as sent; only the most recently sent one was kept.`);
        keep = [keep[0]];
      }
    }
    const w = keep[0];
    const c = contractors.get(txt(w.Username).toLowerCase());
    if (!c || c.action === 'skip') { skipped.notContractor += 1; continue; }
    const status = STATUSES.includes(txt(w.Status)) ? txt(w.Status) : 'Not sent';
    const es = entriesBy.get(weekId) || []; const xs = expensesBy.get(weekId) || [];
    if (status === 'Not sent' && !es.length && !xs.length) { skipped.emptyDrafts += 1; continue; }
    out.push({
      legacyId: weekId, contractor: c, fullName: txt(w.FullName) || c.name, email: txt(w.Email) || c.email,
      weekEnding: ymd(w.WeekEnding) || ymd(weekId.split('|')[1]), status,
      submittedDate: ymd(w.SubmittedDate), approvedBy: txt(w.ApprovedBy), approvalDate: ymd(w.ApprovalDate), declineReason: txt(w.DeclineReason),
      entries: es.map((e) => {
        const start = hhmm(e.StartTime); const finish = hhmm(e.FinishTime); const breakMins = Math.max(0, Math.round(num(e.BreakMins)));
        const hours = e.Hours != null && e.Hours !== '' ? Math.round(num(e.Hours) * 100) / 100 : computeHours(start, finish, breakMins);
        return { day: txt(e.Day), date: ymd(e.Date), clientProject: txt(e.ClientProject), start, finish, breakMins, hours, task: txt(e.Task) };
      }),
      expenses: xs.map((x) => ({
        date: ymd(x.Date), type: EXPENSE_TYPES.includes(txt(x.Type)) ? txt(x.Type) : 'Other',
        description: txt(x.Description).slice(0, 200), amount: Math.round(num(x.Amount) * 100) / 100,
      })).filter((x) => x.amount > 0),
    });
  }
  if (!out.length && !weeks.length) warnings.push('The Weeks tab is empty.');

  // What would happen to each week.
  const existingWeek = db.prepare('SELECT id, status, imported_status FROM timecard_weeks WHERE legacy_id = ?');
  for (const w of out) {
    const ex = existingWeek.get(w.legacyId);
    if (!ex) w.action = 'add';
    else if (ex.imported_status != null && ex.status !== ex.imported_status) { w.action = 'keep'; w.existingId = ex.id; }
    else { w.action = 'update'; w.existingId = ex.id; }
  }
  return { contractors: [...contractors.values()], weeks: out, skipped, warnings };
}

// What the admin sees before importing.
function summary(p) {
  const count = (status) => p.weeks.filter((w) => w.status === status).length;
  return {
    contractors: p.contractors.map((c) => ({
      name: c.name, email: c.email, username: c.username, hourlyRate: c.hourlyRate, action: c.action,
      weeks: p.weeks.filter((w) => w.contractor === c).length,
    })),
    weeks: {
      total: p.weeks.length, approved: count('Approved'), waiting: count('Waiting on approval'), declined: count('Declined'), notSent: count('Not sent'),
      add: p.weeks.filter((w) => w.action === 'add').length,
      update: p.weeks.filter((w) => w.action === 'update').length,
      keep: p.weeks.filter((w) => w.action === 'keep').length,
    },
    entries: p.weeks.reduce((n, w) => n + w.entries.length, 0),
    hours: Math.round(p.weeks.reduce((n, w) => n + w.entries.reduce((m, e) => m + e.hours, 0), 0) * 100) / 100,
    expenses: p.weeks.reduce((n, w) => n + w.expenses.length, 0),
    skipped: p.skipped,
    warnings: p.warnings,
  };
}

// ---- Import ------------------------------------------------------------------
function run(buffer) {
  const p = plan(buffer);
  const result = db.transaction(() => {
    let created = 0;
    const createdByEmail = new Map();
    for (const c of p.contractors) {
      if (c.action === 'create' && createdByEmail.has(c.email.toLowerCase())) {
        c.userId = createdByEmail.get(c.email.toLowerCase());
      } else if (c.action === 'create') {
        c.userId = uuid();
        // A random Work Desk password; they sign in with their old Time Card one.
        db.prepare(`INSERT INTO users (id, name, email, password_hash, role, hourly_rate, legacy_pw_hash, legacy_pw_salt)
          VALUES (?, ?, ?, ?, 'contractor', ?, ?, ?)`).run(
          c.userId, c.name, c.email, bcrypt.hashSync(crypto.randomBytes(24).toString('hex'), 10), c.hourlyRate,
          /^[0-9a-f]{64}$/i.test(c.passwordHash) ? c.passwordHash.toLowerCase() : null, c.salt || null,
        );
        createdByEmail.set(c.email.toLowerCase(), c.userId);
        created += 1;
      } else if (c.action === 'existing' && c.hourlyRate) {
        db.prepare('UPDATE users SET hourly_rate = COALESCE(hourly_rate, ?) WHERE id = ?').run(c.hourlyRate, c.userId);
      }
    }
    const insEntry = db.prepare(`INSERT INTO timecard_entries (id, week_id, user_id, day, date, client_project, start_time, finish_time, break_mins, hours, task)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const insExp = db.prepare('INSERT INTO timecard_expenses (id, week_id, user_id, date, type, description, amount) VALUES (?, ?, ?, ?, ?, ?, ?)');
    let added = 0; let updated = 0; let kept = 0;
    for (const w of p.weeks) {
      if (w.action === 'keep') { kept += 1; continue; }
      const userId = w.contractor.userId;
      const fields = [userId, w.fullName, w.email, w.weekEnding, w.status, w.submittedDate || null, w.approvedBy || null, w.approvalDate || null, w.declineReason || null, w.status];
      let id = w.existingId;
      if (id) {
        db.prepare(`UPDATE timecard_weeks SET user_id = ?, full_name = ?, email = ?, week_ending = ?, status = ?, submitted_date = ?, approved_by = ?,
          approval_date = ?, decline_reason = ?, imported_status = ? WHERE id = ?`).run(...fields, id);
        db.prepare('DELETE FROM timecard_entries WHERE week_id = ?').run(id);
        db.prepare('DELETE FROM timecard_expenses WHERE week_id = ?').run(id);
        updated += 1;
      } else {
        id = uuid();
        db.prepare(`INSERT INTO timecard_weeks (user_id, full_name, email, week_ending, status, submitted_date, approved_by, approval_date, decline_reason, imported_status, id, legacy_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(...fields, id, w.legacyId);
        added += 1;
      }
      for (const e of w.entries) insEntry.run(uuid(), id, userId, e.day, e.date || null, e.clientProject, e.start, e.finish, e.breakMins, e.hours, e.task);
      for (const x of w.expenses) insExp.run(uuid(), id, userId, x.date || null, x.type, x.description, x.amount);
    }
    return { contractorsCreated: created, weeksAdded: added, weeksUpdated: updated, weeksKept: kept };
  })();
  return { ...summary(p), result };
}

module.exports = { readXlsx, plan, summary, run, preview: (buffer) => summary(plan(buffer)) };

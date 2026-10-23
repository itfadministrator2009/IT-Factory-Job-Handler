// Importing the old Time Card Google Sheet (.xlsx): contractor logins that work
// with their old password, weeks with the old app's quirks handled, and safe
// re-imports.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const express = require('express');
const archiver = require('archiver');
const { freshDb, startTestServer, registerUser } = require('./helpers');

let client, server, db, admin;

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const col = (i) => String.fromCharCode(65 + i);
function sheetXml(rows) {
  return `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${
    rows.map((r, ri) => `<row r="${ri + 1}">${r.map((v, ci) => (v == null ? '' : typeof v === 'number'
      ? `<c r="${col(ci)}${ri + 1}"><v>${v}</v></c>`
      : `<c r="${col(ci)}${ri + 1}" t="inlineStr"><is><t>${esc(v)}</t></is></c>`)).join('')}</row>`).join('')
  }</sheetData></worksheet>`;
}
// A tiny .xlsx with the old sheet's layout: title rows, then headers on row 4.
function makeXlsx(tabs) {
  return new Promise((resolve, reject) => {
    const a = archiver('zip'); const chunks = [];
    a.on('data', (c) => chunks.push(c)); a.on('end', () => resolve(Buffer.concat(chunks))); a.on('error', reject);
    const names = Object.keys(tabs);
    a.append(`<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${
      names.map((n, i) => `<sheet name="${n}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`, { name: 'xl/workbook.xml' });
    a.append(`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${
      names.map((n, i) => `<Relationship Id="rId${i + 1}" Type="worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}</Relationships>`, { name: 'xl/_rels/workbook.xml.rels' });
    names.forEach((n, i) => a.append(sheetXml([[n], ['note'], [], ...tabs[n]]), { name: `xl/worksheets/sheet${i + 1}.xml` }));
    a.finalize();
  });
}

const salt = 'salt-123';
const oldHash = crypto.createHash('sha256').update(salt + 'oldpassword', 'utf8').digest('hex');
function oldSheet({ cara = 'Waiting on approval' } = {}) {
  return makeXlsx({
    Users: [
      ['Username', 'PasswordHash', 'Salt', 'Role', 'FullName', 'Email', 'HourlyRate'],
      ['admin', 'x', 'y', 'admin', 'Ana Admin', 'ana@itf.test', null],
      ['CaraC', oldHash, salt, 'contractor', 'Cara Contractor', 'Cara@Contractor.test', 40],
      ['DanF', oldHash, salt, 'contractor', 'Dan Field', 'dan@contractor.test', 30],
      ['NoMail', oldHash, salt, 'contractor', 'No Email', '', 30],
    ],
    Expenses: [
      ['ExpenseId', 'WeekId', 'Username', 'Date', 'Type', 'Description', 'Amount'],
      ['x1', 'CaraC|2026-09-20', 'CaraC', '2026-09-15', 'Tolls', 'M7', 7.5],
    ],
    Weeks: [
      ['WeekId', 'Username', 'FullName', 'Email', 'WeekEnding', 'Status', 'SubmittedDate', 'ApprovedBy', 'ApprovalDate', 'DeclineReason'],
      // Sent week whose week ending the old app changed to the date sent…
      ['CaraC|2026-09-20', 'CaraC', 'Cara Contractor', 'cara@contractor.test', '2026-09-18', 'Approved', '2026-09-18', 'Tom K', '2026-09-21', null],
      // …and the empty copy it then created with the same WeekId.
      ['CaraC|2026-09-20', 'CaraC', 'Cara Contractor', 'cara@contractor.test', '2026-09-20', 'Not sent', null, null, null, null],
      // Two different weeks that ended up with the same week ending.
      ['CaraC|2026-09-27', 'CaraC', 'Cara Contractor', 'cara@contractor.test', '2026-09-25', 'Approved', '2026-09-25', 'Tom K', '2026-09-28', null],
      ['CaraC|2026-10-04', 'CaraC', 'Cara Contractor', 'cara@contractor.test', '2026-09-25', cara, '2026-09-25', null, null, null],
      // Empty draft: skipped.
      ['DanF|2026-10-11', 'DanF', 'Dan Field', 'dan@contractor.test', '2026-10-11', 'Not sent', null, null, null, null],
      // Draft with hours (times stored as Excel numbers): kept.
      ['DanF|2026-10-18', 'DanF', 'Dan Field', 'dan@contractor.test', 46313, 'Not sent', null, null, null, null],
    ],
    Entries: [
      ['EntryId', 'WeekId', 'Username', 'Day', 'Date', 'ClientProject', 'StartTime', 'FinishTime', 'BreakMins', 'Hours', 'Task'],
      ['e1', 'CaraC|2026-09-20', 'CaraC', 'Monday', '2026-09-14', 'WSLHD', '08:00', '16:30', 30, 8, 'Deploy'],
      ['e2', 'CaraC|2026-09-20', 'CaraC', 'Tuesday', '2026-09-15', 'WSLHD', '08:00', '12:00', 0, 4, 'Deploy'],
      ['e3', 'CaraC|2026-09-27', 'CaraC', 'Monday', '2026-09-21', 'Acme', '09:00', '17:00', 60, 7, 'Moves'],
      ['e4', 'CaraC|2026-10-04', 'CaraC', 'Monday', '2026-09-28', 'Acme', '09:00', '15:00', 0, 6, 'Moves'],
      ['e5', 'DanF|2026-10-18', 'DanF', 'Monday', '2026-10-12', 'Westpac', 0.3125, 0.6875, 30, null, 'Racking'],
    ],
  });
}

before(async () => {
  ({ db } = freshDb());
  require('../email').sendMail = async () => {};
  const app = express();
  app.use(express.json({ limit: '15mb' }));
  app.use('/api/auth', require('../routes/auth'));
  app.use('/api/users', require('../routes/users'));
  app.use('/api/timecard', require('../routes/timecard'));
  client = await startTestServer(app);
  server = client.server;
  admin = await registerUser(client, { name: 'Ana Admin', email: 'ana@itf.test' });
});
after(() => server.close());

const send = async (path, buf, token = admin.token) => client.post(path, { token, body: { fileBase64: buf.toString('base64') } });

test('only admins can import, and other files are refused politely', async () => {
  const buf = await oldSheet();
  const staff = await registerUser(client, { name: 'Sam', email: 'sam@itf.test' });
  db.prepare("UPDATE users SET role = 'user' WHERE id = ?").run(staff.id);
  assert.equal((await send('/api/timecard/admin/import/preview', buf, staff.token)).status, 403);
  const bad = await send('/api/timecard/admin/import/preview', Buffer.from('not a spreadsheet'));
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /xlsx/);
});

test('preview shows what will come across', async () => {
  const r = await send('/api/timecard/admin/import/preview', await oldSheet());
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.contractors.map((c) => [c.name, c.action, c.weeks]), [['Cara Contractor', 'create', 3], ['Dan Field', 'create', 1], ['No Email', 'skip', 0]]);
  assert.deepEqual(r.data.weeks, { total: 4, approved: 2, waiting: 1, declined: 0, notSent: 1, add: 4, update: 0, keep: 0 });
  assert.equal(r.data.entries, 5);
  assert.equal(r.data.expenses, 1);
  assert.deepEqual(r.data.skipped, { emptyDrafts: 1, duplicates: 1, notContractor: 0 });
  assert.match(r.data.warnings.join(' '), /No Email has no email/);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM timecard_weeks').get().c, 0, 'preview changes nothing');
});

test('import creates contractor logins and their weeks', async () => {
  const r = await send('/api/timecard/admin/import', await oldSheet());
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.result, { contractorsCreated: 2, weeksAdded: 4, weeksUpdated: 0, weeksKept: 0 });
  const cara = db.prepare("SELECT * FROM users WHERE email = 'Cara@Contractor.test'").get();
  assert.equal(cara.role, 'contractor');
  assert.equal(cara.hourly_rate, 40);
  const weeks = db.prepare('SELECT * FROM timecard_weeks WHERE user_id = ? ORDER BY legacy_id').all(cara.id);
  assert.deepEqual(weeks.map((w) => [w.legacy_id, w.week_ending, w.status]), [
    ['CaraC|2026-09-20', '2026-09-18', 'Approved'],
    ['CaraC|2026-09-27', '2026-09-25', 'Approved'],
    ['CaraC|2026-10-04', '2026-09-25', 'Waiting on approval'],
  ]);
  const first = db.prepare('SELECT COUNT(*) c FROM timecard_entries WHERE week_id = ?').get(weeks[0].id).c;
  assert.equal(first, 2, 'entries belong to the sent week, not the empty copy');
  assert.equal(db.prepare('SELECT SUM(amount) s FROM timecard_expenses WHERE week_id = ?').get(weeks[0].id).s, 7.5);
  // Excel time numbers become HH:MM, and missing hours are worked out.
  const dan = db.prepare("SELECT e.* FROM timecard_entries e JOIN users u ON u.id = e.user_id WHERE u.email = 'dan@contractor.test'").get();
  assert.deepEqual([dan.start_time, dan.finish_time, dan.hours], ['07:30', '16:30', 8.5]);
  assert.equal(db.prepare("SELECT week_ending FROM timecard_weeks WHERE legacy_id = 'DanF|2026-10-18'").get().week_ending, '2026-10-18');

  // Admin approval screens and reports include them.
  const st = await client.get('/api/timecard/admin', { token: admin.token });
  assert.equal(st.data.pending.length, 1);
  assert.equal(st.data.pending[0].total, 6);
  const ap = await client.get('/api/timecard/admin/approved', { token: admin.token });
  assert.equal(ap.data.weeks.length, 2);
  assert.equal(ap.data.weeks.find((w) => w.weekEnding === '2026-09-18').estPay, 480);
});

test('contractors log in with their old Time Card password (any capitals in the email)', async () => {
  const bad = await client.post('/api/auth/login', { body: { email: 'cara@contractor.test', password: 'wrongpassword' } });
  assert.equal(bad.status, 401);
  const ok = await client.post('/api/auth/login', { body: { email: ' cara@contractor.TEST ', password: 'oldpassword' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.user.role, 'contractor');
  // It's now a normal Work Desk password.
  const row = db.prepare("SELECT legacy_pw_hash FROM users WHERE email = 'Cara@Contractor.test'").get();
  assert.equal(row.legacy_pw_hash, null);
  assert.equal((await client.post('/api/auth/login', { body: { email: 'cara@contractor.test', password: 'oldpassword' } })).status, 200);
  const my = await client.get('/api/timecard/my', { token: ok.data.token });
  assert.equal(my.status, 200);
  assert.equal(my.data.approvedWeeks.length, 2);
  assert.equal(my.data.pendingWeeks.length, 1);
});

test('an admin password reset replaces the old password', async () => {
  const dan = db.prepare("SELECT id FROM users WHERE email = 'dan@contractor.test'").get();
  await client.post(`/api/users/admin/${dan.id}/reset-password`, { token: admin.token, body: { password: 'brandnew123' } });
  assert.equal((await client.post('/api/auth/login', { body: { email: 'dan@contractor.test', password: 'oldpassword' } })).status, 401);
  assert.equal((await client.post('/api/auth/login', { body: { email: 'dan@contractor.test', password: 'brandnew123' } })).status, 200);
});

test('importing again refreshes weeks but never undoes a Work Desk approval', async () => {
  const waiting = db.prepare("SELECT id FROM timecard_weeks WHERE legacy_id = 'CaraC|2026-10-04'").get().id;
  const a = await client.post(`/api/timecard/admin/weeks/${waiting}/approve`, { token: admin.token });
  assert.equal(a.status, 200);
  const r = await send('/api/timecard/admin/import', await oldSheet());
  assert.deepEqual(r.data.result, { contractorsCreated: 0, weeksAdded: 0, weeksUpdated: 3, weeksKept: 1 });
  assert.equal(db.prepare('SELECT status FROM timecard_weeks WHERE id = ?').get(waiting).status, 'Approved');
  assert.equal(db.prepare("SELECT COUNT(*) c FROM users WHERE role = 'contractor'").get().c, 2);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM timecard_entries').get().c, 5, 'no duplicate entries');
  // Even if the old app later shows it differently, the Work Desk decision stands.
  const r2 = await send('/api/timecard/admin/import/preview', await oldSheet({ cara: 'Declined' }));
  assert.equal(r2.data.weeks.keep, 1);
});

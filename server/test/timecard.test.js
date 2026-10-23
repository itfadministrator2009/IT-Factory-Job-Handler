// ITF Time Card: contractors log a week's hours and expenses and send it; Work
// Desk admins approve or decline it, with the same emails the old app sent.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { freshDb, startTestServer, registerUser } = require('./helpers');

let client, server, db, admin, admin2, staff, con, con2, sent;

async function login(email) {
  const { data } = await client.post('/api/auth/login', { body: { email, password: 'password123' } });
  return { token: data.token, id: data.user.id, user: data.user };
}

before(async () => {
  ({ db } = freshDb());
  // Capture emails instead of sending them.
  sent = [];
  require('../email').sendMail = async (m) => { sent.push(m); };
  const app = express();
  app.use(express.json());
  app.use('/api/auth', require('../routes/auth'));
  app.use('/api/users', require('../routes/users'));
  app.use('/api/projects', require('../routes/projects'));
  app.use('/api/timecard', require('../routes/timecard'));
  client = await startTestServer(app);
  server = client.server;
  admin = await registerUser(client, { name: 'Ana Admin', email: 'ana@itf.test' }); // first user = admin
  admin2 = await registerUser(client, { name: 'Ben Boss', email: 'ben@itf.test' });
  staff = await registerUser(client, { name: 'Sam Staff', email: 'sam@itf.test' });
  db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(admin2.id);
  const mk = async (name, email, hourlyRate) => {
    const r = await client.post('/api/users/admin', { token: admin.token, body: { name, email, password: 'password123', role: 'contractor', hourlyRate } });
    assert.equal(r.status, 201);
    assert.equal(r.data.user.role, 'contractor');
    return login(email);
  };
  con = await mk('Cara Contractor', 'cara@contractor.test', 80);
  con2 = await mk('Dan Contractor', 'dan@contractor.test', '');
});

after(() => server.close());
beforeEach(() => { sent.length = 0; });

const flush = () => new Promise((r) => setTimeout(r, 30));

test('contractor accounts only reach ITF Time Card', async () => {
  assert.equal(con.user.accessAssets, false);
  assert.equal(con.user.accessStorage, false);
  const projects = await client.get('/api/projects', { token: con.token });
  assert.equal(projects.status, 403);
  assert.equal(projects.data.code, 'contractor_only');
  assert.equal((await client.get('/api/users', { token: con.token })).status, 403);
  assert.equal((await client.get('/api/auth/me', { token: con.token })).status, 200);
  assert.equal((await client.get('/api/timecard/admin', { token: con.token })).status, 403);
  // Staff and admins can't use the contractor side, and contractors aren't offered as job owners.
  assert.equal((await client.get('/api/timecard/my', { token: staff.token })).status, 403);
  const owners = await client.get('/api/users', { token: staff.token });
  assert.ok(!owners.data.users.some((u) => u.id === con.id));
  assert.equal((await client.get('/api/timecard/admin', { token: staff.token })).status, 403);
});

test('hours maths matches the old app', () => {
  const { computeHours } = require('../timecard');
  assert.equal(computeHours('08:00', '16:30', 30), 8);
  assert.equal(computeHours('22:00', '06:00', 0), 8); // past midnight
  assert.equal(computeHours('09:00', '09:10', 30), 0); // never negative
  assert.equal(computeHours('08:15', '17:05', 45), 8.08);
});

let weekId;
test('contractor logs a week, then sends it to every admin', async () => {
  const s = await client.get('/api/timecard/my', { token: con.token });
  assert.equal(s.status, 200);
  assert.equal(s.data.week.status, 'Not sent');
  assert.equal(new Date(`${s.data.week.weekEnding}T12:00:00Z`).getUTCDay(), 0, 'weeks end on a Sunday');
  weekId = s.data.week.id;

  // Can't send an empty week.
  assert.equal((await client.post(`/api/timecard/my/weeks/${weekId}/submit`, { token: con.token })).status, 400);

  let r = await client.post(`/api/timecard/my/weeks/${weekId}/entries`, { token: con.token, body: { day: 'Monday', date: '2026-10-19', start: '08:00', finish: '16:30', breakMins: 30, clientProject: 'Harvey Norman — Rollout', task: 'Printers' } });
  assert.equal(r.status, 200);
  r = await client.post(`/api/timecard/my/weeks/${weekId}/entries`, { token: con.token, body: { day: 'Tuesday', date: '2026-10-20', start: '09:00', finish: '13:00', clientProject: 'Acme', task: 'Desk moves' } });
  assert.equal(r.data.week.total, 12);
  assert.deepEqual(r.data.projects, ['Acme', 'Harvey Norman — Rollout']);
  assert.equal((await client.post(`/api/timecard/my/weeks/${weekId}/entries`, { token: con.token, body: { start: '', finish: '' } })).status, 400);

  r = await client.post(`/api/timecard/my/weeks/${weekId}/expenses`, { token: con.token, body: { date: '2026-10-19', type: 'Parking', amount: '12.5', description: 'Site parking' } });
  assert.equal(r.data.week.expenseTotal, 12.5);
  assert.equal((await client.post(`/api/timecard/my/weeks/${weekId}/expenses`, { token: con.token, body: { date: '2026-10-19', amount: 0 } })).status, 400);
  const bad = await client.post(`/api/timecard/my/weeks/${weekId}/expenses`, { token: con.token, body: { date: '2026-10-19', type: 'Yacht', amount: 5 } });
  const odd = bad.data.week.expenses.find((x) => x.amount === 5);
  assert.equal(odd.type, 'Other');
  await client.delete(`/api/timecard/my/weeks/${weekId}/expenses/${odd.id}`, { token: con.token });

  // Another contractor can't touch it.
  assert.equal((await client.post(`/api/timecard/my/weeks/${weekId}/entries`, { token: con2.token, body: { start: '08:00', finish: '09:00' } })).status, 404);

  r = await client.post(`/api/timecard/my/weeks/${weekId}/submit`, { token: con.token });
  assert.equal(r.status, 200);
  assert.notEqual(r.data.week.id, weekId, 'moves on to a fresh week');
  assert.equal(r.data.pendingWeeks.length, 1);
  assert.equal(r.data.pendingWeeks[0].status, 'Waiting on approval');

  // Sent weeks are locked.
  assert.equal((await client.post(`/api/timecard/my/weeks/${weekId}/entries`, { token: con.token, body: { start: '08:00', finish: '09:00' } })).status, 400);

  await flush();
  assert.equal(sent.length, 1);
  assert.match(sent[0].subject, /^Timesheet approval — Cara Contractor — week ending \d\d\/\d\d\/\d{4}$/);
  assert.deepEqual(sent[0].to.split(',').sort(), ['ana@itf.test', 'ben@itf.test']);
  assert.match(sent[0].html, /Harvey Norman — Rollout/);
  assert.match(sent[0].html, /\$12\.50/);
});

test('admin declines with a reason; contractor fixes and resends', async () => {
  const st = await client.get('/api/timecard/admin', { token: admin.token });
  assert.equal(st.data.pending.length, 1);
  assert.equal(st.data.pending[0].total, 12);
  assert.equal(st.data.contractors.length, 2);

  assert.equal((await client.post(`/api/timecard/admin/weeks/${weekId}/decline`, { token: admin.token, body: { reason: ' ' } })).status, 400);
  const d = await client.post(`/api/timecard/admin/weeks/${weekId}/decline`, { token: admin.token, body: { reason: 'Tuesday is missing a project code' } });
  assert.equal(d.status, 200);
  assert.equal(d.data.week.status, 'Declined');
  await flush();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'cara@contractor.test');
  assert.match(sent[0].subject, /^Timesheet needs changes/);
  assert.match(sent[0].html, /missing a project code/);

  // The declined week is what the contractor lands on.
  const s = await client.get('/api/timecard/my', { token: con.token });
  assert.equal(s.data.week.id, weekId);
  assert.equal(s.data.week.declineReason, 'Tuesday is missing a project code');
  const r = await client.post(`/api/timecard/my/weeks/${weekId}/submit`, { token: con.token });
  assert.equal(r.status, 200);
  assert.equal((await client.post(`/api/timecard/admin/weeks/${weekId}/decline`, { token: staff.token, body: { reason: 'x' } })).status, 403);
});

test('admin approves: accounts and the contractor are emailed; reports and CSV include it', async () => {
  const a = await client.post(`/api/timecard/admin/weeks/${weekId}/approve`, { token: admin2.token });
  assert.equal(a.status, 200);
  assert.equal(a.data.week.approvedBy, 'Ben Boss');
  assert.equal((await client.post(`/api/timecard/admin/weeks/${weekId}/approve`, { token: admin.token })).status, 400);
  await flush();
  const to = sent.map((m) => m.to).sort();
  assert.deepEqual(to, ['accounts@itfactory.com.au', 'cara@contractor.test']);
  assert.match(sent.find((m) => m.to === 'accounts@itfactory.com.au').subject, /^Approved for payment — Cara Contractor/);

  const st = await client.get('/api/timecard/admin', { token: admin.token });
  assert.equal(st.data.pending.length, 0);
  assert.equal(st.data.recent[0].status, 'Approved');
  assert.deepEqual(st.data.projects, ['Acme', 'Harvey Norman — Rollout']);
  assert.deepEqual(st.data.projectBreakdown.map((p) => [p.clientProject, p.totalHours]), [['Harvey Norman — Rollout', 8], ['Acme', 4]]);

  const week = db.prepare('SELECT week_ending FROM timecard_weeks WHERE id = ?').get(weekId).week_ending;
  const range = await client.get(`/api/timecard/admin/range?from=${week}&to=${week}`, { token: admin.token });
  assert.equal(range.data.totalHours, 12);
  const pw = await client.get(`/api/timecard/admin/project-weekly?project=${encodeURIComponent('Acme')}`, { token: admin.token });
  assert.deepEqual(pw.data.rows, [{ weekEnding: week, totalHours: 4 }]);

  const ap = await client.get(`/api/timecard/admin/approved?userId=${con.id}`, { token: admin.token });
  assert.equal(ap.data.weeks.length, 1);
  assert.equal(ap.data.weeks[0].hourlyRate, 80);
  assert.equal(ap.data.weeks[0].estPay, 960);
  assert.equal((await client.get(`/api/timecard/admin/approved?userId=${con2.id}`, { token: admin.token })).data.weeks.length, 0);
});

test('CSV export has the old columns', async () => {
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/timecard/admin/approved.csv`, { headers: { Authorization: `Bearer ${admin.token}` } });
  assert.equal(res.status, 200);
  const lines = (await res.text()).trim().split('\r\n');
  assert.equal(lines[0], 'Contractor,Email,Week Ending,Approved By,Approval Date,Total Hours,Hourly Rate,Est. Pay,Expenses');
  assert.match(lines[1], /^Cara Contractor,cara@contractor\.test,\d\d\/\d\d\/\d{4},Ben Boss,\d\d\/\d\d\/\d{4},12\.00,80\.00,960\.00,12\.50$/);
});

test('bulk approve reports the ones it could not approve', async () => {
  const s = await client.get('/api/timecard/my/week?ending=2026-09-27', { token: con2.token });
  const id = s.data.week.id;
  await client.post(`/api/timecard/my/weeks/${id}/entries`, { token: con2.token, body: { start: '07:00', finish: '15:00', breakMins: 0 } });
  await client.post(`/api/timecard/my/weeks/${id}/submit`, { token: con2.token });
  const r = await client.post('/api/timecard/admin/approve-bulk', { token: admin.token, body: { weekIds: [id, weekId] } });
  assert.deepEqual(r.data.approved, [id]);
  assert.equal(r.data.failures.length, 1);
  assert.equal(r.data.failures[0].weekId, weekId);
});

test('clear week empties an unsent week', async () => {
  const s = await client.get('/api/timecard/my/week?ending=2026-10-04', { token: con2.token });
  const id = s.data.week.id;
  await client.post(`/api/timecard/my/weeks/${id}/entries`, { token: con2.token, body: { start: '07:00', finish: '08:00' } });
  await client.post(`/api/timecard/my/weeks/${id}/expenses`, { token: con2.token, body: { date: '2026-10-01', amount: 3, type: 'Tolls' } });
  const c = await client.post(`/api/timecard/my/weeks/${id}/clear`, { token: con2.token });
  assert.equal(c.data.week.entries.length, 0);
  assert.equal(c.data.week.expenses.length, 0);
  assert.equal((await client.get('/api/timecard/my/week?ending=nope', { token: con2.token })).status, 400);
});

test('hours summary periods: month, quarter, year and Australian financial year', () => {
  const { hoursSummary } = require('../timecard');
  const ins = db.prepare("INSERT INTO timecard_weeks (id, user_id, week_ending, status) VALUES (?, ?, ?, 'Approved')");
  const ent = db.prepare('INSERT INTO timecard_entries (id, week_id, user_id, hours) VALUES (?, ?, ?, ?)');
  [['s1', '2025-08-03', 5], ['s2', '2025-12-28', 7], ['s3', '2026-06-28', 11], ['s4', '2026-02-01', 2], ['s5', '2026-08-09', 3]].forEach(([id, we, h]) => {
    ins.run(id, con2.id, we);
    ent.run(`${id}e`, id, con2.id, h);
  });
  // As if today were 15 Aug 2026.
  assert.deepEqual(hoursSummary('2026-08-15'), {
    thisMonth: 3, // Aug 2026
    lastMonth: 0, // Jul 2026
    lastQuarter: 11, // Apr–Jun 2026
    lastYear: 12, // 2025
    lastFinancialYear: 25, // 1 Jul 2025 – 30 Jun 2026
  });
  // January rolls back into last year's last quarter.
  assert.equal(hoursSummary('2026-01-10').lastQuarter, 7);
});

test('Friday reminder goes to contractors who have not sent this week', () => {
  const { contractorsToRemind } = require('../timecardReminders');
  const { todayYmd, sundayOnOrAfter } = require('../timecard');
  const friday = new Date('2026-10-23T05:00:00Z'); // Fri 23 Oct, 4pm Sydney
  const ending = sundayOnOrAfter(todayYmd(friday));
  assert.equal(ending, '2026-10-25');
  db.prepare('DELETE FROM timecard_weeks WHERE user_id = ? AND week_ending = ? AND id != ?').run(con.id, ending, weekId);
  db.prepare('UPDATE timecard_weeks SET week_ending = ? WHERE id = ?').run(ending, weekId); // Cara: approved for this week
  assert.deepEqual(contractorsToRemind(friday).map((u) => u.name), ['Dan Contractor']);
});

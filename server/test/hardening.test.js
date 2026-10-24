// Time Card client/project list, the activity log, error alerts and two-step
// login for admins.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { v4: uuid } = require('uuid');
const { freshDb, startTestServer, registerUser } = require('./helpers');

let client, server, db, admin, staff, con, sent;

async function login(email, extra = {}) {
  return client.post('/api/auth/login', { body: { email, password: 'password123', ...extra } });
}

before(async () => {
  ({ db } = freshDb());
  sent = [];
  require('../email').sendMail = async (m) => { sent.push(m); };
  const { alertOnServerErrors, errorHandler } = require('../alerts');
  const app = express();
  app.use(express.json());
  app.use(alertOnServerErrors);
  app.use('/api/auth', require('../routes/auth'));
  app.use('/api/users', require('../routes/users'));
  app.use('/api/presence', require('../routes/presence'));
  app.use('/api/timecard', require('../routes/timecard'));
  app.use('/api/admin', require('../routes/admin'));
  app.get('/api/boom', () => { throw new Error('kaboom'); });
  app.use(errorHandler);
  client = await startTestServer(app);
  server = client.server;
  admin = await registerUser(client, { name: 'Ana Admin', email: 'ana@itf.test' });
  staff = await registerUser(client, { name: 'Sam Staff', email: 'sam@itf.test' });
  const r = await client.post('/api/users/admin', { token: admin.token, body: { name: 'Cara Contractor', email: 'cara@contractor.test', password: 'password123', role: 'contractor' } });
  con = { id: r.data.user.id, token: (await login('cara@contractor.test')).data.token };
});

after(() => server.close());

test('client / project names: duplicates merged, list managed by admins', async () => {
  // Entries from before the list existed, with the same client spelled three ways.
  const weekId = uuid();
  db.prepare("INSERT INTO timecard_weeks (id, user_id, full_name, email, week_ending, status) VALUES (?, ?, 'Cara Contractor', 'cara@contractor.test', '2026-10-11', 'Approved')").run(weekId, con.id);
  const add = (p, hrs) => db.prepare('INSERT INTO timecard_entries (id, week_id, user_id, day, date, client_project, hours) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(uuid(), weekId, con.id, 'Monday', '2026-10-06', p, hrs);
  add('Westmead Hospital', 2); add('Westmead Hospital', 3); add('Westmead hospital', 1); add(' westmead  hospital ', 1); add('Acme', 4);

  // The contractor's list is built from them: one Westmead Hospital, most-used spelling.
  let s = await client.get('/api/timecard/my', { token: con.token });
  assert.deepEqual(s.data.projects, ['Acme', 'Westmead Hospital']);
  assert.equal(db.prepare("SELECT COUNT(DISTINCT client_project) AS c FROM timecard_entries WHERE client_project LIKE '%westmead%'").get().c, 1);

  // Typing a known name in any capitals uses the list's spelling; a new name joins the list.
  const week = s.data.week.id;
  let r = await client.post(`/api/timecard/my/weeks/${week}/entries`, { token: con.token, body: { date: '2026-10-19', start: '08:00', finish: '10:00', clientProject: '  WESTMEAD   hospital' } });
  assert.equal(r.status, 200);
  assert.equal(r.data.week.entries[0].clientProject, 'Westmead Hospital');
  r = await client.post(`/api/timecard/my/weeks/${week}/entries`, { token: con.token, body: { date: '2026-10-20', start: '08:00', finish: '10:00', clientProject: 'Westmead Hosp' } });
  assert.deepEqual(r.data.projects, ['Acme', 'Westmead Hosp', 'Westmead Hospital']);
  assert.equal(r.data.recentProjects[0], 'Westmead Hosp');

  // Contractors can't manage the list.
  assert.equal((await client.get('/api/timecard/admin/projects', { token: con.token })).status, 403);

  let list = (await client.get('/api/timecard/admin/projects', { token: admin.token })).data.projects;
  const id = (n) => list.find((p) => p.name === n).id;
  assert.equal(list.find((p) => p.name === 'Westmead Hospital').entries, 5);

  // Merge the typo into the real one.
  r = await client.post('/api/timecard/admin/projects/merge', { token: admin.token, body: { fromIds: [id('Westmead Hosp')], intoId: id('Westmead Hospital') } });
  assert.equal(r.status, 200);
  assert.equal(r.data.result.entries, 1);
  list = r.data.projects;
  assert.deepEqual(list.map((p) => p.name), ['Acme', 'Westmead Hospital']);
  assert.equal(list[1].entries, 6);

  // Rename follows through to entries; renaming onto another name is refused.
  r = await client.patch(`/api/timecard/admin/projects/${id('Acme')}`, { token: admin.token, body: { name: 'Acme Pty Ltd' } });
  assert.equal(r.status, 200);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM timecard_entries WHERE client_project = 'Acme Pty Ltd'").get().c, 1);
  list = r.data.projects;
  r = await client.patch(`/api/timecard/admin/projects/${list[0].id}`, { token: admin.token, body: { name: 'westmead hospital' } });
  assert.equal(r.status, 409);
  assert.match(r.data.error, /Merge/);

  // Add (duplicates refused), hide (gone from the contractor's list).
  assert.equal((await client.post('/api/timecard/admin/projects', { token: admin.token, body: { name: 'Westmead HOSPITAL' } })).status, 409);
  r = await client.post('/api/timecard/admin/projects', { token: admin.token, body: { name: 'Blacktown Council' } });
  assert.equal(r.status, 201);
  await client.patch(`/api/timecard/admin/projects/${list[0].id}`, { token: admin.token, body: { active: false } });
  s = await client.get('/api/timecard/my', { token: con.token });
  assert.deepEqual(s.data.projects, ['Blacktown Council', 'Westmead Hospital']);

  const acts = (await client.get('/api/admin/activity?category=timecard', { token: admin.token })).data.entries.map((e) => e.action);
  ['timecard.project_added', 'timecard.project_changed', 'timecard.project_merged'].forEach((a) => assert.ok(acts.includes(a), a));
});

test('activity log records logins, user changes and log-outs; admins only', async () => {
  assert.equal((await client.post('/api/auth/login', { body: { email: 'sam@itf.test', password: 'nope-nope' } })).status, 401);
  await login('sam@itf.test');
  const created = await client.post('/api/users/admin', { token: admin.token, body: { name: 'Neil New', email: 'neil@itf.test', password: 'password123', role: 'user' } });
  await client.patch(`/api/users/admin/${created.data.user.id}`, { token: admin.token, body: { role: 'admin', accessTimecard: true } });
  await client.post(`/api/users/admin/${created.data.user.id}/reset-password`, { token: admin.token, body: { password: 'another-pass-1' } });
  await client.post(`/api/presence/${created.data.user.id}/logout`, { token: admin.token });
  await client.delete(`/api/users/admin/${created.data.user.id}`, { token: admin.token });

  assert.equal((await client.get('/api/admin/activity', { token: staff.token })).status, 403);
  const r = await client.get('/api/admin/activity', { token: admin.token });
  assert.equal(r.status, 200);
  const byAction = (a) => r.data.entries.find((e) => e.action === a);
  assert.match(byAction('auth.login_failed').details, /sam@itf\.test/);
  assert.equal(byAction('auth.login').userName, 'Sam Staff');
  assert.equal(byAction('user.created').targetName, 'Neil New');
  assert.match(byAction('user.updated').details, /Role: user → admin.*Time Card: on/);
  assert.equal(byAction('user.updated').userName, 'Ana Admin');
  assert.ok(byAction('user.password_set'));
  assert.ok(byAction('user.logged_out'));
  assert.equal(byAction('user.deleted').label, 'Removed a user');

  // Search and paging.
  const q = await client.get('/api/admin/activity?q=Neil', { token: admin.token });
  assert.ok(q.data.entries.length >= 4);
  assert.ok(q.data.entries.every((e) => /Neil/.test(`${e.targetName} ${e.details}`)));
  const page = await client.get('/api/admin/activity?limit=2', { token: admin.token });
  assert.equal(page.data.entries.length, 2);
  assert.equal(page.data.more, true);
  const next = await client.get(`/api/admin/activity?limit=2&before=${page.data.entries[1].id}`, { token: admin.token });
  assert.ok(next.data.entries[0].id < page.data.entries[1].id);
});

test('two-step login: admins get an emailed code; remembered devices skip it', async () => {
  process.env.ADMIN_2FA = 'on';
  try {
    // Staff aren't asked.
    assert.ok((await login('sam@itf.test')).data.token);

    sent.length = 0;
    let r = await login('ana@itf.test');
    assert.equal(r.data.twoStep, true);
    assert.equal(r.data.token, undefined);
    assert.equal(r.data.sentTo, 'an•@itf.test');
    const code = sent[0].subject.match(/(\d{6})$/)[1];
    assert.equal(sent[0].to, 'ana@itf.test');

    // Wrong code, then the right one, remembering this device.
    const wrong = code === '000000' ? '111111' : '000000';
    let v = await client.post('/api/auth/login/verify', { body: { challengeId: r.data.challengeId, code: wrong } });
    assert.equal(v.status, 400);
    assert.match(v.data.error, /4 tries left/);
    v = await client.post('/api/auth/login/verify', { body: { challengeId: r.data.challengeId, code, remember: true, deviceLabel: 'Chrome on Windows' } });
    assert.equal(v.status, 200);
    assert.ok(v.data.token);
    assert.ok(v.data.deviceToken);
    // A code works once.
    assert.equal((await client.post('/api/auth/login/verify', { body: { challengeId: r.data.challengeId, code } })).status, 400);

    // The remembered device logs straight in; another device still needs a code.
    r = await login('ana@itf.test', { deviceToken: v.data.deviceToken });
    assert.ok(r.data.token);
    assert.equal((await login('ana@itf.test', { deviceToken: 'not-a-real-device' })).data.twoStep, true);

    const devices = await client.get('/api/auth/devices', { token: r.data.token });
    assert.equal(devices.data.devices.length, 1);
    assert.equal(devices.data.devices[0].label, 'Chrome on Windows');

    // Five wrong codes and the challenge is spent.
    const c2 = (await login('ana@itf.test')).data.challengeId;
    for (let i = 0; i < 5; i += 1) await client.post('/api/auth/login/verify', { body: { challengeId: c2, code: '99999x' } });
    const goodCode = sent[sent.length - 1].subject.match(/(\d{6})$/)[1];
    assert.equal((await client.post('/api/auth/login/verify', { body: { challengeId: c2, code: goodCode } })).status, 429);

    // Forgetting devices means a code next time.
    await client.delete('/api/auth/devices', { token: r.data.token });
    assert.equal((await login('ana@itf.test', { deviceToken: v.data.deviceToken })).data.twoStep, true);

    // The emergency switch turns it off.
    process.env.ADMIN_2FA = 'off';
    assert.ok((await login('ana@itf.test')).data.token);
  } finally {
    delete process.env.ADMIN_2FA;
  }
});

test('security settings: admins only, changes logged; 2FA needs email set up', async () => {
  assert.equal((await client.get('/api/admin/security', { token: staff.token })).status, 403);
  let r = await client.get('/api/admin/security', { token: admin.token });
  assert.equal(r.status, 200);
  // Tests have no email server, so two-step is on in Settings but not active.
  assert.equal(r.data.twoStep.setting, 'on');
  assert.equal(r.data.twoStep.active, false);
  assert.deepEqual(r.data.alerts.recipients.sort(), ['ana@itf.test']);

  assert.equal((await client.patch('/api/admin/security', { token: admin.token, body: { alertEmails: 'ops@itf.test, nope' } })).status, 400);
  r = await client.patch('/api/admin/security', { token: admin.token, body: { alertEmails: 'ops@itf.test; it@itf.test', twoStep: false } });
  assert.deepEqual(r.data.alerts.recipients, ['ops@itf.test', 'it@itf.test']);
  assert.equal(r.data.twoStep.setting, 'off');
  const log = (await client.get('/api/admin/activity?category=settings', { token: admin.token })).data.entries[0];
  assert.match(log.details, /Two-step login for admins: off; Alert emails: ops@itf\.test, it@itf\.test/);

  sent.length = 0;
  r = await client.post('/api/admin/security/test-alert', { token: admin.token });
  assert.equal(r.status, 200);
  assert.equal(sent[0].to, 'ops@itf.test,it@itf.test');
  assert.match(sent[0].subject, /Work Desk alert: Test alert/);
});

test('server errors email an alert, once per 30 minutes for the same problem', async () => {
  require('../alerts')._resetThrottle();
  sent.length = 0;
  let r = await client.get('/api/boom');
  assert.equal(r.status, 500);
  assert.equal(r.data.error, 'Something went wrong — please try again.');
  await new Promise((ok) => setTimeout(ok, 50));
  assert.equal(sent.length, 1);
  assert.match(sent[0].subject, /Server error on GET \/api\/boom/);
  assert.match(sent[0].text, /kaboom/);

  r = await client.get('/api/boom');
  await new Promise((ok) => setTimeout(ok, 50));
  assert.equal(sent.length, 1, 'repeat held back');

  // Switched off in Settings: no alert.
  require('../alerts')._resetThrottle();
  await client.patch('/api/admin/security', { token: admin.token, body: { alertsEnabled: false } });
  await client.get('/api/boom');
  await new Promise((ok) => setTimeout(ok, 50));
  assert.equal(sent.length, 1);
  await client.patch('/api/admin/security', { token: admin.token, body: { alertsEnabled: true } });
});

test('a failed backup is logged and alerted', async () => {
  require('../alerts')._resetThrottle();
  sent.length = 0;
  const { logActivity } = require('../activity');
  const { sendAlert } = require('../alerts');
  logActivity('backup.failed', { details: 'Stopped at: database. OneDrive said no' });
  const r = await sendAlert('backup-failed', 'Backup failed', 'OneDrive said no');
  assert.equal(r.sent, true);
  assert.match(sent[0].subject, /Backup failed/);
  const e = (await client.get('/api/admin/activity?category=backup', { token: admin.token })).data.entries[0];
  assert.equal(e.label, 'Backup failed');
  assert.equal(e.userName, null);
});

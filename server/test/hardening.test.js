// The activity log, error alerts and two-step login for admins.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { freshDb, startTestServer, registerUser } = require('./helpers');

let client, server, db, admin, staff, sent;

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
  app.use('/api/admin', require('../routes/admin'));
  app.get('/api/boom', () => { throw new Error('kaboom'); });
  app.use(errorHandler);
  client = await startTestServer(app);
  server = client.server;
  admin = await registerUser(client, { name: 'Ana Admin', email: 'ana@itf.test' });
  staff = await registerUser(client, { name: 'Sam Staff', email: 'sam@itf.test' });
  // Ana is the Super Admin here, so she can remove admin accounts.
  db.prepare('UPDATE users SET super_admin = 1 WHERE id = ?').run(admin.id);
});

after(() => server.close());

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

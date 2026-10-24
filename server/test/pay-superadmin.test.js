// ITF Time Card pay per person, and the Super Admin rule for removing admins.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { v4: uuid } = require('uuid');
const { freshDb, startTestServer, registerUser } = require('./helpers');

let client, server, db, ensureSuperAdmin, ana, robert, ben, sam;

before(async () => {
  ({ db, ensureSuperAdmin } = freshDb());
  require('../email').sendMail = async () => {};
  const app = express();
  app.use(express.json());
  app.use('/api/auth', require('../routes/auth'));
  app.use('/api/users', require('../routes/users'));
  app.use('/api/timecard', require('../routes/timecard'));
  client = await startTestServer(app);
  server = client.server;
  ana = await registerUser(client, { name: 'Ana Admin', email: 'ana@itf.test' }); // first user = admin
  robert = await registerUser(client, { name: 'Robert Nahas', email: 'RNahas@itfactory.com.au' });
  sam = await registerUser(client, { name: 'Sam Staff', email: 'sam@itf.test' });
  ensureSuperAdmin();
  const b = await client.post('/api/users/admin', { token: ana.token, body: { name: 'Ben Boss', email: 'ben@itf.test', password: 'password123', role: 'admin' } });
  ben = b.data.user;
});
after(() => server.close());

test('Robert Nahas is the Super Admin', async () => {
  const r = db.prepare('SELECT role, super_admin FROM users WHERE id = ?').get(robert.id);
  assert.equal(r.role, 'admin');
  assert.equal(r.super_admin, 1);
  const me = await client.get('/api/auth/me', { token: robert.token });
  assert.equal(me.data.user.superAdmin, true);
  const list = await client.get('/api/users/admin', { token: ana.token });
  assert.deepEqual(list.data.users.filter((u) => u.superAdmin).map((u) => u.name), ['Robert Nahas']);
});

test('only the Super Admin can remove admins or take admin access away', async () => {
  let r = await client.delete(`/api/users/admin/${ben.id}`, { token: ana.token });
  assert.equal(r.status, 403);
  assert.match(r.data.error, /Super Admin/);
  r = await client.patch(`/api/users/admin/${ben.id}`, { token: ana.token, body: { role: 'user', accessTimecard: true } });
  assert.equal(r.status, 403);
  // Nothing was changed by the refused request.
  assert.equal(db.prepare('SELECT role, access_timecard FROM users WHERE id = ?').get(ben.id).access_timecard, 0);
  // Admins can't change the Super Admin's account or password.
  assert.equal((await client.patch(`/api/users/admin/${robert.id}`, { token: ana.token, body: { name: 'Bob' } })).status, 403);
  assert.equal((await client.post(`/api/users/admin/${robert.id}/reset-password`, { token: ana.token, body: { password: 'new-password-1' } })).status, 403);
  // Admins still manage everyone else.
  assert.equal((await client.patch(`/api/users/admin/${ben.id}`, { token: ana.token, body: { accessTimecard: true } })).status, 200);
  assert.equal((await client.patch(`/api/users/admin/${sam.id}`, { token: ana.token, body: { role: 'contractor' } })).status, 200);
  assert.equal((await client.delete(`/api/users/admin/${sam.id}`, { token: ana.token })).status, 200);
  // The Super Admin can.
  assert.equal((await client.patch(`/api/users/admin/${ben.id}`, { token: robert.token, body: { role: 'user' } })).status, 200);
  assert.equal((await client.patch(`/api/users/admin/${ben.id}`, { token: robert.token, body: { role: 'admin' } })).status, 200);
  assert.equal((await client.delete(`/api/users/admin/${ben.id}`, { token: robert.token })).status, 200);
  assert.equal((await client.delete(`/api/users/admin/${ana.id}`, { token: robert.token })).status, 200);
});

test('pay per person for last week / month / quarter / year / financial year and custom dates', async () => {
  const tc = require('../timecard');
  const periods = tc.payPeriods('2026-10-24'); // a Saturday
  const p = Object.fromEntries(periods.map((x) => [x.key, [x.from, x.to]]));
  assert.deepEqual(p.lastWeek, ['2026-10-12', '2026-10-18']);
  assert.deepEqual(p.lastMonth, ['2026-09-01', '2026-09-30']);
  assert.deepEqual(p.lastQuarter, ['2026-07-01', '2026-09-30']);
  assert.deepEqual(p.lastYear, ['2025-01-01', '2025-12-31']);
  assert.deepEqual(p.lastFy, ['2025-07-01', '2026-06-30']);

  const cara = uuid(); const dan = uuid();
  db.prepare("INSERT INTO users (id, name, email, password_hash, role, hourly_rate) VALUES (?, 'Cara', 'cara@c.test', 'x', 'contractor', 80)").run(cara);
  db.prepare("INSERT INTO users (id, name, email, password_hash, role) VALUES (?, 'Dan', 'dan@c.test', 'x', 'contractor')").run(dan);
  const week = (user, ending, status, hours, exp = 0) => {
    const id = uuid();
    db.prepare('INSERT INTO timecard_weeks (id, user_id, week_ending, status) VALUES (?, ?, ?, ?)').run(id, user, ending, status);
    db.prepare('INSERT INTO timecard_entries (id, week_id, user_id, hours) VALUES (?, ?, ?, ?)').run(uuid(), id, user, hours);
    if (exp) db.prepare('INSERT INTO timecard_expenses (id, week_id, user_id, amount) VALUES (?, ?, ?, ?)').run(uuid(), id, user, exp);
  };
  week(cara, '2026-10-18', 'Approved', 10, 12.5);
  week(cara, '2026-10-11', 'Approved', 5);
  week(cara, '2026-10-18', 'Waiting on approval', 99); // not approved: not paid
  week(dan, '2026-10-18', 'Approved', 4, 20); // no hourly rate

  const lw = tc.payInRange(...p.lastWeek);
  assert.deepEqual(lw[cara], { hours: 10, wages: 800, expenses: 12.5, total: 812.5, noRate: false });
  assert.deepEqual(lw[dan], { hours: 4, wages: null, expenses: 20, total: 20, noRate: true });

  const ana2 = await registerUser(client, { name: 'Zed Admin', email: 'zed@itf.test' });
  db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(ana2.id);
  const r = await client.get('/api/timecard/admin/pay?from=2026-10-05&to=2026-10-18', { token: ana2.token });
  assert.equal(r.status, 200);
  assert.equal(r.data.pay[cara].total, 1212.5);
  assert.equal((await client.get('/api/timecard/admin/pay?from=2026-10-18&to=2026-10-01', { token: ana2.token })).status, 400);
  const dash = await client.get('/api/timecard/admin', { token: ana2.token });
  assert.equal(dash.data.pay.periods.length, 5);
});

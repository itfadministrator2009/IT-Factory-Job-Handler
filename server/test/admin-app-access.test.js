// The Super Admin can switch apps on or off for other admins.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { freshDb, startTestServer, registerUser } = require('./helpers');

let client, server, db, rob, ana, ben, sam;

before(async () => {
  ({ db } = freshDb());
  require('../email').sendMail = async () => {};
  const app = express();
  app.use(express.json());
  app.use('/api/auth', require('../routes/auth'));
  app.use('/api/users', require('../routes/users'));
  app.use('/api/sales', require('../routes/sales'));
  app.use('/api/assets', require('../routes/assets'));
  app.use('/api/timecard', require('../routes/timecard'));
  client = await startTestServer(app);
  server = client.server;
  rob = await registerUser(client, { name: 'Rob Super', email: 'rob@itf.test' });
  ana = await registerUser(client, { name: 'Ana Admin', email: 'ana@itf.test' });
  ben = await registerUser(client, { name: 'Ben Admin', email: 'ben@itf.test' });
  sam = await registerUser(client, { name: 'Sam Staff', email: 'sam@itf.test' });
  db.prepare('UPDATE users SET super_admin = 0').run();
  db.prepare("UPDATE users SET role = 'admin', super_admin = 1 WHERE id = ?").run(rob.id);
  db.prepare("UPDATE users SET role = 'admin' WHERE id IN (?, ?)").run(ana.id, ben.id);
  db.prepare("UPDATE users SET role = 'staff' WHERE id = ?").run(sam.id);
});
after(() => server.close());

const patch = (who, id, body) => client.patch(`/api/users/admin/${id}`, { token: who.token, body });
const me = async (u) => (await client.get('/api/auth/me', { token: u.token })).data.user;

test('admins have every app until the Super Admin switches one off', async () => {
  assert.equal((await client.get('/api/sales/items?kind=sale', { token: ana.token })).status, 200);
  assert.equal((await client.get('/api/timecard/admin/pending-count', { token: ana.token })).status, 200);

  const r = await patch(rob, ana.id, { adminApps: { sales: false, timecard: false } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.user.blockedApps, ['sales', 'timecard']);
  assert.equal((await client.get('/api/sales/items?kind=sale', { token: ana.token })).status, 403);
  assert.equal((await client.get('/api/timecard/admin/pending-count', { token: ana.token })).status, 403);
  assert.equal((await client.get('/api/assets', { token: ana.token })).status === 403, false); // still has the rest
  const u = await me(ana);
  assert.equal(u.accessSales, false);
  assert.equal(u.approvesTimecard, false);
  assert.equal(u.accessAssets, true);

  // And back on.
  await patch(rob, ana.id, { adminApps: { sales: true } });
  assert.equal((await client.get('/api/sales/items?kind=sale', { token: ana.token })).status, 200);
  assert.equal((await me(ana)).approvesTimecard, false);
});

test('only the Super Admin can do it, and never to the Super Admin', async () => {
  const r = await patch(ben, ana.id, { adminApps: { assets: false } });
  assert.equal(r.status, 403);
  assert.equal((await patch(ana, rob.id, { adminApps: { assets: false } })).status, 403);
  assert.equal((await patch(rob, rob.id, { adminApps: { assets: false } })).status, 400);
  assert.equal((await patch(rob, sam.id, { adminApps: { assets: false } })).status, 400); // not an admin
  // A regular admin still manages staff access as before.
  assert.equal((await patch(ben, sam.id, { accessSales: true })).status, 200);
  assert.equal((await me(sam)).accessSales, true);
});

test('someone made an admin starts with every app', async () => {
  await patch(rob, ben.id, { adminApps: { storage: false } });
  await patch(rob, ben.id, { role: 'staff' });
  await patch(rob, ben.id, { role: 'admin' });
  const u = await me(ben);
  assert.equal(u.accessStorage, true);
  const list = (await client.get('/api/users/admin', { token: rob.token })).data.users;
  assert.deepEqual(list.find((x) => x.id === ben.id).blockedApps, []);
});

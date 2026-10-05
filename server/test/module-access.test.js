// Settings → Manage Users: per-user access to the ITF Asset Tracker and ITF Storage Centre.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { freshDb, startTestServer, registerUser } = require('./helpers');

let client, server, db, admin, staff;

before(async () => {
  ({ db } = freshDb());
  const app = express();
  app.use(express.json());
  app.use('/api/auth', require('../routes/auth'));
  app.use('/api/users', require('../routes/users'));
  app.use('/api/assets', require('../routes/assets'));
  app.use('/api/storage', require('../routes/storage'));
  client = await startTestServer(app);
  server = client.server;
  admin = await registerUser(client, { name: 'Admin Person', email: 'admin@example.com' });
  db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(admin.id);
  staff = await registerUser(client, { name: 'Staff Person', email: 'staff@example.com' });
  db.prepare("UPDATE users SET role = 'user' WHERE id = ?").run(staff.id);
});

after(() => server.close());

test('existing users keep access to both sections by default', async () => {
  assert.equal((await client.get('/api/storage/items', { token: staff.token })).status, 200);
  assert.equal((await client.get('/api/assets', { token: staff.token })).status, 200);
  const me = (await client.get('/api/auth/me', { token: staff.token })).data.user;
  assert.deepEqual([me.accessAssets, me.accessStorage], [true, true]);
});

test('an admin can switch a section off for a user, and it applies straight away', async () => {
  const off = await client.patch(`/api/users/admin/${staff.id}`, { token: admin.token, body: { accessStorage: false } });
  assert.equal(off.status, 200);
  assert.equal(off.data.user.accessStorage, false);
  assert.equal(off.data.user.accessAssets, true);

  const blocked = await client.get('/api/storage/items', { token: staff.token });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.data.code, 'no_module_access');
  assert.equal((await client.get('/api/assets', { token: staff.token })).status, 200);
  const me = (await client.get('/api/auth/me', { token: staff.token })).data.user;
  assert.deepEqual([me.accessAssets, me.accessStorage], [true, false]);

  // Only admins can change access.
  assert.equal((await client.patch(`/api/users/admin/${staff.id}`, { token: staff.token, body: { accessStorage: true } })).status, 403);

  await client.patch(`/api/users/admin/${staff.id}`, { token: admin.token, body: { accessStorage: true, accessAssets: false } });
  assert.equal((await client.get('/api/storage/items', { token: staff.token })).status, 200);
  assert.equal((await client.get('/api/assets', { token: staff.token })).status, 403);
});

test('admins always have access, and new users can be added without a section', async () => {
  db.prepare('UPDATE users SET access_assets = 0, access_storage = 0 WHERE id = ?').run(admin.id);
  assert.equal((await client.get('/api/storage/items', { token: admin.token })).status, 200);
  const me = (await client.get('/api/auth/me', { token: admin.token })).data.user;
  assert.deepEqual([me.accessAssets, me.accessStorage], [true, true]);

  const created = await client.post('/api/users/admin', { token: admin.token, body: { name: 'New Tech', email: 'new@example.com', password: 'new-password-1', accessAssets: false } });
  assert.equal(created.status, 201);
  assert.deepEqual([created.data.user.accessAssets, created.data.user.accessStorage], [false, true]);
  const login = await client.post('/api/auth/login', { body: { email: 'new@example.com', password: 'new-password-1' } });
  assert.deepEqual([login.data.user.accessAssets, login.data.user.accessStorage], [false, true]);
});

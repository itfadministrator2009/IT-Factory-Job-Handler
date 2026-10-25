// ITF Casuals can be given the ITF Asset Tracker and ITF Storage Centre (off by default).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { freshDb, startTestServer, registerUser } = require('./helpers');

let client, server, db, ana, cas;

async function loginAs(email) {
  return (await client.post('/api/auth/login', { body: { email, password: 'password123' } })).data;
}

before(async () => {
  ({ db } = freshDb());
  require('../email').sendMail = async () => {};
  const app = express();
  app.use(express.json());
  app.use('/api/auth', require('../routes/auth'));
  app.use('/api/users', require('../routes/users'));
  app.use('/api/timecard', require('../routes/timecard'));
  app.use('/api/assets', require('../routes/assets'));
  app.use('/api/storage', require('../routes/storage'));
  app.use('/api/projects', require('../routes/projects'));
  client = await startTestServer(app);
  server = client.server;
  ana = await registerUser(client, { name: 'Ana Admin', email: 'ana@itf.test' });
  const r = await client.post('/api/users/admin', { token: ana.token, body: { name: 'Cass Casual', email: 'cass@itf.test', password: 'password123', role: 'contractor' } });
  cas = r.data.user;
});
after(() => server.close());

test('a new Casual has only ITF Time Card', async () => {
  assert.equal(cas.accessAssets, false);
  assert.equal(cas.accessStorage, false);
  const { token, user } = await loginAs('cass@itf.test');
  assert.equal(user.accessAssets, false);
  assert.equal(user.accessStorage, false);
  assert.equal((await client.get('/api/assets', { token })).status, 403);
  assert.equal((await client.get('/api/storage/pallets', { token })).status, 403);
  assert.equal((await client.get('/api/timecard/my', { token })).status, 200);
});

test('switching sections on lets a Casual in to just those, never the rest of Work Desk', async () => {
  await client.patch(`/api/users/admin/${cas.id}`, { token: ana.token, body: { accessAssets: true } });
  const { token, user } = await loginAs('cass@itf.test');
  assert.equal(user.accessAssets, true);
  assert.equal(user.accessStorage, false);
  assert.notEqual((await client.get('/api/assets', { token })).status, 403);
  assert.equal((await client.get('/api/storage/pallets', { token })).status, 403);

  await client.patch(`/api/users/admin/${cas.id}`, { token: ana.token, body: { accessStorage: true } });
  assert.notEqual((await client.get('/api/storage/pallets', { token })).status, 403);
  const jobs = await client.get('/api/projects', { token });
  assert.equal(jobs.status, 403);
  assert.equal(jobs.data.code, 'contractor_only');

  // Switched off again: locked out on the next request.
  await client.patch(`/api/users/admin/${cas.id}`, { token: ana.token, body: { accessAssets: false, accessStorage: false } });
  assert.equal((await client.get('/api/assets', { token })).status, 403);
  assert.equal((await client.get('/api/storage/pallets', { token })).status, 403);
});

test('moving someone into ITF Casuals turns the extra sections off', async () => {
  const r = await client.post('/api/users/admin', { token: ana.token, body: { name: 'Uma User', email: 'uma@itf.test', password: 'password123', role: 'user' } });
  assert.equal(r.data.user.accessAssets, true);
  const moved = await client.patch(`/api/users/admin/${r.data.user.id}`, { token: ana.token, body: { role: 'contractor' } });
  assert.equal(moved.data.user.accessAssets, false);
  assert.equal(moved.data.user.accessStorage, false);
  const row = db.prepare('SELECT access_assets, access_storage FROM users WHERE id = ?').get(r.data.user.id);
  assert.deepEqual([row.access_assets, row.access_storage], [0, 0]);
});

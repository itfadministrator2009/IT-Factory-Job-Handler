// Clients (portal logins) as a shared page: who can see and change what.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { freshDb, startTestServer, registerUser } = require('./helpers');

let client, server, db, admin, storageUser, assetsUser, neither, acmeId;

before(async () => {
  ({ db } = freshDb());
  const app = express();
  app.use(express.json());
  app.use('/api/auth', require('../routes/auth'));
  app.use('/api/storage', require('../routes/storage'));
  app.use('/api/clients', require('../routes/clients'));
  client = await startTestServer(app);
  server = client.server;
  admin = await registerUser(client, { name: 'Admin', email: 'admin@example.com' });
  db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(admin.id);
  storageUser = await registerUser(client, { name: 'Store Person', email: 'store@example.com' });
  db.prepare("UPDATE users SET role = 'user', access_storage = 1, access_assets = 0 WHERE id = ?").run(storageUser.id);
  assetsUser = await registerUser(client, { name: 'Asset Person', email: 'assets@example.com' });
  db.prepare("UPDATE users SET role = 'user', access_storage = 0, access_assets = 1 WHERE id = ?").run(assetsUser.id);
  neither = await registerUser(client, { name: 'Nobody', email: 'nobody@example.com' });
  db.prepare("UPDATE users SET role = 'user', access_storage = 0, access_assets = 0 WHERE id = ?").run(neither.id);
  db.prepare('INSERT INTO assets (id, fields_json) VALUES (?, ?)').run('a1', JSON.stringify({ customer: 'Acme' }));
  db.prepare("INSERT INTO storage_items (id, client, item, start_date) VALUES ('s1', 'Acme', 'Laptop', '2026-09-01')").run();
});

after(() => server.close());

test('admins and Storage Centre users add clients; Asset Tracker-only users cannot', async () => {
  const made = await client.post('/api/clients', { token: storageUser.token, body: { clientName: 'Acme', username: 'acme', password: 'acme-pass-1', currency: 'USD' } });
  assert.equal(made.status, 201);
  acmeId = made.data.client.id;
  assert.equal((await client.post('/api/clients', { token: assetsUser.token, body: { clientName: 'Beta' } })).status, 403);
  assert.equal((await client.post('/api/clients', { token: admin.token, body: { clientName: 'Gamma' } })).status, 201);
});

test('who can open the page, and what they see', async () => {
  assert.equal((await client.get('/api/clients', { token: neither.token })).status, 403);
  const full = (await client.get('/api/clients', { token: storageUser.token })).data;
  const acme = full.clients.find((c) => c.clientName === 'Acme');
  assert.equal(acme.currency, 'USD');
  assert.equal(acme.inStorageCount, 1);
  const limited = (await client.get('/api/clients', { token: assetsUser.token })).data;
  const a2 = limited.clients.find((c) => c.clientName === 'Acme');
  assert.equal(a2.username, 'acme');
  assert.equal(a2.hasPortalLogin, true);
  assert.equal(a2.currency, undefined, 'no Storage Centre details for Asset Tracker-only users');
  assert.equal(a2.inStorageCount, undefined);
  assert.deepEqual(limited.unlisted, []);
  assert.deepEqual((await client.get('/api/clients/asset-customers', { token: assetsUser.token })).data.customers, [{ name: 'Acme', count: 1 }]);
});

test('Asset Tracker-only users can link customers but not change logins', async () => {
  const ok = await client.patch(`/api/clients/${acmeId}`, { token: assetsUser.token, body: { assetCustomers: ['Acme'] } });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.data.client.assetCustomers, ['Acme']);
  assert.equal((await client.patch(`/api/clients/${acmeId}`, { token: assetsUser.token, body: { password: 'new-pass-123' } })).status, 403);
  assert.equal((await client.patch(`/api/clients/${acmeId}`, { token: assetsUser.token, body: { assetCustomers: [], removePortalAccess: true } })).status, 403);
  assert.ok(db.prepare('SELECT password_hash FROM storage_clients WHERE id = ?').get(acmeId).password_hash, 'login untouched');
});

test('only admins delete clients; the old Storage Centre address still works', async () => {
  assert.equal((await client.delete(`/api/clients/${acmeId}`, { token: storageUser.token })).status, 403);
  assert.equal((await client.get('/api/storage/clients', { token: storageUser.token })).data.clients.length, 2);
  assert.equal((await client.get('/api/storage/clients', { token: assetsUser.token })).status, 403, 'Storage Centre address still needs Storage Centre access');
  assert.equal((await client.delete(`/api/clients/${acmeId}`, { token: admin.token })).status, 200);
});

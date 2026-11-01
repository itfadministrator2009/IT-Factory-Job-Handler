// Clients (portal logins): admins only. Storage Centre pages read currencies
// from a separate, read-only list.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { freshDb, startTestServer, registerUser } = require('./helpers');

let client, server, db, admin, storageUser, assetsUser, acmeId;

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
  db.prepare('INSERT INTO assets (id, fields_json) VALUES (?, ?)').run('a1', JSON.stringify({ customer: 'Acme' }));
});

after(() => server.close());

test('admins add, see, link and change clients', async () => {
  const made = await client.post('/api/clients', { token: admin.token, body: { clientName: 'Acme', username: 'acme', password: 'acme-pass-1', currency: 'USD' } });
  assert.equal(made.status, 201);
  acmeId = made.data.client.id;
  const list = (await client.get('/api/clients', { token: admin.token })).data;
  assert.equal(list.clients[0].currency, 'USD');
  assert.deepEqual((await client.get('/api/clients/asset-customers', { token: admin.token })).data.customers, [{ name: 'Acme', count: 1 }]);
  const linked = await client.patch(`/api/clients/${acmeId}`, { token: admin.token, body: { assetCustomers: ['Acme'], password: 'new-pass-123' } });
  assert.equal(linked.status, 200);
  assert.deepEqual(linked.data.client.assetCustomers, ['Acme']);
});

test('nobody else can see or change clients, at either address', async () => {
  for (const u of [storageUser, assetsUser]) {
    assert.equal((await client.get('/api/clients', { token: u.token })).status, 403);
    assert.equal((await client.get('/api/clients/asset-customers', { token: u.token })).status, 403);
    assert.equal((await client.post('/api/clients', { token: u.token, body: { clientName: 'Beta' } })).status, 403);
    assert.equal((await client.patch(`/api/clients/${acmeId}`, { token: u.token, body: { assetCustomers: [] } })).status, 403);
    assert.equal((await client.delete(`/api/clients/${acmeId}`, { token: u.token })).status, 403);
    assert.equal((await client.get('/api/storage/clients', { token: u.token })).status, 403);
  }
  assert.equal(db.prepare('SELECT COUNT(*) c FROM storage_clients').get().c, 1);
});

test('Storage Centre users still get each client\'s currency (and nothing else)', async () => {
  const r = await client.get('/api/storage/client-currencies', { token: storageUser.token });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.clients, [{ clientName: 'Acme', currency: 'USD' }]);
  assert.equal((await client.get('/api/storage/client-currencies', { token: assetsUser.token })).status, 403, 'needs Storage Centre access');
});

test('admins delete clients', async () => {
  assert.equal((await client.delete(`/api/clients/${acmeId}`, { token: admin.token })).status, 200);
});

// "Back up now" runs in the background and reports through /status.
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
  app.use('/api/backup', require('../routes/backup'));
  client = await startTestServer(app);
  server = client.server;
  admin = await registerUser(client, { name: 'Admin Person', email: 'admin@example.com' });
  db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(admin.id);
  staff = await registerUser(client, { name: 'Staff Person', email: 'staff@example.com' });
  db.prepare("UPDATE users SET role = 'user' WHERE id = ?").run(staff.id);
});

after(() => server.close());

test('back up now answers straight away and the outcome shows in /status', async () => {
  assert.equal((await client.post('/api/backup/now', { token: staff.token })).status, 403);
  const start = await client.post('/api/backup/now', { token: admin.token });
  assert.equal(start.status, 202);
  let status;
  for (let i = 0; i < 50; i += 1) {
    status = (await client.get('/api/backup/status', { token: admin.token })).data;
    if (!status.running) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  // OneDrive isn't set up in tests, so it fails — with the real reason.
  assert.equal(status.last.state, 'failed');
  assert.match(status.message, /not set up/);
});

test('a backup saved as running when the server stopped shows as interrupted', async () => {
  require('../storageTools').setMeta('backup_status', JSON.stringify({ state: 'running', step: 'photos', startedAt: new Date().toISOString() }));
  const status = (await client.get('/api/backup/status', { token: admin.token })).data;
  assert.equal(status.running, false);
  assert.equal(status.last.state, 'interrupted');
  assert.equal(status.last.step, 'photos');
});

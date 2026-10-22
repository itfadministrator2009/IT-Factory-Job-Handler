// Admins can log people out of Work Desk: the person's existing sign-in stops
// working straight away, they drop off "online now", and they can log back in.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { freshDb, startTestServer, registerUser } = require('./helpers');

let client, server, db, admin, sam, tom;

before(async () => {
  ({ db } = freshDb());
  const app = express();
  app.use(express.json());
  app.use('/api/auth', require('../routes/auth'));
  app.use('/api/presence', require('../routes/presence'));
  client = await startTestServer(app);
  server = client.server;
  admin = await registerUser(client, { name: 'Admin Person', email: 'admin@example.com' });
  sam = await registerUser(client, { name: 'Sam', email: 'sam@example.com' });
  tom = await registerUser(client, { name: 'Tom', email: 'tom@example.com' });
  db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(admin.id);
  db.prepare("UPDATE users SET role = 'user' WHERE id IN (?, ?)").run(sam.id, tom.id);
});

after(() => server.close());

const beat = (u) => client.post('/api/presence/heartbeat', { token: u.token });

test('a user cannot log anyone out', async () => {
  const res = await client.post(`/api/presence/${tom.id}/logout`, { token: sam.token });
  assert.equal(res.status, 403);
  assert.equal((await beat(tom)).status, 200);
});

test('admin logs Sam out: his sign-in stops working and he leaves the online list', async () => {
  await beat(sam);
  const res = await client.post(`/api/presence/${sam.id}/logout`, { token: admin.token });
  assert.equal(res.status, 200);
  assert.equal(res.data.name, 'Sam');
  assert.ok(!res.data.users.some((u) => u.id === sam.id));

  const after = await beat(sam);
  assert.equal(after.status, 401);
  assert.equal(after.data.code, 'signed_out');
  assert.equal((await client.get('/api/auth/me', { token: sam.token })).status, 401);

  // Tom and the admin are unaffected.
  assert.equal((await beat(tom)).status, 200);
  assert.equal((await beat(admin)).status, 200);

  // Sam can log straight back in, and the new sign-in works.
  const login = await client.post('/api/auth/login', { body: { email: 'sam@example.com', password: 'password123' } });
  assert.equal(login.status, 200);
  assert.equal((await client.post('/api/presence/heartbeat', { token: login.data.token })).status, 200);
});

test('admin cannot log themselves out this way', async () => {
  const res = await client.post(`/api/presence/${admin.id}/logout`, { token: admin.token });
  assert.equal(res.status, 400);
});

test('log out everyone else leaves only the admin signed in', async () => {
  const res = await client.post('/api/presence/logout-all', { token: admin.token });
  assert.equal(res.status, 200);
  assert.equal(res.data.count, 2);
  assert.equal((await beat(tom)).status, 401);
  assert.equal((await beat(admin)).status, 200);
});

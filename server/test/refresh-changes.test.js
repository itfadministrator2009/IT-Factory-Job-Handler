// Refresh button: "New changes" counts saves/adds/deletes by other people since
// a page loaded — never your own, and never reads, heartbeats or failed requests.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { freshDb, startTestServer, registerUser } = require('./helpers');

let client, server, ana, bob;
before(async () => {
  freshDb();
  require('../changeTracker').resetChanges();
  const app = express();
  app.use(express.json());
  app.use(require('../changeTracker').trackChanges);
  app.use('/api/auth', require('../routes/auth'));
  app.use('/api/presence', require('../routes/presence'));
  app.use('/api/articles', require('../routes/articles'));
  client = await startTestServer(app);
  server = client.server;
  ana = await registerUser(client, { name: 'Ana', email: 'ana@itf.test' });
  bob = await registerUser(client, { name: 'Bob', email: 'bob@itf.test' });
});
after(() => server.close());

const changes = async (u, since) => (await client.get(`/api/presence/changes${since ? `?since=${since}` : ''}`, { token: u.token })).data;

test("counts only other people's successful changes since the page loaded", async () => {
  const { now } = await changes(ana);
  await new Promise((r) => setTimeout(r, 5));
  // Reads, heartbeats and sign-ins aren't changes.
  await client.get('/api/articles', { token: bob.token });
  await client.post('/api/presence/heartbeat', { token: bob.token });
  assert.equal((await changes(ana, now)).byOthers, 0);
  // Bob saves something: Ana sees it, Bob doesn't (it's his own).
  const made = await client.post('/api/articles', { token: bob.token, body: { title: 'Note', body: 'Hello', category: 'General' } });
  assert.ok(made.status < 300, `article create ${made.status}`);
  assert.equal((await changes(ana, now)).byOthers, 1);
  assert.equal((await changes(bob, now)).byOthers, 0);
  // A failed request isn't a change.
  await client.post('/api/articles', { token: bob.token, body: {} });
  assert.equal((await changes(ana, now)).byOthers, 1);
  // After a refresh (a newer "since") the count starts again.
  const later = (await changes(ana)).now;
  assert.equal((await changes(ana, later)).byOthers, 0);
});

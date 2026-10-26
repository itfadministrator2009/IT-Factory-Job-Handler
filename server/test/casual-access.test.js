// ITF Casuals can be given the ITF Asset Tracker and ITF Storage Centre (off by default).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { freshDb, startTestServer, registerUser, HARVEY_NORMAN_TEMPLATE } = require('./helpers');

let client, server, db, ana, cas;

async function loginAs(email) {
  return (await client.post('/api/auth/login', { body: { email, password: 'password123' } })).data;
}

before(async () => {
  ({ db } = freshDb());
  require('../email').sendMail = async () => {};
  // No real calendar from tests.
  const cal = require.cache[require.resolve('../calendar')];
  cal.exports = { ...cal.exports, createCalendarEvent: async () => null, syncCalendarEvent: async () => null, deleteCalendarEvent: async () => null };
  const app = express();
  app.use(express.json());
  app.use('/api/auth', require('../routes/auth'));
  app.use('/api/users', require('../routes/users'));
  app.use('/api/timecard', require('../routes/timecard'));
  app.use('/api/assets', require('../routes/assets'));
  app.use('/api/storage', require('../routes/storage'));
  app.use('/api/projects', require('../routes/projects'));
  app.use('/api/jobs', require('../routes/jobs'));
  app.use('/api/templates', require('../routes/templates'));
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
  const templates = await client.get('/api/templates', { token });
  assert.equal(templates.status, 403);
  assert.equal(templates.data.code, 'contractor_only');

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

test('Projects "Assign to" lists casuals too, and a casual sees only the entries assigned to them', async () => {
  const staff = (await client.post('/api/users/admin', { token: ana.token, body: { name: 'Sam Staff', email: 'sam@itf.test', password: 'password123', role: 'staff' } })).data.user;
  // Jobs' owner list still leaves casuals out; the Projects list includes everyone.
  const plain = (await client.get('/api/users', { token: ana.token })).data.users.map((u) => u.name);
  assert.ok(!plain.includes('Cass Casual'));
  const all = (await client.get('/api/users?include=casuals', { token: ana.token })).data.users.map((u) => u.name);
  for (const n of ['Ana Admin', 'Cass Casual', 'Sam Staff']) assert.ok(all.includes(n), n);

  const project = (await client.post('/api/projects', { token: ana.token, body: { name: 'Harvey Norman', template: HARVEY_NORMAN_TEMPLATE } })).data.project;
  const mine = (await client.post(`/api/projects/${project.id}/entries`, { token: ana.token, body: { site_name: 'HN Auburn', assigned_to: cas.id } })).data.entry;
  const other = (await client.post(`/api/projects/${project.id}/entries`, { token: ana.token, body: { site_name: 'HN Penrith', assigned_to: staff.id } })).data.entry;

  const { token } = await loginAs('cass@itf.test');
  const list = await client.get('/api/projects', { token });
  assert.equal(list.status, 200);
  assert.deepEqual(list.data.projects.map((p) => p.name), ['Harvey Norman']);
  const entries = await client.get(`/api/projects/${project.id}/entries`, { token });
  assert.deepEqual(entries.data.entries.map((e) => e.site_name), ['HN Auburn']);
  assert.equal((await client.get(`/api/projects/${project.id}/entries/${mine.id}`, { token })).status, 200);
  assert.equal((await client.get(`/api/projects/${project.id}/entries/${other.id}`, { token })).status, 404);
  // Still admin-only: creating entries or projects.
  assert.equal((await client.post(`/api/projects/${project.id}/entries`, { token, body: { site_name: 'x' } })).status, 403);
  assert.equal((await client.post('/api/projects', { token, body: { name: 'x', template: HARVEY_NORMAN_TEMPLATE } })).status, 403);
});

test('a casual can be a job owner, and sees and works only the jobs assigned to them', async () => {
  let n = 900;
  const mk = async (subject, owner) => {
    const id = require('crypto').randomUUID();
    n += 1;
    db.prepare("INSERT INTO jobs (id, job_number, contact_name, subject, owner_id, status) VALUES (?, ?, 'HN', ?, ?, 'Open')").run(id, n, subject, owner);
    return { id };
  };
  const mine = await mk('Casual job', cas.id);
  const other = await mk('Someone else', null);
  const { token } = await loginAs('cass@itf.test');
  const list = await client.get('/api/jobs', { token });
  assert.equal(list.status, 200);
  assert.deepEqual(list.data.jobs.map((j) => j.subject), ['Casual job']);
  assert.equal((await client.get(`/api/jobs/${mine.id}`, { token })).status, 200);
  assert.equal((await client.get(`/api/jobs/${other.id}`, { token })).status, 404);
  // Can work their own job (status, notes)…
  assert.equal((await client.patch(`/api/jobs/${mine.id}`, { token, body: { status: 'In Progress' } })).status, 200);
  assert.equal((await client.post(`/api/jobs/${mine.id}/notes`, { token, body: { body: 'On site' } })).status < 300, true);
  // …but not touch anyone else's, create, delete or export.
  assert.equal((await client.patch(`/api/jobs/${other.id}`, { token, body: { status: 'Closed' } })).status, 404);
  assert.equal((await client.post('/api/jobs', { token, body: { contact_name: 'x', subject: 'x' } })).status, 403);
  assert.equal((await client.delete(`/api/jobs/${mine.id}`, { token })).status, 403);
  assert.equal((await client.get('/api/jobs/export.csv', { token })).status, 403);
  assert.equal((await client.get('/api/users/admin', { token })).status, 403);
});

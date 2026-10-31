// Client portal: Audited assets (ITF Asset Tracker) for a client, scoped to the
// Asset Tracker customer names linked to them on Storage Centre → Clients.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { freshDb, startTestServer, registerUser } = require('./helpers');

let client, server, db, staff, acme, gamma;
const add = (id, f, at) => db.prepare('INSERT INTO assets (id, fields_json, created_at) VALUES (?, ?, ?)').run(id, JSON.stringify(f), at);

before(async () => {
  ({ db } = freshDb());
  const app = express();
  app.use(express.json());
  app.use('/api/auth', require('../routes/auth'));
  app.use('/api/storage', require('../routes/storage'));
  app.use('/api/storage-portal', require('../routes/storagePortal'));
  client = await startTestServer(app);
  server = client.server;
  staff = await registerUser(client, { name: 'Staff Person', email: 'staff@example.com' });
  db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(staff.id);

  add('x1', { asset_tag: 'T1', category: 'Laptop', manufacturer: 'Dell', serial_number: 'S1', customer: 'Acme', audit_month: 'October 2026', zoho_ticket_number: 'J100',
    condition_services: ['Blancco Wiped'], comments: 'Hinge loose', status: 'Sold', buyer: 'Bob Reseller', asset_sent_to: 'Wholesale', asset_location: 'ITF Sydney' }, '2026-10-02 01:00:00');
  add('x2', { asset_tag: 'T2', category: 'Monitor', manufacturer: 'HP', serial_number: 'S2', customer: 'ACME Pty Ltd ', audit_month: 'November 2026', zoho_ticket_number: 'J101',
    condition_services: ['Blancco Wiped', 'Factory Reset'] }, '2026-11-01 01:00:00');
  add('x3', { asset_tag: 'T3', category: 'Laptop', manufacturer: 'Dell', serial_number: 'S3', customer: 'acme', audit_month: 'November 2026', zoho_ticket_number: 'J101' }, '2026-11-01 02:00:00');
  add('y1', { asset_tag: 'Y1', category: 'Laptop', serial_number: 'SY', customer: 'Beta Corp', audit_month: 'November 2026' }, '2026-11-01 03:00:00');
});

after(() => server.close());

async function portalLogin(username, password) {
  const r = await client.post('/api/storage-portal/login', { body: { username, password } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data.token;
}

test('staff link Asset Tracker customers to a portal client', async () => {
  const list = (await client.get('/api/storage/clients/asset-customers', { token: staff.token })).data.customers;
  assert.deepEqual(list.map((c) => [c.name, c.count]), [['Acme', 2], ['ACME Pty Ltd', 1], ['Beta Corp', 1]], 'spellings differing only in capitals are one customer');

  const made = await client.post('/api/storage/clients', { token: staff.token, body: { clientName: 'Acme', username: 'acme', password: 'acme-pass-1', assetCustomers: ['Acme', 'ACME Pty Ltd', 'acme'] } });
  assert.equal(made.status, 201);
  assert.deepEqual(made.data.client.assetCustomers, ['Acme', 'ACME Pty Ltd'], 'duplicates ignoring capitals are dropped');
  acme = await portalLogin('acme', 'acme-pass-1');

  const g = await client.post('/api/storage/clients', { token: staff.token, body: { clientName: 'Gamma', username: 'gamma', password: 'gamma-pass-1' } });
  assert.equal(g.status, 201);
  gamma = await portalLogin('gamma', 'gamma-pass-1');
});

test('the portal shows the right tabs', async () => {
  // Acme has no storage records, so only Audited assets.
  assert.deepEqual((await client.get('/api/storage-portal/me', { token: acme })).data.sections, { storage: false, assets: true });
  // A client with nothing linked keeps the Storage Centre tabs only.
  assert.deepEqual((await client.get('/api/storage-portal/me', { token: gamma })).data.sections, { storage: true, assets: false });
  assert.equal((await client.get('/api/storage-portal/assets', { token: gamma })).status, 403);
});

test('a client sees only their own assets, and never internal fields', async () => {
  const r = await client.get('/api/storage-portal/assets', { token: acme });
  assert.equal(r.data.total, 3);
  assert.deepEqual(r.data.assets.map((a) => a.id).sort(), ['x1', 'x2', 'x3']);
  const x1 = r.data.assets.find((a) => a.id === 'x1').fields;
  assert.equal(x1.comments, 'Hinge loose');
  assert.deepEqual(x1.condition_services, ['Blancco Wiped']);
  ['status', 'buyer', 'asset_sent_to', 'asset_location'].forEach((k) => assert.equal(x1[k], undefined, `${k} must not be sent`));
  assert.ok(!JSON.stringify(r.data).includes('Bob Reseller'));
});

test('search and filters (audit month, category, job number)', async () => {
  const ids = async (qs) => (await client.get(`/api/storage-portal/assets?${qs}`, { token: acme })).data.assets.map((a) => a.id).sort();
  assert.deepEqual(await ids('month=november 2026'), ['x2', 'x3']);
  assert.deepEqual(await ids('category=Laptop'), ['x1', 'x3']);
  assert.deepEqual(await ids('job=J101&category=Monitor'), ['x2']);
  assert.deepEqual(await ids('q=S3'), ['x3']);
  assert.deepEqual(await ids('q=SY'), [], "another customer's serial is never found");
  assert.deepEqual(await ids('q=Wholesale'), [], 'hidden fields are not searchable');
  const opts = (await client.get('/api/storage-portal/assets/options', { token: acme })).data;
  assert.deepEqual(opts.month, [{ value: 'November 2026', count: 2 }, { value: 'October 2026', count: 1 }]);
  assert.deepEqual(opts.job.map((j) => j.value), ['J101', 'J100']);
  assert.ok(!opts.fields.some((f) => ['status', 'buyer', 'asset_sent_to'].includes(f.key)));
});

test('summary counts and CSV export follow the filters', async () => {
  const s = (await client.get('/api/storage-portal/assets/summary', { token: acme })).data;
  assert.equal(s.total, 3);
  assert.equal(s.dataWiped, 2);
  assert.deepEqual(s.byMonth, [{ label: 'October 2026', count: 1 }, { label: 'November 2026', count: 2 }]);
  assert.deepEqual(s.byCategory[0], { label: 'Laptop', count: 2 });
  assert.deepEqual(s.byService, [{ label: 'Blancco Wiped', count: 2 }, { label: 'Factory Reset', count: 1 }]);

  const port = server.address().port;
  const res = await fetch(`http://127.0.0.1:${port}/api/storage-portal/assets/export?month=November%202026`, { headers: { Authorization: `Bearer ${acme}` } });
  assert.equal(res.status, 200);
  const csv = await res.text();
  const lines = csv.trim().split(/\r?\n/);
  assert.equal(lines.length, 3, 'header + 2 assets');
  assert.match(lines[0], /Date added/);
  assert.match(csv, /Blancco Wiped; Factory Reset/);
  assert.doesNotMatch(csv, /Wholesale|Bob Reseller|Sold/);
});

test('unlinking customers removes the tab straight away', async () => {
  const id = db.prepare("SELECT id FROM storage_clients WHERE client_name = 'Acme'").get().id;
  await client.patch(`/api/storage/clients/${id}`, { token: staff.token, body: { assetCustomers: [] } });
  assert.equal((await client.get('/api/storage-portal/assets', { token: acme })).status, 403);
  assert.deepEqual((await client.get('/api/storage-portal/me', { token: acme })).data.sections, { storage: true, assets: false });
});

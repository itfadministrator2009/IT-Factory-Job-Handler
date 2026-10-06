// ITF Asset Tracker: bulk serial search (paste a list of serials → the matching
// assets) and the "By Asset Class" report data.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { freshDb, startTestServer, registerUser } = require('./helpers');

let client, server, db, admin;

const add = (id, f) => db.prepare('INSERT INTO assets (id, fields_json) VALUES (?, ?)').run(id, JSON.stringify(f));

before(async () => {
  ({ db } = freshDb());
  const app = express();
  app.use(express.json());
  app.use('/api/auth', require('../routes/auth'));
  app.use('/api/assets', require('../routes/assets'));
  client = await startTestServer(app);
  server = client.server;
  admin = await registerUser(client, { name: 'Admin Person', email: 'admin@example.com' });
  db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(admin.id);
  add('a1', { serial_number: '5CG5513GZ8', category: 'Laptop', customer: 'Acme', status: 'Available' });
  add('a2', { serial_number: ' 5cg5513gyr ', category: 'Laptop', customer: 'Acme', status: 'Sold', asset_sent_to: 'Wholesale' });
  add('a3', { serial_number: 'MON-1', category: 'Monitor', customer: 'Beta', status: 'Available', asset_sent_to: 'ITF Australia' });
  add('a4', { serial_number: 'MON-1', category: 'Monitor', customer: 'Beta' });
  add('a5', { serial_number: 'OTHER', category: 'Laptop', customer: 'Beta', status: 'Available' });
});

after(() => server.close());

test('bulk serial search finds pasted serials in any case/spacing, keeps the pasted order, and lists the missing ones', async () => {
  const { status, data } = await client.post('/api/assets/serial-search', {
    token: admin.token,
    body: { serials: '5CG5513GYR\n5cg5513gz8, NOPE-1\tmon-1\n5CG5513GYR' },
  });
  assert.equal(status, 200);
  assert.equal(data.searched, 4, 'the repeated serial is only counted once');
  assert.equal(data.found, 3);
  assert.deepEqual(data.assets.map((a) => a.id), ['a2', 'a1', 'a3', 'a4']);
  assert.deepEqual(data.notFound, ['NOPE-1']);
  assert.deepEqual(data.duplicates, [{ serial: 'mon-1', count: 2 }]);

  assert.equal((await client.post('/api/assets/serial-search', { token: admin.token, body: { serials: '  ' } })).status, 400);
});

test('the matches can then be bulk-allocated and exported by id', async () => {
  const { data } = await client.post('/api/assets/serial-search', { token: admin.token, body: { serials: ['5CG5513GZ8', 'OTHER'] } });
  const ids = data.assets.map((a) => a.id);
  const edit = await client.patch('/api/assets/bulk-edit', { token: admin.token, body: { ids, updates: { asset_sent_to: 'ITF Australia' } } });
  assert.equal(edit.data.updated, 2);
  assert.equal(JSON.parse(db.prepare("SELECT fields_json FROM assets WHERE id = 'a5'").get().fields_json).asset_sent_to, 'ITF Australia');

  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/assets/export`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${admin.token}` }, body: JSON.stringify({ ids }),
  });
  const csv = await res.text();
  assert.equal(res.status, 200);
  assert.equal(csv.trim().split(/\r?\n/).length, 3, 'header + the 2 chosen assets');
  assert.match(csv, /OTHER/);
  assert.doesNotMatch(csv, /MON-1/);
});

test('reports include per-class counts by customer, status and where sent', async () => {
  const { status, data } = await client.get('/api/assets/reports/summary', { token: admin.token });
  assert.equal(status, 200);
  const count = (pred) => data.classRows.filter(pred).reduce((t, r) => t + r.count, 0);
  assert.equal(count((r) => r.assetClass === 'Laptop'), 3);
  assert.equal(count((r) => r.assetClass === 'Monitor' && r.customer === 'Beta'), 2);
  assert.equal(count((r) => r.assetClass === 'Laptop' && r.status === 'Sold'), 1);
  assert.equal(count((r) => r.sentTo === 'ITF Australia'), 3);
});

// ITF Asset Tracker tools: filters, duplicate-serial checks, customer name
// grouping, and allocation batches with a packing list.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { freshDb, startTestServer, registerUser } = require('./helpers');

let client, server, db, admin, staff, base;
const add = (id, f) => db.prepare('INSERT INTO assets (id, fields_json) VALUES (?, ?)').run(id, JSON.stringify(f));
const ids = (r) => r.data.assets.map((a) => a.id).sort();

before(async () => {
  ({ db } = freshDb());
  const app = express();
  app.use(express.json());
  app.use('/api/auth', require('../routes/auth'));
  app.use('/api/assets', require('../routes/assets'));
  client = await startTestServer(app);
  server = client.server;
  base = `http://127.0.0.1:${server.address().port}`;
  admin = await registerUser(client, { name: 'Admin Person', email: 'admin@example.com' });
  db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(admin.id);
  staff = await registerUser(client, { name: 'Staff Person', email: 'staff@example.com' });
  db.prepare("UPDATE users SET role = 'user' WHERE id = ?").run(staff.id);
  add('a1', { asset_tag: 'T1', serial_number: 'SER-1', category: 'Laptop', customer: 'Acme', status: 'Available' });
  add('a2', { asset_tag: 'T2', serial_number: 'SER-2', category: 'Laptop', customer: 'ACME ', status: 'Sold', asset_sent_to: 'Wholesale' });
  add('a3', { asset_tag: 'T3', serial_number: 'ser-2', category: 'Monitor', customer: 'Beta', status: 'Available' });
  add('a4', { asset_tag: 'T4', serial_number: 'SER-4', category: 'Monitor', status: 'Available' });
});

after(() => server.close());

test('filters: exact field values, customer spellings as one, blank, duplicates only', async () => {
  assert.deepEqual(ids(await client.get('/api/assets?category=laptop', { token: staff.token })), ['a1', 'a2']);
  assert.deepEqual(ids(await client.get('/api/assets?customer=acme', { token: staff.token })), ['a1', 'a2']);
  assert.deepEqual(ids(await client.get('/api/assets?customer=__none__', { token: staff.token })), ['a4']);
  assert.deepEqual(ids(await client.get('/api/assets?category=Monitor&status=Available', { token: staff.token })), ['a3', 'a4']);
  assert.deepEqual(ids(await client.get('/api/assets?dupes=1', { token: staff.token })), ['a2', 'a3']);
  const all = await client.get('/api/assets/all-ids?sent_to=Wholesale', { token: staff.token });
  assert.deepEqual(all.data.ids, ['a2']);

  const opts = await client.get('/api/assets/filter-options', { token: staff.token });
  assert.deepEqual(opts.data.customer, [{ value: 'Acme', count: 2 }, { value: 'Beta', count: 1 }]);
  assert.ok(opts.data.category.includes('Laptop') && opts.data.sent_to.includes('ITF Australia'));
});

test('reports group customer spellings together', async () => {
  const { data } = await client.get('/api/assets/reports/summary', { token: admin.token });
  assert.deepEqual(data.byCompany.find((r) => r.company === 'Acme'), { company: 'Acme', count: 2 });
  assert.equal(data.byCompany.some((r) => r.company === 'ACME '), false);
  assert.equal(data.classRows.filter((r) => r.customer === 'Acme').reduce((t, r) => t + r.count, 0), 2);
});

test('adding or editing an asset warns about a serial already on file, unless told to save anyway', async () => {
  const dup = await client.post('/api/assets', { token: staff.token, body: { fields: { serial_number: ' ser-1 ' } } });
  assert.equal(dup.status, 409);
  assert.equal(dup.data.code, 'duplicate_serial');
  assert.equal(dup.data.matches[0].assetTag, 'T1');
  const forced = await client.post('/api/assets', { token: staff.token, body: { fields: { serial_number: 'SER-1', asset_tag: 'T5' }, allowDuplicateSerial: true } });
  assert.equal(forced.status, 201);

  // Editing other fields of an asset never trips the check; changing its serial to one in use does.
  assert.equal((await client.patch('/api/assets/a3', { token: staff.token, body: { fields: { status: 'Sold', serial_number: 'ser-2' } } })).status, 200);
  const clash = await client.patch('/api/assets/a4', { token: staff.token, body: { fields: { serial_number: 'SER-2' } } });
  assert.equal(clash.status, 409);
  assert.equal((await client.patch('/api/assets/a4', { token: staff.token, body: { fields: { serial_number: 'SER-NEW' } } })).status, 200);
  db.prepare("DELETE FROM assets WHERE id = ?").run(forced.data.asset.id);
});

test('import skips rows whose serial is already on file (or repeated in the file) unless asked', async () => {
  const csv = 'Serial Number,Category\nSER-1,Laptop\nNEW-1,Laptop\nnew-1,Laptop\nNEW-2,Monitor\n';
  const send = async (extra) => {
    const form = new FormData();
    form.append('file', new Blob([csv], { type: 'text/csv' }), 'import.csv');
    if (extra === true) form.append('allowDuplicates', '1');
    if (Array.isArray(extra)) form.append('onlyRows', JSON.stringify(extra));
    const r = await fetch(`${base}/api/assets/import`, { method: 'POST', headers: { Authorization: `Bearer ${admin.token}` }, body: form });
    return r.json();
  };
  const before = db.prepare('SELECT COUNT(*) c FROM assets').get().c;
  const r1 = await send(false);
  assert.equal(r1.created, 2);
  assert.deepEqual(r1.duplicateSerials, ['SER-1', 'new-1']);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM assets').get().c, before + 2);
  assert.deepEqual(r1.skippedRows, [1, 3]);
  // "Import the skipped rows anyway" re-sends the file with just those rows.
  const r2 = await send(r1.skippedRows);
  assert.equal(r2.created, 2, 'only the two skipped rows are added');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM assets').get().c, before + 4);
  const r3 = await send(true);
  assert.equal(r3.created, 4, 'everything imported when duplicates are allowed');
});

test('allocation batches: create from assets, add/remove, packing list, and filter the list by batch', async () => {
  assert.equal((await client.post('/api/assets/batches', { token: staff.token, body: { name: 'X', assetIds: ['a1'] } })).status, 403);
  assert.equal((await client.post('/api/assets/batches', { token: admin.token, body: { name: ' ', assetIds: ['a1'] } })).status, 400);

  const created = await client.post('/api/assets/batches', { token: admin.token, body: { name: 'Wholesale – Buyer X – Oct', notes: 'Pick up Friday', assetIds: ['a1', 'a2', 'nope'] } });
  assert.equal(created.status, 201);
  assert.equal(created.data.added, 2);
  const bid = created.data.batch.id;
  assert.equal(created.data.batch.number, 1);

  const more = await client.post(`/api/assets/batches/${bid}/items`, { token: admin.token, body: { assetIds: ['a2', 'a3'] } });
  assert.equal(more.data.added, 1, 'an asset already in the batch is not added twice');
  assert.deepEqual(ids(await client.get(`/api/assets?batch=${bid}`, { token: staff.token })), ['a1', 'a2', 'a3']);

  await client.post(`/api/assets/batches/${bid}/remove`, { token: admin.token, body: { assetIds: ['a3'] } });
  // A deleted asset stays on the batch from its snapshot.
  db.prepare("DELETE FROM assets WHERE id = 'a1'").run();
  const detail = await client.get(`/api/assets/batches/${bid}`, { token: staff.token });
  assert.equal(detail.data.batch.count, 2);
  const gone = detail.data.items.find((i) => i.assetId === 'a1');
  assert.equal(gone.deleted, true);
  assert.equal(gone.fields.serial_number, 'SER-1');

  const list = await client.get('/api/assets/batches', { token: staff.token });
  assert.equal(list.data.batches[0].name, 'Wholesale – Buyer X – Oct');

  const pdf = await fetch(`${base}/api/assets/batches/${bid}/pdf`, { headers: { Authorization: `Bearer ${admin.token}` } });
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 4).toString(), '%PDF');

  assert.equal((await client.patch(`/api/assets/batches/${bid}`, { token: admin.token, body: { name: 'Renamed' } })).data.batch.name, 'Renamed');
  assert.equal((await client.delete(`/api/assets/batches/${bid}`, { token: admin.token })).status, 200);
  assert.ok(db.prepare("SELECT 1 FROM assets WHERE id = 'a2'").get(), 'deleting a batch leaves the assets alone');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM asset_batch_items').get().c, 0);
});

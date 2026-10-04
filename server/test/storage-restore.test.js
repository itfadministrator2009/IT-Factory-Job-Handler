// Storage Centre restore, Match & update from a spreadsheet, and item notes.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const bcrypt = require('bcryptjs');
const { freshDb, startTestServer, registerUser } = require('./helpers');

let client, server, db, staff, admin;

before(async () => {
  ({ db } = freshDb());
  const app = express();
  app.use(express.json({ limit: '15mb' }));
  app.use('/api/auth', require('../routes/auth'));
  app.use('/api/storage', require('../routes/storage'));
  app.use('/api/storage-portal', require('../routes/storagePortal'));
  client = await startTestServer(app);
  server = client.server;
  admin = await registerUser(client, { name: 'Admin Person', email: 'admin@example.com' });
  db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(admin.id);
  staff = await registerUser(client, { name: 'Staff Person', email: 'staff@example.com' });
  db.prepare("UPDATE users SET role = 'user' WHERE id = ?").run(staff.id);
});

after(() => server.close());

test('match & update: preview, then apply by serial (ignoring case), skipping blanks', async () => {
  const ins = db.prepare('INSERT INTO storage_items (id, client, serial, reference_number, start_date) VALUES (?,?,?,?,?)');
  ins.run('mu1', 'Acme', 'SN-1', null, '2026-01-01');
  ins.run('mu2', 'Acme', 'sn-2', null, '2026-01-01');
  ins.run('mu3', 'Acme', 'SN-2 ', null, '2026-01-01'); // same serial as mu2
  const rows = [
    { serial: 'sn-1', value: 'REF-1' },
    { serial: 'SN-2', value: 'REF-2' },
    { serial: 'SN-404', value: 'REF-X' },
    { serial: 'SN-1', value: '' },
    { serial: '', value: 'nothing' },
  ];
  const preview = (await client.post('/api/storage/items/match-update', { token: staff.token, body: { field: 'referenceNumber', rows, dryRun: true } })).data;
  assert.deepEqual(
    [preview.matchedRows, preview.itemsToUpdate, preview.blank, preview.noSerial, preview.unmatched, preview.multiCount, preview.updated],
    [2, 3, 1, 1, ['SN-404'], 1, 0],
  );
  assert.equal(db.prepare("SELECT reference_number FROM storage_items WHERE id = 'mu1'").get().reference_number, null);
  const done = (await client.post('/api/storage/items/match-update', { token: staff.token, body: { field: 'referenceNumber', rows } })).data;
  assert.equal(done.updated, 3);
  const got = db.prepare("SELECT id, reference_number, last_edited_by FROM storage_items WHERE id LIKE 'mu%' ORDER BY id").all();
  assert.deepEqual(got.map((r) => r.reference_number), ['REF-1', 'REF-2', 'REF-2']);
  assert.equal(got[0].last_edited_by, 'Staff Person');
  // Dates go through the same parsing as the import.
  await client.post('/api/storage/items/match-update', { token: staff.token, body: { field: 'endDate', rows: [{ serial: 'SN-1', value: '5/9/2026' }] } });
  assert.equal(db.prepare("SELECT end_date FROM storage_items WHERE id = 'mu1'").get().end_date, '2026-09-05');
  const bad = await client.post('/api/storage/items/match-update', { token: staff.token, body: { field: 'id', rows } });
  assert.equal(bad.status, 400);
});

test('item notes are saved under the signed-in user and read back by key', async () => {
  await client.post('/api/storage/item-notes', { token: staff.token, body: { itemKey: 'item:mu1', note: 'Screen cracked', author: 'Someone Else' } });
  await client.post('/api/storage/item-notes', { token: staff.token, body: { itemKey: 'client:Acme', note: 'Call before delivery' } });
  const blank = await client.post('/api/storage/item-notes', { token: staff.token, body: { itemKey: 'item:mu1', note: '   ' } });
  assert.equal(blank.status, 400);
  const { data } = await client.get('/api/storage/item-notes?keys=item:mu1,client:Acme', { token: staff.token });
  assert.equal(data.notes.length, 2);
  assert.ok(data.notes.every((n) => n.author === 'Staff Person'));
});

test('restore: preview, admin only, typed confirmation, restore point, logins kept', async () => {
  // Starting data: two items, a client with a portal login, a classified location.
  db.prepare("INSERT INTO storage_items (id, client, serial, location, start_date, price_week) VALUES ('r1', 'Kilo', 'K-1', 'Pallet 1', '2026-01-01', 12.5)").run();
  db.prepare("INSERT INTO storage_clients (id, client_name, username, password_hash) VALUES ('ck', 'Kilo', 'kilo', ?)").run(bcrypt.hashSync('kilo-password-1', 4));
  await client.post('/api/storage/locations-registry', { token: staff.token, body: { location: 'Pallet 1', isPallet: true } });
  const { buildStorageCentreZip } = require('../storageExport');
  const { buffer } = await buildStorageCentreZip();
  const zipBase64 = buffer.toString('base64');
  const itemsAtBackup = db.prepare('SELECT COUNT(*) AS n FROM storage_items').get().n;

  // Things change after the backup.
  db.prepare("DELETE FROM storage_items WHERE id = 'r1'").run();
  db.prepare("INSERT INTO storage_items (id, client, serial) VALUES ('r2', 'Kilo', 'K-2')").run();

  assert.equal((await client.post('/api/storage/restore/preview', { token: staff.token, body: { source: 'upload', zipBase64 } })).status, 403);
  const preview = (await client.post('/api/storage/restore/preview', { token: admin.token, body: { source: 'upload', zipBase64 } })).data;
  const itemsRow = preview.tables.find((t) => t.file === 'items.csv');
  assert.equal(itemsRow.backupRows, itemsAtBackup);
  assert.ok(preview.exportedAt);

  const noConfirm = await client.post('/api/storage/restore', { token: admin.token, body: { source: 'upload', zipBase64 } });
  assert.equal(noConfirm.status, 400);
  const notZip = await client.post('/api/storage/restore/preview', { token: admin.token, body: { source: 'upload', zipBase64: Buffer.from('hello').toString('base64') } });
  assert.equal(notZip.status, 400);

  const done = await client.post('/api/storage/restore', { token: admin.token, body: { source: 'upload', zipBase64, confirm: 'RESTORE' } });
  assert.equal(done.status, 200);
  assert.equal(done.data.restored['items.csv'], itemsAtBackup);
  const r1 = db.prepare("SELECT * FROM storage_items WHERE id = 'r1'").get();
  assert.equal(r1.price_week, 12.5);
  assert.equal(r1.start_date, '2026-01-01');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM storage_items WHERE id = 'r2'").get().n, 0);
  assert.equal(db.prepare("SELECT location_key FROM storage_locations_registry WHERE location = 'Pallet 1'").get().location_key, 'pallet 1');

  // The client portal login still works after the restore.
  const login = await client.post('/api/storage-portal/login', { body: { username: 'kilo', password: 'kilo-password-1' } });
  assert.equal(login.status, 200);

  // A restore point of the data just replaced was saved; restoring it undoes the restore.
  const sources = (await client.get('/api/storage/restore/sources', { token: admin.token })).data;
  assert.equal(sources.restorePoints.length, 1);
  assert.match(sources.oneDriveError, /not set up/);
  const undo = await client.post('/api/storage/restore', { token: admin.token, body: { source: 'point', pointId: sources.restorePoints[0].id, confirm: 'RESTORE' } });
  assert.equal(undo.status, 200);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM storage_items WHERE id = 'r2'").get().n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM storage_items WHERE id = 'r1'").get().n, 0);
});

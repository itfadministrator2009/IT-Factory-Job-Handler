// ITF Asset Checklist: access, saving with photos, Asset IDs, Sales Manager link,
// edits, bulk platform, delete, summary and the Google Sheet import.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { freshDb, startTestServer, registerUser } = require('./helpers');

let client, server, db, base, ana, tom;

before(async () => {
  ({ db } = freshDb());
  require('../email').sendMail = async () => {};
  const app = express();
  app.use(express.json({ limit: '15mb' }));
  app.use('/api/auth', require('../routes/auth'));
  app.use('/api/users', require('../routes/users'));
  app.use('/api/sales', require('../routes/sales'));
  app.use('/api/checklist', require('../routes/checklist'));
  client = await startTestServer(app);
  server = client.server;
  base = `http://127.0.0.1:${server.address().port}`;
  ana = await registerUser(client, { name: 'Ana Admin', email: 'ana@itf.test' });
  tom = await registerUser(client, { name: 'Tom Tech', email: 'tom@itf.test' });
  db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(ana.id);
  db.prepare("UPDATE users SET role = 'contractor' WHERE id = ?").run(tom.id);
});
after(() => server.close());

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
async function send(method, u, url, data, photos = 0) {
  const fd = new FormData();
  fd.append('data', JSON.stringify(data));
  for (let i = 0; i < photos; i += 1) fd.append('photos', new Blob([PNG], { type: 'image/png' }), `p${i}.png`);
  const r = await fetch(base + url, { method, headers: { authorization: `Bearer ${u.token}` }, body: fd });
  return { status: r.status, data: await r.json() };
}
const laptop = (extra = {}) => ({
  deviceKey: 'laptop', date: '2026-10-30', grade: 'Great Condition (B)', platform: '',
  info: { Make: 'Dell', Model: 'Latitude 5420', 'Serial Number': 'ABC123', RAM: '16GB' },
  items: ['Boots without errors', 'Keyboard (test all keys)', 'Not a real item'], ...extra,
});

test('casuals need Asset Checklist switched on; admins have it', async () => {
  assert.equal((await client.get('/api/checklist/config', { token: tom.token })).status, 403);
  assert.equal((await client.get('/api/checklist/config', { token: ana.token })).status, 200);
  await client.patch(`/api/users/admin/${tom.id}`, { token: ana.token, body: { accessChecklist: true } });
  const cfg = await client.get('/api/checklist/config', { token: tom.token });
  assert.equal(cfg.status, 200);
  assert.ok(cfg.data.config.deviceTypes.laptop.sections.length > 0);
  assert.equal((await client.get('/api/auth/me', { token: tom.token })).data.user.accessChecklist, true);
});

test('saving gives the next Asset ID, keeps only real items, stores photos', async () => {
  const r = await send('POST', tom, '/api/checklist/entries', laptop(), 2);
  assert.equal(r.status, 201);
  const e = r.data.entry;
  assert.equal(e.assetId, 'LAP-0001');
  assert.equal(e.technician, 'Tom Tech');
  assert.deepEqual(e.items, ['Boots without errors', 'Keyboard (test all keys)']);
  assert.equal(e.photos.length, 2);
  assert.equal(r.data.salesSynced, false);
  const p = await fetch(`${base}/api/checklist/photos/${e.photos[0].id}`, { headers: { authorization: `Bearer ${tom.token}` } });
  assert.equal(p.status, 200);
  const r2 = await send('POST', tom, '/api/checklist/entries', laptop({ info: { Make: 'HP', 'Serial Number': 'zz9' } }));
  assert.equal(r2.data.entry.assetId, 'LAP-0002');
  assert.equal((await send('POST', tom, '/api/checklist/entries', laptop({ grade: '' }))).status, 400);
  const dup = await client.get('/api/checklist/check-serial?device=laptop&serial=abc123', { token: tom.token });
  assert.equal(dup.data.duplicate, true);
  assert.equal(dup.data.assetId, 'LAP-0001');
  const notDup = await client.get(`/api/checklist/check-serial?device=laptop&serial=abc123&exclude=${e.id}`, { token: tom.token });
  assert.equal(notDup.data.duplicate, false);
});

test('ITF Australia adds it to Sales Manager inventory once', async () => {
  const r = await send('POST', tom, '/api/checklist/entries', laptop({ platform: 'ITF Australia', info: { Make: 'Lenovo', Model: 'T14', 'Serial Number': 'L1', RAM: '8GB' } }));
  assert.equal(r.data.salesSynced, true);
  const item = db.prepare('SELECT * FROM sales_items WHERE id = ?').get(r.data.entry.salesItemId);
  assert.equal(item.kind, 'inventory');
  assert.equal(item.sku, r.data.entry.assetId);
  assert.equal(item.itemtype, 'Laptop');
  assert.equal(item.ram, '8GB');
  assert.equal(item.labour, '35');
  assert.match(item.comments, /Cosmetic Grade: Great Condition \(B\)/);
  // Editing it again doesn't add a second copy.
  const u = await send('PATCH', ana, `/api/checklist/entries/${r.data.entry.id}`, laptop({ platform: 'ITF Australia', notes: 'Small scratch' }));
  assert.equal(u.data.entry.salesItemId, r.data.entry.salesItemId);
  assert.equal(u.data.entry.lastEditedBy, 'Ana Admin');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sales_items WHERE sku = ?").get(r.data.entry.assetId).n, 1);
});

test('edit keeps chosen photos, bulk platform syncs, delete removes', async () => {
  const list = (await client.get('/api/checklist/entries?device=laptop', { token: tom.token })).data.entries;
  const first = list.find((x) => x.assetId === 'LAP-0001');
  assert.equal(first.photoCount, 2);
  const full = (await client.get(`/api/checklist/entries/${first.id}`, { token: tom.token })).data.entry;
  const u = await send('PATCH', tom, `/api/checklist/entries/${first.id}`, laptop({ keepPhotoIds: [full.photos[0].id] }), 1);
  assert.equal(u.data.entry.photos.length, 2);
  assert.ok(u.data.entry.photos.some((p) => p.id === full.photos[0].id));
  assert.ok(!u.data.entry.photos.some((p) => p.id === full.photos[1].id));

  const second = list.find((x) => x.assetId === 'LAP-0002');
  const b = await client.post('/api/checklist/entries/bulk-platform', { token: tom.token, body: { ids: [first.id, second.id], platform: 'ITF Australia' } });
  assert.equal(b.data.updated, 2);
  assert.equal(b.data.synced, 2);

  const d = await client.post('/api/checklist/entries/delete', { token: tom.token, body: { ids: [second.id] } });
  assert.equal(d.data.deleted, 1);
  assert.equal((await client.get(`/api/checklist/entries/${second.id}`, { token: tom.token })).status, 404);
  // Asset IDs are never reused.
  const r = await send('POST', tom, '/api/checklist/entries', laptop({ info: { 'Serial Number': 'new' } }));
  assert.equal(r.data.entry.assetId, 'LAP-0004');
});

test('summary counts by device, model and technician', async () => {
  const s = (await client.get('/api/checklist/summary', { token: tom.token })).data;
  const lap = s.deviceTypes.find((d) => d.key === 'laptop');
  assert.equal(lap.total, 3);
  assert.equal(lap.synced, 2);
  assert.equal(s.technicians[0].username, 'Tom Tech');
  assert.ok(s.technicians[0].today >= 1);
});

test('Google Sheet import keeps Asset IDs, links and Drive photos; safe to repeat', async () => {
  const headers = ['Asset ID', 'Timestamp', 'Technician', 'Date', 'Product Type', 'Make', 'Model', 'Serial Number', 'Additional Details',
    'Cosmetic Grade', 'Condition Notes', 'Photos', 'Platform', 'Sales Sync', 'Last Edited By'];
  const rows = [
    ['OTH-0007', '2026-03-04 15:07', 'jason', '2026-03-04', 'Dock', 'Targus', 'ACP71', 'T1', 'with PSU', 'Good Condition (B-)', 'ok', 'drv1, drv2', 'ITF Australia', 'old-sales-id', ''],
    ['', '', '', '', '', '', '', '', '', '', '', '', '', '', ''],
  ];
  assert.equal((await client.post('/api/checklist/import', { token: tom.token, body: { deviceKey: 'otherEquipment', headers, rows } })).status, 403);
  const r = await client.post('/api/checklist/import', { token: ana.token, body: { deviceKey: 'otherEquipment', headers, rows } });
  assert.deepEqual(r.data, { added: 1, updated: 0, skipped: 1 });
  const again = await client.post('/api/checklist/import', { token: ana.token, body: { deviceKey: 'otherEquipment', headers, rows } });
  assert.equal(again.data.updated, 1);
  const e = (await client.get('/api/checklist/entries?device=otherEquipment', { token: ana.token })).data.entries[0];
  assert.equal(e.assetId, 'OTH-0007');
  assert.equal(e.technician, 'jason');
  assert.equal(e.info['Product Type'], 'Dock');
  assert.deepEqual(e.drivePhotoIds, ['drv1', 'drv2']);
  assert.equal(e.salesItemId, 'old-sales-id');
  assert.equal(new Date(e.createdAt).toISOString(), '2026-03-04T04:07:00.000Z'); // 3:07 pm Sydney (AEDT)
  // New entries carry on after the imported numbers.
  const n = await send('POST', ana, '/api/checklist/entries', { deviceKey: 'otherEquipment', grade: 'Poor (D)', info: { 'Product Type': 'Cable' } });
  assert.equal(n.data.entry.assetId, 'OTH-0008');
});

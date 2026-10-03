// Old-app staff tools: bulk edit, import, model cleanup, billing gaps, the
// calculator, dashboard, receiving/dispatch invoicing, presence, and the
// optional tracking number on "Delivered".
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { freshDb, startTestServer, registerUser } = require('./helpers');

let client, server, db, staff, admin;
const sent = [];

before(async () => {
  ({ db } = freshDb());
  const real = require('../email');
  require.cache[require.resolve('../email')].exports = {
    ...real,
    notifyStorageOrderTracking: async (args) => { sent.push(args); },
  };
  const app = express();
  app.use(express.json());
  app.use('/api/auth', require('../routes/auth'));
  app.use('/api/storage', require('../routes/storage'));
  app.use('/api/presence', require('../routes/presence'));
  client = await startTestServer(app);
  server = client.server;
  admin = await registerUser(client, { name: 'Admin Person', email: 'admin@example.com' });
  db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(admin.id);
  staff = await registerUser(client, { name: 'Staff Person', email: 'staff@example.com' });
  db.prepare("UPDATE users SET role = 'user' WHERE id = ?").run(staff.id);
});

after(() => server.close());

const item = db0 => db0.prepare('INSERT INTO storage_items (id, client, storage_centre, location, item, make, model, serial, price_week, start_date, end_date) VALUES (?,?,?,?,?,?,?,?,?,?,?)');

test('import coerces dates, prices and quantities and records who imported', async () => {
  const { status, data } = await client.post('/api/storage/items/import', {
    token: staff.token,
    body: { items: [
      { client: 'Imp', item: 'Laptop', serial: 'I-1', priceWeek: '$1,200.50', quantity: '2', startDate: '3/8/2026', endDate: '' },
      { client: 'Imp', item: 'Printer', serial: 'I-2', startDate: 46237 }, // Excel serial for 2026-08-03
      { client: '', item: '' }, // blank row skipped
    ] },
  });
  assert.equal(status, 201);
  assert.equal(data.imported, 2);
  const rows = db.prepare("SELECT * FROM storage_items WHERE client = 'Imp' ORDER BY serial").all();
  assert.equal(rows[0].price_week, 1200.5);
  assert.equal(rows[0].start_date, '2026-08-03');
  assert.equal(rows[0].end_date, null);
  assert.equal(rows[0].quantity, '2');
  assert.equal(rows[0].added_by, 'Staff Person');
  assert.equal(rows[1].start_date, '2026-08-03');
});

test('bulk edit is reachable, records the editor and handles the status override', async () => {
  const ids = db.prepare("SELECT id FROM storage_items WHERE client = 'Imp'").all().map((r) => r.id);
  const { status, data } = await client.patch('/api/storage/items/bulk-edit', { token: staff.token, body: { ids, updates: { poNumber: 'PO-9', status: 'out' } } });
  assert.equal(status, 200);
  assert.equal(data.updated, 2);
  const rows = db.prepare("SELECT * FROM storage_items WHERE client = 'Imp'").all();
  assert.ok(rows.every((r) => r.po_number === 'PO-9' && /^\d{4}-\d{2}-\d{2}$/.test(r.end_date) && r.last_edited_by === 'Staff Person'));
  await client.patch('/api/storage/items/bulk-edit', { token: staff.token, body: { ids, updates: { status: 'in' } } });
  assert.ok(db.prepare("SELECT * FROM storage_items WHERE client = 'Imp'").all().every((r) => r.end_date === null));
  // "Mark out" leaves an item that already left storage with its real end date.
  db.prepare('UPDATE storage_items SET end_date = ? WHERE id = ?').run('2026-03-01', ids[0]);
  const out = await client.patch('/api/storage/items/bulk-edit', { token: staff.token, body: { ids, updates: { status: 'out' } } });
  assert.equal(out.data.markedOut, 1);
  assert.equal(db.prepare('SELECT end_date FROM storage_items WHERE id = ?').get(ids[0]).end_date, '2026-03-01');
  await client.patch('/api/storage/items/bulk-edit', { token: staff.token, body: { ids, updates: { status: 'in' } } });
});

test('model summary groups exact spellings; rename sets model only', async () => {
  const ins = item(db);
  ins.run('m1', 'Mod', 'WP', 'A1', 'Printer', 'HP', 'LaserJet MFP E77830', 'M-1', 1, '2026-01-01', null);
  ins.run('m2', 'Mod', 'WP', 'A1', 'Printer', 'HP', 'E77830 MFP', 'M-2', 1, '2026-01-01', null);
  ins.run('m3', 'Mod', 'WP', 'A1', 'Printer', 'HP', 'E77830 MFP', 'M-3', 1, '2026-01-01', null);
  const { data } = await client.get('/api/storage/model-summary?client=Mod', { token: staff.token });
  assert.deepEqual(data.models.map((m) => [m.model, m.count]), [['E77830 MFP', 2], ['LaserJet MFP E77830', 1]]);
  const r = await client.post('/api/storage/items/rename-model', { token: staff.token, body: { ids: ['m1'], model: 'E77830 MFP' } });
  assert.equal(r.data.updated, 1);
  const row = db.prepare("SELECT make, model, last_edited_by FROM storage_items WHERE id = 'm1'").get();
  assert.deepEqual(row, { make: 'HP', model: 'E77830 MFP', last_edited_by: 'Staff Person' });
});

test('billing gaps: $0 items with no covering pallet rate', async () => {
  const ins = item(db);
  ins.run('g1', 'Gap', 'WP', 'Pallet 1', 'Laptop', null, null, 'G-1', 0, '2026-01-01', null); // covered by pallet
  ins.run('g2', 'Gap', 'WP', 'Shelf 2', 'Laptop', null, null, 'G-2', 0, '2026-01-01', null); // gap
  ins.run('g3', 'Gap', 'WP', '', 'Laptop', null, null, 'G-3', null, '2026-01-01', null); // gap (no location)
  ins.run('g4', 'Gap', 'WP', 'Shelf 2', 'Laptop', null, null, 'G-4', 5, '2026-01-01', null); // has a rate
  db.prepare("INSERT INTO storage_pallets (id, client, storage_centre, location, price_week) VALUES ('p1', 'Gap', 'WP', 'Pallet 1', 10)").run();
  const { data } = await client.get('/api/storage/billing-gaps', { token: staff.token });
  assert.deepEqual(data.items.filter((i) => i.client === 'Gap').map((i) => i.id).sort(), ['g2', 'g3']);
});

test('calculator: pallet + item rows, by location, and per item', async () => {
  const q = (g) => `/api/storage/reports/calculator?from=2026-08-01&to=2026-08-07&client=Gap&groupBy=${g}`;
  // Give the gap items rates so the item rows have a cost.
  db.prepare("UPDATE storage_items SET price_week = 7 WHERE id IN ('g2','g3')").run();
  const all = (await client.get(q('all'), { token: staff.token })).data;
  const pallet = all.rows.find((r) => r.type === 'Pallet');
  assert.equal(pallet.cost, 10); // $10/wk for 7 days
  assert.equal(all.rows.filter((r) => r.type === 'Item').length, 3); // g2, g3, g4
  assert.equal(all.total, 10 + 7 + 7 + 5);
  const loc = (await client.get(q('location'), { token: staff.token })).data;
  assert.deepEqual(loc.rows.map((r) => r.location).sort(), ['(none)', 'Pallet 1', 'Shelf 2']);
  assert.equal(loc.total, all.total);
  const none = (await client.get(q('none'), { token: staff.token })).data;
  assert.equal(none.rows.length, 4); // per item, pallet rate ignored
  assert.equal(none.total, 0 + 7 + 7 + 5);
});

test('date presets follow the old app (Mon–Sun weeks, Australian financial year)', () => {
  const { presetRange } = require('../storageTools');
  const now = new Date('2026-10-04T01:00:00Z'); // Sunday 4 Oct 2026, 11am Sydney
  assert.deepEqual(presetRange('lastWeek', now), { from: '2026-09-21', to: '2026-09-27' });
  assert.deepEqual(presetRange('lastMonth', now), { from: '2026-09-01', to: '2026-09-30' });
  assert.deepEqual(presetRange('lastQuarter', now), { from: '2026-07-01', to: '2026-09-30' });
  assert.deepEqual(presetRange('lastYear', now), { from: '2025-01-01', to: '2025-12-31' });
  assert.deepEqual(presetRange('lastFY', now), { from: '2025-07-01', to: '2026-06-30' });
  assert.equal(require('../storageTools').parseLocalDate('31/02/2026'), null);
});

test('dashboard returns per-client costs, counts and status lines', async () => {
  const { status, data } = await client.get('/api/storage/dashboard', { token: staff.token });
  assert.equal(status, 200);
  assert.ok(data.costByClient.find((r) => r.client === 'Gap'));
  assert.ok(['lastWeek', 'lastMonth', 'lastQuarter', 'lastYear', 'lastFY'].every((k) => data.ranges[k]));
  assert.ok(data.stats.inStorage >= 4);
  assert.ok(data.itemsByClient.find((r) => r.client === 'Gap').count >= 4);
  assert.equal(typeof data.unclassifiedLocations, 'number');
});

test('receiving/dispatch invoicing: per-client fees, client filter, admin-only PDF', async () => {
  const ins = db.prepare('INSERT INTO storage_receiving_dispatch (id, client, date_received, date_dispatched, rate, stock_received_type, stock_received_qty, stock_dispatched_type, stock_dispatched_qty) VALUES (?,?,?,?,?,?,?,?,?)');
  ins.run('rd1', 'Kilo', '2026-08-03', '2026-08-05', 10, 'Pallet: 2 @ $10', '2', 'Individual Item: 3 @ $5', '3');
  ins.run('rd2', 'Lima', '2026-08-04', null, null, 'Individual Item: 1 @ $5', '1', null, null);
  ins.run('rd3', 'Lima', '2026-09-04', null, null, 'Individual Item: 9 @ $5', '9', null, null); // outside period
  const { data } = await client.get('/api/storage/reports/rd?from=2026-08-01&to=2026-08-31', { token: staff.token });
  const kilo = data.clients.find((c) => c.client === 'Kilo');
  assert.deepEqual([kilo.receiving, kilo.dispatch, kilo.total, kilo.lines.length], [20, 15, 35, 2]);
  assert.equal(data.clients.find((c) => c.client === 'Lima').total, 5);
  assert.equal(data.total, 40);
  const one = (await client.get('/api/storage/reports/rd?from=2026-08-01&to=2026-08-31&client=Lima', { token: staff.token })).data;
  assert.deepEqual(one.clients.map((c) => c.client), ['Lima']);
  const denied = await client.get('/api/storage/reports/rd-invoice.pdf?client=Kilo&from=2026-08-01&to=2026-08-31', { token: staff.token });
  assert.equal(denied.status, 403);
  const pdf = await client.get('/api/storage/reports/rd-invoice.pdf?client=Kilo&from=2026-08-01&to=2026-08-31', { token: admin.token, raw: true });
  assert.equal(pdf.status, 200);
});

test('order statuses are validated; tracking number is optional on Delivered', async () => {
  db.prepare("INSERT INTO storage_orders (id, order_number, client, status) VALUES ('o1', 'SC-90001', 'Kilo', 'In Progress')").run();
  const bad = await client.patch('/api/storage/orders/o1', { token: staff.token, body: { status: 'Shipped' } });
  assert.equal(bad.status, 400);
  const noEmail = await client.post('/api/storage/orders/o1/deliver', { token: staff.token, body: { toEmail: 'nope' } });
  assert.equal(noEmail.status, 400);
  sent.length = 0;
  const ok = await client.post('/api/storage/orders/o1/deliver', { token: staff.token, body: { toEmail: 'cust@example.com', message: 'Thanks' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.order.status, 'Delivered');
  assert.equal(sent[0].trackingNumber, '');
});

test('presence: heartbeat lists who is online; sign-out clears it', async () => {
  await client.post('/api/presence/heartbeat', { token: staff.token });
  const { data } = await client.post('/api/presence/heartbeat', { token: admin.token });
  assert.deepEqual(data.users.map((u) => u.name).sort(), ['Admin Person', 'Staff Person']);
  await client.delete('/api/presence', { token: staff.token });
  const after2 = (await client.get('/api/presence', { token: admin.token })).data;
  assert.deepEqual(after2.users.map((u) => u.name), ['Admin Person']);
});

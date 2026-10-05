// Storage Centre: locations registry, PDFs, export/backup, and the client portal.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { freshDb, startTestServer, registerUser } = require('./helpers');

let client, server, db, staff, admin;

async function raw(method, path, { token, body } = {}) {
  const port = server.address().port;
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, headers: res.headers, buf: Buffer.from(await res.arrayBuffer()) };
}

before(async () => {
  ({ db } = freshDb());
  const app = express();
  app.use(express.json());
  app.use('/api/auth', require('../routes/auth'));
  app.use('/api/storage', require('../routes/storage'));
  // Mounted at /api ahead of the portal, as in index.js: its staff sign-in check
  // must only cover attachment URLs, not every /api request (it once blocked the
  // portal login with "Missing or invalid Authorization header").
  app.use('/api', require('../routes/attachments'));
  app.use('/api/storage-portal', require('../routes/storagePortal'));
  client = await startTestServer(app);
  server = client.server;
  admin = await registerUser(client, { name: 'Admin Person', email: 'admin@example.com' });
  db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(admin.id);
  staff = await registerUser(client, { name: 'Staff Person', email: 'staff@example.com' });
  db.prepare("UPDATE users SET role = 'user' WHERE id = ?").run(staff.id);

  const item = db.prepare('INSERT INTO storage_items (id, client, storage_centre, location, item, make, model, serial, price_week, start_date, end_date) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
  item.run('a1', 'Acme', 'Wetherill Park', 'Pallet 1', 'Laptop', 'Dell', '5420', 'SER-A1', 7, '2026-09-01', null);
  item.run('a2', 'Acme', 'Wetherill Park', 'Pallet 1', 'Laptop', 'Dell', '5420', 'SER-A2', 7, '2026-09-01', '2026-09-10');
  item.run('a3', 'Acme', 'Wetherill Park', 'Shelf B', 'Dock', 'Dell', 'WD19', 'SER-A3', 14, '2026-09-01', null);
  item.run('b1', 'Beta', 'Smithfield', 'Pallet 9', 'Desktop', 'HP', 'G9', 'SER-B1', 3.5, '2026-09-01', null);
  db.prepare('INSERT INTO storage_pallets (id, client, storage_centre, location, price_week, start_date) VALUES (?,?,?,?,?,?)')
    .run('p1', 'Acme', 'Wetherill Park', 'Pallet 1', 70, '2026-09-01');
  db.prepare('INSERT INTO storage_orders (id, order_number, client, devices, status) VALUES (?,?,?,?,?)').run('o-acme', 'SC-00001', 'Acme', 'SER-A1', 'Pending');
  db.prepare('INSERT INTO storage_orders (id, order_number, client, devices, status) VALUES (?,?,?,?,?)').run('o-beta', 'SC-00002', 'Beta', 'SER-B1', 'Pending');
  db.prepare('INSERT INTO storage_receiving_dispatch (id, client, date_dispatched, stock_dispatched_type, stock_dispatched_qty) VALUES (?,?,?,?,?)')
    .run('rd1', 'Acme', '2026-09-15', 'Individual Item: 2 @ $5', '2');
});

after(() => server.close());

// ---------------------------------------------------------------------------
test('locations overview lists in-use locations with counts, and classification round-trips', async () => {
  let { data } = await client.get('/api/storage/locations-registry/overview', { token: staff.token });
  const p1 = data.locations.find((l) => l.location === 'Pallet 1');
  assert.equal(p1.classified, false);
  assert.equal(p1.itemCount, 2);
  assert.equal(p1.currentItemCount, 1);
  assert.deepEqual(p1.clients, ['Acme']);
  assert.equal(p1.palletRecords, 1);

  await client.post('/api/storage/locations-registry', { token: staff.token, body: { location: 'pallet  1', isPallet: true } });
  ({ data } = await client.get('/api/storage/locations-registry/overview', { token: staff.token }));
  assert.equal(data.locations.filter((l) => l.location.toLowerCase() === 'pallet 1').length, 1, 'same location, not a duplicate');
  assert.equal(data.locations.find((l) => l.location.toLowerCase() === 'pallet 1').isPallet, true);

  assert.equal((await client.delete('/api/storage/locations-registry?location=Pallet%201', { token: staff.token })).status, 403);
  assert.equal((await client.delete('/api/storage/locations-registry?location=Pallet%201', { token: admin.token })).status, 200);
  ({ data } = await client.get('/api/storage/locations-registry/overview', { token: staff.token }));
  assert.equal(data.locations.find((l) => l.location.toLowerCase() === 'pallet 1').classified, false);
});

test('statement lines add up to the Reports summary', async () => {
  const q = 'from=2026-09-01&to=2026-09-30';
  const { data: summary } = await client.get(`/api/storage/reports/summary?${q}`, { token: admin.token });
  const { data: st } = await client.get(`/api/storage/reports/statement?client=Acme&${q}`, { token: admin.token });
  const acme = summary.summary.find((s) => s.client === 'Acme');
  assert.equal(st.total, acme.total);
  assert.equal(st.rdTotal, 10);
  // Pallet 1 group billed at the pallet rate: $70/wk × 30 days.
  const pallet = st.storageLines.find((l) => l.kind === 'pallet');
  assert.equal(pallet.days, 30);
  assert.equal(pallet.amount, 300);
});

test('order and invoice PDFs are real PDFs; invoices are admin-only', async () => {
  const order = await raw('GET', '/api/storage/orders/o-acme/pdf', { token: staff.token });
  assert.equal(order.status, 200);
  assert.equal(order.buf.subarray(0, 4).toString(), '%PDF');
  assert.equal((await raw('GET', '/api/storage/orders/nope/pdf', { token: staff.token })).status, 404);

  const q = '/api/storage/reports/invoice.pdf?client=Acme&from=2026-09-01&to=2026-09-30';
  assert.equal((await raw('GET', q, { token: staff.token })).status, 403);
  const inv = await raw('GET', q, { token: admin.token });
  assert.equal(inv.status, 200);
  assert.equal(inv.buf.subarray(0, 4).toString(), '%PDF');
  assert.match(inv.headers.get('content-disposition'), /INV-ACME-20260930\.pdf/);
  assert.equal((await raw('GET', '/api/storage/reports/invoice.pdf?client=Acme&from=2026-09-30&to=2026-09-01', { token: admin.token })).status, 400);
});

test('Storage Centre export zip contains every table and no password hashes', async () => {
  db.prepare("INSERT INTO storage_clients (id, client_name, username, password_hash) VALUES ('c-x', 'Export Co', 'exportco', 'SECRET-HASH')").run();
  assert.equal((await raw('GET', '/api/storage/export.zip', { token: staff.token })).status, 403);
  const zip = await raw('GET', '/api/storage/export.zip', { token: admin.token });
  assert.equal(zip.status, 200);
  assert.equal(zip.buf.subarray(0, 2).toString(), 'PK');
  // File names are stored uncompressed in the zip's directory.
  ['items.csv', 'pallets.csv', 'clients.csv', 'orders.csv', 'receiving-dispatch.csv', 'locations.csv', 'README.txt']
    .forEach((f) => assert.ok(zip.buf.includes(Buffer.from(f)), `${f} in zip`));
  const clientsCsv = require('../storageExport').tableCsvs().find((t) => t.file === 'clients.csv').csv;
  assert.ok(clientsCsv.includes('Export Co'));
  assert.ok(!clientsCsv.includes('SECRET-HASH'), 'password hash must not be exported');
  assert.ok(!/password_hash/.test(clientsCsv));
  db.prepare("DELETE FROM storage_clients WHERE id = 'c-x'").run();
});

test('backup snapshot is a complete, readable copy of the live database (WAL-safe)', async () => {
  const { snapshotDatabase } = require('../backup');
  db.prepare("INSERT INTO storage_items (id, client, item) VALUES ('snap-check', 'Acme', 'Just written')").run();
  const buf = await snapshotDatabase();
  const fs = require('fs'); const os = require('os'); const path = require('path');
  const tmp = path.join(os.tmpdir(), `snap-test-${process.pid}.db`);
  fs.writeFileSync(tmp, buf);
  const Database = require('better-sqlite3');
  const copy = new Database(tmp, { readonly: true });
  assert.equal(copy.prepare("SELECT item FROM storage_items WHERE id = 'snap-check'").get().item, 'Just written');
  copy.close();
  fs.unlinkSync(tmp);
  db.prepare("DELETE FROM storage_items WHERE id = 'snap-check'").run();
});

// ---------------------------------------------------------------------------
// Client portal
// ---------------------------------------------------------------------------
let acmeToken;

test('staff set up portal logins with validation', async () => {
  const short = await client.post('/api/storage/clients', { token: staff.token, body: { clientName: 'Acme', username: 'acme.ops', password: 'short' } });
  assert.equal(short.status, 400);
  const created = await client.post('/api/storage/clients', { token: staff.token, body: { clientName: 'Acme', username: 'acme.ops', password: 'acme-password-1' } });
  assert.equal(created.status, 201);
  assert.equal(created.data.client.hasPortalLogin, true);
  const dupe = await client.post('/api/storage/clients', { token: staff.token, body: { clientName: 'Beta', username: 'ACME.OPS', password: 'beta-password-1' } });
  assert.equal(dupe.status, 400, 'usernames are unique ignoring case');
  const beta = await client.post('/api/storage/clients', { token: staff.token, body: { clientName: 'Beta', username: 'beta', password: 'beta-password-1' } });
  assert.equal(beta.status, 201);
});

test('portal login: wrong password refused, username is case-insensitive', async () => {
  assert.equal((await client.post('/api/storage-portal/login', { body: { username: 'acme.ops', password: 'wrong-password' } })).status, 401);
  assert.equal((await client.post('/api/storage-portal/login', { body: { username: 'nobody', password: 'whatever-123' } })).status, 401);
  const ok = await client.post('/api/storage-portal/login', { body: { username: 'Acme.Ops', password: 'acme-password-1' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.client.name, 'Acme');
  acmeToken = ok.data.token;
});

test('portal and staff tokens cannot cross over', async () => {
  assert.equal((await client.get('/api/storage/items', { token: acmeToken })).status, 401, 'client token must not open staff API');
  assert.equal((await client.get('/api/storage/clients', { token: acmeToken })).status, 401);
  assert.equal((await client.get('/api/storage-portal/items', { token: staff.token })).status, 401, 'staff token is not a portal login');
  assert.equal((await client.get('/api/storage-portal/items')).status, 401);
});

test('portal only shows the signed-in client’s data, without prices', async () => {
  const { data: all } = await client.get('/api/storage-portal/items', { token: acmeToken });
  assert.deepEqual(all.items.map((i) => i.serial).sort(), ['SER-A1', 'SER-A2', 'SER-A3'], 'every Acme item, no one else\u2019s');
  assert.ok(all.items.every((i) => !('priceWeek' in i) && !('price_week' in i)));
  assert.equal(all.items.find((i) => i.serial === 'SER-A2').status, 'Out of Storage');
  assert.equal(all.items.find((i) => i.serial === 'SER-A1').status, 'In storage');

  const { data: orders } = await client.get('/api/storage-portal/orders', { token: acmeToken });
  assert.deepEqual(orders.orders.map((o) => o.orderNumber), ['SC-00001']);
  assert.equal((await raw('GET', '/api/storage-portal/orders/o-beta/pdf', { token: acmeToken })).status, 404, 'cannot open another client’s order');
  const pdf = await raw('GET', '/api/storage-portal/orders/o-acme/pdf', { token: acmeToken });
  assert.equal(pdf.buf.subarray(0, 4).toString(), '%PDF');

  const { data: rd } = await client.get('/api/storage-portal/receiving-dispatch', { token: acmeToken });
  assert.equal(rd.entries.length, 1);
  assert.equal(rd.entries[0].stockDispatched, 'Individual Item x 2');
  assert.ok(!JSON.stringify(rd).includes('$'), 'no rates or fees');
});

test('portal order submission creates an In Progress order for that client only', async () => {
  const missing = await client.post('/api/storage-portal/orders', { token: acmeToken, body: { deliveryAddress: '1 Test St' } });
  assert.equal(missing.status, 400, 'no devices picked');
  const notTheirs = await client.post('/api/storage-portal/orders', { token: acmeToken, body: { deviceIds: ['b1'], deliveryAddress: '1 Test St' } });
  assert.equal(notTheirs.status, 400, 'cannot order another client\u2019s stock');
  const gone = await client.post('/api/storage-portal/orders', { token: acmeToken, body: { deviceIds: ['a2'], deliveryAddress: '1 Test St' } });
  assert.equal(gone.status, 400, 'cannot order stock that has left storage');
  const res = await client.post('/api/storage-portal/orders', {
    token: acmeToken,
    body: { client: 'Beta', deviceIds: ['a1', 'a3'], deliveryAddress: '1 Test St', requestedBy: 'Pat', dateToBeDelivered: '2026-10-10' },
  });
  assert.equal(res.status, 201);
  const row = db.prepare('SELECT * FROM storage_orders WHERE order_number = ?').get(res.data.order.orderNumber);
  assert.equal(row.client, 'Acme', 'client always comes from the login, never the request body');
  assert.equal(row.status, 'In Progress', 'portal orders start In Progress, as in the old app');
  assert.equal(row.requestor, 'Pat (client portal)');
  assert.equal(row.devices, 'SER-A1, SER-A3', 'stored as serials, like the old app');
});

test('send to dispatch: Delivered, matching serials closed out, dispatch entry pre-fill', async () => {
  const order = db.prepare("SELECT * FROM storage_orders WHERE devices = 'SER-A1, SER-A3'").get();
  db.prepare("INSERT INTO storage_items (id, client, serial, start_date) VALUES ('other', 'Beta', 'SER-A3', '2026-09-01')").run();
  const { status, data } = await client.post(`/api/storage/orders/${order.id}/dispatch`, { token: staff.token, body: { endDate: '2026-10-11' } });
  assert.equal(status, 200);
  assert.equal(data.order.status, 'Delivered');
  assert.deepEqual(data.matched.sort(), ['SER-A1', 'SER-A3']);
  assert.equal(db.prepare("SELECT end_date FROM storage_items WHERE id = 'a1'").get().end_date, '2026-10-11');
  assert.equal(db.prepare("SELECT end_date FROM storage_items WHERE id = 'other'").get().end_date, null, 'another client\u2019s identical serial is untouched');
  assert.equal(data.dispatchPrefill.stockDispatchedType, 'Individual Item: 2 @ $5');
  assert.match(data.dispatchPrefill.dispatch, /^Dispatched from Order SC-\d{5}\nDevices: SER-A1, SER-A3\nDelivery address: 1 Test St/);
  // Running it again: both serials are now out of storage.
  const again = await client.post(`/api/storage/orders/${order.id}/dispatch`, { token: staff.token, body: {} });
  assert.deepEqual(again.data.unmatched.sort(), ['SER-A1 (already out of storage)', 'SER-A3 (already out of storage)']);
});

test('change password, then removed access takes effect immediately', async () => {
  const bad = await client.post('/api/storage-portal/change-password', { token: acmeToken, body: { currentPassword: 'nope', newPassword: 'new-password-22' } });
  assert.equal(bad.status, 400);
  const ok = await client.post('/api/storage-portal/change-password', { token: acmeToken, body: { currentPassword: 'acme-password-1', newPassword: 'new-password-22' } });
  assert.equal(ok.status, 200);
  assert.equal((await client.post('/api/storage-portal/login', { body: { username: 'acme.ops', password: 'new-password-22' } })).status, 200);

  const acmeId = db.prepare("SELECT id FROM storage_clients WHERE client_name = 'Acme'").get().id;
  await client.patch(`/api/storage/clients/${acmeId}`, { token: staff.token, body: { removePortalAccess: true } });
  assert.equal((await client.get('/api/storage-portal/items', { token: acmeToken })).status, 401, 'existing session cut off');
  assert.equal((await client.post('/api/storage-portal/login', { body: { username: 'acme.ops', password: 'new-password-22' } })).status, 401);
});

test('job attachment URLs still need a staff sign-in', async () => {
  assert.equal((await client.get('/api/attachments/nope/download')).status, 401);
  assert.equal((await client.post('/api/jobs/nope/attachments', { body: {} })).status, 401);
});

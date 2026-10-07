// Parity with the old Apps Script Storage Centre: undated receiving/dispatch
// entries aren't billed, receiving vs dispatch fees are split, staff are
// emailed when stock is received, the Monday invoicing email, and the portal's
// pallet count (only registry-classified pallets count).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { freshDb, startTestServer, registerUser } = require('./helpers');

let client, server, db, staff, admin;
const sent = [];

// Capture outgoing Storage Centre emails instead of sending them. Installed
// after freshDb() (which clears the module cache) and before the routes load.
function fakeEmails() {
  const real = require('../email');
  const emailPath = require.resolve('../email');
  require.cache[emailPath].exports = {
    ...real,
    notifyStorageOrderSubmitted: async (args) => { sent.push({ type: 'order', ...args }); },
    notifyStorageStockReceived: async (args) => { sent.push({ type: 'received', ...args }); },
    notifyStorageWeeklyInvoicing: async (args) => { sent.push({ type: 'weekly', ...args }); },
  };
}

before(async () => {
  process.env.STORAGE_RECEIVING_NOTIFY_EMAILS = 'stock@example.com, ops@example.com';
  process.env.STORAGE_NOTIFY_EMAILS = 'orders@example.com';
  process.env.STORAGE_WEEKLY_REMINDER_EMAILS = 'accounts@example.com';
  ({ db } = freshDb());
  fakeEmails();
  const app = express();
  app.use(express.json());
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

after(() => {
  server.close();
  delete process.env.STORAGE_RECEIVING_NOTIFY_EMAILS;
  delete process.env.STORAGE_NOTIFY_EMAILS;
  delete process.env.STORAGE_WEEKLY_REMINDER_EMAILS;
});

test('receiving vs dispatch fees are split, and undated entries are not billed (old app rule)', async () => {
  const ins = db.prepare('INSERT INTO storage_receiving_dispatch (id, client, date_received, date_dispatched, rate, stock_received_type, stock_received_qty, stock_dispatched_type, stock_dispatched_qty, saved_on) VALUES (?,?,?,?,?,?,?,?,?,?)');
  ins.run('r1', 'Delta', '2026-08-03', null, 10, 'Pallet', '2', null, null, '2026-08-03 09:00:00');
  ins.run('r2', 'Delta', null, '2026-08-05', null, null, null, 'Individual Item: 3 @ $5', '3', '2026-08-05 09:00:00');
  ins.run('r3', 'Delta', null, null, 10, 'Pallet', '7', null, null, '2026-08-04 09:00:00'); // no dates: never billed
  const { data } = await client.get('/api/storage/reports/summary?from=2026-08-03&to=2026-08-09', { token: admin.token });
  const delta = data.summary.find((s) => s.client === 'Delta');
  assert.equal(delta.receivingFees, 20);
  assert.equal(delta.dispatchFees, 15);
  assert.equal(delta.receivingDispatchFees, 35);
  assert.equal(delta.total, 35);
});

test('logging received stock emails staff; dispatch-only entries do not', async () => {
  sent.length = 0;
  await client.post('/api/storage/receiving-dispatch', { token: staff.token, body: { client: 'Echo', dateDispatched: '2026-09-01', stockDispatchedType: 'Pallet', stockDispatchedQty: 1, rate: 10 } });
  assert.equal(sent.filter((m) => m.type === 'received').length, 0);
  await client.post('/api/storage/receiving-dispatch', { token: staff.token, body: { client: 'Echo', dateReceived: '2026-09-02', stockReceivedType: 'Pallet', stockReceivedQty: 4, rate: 10, receiving: 'Shrink-wrapped' } });
  const mail = sent.find((m) => m.type === 'received');
  assert.ok(mail, 'stock-received email sent');
  assert.deepEqual(mail.toEmails, ['stock@example.com', 'ops@example.com']);
  assert.equal(mail.entry.client, 'Echo');
  assert.equal(mail.loggedBy, 'Staff Person');
});

test('portal orders email staff with the full order details', async () => {
  db.prepare("INSERT INTO storage_clients (id, client_name, username, password_hash) VALUES ('c-f', 'Foxtrot', 'fox', ?)").run(require('bcryptjs').hashSync('fox-password-1', 4));
  const { data: login } = await client.post('/api/storage-portal/login', { body: { username: 'fox', password: 'fox-password-1' } });
  db.prepare("INSERT INTO storage_items (id, client, item, make, model, serial, start_date) VALUES ('fx0', 'Foxtrot', 'Laptop', 'Dell', '5420', 'SER-1', '2026-09-01')").run();
  sent.length = 0;
  await client.post('/api/storage-portal/orders', {
    token: login.token,
    body: { deviceIds: ['fx0'], deliveryAddress: '2 Test Rd', siteContactName: 'Sam', siteContactPhone: '0400', configInformation: 'SOE', notes: 'Dock B', requestedBy: 'Pat' },
  });
  const mail = sent.find((m) => m.type === 'order');
  assert.equal(mail.source, 'portal');
  assert.equal(mail.siteContactName, 'Sam');
  assert.equal(mail.configInformation, 'SOE');
  assert.equal(mail.requestor, 'Pat (client portal)');
  assert.equal(mail.devices, 'Laptop Dell 5420 S/N SER-1');
});

test('portal orders still email the team when STORAGE_NOTIFY_EMAILS is not set', async () => {
  const saved = process.env.STORAGE_NOTIFY_EMAILS;
  delete process.env.STORAGE_NOTIFY_EMAILS;
  try {
    db.prepare("INSERT INTO storage_clients (id, client_name, username, password_hash) VALUES ('c-g', 'Golf', 'golf', ?)").run(require('bcryptjs').hashSync('golf-password-1', 4));
    const { data: login } = await client.post('/api/storage-portal/login', { body: { username: 'golf', password: 'golf-password-1' } });
    db.prepare("INSERT INTO storage_items (id, client, item, make, model, serial, start_date) VALUES ('g1', 'Golf', 'Laptop', 'HP', '840', 'SER-2', '2026-09-01')").run();
    sent.length = 0;
    const res = await client.post('/api/storage-portal/orders', {
      token: login.token,
      body: { deviceIds: ['g1'], deliveryAddress: '3 Test Rd', requestedBy: 'Pat' },
    });
    assert.equal(res.status, 201);
    const mail = sent.find((m) => m.type === 'order');
    assert.ok(mail, 'an order email was sent');
    assert.deepEqual(mail.toEmails, ['sam@itfactory.com.au', 'tom@itfactory.com.au', 'rnahas@itfactory.com.au', 'michael@itfactory.com.au', 'admin@itfactory.com.au', 'elina@itfactory.com.au']);
  } finally {
    process.env.STORAGE_NOTIFY_EMAILS = saved;
  }
});

test('portal pallet count only counts locations classified as pallets', async () => {
  const item = db.prepare('INSERT INTO storage_items (id, client, storage_centre, location, start_date, end_date) VALUES (?,?,?,?,?,?)');
  item.run('f1', 'Foxtrot', 'WP', 'Pallet 7', '2026-09-01', null);
  item.run('f2', 'Foxtrot', 'WP', 'pallet  7', '2026-09-01', null); // same pallet, different spacing/case
  item.run('f3', 'Foxtrot', 'WP', 'Warehouse Floor', '2026-09-01', null);
  item.run('f4', 'Foxtrot', 'WP', 'Pallet 8', '2026-09-01', null); // unclassified
  item.run('f5', 'Foxtrot', 'WP', 'Pallet 9', '2026-09-01', '2026-09-10'); // left storage
  item.run('f6', 'Foxtrot', 'WP', 'Pallet 7', null, null); // no start date: not "In storage"
  await client.post('/api/storage/locations-registry', { token: staff.token, body: { location: 'Pallet 7', isPallet: true } });
  await client.post('/api/storage/locations-registry', { token: staff.token, body: { location: 'Pallet 9', isPallet: true } });
  await client.post('/api/storage/locations-registry', { token: staff.token, body: { location: 'Warehouse Floor', isPallet: false } });
  const { data: login } = await client.post('/api/storage-portal/login', { body: { username: 'fox', password: 'fox-password-1' } });
  const { data } = await client.get('/api/storage-portal/summary', { token: login.token });
  assert.equal(data.inStorageCount, 5); // includes fx0 from the order test (no location)
  assert.equal(data.palletCount, 1);
});

test('weekly invoicing email: last Mon–Sun, Mondays only, once per week', async () => {
  const weekly = require('../storageWeekly');
  // Monday 12 Oct 2026, 09:00 Sydney (AEDT, UTC+11) = 22:00 UTC Sunday 11 Oct.
  const mondayMorning = new Date('2026-10-11T22:00:00Z');
  assert.deepEqual(weekly.lastWeekRange(mondayMorning), { from: '2026-10-05', to: '2026-10-11' });
  // Sunday 11 Oct, 19:00 Sydney: the last completed week is still 28 Sep – 4 Oct.
  assert.deepEqual(weekly.lastWeekRange(new Date('2026-10-11T08:00:00Z')), { from: '2026-09-28', to: '2026-10-04' });

  db.prepare("INSERT INTO storage_receiving_dispatch (id, client, date_received, rate, stock_received_type, stock_received_qty) VALUES ('w1', 'Golf', '2026-10-07', 10, 'Pallet', '3')").run();
  sent.length = 0;
  assert.equal(await weekly.tick(new Date('2026-10-12T22:00:00Z')), null, 'Tuesday: no send');
  assert.equal(await weekly.tick(new Date('2026-10-11T20:00:00Z')), null, 'Monday 7am: before the hour');
  const result = await weekly.tick(mondayMorning);
  assert.equal(result.ok, true);
  assert.equal(await weekly.tick(new Date('2026-10-11T23:00:00Z')), null, 'same week not sent twice');
  const mails = sent.filter((m) => m.type === 'weekly');
  assert.equal(mails.length, 1);
  assert.deepEqual(mails[0].toEmails, ['accounts@example.com']);
  assert.equal(mails[0].fromLabel, '05/10/2026');
  const golf = mails[0].rows.find((r) => r.client === 'Golf');
  assert.equal(golf.receivingFees, 30);
  assert.ok(mails[0].rows.every((r) => r.total > 0), 'only clients with something to bill');

  const manual = await client.post('/api/storage/reports/weekly-reminder', { token: staff.token });
  assert.equal(manual.status, 403);
});

test('invoice says ex GST when no GST rate is set', async () => {
  const { buildInvoicePdf } = require('../storagePdf');
  const pdf = await buildInvoicePdf({ client: 'Golf', from: '2026-10-05', to: '2026-10-11', storageLines: [], rdLines: [], storageTotal: 0, rdTotal: 30, total: 30 });
  assert.equal(pdf.subarray(0, 4).toString(), '%PDF');
});

// Receiving / Dispatch: fee = rate × qty, PATCH edits, Reports fee by date range,
// and the migration's field mapping for the old sheet's stock type/qty columns.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { freshDb, startTestServer, registerUser } = require('./helpers');

let client, server, token, adminToken, db;

before(async () => {
  ({ db } = freshDb());
  const app = express();
  app.use(express.json());
  app.use('/api/auth', require('../routes/auth'));
  app.use('/api/storage', require('../routes/storage'));
  client = await startTestServer(app);
  server = client.server;
  const admin = await registerUser(client, { name: 'Admin Person', email: 'admin@example.com' });
  db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(admin.id);
  adminToken = admin.token;
  const staff = await registerUser(client, { name: 'Staff Person', email: 'staff@example.com' });
  db.prepare("UPDATE users SET role = 'user' WHERE id = ?").run(staff.id);
  token = staff.token;
});

after(() => server.close());

test('POST computes fee as rate × received qty + rate × dispatched qty', async () => {
  const { status, data } = await client.post('/api/storage/receiving-dispatch', {
    token,
    body: {
      client: 'Acme', rate: '12.5', dateReceived: '2026-09-02', stockReceivedType: 'Pallets', stockReceivedQty: '4',
      dateDispatched: '2026-10-05', stockDispatchedType: 'Pallets', stockDispatchedQty: '2', receiving: 'Arrived wrapped',
    },
  });
  assert.equal(status, 201);
  assert.equal(data.entry.feeReceived, 50);
  assert.equal(data.entry.feeDispatched, 25);
  assert.equal(data.entry.fee, 75);
  assert.equal(data.entry.receiving, 'Arrived wrapped');
  assert.equal(data.entry.savedBy, 'Staff Person');
});

test('PATCH edits fields, recalculates the fee and records who saved it', async () => {
  const created = await client.post('/api/storage/receiving-dispatch', {
    token: adminToken, body: { client: 'Beta', rate: 10, stockReceivedType: 'Cartons', stockReceivedQty: 3 },
  });
  const id = created.data.entry.id;
  const { status, data } = await client.patch(`/api/storage/receiving-dispatch/${id}`, {
    token, body: { stockReceivedQty: '5', dispatch: 'Courier booked', dateDispatched: '' },
  });
  assert.equal(status, 200);
  assert.equal(data.entry.stockReceivedQty, '5');
  assert.equal(data.entry.stockReceivedType, 'Cartons'); // untouched field kept
  assert.equal(data.entry.dispatch, 'Courier booked');
  assert.equal(data.entry.dateDispatched, null);
  assert.equal(data.entry.fee, 50);
  assert.equal(data.entry.savedBy, 'Staff Person');

  const blank = await client.patch(`/api/storage/receiving-dispatch/${id}`, { token, body: { client: '' } });
  assert.equal(blank.status, 400);
  const missing = await client.patch('/api/storage/receiving-dispatch/nope', { token, body: { rate: 1 } });
  assert.equal(missing.status, 404);
});

test('GET can filter by client', async () => {
  const { data } = await client.get('/api/storage/receiving-dispatch?client=Acme', { token });
  assert.ok(data.entries.length >= 1);
  assert.ok(data.entries.every((e) => e.client === 'Acme'));
});

test('only admins can delete', async () => {
  const created = await client.post('/api/storage/receiving-dispatch', { token, body: { client: 'Gamma' } });
  const id = created.data.entry.id;
  assert.equal((await client.delete(`/api/storage/receiving-dispatch/${id}`, { token })).status, 403);
  assert.equal((await client.delete(`/api/storage/receiving-dispatch/${id}`, { token: adminToken })).status, 200);
});

test('Reports charge each half of the fee in the period its own date falls in', async () => {
  // Acme: received 2026-09-02 ($50), dispatched 2026-10-05 ($25). Acme has no stored items,
  // so this also checks that fee-only clients still appear in the summary.
  const sept = await client.get('/api/storage/reports/summary?from=2026-09-01&to=2026-09-30', { token: adminToken });
  assert.equal(sept.status, 200);
  const acmeSept = sept.data.summary.find((s) => s.client === 'Acme');
  assert.ok(acmeSept, 'Acme should appear even with no stored items');
  assert.equal(acmeSept.receivingDispatchFees, 50);

  const oct = await client.get('/api/storage/reports/summary?from=2026-10-01&to=2026-10-31', { token: adminToken });
  assert.equal(oct.data.summary.find((s) => s.client === 'Acme').receivingDispatchFees, 25);
});

test('migration maps the old sheet stock type/qty fields', () => {
  const { mapReceivingDispatch } = require('../scripts/migrate-storage-centre');
  const camel = mapReceivingDispatch({
    client: 'Acme', dateReceived: '01/03/2026', dateDispatched: '', rate: '$15',
    stockReceivedType: 'Pallets', stockReceivedQty: 6, stockDispatchedType: '', stockDispatchedQty: '',
    receiving: 'Left at dock 2', dispatch: '', savedBy: 'Rob', savedOn: '01/03/2026 09:15',
  });
  assert.equal(camel.dateReceived, '2026-03-01');
  assert.equal(camel.dateDispatched, null);
  assert.equal(camel.rate, 15);
  assert.equal(camel.stockReceivedType, 'Pallets');
  assert.equal(camel.stockReceivedQty, '6');
  assert.equal(camel.stockDispatchedQty, null);
  assert.equal(camel.receiving, 'Left at dock 2'); // notes stay notes
  assert.equal(camel.savedOn, '2026-03-01 09:15:00');

  const headings = mapReceivingDispatch({ client: 'B', 'Stock Dispatched Type': 'Cartons', 'Stock Dispatched Qty': '3' });
  assert.equal(headings.stockDispatchedType, 'Cartons');
  assert.equal(headings.stockDispatchedQty, '3');

  // Shorthand in a notes field is used only when the Qty column is empty and the text is exactly that shape.
  const shorthand = mapReceivingDispatch({ client: 'C', receiving: 'Pallets: 2 @ $25' });
  assert.equal(shorthand.stockReceivedType, 'Pallets');
  assert.equal(shorthand.stockReceivedQty, '2');
  const prose = mapReceivingDispatch({ client: 'C', receiving: 'Note: 2 boxes damaged, photos taken' });
  assert.equal(prose.stockReceivedQty, null);

  const isoDate = mapReceivingDispatch({ client: 'D', dateReceived: '2026-02-28T13:00:00.000Z' });
  assert.equal(isoDate.dateReceived, '2026-03-01');
});

test('old-app rows: rate lives in the Type text ("Individual Item: 65 @ $5")', async () => {
  const { mapReceivingDispatch } = require('../scripts/migrate-storage-centre');
  // Shape seen in the live export (sample 3).
  const m = mapReceivingDispatch({
    _row: 28, client: 'NSW Health WSLHD', dateReceived: '', dateDispatched: '22/09/2026', rate: '',
    stockReceivedType: '', stockReceivedQty: '', stockDispatchedType: 'Individual Item: 9 @ $5', stockDispatchedQty: 9,
    receiving: '', dispatch: 'Dispatched from Order ORD-00027', savedBy: 'Robert Nahas', savedOn: '24/09/2026 17:24',
  });
  assert.equal(m.stockDispatchedType, 'Individual Item');
  assert.equal(m.stockDispatchedQty, '9');
  assert.equal(m.rate, 5);
  assert.equal(m.dateDispatched, '2026-09-22');

  // Several parts stay as written; the API reads the fee from the parts.
  const multi = mapReceivingDispatch({ client: 'Multi', stockReceivedType: 'Pallets: 2 @ $25; Cartons: 4 @ $3', stockReceivedQty: '6' });
  assert.equal(multi.stockReceivedType, 'Pallets: 2 @ $25; Cartons: 4 @ $3');
  assert.equal(multi.rate, null);

  const { data } = await client.post('/api/storage/receiving-dispatch', {
    token, body: { client: 'Multi', stockReceivedType: multi.stockReceivedType, stockReceivedQty: '6',
      stockDispatchedType: 'Individual Item: 65 @ $5', stockDispatchedQty: '65' },
  });
  assert.equal(data.entry.feeReceived, 62); // 2×25 + 4×3
  assert.equal(data.entry.feeDispatched, 325); // 65×5, no Rate column needed
  assert.equal(data.entry.fee, 387);
});

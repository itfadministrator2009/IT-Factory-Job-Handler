// Storage Centre: a client can be charged in US dollars. Amounts are labelled in
// the client's currency and totals are kept separate per currency.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { freshDb, startTestServer, registerUser } = require('./helpers');

let client, server, db, staff;
const emails = [];

before(async () => {
  ({ db } = freshDb());
  const real = require('../email');
  require.cache[require.resolve('../email')].exports = { ...real, notifyStorageWeeklyInvoicing: async (args) => { emails.push(args); } };
  const app = express();
  app.use(express.json());
  app.use('/api/auth', require('../routes/auth'));
  app.use('/api/storage', require('../routes/storage'));
  client = await startTestServer(app);
  server = client.server;
  staff = await registerUser(client, { name: 'Staff Person', email: 'staff@example.com' });
  db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(staff.id);
  const item = db.prepare('INSERT INTO storage_items (id, client, storage_centre, location, item, price_week, start_date) VALUES (?,?,?,?,?,?,?)');
  item.run('a1', 'Aussie Co', 'WP', 'Shelf 1', 'Laptop', 7, '2026-01-01'); // $1/day
  item.run('u1', 'Yank Corp', 'WP', 'Shelf 2', 'Laptop', 14, '2026-01-01'); // US$2/day
});

after(() => server.close());

test('clients are AUD by default and can be set to USD; other values are refused', async () => {
  const made = await client.post('/api/storage/clients', { token: staff.token, body: { clientName: 'Yank Corp', currency: 'usd' } });
  assert.equal(made.status, 201);
  assert.equal(made.data.client.currency, 'USD');
  const aus = await client.post('/api/storage/clients', { token: staff.token, body: { clientName: 'Aussie Co' } });
  assert.equal(aus.data.client.currency, 'AUD');
  const bad = await client.patch(`/api/storage/clients/${aus.data.client.id}`, { token: staff.token, body: { currency: 'EUR' } });
  assert.equal(bad.status, 400);
  const list = await client.get('/api/storage/clients', { token: staff.token });
  assert.deepEqual(list.data.clients.map((c) => [c.clientName, c.currency]), [['Aussie Co', 'AUD'], ['Yank Corp', 'USD']]);
});

test('report summary labels each client and keeps a total per currency', async () => {
  const { data } = await client.get('/api/storage/reports/summary?from=2026-03-02&to=2026-03-08', { token: staff.token });
  const by = Object.fromEntries(data.summary.map((r) => [r.client, r]));
  assert.equal(by['Aussie Co'].currency, 'AUD');
  assert.equal(by['Yank Corp'].currency, 'USD');
  assert.deepEqual(data.totals, [{ currency: 'AUD', total: 7 }, { currency: 'USD', total: 14 }]);
  assert.equal(data.grandTotal, 7); // AUD only — never AUD + USD
  const st = await client.get('/api/storage/reports/statement?client=Yank%20Corp&from=2026-03-02&to=2026-03-08', { token: staff.token });
  assert.equal(st.data.currency, 'USD');
});

test('calculator and dashboard carry the currency too', async () => {
  const calc = await client.get('/api/storage/reports/calculator?from=2026-03-02&to=2026-03-08&groupBy=none', { token: staff.token });
  assert.deepEqual(calc.data.totals, [{ currency: 'AUD', total: 7 }, { currency: 'USD', total: 14 }]);
  assert.equal(calc.data.rows.find((r) => r.client === 'Yank Corp').currency, 'USD');
  const dash = await client.get('/api/storage/dashboard', { token: staff.token });
  assert.equal(dash.data.costByClient.find((r) => r.client === 'Yank Corp').currency, 'USD');
});

test('weekly email gets per-currency totals', async () => {
  const { sendWeeklyInvoicingReminder } = require('../storageWeekly');
  emails.length = 0;
  const r = await sendWeeklyInvoicingReminder({ toEmails: ['x@example.com'], range: { from: '2026-03-02', to: '2026-03-08' } });
  assert.deepEqual(r.totals, [{ currency: 'AUD', total: 7 }, { currency: 'USD', total: 14 }]);
  assert.equal(emails[0].rows.find((x) => x.client === 'Yank Corp').currency, 'USD');
});

test('money is formatted with US$ for USD', () => {
  const { formatMoney } = require('../storageCurrency');
  assert.equal(formatMoney(1234.5, 'USD'), 'US$1,234.50');
  assert.equal(formatMoney(1234.5, 'AUD'), '$1,234.50');
});

// ITF Sales Manager: access, items, moves, imports, Shopify review list, weekly summary.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { freshDb, startTestServer, registerUser } = require('./helpers');

let client, server, db, ana, sam;

before(async () => {
  ({ db } = freshDb());
  require('../email').sendMail = async () => {};
  const app = express();
  app.use(express.json({ limit: '15mb' }));
  app.use('/api/auth', require('../routes/auth'));
  app.use('/api/users', require('../routes/users'));
  app.use('/api/sales', require('../routes/sales'));
  client = await startTestServer(app);
  server = client.server;
  ana = await registerUser(client, { name: 'Ana Admin', email: 'ana@itf.test' });
  sam = await registerUser(client, { name: 'Sam Staff', email: 'sam@itf.test' });
  db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(ana.id);
  db.prepare("UPDATE users SET role = 'staff' WHERE id = ?").run(sam.id);
});
after(() => server.close());

const add = (u, kind, data, extra = {}) => client.post('/api/sales/items', { token: u.token, body: { kind, data, ...extra } });

test('staff need Sales Manager switched on; admins always have it', async () => {
  assert.equal((await client.get('/api/sales/items?kind=sale', { token: sam.token })).status, 403);
  assert.equal((await client.get('/api/sales/items?kind=sale', { token: ana.token })).status, 200);
  const me = await client.get('/api/auth/me', { token: sam.token });
  assert.equal(me.data.user.accessSales, false);
  await client.patch(`/api/users/admin/${sam.id}`, { token: ana.token, body: { accessSales: true } });
  assert.equal((await client.get('/api/sales/items?kind=sale', { token: sam.token })).status, 200);
  assert.equal((await client.get('/api/auth/me', { token: sam.token })).data.user.accessSales, true);
});

test('add, edit and delete keep who did it and the old field names', async () => {
  const r = await add(sam, 'inventory', { sku: '0467', itemtype: 'Laptop', make: 'Dell', model: 'Latitude 5420', serial: 'ABC123', cost: '150', labour: 35 });
  assert.equal(r.status, 201);
  const it = r.data.item;
  assert.equal(it.sku, '0467'); // leading zero kept
  assert.equal(it.kind, 'inventory');
  assert.equal(it.addedby, 'Sam Staff');
  assert.ok(it.createdAt > 0);
  const u = await client.patch(`/api/sales/items/${it.id}`, { token: ana.token, body: { data: { status: 'Tested', listed: 499 } } });
  assert.equal(u.data.item.status, 'Tested');
  assert.equal(u.data.item.listed, '499');
  assert.equal(u.data.item.lasteditedby, 'Ana Admin');
  assert.equal(u.data.item.addedby, 'Sam Staff');
  assert.equal((await add(sam, 'sale', { make: 'HP' })).status, 400); // needs SKU or model
  const tmp = (await add(sam, 'sale', { sku: 'DEL-ME' })).data.item;
  assert.equal((await client.delete(`/api/sales/items/${tmp.id}`, { token: sam.token })).status, 200);
  assert.equal((await client.get(`/api/sales/items?kind=sale`, { token: sam.token })).data.items.some((x) => x.id === tmp.id), false);
});

test('moving inventory into Sales sets today as the sell date and Sold; and back again', async () => {
  const inv = (await client.get('/api/sales/items?kind=inventory', { token: sam.token })).data.items.find((x) => x.sku === '0467');
  const mv = await client.post('/api/sales/items/move', { token: sam.token, body: { ids: [inv.id], to: 'sale' } });
  assert.equal(mv.data.moved, 1);
  const sale = (await client.get('/api/sales/items?kind=sale', { token: sam.token })).data.items.find((x) => x.id === inv.id);
  assert.match(sale.selldate, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(sale.status, '');
  const back = await client.post('/api/sales/items/move', { token: sam.token, body: { ids: [inv.id], to: 'inventory' } });
  assert.equal(back.data.moved, 1);
  assert.ok((await client.get('/api/sales/items?kind=inventory', { token: sam.token })).data.items.some((x) => x.id === inv.id));
});

test('bulk update changes only the ticked fields', async () => {
  const a = (await add(sam, 'inventory', { sku: 'B1', model: 'X', location: 'Shelf 1' })).data.item;
  const b = (await add(sam, 'inventory', { sku: 'B2', model: 'Y', location: 'Shelf 2' })).data.item;
  const r = await client.post('/api/sales/items/bulk-update', { token: sam.token, body: { ids: [a.id, b.id], fields: { status: 'Listed' } } });
  assert.equal(r.data.updated, 2);
  const items = (await client.get('/api/sales/items?kind=inventory', { token: sam.token })).data.items;
  assert.equal(items.find((x) => x.id === a.id).status, 'Listed');
  assert.equal(items.find((x) => x.id === b.id).location, 'Shelf 2');
});

test('Google Sheet import keeps the sheet ids, so running it again updates instead of doubling', async () => {
  const rows = [
    { id: 'e17000001', sku: '0001', make: 'Lenovo', model: 'T14', selldate: '2026-09-01', sellprice: 400, cost: 200, platform: 'eBay', addedby: 'Tara', createdAt: 1757000000000 },
    { id: 'e17000002', sku: '0002', make: 'Apple', model: 'iPad', selldate: '2026-09-02', sellprice: 300, platform: 'Shopify', shopifysourcekey: '111-222' },
  ];
  assert.equal((await client.post('/api/sales/import', { token: sam.token, body: { kind: 'sale', records: rows, keepIds: true } })).status, 403);
  const first = await client.post('/api/sales/import', { token: ana.token, body: { kind: 'sale', records: rows, keepIds: true } });
  assert.deepEqual(first.data, { added: 2, updated: 0 });
  rows[0].sellprice = 450;
  const again = await client.post('/api/sales/import', { token: ana.token, body: { kind: 'sale', records: rows, keepIds: true } });
  assert.deepEqual(again.data, { added: 0, updated: 2 });
  const items = (await client.get('/api/sales/items?kind=sale', { token: ana.token })).data.items;
  const t14 = items.find((x) => x.id === 'e17000001');
  assert.equal(t14.sellprice, '450');
  assert.equal(t14.addedby, 'Tara');
  assert.equal(t14.createdAt, 1757000000000);
});

test('Shopify order lines: sync stages new lines once; adding one to Sales takes it off the list', async () => {
  process.env.SHOPIFY_STORE_DOMAIN = 'https://teststore.myshopify.com/';
  process.env.SHOPIFY_CLIENT_ID = 'id';
  process.env.SHOPIFY_CLIENT_SECRET = 'secret';
  const shopify = require('../salesShopify');
  shopify._resetToken();
  const orders = [
    { id: 111, name: '#1001', created_at: '2026-10-20T01:00:00Z', customer: { first_name: 'Jo', last_name: 'Bloggs' },
      line_items: [{ id: 222, title: 'iPad', sku: 'S-1', quantity: 1, price: '300.00' }, { id: 333, title: 'Case', sku: 'S-2', quantity: 2, price: '20.00' }] },
  ];
  const calls = [];
  const fakeFetch = async (url) => {
    calls.push(url);
    if (url.includes('/oauth/access_token')) return { ok: true, json: async () => ({ access_token: 'tok', expires_in: 86399 }) };
    return { ok: true, json: async () => ({ orders }), headers: { get: () => '' } };
  };
  const r = await shopify.syncShopifyOrders({ fetchImpl: fakeFetch });
  assert.equal(r.ok, true);
  assert.equal(r.staged, 1); // 111-222 is already in Sales (imported above), only the case line is new
  assert.ok(calls[0].startsWith('https://teststore.myshopify.com/admin/oauth/access_token'));
  const again = await shopify.syncShopifyOrders({ fetchImpl: fakeFetch });
  assert.equal(again.staged, 0);
  const pending = (await client.get('/api/sales/shopify/pending', { token: sam.token })).data.orders;
  assert.equal(pending.length, 1);
  assert.equal(pending[0].orderNumber, '#1001');
  assert.equal(pending[0].customer, 'Jo Bloggs');
  const saved = await add(sam, 'sale', { model: 'Case', sellprice: '20', platform: 'Shopify' }, { shopifyPendingId: pending[0].id });
  assert.equal(saved.status, 201);
  assert.equal(saved.data.item.shopifysourcekey, '111-333');
  assert.equal((await client.get('/api/sales/shopify/pending', { token: sam.token })).data.orders.length, 0);
  const cov = await shopify.checkCoverage(null, null, { fetchImpl: fakeFetch });
  assert.equal(cov.matched, 0); // no sale carries order #1001 in its Order no. yet
  assert.equal(cov.missing, 1);
  delete process.env.SHOPIFY_STORE_DOMAIN;
});

test('weekly summary: revenue, net after the weekly labour + ads, and slow stock', async () => {
  const { weeklySummary } = require('../salesWeekly');
  const s = weeklySummary({ from: '2026-09-01', to: '2026-09-07' });
  // 0001: 450 - 200 = 250; 0002: 300. Less $3,000 labour + $1,000 ads for the week.
  assert.equal(s.itemsSold, 2);
  assert.equal(s.revenue, 750);
  assert.equal(s.net, 550 - 4000);
  db.prepare("UPDATE sales_items SET created_at = ? WHERE sku = 'B1'").run(Date.now() - 61 * 86400000);
  assert.equal(weeklySummary({ from: '2026-09-01', to: '2026-09-07' }).slowStock, 1);
});

test('clearing a whole list is admin-only and needs confirming', async () => {
  assert.equal((await client.delete('/api/sales/items?kind=inventory&confirm=yes', { token: sam.token })).status, 403);
  assert.equal((await client.delete('/api/sales/items?kind=inventory', { token: ana.token })).status, 400);
  const r = await client.delete('/api/sales/items?kind=inventory&confirm=yes', { token: ana.token });
  assert.ok(r.data.removed >= 1);
  const log = (await client.get('/api/sales/activity', { token: sam.token })).data.entries;
  assert.ok(log.some((e) => e.action === 'Cleared all data'));
});

// ITF Time Card: a photo (or PDF) of the receipt/invoice on an expense claim.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const express = require('express');

const { freshDb, startTestServer, registerUser, TEST_UPLOAD_DIR } = require('./helpers');

const UPLOADS = TEST_UPLOAD_DIR; // the helpers point uploads here

let client, server, db, admin, con, other, base, weekId;
// A tiny valid PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

// Files are deleted in the background, so give it a moment.
async function gone(file) {
  for (let i = 0; i < 50 && fs.existsSync(file); i++) await new Promise((r) => setTimeout(r, 20));
  return !fs.existsSync(file);
}
async function login(email) {
  const { data } = await client.post('/api/auth/login', { body: { email, password: 'password123' } });
  return { token: data.token, id: data.user.id };
}
async function postExpense(token, fields, file) {
  const form = new FormData();
  Object.entries(fields).forEach(([k, v]) => form.append(k, String(v)));
  if (file) form.append('receipt', new Blob([file.buf], { type: file.type }), file.name);
  const res = await fetch(`${base}/api/timecard/my/weeks/${weekId}/expenses`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
  return { status: res.status, data: await res.json() };
}

before(async () => {
  ({ db } = freshDb());
  require('../email').sendMail = async () => {};
  const app = express();
  app.use(express.json());
  app.use('/api/auth', require('../routes/auth'));
  app.use('/api/users', require('../routes/users'));
  app.use('/api/timecard', require('../routes/timecard'));
  client = await startTestServer(app);
  server = client.server;
  base = `http://127.0.0.1:${server.address().port}`;
  admin = await registerUser(client, { name: 'Ana Admin', email: 'ana@itf.test' });
  for (const [name, email] of [['Cara Contractor', 'cara@contractor.test'], ['Dan Contractor', 'dan@contractor.test']]) {
    const r = await client.post('/api/users/admin', { token: admin.token, body: { name, email, password: 'password123', role: 'contractor' } });
    assert.equal(r.status, 201);
  }
  con = await login('cara@contractor.test');
  other = await login('dan@contractor.test');
  weekId = (await client.get('/api/timecard/my', { token: con.token })).data.week.id;
});

after(() => server.close());

test('an expense can be claimed with a photo of the receipt', async () => {
  const r = await postExpense(con.token, { date: '2026-10-27', type: 'Fuel', amount: '54.20', description: 'Fuel to site' }, { buf: PNG, type: 'image/png', name: 'receipt.png' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const x = r.data.week.expenses[0];
  assert.equal(x.amount, 54.2);
  assert.equal(x.receipt.name, 'receipt.png');
  const stored = db.prepare('SELECT receipt_name FROM timecard_expenses WHERE id = ?').get(x.id).receipt_name;
  assert.ok(fs.existsSync(path.join(UPLOADS, stored)));

  // The claimant and a Time Card admin can open it; another contractor can't.
  const view = (token) => fetch(`${base}/api/timecard/expenses/${x.id}/receipt`, { headers: { Authorization: `Bearer ${token}` } });
  const mine = await view(con.token);
  assert.equal(mine.status, 200);
  assert.deepEqual(Buffer.from(await mine.arrayBuffer()), PNG);
  assert.equal((await view(admin.token)).status, 200);
  assert.equal((await view(other.token)).status, 404);
});

test('a receipt is optional, and only photos or PDFs are kept', async () => {
  const plain = await postExpense(con.token, { date: '2026-10-28', type: 'Parking', amount: '12' });
  assert.equal(plain.status, 200);
  assert.equal(plain.data.week.expenses.find((e) => e.type === 'Parking').receipt, null);
  const pdf = await postExpense(con.token, { date: '2026-10-28', type: 'Materials', amount: '30' }, { buf: Buffer.from('%PDF-1.4 test'), type: 'application/pdf', name: 'invoice.pdf' });
  assert.equal(pdf.data.week.expenses.find((e) => e.type === 'Materials').receipt.mime, 'application/pdf');
  const txt = await postExpense(con.token, { date: '2026-10-28', type: 'Meals', amount: '9' }, { buf: Buffer.from('hello'), type: 'text/plain', name: 'note.txt' });
  assert.equal(txt.data.week.expenses.find((e) => e.type === 'Meals').receipt, null, 'other files are ignored');
});

test('a bad expense never leaves its photo behind', async () => {
  const before = fs.readdirSync(UPLOADS).length;
  const r = await postExpense(con.token, { date: '', type: 'Fuel', amount: '10' }, { buf: PNG, type: 'image/png', name: 'r.png' });
  assert.equal(r.status, 400);
  assert.equal(fs.readdirSync(UPLOADS).length, before);
});

test('deleting an expense, or clearing the week, removes the receipt file', async () => {
  const week = (await client.get('/api/timecard/my', { token: con.token })).data.week;
  const fuel = week.expenses.find((e) => e.type === 'Fuel');
  const stored = db.prepare('SELECT receipt_name FROM timecard_expenses WHERE id = ?').get(fuel.id).receipt_name;
  const del = await client.delete(`/api/timecard/my/weeks/${weekId}/expenses/${fuel.id}`, { token: con.token });
  assert.equal(del.status, 200);
  assert.ok(await gone(path.join(UPLOADS, stored)));

  const pdfName = db.prepare("SELECT receipt_name FROM timecard_expenses WHERE type = 'Materials'").get().receipt_name;
  await client.post(`/api/timecard/my/weeks/${weekId}/clear`, { token: con.token });
  assert.ok(await gone(path.join(UPLOADS, pdfName)));
});

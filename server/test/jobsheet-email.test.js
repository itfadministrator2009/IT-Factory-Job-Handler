// Email Job Sheet: admin@ by default, more recipients can be added.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { freshDb, startTestServer, registerUser } = require('./helpers');

let client, server, db, staff;
const sent = [];

before(async () => {
  ({ db } = freshDb());
  const real = require('../email');
  require.cache[require.resolve('../email')].exports = { ...real, sendJobSheetEmail: async (args) => { sent.push(args); } };
  const app = express();
  app.use(express.json());
  app.use('/api/auth', require('../routes/auth'));
  app.use('/api/jobs', require('../routes/pdf'));
  client = await startTestServer(app);
  server = client.server;
  staff = await registerUser(client, { name: 'Staff Person', email: 'staff@example.com' });
  db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(staff.id);
  // No contact email on this job — it can still be emailed now.
  db.prepare("INSERT INTO jobs (id, job_number, contact_name, subject) VALUES ('j1', 77, 'Pat', 'Printer install')").run();
});

after(() => server.close());

test('with no recipients given it goes to admin@itfactory.com.au', async () => {
  sent.length = 0;
  const res = await client.post('/api/jobs/j1/email-pdf', { token: staff.token, body: {} });
  assert.equal(res.status, 200);
  assert.equal(res.data.sentTo, 'admin@itfactory.com.au');
  assert.equal(sent[0].toEmail, 'admin@itfactory.com.au');
});

test('several recipients, duplicates dropped, bad addresses refused', async () => {
  sent.length = 0;
  const ok = await client.post('/api/jobs/j1/email-pdf', {
    token: staff.token, body: { toEmails: ['admin@itfactory.com.au', 'tech@example.com; ADMIN@itfactory.com.au', 'client@example.com'] },
  });
  assert.equal(ok.status, 200);
  assert.equal(sent[0].toEmail, 'admin@itfactory.com.au, tech@example.com, client@example.com');
  const bad = await client.post('/api/jobs/j1/email-pdf', { token: staff.token, body: { toEmails: ['admin@itfactory.com.au', 'nope'] } });
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /nope/);
});

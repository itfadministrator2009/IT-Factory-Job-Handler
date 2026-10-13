// Certificate of Data Destruction: built from spreadsheet rows for a job.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { freshDb, startTestServer, registerUser } = require('./helpers');
const { cleanRows } = require('../dataCertPdf');

let client, server, db, staff, base;

before(async () => {
  ({ db } = freshDb());
  const app = express();
  app.use(express.json({ limit: '15mb' }));
  app.use('/api/auth', require('../routes/auth'));
  app.use('/api/jobs', require('../routes/pdf'));
  client = await startTestServer(app);
  server = client.server;
  base = `http://127.0.0.1:${server.address().port}`;
  staff = await registerUser(client, { name: 'Staff Person', email: 'staff@example.com' });
  db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(staff.id);
  db.prepare("INSERT INTO jobs (id, job_number, contact_name, account_name, subject) VALUES ('j1', 50, 'Pat', 'Axiom Technologies', 'Collection')").run();
});

after(() => server.close());

const post = (id, body) => fetch(`${base}/api/jobs/${id}/data-destruction-certificate`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${staff.token}` }, body: JSON.stringify(body),
});

test('certificate PDF is built from the rows, named after the job and customer', async () => {
  const rows = Array.from({ length: 45 }, (_, i) => ({ item: 'Hard Drive', make: '36GB 3.5" SCSI', model: 'DDYS-T36950', serial: `SER-${i}` }));
  const res = await post('j1', { rows });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/pdf');
  assert.equal(res.headers.get('x-filename'), '50_Axiom_Technologies_Certificate_of_Data_Destruction.pdf');
  const buf = Buffer.from(await res.arrayBuffer());
  assert.equal(buf.subarray(0, 4).toString(), '%PDF');
  // 45 devices run onto a second page.
  assert.equal((buf.toString('latin1').match(/\/Type \/Page\b/g) || []).length, 2);
});

test('empty spreadsheet and unknown job are refused', async () => {
  assert.equal((await post('j1', { rows: [] })).status, 400);
  assert.equal((await post('j1', { rows: [{ item: '', serial: ' ' }] })).status, 400);
  assert.equal((await post('nope', { rows: [{ item: 'Desktop' }] })).status, 404);
});

test('rows are trimmed to the four columns', () => {
  assert.deepEqual(cleanRows([{ item: ' Desktop ', make: 'Dell', model: 'X', serial: 'S1', extra: 'ignored' }, {}]),
    [{ item: 'Desktop', make: 'Dell', model: 'X', serial: 'S1' }]);
});

// Settings → Disk usage: measures the database, uploaded files (by job/project,
// type and left-over files) and is admin only.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const express = require('express');
const { freshDb, startTestServer, registerUser } = require('./helpers');

let client, server, db, admin, user;

before(async () => {
  ({ db } = freshDb());
  const app = express();
  app.use(express.json());
  app.use('/api/auth', require('../routes/auth'));
  app.use('/api/backup', require('../routes/backup'));
  client = await startTestServer(app);
  server = client.server;
  admin = await registerUser(client, { name: 'Admin Person', email: 'admin@example.com' });
  user = await registerUser(client, { name: 'Plain User', email: 'user@example.com' });
  db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(admin.id);
  db.prepare("UPDATE users SET role = 'user' WHERE id = ?").run(user.id);

  const dir = process.env.UPLOAD_DIR;
  fs.mkdirSync(dir, { recursive: true });
  db.prepare("INSERT INTO jobs (id, job_number, contact_name, subject) VALUES ('j1', 50, 'Pat', 'Laptop audit')").run();
  fs.writeFileSync(path.join(dir, 'photo-1.jpg'), Buffer.alloc(300000));
  fs.writeFileSync(path.join(dir, 'sheet-1.xlsx'), Buffer.alloc(20000));
  fs.writeFileSync(path.join(dir, 'orphan.jpg'), Buffer.alloc(50000));
  const att = db.prepare('INSERT INTO attachments (id, job_id, stored_name, original_name, mime_type, size) VALUES (?, ?, ?, ?, ?, ?)');
  att.run('a1', 'j1', 'photo-1.jpg', 'IMG_0001.jpg', 'image/jpeg', 300000);
  att.run('a2', 'j1', 'sheet-1.xlsx', 'Audit.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 20000);
});

after(() => server.close());

test('disk usage is admin only', async () => {
  const res = await client.get('/api/backup/disk-usage', { token: user.token });
  assert.equal(res.status, 403);
});

test('breaks uploads down by area, type, job and largest file', async () => {
  const res = await client.get('/api/backup/disk-usage', { token: admin.token });
  assert.equal(res.status, 200);
  const { uploads, database } = res.data;
  const area = Object.fromEntries(uploads.byArea.map((a) => [a.name, a]));
  assert.equal(area['Job attachments'].bytes, 320000);
  assert.equal(area['Job attachments'].files, 2);
  assert.equal(area['Not linked to anything (left over)'].bytes, 50000);
  const kind = Object.fromEntries(uploads.byKind.map((k) => [k.name, k.bytes]));
  assert.equal(kind['Photos / images'], 350000);
  assert.equal(kind.Spreadsheets, 20000);
  assert.equal(uploads.topOwners[0].owner, 'Job #50 — Laptop audit');
  assert.equal(uploads.topOwners[0].bytes, 320000);
  assert.equal(uploads.largestFiles[0].name, 'IMG_0001.jpg');
  assert.ok(database.file > 0);
  assert.ok(Array.isArray(database.tables) && database.tables.some((t) => t.table === 'jobs'));
});

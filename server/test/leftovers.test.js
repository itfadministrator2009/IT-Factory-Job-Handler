// Settings → Disk usage: the Super Admin can remove left-over files no job or
// project uses — on the Render disk and in Cloudflare R2 — with safety rules.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');
const express = require('express');
const { freshDb, startTestServer, registerUser } = require('./helpers');

let client, server, db, ana, sam, fileStore, bucket;
const dir = () => process.env.UPLOAD_DIR;
const name = (ext = '.jpg') => `${crypto.randomUUID()}${ext}`;
const old = (p) => { const t = new Date(Date.now() - 3 * 86400000); fs.utimesSync(p, t, t); };
const file = (n, { age = 'old', bytes = 1000 } = {}) => { const p = path.join(dir(), n); fs.writeFileSync(p, Buffer.alloc(bytes, 1)); if (age === 'old') old(p); return p; };

before(async () => {
  ({ db } = freshDb());
  require('../email').sendMail = async () => {};
  require('../recordRestore'); // creates the restore log table
  fileStore = require('../fileStore');
  bucket = new Map();
  fileStore._setBackend({
    async put(n, p) { bucket.set(n, fs.readFileSync(p)); },
    async head(n) { const b = bucket.get(n); return b ? { size: b.length } : null; },
    async get(n) { const b = bucket.get(n); return b ? { stream: Readable.from([b]), size: b.length } : null; },
    async del(n) { bucket.delete(n); },
  });
  const app = express();
  app.use(express.json());
  app.use('/api/auth', require('../routes/auth'));
  app.use('/api/backup', require('../routes/backup'));
  client = await startTestServer(app);
  server = client.server;
  ana = await registerUser(client, { name: 'Ana Admin', email: 'ana@itf.test' });
  sam = await registerUser(client, { name: 'Sam Second', email: 'sam@itf.test' });
  db.prepare("UPDATE users SET role = 'admin' WHERE id IN (?, ?)").run(ana.id, sam.id);
  db.prepare('UPDATE users SET super_admin = 1 WHERE id = ?').run(ana.id);
  db.prepare("INSERT INTO jobs (id, job_number, contact_name, subject) VALUES ('j1', 80, 'Pat', 'Leftovers')").run();
  fs.mkdirSync(dir(), { recursive: true });
});
after(() => { fileStore._setBackend(null); server.close(); });

test('only unused, day-old upload files go — on the disk and in R2', async () => {
  const used = name(); file(used);
  db.prepare("INSERT INTO attachments (id, job_id, stored_name, original_name, mime_type, size) VALUES ('a1', 'j1', ?, 'used.jpg', 'image/jpeg', 1000)").run(used);
  const unused = name('.pdf'); file(unused, { bytes: 5000 });
  const recent = name(); file(recent, { age: 'new' });
  const restorable = name(); file(restorable);
  db.prepare("INSERT INTO record_restore_log (id, type, record_id, before_json) VALUES ('r1', 'job', 'j9', ?)").run(JSON.stringify({ children: { attachments: [{ stored_name: restorable }] } }));
  file('stray.bin'); file('helpdesk-copy.db');
  // In R2 only: one unused, one used.
  const cloudUnused = name(); bucket.set(cloudUnused, Buffer.alloc(7000));
  db.prepare("INSERT INTO cloud_files (name, size, stored_at) VALUES (?, 7000, datetime('now', '-3 days'))").run(cloudUnused);
  const cloudUsed = name(); bucket.set(cloudUsed, Buffer.alloc(10));
  db.prepare("INSERT INTO cloud_files (name, size, stored_at) VALUES (?, 10, datetime('now', '-3 days'))").run(cloudUsed);
  db.prepare("INSERT INTO attachments (id, job_id, stored_name, original_name, mime_type, size) VALUES ('a2', 'j1', ?, 'cloud.jpg', 'image/jpeg', 10)").run(cloudUsed);

  const usage = await client.get('/api/backup/disk-usage', { token: ana.token });
  assert.deepEqual(usage.data.leftovers, { files: 2, bytes: 12000 });

  // Only the Super Admin can remove them.
  assert.equal((await client.post('/api/backup/leftovers/clean', { token: sam.token })).status, 403);
  const r = await client.post('/api/backup/leftovers/clean', { token: ana.token });
  assert.deepEqual(r.data, { removed: 2, bytes: 12000 });
  await new Promise((ok) => setTimeout(ok, 50));

  const exists = (n) => fs.existsSync(path.join(dir(), n));
  assert.equal(exists(unused), false);
  assert.equal(bucket.has(cloudUnused), false);
  assert.equal(db.prepare('SELECT 1 FROM cloud_files WHERE name = ?').get(cloudUnused), undefined);
  [used, recent, restorable, 'stray.bin', 'helpdesk-copy.db'].forEach((n) => assert.ok(exists(n), `${n} kept`));
  assert.ok(bucket.has(cloudUsed));
  const log = db.prepare("SELECT details FROM activity_log WHERE action = 'files.leftovers_removed'").get();
  assert.match(log.details, /Removed 2 left-over files/);
  assert.deepEqual((await client.get('/api/backup/disk-usage', { token: ana.token })).data.leftovers, { files: 0, bytes: 0 });
});

// Uploaded files move to Cloudflare R2 when it's set up: new uploads are copied
// straight away, older files in the background, and the disk copy is only removed
// once R2 holds the whole file. Files are still served through Work Desk.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const express = require('express');
const { freshDb, startTestServer, registerUser } = require('./helpers');

let client, server, db, admin, fileStore, bucket, fake;
const dir = () => process.env.UPLOAD_DIR;
const base = () => client.baseUrl || `http://127.0.0.1:${server.address().port}`;
const wait = (ms = 60) => new Promise((r) => setTimeout(r, ms));

// A stand-in for R2 that keeps objects in memory.
function fakeR2() {
  bucket = new Map();
  return {
    shortBy: 0, down: false,
    async put(name, filePath) { if (this.down) throw new Error('R2 unreachable'); bucket.set(name, fs.readFileSync(filePath)); },
    async head(name) { const b = bucket.get(name); return b ? { size: b.length - this.shortBy } : null; },
    async get(name) { if (this.down) throw new Error('R2 unreachable'); const b = bucket.get(name); return b ? { stream: Readable.from([b]), size: b.length, contentType: 'image/png' } : null; },
    async del(name) { bucket.delete(name); },
  };
}

before(async () => {
  ({ db } = freshDb());
  require('../email').sendMail = async () => {};
  fileStore = require('../fileStore');
  fake = fakeR2();
  fileStore._setBackend(fake);
  const app = express();
  app.use(express.json());
  app.use('/api/auth', require('../routes/auth'));
  app.use('/api', require('../routes/attachments'));
  app.use('/api/backup', require('../routes/backup'));
  client = await startTestServer(app);
  server = client.server;
  admin = await registerUser(client, { name: 'Admin Person', email: 'admin@example.com' });
  db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(admin.id);
  db.prepare("INSERT INTO jobs (id, job_number, contact_name, subject, owner_id) VALUES ('j1', 70, 'Pat', 'Cloud', ?)").run(admin.id);
  fs.mkdirSync(dir(), { recursive: true });
});

after(() => { fileStore._setBackend(null); server.close(); });

async function upload(buf, name, type) {
  const form = new FormData();
  form.append('files', new Blob([buf], { type }), name);
  const res = await fetch(`${base()}/api/jobs/j1/attachments`, { method: 'POST', headers: { Authorization: `Bearer ${admin.token}` }, body: form });
  return res.json();
}
const download = (id) => fetch(`${base()}/api/attachments/${id}/download`, { headers: { Authorization: `Bearer ${admin.token}` } });

test('a new upload is copied to R2 straight away and still opens after the disk copy is removed', async () => {
  const pdf = Buffer.from('%PDF-1.4 hello');
  const { attachments } = await upload(pdf, 'audit.pdf', 'application/pdf');
  await wait();
  const row = db.prepare('SELECT stored_name FROM attachments WHERE id = ?').get(attachments[0].id);
  assert.deepEqual(bucket.get(row.stored_name), pdf);
  assert.ok(fs.existsSync(path.join(dir(), row.stored_name)), 'recent files stay on the disk for an hour');

  // An hour later the disk copy is tidied away…
  assert.equal(fileStore.sweepLocal({ olderThanMs: 0 }), 1);
  assert.equal(fs.existsSync(path.join(dir(), row.stored_name)), false);
  // …and the file still downloads, from R2, with its name.
  const res = await download(attachments[0].id);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition'), /audit\.pdf/);
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), pdf);
  // A signed-out request still gets nothing.
  assert.equal((await fetch(`${base()}/api/attachments/${attachments[0].id}/download`)).status, 401);
});

test('files already on the disk are copied across in the background', async () => {
  fs.writeFileSync(path.join(dir(), 'old-1.jpg'), Buffer.alloc(5000, 7));
  db.prepare("INSERT INTO attachments (id, job_id, stored_name, original_name, mime_type, size) VALUES ('old1', 'j1', 'old-1.jpg', 'old.jpg', 'image/jpeg', 5000)").run();
  // A stray file nothing points at is left alone.
  fs.writeFileSync(path.join(dir(), 'stray.bin'), Buffer.alloc(10));
  assert.ok(fileStore.status().waiting >= 1);
  const r = await fileStore.syncAll({ olderThanMs: 0 });
  assert.equal(r.failed, 0);
  assert.ok(bucket.has('old-1.jpg'));
  assert.equal(bucket.has('stray.bin'), false);
  assert.equal(fs.existsSync(path.join(dir(), 'old-1.jpg')), false);
  assert.ok(fs.existsSync(path.join(dir(), 'stray.bin')));
  assert.equal(fileStore.status().waiting, 0);
  // The PDF builders read it back from R2.
  assert.equal((await fileStore.readBuffer('old-1.jpg')).length, 5000);
  // Shown in Settings → Disk usage, and not counted as missing.
  const usage = await client.get('/api/backup/disk-usage', { token: admin.token });
  assert.equal(usage.data.cloud.enabled, true);
  assert.ok(usage.data.cloud.files >= 2);
  assert.equal(usage.data.uploads.missingFiles, 0);
});

test('the disk copy is kept if R2 does not have the whole file, or R2 is down', async () => {
  fs.writeFileSync(path.join(dir(), 'part.jpg'), Buffer.alloc(3000, 1));
  db.prepare("INSERT INTO attachments (id, job_id, stored_name, original_name, mime_type, size) VALUES ('p1', 'j1', 'part.jpg', 'part.jpg', 'image/jpeg', 3000)").run();
  fake.shortBy = 1;
  let r = await fileStore.syncAll({ olderThanMs: 0 });
  assert.equal(r.failed, 1);
  assert.ok(fs.existsSync(path.join(dir(), 'part.jpg')));
  assert.match(fileStore.status().lastError.message, /expected 3000/);
  fake.shortBy = 0; fake.down = true;
  r = await fileStore.syncAll({ olderThanMs: 0 });
  assert.equal(r.failed, 1);
  assert.ok(fs.existsSync(path.join(dir(), 'part.jpg')));
  fake.down = false;
  r = await fileStore.syncAll({ olderThanMs: 0 });
  assert.equal(r.failed, 0);
  assert.equal(fs.existsSync(path.join(dir(), 'part.jpg')), false);
  assert.equal(fileStore.status().lastError, null);
});

test('deleting an attachment deletes it from R2 too', async () => {
  const res = await client.delete('/api/attachments/old1', { token: admin.token });
  assert.equal(res.status, 200);
  await wait();
  assert.equal(bucket.has('old-1.jpg'), false);
  assert.equal(db.prepare("SELECT 1 FROM cloud_files WHERE name = 'old-1.jpg'").get(), undefined);
});

test('the photo backup zip includes files that are only in R2', async () => {
  const { zipDirectoryToFile } = require('../backup');
  const out = path.join(os.tmpdir(), `cloud-zip-${process.pid}.zip`);
  const cloudOnly = fileStore.cloudNames().filter((n) => !fs.existsSync(path.join(dir(), n)));
  assert.ok(cloudOnly.length >= 2);
  await zipDirectoryToFile(dir(), out, cloudOnly);
  const zip = fs.readFileSync(out).toString('latin1');
  cloudOnly.forEach((n) => assert.ok(zip.includes(n), `${n} in the zip`));
  assert.ok(zip.includes('stray.bin'));
  fs.unlinkSync(out);
});

test('without R2 set up, files stay on the disk as before', async () => {
  fileStore._setBackend(null);
  try {
    const { attachments } = await upload(Buffer.from('plain'), 'note.txt', 'text/plain');
    await wait();
    const row = db.prepare('SELECT stored_name FROM attachments WHERE id = ?').get(attachments[0].id);
    assert.equal(bucket.has(row.stored_name), false);
    assert.equal(fileStore.sweepLocal({ olderThanMs: 0 }), 0);
    const res = await download(attachments[0].id);
    assert.equal(await res.text(), 'plain');
  } finally { fileStore._setBackend(fake); }
});

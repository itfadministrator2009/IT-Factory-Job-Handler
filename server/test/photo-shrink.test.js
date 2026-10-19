// Photos are shrunk to fit 1600 px when uploaded, and an admin can shrink the
// photos already stored. Non-photos and small photos are left untouched.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const express = require('express');
const sharp = require('sharp');
const { freshDb, startTestServer, registerUser } = require('./helpers');

let client, server, db, admin, user, bigJpeg;
const dir = () => process.env.UPLOAD_DIR;

// A noisy 4000×3000 photo-like JPEG (several MB, like a phone photo).
async function makePhoto(width = 4000, height = 3000) {
  const raw = Buffer.alloc(width * height * 3);
  for (let i = 0; i < raw.length; i += 1) raw[i] = (i * 2654435761) >>> 24;
  return sharp(raw, { raw: { width, height, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();
}

before(async () => {
  ({ db } = freshDb());
  bigJpeg = await makePhoto();
  const app = express();
  app.use(express.json());
  app.use('/api/auth', require('../routes/auth'));
  app.use('/api', require('../routes/attachments'));
  app.use('/api/backup', require('../routes/backup'));
  client = await startTestServer(app);
  server = client.server;
  admin = await registerUser(client, { name: 'Admin Person', email: 'admin@example.com' });
  user = await registerUser(client, { name: 'Plain User', email: 'user@example.com' });
  db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(admin.id);
  db.prepare("UPDATE users SET role = 'user' WHERE id = ?").run(user.id);
  db.prepare("INSERT INTO jobs (id, job_number, contact_name, subject, owner_id) VALUES ('j1', 60, 'Pat', 'Photos', ?)").run(admin.id);
  fs.mkdirSync(dir(), { recursive: true });
});

after(() => server.close());

async function upload(files) {
  const form = new FormData();
  files.forEach(({ buf, name, type }) => form.append('files', new Blob([buf], { type }), name));
  const res = await fetch(`${client.baseUrl || `http://127.0.0.1:${server.address().port}`}/api/jobs/j1/attachments`, {
    method: 'POST', headers: { Authorization: `Bearer ${admin.token}` }, body: form,
  });
  return { status: res.status, data: await res.json() };
}

test('an uploaded phone photo is shrunk to fit 1600 px; a PDF is left alone', async () => {
  assert.ok(bigJpeg.length > 1024 * 1024, 'test photo should be over 1 MB');
  const pdf = Buffer.from('%PDF-1.4\n' + 'x'.repeat(600 * 1024));
  const res = await upload([
    { buf: bigJpeg, name: 'IMG_0001.JPG', type: 'image/jpeg' },
    { buf: pdf, name: 'audit.pdf', type: 'application/pdf' },
  ]);
  assert.equal(res.status, 201);
  const rows = db.prepare('SELECT * FROM attachments ORDER BY original_name').all();
  const photo = rows.find((r) => r.original_name === 'IMG_0001.JPG');
  const doc = rows.find((r) => r.original_name === 'audit.pdf');
  const meta = await sharp(path.join(dir(), photo.stored_name)).metadata();
  assert.ok(Math.max(meta.width, meta.height) <= 1600);
  assert.ok(photo.size < bigJpeg.length / 3, `photo should be much smaller (${photo.size} vs ${bigJpeg.length})`);
  assert.equal(photo.size, fs.statSync(path.join(dir(), photo.stored_name)).size);
  assert.equal(doc.size, pdf.length);
  assert.equal(fs.statSync(path.join(dir(), doc.stored_name)).size, pdf.length);
});

test('admin can shrink photos already stored; users cannot', async () => {
  // A full-size photo stored before shrinking existed.
  fs.writeFileSync(path.join(dir(), 'old-photo.jpg'), bigJpeg);
  db.prepare("INSERT INTO attachments (id, job_id, stored_name, original_name, mime_type, size) VALUES ('old1', 'j1', 'old-photo.jpg', 'old.jpg', 'image/jpeg', ?)").run(bigJpeg.length);

  const denied = await client.post('/api/backup/shrink-photos', { token: user.token });
  assert.equal(denied.status, 403);

  const started = await client.post('/api/backup/shrink-photos', { token: admin.token });
  assert.equal(started.status, 202);
  let status;
  for (let i = 0; i < 100; i += 1) {
    status = (await client.get('/api/backup/shrink-photos', { token: admin.token })).data;
    if (!status.running) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(status.running, false);
  assert.ok(status.shrunk >= 1);
  assert.ok(status.after < status.before);
  const row = db.prepare("SELECT * FROM attachments WHERE id = 'old1'").get();
  assert.ok(row.size < bigJpeg.length / 3);
  const meta = await sharp(path.join(dir(), row.stored_name)).metadata();
  assert.ok(Math.max(meta.width, meta.height) <= 1600);
});

test('a file that is not really an image is left exactly as it was', async () => {
  const { shrinkFile } = require('../photoShrink');
  const p = path.join(dir(), 'fake.jpg');
  const junk = Buffer.alloc(700 * 1024, 7);
  fs.writeFileSync(p, junk);
  assert.equal(await shrinkFile(p, { mime: 'image/jpeg' }), null);
  assert.deepEqual(fs.readFileSync(p), junk);
});

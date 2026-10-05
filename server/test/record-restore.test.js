// Settings → Backup → Restore individual records: bring back one job, asset or
// Storage Centre item from a backup without rolling back anything else.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const { freshDb, startTestServer, registerUser } = require('./helpers');

let client, server, db, admin, staff, base, uploadId;

async function uploadBackup(buffer, token = admin.token) {
  const res = await fetch(`${base}/api/record-restore/upload?name=test-backup.db`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', Authorization: `Bearer ${token}` },
    body: buffer,
  });
  return { status: res.status, data: await res.json() };
}
const src = () => ({ source: 'upload', uploadId });
const search = (type, extra = {}) => client.post('/api/record-restore/search', { token: admin.token, body: { ...src(), type, ...extra } });
const restore = (type, ids) => client.post('/api/record-restore/restore', { token: admin.token, body: { ...src(), type, ids } });

before(async () => {
  ({ db } = freshDb());
  const app = express();
  app.use(express.json());
  app.use('/api/auth', require('../routes/auth'));
  app.use('/api/record-restore', require('../routes/recordRestore'));
  client = await startTestServer(app);
  server = client.server;
  base = `http://127.0.0.1:${server.address().port}`;
  admin = await registerUser(client, { name: 'Admin Person', email: 'admin@example.com' });
  db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(admin.id);
  staff = await registerUser(client, { name: 'Staff Person', email: 'staff@example.com' });
  db.prepare("UPDATE users SET role = 'user' WHERE id = ?").run(staff.id);

  // Some records, as they were on the night of the backup.
  db.prepare("INSERT INTO jobs (id, job_number, contact_name, account_name, subject, status, created_by) VALUES ('j1', 101, 'Sam', 'Acme', 'Printer install', 'Open', ?)").run(admin.id);
  db.prepare("INSERT INTO jobs (id, job_number, contact_name, subject) VALUES ('j2', 102, 'Pat', 'Laptop swap')").run();
  db.prepare("INSERT INTO job_items (id, job_id, description, qty) VALUES ('ji1', 'j1', 'HP M404', 2)").run();
  db.prepare("INSERT INTO job_notes (id, job_id, author_id, body) VALUES ('jn1', 'j1', ?, 'Booked for Monday')").run(admin.id);
  db.prepare(`INSERT INTO assets (id, fields_json) VALUES ('a1', '{"asset_tag":"ITF-0001","manufacturer":"Dell","model_name":"Latitude 5440","serial_number":"ABC123","status":"In stock"}')`).run();
  db.prepare("INSERT INTO storage_items (id, client, item, serial, storage_centre, location) VALUES ('s1', 'Viridian', 'Monitor', 'MON-1', 'Sydney', 'P1')").run();
  db.prepare("INSERT INTO storage_items (id, client, item, serial) VALUES ('s2', 'Viridian', 'Dock', 'DOCK-1')").run();
  db.prepare("INSERT INTO storage_item_notes (id, item_key, note) VALUES ('n1', 'item:s1', 'Screen scratched')").run();
  db.prepare("INSERT INTO projects (id, name, template_json) VALUES ('p1', 'Harvey Norman rollout', '{}')").run();
  db.prepare("INSERT INTO project_entries (id, project_id, entry_number) VALUES ('pe1', 'p1', 1)").run();

  const file = path.join(os.tmpdir(), `record-restore-test-${process.pid}.db`);
  await db.backup(file);
  const buffer = fs.readFileSync(file);
  fs.unlinkSync(file);

  // Since then: a job deleted, an asset and an item edited, an item deleted, a new job added.
  db.prepare("DELETE FROM jobs WHERE id = 'j1'").run();
  db.prepare(`UPDATE assets SET fields_json = '{"asset_tag":"ITF-0001","manufacturer":"Dell","model_name":"Latitude 5440","serial_number":"ABC123","status":"Disposed"}' WHERE id = 'a1'`).run();
  db.prepare("UPDATE storage_items SET location = 'P9' WHERE id = 's1'").run();
  db.prepare("DELETE FROM storage_items WHERE id = 's2'").run();
  db.prepare("DELETE FROM storage_item_notes WHERE id = 'n1'").run();
  db.prepare("INSERT INTO jobs (id, job_number, contact_name, subject) VALUES ('j3', 103, 'Lee', 'New since backup')").run();

  const up = await uploadBackup(buffer);
  assert.equal(up.status, 200, JSON.stringify(up.data));
  uploadId = up.data.uploadId;
});

after(() => server.close());

test('only admins can use it, and a non-database file is refused', async () => {
  assert.equal((await client.get('/api/record-restore/sources', { token: staff.token })).status, 403);
  assert.equal((await uploadBackup(Buffer.from('hello'), staff.token)).status, 403);
  const bad = await uploadBackup(Buffer.from('x'.repeat(200)));
  assert.equal(bad.status, 400);
  const sources = await client.get('/api/record-restore/sources', { token: admin.token });
  assert.equal(sources.status, 200);
  const sections = new Set(sources.data.types.map((t) => t.section));
  assert.deepEqual([...sections], ['ITF Work Desk', 'ITF Asset Tracker', 'ITF Storage Centre']);
});

test('search lists what was deleted or changed since the backup', async () => {
  const jobs = await search('job');
  assert.equal(jobs.status, 200);
  assert.deepEqual(jobs.data.records.map((r) => [r.id, r.status]), [['j1', 'deleted']]);
  assert.match(jobs.data.records[0].title, /#101 — Printer install/);

  const all = await search('job', { show: 'all' });
  assert.deepEqual(all.data.records.map((r) => r.status).sort(), ['deleted', 'same']);

  const assets = await search('asset');
  assert.equal(assets.data.records[0].status, 'changed');
  assert.deepEqual(assets.data.records[0].changed, ['fields_json']);
  assert.match(assets.data.records[0].title, /Tag ITF-0001/);

  const items = await search('storage_item', { q: 'mon-1' });
  assert.deepEqual(items.data.records.map((r) => [r.id, r.status, r.changed]), [['s1', 'changed', ['location']]]);
});

test('restoring a deleted job brings back its line items and notes, and nothing else changes', async () => {
  const r = await restore('job', ['j1']);
  assert.equal(r.status, 200);
  assert.equal(r.data.restored, 1);
  assert.equal(r.data.results[0].wasDeleted, true);
  assert.deepEqual(r.data.results[0].counts, { 'line items': 1, notes: 1 });
  assert.equal(db.prepare("SELECT subject FROM jobs WHERE id = 'j1'").get().subject, 'Printer install');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM job_items WHERE job_id = 'j1'").get().n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM job_notes WHERE job_id = 'j1'").get().n, 1);
  // The job added after the backup is untouched.
  assert.ok(db.prepare("SELECT 1 FROM jobs WHERE id = 'j3'").get());
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
});

test('restoring an edited asset and storage item puts the old values back, then undo reverses it', async () => {
  assert.equal((await restore('asset', ['a1'])).data.restored, 1);
  assert.match(db.prepare("SELECT fields_json FROM assets WHERE id = 'a1'").get().fields_json, /In stock/);

  const r = await restore('storage_item', ['s1', 's2']);
  assert.equal(r.data.restored, 2);
  assert.equal(db.prepare("SELECT location FROM storage_items WHERE id = 's1'").get().location, 'P1');
  assert.ok(db.prepare("SELECT 1 FROM storage_items WHERE id = 's2'").get());
  assert.equal(db.prepare("SELECT note FROM storage_item_notes WHERE item_key = 'item:s1'").get().note, 'Screen scratched');

  const log = (await client.get('/api/record-restore/log', { token: admin.token })).data.restores;
  const s1 = log.find((l) => l.record_id === 's1');
  const s2 = log.find((l) => l.record_id === 's2');
  assert.equal(s2.wasDeleted, true);

  assert.equal((await client.post(`/api/record-restore/log/${s1.id}/undo`, { token: admin.token })).status, 200);
  assert.equal(db.prepare("SELECT location FROM storage_items WHERE id = 's1'").get().location, 'P9');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM storage_item_notes WHERE item_key = 'item:s1'").get().n, 0);
  // Undoing a restore of a deleted record removes it again.
  await client.post(`/api/record-restore/log/${s2.id}/undo`, { token: admin.token });
  assert.equal(db.prepare("SELECT 1 FROM storage_items WHERE id = 's2'").get(), undefined);
  // Can't undo twice.
  assert.equal((await client.post(`/api/record-restore/log/${s1.id}/undo`, { token: admin.token })).status, 400);
});

test('an entry whose project is gone is refused, but restoring the whole project works', async () => {
  db.prepare("DELETE FROM projects WHERE id = 'p1'").run();
  const entry = await restore('project_entry', ['pe1']);
  assert.equal(entry.data.restored, 0);
  assert.match(entry.data.results[0].error, /project no longer exists/);

  const proj = await restore('project', ['p1']);
  assert.equal(proj.data.restored, 1);
  assert.deepEqual(proj.data.results[0].counts, { entries: 1 });
  assert.ok(db.prepare("SELECT 1 FROM project_entries WHERE id = 'pe1'").get());
});

test('an unknown record id or type is reported, not crashed on', async () => {
  const r = await restore('job', ['nope']);
  assert.equal(r.data.restored, 0);
  assert.match(r.data.results[0].error, /Not in this backup/);
  assert.equal((await restore('bogus', ['j1'])).status, 400);
  const expired = await client.post('/api/record-restore/search', { token: admin.token, body: { source: 'upload', uploadId: 'upload:missing', type: 'job' } });
  assert.equal(expired.status, 400);
});

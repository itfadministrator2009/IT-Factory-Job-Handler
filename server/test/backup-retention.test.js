// Old OneDrive backups: photo zips kept nightly for 30 days and data files for a
// year, then the first backup of each month is kept for good. Nothing else is touched.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb } = require('./helpers');

let backup;
const realFetch = global.fetch;
before(() => { freshDb(); backup = require('../backup'); });
after(() => { global.fetch = realFetch; });

// Every night from 2025-06-01 to 2026-10-25, all four files, plus some others.
function folder() {
  const files = [];
  for (let t = Date.parse('2025-06-01T00:00:00Z'); t <= Date.parse('2026-10-25T00:00:00Z'); t += 86400000) {
    const d = new Date(t).toISOString().slice(0, 10);
    files.push({ id: `db-${d}`, name: `helpdesk-backup-${d}.db`, size: 16e6 });
    files.push({ id: `ph-${d}`, name: `helpdesk-uploads-${d}.zip`, size: 1.9e9 });
    files.push({ id: `sc-${d}`, name: `storage-centre-${d}.zip`, size: 1e5 });
    files.push({ id: `tc-${d}`, name: `time-card-${d}.zip`, size: 5e4 });
  }
  files.push({ id: 'safety', name: 'pre-restore-safety-2025-07-03T01-02-03-000Z.db', size: 16e6 });
  files.push({ id: 'safety-photos', name: 'pre-restore-safety-2025-07-03T01-02-03-000Z-uploads.zip', size: 1.9e9 });
  files.push({ id: 'mine', name: 'notes.txt', size: 10 });
  return files;
}

test('photo zips: every night for 30 days, then the first of each month', () => {
  const gone = new Set(backup.planPrune(folder(), '2026-10-25').map((f) => f.name));
  const kept = (n) => !gone.has(n);
  assert.ok(kept('helpdesk-uploads-2026-10-25.zip'));
  assert.ok(kept('helpdesk-uploads-2026-09-25.zip'), '30 days ago is kept');
  assert.ok(!kept('helpdesk-uploads-2026-09-24.zip'), '31 days ago goes');
  assert.ok(kept('helpdesk-uploads-2026-09-01.zip'), 'first of the month stays');
  assert.ok(kept('helpdesk-uploads-2025-06-01.zip'));
  assert.ok(!kept('helpdesk-uploads-2025-06-02.zip'));
  // 31 recent + one per older month (Jun 2025 – Sep 2026 = 16).
  const left = folder().filter((f) => f.name.startsWith('helpdesk-uploads-') && kept(f.name)).length;
  assert.equal(left, 31 + 16);
});

test('database and spreadsheets: every night for a year, then the first of each month', () => {
  const gone = new Set(backup.planPrune(folder(), '2026-10-25').map((f) => f.name));
  assert.ok(!gone.has('helpdesk-backup-2025-10-25.db'), 'a year ago is kept');
  assert.ok(gone.has('helpdesk-backup-2025-10-24.db'));
  assert.ok(!gone.has('helpdesk-backup-2025-07-01.db'));
  assert.ok(gone.has('storage-centre-2025-07-15.zip'));
  assert.ok(!gone.has('time-card-2025-09-01.zip'));
  // Safety copies and other files are never touched.
  ['pre-restore-safety-2025-07-03T01-02-03-000Z.db', 'pre-restore-safety-2025-07-03T01-02-03-000Z-uploads.zip', 'notes.txt'].forEach((n) => assert.ok(!gone.has(n), n));
});

test('tidying deletes only the planned files, and only when tonight\'s backup is there', async () => {
  const deleted = [];
  let files = folder();
  global.fetch = async (url, opts = {}) => {
    if (opts.method === 'DELETE') { deleted.push(decodeURIComponent(url.split('/items/')[1])); return new Response(null, { status: 204 }); }
    // Two pages, like OneDrive.
    if (url.includes('page2')) return Response.json({ value: files.slice(1000) });
    return Response.json({ value: files.slice(0, 1000), '@odata.nextLink': 'https://graph.microsoft.com/page2' });
  };
  const r = await backup.pruneOldBackups('2026-10-25');
  const planned = backup.planPrune(folder(), '2026-10-25').map((f) => f.id).sort();
  assert.deepEqual(deleted.sort(), planned);
  assert.equal(r.removed, planned.length);
  assert.ok(r.bytes > 500e9, 'frees hundreds of GB of old photo zips');

  // Tonight's backup missing: nothing is deleted.
  deleted.length = 0;
  files = folder().filter((f) => f.name !== 'helpdesk-backup-2026-10-25.db');
  const r2 = await backup.pruneOldBackups('2026-10-25');
  assert.equal(r2.removed, 0);
  assert.equal(deleted.length, 0);
});

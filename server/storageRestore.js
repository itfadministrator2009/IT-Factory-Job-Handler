// Storage Centre restore — the old app's "Restore Backup", which put back the
// Storage Centre data only. Here that means the Storage Centre tables are
// replaced from a Storage Centre backup zip (the CSV export the nightly backup
// uploads and the Reports page's "Download backup" button produces). Jobs,
// projects, users and everything else in Work Desk are left alone.
//
// Every restore first saves the current Storage Centre data as a "restore
// point" kept in the database, so a restore can itself be undone.
// Client portal logins survive a restore: the export has no password hashes, so
// a restored client keeps the current password when its username is unchanged.
const { randomUUID } = require('crypto');
const { db } = require('./db');
const { buildStorageCentreZip } = require('./storageExport');
const { readZip, parseCsv } = require('./zipRead');

db.exec(`CREATE TABLE IF NOT EXISTS storage_restore_points (
  id TEXT PRIMARY KEY,
  reason TEXT,
  created_by TEXT,
  counts TEXT,
  zip BLOB NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`);

const KEEP_POINTS = 10;

const FILES = [
  { file: 'items.csv', table: 'storage_items', label: 'Items' },
  { file: 'item-notes.csv', table: 'storage_item_notes', label: 'Item notes' },
  { file: 'pallets.csv', table: 'storage_pallets', label: 'Pallet rates' },
  { file: 'clients.csv', table: 'storage_clients', label: 'Clients' },
  { file: 'orders.csv', table: 'storage_orders', label: 'Orders' },
  { file: 'receiving-dispatch.csv', table: 'storage_receiving_dispatch', label: 'Receiving / dispatch' },
  { file: 'locations.csv', table: 'storage_locations_registry', label: 'Location classifications' },
];

const normLocation = (s) => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();
const countRows = (table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;

function openBackup(buffer) {
  let files;
  try { files = readZip(buffer); } catch (err) { throw new Error(`That file isn't a Storage Centre backup zip (${err.message}).`); }
  if (!files['items.csv']) throw new Error("That zip has no items.csv, so it isn't a Storage Centre backup.");
  const tables = {};
  FILES.forEach(({ file }) => { if (files[file]) tables[file] = parseCsv(files[file].toString('utf8')); });
  if (tables['items.csv'].length && !('id' in tables['items.csv'][0])) throw new Error('items.csv in that zip is missing its id column.');
  const readme = files['README.txt'] ? files['README.txt'].toString('utf8') : '';
  const created = readme.match(/Created:\s*(\S+)/);
  return { tables, exportedAt: created ? created[1] : null };
}

// What a restore would change, without changing anything.
function inspect(buffer) {
  const { tables, exportedAt } = openBackup(buffer);
  return {
    exportedAt,
    tables: FILES.map(({ file, table, label }) => ({
      file, label, inBackup: file in tables, backupRows: tables[file]?.length ?? null, currentRows: countRows(table),
    })),
  };
}

async function saveRestorePoint(reason, by) {
  const { buffer, counts } = await buildStorageCentreZip();
  const id = randomUUID();
  db.prepare('INSERT INTO storage_restore_points (id, reason, created_by, counts, zip) VALUES (?, ?, ?, ?, ?)')
    .run(id, reason, by || null, JSON.stringify(counts), buffer);
  const old = db.prepare('SELECT id FROM storage_restore_points ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET ?').all(KEEP_POINTS);
  old.forEach((r) => db.prepare('DELETE FROM storage_restore_points WHERE id = ?').run(r.id));
  return id;
}

function listRestorePoints() {
  return db.prepare('SELECT id, reason, created_by, counts, created_at, length(zip) AS size FROM storage_restore_points ORDER BY created_at DESC, rowid DESC').all()
    .map((r) => ({ id: r.id, reason: r.reason, createdBy: r.created_by, createdAt: r.created_at, size: r.size, counts: JSON.parse(r.counts || '{}') }));
}

function restorePointZip(id) {
  return db.prepare('SELECT zip FROM storage_restore_points WHERE id = ?').get(id)?.zip || null;
}

function insertRows(table, rows, fix) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  const known = new Set(cols.map((c) => c.name));
  const keepDefault = new Set(cols.filter((c) => c.notnull && c.dflt_value != null).map((c) => c.name));
  let n = 0;
  rows.forEach((raw) => {
    const row = {};
    Object.entries(raw).forEach(([k, v]) => { if (known.has(k)) row[k] = v === '' ? null : v; });
    if (fix) fix(row, raw);
    Object.keys(row).forEach((k) => { if (row[k] == null && keepDefault.has(k)) delete row[k]; });
    const keys = Object.keys(row);
    if (!keys.length) return;
    db.prepare(`INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).run(...keys.map((k) => row[k]));
    n += 1;
  });
  return n;
}

async function restore(buffer, { by, reason } = {}) {
  const { tables } = openBackup(buffer);
  const pointId = await saveRestorePoint(reason || 'Before restore', by);

  const logins = db.prepare('SELECT id, client_name, username, password_hash FROM storage_clients').all();
  const loginById = new Map(logins.map((c) => [c.id, c]));
  const loginByName = new Map(logins.map((c) => [String(c.client_name).trim().toLowerCase(), c]));

  const restored = {};
  db.transaction(() => {
    FILES.forEach(({ file, table }) => {
      if (!(file in tables)) return;
      db.prepare(`DELETE FROM ${table}`).run();
      let fix = null;
      if (table === 'storage_clients') {
        fix = (row) => {
          const prev = loginById.get(row.id) || loginByName.get(String(row.client_name || '').trim().toLowerCase());
          const sameUser = prev && prev.username && row.username && prev.username.toLowerCase() === String(row.username).toLowerCase();
          row.password_hash = sameUser ? prev.password_hash : null;
          if (!row.id) row.id = randomUUID();
        };
      } else if (table === 'storage_locations_registry') {
        fix = (row) => { row.id = randomUUID(); row.location_key = normLocation(row.location); };
      } else {
        fix = (row) => { if (!row.id) row.id = randomUUID(); };
      }
      restored[file] = insertRows(table, tables[file], fix);
    });
  })();
  return { restorePointId: pointId, restored };
}

module.exports = { inspect, restore, saveRestorePoint, listRestorePoints, restorePointZip, FILES };

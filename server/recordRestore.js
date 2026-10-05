// Restore individual records from a nightly backup (the helpdesk-backup-*.db files
// on OneDrive, or a .db file uploaded by hand) without rolling back anything else:
// one job, one asset, one Storage Centre item, and so on.
//
// Each record type below names its main table, how to label it, and its child
// rows (notes, line items, audit history…). Restoring a record replaces that
// record and its children with the backup's copy; nothing else is touched. The
// rows being replaced are kept in record_restore_log first, so every restore can
// be undone from the same screen.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const { db } = require('./db');

const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');

db.exec(`CREATE TABLE IF NOT EXISTS record_restore_log (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  record_id TEXT NOT NULL,
  label TEXT,
  backup_name TEXT,
  before_json TEXT,
  after_json TEXT,
  restored_by TEXT,
  restored_at TEXT NOT NULL DEFAULT (datetime('now')),
  undone_at TEXT,
  undone_by TEXT
)`);

const j = (s) => { try { return JSON.parse(s || '{}'); } catch (e) { return {}; } };
const dmy = (d) => { const m = String(d || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[3]}/${m[2]}/${m[1]}` : (d || ''); };
const join = (...parts) => parts.map((p) => (p == null ? '' : String(p).trim())).filter(Boolean).join(' · ');

// section: which part of the app (for grouping in the picker)
// children: rows that belong to the record; `where` uses ? for the record id and
// runs in both the backup and the live database.
const TYPES = {
  job: {
    section: 'ITF Work Desk', label: 'Job', table: 'jobs',
    order: 'job_number DESC',
    describe: (r) => ({ title: `#${r.job_number ?? '?'} — ${r.subject || ''}`, detail: join(r.account_name, r.contact_name, r.status, dmy(r.created_at)) }),
    search: (r) => [r.job_number, r.subject, r.account_name, r.contact_name, r.customer_reference, r.site_address],
    children: [
      { table: 'job_items', where: 'job_id = ?', label: 'line items' },
      { table: 'job_notes', where: 'job_id = ?', label: 'notes' },
      { table: 'attachments', where: 'job_id = ?', label: 'attachments', files: 'stored_name' },
      { table: 'job_audit', where: 'job_id = ?', label: 'history' },
    ],
    // The calendar event was removed when the job was deleted — don't point at it.
    fixRow: (row, existsNow) => (existsNow ? row : { ...row, ms_event_id: null }),
  },
  project: {
    section: 'ITF Work Desk', label: 'Project (with all its entries)', table: 'projects',
    order: 'created_at DESC',
    describe: (r) => ({ title: r.name, detail: join(r.description, dmy(r.created_at)) }),
    search: (r) => [r.name, r.description],
    children: [
      { table: 'project_assignments', where: 'project_id = ?', label: 'assignments' },
      { table: 'project_entries', where: 'project_id = ?', label: 'entries' },
      { table: 'project_entry_photos', where: 'entry_id IN (SELECT id FROM project_entries WHERE project_id = ?)', label: 'photos', files: 'stored_name' },
      { table: 'project_entry_audit', where: 'entry_id IN (SELECT id FROM project_entries WHERE project_id = ?)', label: 'history' },
    ],
  },
  project_entry: {
    section: 'ITF Work Desk', label: 'Project entry', table: 'project_entries',
    order: 'project_id, entry_number DESC',
    describe: (r, src) => {
      const p = src.prepare('SELECT name FROM projects WHERE id = ?').get(r.project_id);
      return { title: `${p?.name || 'Project'} — entry #${r.entry_number}${r.site_name ? ` ${r.site_name}` : ''}`, detail: join(r.status, dmy(r.created_at)) };
    },
    search: (r) => [r.entry_number, r.site_name, r.status, r.answers_json],
    children: [
      { table: 'project_entry_photos', where: 'entry_id = ?', label: 'photos', files: 'stored_name' },
      { table: 'project_entry_audit', where: 'entry_id = ?', label: 'history' },
    ],
    // An entry needs its project to exist.
    check: (r) => (db.prepare('SELECT 1 FROM projects WHERE id = ?').get(r.project_id) ? null : 'Its project no longer exists — restore the whole project instead.'),
  },
  article: {
    section: 'ITF Work Desk', label: 'Knowledge Base article', table: 'articles',
    order: 'updated_at DESC',
    describe: (r) => ({ title: r.title, detail: join(r.category, dmy(r.updated_at)) }),
    search: (r) => [r.title, r.category, r.body],
    check: (r) => (db.prepare('SELECT 1 FROM articles WHERE slug = ? AND id != ?').get(r.slug, r.id) ? `Another article now uses the address "${r.slug}".` : null),
  },
  template: {
    section: 'ITF Work Desk', label: 'Job template', table: 'job_templates',
    order: 'name',
    describe: (r) => ({ title: r.name, detail: dmy(r.created_at) }),
    search: (r) => [r.name],
  },
  asset: {
    section: 'ITF Asset Tracker', label: 'Asset', table: 'assets',
    order: 'created_at DESC',
    describe: (r) => {
      const f = j(r.fields_json);
      return {
        title: join(f.asset_tag && `Tag ${f.asset_tag}`, f.manufacturer, f.model_name || f.model_number, f.serial_number && `S/N ${f.serial_number}`) || r.id,
        detail: join(f.category, f.customer, f.status, dmy(r.created_at)),
      };
    },
    search: (r) => [r.fields_json],
    children: [{ table: 'asset_audit', where: 'asset_id = ?', label: 'history' }],
  },
  storage_item: {
    section: 'ITF Storage Centre', label: 'Manifest item', table: 'storage_items',
    order: 'client, serial',
    describe: (r) => ({
      title: join(r.client, r.item, [r.make, r.model].filter(Boolean).join(' '), r.serial && `S/N ${r.serial}`),
      detail: join(r.storage_centre, r.location, r.start_date && `in ${dmy(r.start_date)}`, r.end_date && `out ${dmy(r.end_date)}`),
    }),
    search: (r) => [r.client, r.item, r.make, r.model, r.serial, r.asset_tag, r.job_number, r.reference_number, r.po_number, r.order_number, r.location],
    children: [{ table: 'storage_item_notes', where: "item_key = 'item:' || ?", label: 'notes' }],
  },
  storage_pallet: {
    section: 'ITF Storage Centre', label: 'Pallet rate', table: 'storage_pallets',
    order: 'client, location',
    describe: (r) => ({ title: join(r.client, r.storage_centre, r.location), detail: join(r.price_week != null && `$${r.price_week}/wk`, r.start_date && `from ${dmy(r.start_date)}`, r.end_date && `to ${dmy(r.end_date)}`) }),
    search: (r) => [r.client, r.storage_centre, r.location, r.notes],
  },
  storage_order: {
    section: 'ITF Storage Centre', label: 'Client order', table: 'storage_orders',
    order: 'created_at DESC',
    describe: (r) => ({ title: join(r.order_number, r.client), detail: join(r.status, r.delivery_address, dmy(r.date_to_be_delivered)) }),
    search: (r) => [r.order_number, r.client, r.devices, r.delivery_address, r.site_contact_name, r.notes, r.requestor],
    check: (r) => (r.order_number && db.prepare('SELECT 1 FROM storage_orders WHERE order_number = ? AND id != ?').get(r.order_number, r.id) ? `Another order now uses number ${r.order_number}.` : null),
  },
  storage_client: {
    section: 'ITF Storage Centre', label: 'Client (portal login)', table: 'storage_clients',
    order: 'client_name',
    describe: (r) => ({ title: r.client_name, detail: join(r.username && `portal login ${r.username}`, dmy(r.created_at)) }),
    search: (r) => [r.client_name, r.username],
    check: (r) => {
      if (db.prepare('SELECT 1 FROM storage_clients WHERE lower(client_name) = lower(?) AND id != ?').get(r.client_name, r.id)) return `Another client is now called "${r.client_name}".`;
      if (r.username && db.prepare('SELECT 1 FROM storage_clients WHERE username = ? AND id != ?').get(r.username, r.id)) return `Another client now uses the portal login "${r.username}".`;
      return null;
    },
  },
  storage_rd: {
    section: 'ITF Storage Centre', label: 'Receiving / dispatch entry', table: 'storage_receiving_dispatch',
    order: 'COALESCE(date_dispatched, date_received) DESC',
    describe: (r) => ({ title: join(r.client, r.date_received && `received ${dmy(r.date_received)}`, r.date_dispatched && `dispatched ${dmy(r.date_dispatched)}`), detail: join(r.stock_received_type, r.stock_dispatched_type) }),
    search: (r) => [r.client, r.stock_received_type, r.stock_dispatched_type, r.receiving, r.dispatch],
  },
};

function typeList() {
  return Object.entries(TYPES).map(([id, t]) => ({ id, section: t.section, label: t.label }));
}

// ---------------------------------------------------------------------------
// Backup files: opened read-only from a temp copy, cached for a few minutes so
// searching and restoring don't download the same file again.
// ---------------------------------------------------------------------------
const CACHE_MS = 15 * 60 * 1000;
const cache = new Map(); // key -> { db, file, name, at }

function sweep() {
  const now = Date.now();
  for (const [k, v] of cache) {
    if (now - v.at > CACHE_MS) {
      try { v.db.close(); } catch (e) { /* closed */ }
      try { fs.unlinkSync(v.file); } catch (e) { /* gone */ }
      cache.delete(k);
    }
  }
}

function openBuffer(key, buffer, name) {
  sweep();
  if (cache.has(key)) { const c = cache.get(key); c.at = Date.now(); return c; }
  if (!buffer || buffer.length < 100 || buffer.subarray(0, 15).toString() !== 'SQLite format 3') {
    throw Object.assign(new Error("That isn't a Work Desk database backup (.db file)."), { status: 400 });
  }
  const file = path.join(os.tmpdir(), `record-restore-${crypto.randomUUID()}.db`);
  fs.writeFileSync(file, buffer);
  const src = new Database(file, { readonly: true, fileMustExist: true });
  const entry = { db: src, file, name, at: Date.now() };
  cache.set(key, entry);
  return entry;
}

// For a hand-uploaded .db: keep it under a short id the page sends back.
function registerUpload(buffer, name) {
  const key = `upload:${crypto.createHash('sha1').update(buffer).digest('hex').slice(0, 16)}`;
  openBuffer(key, buffer, name || 'Uploaded backup');
  return key;
}

function cached(key) {
  sweep();
  const c = cache.get(key);
  if (c) c.at = Date.now();
  return c || null;
}

// ---------------------------------------------------------------------------
const tableExists = (d, t) => !!d.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(t);
const columns = (d, t) => d.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
const sharedColumns = (src, t) => { const live = new Set(columns(db, t)); return columns(src, t).filter((c) => live.has(c)); };
const IGNORE_DIFF = new Set(['updated_at']);

function changedFields(a, b, cols) {
  return cols.filter((c) => !IGNORE_DIFF.has(c) && String(a[c] ?? '') !== String(b[c] ?? ''));
}

// Records in the backup, each marked deleted (not here any more), changed or same.
function search(src, typeId, { q = '', show = 'changed', limit = 300 } = {}) {
  const t = TYPES[typeId];
  if (!t) throw Object.assign(new Error('Unknown record type'), { status: 400 });
  if (!tableExists(src, t.table)) return { records: [], total: 0, note: 'This backup is from before this part of the app existed.' };
  const cols = sharedColumns(src, t.table);
  const rows = src.prepare(`SELECT * FROM ${t.table} ORDER BY ${t.order}`).all();
  const needle = String(q).trim().toLowerCase();
  const liveStmt = db.prepare(`SELECT * FROM ${t.table} WHERE id = ?`);
  const out = [];
  let total = 0;
  for (const r of rows) {
    if (needle && !t.search(r).some((v) => String(v ?? '').toLowerCase().includes(needle))) continue;
    const live = liveStmt.get(r.id);
    const status = !live ? 'deleted' : (changedFields(r, live, cols).length ? 'changed' : 'same');
    if (show === 'changed' && status === 'same') continue;
    total += 1;
    if (out.length >= limit) continue;
    const d = t.describe(r, src);
    out.push({ id: r.id, title: d.title, detail: d.detail, status, changed: live ? changedFields(r, live, cols) : [] });
  }
  return { records: out, total };
}

// Every row that makes up one record (main row + children) in a database.
function snapshot(d, t, id) {
  const main = tableExists(d, t.table) ? d.prepare(`SELECT * FROM ${t.table} WHERE id = ?`).get(id) : null;
  if (!main) return null;
  const children = {};
  (t.children || []).forEach((c) => {
    if (tableExists(d, c.table)) children[c.table] = d.prepare(`SELECT * FROM ${c.table} WHERE ${c.where}`).all(id);
  });
  return { main, children };
}

// Replace one record (and its children) in the live database with `snap`
// (or remove it when snap is null). Foreign keys are switched off so a record
// whose user has since been removed still comes back whole; children are
// cleared by hand instead of by cascade.
function writeRecord(t, id, snap) {
  const insert = (table, row) => {
    const live = new Set(columns(db, table));
    const cols = Object.keys(row).filter((c) => live.has(c));
    db.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...cols.map((c) => row[c]));
  };
  [...(t.children || [])].reverse().forEach((c) => db.prepare(`DELETE FROM ${c.table} WHERE ${c.where}`).run(id));
  db.prepare(`DELETE FROM ${t.table} WHERE id = ?`).run(id);
  if (!snap) return;
  insert(t.table, snap.main);
  (t.children || []).forEach((c) => (snap.children[c.table] || []).forEach((row) => insert(c.table, row)));
}

function withForeignKeysOff(fn) {
  db.pragma('foreign_keys = OFF');
  try { return db.transaction(fn)(); } finally { db.pragma('foreign_keys = ON'); }
}

function restore(src, backupName, typeId, ids, userName) {
  const t = TYPES[typeId];
  if (!t) throw Object.assign(new Error('Unknown record type'), { status: 400 });
  if (!Array.isArray(ids) || !ids.length) throw Object.assign(new Error('Choose at least one record'), { status: 400 });
  if (ids.length > 500) throw Object.assign(new Error('At most 500 records at a time'), { status: 400 });
  const results = [];
  const logStmt = db.prepare('INSERT INTO record_restore_log (id, type, record_id, label, backup_name, before_json, after_json, restored_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  withForeignKeysOff(() => {
    ids.forEach((id) => {
      const fromBackup = snapshot(src, t, id);
      if (!fromBackup) { results.push({ id, ok: false, error: 'Not in this backup' }); return; }
      const d = t.describe(fromBackup.main, src);
      const problem = t.check ? t.check(fromBackup.main) : null;
      if (problem) { results.push({ id, title: d.title, ok: false, error: problem }); return; }
      const before = snapshot(db, t, id);
      const snap = { main: t.fixRow ? t.fixRow(fromBackup.main, !!before) : fromBackup.main, children: { ...fromBackup.children } };
      // Photos / attachments only come back if their file is still on the server.
      let missingFiles = 0;
      (t.children || []).filter((c) => c.files).forEach((c) => {
        const rows = snap.children[c.table] || [];
        snap.children[c.table] = rows.filter((row) => {
          const ok = row[c.files] && fs.existsSync(path.join(UPLOAD_DIR, row[c.files]));
          if (!ok) missingFiles += 1;
          return ok;
        });
      });
      try {
        db.transaction(() => writeRecord(t, id, snap))(); // savepoint: a failure here leaves this record as it was
      } catch (err) {
        results.push({ id, title: d.title, ok: false, error: `Could not restore: ${err.message}` });
        return;
      }
      const counts = Object.fromEntries((t.children || []).map((c) => [c.label, (snap.children[c.table] || []).length]).filter(([, n]) => n));
      logStmt.run(crypto.randomUUID(), typeId, id, d.title, backupName, before ? JSON.stringify(before) : null, JSON.stringify(snap), userName || null);
      results.push({ id, title: d.title, ok: true, wasDeleted: !before, counts, missingFiles });
    });
  });
  return { restored: results.filter((r) => r.ok).length, results };
}

function recentRestores(limit = 30) {
  return db.prepare('SELECT id, type, record_id, label, backup_name, restored_by, restored_at, undone_at, undone_by, before_json IS NULL AS was_deleted FROM record_restore_log ORDER BY restored_at DESC LIMIT ?').all(limit)
    .map((r) => ({ ...r, typeLabel: TYPES[r.type]?.label || r.type, wasDeleted: !!r.was_deleted }));
}

// Put a record back to how it was just before a restore (removing it again if
// it had been deleted). Only the latest restore of a record can be undone.
function undo(logId, userName) {
  const log = db.prepare('SELECT * FROM record_restore_log WHERE id = ?').get(logId);
  if (!log) throw Object.assign(new Error('Restore not found'), { status: 404 });
  if (log.undone_at) throw Object.assign(new Error('That restore was already undone'), { status: 400 });
  const later = db.prepare('SELECT 1 FROM record_restore_log WHERE type = ? AND record_id = ? AND restored_at > ? AND undone_at IS NULL').get(log.type, log.record_id, log.restored_at);
  if (later) throw Object.assign(new Error('This record was restored again since — undo the newer restore first.'), { status: 400 });
  const t = TYPES[log.type];
  withForeignKeysOff(() => {
    writeRecord(t, log.record_id, log.before_json ? JSON.parse(log.before_json) : null);
    db.prepare("UPDATE record_restore_log SET undone_at = datetime('now'), undone_by = ? WHERE id = ?").run(userName || null, logId);
  });
  return { ok: true };
}

module.exports = { TYPES, typeList, openBuffer, registerUpload, cached, search, restore, recentRestores, undo };

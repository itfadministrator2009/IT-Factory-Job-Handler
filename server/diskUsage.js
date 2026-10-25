// What is using the server's disk: the database (and which tables inside it),
// uploaded files (job attachments, project photos, and files nothing points to
// any more), Storage Centre restore points, and anything else sitting next to
// the database on the disk. Read-only — it measures, it never deletes.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { db } = require('./db');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'helpdesk.db');
// The upload routes and the backup have used two different defaults over time;
// look in every place uploads could be.
const fileStore = require('./fileStore');
const UPLOAD_DIRS = [...new Set([
  fileStore.UPLOAD_DIR,
  process.env.UPLOAD_DIR,
  path.join(__dirname, '..', 'uploads'),
  path.join(__dirname, 'uploads'),
].filter(Boolean).map((d) => path.resolve(d)))];

const TABLE_LABELS = {
  jobs: 'Jobs', job_audit: 'Job history', job_notes: 'Job notes', job_items: 'Job items', attachments: 'Attachment records',
  projects: 'Projects', project_entries: 'Project entries', project_entry_photos: 'Project photo records', project_entry_audit: 'Project entry history',
  assets: 'Asset Tracker assets', asset_audit: 'Asset history', asset_batches: 'Asset batches', asset_batch_items: 'Asset batch items',
  storage_items: 'Storage items', storage_item_notes: 'Storage item notes', storage_restore_points: 'Storage restore points',
  storage_receiving_dispatch: 'Receiving / dispatch', storage_orders: 'Client orders', record_restore_log: 'Record restore log',
  users: 'Users', articles: 'Articles',
  cloud_files: 'Cloudflare R2 file list', timecard_entries: 'Time Card entries', timecard_weeks: 'Time Card weeks',
  timecard_expenses: 'Time Card expenses', activity_log: 'Activity log', app_settings: 'Settings', storage_meta: 'Storage Centre settings',
  storage_clients: 'Storage clients', storage_locations_registry: 'Storage locations', storage_pallets: 'Storage pallets', login_challenges: 'Login codes',
  trusted_devices: 'Remembered devices', job_templates: 'Job templates', asset_field_defs: 'Asset Tracker fields', project_assignments: 'Project assignments',
  user_presence: 'Who is online', timecard_meta: 'Time Card settings', timecard_projects: 'Time Card projects', job_number_seq: 'Job numbers',
  storage_order_number_seq: 'Order numbers',
};

function statSize(p) { try { return fs.statSync(p).size; } catch (e) { return 0; } }

// Total size and file count under a folder (follows no symlinks).
function folderSize(dir, depth = 0) {
  let bytes = 0; let files = 0;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return { bytes, files }; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isFile()) { bytes += statSize(p); files += 1; } else if (e.isDirectory() && depth < 6) {
      const sub = folderSize(p, depth + 1); bytes += sub.bytes; files += sub.files;
    }
  }
  return { bytes, files };
}

function diskSpace(dir) {
  try {
    const s = fs.statfsSync(dir);
    const total = s.blocks * s.bsize;
    const free = s.bavail * s.bsize;
    return { total, free, used: total - free };
  } catch (e) { return null; }
}

function tableSizes() {
  try {
    return db.prepare(`SELECT m.tbl_name AS name, SUM(s.pgsize) AS bytes
      FROM dbstat s JOIN sqlite_master m ON m.name = s.name
      GROUP BY m.tbl_name ORDER BY bytes DESC`).all()
      .map((r) => ({ table: r.name, label: TABLE_LABELS[r.name] || r.name, bytes: r.bytes }));
  } catch (e) { return null; } // SQLite built without dbstat
}

const kindOf = (mime, name) => {
  const m = String(mime || '').toLowerCase(); const ext = path.extname(String(name || '')).toLowerCase();
  if (m.startsWith('image/') || ['.jpg', '.jpeg', '.png', '.heic', '.webp', '.gif'].includes(ext)) return 'Photos / images';
  if (m === 'application/pdf' || ext === '.pdf') return 'PDFs';
  if (/sheet|excel|csv/.test(m) || ['.xlsx', '.xls', '.csv'].includes(ext)) return 'Spreadsheets';
  if (m.startsWith('video/') || ['.mp4', '.mov'].includes(ext)) return 'Videos';
  return 'Other files';
};

function uploadsBreakdown() {
  // Every file the database knows about, keyed by stored name.
  const known = new Map();
  try {
    db.prepare(`SELECT a.stored_name, a.original_name, a.mime_type, a.created_at, j.job_number, j.subject
      FROM attachments a LEFT JOIN jobs j ON j.id = a.job_id`).all()
      .forEach((r) => known.set(r.stored_name, { area: 'Job attachments', name: r.original_name, mime: r.mime_type, createdAt: r.created_at, owner: r.job_number != null ? `Job #${r.job_number}${r.subject ? ` — ${r.subject}` : ''}` : 'Job (deleted)', ownerKey: `job:${r.job_number}` }));
  } catch (e) { /* table missing */ }
  try {
    db.prepare(`SELECT ph.stored_name, ph.original_name, ph.mime_type, ph.created_at, e.entry_number, p.name AS project
      FROM project_entry_photos ph LEFT JOIN project_entries e ON e.id = ph.entry_id LEFT JOIN projects p ON p.id = e.project_id`).all()
      .forEach((r) => known.set(r.stored_name, { area: 'Project photos', name: r.original_name, mime: r.mime_type, createdAt: r.created_at, owner: r.project ? `${r.project}${r.entry_number != null ? ` — entry #${r.entry_number}` : ''}` : 'Project (deleted)', ownerKey: `project:${r.project}` }));
  } catch (e) { /* table missing */ }

  // Every uploaded file, wherever it is: on the Render disk, in Cloudflare R2, or both.
  const all = new Map(); // stored name -> { name, area, kind, owner, ownerKey, createdAt, render, cloud }
  const entryFor = (stored) => {
    if (!all.has(stored)) {
      const k = known.get(stored);
      all.set(stored, {
        name: k?.name || stored,
        area: k ? k.area : 'Not linked to anything (left over)',
        kind: kindOf(k?.mime, k?.name || stored),
        owner: k?.owner || null, ownerKey: k?.ownerKey || null, createdAt: k?.createdAt || null,
        render: 0, onRender: false, cloud: 0, inCloud: false,
      });
    }
    return all.get(stored);
  };
  const dirs = [];
  for (const dir of UPLOAD_DIRS) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { continue; }
    let dirBytes = 0; let dirFiles = 0;
    for (const e of entries) {
      if (!e.isFile()) continue;
      const bytes = statSize(path.join(dir, e.name));
      dirBytes += bytes; dirFiles += 1;
      const f = entryFor(e.name);
      f.render += bytes; f.onRender = true;
    }
    dirs.push({ dir, bytes: dirBytes, files: dirFiles });
  }
  try {
    db.prepare('SELECT name, size FROM cloud_files').all().forEach((r) => {
      const f = entryFor(r.name);
      f.cloud = r.size; f.inCloud = true;
    });
  } catch (e) { /* no cloud storage yet */ }

  const files = [...all.values()];
  const render = summarise(files.filter((f) => f.onRender), (f) => f.render);
  return {
    // The Render disk (what the top of the page and the disk alert are about).
    dirs,
    ...render,
    // The same breakdown for Cloudflare R2, and for every file wherever it is.
    breakdowns: {
      all: summarise(files, (f) => Math.max(f.render, f.cloud)),
      render,
      cloud: summarise(files.filter((f) => f.inCloud), (f) => f.cloud),
    },
    // Files moved to Cloudflare R2 aren't on the disk any more, but aren't missing.
    missingFiles: [...known.keys()].filter((n) => !all.get(n)?.onRender && !all.get(n)?.inCloud).length,
  };
}

const whereOf = (f) => (f.onRender && f.inCloud ? 'Both' : f.inCloud ? 'Cloudflare R2' : 'Render');

// Totals by area, type, month and job/project, plus the largest files.
function summarise(files, bytesOf) {
  const areas = {}; const kinds = {}; const owners = {}; const months = {};
  let total = 0;
  for (const f of files) {
    const bytes = bytesOf(f);
    total += bytes;
    (areas[f.area] ||= { bytes: 0, files: 0 }).bytes += bytes; areas[f.area].files += 1;
    (kinds[f.kind] ||= { bytes: 0, files: 0 }).bytes += bytes; kinds[f.kind].files += 1;
    if (f.ownerKey) { (owners[f.ownerKey] ||= { owner: f.owner, area: f.area, bytes: 0, files: 0 }).bytes += bytes; owners[f.ownerKey].files += 1; }
    const month = String(f.createdAt || '').slice(0, 7);
    if (month) { (months[month] ||= { bytes: 0, files: 0 }).bytes += bytes; months[month].files += 1; }
  }
  const list = (o) => Object.entries(o).map(([name, v]) => ({ name, ...v })).sort((a, b) => b.bytes - a.bytes);
  return {
    total,
    files: files.length,
    byArea: list(areas),
    byKind: list(kinds),
    byMonth: Object.entries(months).map(([month, v]) => ({ month, ...v })).sort((a, b) => b.month.localeCompare(a.month)).slice(0, 12),
    topOwners: Object.values(owners).sort((a, b) => b.bytes - a.bytes).slice(0, 10),
    largestFiles: files.map((f) => ({ name: f.name, area: f.area, owner: f.owner, bytes: bytesOf(f), createdAt: f.createdAt, where: whereOf(f) }))
      .sort((a, b) => b.bytes - a.bytes).slice(0, 15),
  };
}

function restorePoints() {
  const out = {};
  try { out.storage = db.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(LENGTH(zip)), 0) AS bytes FROM storage_restore_points').get(); } catch (e) { /* none */ }
  try { out.records = db.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(LENGTH(before_json) + LENGTH(COALESCE(after_json, \'\'))), 0) AS bytes FROM record_restore_log').get(); } catch (e) { /* none */ }
  return out;
}

// Everything else on the same disk as the database (stray backups, old copies…).
function besideDatabase() {
  const dir = path.dirname(path.resolve(DB_PATH));
  const skip = new Set([path.basename(DB_PATH), `${path.basename(DB_PATH)}-wal`, `${path.basename(DB_PATH)}-shm`]);
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return { dir, items: [] }; }
  const items = entries.filter((e) => !skip.has(e.name) && !UPLOAD_DIRS.includes(path.join(dir, e.name)) && e.name !== 'node_modules')
    .map((e) => {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { const s = folderSize(p); return { name: `${e.name}/`, bytes: s.bytes, files: s.files }; }
      return { name: e.name, bytes: statSize(p), files: 1 };
    })
    .sort((a, b) => b.bytes - a.bytes).slice(0, 15);
  return { dir, items };
}

function leftoverTempFiles() {
  let entries = [];
  try { entries = fs.readdirSync(os.tmpdir()); } catch (e) { return { bytes: 0, files: 0 }; }
  const ours = entries.filter((n) => /^(workdesk-|record-restore-)/.test(n));
  return { bytes: ours.reduce((t, n) => t + statSize(path.join(os.tmpdir(), n)), 0), files: ours.length };
}

function diskUsage() {
  const pageSize = db.pragma('page_size', { simple: true });
  const freePages = db.pragma('freelist_count', { simple: true });
  const database = {
    path: path.resolve(DB_PATH),
    file: statSize(DB_PATH),
    wal: statSize(`${DB_PATH}-wal`),
    shm: statSize(`${DB_PATH}-shm`),
    reclaimable: pageSize * freePages, // empty space inside the file a VACUUM would give back
    tables: tableSizes(),
  };
  database.total = database.file + database.wal + database.shm;
  return {
    measuredAt: new Date().toISOString(),
    disk: diskSpace(path.dirname(path.resolve(DB_PATH))),
    database,
    uploads: uploadsBreakdown(),
    restorePoints: restorePoints(),
    besideDatabase: besideDatabase(),
    tempFiles: leftoverTempFiles(),
    cloud: fileStore.status(),
  };
}

module.exports = { diskUsage, diskSpace, DB_PATH };

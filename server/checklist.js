// ITF Asset Checklist — QA checklists for refurbished devices (moved over from
// the old Google Sheets "IT Factory Australia Asset Checklist" app).
//
// One row per saved checklist. Device details and ticked items are kept as
// JSON keyed by the labels in checklistConfig.js, so they read the same way the
// old sheet's columns did. Photos are files like job photos; entries brought in
// from the old sheet keep their Google Drive photo IDs as links.
const { randomUUID } = require('crypto');
const { db } = require('./db');
const CONFIG = require('./checklistConfig');

db.exec(`
CREATE TABLE IF NOT EXISTS checklist_entries (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL UNIQUE,
  device_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  technician TEXT,
  date TEXT,
  info_json TEXT NOT NULL DEFAULT '{}',
  items_json TEXT NOT NULL DEFAULT '[]',
  grade TEXT,
  notes TEXT,
  platform TEXT,
  sales_item_id TEXT,
  last_edited_by TEXT,
  updated_at INTEGER,
  drive_photo_ids TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_checklist_device ON checklist_entries(device_key, created_at);
CREATE TABLE IF NOT EXISTS checklist_photos (
  id TEXT PRIMARY KEY,
  entry_id TEXT NOT NULL,
  stored_name TEXT NOT NULL,
  original_name TEXT,
  mime_type TEXT,
  size INTEGER,
  created_at INTEGER NOT NULL,
  uploaded_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_checklist_photos_entry ON checklist_photos(entry_id);
CREATE TABLE IF NOT EXISTS checklist_counters (
  device_key TEXT PRIMARY KEY,
  last INTEGER NOT NULL DEFAULT 0
);
`);

const DEVICES = CONFIG.deviceTypes;
const deviceOf = (key) => (Object.prototype.hasOwnProperty.call(DEVICES, key) ? DEVICES[key] : null);
// Every checklist item for a device type, in order.
const itemsOf = (device) => device.sections.flatMap((s) => s.items);
const clean = (v) => (v === null || v === undefined ? '' : String(v).trim());

// Next Asset ID for a device type, e.g. LAP-0042. Never reused, even after a delete.
function nextAssetId(deviceKey) {
  const device = deviceOf(deviceKey);
  const next = db.transaction(() => {
    db.prepare('INSERT OR IGNORE INTO checklist_counters (device_key, last) VALUES (?, 0)').run(deviceKey);
    db.prepare('UPDATE checklist_counters SET last = last + 1 WHERE device_key = ?').run(deviceKey);
    return db.prepare('SELECT last FROM checklist_counters WHERE device_key = ?').get(deviceKey).last;
  })();
  const id = `${device.assetPrefix}-${String(next).padStart(4, '0')}`;
  // Should an imported entry already hold this number, move past it.
  if (db.prepare('SELECT 1 FROM checklist_entries WHERE asset_id = ?').get(id)) return nextAssetId(deviceKey);
  return id;
}
// After an import: the counter starts after the highest number already used.
function bumpCounter(deviceKey, assetId) {
  const n = parseInt(String(assetId).split('-').pop(), 10);
  if (!Number.isFinite(n)) return;
  db.prepare('INSERT OR IGNORE INTO checklist_counters (device_key, last) VALUES (?, 0)').run(deviceKey);
  db.prepare('UPDATE checklist_counters SET last = MAX(last, ?) WHERE device_key = ?').run(n, deviceKey);
}

function photosOf(entryId) {
  return db.prepare('SELECT id, original_name AS name, mime_type AS mimeType, size, created_at AS createdAt FROM checklist_photos WHERE entry_id = ? ORDER BY created_at').all(entryId);
}
function toEntry(r, { withPhotos = false, photoCounts = null } = {}) {
  if (!r) return null;
  let info = {};
  let items = [];
  try { info = JSON.parse(r.info_json || '{}'); } catch { info = {}; }
  try { items = JSON.parse(r.items_json || '[]'); } catch { items = []; }
  const drivePhotoIds = String(r.drive_photo_ids || '').split(',').map((s) => s.trim()).filter(Boolean);
  const out = {
    id: r.id, assetId: r.asset_id, deviceKey: r.device_key, createdAt: r.created_at, technician: r.technician || '',
    date: r.date || '', info, items, grade: r.grade || '', notes: r.notes || '', platform: r.platform || '',
    salesItemId: r.sales_item_id || '', lastEditedBy: r.last_edited_by || '', updatedAt: r.updated_at || null, drivePhotoIds,
  };
  if (withPhotos) out.photos = photosOf(r.id);
  if (photoCounts) out.photoCount = (photoCounts[r.id] || 0) + drivePhotoIds.length;
  return out;
}

function listEntries(deviceKey) {
  const rows = db.prepare('SELECT * FROM checklist_entries WHERE device_key = ? ORDER BY created_at DESC, asset_id DESC').all(deviceKey);
  const counts = {};
  db.prepare(`SELECT p.entry_id, COUNT(*) AS n FROM checklist_photos p JOIN checklist_entries e ON e.id = p.entry_id
    WHERE e.device_key = ? GROUP BY p.entry_id`).all(deviceKey).forEach((x) => { counts[x.entry_id] = x.n; });
  return rows.map((r) => toEntry(r, { photoCounts: counts }));
}
function getEntry(id) {
  return toEntry(db.prepare('SELECT * FROM checklist_entries WHERE id = ?').get(id), { withPhotos: true });
}

// The checklist form's values, keeping only what this device type asks for.
function normalise(device, body) {
  const info = {};
  device.infoFields.forEach((f) => { info[f] = clean(body.info?.[f]); });
  const allowed = new Set(itemsOf(device));
  const items = Array.isArray(body.items) ? [...new Set(body.items.map(String))].filter((i) => allowed.has(i)) : [];
  return {
    info, items,
    date: /^\d{4}-\d{2}-\d{2}$/.test(clean(body.date)) ? clean(body.date) : '',
    grade: clean(body.grade), notes: String(body.notes ?? '').trim(), platform: clean(body.platform),
  };
}

// The Sales Manager inventory item for a checklist entry (same as the old app sent).
const PACK_HANDLE_COST = 5;
const LABOUR_COST = 35;
const ADS_COST = 35;
function salesItemFor(entry) {
  const device = deviceOf(entry.deviceKey);
  const f = (k) => clean(entry.info[k]);
  const parts = [];
  if (entry.grade) parts.push(`Cosmetic Grade: ${entry.grade}.`);
  if (entry.notes) parts.push(`Condition Notes: ${entry.notes}`);
  if (f('Additional Details')) parts.push(`Additional Details: ${f('Additional Details')}`);
  parts.push(`(Auto-added from ITF Asset Checklist, Asset ID ${entry.assetId}.)`);
  return {
    sku: entry.assetId,
    itemtype: f('Product Type') || device.salesItemType || device.label,
    make: f('Make'), model: f('Model'), serial: f('Serial Number'), colour: f('Colour'),
    batteryhealth: f('Battery Health'), capacity: f('Capacity'), ram: f('RAM'), cpu: f('CPU'), processor: f('PROCESSOR'),
    display: f('Screen Size'),
    packhandle: PACK_HANDLE_COST, labour: LABOUR_COST, adscost: ADS_COST,
    platform: 'ITF Australia', origin: 'Asset Checklist', comments: parts.join(' '),
    addedby: entry.technician, lasteditedby: entry.technician,
  };
}
// Adds the device to ITF Sales Manager → Inventory on Hand (once). Returns the item id.
function syncToSales(entryId) {
  const entry = getEntry(entryId);
  if (!entry || entry.platform !== 'ITF Australia') return '';
  if (entry.salesItemId) return entry.salesItemId;
  const sales = require('./sales');
  const itemId = sales.insertItem('inventory', salesItemFor(entry), entry.technician || 'Asset Checklist');
  db.prepare('UPDATE checklist_entries SET sales_item_id = ? WHERE id = ?').run(itemId, entryId);
  sales.logSalesActivity(entry.technician || 'Asset Checklist', 'Added from Asset Checklist', 'inventory', `${entry.assetId} — ${[entry.info.Make, entry.info.Model].filter(Boolean).join(' ')}`);
  return itemId;
}

function createEntry(deviceKey, body, userName, { now = Date.now() } = {}) {
  const device = deviceOf(deviceKey);
  const v = normalise(device, body);
  const id = randomUUID();
  const assetId = nextAssetId(deviceKey);
  db.prepare(`INSERT INTO checklist_entries (id, asset_id, device_key, created_at, technician, date, info_json, items_json, grade, notes, platform)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, assetId, deviceKey, now, userName, v.date, JSON.stringify(v.info), JSON.stringify(v.items), v.grade, v.notes, v.platform);
  return id;
}
function updateEntry(id, body, userName) {
  const before = db.prepare('SELECT * FROM checklist_entries WHERE id = ?').get(id);
  const device = deviceOf(before.device_key);
  const v = normalise(device, body);
  db.prepare(`UPDATE checklist_entries SET date = ?, info_json = ?, items_json = ?, grade = ?, notes = ?, platform = ?,
    last_edited_by = ?, updated_at = ? WHERE id = ?`)
    .run(v.date, JSON.stringify(v.info), JSON.stringify(v.items), v.grade, v.notes, v.platform, userName, Date.now(), id);
}

// Another saved entry of this device type with the same serial number, if any.
function findSerial(deviceKey, serial, excludeId) {
  const s = clean(serial).toLowerCase();
  if (!s) return null;
  const rows = db.prepare(`SELECT id, asset_id FROM checklist_entries WHERE device_key = ?
    AND lower(trim(json_extract(info_json, '$."Serial Number"'))) = ?`).all(deviceKey, s);
  const hit = rows.find((r) => r.id !== excludeId);
  return hit ? { id: hit.id, assetId: hit.asset_id } : null;
}

// Totals for the Summary page (same figures as the old app's Summary).
function summary() {
  const tz = 'Australia/Sydney';
  const dayOf = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(ms));
  const today = dayOf(Date.now());
  const weekAgo = Date.now() - 6 * 86400000;
  const techs = {};
  // For the dashboard charts: per day (last 30 days), per month (last 12),
  // by grade and by platform. Days and months are Sydney time.
  const [ty, tm, td] = today.split('-').map(Number);
  const dayKeys = [];
  for (let i = 29; i >= 0; i -= 1) dayKeys.push(new Date(Date.UTC(ty, tm - 1, td - i)).toISOString().slice(0, 10));
  const perDay = Object.fromEntries(dayKeys.map((k) => [k, 0]));
  const monthKeys = [];
  for (let i = 11; i >= 0; i -= 1) { const d = new Date(Date.UTC(ty, tm - 1 - i, 1)); monthKeys.push(d.toISOString().slice(0, 7)); }
  const perMonth = Object.fromEntries(monthKeys.map((k) => [k, 0]));
  const grades = {};
  const platforms = {};
  let grandTotal = 0;
  let totalSynced = 0;
  let totalPending = 0;
  const deviceTypes = Object.keys(DEVICES).map((key) => {
    const rows = db.prepare('SELECT technician, created_at, info_json, platform, grade, sales_item_id FROM checklist_entries WHERE device_key = ?').all(key);
    const out = { key, label: DEVICES[key].label, total: rows.length, synced: 0, pending: 0, models: [] };
    const models = {};
    rows.forEach((r) => {
      grandTotal += 1;
      let info = {};
      try { info = JSON.parse(r.info_json || '{}'); } catch { info = {}; }
      const m = [info.Make, info.Model].filter(Boolean).join(' ') || '(unspecified)';
      models[m] = (models[m] || 0) + 1;
      const g = clean(r.grade) || '(not graded)';
      grades[g] = (grades[g] || 0) + 1;
      const p = clean(r.platform) || '(not set)';
      platforms[p] = (platforms[p] || 0) + 1;
      if (r.created_at) {
        const day = dayOf(r.created_at);
        if (day in perDay) perDay[day] += 1;
        if (day.slice(0, 7) in perMonth) perMonth[day.slice(0, 7)] += 1;
      }
      if (r.platform === 'ITF Australia') {
        if (r.sales_item_id) { out.synced += 1; totalSynced += 1; } else { out.pending += 1; totalPending += 1; }
      }
      const t = clean(r.technician);
      if (t) {
        const x = (techs[t] = techs[t] || { username: t, total: 0, today: 0, last7Days: 0 });
        x.total += 1;
        if (r.created_at && dayOf(r.created_at) === today) x.today += 1;
        if (r.created_at && r.created_at >= weekAgo) x.last7Days += 1;
      }
    });
    out.models = Object.entries(models).map(([model, count]) => ({ model, count })).sort((a, b) => b.count - a.count);
    return out;
  });
  const counted = (o) => Object.entries(o).map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count);
  return {
    deviceTypes, technicians: Object.values(techs).sort((a, b) => b.total - a.total), grandTotal, totalSynced, totalPending,
    daily: dayKeys.map((day) => ({ day, count: perDay[day] })),
    monthly: monthKeys.map((month) => ({ month, count: perMonth[month] })),
    grades: counted(grades),
    platforms: counted(platforms),
  };
}

// Sydney wall-clock time → milliseconds (for the old sheet's Timestamp column).
function sydneyToMs(y, mo, d, h = 0, mi = 0, s = 0) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Australia/Sydney', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(guess)).reduce((o, p) => ({ ...o, [p.type]: p.value }), {});
  const asSydney = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return guess - (asSydney - guess);
}
// "2026-03-04 15:07", "2026-03-04T15:07:00", "4/3/2026 15:07" → ms (Sydney time).
function parseSheetTime(v) {
  const s = clean(v);
  if (!s) return null;
  if (/^\d{10,}$/.test(s)) return Number(s);
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) return sydneyToMs(+m[1], +m[2], +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:,?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) return sydneyToMs(+m[3], +m[2], +m[1], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}
function sheetDate(v) {
  const s = clean(v);
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return '';
}

// Old sheet column names that were renamed over time.
const HEADER_RENAMES = { Specs: 'Capacity', 'Trackpad / Touchscreen (if applicable)': 'Trackpad' };

// One tab of the old Google Sheet → entries (matched by Asset ID, so importing
// again updates rather than duplicates). Returns { added, updated, skipped }.
function importSheetRows(deviceKey, headers, rows, userName) {
  const device = deviceOf(deviceKey);
  const col = {};
  headers.forEach((h, i) => {
    const name = HEADER_RENAMES[clean(h)] || clean(h);
    if (name && !(name in col)) col[name] = i;
  });
  if (!('Asset ID' in col)) throw new Error(`The ${device.sheetName} tab has no "Asset ID" column.`);
  const cell = (r, name) => (name in col ? clean(r[col[name]]) : '');
  const items = itemsOf(device);
  const upsert = db.prepare(`INSERT INTO checklist_entries
    (id, asset_id, device_key, created_at, technician, date, info_json, items_json, grade, notes, platform, sales_item_id, last_edited_by, updated_at, drive_photo_ids)
    VALUES (@id, @asset_id, @device_key, @created_at, @technician, @date, @info_json, @items_json, @grade, @notes, @platform, @sales_item_id, @last_edited_by, @updated_at, @drive_photo_ids)
    ON CONFLICT(asset_id) DO UPDATE SET device_key = excluded.device_key, created_at = excluded.created_at, technician = excluded.technician,
      date = excluded.date, info_json = excluded.info_json, items_json = excluded.items_json, grade = excluded.grade, notes = excluded.notes,
      platform = excluded.platform, sales_item_id = excluded.sales_item_id, last_edited_by = excluded.last_edited_by,
      drive_photo_ids = excluded.drive_photo_ids`);
  let added = 0;
  let updated = 0;
  let skipped = 0;
  db.transaction(() => {
    rows.forEach((r) => {
      const assetId = cell(r, 'Asset ID');
      if (!assetId) { skipped += 1; return; }
      const info = {};
      device.infoFields.forEach((f) => { info[f] = cell(r, f); });
      const ticked = items.filter((it) => cell(r, it) !== '');
      const exists = db.prepare('SELECT 1 FROM checklist_entries WHERE asset_id = ?').get(assetId);
      upsert.run({
        id: randomUUID(), asset_id: assetId, device_key: deviceKey,
        created_at: parseSheetTime(cell(r, 'Timestamp')) || parseSheetTime(cell(r, 'Date')) || Date.now(),
        technician: cell(r, 'Technician'), date: sheetDate(cell(r, 'Date')),
        info_json: JSON.stringify(info), items_json: JSON.stringify(ticked),
        grade: cell(r, 'Cosmetic Grade'), notes: cell(r, 'Condition Notes'), platform: cell(r, 'Platform'),
        sales_item_id: cell(r, 'Sales Sync') || null, last_edited_by: cell(r, 'Last Edited By') || null, updated_at: null,
        drive_photo_ids: cell(r, 'Photos'),
      });
      bumpCounter(deviceKey, assetId);
      if (exists) updated += 1; else added += 1;
    });
  })();
  return { added, updated, skipped };
}

module.exports = {
  CONFIG, DEVICES, deviceOf, itemsOf, nextAssetId, listEntries, getEntry, toEntry, createEntry, updateEntry,
  findSerial, salesItemFor, syncToSales, summary, importSheetRows, parseSheetTime, sheetDate, photosOf,
};

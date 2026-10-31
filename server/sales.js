// ITF Sales Manager — sales and inventory of refurbished IT (moved over from the
// old Google Sheets "IT Factory Australia Sales Manager" / Sales Ledger app).
//
// One table holds both lists: kind 'sale' (All Sales) and kind 'inventory'
// (Inventory on Hand). Moving an item between them just changes its kind.
// Field names match the old sheet's columns so imports and exports line up.
const { randomUUID } = require('crypto');
const { db } = require('./db');

// Every field an item can have (same names as the old sheet's columns).
const FIELDS = [
  'sku', 'itemtype', 'make', 'model', 'serial', 'platform', 'orderno', 'customer',
  'selldate', 'listed', 'sellprice', 'cost', 'postage', 'fees', 'packhandle', 'labour',
  'adscost', 'warranty', 'location', 'origin', 'comments', 'status',
  'ram', 'cpu', 'processor', 'capacity', 'colour', 'display', 'extra', 'batteryhealth',
  'addedby', 'lasteditedby', 'extendedwarranty', 'shopifysourcekey',
];

db.exec(`
CREATE TABLE IF NOT EXISTS sales_items (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('sale', 'inventory')),
  ${FIELDS.map((f) => `${f} TEXT`).join(',\n  ')},
  created_at INTEGER,
  last_modified INTEGER
);
CREATE INDEX IF NOT EXISTS idx_sales_items_kind ON sales_items(kind);
CREATE INDEX IF NOT EXISTS idx_sales_items_selldate ON sales_items(selldate);
CREATE TABLE IF NOT EXISTS sales_activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  username TEXT,
  action TEXT,
  kind TEXT,
  detail TEXT
);
CREATE TABLE IF NOT EXISTS sales_shopify_pending (
  id TEXT PRIMARY KEY,
  shopify_order_id TEXT NOT NULL,
  shopify_line_item_id TEXT NOT NULL,
  order_number TEXT,
  order_date TEXT,
  customer TEXT,
  product_title TEXT,
  sku TEXT,
  quantity REAL,
  price TEXT,
  staged_at INTEGER,
  UNIQUE (shopify_order_id, shopify_line_item_id)
);
CREATE TABLE IF NOT EXISTS sales_meta (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT NOT NULL DEFAULT (datetime('now')));
`);

const getMeta = (key) => db.prepare('SELECT value FROM sales_meta WHERE key = ?').get(key)?.value ?? null;
const setMeta = (key, value) => db.prepare(`INSERT INTO sales_meta (key, value) VALUES (?, ?)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`).run(key, value == null ? null : String(value));

// --- Items ------------------------------------------------------------------

// A database row -> the record the app works with (old sheet's field names).
function toRecord(row) {
  if (!row) return null;
  const r = { id: row.id, kind: row.kind, createdAt: row.created_at, lastmodified: row.last_modified };
  FIELDS.forEach((f) => { r[f] = row[f] == null ? '' : row[f]; });
  return r;
}

// Clean a value for storage: blanks become NULL, everything else plain text.
// Spreadsheet numbers come back as JS numbers; SKUs keep their leading zeros
// because they arrive as text.
function clean(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? String(Math.round(v * 1e6) / 1e6) : null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

function listItems(kind) {
  return db.prepare('SELECT * FROM sales_items WHERE kind = ? ORDER BY created_at DESC').all(kind).map(toRecord);
}
function getItem(id) { return toRecord(db.prepare('SELECT * FROM sales_items WHERE id = ?').get(id)); }

function insertItem(kind, data, userName, { keepId = false, now = Date.now() } = {}) {
  const id = keepId && data.id ? String(data.id) : randomUUID();
  const vals = {};
  FIELDS.forEach((f) => { vals[f] = clean(data[f]); });
  if (!vals.addedby) vals.addedby = userName || null;
  if (!vals.lasteditedby && !keepId) vals.lasteditedby = userName || null; // sheet rows keep their own history
  const created = Number(data.createdAt) || now;
  db.prepare(`INSERT INTO sales_items (id, kind, ${FIELDS.join(', ')}, created_at, last_modified)
    VALUES (@id, @kind, ${FIELDS.map((f) => `@${f}`).join(', ')}, @created_at, @last_modified)
    ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, ${FIELDS.map((f) => `${f} = excluded.${f}`).join(', ')},
      created_at = excluded.created_at, last_modified = excluded.last_modified`)
    .run({ id, kind, ...vals, created_at: created, last_modified: now });
  return id;
}

// Change only the fields given (others stay as they are).
function updateItem(id, fields, userName) {
  const sets = [];
  const params = { id, now: Date.now() };
  FIELDS.forEach((f) => {
    if (f in fields && f !== 'addedby' && f !== 'lasteditedby') { sets.push(`${f} = @${f}`); params[f] = clean(fields[f]); }
  });
  if ('createdAt' in fields && Number(fields.createdAt)) { sets.push('created_at = @created_at'); params.created_at = Number(fields.createdAt); }
  sets.push('lasteditedby = @lasteditedby'); params.lasteditedby = userName || clean(fields.lasteditedby);
  return db.prepare(`UPDATE sales_items SET ${sets.join(', ')}, last_modified = @now WHERE id = @id`).run(params).changes;
}

function logSalesActivity(username, action, kind, detail) {
  db.prepare('INSERT INTO sales_activity (at, username, action, kind, detail) VALUES (?, ?, ?, ?, ?)')
    .run(Date.now(), username || null, action, kind || null, detail || null);
}
function recentActivity(limit = 300) {
  return db.prepare('SELECT at, username, action, kind, detail FROM sales_activity ORDER BY id DESC LIMIT ?').all(limit);
}
// Kept 90 days, like the old app.
function pruneSalesActivity() {
  db.prepare('DELETE FROM sales_activity WHERE at < ?').run(Date.now() - 90 * 86400000);
}
function describe(r) {
  const label = [r.make, r.model].filter(Boolean).join(' ').trim();
  return [r.sku ? `SKU ${r.sku}` : '', label].filter(Boolean).join(' — ') || 'item';
}

// --- Profit maths (the weekly email; the app does the same in the browser) ---

// Labour and Google Ads are fixed WEEKLY costs, shared across each week's sales.
const WEEKLY_LABOUR_COST = Number(process.env.SALES_WEEKLY_LABOUR_COST || 3000);
const WEEKLY_ADS_COST = Number(process.env.SALES_WEEKLY_ADS_COST || 1000);
const num = (v) => parseFloat(v) || 0;
// Net for one sale BEFORE the weekly labour/ads (taken off once per week).
function netBeforeWeekly(r) {
  return num(r.sellprice) + num(r.extendedwarranty) - num(r.cost) - num(r.postage) - num(r.fees) - num(r.packhandle);
}

module.exports = {
  FIELDS, toRecord, clean, listItems, getItem, insertItem, updateItem,
  logSalesActivity, recentActivity, pruneSalesActivity, describe,
  getMeta, setMeta, WEEKLY_LABOUR_COST, WEEKLY_ADS_COST, netBeforeWeekly, num,
};

const Database = require('better-sqlite3');
const path = require('path');
const { randomUUID } = require('crypto');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'helpdesk.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'agent',
  reset_token TEXT,
  reset_token_expires TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  job_number INTEGER,
  contact_name TEXT NOT NULL,
  account_name TEXT,
  email TEXT,
  phone TEXT,
  subject TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'Open',
  owner_id TEXT,
  product_name TEXT,
  due_date TEXT,
  scheduled_time TEXT,
  language TEXT,
  priority TEXT DEFAULT 'Medium' CHECK(priority IN ('Low','Medium','High','Urgent')),
  channel TEXT DEFAULT 'Phone',
  classifications TEXT,
  site_address TEXT,
  access_notes TEXT,
  customer_reference TEXT,
  signature_name TEXT,
  signature_data TEXT,
  signature_at TEXT,
  resolved_at TEXT,
  ms_event_id TEXT,
  comments TEXT,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (owner_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS job_audit (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  field TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  changed_by TEXT,
  changed_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE,
  FOREIGN KEY (changed_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS job_templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  fields_json TEXT NOT NULL,
  items_json TEXT NOT NULL DEFAULT '[]',
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (created_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS job_items (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  description TEXT NOT NULL,
  qty INTEGER NOT NULL DEFAULT 1,
  reference TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS job_notes (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  author_id TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE,
  FOREIGN KEY (author_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  stored_name TEXT NOT NULL,
  original_name TEXT NOT NULL,
  mime_type TEXT,
  size INTEGER,
  uploaded_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE,
  FOREIGN KEY (uploaded_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS articles (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  body TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'General',
  author_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (author_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS job_number_seq (
  n INTEGER
);

-- ================= Projects feature =================
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  template_json TEXT NOT NULL,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (created_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS project_assignments (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  assigned_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE(project_id, user_id)
);

CREATE TABLE IF NOT EXISTS project_entries (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  entry_number INTEGER NOT NULL,
  site_name TEXT,
  status TEXT NOT NULL DEFAULT 'Draft',
  answers_json TEXT NOT NULL DEFAULT '{}',
  created_by TEXT,
  assigned_to TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  submitted_at TEXT,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id),
  FOREIGN KEY (assigned_to) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS project_entry_photos (
  id TEXT PRIMARY KEY,
  entry_id TEXT NOT NULL,
  field_id TEXT NOT NULL,
  repeat_index INTEGER,
  stored_name TEXT NOT NULL,
  original_name TEXT NOT NULL,
  mime_type TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (entry_id) REFERENCES project_entries(id) ON DELETE CASCADE
);

-- Who assigned/reassigned/submitted a given entry, and when — the equivalent of
-- job_audit above, but for project entries. Bulk actions can reassign many entries
-- at once, so this answers "who did that, and when" after the fact.
CREATE TABLE IF NOT EXISTS project_entry_audit (
  id TEXT PRIMARY KEY,
  entry_id TEXT NOT NULL,
  field TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  changed_by TEXT,
  changed_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (entry_id) REFERENCES project_entries(id) ON DELETE CASCADE,
  FOREIGN KEY (changed_by) REFERENCES users(id)
);
-- ================= end Projects feature =================

-- ================= Asset Tracker feature =================
-- Field definitions are data, not schema — this is what lets an admin "add a
-- field" or edit a dropdown's options from the UI without ever touching the
-- database. Every asset's actual values live in assets.fields_json, keyed by
-- field_key, exactly like project_entries.answers_json does for Projects.
CREATE TABLE IF NOT EXISTS asset_field_defs (
  id TEXT PRIMARY KEY,
  field_key TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'text', -- text | textarea | number | date | dropdown | multiselect
  options_json TEXT, -- JSON array of strings — only meaningful for dropdown/multiselect
  is_core INTEGER NOT NULL DEFAULT 0, -- core fields ship built-in; their options can still be edited, but the field itself can't be deleted
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY,
  fields_json TEXT NOT NULL DEFAULT '{}',
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (created_by) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_assets_created_at ON assets(created_at);

CREATE TABLE IF NOT EXISTS asset_audit (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL,
  field TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  changed_by TEXT,
  changed_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE CASCADE,
  FOREIGN KEY (changed_by) REFERENCES users(id)
);
-- ================= end Asset Tracker feature =================

-- ================= Storage Centre feature =================
-- Mirrors the "Items" sheet from the standalone Storage Centre Google Apps Script
-- app (HEADERS/KEY_MAP there) field-for-field, so the one-time migration script can
-- map columns straight across with no reshaping.
CREATE TABLE IF NOT EXISTS storage_items (
  id TEXT PRIMARY KEY,
  client TEXT,
  job_number TEXT,
  reference_number TEXT,
  storage_centre TEXT,
  location TEXT,
  quantity TEXT,
  condition TEXT,
  photo TEXT,
  item TEXT,
  make TEXT,
  model TEXT,
  serial TEXT,
  price_week REAL,
  start_date TEXT,
  end_date TEXT,
  added_by TEXT,
  last_edited_by TEXT,
  asset_tag TEXT,
  po_number TEXT,
  order_number TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_storage_items_client ON storage_items(client);
CREATE INDEX IF NOT EXISTS idx_storage_items_serial ON storage_items(serial);

CREATE TABLE IF NOT EXISTS storage_item_notes (
  id TEXT PRIMARY KEY,
  item_key TEXT NOT NULL,
  note TEXT NOT NULL,
  author TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_storage_item_notes_key ON storage_item_notes(item_key);

-- Mirrors the "Pallets" sheet (PALLETS_HEADERS/PALLETS_KEY_MAP).
CREATE TABLE IF NOT EXISTS storage_pallets (
  id TEXT PRIMARY KEY,
  client TEXT,
  storage_centre TEXT,
  location TEXT,
  price_week REAL,
  start_date TEXT,
  end_date TEXT,
  notes TEXT,
  added_by TEXT,
  last_edited_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Mirrors the "Clients" sheet (CLIENTS_HEADERS). Client portal login (username/
-- password) is kept here rather than in Work Desk's own users table, since a
-- storage client is not a Work Desk staff account — it reuses Work Desk's JWT
-- *mechanism* (same signing + authRequired-style middleware) via a separate
-- "storage client" token type, not the staff users table itself.
CREATE TABLE IF NOT EXISTS storage_clients (
  id TEXT PRIMARY KEY,
  client_name TEXT NOT NULL UNIQUE,
  username TEXT UNIQUE,
  password_hash TEXT,
  added_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Mirrors the "ClientOrders" sheet (CLIENT_ORDERS_HEADERS).
CREATE TABLE IF NOT EXISTS storage_orders (
  id TEXT PRIMARY KEY,
  order_number TEXT UNIQUE,
  client TEXT,
  devices TEXT,
  delivery_address TEXT,
  site_contact_name TEXT,
  site_contact_phone TEXT,
  date_to_be_delivered TEXT,
  config_information TEXT,
  notes TEXT,
  requestor TEXT,
  status TEXT NOT NULL DEFAULT 'Pending',
  tracking_number TEXT,
  tracking_email_sent_to TEXT,
  tracking_email_sent_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS storage_order_number_seq (n INTEGER);

-- Mirrors LocationsRegistry — classifies a Location *text* (not per storage
-- centre) as a real pallet-naming pattern or a placeholder, exactly as the old
-- app does, so the same classification decides pallet-rate lookups everywhere.
CREATE TABLE IF NOT EXISTS storage_locations_registry (
  id TEXT PRIMARY KEY,
  location TEXT NOT NULL UNIQUE,
  location_key TEXT NOT NULL UNIQUE,
  is_pallet INTEGER NOT NULL DEFAULT 0,
  classified_by TEXT,
  classified_on TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Mirrors the "ReceivingDispatch" sheet (RECEIVING_DISPATCH_HEADERS).
CREATE TABLE IF NOT EXISTS storage_receiving_dispatch (
  id TEXT PRIMARY KEY,
  client TEXT,
  date_received TEXT,
  date_dispatched TEXT,
  rate REAL,
  stock_received_type TEXT,
  stock_received_qty TEXT,
  stock_dispatched_type TEXT,
  stock_dispatched_qty TEXT,
  receiving TEXT,
  dispatch TEXT,
  saved_by TEXT,
  saved_on TEXT NOT NULL DEFAULT (datetime('now'))
);
-- ================= end Storage Centre feature =================
`);

// Seeds the built-in Asset Tracker fields once, matching the columns and dropdown
// values actually used in IT Factory's existing asset register — so the tracker is
// immediately usable with the categories and conditions already in real use, while
// still letting an admin add more fields or options later.
function seedAssetFieldDefs() {
  const count = db.prepare('SELECT COUNT(*) as c FROM asset_field_defs').get().c;
  if (count > 0) return;
  const opts = (arr) => JSON.stringify(arr);
  const fields = [
    ['asset_tag', 'Asset Tag', 'text', null],
    ['category', 'Category', 'dropdown', opts(['AIO', 'Desktop', 'Docking Station', 'Hard Drive', 'Keyboard', 'Laptop', 'Miscellaneous Equipment', 'Mobile Phone', 'Monitor', 'Mouse', 'Network', 'Printer', 'Tablet', 'UPS'])],
    ['manufacturer', 'Manufacturer', 'dropdown', opts(['APC', 'Acer', 'Apple', 'Cisco', 'Dell', 'Epson', 'HP', 'LG', 'Lenovo', 'Microsoft', 'Mixed', 'Nokia', 'Oppo', 'Targus', 'Toshiba', 'WD', 'Zebra'])],
    ['model_name', 'Model Name', 'text', null],
    ['model_number', 'Model Number', 'text', null],
    ['serial_number', 'Serial Number', 'text', null],
    ['client_asset_tag', 'Client Asset Tag', 'text', null],
    ['ram', 'Ram', 'text', null],
    ['cpu_speed', 'CPU Speed', 'text', null],
    ['cpu_gen', 'CPU Gen', 'text', null],
    ['hdd', 'HDD', 'text', null],
    ['battery', 'Battery', 'dropdown', opts(['Yes', 'No'])],
    ['condition_appearance', 'Condition Appearance', 'multiselect', opts(['Ok', 'Bezel-Dents', 'Brand New - Open Box', 'Broken Latch', 'Cracked Front Bezel', 'Damaged Casing', 'Damaged Casing Major', 'Damaged Hinge', 'Detached Screen - Broken', 'Faulty Backlight', 'Light Screen Scratches', 'Minor Screen Scratch', 'Missing Cover', 'Missing Rubber Feet', 'Scratched Screen ( Minor)', 'Screen Bubbles', 'Screen-Cracks', 'Screen-Damaged Glass', 'Screen-Moderate Scratches', 'Swollen Battery'])],
    ['condition_completeness', 'Condition Completeness', 'multiselect', opts(['Ok', 'Missing Battery', 'Missing HDD', 'Missing Power Adapter', 'Missing RAM', 'Missing Stand'])],
    ['condition_operability', 'Condition Operability', 'multiselect', opts(['Ok', 'BIOS Password', 'Bios Password Removed', 'Cracked Screen', 'Faulty HDD - Not Detected', 'Faulty Screen Lines', 'Faulty Screen No Display', 'Google Locked', 'Looping on Apple Logo', 'Noisey Fan', 'Not Booting', 'Not Powering up', 'Not Tested', 'Screen Dark Spots', 'Screen Dim'])],
    ['condition_services', 'Condition Services', 'multiselect', opts(['Ok', 'Blancco Failed', 'Blancco Wiped', 'E-Waste', 'Factory Reset', 'HDD Shredded', 'Lazesoft Wiped', 'Power Washed'])],
    ['asset_upgrade', 'Asset Upgrade', 'text', null],
    ['asset_sent_to', 'Asset Sent To', 'dropdown', opts(['E-Waste', 'ITF Australia', 'Return to Client', 'Wholesale'])],
    ['customer', 'Customer', 'text', null],
    ['zoho_ticket_number', 'Zoho Ticket Number', 'text', null],
    ['audit_month', 'Audit Month', 'text', null],
    ['comments', 'Comments', 'textarea', null],
    ['status', 'Status', 'dropdown', opts(['Available', 'Sold'])],
    ['buyer', 'Buyer', 'text', null],
  ];
  const insert = db.prepare('INSERT INTO asset_field_defs (id, field_key, label, type, options_json, is_core, sort_order) VALUES (?, ?, ?, ?, ?, 1, ?)');
  fields.forEach(([key, label, type, options], idx) => insert.run(randomUUID(), key, label, type, options, idx));
}
seedAssetFieldDefs();

function addColumnIfMissing(table, column, definition) {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  } catch (err) {
    if (!/duplicate column name/i.test(err.message)) throw err;
  }
}
addColumnIfMissing('jobs', 'ms_event_id', 'TEXT');
addColumnIfMissing('jobs', 'comments', 'TEXT');
addColumnIfMissing('project_entries', 'assigned_to', 'TEXT');

function migrateJobsStatusConstraint() {
  const tableSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='jobs'").get()?.sql;
  if (!tableSql || !/CHECK\(status IN/i.test(tableSql)) return;

  db.pragma('foreign_keys = OFF');
  const migrate = db.transaction(() => {
    db.exec(`
      CREATE TABLE jobs_new (
        id TEXT PRIMARY KEY,
        job_number INTEGER,
        contact_name TEXT NOT NULL,
        account_name TEXT,
        email TEXT,
        phone TEXT,
        subject TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL DEFAULT 'Open',
        owner_id TEXT,
        product_name TEXT,
        due_date TEXT,
        scheduled_time TEXT,
        language TEXT,
        priority TEXT DEFAULT 'Medium' CHECK(priority IN ('Low','Medium','High','Urgent')),
        channel TEXT DEFAULT 'Phone',
        classifications TEXT,
        site_address TEXT,
        access_notes TEXT,
        customer_reference TEXT,
        signature_name TEXT,
        signature_data TEXT,
        signature_at TEXT,
        resolved_at TEXT,
        ms_event_id TEXT,
        comments TEXT,
        created_by TEXT REFERENCES users(id),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (owner_id) REFERENCES users(id)
      );
    `);
    const oldCols = db.prepare("PRAGMA table_info(jobs)").all().map((c) => c.name);
    const newCols = db.prepare("PRAGMA table_info(jobs_new)").all().map((c) => c.name);
    const commonCols = newCols.filter((c) => oldCols.includes(c));
    const colList = commonCols.join(', ');
    db.exec(`INSERT INTO jobs_new (${colList}) SELECT ${colList} FROM jobs;`);
    db.exec('DROP TABLE jobs;');
    db.exec('ALTER TABLE jobs_new RENAME TO jobs;');
  });
  migrate();
  db.pragma('foreign_keys = ON');
  console.log('[db] Migrated jobs table: removed the outdated status CHECK constraint.');
}
migrateJobsStatusConstraint();

function migrateUsersEmailUnique() {
  const tableSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'").get()?.sql;
  if (!tableSql || !/email TEXT UNIQUE/i.test(tableSql)) return;

  db.pragma('foreign_keys = OFF');
  const migrate = db.transaction(() => {
    db.exec(`
      CREATE TABLE users_new (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'agent',
        reset_token TEXT,
        reset_token_expires TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    const oldCols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
    const newCols = db.prepare('PRAGMA table_info(users_new)').all().map((c) => c.name);
    const commonCols = newCols.filter((c) => oldCols.includes(c));
    const colList = commonCols.join(', ');
    db.exec(`INSERT INTO users_new (${colList}) SELECT ${colList} FROM users;`);
    db.exec('DROP TABLE users;');
    db.exec('ALTER TABLE users_new RENAME TO users;');
  });
  migrate();
  db.pragma('foreign_keys = ON');
  console.log('[db] Migrated users table: removed the UNIQUE constraint on email.');
}
migrateUsersEmailUnique();

db.prepare("UPDATE jobs SET status = 'Collected' WHERE status = 'Resolved'").run();

const seqRow = db.prepare('SELECT COUNT(*) as c FROM job_number_seq').get();
if (seqRow.c === 0) {
  db.prepare('INSERT INTO job_number_seq (n) VALUES (0)').run();
}

function nextJobNumber() {
  db.prepare('UPDATE job_number_seq SET n = n + 1').run();
  return db.prepare('SELECT n FROM job_number_seq').get().n;
}

function peekNextJobNumber() {
  const row = db.prepare('SELECT n FROM job_number_seq').get();
  return (row?.n || 0) + 1;
}

const storageOrderSeqRow = db.prepare('SELECT COUNT(*) as c FROM storage_order_number_seq').get();
if (storageOrderSeqRow.c === 0) {
  db.prepare('INSERT INTO storage_order_number_seq (n) VALUES (0)').run();
}

// Skips any number already taken (e.g. by imported or hand-entered orders), so a
// new order can never fail on the order_number UNIQUE constraint.
function nextStorageOrderNumber() {
  const taken = db.prepare('SELECT 1 FROM storage_orders WHERE order_number = ?');
  for (;;) {
    db.prepare('UPDATE storage_order_number_seq SET n = n + 1').run();
    const n = db.prepare('SELECT n FROM storage_order_number_seq').get().n;
    const orderNumber = `SC-${String(n).padStart(5, '0')}`;
    if (!taken.get(orderNumber)) return orderNumber;
  }
}

module.exports = { db, nextJobNumber, peekNextJobNumber, nextStorageOrderNumber };

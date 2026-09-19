const Database = require('better-sqlite3');
const path = require('path');

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
`);

// Safe migrations for columns added after the original CREATE TABLE ran on an
// already-existing database — CREATE TABLE IF NOT EXISTS only helps brand-new
// databases, so any column added to that statement later needs an explicit ALTER
// TABLE here too, or it silently never appears on a database that already existed.
// "duplicate column name" just means it's already there (fresh DB) — safe to ignore.
function addColumnIfMissing(table, column, definition) {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  } catch (err) {
    if (!/duplicate column name/i.test(err.message)) throw err;
  }
}
addColumnIfMissing('jobs', 'ms_event_id', 'TEXT');
addColumnIfMissing('jobs', 'comments', 'TEXT');

// One-time schema migration: the original `status` column had a CHECK constraint
// hard-coded to the old status values (including 'Resolved'), and SQLite can't alter
// a CHECK constraint directly — the only way to change it is to rebuild the table.
// This runs once (it detects and skips itself once the old constraint is gone) and
// preserves every column and every row exactly as they were, just without the
// constraint. No CHECK constraint is added back — status values are validated at the
// application layer instead, so the status list can change again later without ever
// needing another table rebuild like this one.
function migrateJobsStatusConstraint() {
  const tableSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='jobs'").get()?.sql;
  if (!tableSql || !/CHECK\(status IN/i.test(tableSql)) return; // already migrated, or a fresh DB that never had it

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
    // Only copy columns that actually exist on the live table into columns that
    // exist on the new one — dynamic rather than a hard-coded list, so this stays
    // safe even if the real table's exact column history differs from what's
    // assumed here.
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

// One-time schema migration: the users table originally had a UNIQUE constraint on
// email, which blocked multiple tech accounts sharing one inbox. Same rebuild
// approach as the jobs status migration above — preserves every column and row,
// just drops the constraint. Safe to run on every startup; it detects and skips
// itself once already migrated.
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

// One-time data fixup: the "Resolved" status was renamed to "Collected" — this
// updates any jobs already sitting in that old status so they land in the new one
// instead of becoming an orphaned value the UI no longer offers.
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
db.exec(`
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
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  submitted_at TEXT,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id)
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
`);
module.exports = { db, nextJobNumber, peekNextJobNumber };

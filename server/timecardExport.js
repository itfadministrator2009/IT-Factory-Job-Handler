// ITF Time Card export: timesheets, entries, expenses and the people who log time,
// each as a CSV, zipped — readable in Excel without any database tools. Uploaded to
// OneDrive with every backup, alongside the full database (which also holds all of
// this). Passwords are never included.
const archiver = require('archiver');
const { db } = require('./db');
const { toCsv } = require('./storageExport');
const { TIMESHEET_USERS_SQL } = require('./permissions');

const TABLES = [
  { file: 'timesheets.csv', sql: `SELECT w.id, COALESCE(u.name, w.full_name) AS person, COALESCE(u.email, w.email) AS email, w.week_ending, w.status,
      w.submitted_date, w.approved_by, w.approval_date, w.decline_reason,
      (SELECT ROUND(COALESCE(SUM(hours), 0), 2) FROM timecard_entries e WHERE e.week_id = w.id) AS total_hours,
      (SELECT ROUND(COALESCE(SUM(amount), 0), 2) FROM timecard_expenses x WHERE x.week_id = w.id) AS total_expenses,
      w.legacy_id AS old_app_week_id, w.created_at
    FROM timecard_weeks w LEFT JOIN users u ON u.id = w.user_id ORDER BY w.week_ending DESC, person` },
  { file: 'entries.csv', sql: `SELECT e.id, e.week_id, COALESCE(u.name, w.full_name) AS person, w.week_ending, w.status AS timesheet_status,
      e.day, e.date, e.client_project, e.start_time, e.finish_time, e.break_mins, e.hours, e.task, e.created_at
    FROM timecard_entries e JOIN timecard_weeks w ON w.id = e.week_id LEFT JOIN users u ON u.id = e.user_id
    ORDER BY w.week_ending DESC, person, e.date, e.start_time` },
  { file: 'expenses.csv', sql: `SELECT x.id, x.week_id, COALESCE(u.name, w.full_name) AS person, w.week_ending, w.status AS timesheet_status,
      x.date, x.type, x.description, x.amount, x.created_at
    FROM timecard_expenses x JOIN timecard_weeks w ON w.id = x.week_id LEFT JOIN users u ON u.id = x.user_id
    ORDER BY w.week_ending DESC, person, x.date` },
  { file: 'people.csv', sql: `SELECT id, name, email, role, hourly_rate, created_at FROM users WHERE ${TIMESHEET_USERS_SQL}
      OR id IN (SELECT user_id FROM timecard_weeks) ORDER BY name` },
];

function timecardCsvs() {
  return TABLES.map(({ file, sql }) => {
    const stmt = db.prepare(sql);
    const columns = stmt.columns().map((c) => c.name);
    const rows = stmt.all();
    return { file, csv: toCsv(rows, columns), count: rows.length };
  });
}

function buildTimecardZip() {
  const files = timecardCsvs();
  return new Promise((resolve, reject) => {
    const archive = archiver('zip', { zlib: { level: 6 } });
    const chunks = [];
    archive.on('data', (c) => chunks.push(c));
    archive.on('end', () => resolve({ buffer: Buffer.concat(chunks), counts: Object.fromEntries(files.map((f) => [f.file, f.count])) }));
    archive.on('error', reject);
    files.forEach(({ file, csv }) => archive.append(csv, { name: file }));
    archive.append(
      `IT Factory — ITF Time Card export\r\nCreated: ${new Date().toISOString()} (UTC)\r\n\r\n${files.map((f) => `${f.file}: ${f.count} row(s)`).join('\r\n')}\r\n\r\nThe full database backup (helpdesk-backup-*.db) also contains all Time Card data.\r\n`,
      { name: 'README.txt' },
    );
    archive.finalize();
  });
}

module.exports = { buildTimecardZip, timecardCsvs };

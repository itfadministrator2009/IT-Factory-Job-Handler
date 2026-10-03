// Storage Centre export: every Storage Centre table as a CSV, zipped. Readable in
// Excel without any database tools, so it doubles as a plain-language backup and
// as the "keep a copy of the sheet" habit staff had with the old Google Sheet.
// Client portal password hashes are deliberately left out.
const archiver = require('archiver');
const { db } = require('./db');

const TABLES = [
  { file: 'items.csv', sql: 'SELECT * FROM storage_items ORDER BY client, storage_centre, location' },
  { file: 'item-notes.csv', sql: 'SELECT * FROM storage_item_notes ORDER BY created_at' },
  { file: 'pallets.csv', sql: 'SELECT * FROM storage_pallets ORDER BY client, storage_centre, location' },
  { file: 'clients.csv', sql: 'SELECT id, client_name, username, CASE WHEN password_hash IS NULL THEN 0 ELSE 1 END AS has_portal_login, added_by, created_at FROM storage_clients ORDER BY client_name' },
  { file: 'orders.csv', sql: 'SELECT * FROM storage_orders ORDER BY created_at' },
  { file: 'receiving-dispatch.csv', sql: 'SELECT * FROM storage_receiving_dispatch ORDER BY saved_on' },
  { file: 'locations.csv', sql: 'SELECT location, is_pallet, classified_by, classified_on FROM storage_locations_registry ORDER BY location' },
];

function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\r\n]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(rows, columns) {
  const lines = [columns.map(csvCell).join(',')];
  rows.forEach((r) => lines.push(columns.map((c) => csvCell(r[c])).join(',')));
  // BOM so Excel opens UTF-8 (names with accents, "×", "—") correctly.
  return '﻿' + lines.join('\r\n') + '\r\n';
}

function tableCsvs() {
  return TABLES.map(({ file, sql }) => {
    const stmt = db.prepare(sql);
    const columns = stmt.columns().map((c) => c.name);
    const rows = stmt.all();
    return { file, csv: toCsv(rows, columns), count: rows.length };
  });
}

function buildStorageCentreZip() {
  const files = tableCsvs();
  return new Promise((resolve, reject) => {
    const archive = archiver('zip', { zlib: { level: 6 } });
    const chunks = [];
    archive.on('data', (c) => chunks.push(c));
    archive.on('end', () => resolve({ buffer: Buffer.concat(chunks), counts: Object.fromEntries(files.map((f) => [f.file, f.count])) }));
    archive.on('error', reject);
    const exportedAt = new Date().toISOString();
    files.forEach(({ file, csv }) => archive.append(csv, { name: file }));
    archive.append(
      `IT Factory Storage Centre export\r\nCreated: ${exportedAt} (UTC)\r\n\r\n${files.map((f) => `${f.file}: ${f.count} row(s)`).join('\r\n')}\r\n`,
      { name: 'README.txt' },
    );
    archive.finalize();
  });
}

module.exports = { buildStorageCentreZip, tableCsvs, toCsv, TABLES };

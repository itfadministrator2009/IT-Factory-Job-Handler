const express = require('express');
const { randomUUID } = require('crypto');
const bcrypt = require('bcryptjs');
const { db, nextStorageOrderNumber } = require('../db');
const { authRequired } = require('../auth');
const { isAdminRole, requireModule } = require('../permissions');
const { notifyStorageOrderTracking, notifyStorageOrderSubmitted, notifyStorageStockReceived } = require('../email');
const { orderNotifyList } = require('../storageNotify');
const {
  ALL_PALLETS, ALL_PALLETS_AT_CENTRE, rdFees, parsePeriod, summary: billingSummary, clientStatement, rdLinesInPeriod, round2,
} = require('../storageBilling');
const { buildOrderPdf, buildInvoicePdf, buildRdInvoicePdf, invoiceReference } = require('../storagePdf');
const { buildStorageCentreZip } = require('../storageExport');
const storageRestore = require('../storageRestore');
const { listBackups, downloadBackup } = require('../backup');
const { sendWeeklyInvoicingReminder, recipients: weeklyRecipients } = require('../storageWeekly');
const {
  billingGaps, calculator, dashboard, modelSummary, parseLocalDate, toNumberOrNull, presetRange, PRESETS,
} = require('../storageTools');

const router = express.Router();
router.use(authRequired);
router.use(requireModule('storage'));

function isAdmin(userId) {
  return isAdminRole(db.prepare('SELECT role FROM users WHERE id = ?').get(userId)?.role);
}

// ---------------------------------------------------------------------------
// Items / Manifest
// ---------------------------------------------------------------------------

function rowToItem(row) {
  if (!row) return row;
  return {
    id: row.id,
    client: row.client,
    jobNumber: row.job_number,
    referenceNumber: row.reference_number,
    storageCentre: row.storage_centre,
    location: row.location,
    quantity: row.quantity,
    condition: row.condition,
    photo: row.photo,
    item: row.item,
    make: row.make,
    model: row.model,
    serial: row.serial,
    priceWeek: row.price_week,
    startDate: row.start_date,
    endDate: row.end_date,
    addedBy: row.added_by,
    lastEditedBy: row.last_edited_by,
    assetTag: row.asset_tag,
    poNumber: row.po_number,
    orderNumber: row.order_number,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const ITEM_FIELD_COLUMNS = {
  client: 'client', jobNumber: 'job_number', referenceNumber: 'reference_number',
  storageCentre: 'storage_centre', location: 'location', quantity: 'quantity',
  condition: 'condition', photo: 'photo', item: 'item', make: 'make', model: 'model',
  serial: 'serial', priceWeek: 'price_week', startDate: 'start_date', endDate: 'end_date',
  addedBy: 'added_by', lastEditedBy: 'last_edited_by', assetTag: 'asset_tag',
  poNumber: 'po_number', orderNumber: 'order_number',
};

// Full manifest, no pagination — mirrors the old app's single getAllData fetch.
// At current data volumes (a few thousand rows of short text) this is small
// enough as plain JSON that a server cache isn't needed the way Apps Script's
// CacheService workaround was: SQLite + Express serve this in milliseconds.
router.get('/items', (req, res) => {
  const rows = db.prepare('SELECT * FROM storage_items ORDER BY created_at').all();
  res.json({ items: rows.map(rowToItem) });
});

router.post('/items', (req, res) => {
  const b = req.body || {};
  const id = randomUUID();
  const cols = ['id', ...Object.keys(ITEM_FIELD_COLUMNS).map((k) => ITEM_FIELD_COLUMNS[k])];
  const vals = [id, ...Object.keys(ITEM_FIELD_COLUMNS).map((k) => b[k] ?? null)];
  db.prepare(`INSERT INTO storage_items (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...vals);
  const row = db.prepare('SELECT * FROM storage_items WHERE id = ?').get(id);
  res.status(201).json({ item: rowToItem(row) });
});

// Bulk edit (old bulkUpdateItems): the same value written to every selected
// item. `updates.status` is the old "Status" override: 'in' clears the end date
// (back in storage), 'out' sets it to today — but only on items still in
// storage, so an item that already left keeps its real end date (and billing). Registered before /items/:id so
// Express doesn't treat "bulk-edit" as an item id.
const sydneyToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney' }).format(new Date());
const BULK_EDIT_FIELDS = ['client', 'jobNumber', 'referenceNumber', 'storageCentre', 'location', 'quantity', 'condition', 'item', 'make', 'model', 'serial', 'priceWeek', 'startDate', 'endDate', 'assetTag', 'poNumber', 'orderNumber'];
router.patch('/items/bulk-edit', (req, res) => {
  const { ids, updates } = req.body || {};
  if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'ids array is required' });
  if (!updates || typeof updates !== 'object') return res.status(400).json({ error: 'updates object is required' });
  const u = { ...updates };
  const markOut = u.status === 'out';
  if (u.status === 'in') u.endDate = null;
  if (markOut) delete u.endDate;
  const sets = [];
  const setVals = [];
  BULK_EDIT_FIELDS.forEach((k) => {
    if (u[k] === undefined) return;
    let v = u[k] === '' ? null : u[k];
    if (k === 'priceWeek' && v != null) { v = Number(v); if (!Number.isFinite(v)) return; }
    sets.push(`${ITEM_FIELD_COLUMNS[k]} = ?`); setVals.push(v);
  });
  if (sets.length === 0 && !markOut) return res.status(400).json({ error: 'Nothing to update' });
  const who = req.user.name || null;
  const stmt = sets.length ? db.prepare(`UPDATE storage_items SET ${sets.join(', ')}, last_edited_by = ?, updated_at = datetime('now') WHERE id = ?`) : null;
  const outStmt = db.prepare("UPDATE storage_items SET end_date = ?, last_edited_by = ?, updated_at = datetime('now') WHERE id = ? AND end_date IS NULL");
  const exists = db.prepare('SELECT 1 FROM storage_items WHERE id = ?');
  let updated = 0; let markedOut = 0; let found = 0;
  const today = sydneyToday();
  db.transaction(() => {
    ids.forEach((id) => {
      if (!exists.get(id)) return;
      found += 1;
      if (stmt) updated += stmt.run(...setVals, who, id).changes;
      if (markOut) markedOut += outStmt.run(today, who, id).changes;
    });
  })();
  res.json({ ok: true, updated: stmt ? updated : markedOut, markedOut, notFound: ids.length - found });
});

// Spreadsheet import (old bulkSaveItems): every row inserted in one transaction.
// Dates accept YYYY-MM-DD, D/M/YYYY or an Excel serial; quantity and price have
// "$" and "," stripped. The client maps the spreadsheet's columns first.
router.post('/items/import', (req, res) => {
  const rows = req.body?.items;
  if (!Array.isArray(rows) || rows.length === 0) return res.status(400).json({ error: 'items array is required' });
  if (rows.length > 20000) return res.status(400).json({ error: 'Import at most 20,000 rows at a time' });
  const keys = Object.keys(ITEM_FIELD_COLUMNS).filter((k) => !['addedBy', 'lastEditedBy', 'photo'].includes(k));
  const cols = ['id', ...keys.map((k) => ITEM_FIELD_COLUMNS[k]), 'added_by', 'last_edited_by'];
  const stmt = db.prepare(`INSERT INTO storage_items (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`);
  const who = req.user.name || null;
  const clean = (v) => (v == null ? null : (String(v).trim() || null));
  let imported = 0;
  db.transaction(() => {
    rows.forEach((r) => {
      if (!r || typeof r !== 'object') return;
      const vals = keys.map((k) => {
        if (k === 'startDate' || k === 'endDate') return parseLocalDate(r[k]);
        if (k === 'priceWeek') return toNumberOrNull(r[k]);
        if (k === 'quantity') { const n = toNumberOrNull(r[k]); return n == null ? clean(r[k]) : String(n); }
        return clean(r[k]);
      });
      if (vals.every((v) => v == null)) return;
      stmt.run(randomUUID(), ...vals, who, who);
      imported += 1;
    });
  })();
  res.status(201).json({ ok: true, imported });
});

// Model cleanup (old bulkRenameModel): sets Model only; Make is left alone.
router.post('/items/rename-model', (req, res) => {
  const { ids, model } = req.body || {};
  const name = String(model || '').trim();
  if (!name) return res.status(400).json({ error: 'A new model name is required' });
  if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'ids array is required' });
  const stmt = db.prepare("UPDATE storage_items SET model = ?, last_edited_by = ?, updated_at = datetime('now') WHERE id = ?");
  let updated = 0;
  db.transaction(() => { ids.forEach((id) => { updated += stmt.run(name, req.user.name || null, id).changes; }); })();
  res.json({ ok: true, updated });
});

router.get('/model-summary', (req, res) => {
  res.json({ models: modelSummary(req.query.client && req.query.client !== '__ALL__' ? req.query.client : null) });
});

// Match & update from a spreadsheet (old updateFieldByRowMap): the client sends
// serial + value pairs read from the sheet; every item whose serial matches
// (trimmed, ignoring case) gets that value in one field. Blank values are
// skipped. dryRun returns the preview without changing anything.
const MATCH_FIELDS = ['referenceNumber', 'jobNumber', 'poNumber', 'orderNumber', 'assetTag', 'client', 'storageCentre', 'location', 'condition', 'item', 'make', 'model', 'quantity', 'priceWeek', 'startDate', 'endDate'];
router.post('/items/match-update', (req, res) => {
  const { field, rows, dryRun } = req.body || {};
  if (!MATCH_FIELDS.includes(field)) return res.status(400).json({ error: 'Choose a field to update' });
  if (!Array.isArray(rows) || rows.length === 0) return res.status(400).json({ error: 'No rows to match' });
  if (rows.length > 20000) return res.status(400).json({ error: 'At most 20,000 rows at a time' });
  const bySerial = new Map();
  db.prepare("SELECT id, serial FROM storage_items WHERE serial IS NOT NULL AND trim(serial) != ''").all().forEach((r) => {
    const k = String(r.serial).trim().toUpperCase();
    if (!bySerial.has(k)) bySerial.set(k, []);
    bySerial.get(k).push(r.id);
  });
  const convert = (v) => {
    if (field === 'startDate' || field === 'endDate') return parseLocalDate(v);
    if (field === 'priceWeek') return toNumberOrNull(v);
    return String(v).trim();
  };
  const updates = []; const unmatched = []; const multi = []; const badValues = [];
  let blank = 0; let noSerial = 0;
  rows.forEach((r) => {
    const serial = String(r?.serial ?? '').trim().toUpperCase();
    if (!serial) { noSerial += 1; return; }
    const raw = r?.value;
    if (raw == null || String(raw).trim() === '') { blank += 1; return; }
    const ids = bySerial.get(serial);
    if (!ids) { unmatched.push(String(r.serial).trim()); return; }
    const value = convert(raw);
    if (value == null) { badValues.push(`${String(r.serial).trim()}: ${raw}`); return; }
    if (ids.length > 1) multi.push({ serial: String(r.serial).trim(), count: ids.length });
    ids.forEach((id) => updates.push([id, value]));
  });
  const summary = {
    field, rows: rows.length, matchedRows: rows.length - blank - noSerial - unmatched.length - badValues.length, itemsToUpdate: updates.length,
    blank, noSerial, unmatched: unmatched.slice(0, 50), unmatchedCount: unmatched.length, multi: multi.slice(0, 50), multiCount: multi.length,
    badValues: badValues.slice(0, 20), badValueCount: badValues.length,
  };
  if (dryRun) return res.json({ ...summary, updated: 0 });
  const stmt = db.prepare(`UPDATE storage_items SET ${ITEM_FIELD_COLUMNS[field]} = ?, last_edited_by = ?, updated_at = datetime('now') WHERE id = ?`);
  let updated = 0;
  db.transaction(() => { updates.forEach(([id, v]) => { updated += stmt.run(v, req.user.name || null, id).changes; }); })();
  res.json({ ...summary, updated });
});

router.patch('/items/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM storage_items WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Item not found' });
  const b = req.body || {};
  const sets = [];
  const vals = [];
  Object.keys(ITEM_FIELD_COLUMNS).forEach((k) => {
    if (b[k] !== undefined) { sets.push(`${ITEM_FIELD_COLUMNS[k]} = ?`); vals.push(b[k]); }
  });
  if (sets.length === 0) return res.status(400).json({ error: 'Nothing to update' });
  sets.push("updated_at = datetime('now')");
  vals.push(req.params.id);
  db.prepare(`UPDATE storage_items SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  const row = db.prepare('SELECT * FROM storage_items WHERE id = ?').get(req.params.id);
  res.json({ item: rowToItem(row) });
});

router.delete('/items/:id', (req, res) => {
  if (!isAdmin(req.user.id)) return res.status(403).json({ error: 'Only admins can delete items' });
  const result = db.prepare('DELETE FROM storage_items WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Item not found' });
  res.json({ ok: true });
});

router.post('/items/bulk-delete', (req, res) => {
  if (!isAdmin(req.user.id)) return res.status(403).json({ error: 'Only admins can delete items' });
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'ids array is required' });
  let deleted = 0;
  ids.forEach((id) => { deleted += db.prepare('DELETE FROM storage_items WHERE id = ?').run(id).changes; });
  res.json({ ok: true, deleted });
});

// Item notes, keyed like the old app's ItemNotes sheet: "item:<id>" for one
// item, or "<field>:<value>" (e.g. "client:HP", "location:Pallet 3") for a group,
// so a note on a client shows on every one of that client's items.
router.get('/item-notes', (req, res) => {
  const keys = (req.query.keys || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (keys.length === 0) return res.json({ notes: [] });
  const placeholders = keys.map(() => '?').join(', ');
  const rows = db.prepare(`SELECT * FROM storage_item_notes WHERE item_key IN (${placeholders}) ORDER BY created_at DESC`).all(...keys);
  res.json({ notes: rows });
});

router.post('/item-notes', (req, res) => {
  const itemKey = String(req.body?.itemKey || '').trim();
  const note = String(req.body?.note || '').trim();
  if (!itemKey || !note) return res.status(400).json({ error: 'Write a note before adding it.' });
  if (note.length > 4000) return res.status(400).json({ error: 'Notes can be at most 4,000 characters' });
  const id = randomUUID();
  db.prepare('INSERT INTO storage_item_notes (id, item_key, note, author) VALUES (?, ?, ?, ?)')
    .run(id, itemKey, note, req.user.name || null);
  res.status(201).json({ note: db.prepare('SELECT * FROM storage_item_notes WHERE id = ?').get(id) });
});

// ---------------------------------------------------------------------------
// Pallets
// ---------------------------------------------------------------------------

function rowToPallet(row) {
  if (!row) return row;
  return {
    id: row.id, client: row.client, storageCentre: row.storage_centre, location: row.location,
    priceWeek: row.price_week, startDate: row.start_date, endDate: row.end_date, notes: row.notes,
    addedBy: row.added_by, lastEditedBy: row.last_edited_by,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}
const PALLET_FIELD_COLUMNS = {
  client: 'client', storageCentre: 'storage_centre', location: 'location', priceWeek: 'price_week',
  startDate: 'start_date', endDate: 'end_date', notes: 'notes', addedBy: 'added_by', lastEditedBy: 'last_edited_by',
};

router.get('/pallets', (req, res) => {
  res.json({ pallets: db.prepare('SELECT * FROM storage_pallets ORDER BY created_at').all().map(rowToPallet) });
});

router.post('/pallets', (req, res) => {
  const b = req.body || {};
  const id = randomUUID();
  const cols = ['id', ...Object.keys(PALLET_FIELD_COLUMNS).map((k) => PALLET_FIELD_COLUMNS[k])];
  const vals = [id, ...Object.keys(PALLET_FIELD_COLUMNS).map((k) => b[k] ?? null)];
  db.prepare(`INSERT INTO storage_pallets (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...vals);
  res.status(201).json({ pallet: rowToPallet(db.prepare('SELECT * FROM storage_pallets WHERE id = ?').get(id)) });
});

router.patch('/pallets/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM storage_pallets WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Pallet not found' });
  const b = req.body || {};
  const sets = [];
  const vals = [];
  Object.keys(PALLET_FIELD_COLUMNS).forEach((k) => {
    if (b[k] !== undefined) { sets.push(`${PALLET_FIELD_COLUMNS[k]} = ?`); vals.push(b[k]); }
  });
  if (sets.length === 0) return res.status(400).json({ error: 'Nothing to update' });
  sets.push("updated_at = datetime('now')");
  vals.push(req.params.id);
  db.prepare(`UPDATE storage_pallets SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  res.json({ pallet: rowToPallet(db.prepare('SELECT * FROM storage_pallets WHERE id = ?').get(req.params.id)) });
});

router.delete('/pallets/:id', (req, res) => {
  if (!isAdmin(req.user.id)) return res.status(403).json({ error: 'Only admins can delete pallets' });
  const result = db.prepare('DELETE FROM storage_pallets WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Pallet not found' });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Clients (storage clients — the client-portal accounts, not Work Desk staff)
// ---------------------------------------------------------------------------

function rowToClient(row) {
  if (!row) return row;
  return { id: row.id, clientName: row.client_name, username: row.username, hasPortalLogin: !!row.password_hash, addedBy: row.added_by, createdAt: row.created_at };
}

// The client list (like the old app's Clients sheet) plus, under `unlisted`,
// every other client name used on items, pallets, orders or receiving/dispatch
// entries, so nobody is missing from the page just because they were never
// added to the list. Names are compared ignoring case and extra spaces.
router.get('/clients', (req, res) => {
  const key = (s) => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();
  const itemCounts = {};
  db.prepare("SELECT client, COUNT(*) AS total, SUM(CASE WHEN start_date IS NOT NULL AND end_date IS NULL THEN 1 ELSE 0 END) AS in_storage FROM storage_items WHERE client IS NOT NULL AND trim(client) != '' GROUP BY client").all()
    .forEach((r) => {
      const k = key(r.client);
      const c = itemCounts[k] || (itemCounts[k] = { names: new Set(), total: 0, inStorage: 0 });
      c.names.add(r.client.trim()); c.total += r.total; c.inStorage += r.in_storage || 0;
    });
  const listed = db.prepare('SELECT * FROM storage_clients ORDER BY client_name COLLATE NOCASE').all();
  const listedKeys = new Set(listed.map((c) => key(c.client_name)));
  const clients = listed.map((c) => ({ ...rowToClient(c), itemCount: itemCounts[key(c.client_name)]?.total || 0, inStorageCount: itemCounts[key(c.client_name)]?.inStorage || 0 }));

  const others = new Map();
  const note = (name, source) => {
    const clean = String(name || '').trim().replace(/\s+/g, ' ');
    const k = key(clean);
    if (!k || listedKeys.has(k)) return;
    if (!others.has(k)) others.set(k, { clientName: clean, sources: new Set() });
    others.get(k).sources.add(source);
  };
  Object.values(itemCounts).forEach((c) => c.names.forEach((n) => note(n, 'items')));
  db.prepare("SELECT DISTINCT client FROM storage_pallets WHERE client IS NOT NULL").all().forEach((r) => note(r.client, 'pallet rates'));
  db.prepare("SELECT DISTINCT client FROM storage_orders WHERE client IS NOT NULL").all().forEach((r) => note(r.client, 'orders'));
  db.prepare("SELECT DISTINCT client FROM storage_receiving_dispatch WHERE client IS NOT NULL").all().forEach((r) => note(r.client, 'receiving/dispatch'));
  const unlisted = [...others.entries()].map(([k, o]) => ({
    clientName: o.clientName, sources: [...o.sources], itemCount: itemCounts[k]?.total || 0, inStorageCount: itemCounts[k]?.inStorage || 0,
  })).sort((a, b) => a.clientName.localeCompare(b.clientName, undefined, { sensitivity: 'base' }));

  res.json({ clients, unlisted });
});

const PORTAL_MIN_PASSWORD = 8;

// Usernames are matched case-insensitively at portal login, so they must be
// unique ignoring case. Returns an error message, or null if OK.
function checkPortalLogin(username, password, exceptId) {
  if (username) {
    if (!/^[A-Za-z0-9._@-]{3,64}$/.test(username)) return 'Usernames are 3–64 characters: letters, numbers, . _ @ -';
    const clash = db.prepare('SELECT id FROM storage_clients WHERE lower(username) = lower(?) AND id != ?').get(username, exceptId || '');
    if (clash) return 'That username is already used by another client';
  }
  if (password && password.length < PORTAL_MIN_PASSWORD) return `Portal passwords must be at least ${PORTAL_MIN_PASSWORD} characters`;
  return null;
}

router.post('/clients', (req, res) => {
  const { clientName, password } = req.body;
  const username = req.body.username ? String(req.body.username).trim() : null;
  if (!clientName || !clientName.trim()) return res.status(400).json({ error: 'A client name is required' });
  const existing = db.prepare('SELECT id FROM storage_clients WHERE lower(trim(client_name)) = lower(?)').get(clientName.trim());
  if (existing) return res.status(400).json({ error: 'A client with this name already exists' });
  if (password && !username) return res.status(400).json({ error: 'Set a username to go with the portal password' });
  const problem = checkPortalLogin(username, password);
  if (problem) return res.status(400).json({ error: problem });
  const id = randomUUID();
  const passwordHash = password ? bcrypt.hashSync(password, 10) : null;
  db.prepare('INSERT INTO storage_clients (id, client_name, username, password_hash, added_by) VALUES (?, ?, ?, ?, ?)')
    .run(id, clientName.trim(), username || null, passwordHash, req.user.name);
  res.status(201).json({ client: rowToClient(db.prepare('SELECT * FROM storage_clients WHERE id = ?').get(id)) });
});

router.patch('/clients/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM storage_clients WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Client not found' });
  const { clientName, password, removePortalAccess } = req.body;
  const username = req.body.username === undefined ? undefined : (req.body.username ? String(req.body.username).trim() : null);
  const problem = checkPortalLogin(username, password, existing.id);
  if (problem) return res.status(400).json({ error: problem });
  const finalUsername = username === undefined ? existing.username : username;
  if (password && !finalUsername) return res.status(400).json({ error: 'Set a username to go with the portal password' });
  const sets = [];
  const vals = [];
  if (clientName !== undefined) {
    if (!String(clientName).trim()) return res.status(400).json({ error: 'A client name is required' });
    const clash = db.prepare('SELECT id FROM storage_clients WHERE client_name = ? AND id != ?').get(String(clientName).trim(), existing.id);
    if (clash) return res.status(400).json({ error: 'A client with this name already exists' });
    sets.push('client_name = ?'); vals.push(String(clientName).trim());
  }
  if (username !== undefined) { sets.push('username = ?'); vals.push(username); }
  if (removePortalAccess) { sets.push('password_hash = NULL'); }
  else if (password) { sets.push('password_hash = ?'); vals.push(bcrypt.hashSync(password, 10)); }
  if (sets.length === 0) return res.status(400).json({ error: 'Nothing to update' });
  vals.push(req.params.id);
  db.prepare(`UPDATE storage_clients SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  res.json({ client: rowToClient(db.prepare('SELECT * FROM storage_clients WHERE id = ?').get(req.params.id)) });
});

router.delete('/clients/:id', (req, res) => {
  if (!isAdmin(req.user.id)) return res.status(403).json({ error: 'Only admins can delete clients' });
  const result = db.prepare('DELETE FROM storage_clients WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Client not found' });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Client Orders — including the Delivered-status tracking email step
// ---------------------------------------------------------------------------

function rowToOrder(row) {
  if (!row) return row;
  return {
    id: row.id, orderNumber: row.order_number, client: row.client, devices: row.devices,
    deliveryAddress: row.delivery_address, siteContactName: row.site_contact_name,
    siteContactPhone: row.site_contact_phone, dateToBeDelivered: row.date_to_be_delivered,
    configInformation: row.config_information, notes: row.notes, requestor: row.requestor,
    status: row.status, trackingNumber: row.tracking_number,
    trackingEmailSentTo: row.tracking_email_sent_to, trackingEmailSentAt: row.tracking_email_sent_at,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

router.get('/orders', (req, res) => {
  res.json({ orders: db.prepare('SELECT * FROM storage_orders ORDER BY created_at DESC').all().map(rowToOrder) });
});

router.post('/orders', (req, res) => {
  const b = req.body || {};
  if (!b.client) return res.status(400).json({ error: 'client is required' });
  const id = randomUUID();
  const orderNumber = nextStorageOrderNumber();
  db.prepare(`INSERT INTO storage_orders
    (id, order_number, client, devices, delivery_address, site_contact_name, site_contact_phone, date_to_be_delivered, config_information, notes, requestor, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'In Progress')`)
    .run(id, orderNumber, b.client, b.devices || null, b.deliveryAddress || null, b.siteContactName || null,
      b.siteContactPhone || null, b.dateToBeDelivered || null, b.configInformation || null, b.notes || null, b.requestor || req.user.name);
  const order = db.prepare('SELECT * FROM storage_orders WHERE id = ?').get(id);

  // Internal "new order placed" email to the team (see storageNotify.js for the list).
  const notifyList = orderNotifyList();
  if (notifyList.length) {
    notifyStorageOrderSubmitted({
      toEmails: notifyList, orderNumber, clientName: b.client, devices: b.devices,
      deliveryAddress: b.deliveryAddress, dateToBeDelivered: b.dateToBeDelivered,
      siteContactName: b.siteContactName, siteContactPhone: b.siteContactPhone,
      configInformation: b.configInformation, notes: b.notes, requestor: order.requestor,
    }).catch((err) => console.error('[storage] order-submitted notify failed:', err.message));
  }

  res.status(201).json({ order: rowToOrder(order) });
});

// Plain status/field update — does NOT send the tracking email. Changing status to
// "Delivered" from the UI should go through POST /orders/:id/deliver instead, which
// sends (or skips) the tracking email and then applies the same status change.
// The old app's statuses (In Progress / Delivered / Cancelled), plus Pending for
// orders created before the move.
const ORDER_STATUSES = ['Pending', 'In Progress', 'Delivered', 'Cancelled'];
router.patch('/orders/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM storage_orders WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Order not found' });
  const map = {
    client: 'client', devices: 'devices', deliveryAddress: 'delivery_address',
    siteContactName: 'site_contact_name', siteContactPhone: 'site_contact_phone',
    dateToBeDelivered: 'date_to_be_delivered', configInformation: 'config_information',
    notes: 'notes', requestor: 'requestor', status: 'status',
  };
  const b = req.body || {};
  if (b.status !== undefined && !ORDER_STATUSES.includes(b.status)) {
    return res.status(400).json({ error: `status must be one of: ${ORDER_STATUSES.join(', ')}` });
  }
  const sets = [];
  const vals = [];
  Object.keys(map).forEach((k) => { if (b[k] !== undefined) { sets.push(`${map[k]} = ?`); vals.push(b[k]); } });
  if (sets.length === 0) return res.status(400).json({ error: 'Nothing to update' });
  sets.push("updated_at = datetime('now')");
  vals.push(req.params.id);
  db.prepare(`UPDATE storage_orders SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  res.json({ order: rowToOrder(db.prepare('SELECT * FROM storage_orders WHERE id = ?').get(req.params.id)) });
});

// Marks an order Delivered. Optionally sends the "your order is on its way" email
// first (manual recipient address + tracking number, matching the original Apps
// Script app's modal) — pass `skipEmail: true` for the "Skip" button path.
router.post('/orders/:id/deliver', async (req, res) => {
  const existing = db.prepare('SELECT * FROM storage_orders WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Order not found' });
  const { skipEmail, toEmail, trackingNumber, message } = req.body || {};

  if (!skipEmail) {
    // One or more addresses: an array, or text separated by commas, semicolons,
    // spaces or new lines. Tracking number is optional, as in the old app.
    const raw = Array.isArray(toEmail) ? toEmail.join(',') : String(toEmail || '');
    const seen = new Set();
    const recipients = raw.split(/[\s,;]+/).map((a) => a.trim()).filter(Boolean)
      .filter((a) => { const k = a.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
    const bad = recipients.filter((a) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a));
    if (!recipients.length) return res.status(400).json({ error: 'A valid customer email is required unless skipEmail is true' });
    if (bad.length) return res.status(400).json({ error: `Not a valid email address: ${bad.join(', ')}` });
    if (recipients.length > 20) return res.status(400).json({ error: 'Up to 20 email addresses at a time' });
    const sentTo = recipients.join(', ');
    try {
      await notifyStorageOrderTracking({
        toEmail: sentTo, orderNumber: existing.order_number, clientName: existing.client, trackingNumber: trackingNumber || '', message,
      });
    } catch (err) {
      console.error('[storage] tracking email failed:', err.message);
      return res.status(502).json({ error: 'Could not send the tracking email. The order was not marked Delivered — try again or use Skip.' });
    }
    db.prepare(`UPDATE storage_orders SET status = 'Delivered', tracking_number = ?, tracking_email_sent_to = ?, tracking_email_sent_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`)
      .run(trackingNumber || null, sentTo, req.params.id);
  } else {
    db.prepare(`UPDATE storage_orders SET status = 'Delivered', updated_at = datetime('now') WHERE id = ?`).run(req.params.id);
  }

  res.json({ order: rowToOrder(db.prepare('SELECT * FROM storage_orders WHERE id = ?').get(req.params.id)) });
});

function sendPdf(res, buffer, filename, download) {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `${download ? 'attachment' : 'inline'}; filename="${filename.replace(/[^A-Za-z0-9._-]+/g, '_')}"`);
  res.send(buffer);
}

router.get('/orders/:id/pdf', async (req, res) => {
  const row = db.prepare('SELECT * FROM storage_orders WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Order not found' });
  try {
    const order = rowToOrder(row);
    sendPdf(res, await buildOrderPdf(order), `${order.orderNumber || 'order'}.pdf`, req.query.download === '1');
  } catch (err) {
    console.error('[storage] order PDF failed:', err);
    res.status(500).json({ error: 'Could not generate the order PDF' });
  }
});

// "Send to dispatch" — the old app's sendOrderToDispatch: marks the order
// Delivered (no tracking email; that stays a separate step), sets the storage
// end date on the manifest items whose serial exactly matches one of the
// order's devices and are still in storage, and returns what the dispatch
// entry should be pre-filled with. Matching is by exact serial only (case-
// insensitive), and only within the order's own client, so it can never close
// out another client's stock.
function orderDeviceTokens(devices) {
  return String(devices || '').split(/[,\n]/).map((t) => t.trim())
    // Portal orders list devices as "SERIAL — Make Model (Location)"; the serial is the first part.
    .map((t) => t.split(/\s+—\s+/)[0].trim())
    .filter(Boolean);
}

router.post('/orders/:id/dispatch', (req, res) => {
  const order = db.prepare('SELECT * FROM storage_orders WHERE id = ?').get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  const endDate = /^\d{4}-\d{2}-\d{2}$/.test(String(req.body?.endDate || ''))
    ? req.body.endDate
    : new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney' }).format(new Date());

  const tokens = [...new Set(orderDeviceTokens(order.devices))];
  const findInStorage = db.prepare(`SELECT id, serial FROM storage_items WHERE lower(trim(client)) = lower(trim(?)) AND upper(trim(serial)) = upper(?)
    AND start_date IS NOT NULL AND start_date != '' AND (end_date IS NULL OR end_date = '')`);
  const findOut = db.prepare("SELECT 1 FROM storage_items WHERE lower(trim(client)) = lower(trim(?)) AND upper(trim(serial)) = upper(?) AND end_date IS NOT NULL AND end_date != ''");
  const setEnd = db.prepare("UPDATE storage_items SET end_date = ?, last_edited_by = ?, updated_at = datetime('now') WHERE id = ?");
  const matched = []; const unmatched = [];
  db.transaction(() => {
    tokens.forEach((t) => {
      const rows = findInStorage.all(order.client, t);
      if (rows.length) { rows.forEach((r) => setEnd.run(endDate, req.user.name, r.id)); matched.push(t); }
      else unmatched.push(findOut.get(order.client, t) ? `${t} (already out of storage)` : t);
    });
    if (order.status !== 'Delivered') {
      db.prepare("UPDATE storage_orders SET status = 'Delivered', updated_at = datetime('now') WHERE id = ?").run(order.id);
    }
  })();

  const notes = [
    `Dispatched from Order ${order.order_number || ''}`,
    `Devices: ${order.devices || ''}`,
    order.delivery_address ? `Delivery address: ${order.delivery_address}` : null,
    order.site_contact_name ? `Site contact: ${order.site_contact_name}` : null,
  ].filter(Boolean).join('\n');

  res.json({
    order: rowToOrder(db.prepare('SELECT * FROM storage_orders WHERE id = ?').get(order.id)),
    endDate, deviceCount: tokens.length, matched, unmatched,
    dispatchPrefill: {
      client: order.client, dateDispatched: endDate,
      stockDispatchedType: `Individual Item: ${tokens.length || 1} @ $5`, stockDispatchedQty: String(tokens.length || 1),
      dispatch: notes,
    },
  });
});

router.delete('/orders/:id', (req, res) => {
  if (!isAdmin(req.user.id)) return res.status(403).json({ error: 'Only admins can delete orders' });
  const result = db.prepare('DELETE FROM storage_orders WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Order not found' });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Lists — distinct values used to populate dropdowns client-side (clients,
// storage centres, locations), mirroring the old app's getLists().
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Locations registry — classifies a Location *text* (not per storage centre)
// as a real pallet or a placeholder, matching the old app's rate-lookup logic.
// ---------------------------------------------------------------------------

function normalizeLocationKey(s) {
  return String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

router.get('/locations-registry', (req, res) => {
  const rows = db.prepare('SELECT * FROM storage_locations_registry ORDER BY location').all();
  res.json({ locations: rows.map((r) => ({ location: r.location, isPallet: !!r.is_pallet, classifiedBy: r.classified_by, classifiedOn: r.classified_on })) });
});

// Every location that is classified OR in use (on an item or a pallet record),
// with how many items currently sit there and for which clients — so staff can
// see what still needs classifying. "Current" = no end date.
router.get('/locations-registry/overview', (req, res) => {
  const byKey = new Map();
  const entry = (loc) => {
    const clean = String(loc || '').trim().replace(/\s+/g, ' ');
    if (!clean) return null;
    const key = normalizeLocationKey(clean);
    if (!byKey.has(key)) {
      byKey.set(key, { location: clean, classified: false, isPallet: false, classifiedBy: null, classifiedOn: null, itemCount: 0, currentItemCount: 0, palletRecords: 0, clients: new Set(), storageCentres: new Set() });
    }
    return byKey.get(key);
  };
  db.prepare('SELECT * FROM storage_locations_registry').all().forEach((r) => {
    const e = entry(r.location);
    if (!e) return;
    e.location = r.location;
    Object.assign(e, { classified: true, isPallet: !!r.is_pallet, classifiedBy: r.classified_by, classifiedOn: r.classified_on });
  });
  db.prepare("SELECT location, client, storage_centre, end_date FROM storage_items WHERE location IS NOT NULL AND location != ''").all().forEach((r) => {
    const e = entry(r.location);
    if (!e) return;
    e.itemCount += 1;
    if (!r.end_date) e.currentItemCount += 1;
    if (r.client) e.clients.add(r.client);
    if (r.storage_centre) e.storageCentres.add(r.storage_centre);
  });
  db.prepare("SELECT location, client, storage_centre FROM storage_pallets WHERE location IS NOT NULL AND location != '' AND location NOT IN (?, ?)")
    .all(ALL_PALLETS, ALL_PALLETS_AT_CENTRE).forEach((r) => {
      const e = entry(r.location);
      if (!e) return;
      e.palletRecords += 1;
      if (r.client) e.clients.add(r.client);
      if (r.storage_centre) e.storageCentres.add(r.storage_centre);
    });
  const locations = [...byKey.values()]
    .map((e) => ({ ...e, clients: [...e.clients].sort(), storageCentres: [...e.storageCentres].sort() }))
    .sort((a, b) => a.location.localeCompare(b.location, undefined, { numeric: true, sensitivity: 'base' }));
  res.json({ locations });
});

// Removes a classification only — items stay where they are; the location just
// shows as unclassified again.
router.delete('/locations-registry', (req, res) => {
  if (!isAdmin(req.user.id)) return res.status(403).json({ error: 'Only admins can remove classifications' });
  const key = normalizeLocationKey(req.query.location);
  if (!key) return res.status(400).json({ error: 'location is required' });
  const result = db.prepare('DELETE FROM storage_locations_registry WHERE location_key = ?').run(key);
  if (result.changes === 0) return res.status(404).json({ error: 'That location is not classified' });
  res.json({ ok: true });
});

router.post('/locations-registry', (req, res) => {
  const { location, isPallet } = req.body;
  const clean = String(location || '').trim().replace(/\s+/g, ' ');
  if (!clean) return res.status(400).json({ error: 'A location is required' });
  const key = normalizeLocationKey(clean);
  const existing = db.prepare('SELECT id FROM storage_locations_registry WHERE location_key = ?').get(key);
  if (existing) {
    db.prepare("UPDATE storage_locations_registry SET is_pallet = ?, classified_by = ?, classified_on = datetime('now') WHERE id = ?")
      .run(isPallet ? 1 : 0, req.user.name, existing.id);
  } else {
    db.prepare('INSERT INTO storage_locations_registry (id, location, location_key, is_pallet, classified_by) VALUES (?, ?, ?, ?, ?)')
      .run(randomUUID(), clean, key, isPallet ? 1 : 0, req.user.name);
  }
  res.status(201).json({ ok: true });
});

// Bring across the old app's LocationsRegistry sheet (Location, Is Pallet,
// Classified By, ...). Rows are matched the same way as above (spaces collapsed,
// case ignored). A location already classified here keeps its Work Desk answer
// unless overwrite is set. dryRun returns the counts without saving.
const truthy = (v) => v === true || /^(true|yes|y|1|pallet)$/i.test(String(v ?? '').trim());
router.post('/locations-registry/import', (req, res) => {
  const { rows, dryRun, overwrite } = req.body || {};
  if (!Array.isArray(rows) || rows.length === 0) return res.status(400).json({ error: 'No rows to import' });
  if (rows.length > 20000) return res.status(400).json({ error: 'At most 20,000 rows at a time' });
  const existing = new Map(db.prepare('SELECT id, location_key, is_pallet FROM storage_locations_registry').all().map((r) => [r.location_key, r]));
  const seen = new Map();
  let blank = 0;
  rows.forEach((r) => {
    const clean = String(r?.location ?? '').trim().replace(/\s+/g, ' ');
    if (!clean) { blank += 1; return; }
    seen.set(normalizeLocationKey(clean), { clean, isPallet: truthy(r?.isPallet), by: String(r?.classifiedBy ?? '').trim() || null });
  });
  const toAdd = []; const toChange = []; let same = 0; let keptHere = 0;
  seen.forEach((v, key) => {
    const cur = existing.get(key);
    if (!cur) toAdd.push([key, v]);
    else if (!!cur.is_pallet === v.isPallet) same += 1;
    else if (overwrite) toChange.push([cur.id, v]);
    else keptHere += 1;
  });
  // In-use locations that would still be unclassified afterwards.
  const after = new Set([...existing.keys(), ...seen.keys()]);
  const stillUnclassified = new Set();
  db.prepare("SELECT location FROM storage_items WHERE location IS NOT NULL AND trim(location) != '' AND start_date IS NOT NULL AND end_date IS NULL").all()
    .forEach((r) => { const k = normalizeLocationKey(r.location); if (!after.has(k)) stillUnclassified.add(r.location.trim().replace(/\s+/g, ' ')); });
  const summary = {
    rows: rows.length, blank, locations: seen.size, toAdd: toAdd.length, toChange: toChange.length, same, keptHere,
    pallets: [...seen.values()].filter((v) => v.isPallet).length,
    stillUnclassified: [...stillUnclassified].sort().slice(0, 100), stillUnclassifiedCount: stillUnclassified.size,
  };
  if (dryRun) return res.json({ ...summary, saved: 0 });
  const ins = db.prepare('INSERT INTO storage_locations_registry (id, location, location_key, is_pallet, classified_by) VALUES (?, ?, ?, ?, ?)');
  const upd = db.prepare("UPDATE storage_locations_registry SET is_pallet = ?, classified_by = ?, classified_on = datetime('now') WHERE id = ?");
  let saved = 0;
  db.transaction(() => {
    toAdd.forEach(([key, v]) => { saved += ins.run(randomUUID(), v.clean, key, v.isPallet ? 1 : 0, v.by || `${req.user.name} (old app)`).changes; });
    toChange.forEach(([id, v]) => { saved += upd.run(v.isPallet ? 1 : 0, v.by || `${req.user.name} (old app)`, id).changes; });
  })();
  res.json({ ...summary, saved });
});

// ---------------------------------------------------------------------------
// Receiving / Dispatch log
// ---------------------------------------------------------------------------

// Fees (rate x qty, or the old app's "Type: Qty @ $Rate" text) come from
// storageBilling.js so Reports, invoices and the client portal agree.

function rowToRD(row) {
  if (!row) return row;
  const fees = rdFees(row);
  return {
    id: row.id, client: row.client, dateReceived: row.date_received, dateDispatched: row.date_dispatched,
    rate: row.rate, stockReceivedType: row.stock_received_type, stockReceivedQty: row.stock_received_qty,
    stockDispatchedType: row.stock_dispatched_type, stockDispatchedQty: row.stock_dispatched_qty,
    receiving: row.receiving, dispatch: row.dispatch, savedBy: row.saved_by, savedOn: row.saved_on,
    feeReceived: fees.received, feeDispatched: fees.dispatched, fee: fees.total,
  };
}

// Body field -> column, for POST and PATCH. Empty strings become NULL.
const RD_FIELDS = {
  client: 'client', dateReceived: 'date_received', dateDispatched: 'date_dispatched', rate: 'rate',
  stockReceivedType: 'stock_received_type', stockReceivedQty: 'stock_received_qty',
  stockDispatchedType: 'stock_dispatched_type', stockDispatchedQty: 'stock_dispatched_qty',
  receiving: 'receiving', dispatch: 'dispatch',
};
function rdValue(field, v) {
  if (v === undefined || v === null || v === '') return null;
  if (field === 'rate') { const n = Number(v); return Number.isFinite(n) ? n : null; }
  return String(v).trim() || null;
}

router.get('/receiving-dispatch', (req, res) => {
  const { client } = req.query;
  const rows = client
    ? db.prepare('SELECT * FROM storage_receiving_dispatch WHERE client = ? ORDER BY saved_on DESC').all(client)
    : db.prepare('SELECT * FROM storage_receiving_dispatch ORDER BY saved_on DESC').all();
  res.json({ entries: rows.map(rowToRD) });
});

router.post('/receiving-dispatch', (req, res) => {
  const b = req.body || {};
  if (!b.client || !String(b.client).trim()) return res.status(400).json({ error: 'client is required' });
  const id = randomUUID();
  const v = (f) => rdValue(f, b[f]);
  db.prepare(`INSERT INTO storage_receiving_dispatch
    (id, client, date_received, date_dispatched, rate, stock_received_type, stock_received_qty, stock_dispatched_type, stock_dispatched_qty, receiving, dispatch, saved_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, v('client'), v('dateReceived'), v('dateDispatched'), v('rate'),
      v('stockReceivedType'), v('stockReceivedQty'), v('stockDispatchedType'), v('stockDispatchedQty'),
      v('receiving'), v('dispatch'), req.user.name);
  const entry = rowToRD(db.prepare('SELECT * FROM storage_receiving_dispatch WHERE id = ?').get(id));

  // Like the old app: email staff when an entry logs stock received (a
  // dispatch-only entry doesn't). Recipients come from STORAGE_RECEIVING_NOTIFY_EMAILS.
  // A failed email never fails the save — the entry is already logged.
  const receivingList = (process.env.STORAGE_RECEIVING_NOTIFY_EMAILS || '').split(',').map((x) => x.trim()).filter(Boolean);
  if (receivingList.length && (entry.stockReceivedType || entry.stockReceivedQty || entry.receiving || entry.dateReceived)) {
    notifyStorageStockReceived({ toEmails: receivingList, entry, loggedBy: req.user.name })
      .catch((err) => console.error('[storage] stock-received notify failed:', err.message));
  }

  res.status(201).json({ entry });
});

router.patch('/receiving-dispatch/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM storage_receiving_dispatch WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Entry not found' });
  const b = req.body || {};
  const sets = [];
  const params = [];
  for (const [field, col] of Object.entries(RD_FIELDS)) {
    if (!(field in b)) continue;
    const val = rdValue(field, b[field]);
    if (field === 'client' && !val) return res.status(400).json({ error: 'client cannot be blank' });
    sets.push(`${col} = ?`);
    params.push(val);
  }
  if (sets.length === 0) return res.status(400).json({ error: 'Nothing to update' });
  // saved_by / saved_on are left alone: they record who originally logged the
  // entry, exactly as the old app's updateReceivingDispatchEntry did.
  params.push(req.params.id);
  db.prepare(`UPDATE storage_receiving_dispatch SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  res.json({ entry: rowToRD(db.prepare('SELECT * FROM storage_receiving_dispatch WHERE id = ?').get(req.params.id)) });
});

router.delete('/receiving-dispatch/:id', (req, res) => {
  if (!isAdmin(req.user.id)) return res.status(403).json({ error: 'Only admins can delete entries' });
  const result = db.prepare('DELETE FROM storage_receiving_dispatch WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Entry not found' });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Reports — storage cost per client over a date range (rules in storageBilling.js,
// mirroring the old app's computeStorageCostForClient_) plus receiving/dispatch fees.
// ---------------------------------------------------------------------------

router.get('/reports/summary', (req, res) => {
  const { from, to } = req.query;
  if (!parsePeriod(from, to)) return res.status(400).json({ error: 'from and to (YYYY-MM-DD) are required, with from on or before to' });
  res.json(billingSummary(from, to));
});

// Line-by-line charges for one client — what the invoice PDF prints.
router.get('/reports/statement', (req, res) => {
  const { client, from, to } = req.query;
  if (!client) return res.status(400).json({ error: 'client is required' });
  if (!parsePeriod(from, to)) return res.status(400).json({ error: 'from and to (YYYY-MM-DD) are required, with from on or before to' });
  res.json(clientStatement(client, from, to));
});

// Sends last week's invoicing summary now (the Monday email), to the
// STORAGE_WEEKLY_REMINDER_EMAILS list — handy for checking it after setup.
router.post('/reports/weekly-reminder', async (req, res) => {
  if (!isAdmin(req.user.id)) return res.status(403).json({ error: 'Only admins can send the weekly summary' });
  if (!weeklyRecipients().length) return res.status(400).json({ error: 'Set STORAGE_WEEKLY_REMINDER_EMAILS on the server first.' });
  try {
    res.json(await sendWeeklyInvoicingReminder());
  } catch (err) {
    console.error('[storage] weekly reminder (manual) failed:', err);
    res.status(502).json({ error: 'Could not send the email' });
  }
});

router.get('/reports/invoice.pdf', async (req, res) => {
  if (!isAdmin(req.user.id)) return res.status(403).json({ error: 'Only admins can generate invoices' });
  const { client, from, to } = req.query;
  if (!client) return res.status(400).json({ error: 'client is required' });
  if (!parsePeriod(from, to)) return res.status(400).json({ error: 'from and to (YYYY-MM-DD) are required, with from on or before to' });
  try {
    const statement = clientStatement(client, from, to);
    sendPdf(res, await buildInvoicePdf(statement), `${invoiceReference(statement)}.pdf`, req.query.download === '1');
  } catch (err) {
    console.error('[storage] invoice PDF failed:', err);
    res.status(500).json({ error: 'Could not generate the invoice PDF' });
  }
});

// Receiving / dispatch invoicing (the old Invoicing tab's second section):
// receiving and dispatch fees per client for a period, with the lines behind them.
function rdReport(from, to, client) {
  const rows = db.prepare('SELECT * FROM storage_receiving_dispatch').all().filter((r) => !client || r.client === client);
  const byClient = {};
  rdLinesInPeriod(rows, from, to).forEach((l) => {
    if (!l.amount) return;
    const c = byClient[l.client || '(no client)'] || (byClient[l.client || '(no client)'] = { client: l.client || '(no client)', receiving: 0, dispatch: 0, lines: [] });
    if (l.kind === 'Receiving') c.receiving += l.amount; else c.dispatch += l.amount;
    c.lines.push(l);
  });
  const clients = Object.values(byClient)
    .map((c) => ({ ...c, receiving: round2(c.receiving), dispatch: round2(c.dispatch), total: round2(c.receiving + c.dispatch) }))
    .sort((a, b) => a.client.localeCompare(b.client, undefined, { sensitivity: 'base' }));
  return {
    from, to, clients,
    receiving: round2(clients.reduce((t, c) => t + c.receiving, 0)),
    dispatch: round2(clients.reduce((t, c) => t + c.dispatch, 0)),
    total: round2(clients.reduce((t, c) => t + c.total, 0)),
  };
}

router.get('/reports/rd', (req, res) => {
  const { from, to, client } = req.query;
  if (!parsePeriod(from, to)) return res.status(400).json({ error: 'from and to (YYYY-MM-DD) are required, with from on or before to' });
  res.json(rdReport(from, to, client || null));
});

router.get('/reports/rd-invoice.pdf', async (req, res) => {
  if (!isAdmin(req.user.id)) return res.status(403).json({ error: 'Only admins can generate invoices' });
  const { client, from, to } = req.query;
  if (!client) return res.status(400).json({ error: 'client is required' });
  if (!parsePeriod(from, to)) return res.status(400).json({ error: 'from and to (YYYY-MM-DD) are required, with from on or before to' });
  try {
    const report = rdReport(from, to, client);
    const c = report.clients[0] || { client, lines: [], total: 0 };
    const pdf = await buildRdInvoicePdf({ client, from, to, lines: c.lines, total: c.total });
    sendPdf(res, pdf, `RD-${invoiceReference({ client, to })}.pdf`, req.query.download === '1');
  } catch (err) {
    console.error('[storage] R/D invoice PDF failed:', err);
    res.status(500).json({ error: 'Could not generate the invoice PDF' });
  }
});

// Storage calculator (old Reports tab "Calculator").
router.get('/reports/calculator', (req, res) => {
  const { from, to, client, centre, groupBy } = req.query;
  if (!parsePeriod(from, to)) return res.status(400).json({ error: 'from and to (YYYY-MM-DD) are required, with from on or before to' });
  if (groupBy && !['all', 'location', 'none'].includes(groupBy)) return res.status(400).json({ error: 'groupBy must be all, location or none' });
  res.json(calculator({ from, to, client: client || null, centre: centre || null, groupBy: groupBy || 'all' }));
});

// Date presets (last week / month / quarter / year / financial year), Sydney time.
router.get('/reports/presets', (req, res) => {
  res.json({ presets: Object.fromEntries(PRESETS.map((p) => [p, presetRange(p)])) });
});

// Items costing $0/week with no pallet rate to cover them.
router.get('/billing-gaps', (req, res) => {
  res.json({ items: billingGaps() });
});

router.get('/dashboard', (req, res) => {
  res.json(dashboard());
});

// ---------------------------------------------------------------------------
// Restore Storage Centre data from a backup (admin). Only the Storage Centre
// tables are replaced; see storageRestore.js.
// ---------------------------------------------------------------------------
async function restoreSourceBuffer(body) {
  const { source, backupId, pointId, zipBase64 } = body || {};
  if (source === 'point') {
    const zip = storageRestore.restorePointZip(pointId);
    if (!zip) throw Object.assign(new Error('That restore point no longer exists'), { status: 404 });
    return zip;
  }
  if (source === 'onedrive') {
    if (!backupId) throw Object.assign(new Error('Choose a backup'), { status: 400 });
    return downloadBackup(backupId);
  }
  if (source === 'upload') {
    if (!zipBase64) throw Object.assign(new Error('Choose a backup file'), { status: 400 });
    return Buffer.from(String(zipBase64), 'base64');
  }
  throw Object.assign(new Error('Unknown backup source'), { status: 400 });
}

router.get('/restore/sources', async (req, res) => {
  if (!isAdmin(req.user.id)) return res.status(403).json({ error: 'Only admins can restore Storage Centre data' });
  let oneDrive = []; let oneDriveError = null;
  try {
    const r = await listBackups();
    if (r.ok) oneDrive = r.backups.filter((b) => /^storage-centre-.*\.zip$/i.test(b.name));
    else oneDriveError = r.reason === 'not_configured' ? 'OneDrive backups are not set up on this server.' : (r.error || 'Could not list OneDrive backups');
  } catch (err) { oneDriveError = err.message; }
  res.json({ restorePoints: storageRestore.listRestorePoints(), oneDrive, oneDriveError });
});

router.post('/restore/points', async (req, res) => {
  if (!isAdmin(req.user.id)) return res.status(403).json({ error: 'Only admins can do this' });
  const id = await storageRestore.saveRestorePoint(String(req.body?.reason || 'Saved by hand').slice(0, 200), req.user.name);
  res.status(201).json({ id, restorePoints: storageRestore.listRestorePoints() });
});

router.get('/restore/points/:id/download', (req, res) => {
  if (!isAdmin(req.user.id)) return res.status(403).json({ error: 'Only admins can do this' });
  const zip = storageRestore.restorePointZip(req.params.id);
  if (!zip) return res.status(404).json({ error: 'Restore point not found' });
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', 'attachment; filename="storage-centre-restore-point.zip"');
  res.send(zip);
});

router.post('/restore/preview', async (req, res) => {
  if (!isAdmin(req.user.id)) return res.status(403).json({ error: 'Only admins can restore Storage Centre data' });
  try {
    res.json(storageRestore.inspect(await restoreSourceBuffer(req.body)));
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

router.post('/restore', async (req, res) => {
  if (!isAdmin(req.user.id)) return res.status(403).json({ error: 'Only admins can restore Storage Centre data' });
  if (req.body?.confirm !== 'RESTORE') return res.status(400).json({ error: 'Type RESTORE to confirm' });
  try {
    const buffer = await restoreSourceBuffer(req.body);
    const result = await storageRestore.restore(buffer, { by: req.user.name, reason: 'Before restore' });
    console.log(`[storage] Storage Centre data restored by ${req.user.name}:`, JSON.stringify(result.restored));
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[storage] restore failed:', err.message);
    res.status(err.status || 400).json({ error: err.message });
  }
});

// Download every Storage Centre table as CSVs in a zip (the same file the nightly
// backup uploads to OneDrive), so admins can keep a copy without OneDrive.
router.get('/export.zip', async (req, res) => {
  if (!isAdmin(req.user.id)) return res.status(403).json({ error: 'Only admins can download the Storage Centre export' });
  try {
    const { buffer } = await buildStorageCentreZip();
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney' }).format(new Date());
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="storage-centre-${day}.zip"`);
    res.send(buffer);
  } catch (err) {
    console.error('[storage] export failed:', err);
    res.status(500).json({ error: 'Could not build the export' });
  }
});

router.get('/lists', (req, res) => {
  const clients = db.prepare("SELECT DISTINCT client FROM storage_items WHERE client IS NOT NULL AND client != '' UNION SELECT client_name FROM storage_clients ORDER BY client").all().map((r) => r.client);
  const storageCentres = db.prepare("SELECT DISTINCT storage_centre FROM storage_items WHERE storage_centre IS NOT NULL AND storage_centre != '' ORDER BY storage_centre").all().map((r) => r.storage_centre);
  const locations = db.prepare("SELECT DISTINCT location FROM storage_items WHERE location IS NOT NULL AND location != '' ORDER BY location").all().map((r) => r.location);
  res.json({ clients: [...new Set(clients)], storageCentres, locations });
});

module.exports = router;

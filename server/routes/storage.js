const express = require('express');
const { randomUUID } = require('crypto');
const bcrypt = require('bcryptjs');
const { db, nextStorageOrderNumber } = require('../db');
const { authRequired } = require('../auth');
const { isAdminRole } = require('../permissions');
const { notifyStorageOrderTracking, notifyStorageOrderSubmitted } = require('../email');
const {
  ALL_PALLETS, ALL_PALLETS_AT_CENTRE, rdFees, parsePeriod, summary: billingSummary, clientStatement,
} = require('../storageBilling');
const { buildOrderPdf, buildInvoicePdf, invoiceReference } = require('../storagePdf');
const { buildStorageCentreZip } = require('../storageExport');

const router = express.Router();
router.use(authRequired);

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

router.patch('/items/bulk-edit', (req, res) => {
  const { ids, updates } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'ids array is required' });
  if (!updates || typeof updates !== 'object') return res.status(400).json({ error: 'updates object is required' });
  const sets = [];
  const setVals = [];
  Object.keys(ITEM_FIELD_COLUMNS).forEach((k) => {
    if (updates[k] !== undefined) { sets.push(`${ITEM_FIELD_COLUMNS[k]} = ?`); setVals.push(updates[k]); }
  });
  if (sets.length === 0) return res.status(400).json({ error: 'Nothing to update' });
  sets.push("updated_at = datetime('now')");
  const stmt = db.prepare(`UPDATE storage_items SET ${sets.join(', ')} WHERE id = ?`);
  let updated = 0;
  ids.forEach((id) => { updated += stmt.run(...setVals, id).changes; });
  res.json({ ok: true, updated });
});

// Item notes (keyed by a free-text "item key", matching the old app's model —
// usually serial or asset tag) — lets staff leave a running log against an item.
router.get('/item-notes', (req, res) => {
  const keys = (req.query.keys || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (keys.length === 0) return res.json({ notes: [] });
  const placeholders = keys.map(() => '?').join(', ');
  const rows = db.prepare(`SELECT * FROM storage_item_notes WHERE item_key IN (${placeholders}) ORDER BY created_at DESC`).all(...keys);
  res.json({ notes: rows });
});

router.post('/item-notes', (req, res) => {
  const { itemKey, note, author } = req.body;
  if (!itemKey || !note) return res.status(400).json({ error: 'itemKey and note are required' });
  const id = randomUUID();
  db.prepare('INSERT INTO storage_item_notes (id, item_key, note, author) VALUES (?, ?, ?, ?)')
    .run(id, itemKey, note, author || req.user.name);
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

router.get('/clients', (req, res) => {
  res.json({ clients: db.prepare('SELECT * FROM storage_clients ORDER BY client_name').all().map(rowToClient) });
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
  const existing = db.prepare('SELECT id FROM storage_clients WHERE client_name = ?').get(clientName.trim());
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
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Pending')`)
    .run(id, orderNumber, b.client, b.devices || null, b.deliveryAddress || null, b.siteContactName || null,
      b.siteContactPhone || null, b.dateToBeDelivered || null, b.configInformation || null, b.notes || null, b.requestor || req.user.name);
  const order = db.prepare('SELECT * FROM storage_orders WHERE id = ?').get(id);

  // Internal notification — recipients configurable later; for now this is a no-op
  // unless STORAGE_NOTIFY_EMAILS is set, since there's no admin UI for it yet.
  const notifyList = (process.env.STORAGE_NOTIFY_EMAILS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (notifyList.length) {
    notifyStorageOrderSubmitted({
      toEmails: notifyList, orderNumber, clientName: b.client, devices: b.devices,
      deliveryAddress: b.deliveryAddress, dateToBeDelivered: b.dateToBeDelivered,
    }).catch((err) => console.error('[storage] order-submitted notify failed:', err.message));
  }

  res.status(201).json({ order: rowToOrder(order) });
});

// Plain status/field update — does NOT send the tracking email. Changing status to
// "Delivered" from the UI should go through POST /orders/:id/deliver instead, which
// sends (or skips) the tracking email and then applies the same status change.
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
    if (!toEmail || !trackingNumber) {
      return res.status(400).json({ error: 'toEmail and trackingNumber are required unless skipEmail is true' });
    }
    try {
      await notifyStorageOrderTracking({
        toEmail, orderNumber: existing.order_number, clientName: existing.client, trackingNumber, message,
      });
    } catch (err) {
      console.error('[storage] tracking email failed:', err.message);
      return res.status(502).json({ error: 'Could not send the tracking email. The order was not marked Delivered — try again or use Skip.' });
    }
    db.prepare(`UPDATE storage_orders SET status = 'Delivered', tracking_number = ?, tracking_email_sent_to = ?, tracking_email_sent_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`)
      .run(trackingNumber, toEmail, req.params.id);
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
  res.status(201).json({ entry: rowToRD(db.prepare('SELECT * FROM storage_receiving_dispatch WHERE id = ?').get(id)) });
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
  // saved_by / saved_on record the last person to save the entry, as in the old app.
  sets.push('saved_by = ?', "saved_on = datetime('now')");
  params.push(req.user.name, req.params.id);
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

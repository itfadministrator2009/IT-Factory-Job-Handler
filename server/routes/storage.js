const express = require('express');
const { randomUUID } = require('crypto');
const bcrypt = require('bcryptjs');
const { db, nextStorageOrderNumber } = require('../db');
const { authRequired } = require('../auth');
const { isAdminRole } = require('../permissions');
const { notifyStorageOrderTracking, notifyStorageOrderSubmitted } = require('../email');

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

router.post('/clients', (req, res) => {
  const { clientName, username, password } = req.body;
  if (!clientName || !clientName.trim()) return res.status(400).json({ error: 'A client name is required' });
  const existing = db.prepare('SELECT id FROM storage_clients WHERE client_name = ?').get(clientName.trim());
  if (existing) return res.status(400).json({ error: 'A client with this name already exists' });
  const id = randomUUID();
  const passwordHash = password ? bcrypt.hashSync(password, 10) : null;
  db.prepare('INSERT INTO storage_clients (id, client_name, username, password_hash, added_by) VALUES (?, ?, ?, ?, ?)')
    .run(id, clientName.trim(), username || null, passwordHash, req.user.name);
  res.status(201).json({ client: rowToClient(db.prepare('SELECT * FROM storage_clients WHERE id = ?').get(id)) });
});

router.patch('/clients/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM storage_clients WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Client not found' });
  const { clientName, username, password } = req.body;
  const sets = [];
  const vals = [];
  if (clientName !== undefined) { sets.push('client_name = ?'); vals.push(clientName); }
  if (username !== undefined) { sets.push('username = ?'); vals.push(username); }
  if (password) { sets.push('password_hash = ?'); vals.push(bcrypt.hashSync(password, 10)); }
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

router.get('/lists', (req, res) => {
  const clients = db.prepare("SELECT DISTINCT client FROM storage_items WHERE client IS NOT NULL AND client != '' UNION SELECT client_name FROM storage_clients ORDER BY client").all().map((r) => r.client);
  const storageCentres = db.prepare("SELECT DISTINCT storage_centre FROM storage_items WHERE storage_centre IS NOT NULL AND storage_centre != '' ORDER BY storage_centre").all().map((r) => r.storage_centre);
  const locations = db.prepare("SELECT DISTINCT location FROM storage_items WHERE location IS NOT NULL AND location != '' ORDER BY location").all().map((r) => r.location);
  res.json({ clients: [...new Set(clients)], storageCentres, locations });
});

module.exports = router;

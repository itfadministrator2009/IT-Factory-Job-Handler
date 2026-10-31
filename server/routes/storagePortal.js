// Storage Centre client portal — the client-facing side of the Storage Centre,
// with its own login (storage_clients.username / password_hash), separate from
// Work Desk staff accounts. Every query is scoped to the signed-in client's name,
// and pricing (weekly rates, receiving/dispatch fees) is never returned here —
// invoices still come from staff.
const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { randomUUID } = require('crypto');
const { db, nextStorageOrderNumber } = require('../db');
const { signStorageClientToken, storageClientRequired } = require('../auth');
const { notifyStorageOrderSubmitted } = require('../email');
const { orderNotifyList } = require('../storageNotify');
const { parseStockParts } = require('../storageBilling');
const { buildOrderPdf } = require('../storagePdf');

const router = express.Router();
const MIN_PASSWORD_LENGTH = 8;

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many sign-in attempts. Please try again in a few minutes.' },
});
const orderLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many orders submitted in a short time. Please try again later or contact IT Factory.' },
});

// Constant-time-ish failure: always run a bcrypt compare so a missing username
// takes as long as a wrong password.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

router.post('/login', loginLimiter, (req, res) => {
  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '');
  if (!username || !password) return res.status(400).json({ error: 'Enter your username and password' });
  const client = db.prepare('SELECT * FROM storage_clients WHERE lower(username) = lower(?)').get(username);
  const ok = bcrypt.compareSync(password, client?.password_hash || DUMMY_HASH);
  if (!client || !client.password_hash || !ok) return res.status(401).json({ error: 'Incorrect username or password' });
  res.json({ token: signStorageClientToken(client), client: { name: client.client_name, username: client.username } });
});

router.use(storageClientRequired);

// Re-reads the client on every request so a deleted client, removed portal
// access, or a renamed client takes effect immediately rather than when the
// token expires.
router.use((req, res, next) => {
  const row = db.prepare('SELECT * FROM storage_clients WHERE id = ?').get(req.storageClient.clientId);
  if (!row || !row.password_hash) return res.status(401).json({ error: 'Your portal access has been removed. Please contact IT Factory.' });
  req.portalClient = row;
  next();
});

// Which tabs this client gets: Storage Centre tabs when they have any storage
// records (or no audited assets linked), Audited assets when Asset Tracker
// customer names are linked to them.
function hasStorageRecords(name) {
  const q = (t) => db.prepare(`SELECT 1 FROM ${t} WHERE lower(trim(client)) = lower(trim(?)) LIMIT 1`).get(name);
  return !!(q('storage_items') || q('storage_orders') || q('storage_receiving_dispatch'));
}
router.get('/me', (req, res) => {
  const assets = assetCustomerKeys(req.portalClient).length > 0;
  res.json({
    client: { name: req.portalClient.client_name, username: req.portalClient.username },
    sections: { storage: !assets || hasStorageRecords(req.portalClient.client_name), assets },
  });
});

router.post('/change-password', (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Enter your current and new password' });
  if (!bcrypt.compareSync(String(currentPassword), req.portalClient.password_hash)) return res.status(400).json({ error: 'Your current password is incorrect' });
  if (String(newPassword).length < MIN_PASSWORD_LENGTH) return res.status(400).json({ error: `New password must be at least ${MIN_PASSWORD_LENGTH} characters` });
  db.prepare('UPDATE storage_clients SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(String(newPassword), 10), req.portalClient.id);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Stock on hand
// ---------------------------------------------------------------------------
const normLoc = (v) => String(v || '').trim().replace(/\s+/g, ' ').toLowerCase();
function palletLocationKeys() {
  return new Set(db.prepare('SELECT location_key FROM storage_locations_registry WHERE is_pallet = 1').all().map((r) => r.location_key));
}
// Same rule as the old app's computeDerived_: a start date and no end date = In storage.
function itemStatus(r) {
  if (!r.start_date) return '';
  return r.end_date ? 'Out of Storage' : 'In storage';
}

function portalItem(r, pallets) {
  return {
    id: r.id, item: r.item, make: r.make, model: r.model, serial: r.serial, assetTag: r.asset_tag,
    quantity: r.quantity, condition: r.condition, storageCentre: r.storage_centre, location: r.location,
    jobNumber: r.job_number, referenceNumber: r.reference_number, poNumber: r.po_number, orderNumber: r.order_number,
    startDate: r.start_date, endDate: r.end_date, status: itemStatus(r),
    // Whether this item sits on a location classified as a pallet (Locations page) —
    // the order form groups those by pallet, as the old portal did.
    onPallet: !!(r.location && pallets.has(normLoc(r.location))),
  };
}

// Headline counts, as the old portal showed them: items "In storage" and how
// many distinct pallets they sit on. Only locations classified as pallets on
// the Locations page count — unclassified or "not a pallet" ones never do.
router.get('/summary', (req, res) => {
  const items = db.prepare("SELECT storage_centre, location FROM storage_items WHERE lower(trim(client)) = lower(trim(?)) AND start_date IS NOT NULL AND start_date != '' AND (end_date IS NULL OR end_date = '')")
    .all(req.portalClient.client_name);
  const palletKeys = palletLocationKeys();
  const pallets = new Set();
  items.forEach((i) => {
    if (i.location && palletKeys.has(normLoc(i.location))) pallets.add(`${normLoc(i.storage_centre)}|||${normLoc(i.location)}`);
  });
  const total = db.prepare('SELECT COUNT(*) AS c FROM storage_items WHERE lower(trim(client)) = lower(trim(?))').get(req.portalClient.client_name).c;
  res.json({ inStorageCount: items.length, palletCount: pallets.size, totalCount: total });
});

// Every item on record for this client, with its status — as the old portal showed.
router.get('/items', (req, res) => {
  const pallets = palletLocationKeys();
  const rows = db.prepare('SELECT * FROM storage_items WHERE lower(trim(client)) = lower(trim(?)) ORDER BY storage_centre, location, item, serial')
    .all(req.portalClient.client_name);
  res.json({ items: rows.map((r) => portalItem(r, pallets)) });
});

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------
function portalOrder(r) {
  return {
    id: r.id, orderNumber: r.order_number, devices: r.devices, deliveryAddress: r.delivery_address,
    siteContactName: r.site_contact_name, siteContactPhone: r.site_contact_phone,
    dateToBeDelivered: r.date_to_be_delivered, configInformation: r.config_information, notes: r.notes,
    requestor: r.requestor, status: r.status, trackingNumber: r.tracking_number,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

router.get('/orders', (req, res) => {
  const rows = db.prepare('SELECT * FROM storage_orders WHERE lower(trim(client)) = lower(trim(?)) ORDER BY created_at DESC').all(req.portalClient.client_name);
  res.json({ orders: rows.map(portalOrder) });
});

const ORDER_LIMITS = { deliveryAddress: 500, siteContactName: 200, siteContactPhone: 60, configInformation: 4000, notes: 4000, requestedBy: 200 };

router.post('/orders', orderLimiter, (req, res) => {
  const b = req.body || {};
  const clean = (k) => (b[k] == null ? '' : String(b[k]).trim());
  for (const [k, max] of Object.entries(ORDER_LIMITS)) {
    if (clean(k).length > max) return res.status(400).json({ error: `${k} is too long` });
  }
  // Devices are picked from the client's own in-storage stock (as in the old
  // portal), by item id — so a client can never order someone else's stock.
  const ids = Array.isArray(b.deviceIds) ? [...new Set(b.deviceIds.map(String))].slice(0, 2000) : [];
  if (!ids.length) return res.status(400).json({ error: 'Select at least one device before submitting.' });
  const pick = db.prepare(`SELECT * FROM storage_items WHERE id = ? AND lower(trim(client)) = lower(trim(?))
    AND start_date IS NOT NULL AND start_date != '' AND (end_date IS NULL OR end_date = '')`);
  const picked = ids.map((id) => pick.get(id, req.portalClient.client_name)).filter(Boolean);
  if (picked.length !== ids.length) return res.status(400).json({ error: 'Some selected devices are no longer in storage — refresh the page and try again.' });
  // Stored the way the old app did (serial, or the item name when there's no
  // serial), so "Send to dispatch" can match them back to the manifest.
  const devices = picked.map((i) => (i.serial && i.serial.trim()) || i.item || '').filter(Boolean).join(', ');
  const deviceLines = picked.map((i) => [i.item, i.make, i.model, i.serial ? `S/N ${i.serial}` : null].filter(Boolean).join(' ')).join('\n');
  if (!clean('deliveryAddress')) return res.status(400).json({ error: 'A delivery address is required' });
  const date = clean('dateToBeDelivered');
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Delivery date must be a valid date' });

  // Portal orders start as "In Progress", as they did in the old app.
  const client = req.portalClient;
  const requestor = clean('requestedBy') ? `${clean('requestedBy')} (client portal)` : `${client.username} (client portal)`;
  const id = randomUUID();
  const orderNumber = nextStorageOrderNumber();
  db.prepare(`INSERT INTO storage_orders
    (id, order_number, client, devices, delivery_address, site_contact_name, site_contact_phone, date_to_be_delivered, config_information, notes, requestor, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'In Progress')`)
    .run(id, orderNumber, client.client_name, devices, clean('deliveryAddress'), clean('siteContactName') || null,
      clean('siteContactPhone') || null, date || null, clean('configInformation') || null, clean('notes') || null, requestor);

  // Tell the team a client has placed an order (see storageNotify.js for the list).
  const notifyList = orderNotifyList();
  if (notifyList.length) {
    notifyStorageOrderSubmitted({
      toEmails: notifyList, orderNumber, clientName: client.client_name, devices: deviceLines,
      deliveryAddress: clean('deliveryAddress'), dateToBeDelivered: date, source: 'portal',
      siteContactName: clean('siteContactName'), siteContactPhone: clean('siteContactPhone'),
      configInformation: clean('configInformation'), notes: clean('notes'), requestor,
    }).catch((err) => console.error('[storage-portal] order-submitted notify failed:', err.message));
  }

  res.status(201).json({ order: portalOrder(db.prepare('SELECT * FROM storage_orders WHERE id = ?').get(id)) });
});

router.get('/orders/:id/pdf', async (req, res) => {
  const row = db.prepare('SELECT * FROM storage_orders WHERE id = ? AND lower(trim(client)) = lower(trim(?))').get(req.params.id, req.portalClient.client_name);
  if (!row) return res.status(404).json({ error: 'Order not found' });
  try {
    const pdf = await buildOrderPdf({ ...portalOrder(row), client: row.client });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${String(row.order_number || 'order').replace(/[^A-Za-z0-9._-]+/g, '_')}.pdf"`);
    res.send(pdf);
  } catch (err) {
    console.error('[storage-portal] order PDF failed:', err);
    res.status(500).json({ error: 'Could not generate the PDF' });
  }
});

// ---------------------------------------------------------------------------
// Receiving / dispatch history — quantities only, no rates or fees.
// ---------------------------------------------------------------------------
function stockWithoutRates(type, qty) {
  const parts = parseStockParts(type);
  if (parts.length) return parts.map((p) => `${p.type} x ${p.qty}`).join('; ');
  if (!type && (qty == null || qty === '')) return '';
  return `${type || 'Stock'} x ${qty ?? 0}`;
}

router.get('/receiving-dispatch', (req, res) => {
  const rows = db.prepare('SELECT * FROM storage_receiving_dispatch WHERE lower(trim(client)) = lower(trim(?)) ORDER BY COALESCE(date_dispatched, date_received, saved_on) DESC')
    .all(req.portalClient.client_name);
  res.json({
    entries: rows.map((r) => ({
      id: r.id, dateReceived: r.date_received, dateDispatched: r.date_dispatched,
      stockReceived: stockWithoutRates(r.stock_received_type, r.stock_received_qty),
      stockDispatched: stockWithoutRates(r.stock_dispatched_type, r.stock_dispatched_qty),
      receivingNotes: r.receiving, dispatchNotes: r.dispatch,
    })),
  });
});

// ---------------------------------------------------------------------------
// Audited assets (ITF Asset Tracker) — only assets whose Customer is one of the
// names linked to this client on Storage Centre → Clients. Only the fields in
// PORTAL_ASSET_FIELDS are ever sent: no Status, Sent to, Buyer, Location or
// any field added later in Manage Fields.
// ---------------------------------------------------------------------------
const PORTAL_ASSET_FIELDS = ['asset_tag', 'category', 'manufacturer', 'model_name', 'model_number', 'serial_number', 'client_asset_tag',
  'ram', 'cpu_speed', 'cpu_gen', 'hdd', 'battery', 'condition_appearance', 'condition_completeness', 'condition_operability',
  'condition_services', 'asset_upgrade', 'zoho_ticket_number', 'audit_month', 'comments'];
const fieldSql = (key) => `trim(COALESCE(json_extract(fields_json, '$.${key}'), ''))`;
const normSql = (key) => `lower(trim(replace(replace(replace(COALESCE(json_extract(fields_json, '$.${key}'), ''), '  ', ' '), '  ', ' '), '  ', ' ')))`;
const normText = (v) => String(v ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

function assetCustomerKeys(client) {
  let list = [];
  try { list = JSON.parse(client.asset_customers || '[]'); } catch { list = []; }
  return [...new Set((Array.isArray(list) ? list : []).map(normText).filter(Boolean))];
}

// WHERE for this client's assets plus the portal filters (search, audit month,
// category, job number).
function portalAssetWhere(req) {
  const keys = assetCustomerKeys(req.portalClient);
  const parts = [`${normSql('customer')} IN (${keys.map(() => '?').join(',')})`];
  const params = [...keys];
  const q = String(req.query.q || '').trim();
  if (q) {
    parts.push(`(${PORTAL_ASSET_FIELDS.map((k) => `${fieldSql(k)} LIKE ?`).join(' OR ')})`);
    PORTAL_ASSET_FIELDS.forEach(() => params.push(`%${q}%`));
  }
  [['month', 'audit_month'], ['category', 'category'], ['job', 'zoho_ticket_number']].forEach(([param, key]) => {
    const v = req.query[param];
    if (v == null || v === '') return;
    if (v === '__none__') parts.push(`${normSql(key)} = ''`);
    else { parts.push(`${normSql(key)} = ?`); params.push(normText(v)); }
  });
  return { where: `WHERE ${parts.join(' AND ')}`, params };
}

function portalAsset(row) {
  let f = {};
  try { f = JSON.parse(row.fields_json || '{}'); } catch { f = {}; }
  const fields = {};
  PORTAL_ASSET_FIELDS.forEach((k) => { if (f[k] != null && f[k] !== '') fields[k] = f[k]; });
  return { id: row.id, createdAt: row.created_at, fields };
}

function portalFieldDefs() {
  const defs = db.prepare('SELECT field_key, label, type FROM asset_field_defs').all();
  return PORTAL_ASSET_FIELDS.map((k) => { const d = defs.find((x) => x.field_key === k); return d ? { key: k, label: d.label, type: d.type } : null; }).filter(Boolean);
}

function requireAssets(req, res, next) {
  if (!assetCustomerKeys(req.portalClient).length) return res.status(403).json({ error: 'Audited assets are not set up for your account. Please contact IT Factory.' });
  next();
}

// Distinct values (with counts) of one field across this client's assets.
function valueCounts(req, key) {
  const keys = assetCustomerKeys(req.portalClient);
  const rows = db.prepare(`SELECT ${fieldSql(key)} AS v, COUNT(*) AS n, MIN(created_at) AS first FROM assets
    WHERE ${normSql('customer')} IN (${keys.map(() => '?').join(',')}) GROUP BY ${normSql(key)}`).all(...keys);
  return rows.map((r) => ({ value: r.v, count: r.n, first: r.first }));
}

router.get('/assets/options', requireAssets, (req, res) => {
  const byFirst = (a, b) => String(b.first).localeCompare(String(a.first));
  res.json({
    fields: portalFieldDefs(),
    month: valueCounts(req, 'audit_month').sort(byFirst).map(({ value, count }) => ({ value, count })),
    category: valueCounts(req, 'category').sort((a, b) => a.value.localeCompare(b.value)).map(({ value, count }) => ({ value, count })),
    job: valueCounts(req, 'zoho_ticket_number').sort(byFirst).map(({ value, count }) => ({ value, count })),
  });
});

router.get('/assets', requireAssets, (req, res) => {
  const { where, params } = portalAssetWhere(req);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const total = db.prepare(`SELECT COUNT(*) AS c FROM assets ${where}`).get(...params).c;
  const rows = db.prepare(`SELECT id, fields_json, created_at FROM assets ${where} ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, (page - 1) * limit);
  res.json({ assets: rows.map(portalAsset), total, page, totalPages: Math.max(1, Math.ceil(total / limit)) });
});

// Counts for the charts, following the current filters.
router.get('/assets/summary', requireAssets, (req, res) => {
  const { where, params } = portalAssetWhere(req);
  const group = (key) => db.prepare(`SELECT ${fieldSql(key)} AS v, COUNT(*) AS n, MIN(created_at) AS first FROM assets ${where} GROUP BY ${normSql(key)} ORDER BY n DESC`)
    .all(...params).map((r) => ({ label: r.v || '(not set)', count: r.n, first: r.first }));
  const total = db.prepare(`SELECT COUNT(*) AS c FROM assets ${where}`).get(...params).c;
  // Data wiping / services: each ticked option counted once per asset.
  const services = {};
  let dataWiped = 0; // assets with a wipe or shred recorded (not a failed one)
  db.prepare(`SELECT json_extract(fields_json, '$.condition_services') AS s FROM assets ${where}`).all(...params).forEach(({ s }) => {
    let list = [];
    try { list = Array.isArray(s) ? s : JSON.parse(s || '[]'); } catch { list = s ? [String(s)] : []; }
    const items = (Array.isArray(list) ? list : [list]).map((x) => String(x).trim()).filter(Boolean);
    items.forEach((x) => { services[x] = (services[x] || 0) + 1; });
    if (items.some((x) => /wipe|shred/i.test(x) && !/fail/i.test(x))) dataWiped += 1;
  });
  res.json({
    total,
    dataWiped,
    byMonth: group('audit_month').sort((a, b) => String(a.first).localeCompare(String(b.first))).map(({ label, count }) => ({ label, count })),
    byCategory: group('category').map(({ label, count }) => ({ label, count })),
    byManufacturer: group('manufacturer').map(({ label, count }) => ({ label, count })),
    byService: Object.entries(services).map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count),
  });
});

router.get('/assets/export', requireAssets, (req, res) => {
  const { where, params } = portalAssetWhere(req);
  const fields = portalFieldDefs();
  const rows = db.prepare(`SELECT id, fields_json, created_at FROM assets ${where} ORDER BY created_at DESC, rowid DESC`).all(...params).map(portalAsset);
  const cell = (v) => {
    const t = Array.isArray(v) ? v.join('; ') : (v == null ? '' : String(v));
    const safe = /^[=+\-@\t\r]/.test(t) ? `'${t}` : t; // stop spreadsheet formulas
    return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  const lines = [['Date added', ...fields.map((f) => f.label)].map(cell).join(',')];
  const sydneyDate = (utc) => { const ms = Date.parse(`${String(utc || '').replace(' ', 'T')}Z`); return Number.isNaN(ms) ? '' : new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Sydney' }).format(new Date(ms)); };
  rows.forEach((a) => lines.push([sydneyDate(a.createdAt), ...fields.map((f) => a.fields[f.key])].map(cell).join(',')));
  const name = String(req.portalClient.client_name || 'assets').replace(/[^A-Za-z0-9._-]+/g, '_');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${name}-audited-assets-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send('﻿' + lines.join('\r\n') + '\r\n');
});

module.exports = router;

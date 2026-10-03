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

router.get('/me', (req, res) => {
  res.json({ client: { name: req.portalClient.client_name, username: req.portalClient.username } });
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
function portalItem(r) {
  return {
    id: r.id, item: r.item, make: r.make, model: r.model, serial: r.serial, assetTag: r.asset_tag,
    quantity: r.quantity, condition: r.condition, storageCentre: r.storage_centre, location: r.location,
    jobNumber: r.job_number, referenceNumber: r.reference_number, poNumber: r.po_number, orderNumber: r.order_number,
    startDate: r.start_date, endDate: r.end_date,
  };
}

// Current stock by default (no end date); ?include=all adds items that have left.
router.get('/items', (req, res) => {
  const all = req.query.include === 'all';
  const rows = db.prepare(`SELECT * FROM storage_items WHERE client = ? ${all ? '' : "AND (end_date IS NULL OR end_date = '')"} ORDER BY storage_centre, location, item, serial`)
    .all(req.portalClient.client_name);
  res.json({ items: rows.map(portalItem) });
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
  const rows = db.prepare('SELECT * FROM storage_orders WHERE client = ? ORDER BY created_at DESC').all(req.portalClient.client_name);
  res.json({ orders: rows.map(portalOrder) });
});

const ORDER_LIMITS = { devices: 20000, deliveryAddress: 500, siteContactName: 200, siteContactPhone: 60, configInformation: 4000, notes: 4000, requestedBy: 200 };

router.post('/orders', orderLimiter, (req, res) => {
  const b = req.body || {};
  const clean = (k) => (b[k] == null ? '' : String(b[k]).trim());
  for (const [k, max] of Object.entries(ORDER_LIMITS)) {
    if (clean(k).length > max) return res.status(400).json({ error: `${k} is too long` });
  }
  if (!clean('devices')) return res.status(400).json({ error: 'List the devices you need delivered' });
  if (!clean('deliveryAddress')) return res.status(400).json({ error: 'A delivery address is required' });
  const date = clean('dateToBeDelivered');
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Delivery date must be a valid date' });

  const client = req.portalClient;
  const requestor = clean('requestedBy') ? `${clean('requestedBy')} (client portal)` : `${client.username} (client portal)`;
  const id = randomUUID();
  const orderNumber = nextStorageOrderNumber();
  db.prepare(`INSERT INTO storage_orders
    (id, order_number, client, devices, delivery_address, site_contact_name, site_contact_phone, date_to_be_delivered, config_information, notes, requestor, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Pending')`)
    .run(id, orderNumber, client.client_name, clean('devices'), clean('deliveryAddress'), clean('siteContactName') || null,
      clean('siteContactPhone') || null, date || null, clean('configInformation') || null, clean('notes') || null, requestor);

  const notifyList = (process.env.STORAGE_NOTIFY_EMAILS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (notifyList.length) {
    notifyStorageOrderSubmitted({
      toEmails: notifyList, orderNumber, clientName: client.client_name, devices: clean('devices'),
      deliveryAddress: clean('deliveryAddress'), dateToBeDelivered: date, source: 'portal',
    }).catch((err) => console.error('[storage-portal] order-submitted notify failed:', err.message));
  }

  res.status(201).json({ order: portalOrder(db.prepare('SELECT * FROM storage_orders WHERE id = ?').get(id)) });
});

router.get('/orders/:id/pdf', async (req, res) => {
  const row = db.prepare('SELECT * FROM storage_orders WHERE id = ? AND client = ?').get(req.params.id, req.portalClient.client_name);
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
  const rows = db.prepare('SELECT * FROM storage_receiving_dispatch WHERE client = ? ORDER BY COALESCE(date_dispatched, date_received, saved_on) DESC')
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

module.exports = router;

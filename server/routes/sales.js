// ITF Sales Manager API. Everyone with ITF Sales Manager switched on (admins
// always) can add, edit and move items; clearing a whole list, the Google
// Sheet import and the manual Shopify sync are admin-only.
const express = require('express');
const { db } = require('../db');
const { authRequired } = require('../auth');
const { isAdminRole, currentRole, requireModule } = require('../permissions');
const sales = require('../sales');
const shopify = require('../salesShopify');

const router = express.Router();
router.use(authRequired);
router.use(requireModule('sales'));

const KINDS = ['sale', 'inventory'];
const kindOf = (v) => (v === 'inventory' ? 'inventory' : 'sale');
const listName = (k) => (k === 'inventory' ? 'Inventory on Hand' : 'All Sales');
const isAdmin = (req) => isAdminRole(currentRole(req.user.id));
const sydneyToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney' }).format(new Date());
function adminOnly(req, res, next) {
  if (isAdmin(req)) return next();
  res.status(403).json({ error: 'Only admins can do that.' });
}

router.get('/items', (req, res) => {
  const kind = kindOf(req.query.kind);
  res.json({ items: sales.listItems(kind), syncedAt: Date.now() });
});

// Add one item. Adding a Shopify order line ({ shopifyPendingId }) also takes it
// off the review list and remembers which order line it came from.
router.post('/items', (req, res) => {
  const kind = kindOf(req.body?.kind);
  const data = { ...(req.body?.data || {}) };
  if (!String(data.sku || '').trim() && !String(data.model || '').trim()) {
    return res.status(400).json({ error: 'Add at least a SKU or model.' });
  }
  const pendingId = req.body?.shopifyPendingId;
  let pending = null;
  if (pendingId) {
    pending = db.prepare('SELECT * FROM sales_shopify_pending WHERE id = ?').get(pendingId);
    if (pending) data.shopifysourcekey = `${pending.shopify_order_id}-${pending.shopify_line_item_id}`;
  }
  delete data.id;
  data.addedby = req.user.name;
  const id = db.transaction(() => {
    const newId = sales.insertItem(kind, data, req.user.name);
    if (pending) shopify.dismissPending(pending.id);
    return newId;
  })();
  const item = sales.getItem(id);
  sales.logSalesActivity(req.user.name, pending ? 'Added from Shopify' : 'Added', kind, sales.describe(item));
  res.status(201).json({ item });
});

router.patch('/items/:id', (req, res) => {
  const existing = sales.getItem(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Item not found' });
  sales.updateItem(req.params.id, req.body?.data || {}, req.user.name);
  const item = sales.getItem(req.params.id);
  sales.logSalesActivity(req.user.name, 'Updated', item.kind, sales.describe(item));
  res.json({ item });
});

router.delete('/items/:id', (req, res) => {
  const existing = sales.getItem(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Item not found' });
  db.prepare('DELETE FROM sales_items WHERE id = ?').run(req.params.id);
  sales.logSalesActivity(req.user.name, 'Deleted', existing.kind, sales.describe(existing));
  res.json({ ok: true });
});

// The same change to many items: { ids, fields }.
router.post('/items/bulk-update', (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : [];
  const fields = req.body?.fields || {};
  if (!ids.length) return res.status(400).json({ error: 'Nothing selected' });
  let updated = 0;
  db.transaction(() => { ids.forEach((id) => { updated += sales.updateItem(id, fields, req.user.name); }); })();
  const kind = ids.length ? sales.getItem(ids[0])?.kind : null;
  sales.logSalesActivity(req.user.name, 'Bulk updated', kind, `${updated} item(s): ${Object.keys(fields).join(', ')}`);
  res.json({ updated });
});

// Move items between Inventory on Hand and All Sales: { ids, to: 'sale' | 'inventory' }.
// Into Sales: sell date defaults to today and the status starts as Sold.
// Back to Inventory: the sale status is cleared (inventory starts as Not Tested).
router.post('/items/move', (req, res) => {
  const to = kindOf(req.body?.to);
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : [];
  if (!ids.length) return res.status(400).json({ error: 'Nothing selected' });
  const now = Date.now();
  let moved = 0;
  db.transaction(() => {
    ids.forEach((id) => {
      const it = sales.getItem(id);
      if (!it || it.kind === to) return;
      if (to === 'sale') {
        moved += db.prepare(`UPDATE sales_items SET kind = 'sale', status = NULL, selldate = COALESCE(NULLIF(selldate, ''), ?),
          created_at = ?, last_modified = ?, lasteditedby = ? WHERE id = ?`).run(sydneyToday(), now, now, req.user.name, id).changes;
      } else {
        moved += db.prepare(`UPDATE sales_items SET kind = 'inventory', status = NULL, last_modified = ?, lasteditedby = ? WHERE id = ?`)
          .run(now, req.user.name, id).changes;
      }
    });
  })();
  sales.logSalesActivity(req.user.name, 'Moved', to, `${moved} item(s) to ${listName(to)}`);
  res.json({ moved });
});

// Add many items at once (CSV import, or the one-off Google Sheet import).
// keepIds (admins): the old sheet's ids are kept, so importing the same sheet
// again updates those items instead of adding them twice.
router.post('/import', (req, res) => {
  const kind = kindOf(req.body?.kind);
  const records = Array.isArray(req.body?.records) ? req.body.records : [];
  const keepIds = !!req.body?.keepIds;
  if (keepIds && !isAdmin(req)) return res.status(403).json({ error: 'Only admins can import the Google Sheet.' });
  if (!records.length) return res.status(400).json({ error: 'No rows to import' });
  if (records.length > 50000) return res.status(400).json({ error: 'Too many rows in one go' });
  let added = 0;
  let updated = 0;
  db.transaction(() => {
    records.forEach((r) => {
      if (!r || typeof r !== 'object') return;
      const exists = keepIds && r.id ? db.prepare('SELECT 1 FROM sales_items WHERE id = ?').get(String(r.id)) : null;
      sales.insertItem(kind, r, req.user.name, { keepId: keepIds });
      if (exists) updated += 1; else added += 1;
    });
  })();
  sales.logSalesActivity(req.user.name, keepIds ? 'Imported from Google Sheet' : 'Imported', kind, `${added} added, ${updated} updated`);
  res.json({ added, updated });
});

// The old sheet's ShopifyPending tab (admins, during the move).
router.post('/import-shopify-pending', adminOnly, (req, res) => {
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  const keys = shopify.knownKeys();
  const ins = db.prepare(`INSERT OR IGNORE INTO sales_shopify_pending
    (id, shopify_order_id, shopify_line_item_id, order_number, order_date, customer, product_title, sku, quantity, price, staged_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  let added = 0;
  db.transaction(() => {
    rows.forEach((r) => {
      const o = String(r.shopifyOrderId || '').trim();
      const l = String(r.shopifyLineItemId || '').trim();
      if (!o || !l || keys.has(`${o}-${l}`)) return;
      added += ins.run(String(r.id || require('crypto').randomUUID()), o, l, sales.clean(r.orderNumber), sales.clean(r.orderDate),
        sales.clean(r.customer), sales.clean(r.productTitle), sales.clean(r.sku), Number(r.quantity) || 1,
        sales.clean(r.price) || '0', Number(r.stagedAt) || Date.now()).changes;
      keys.add(`${o}-${l}`);
    });
  })();
  res.json({ added });
});

// Clear a whole list (admins).
router.delete('/items', adminOnly, (req, res) => {
  const kind = kindOf(req.query.kind);
  if (req.query.confirm !== 'yes') return res.status(400).json({ error: 'Confirmation required' });
  const removed = db.prepare('DELETE FROM sales_items WHERE kind = ?').run(kind).changes;
  sales.logSalesActivity(req.user.name, 'Cleared all data', kind, `${removed} item(s) removed`);
  res.json({ removed });
});

router.get('/activity', (req, res) => {
  res.json({ entries: sales.recentActivity() });
});

router.get('/settings', (req, res) => {
  res.json({
    weeklyLabourCost: sales.WEEKLY_LABOUR_COST,
    weeklyAdsCost: sales.WEEKLY_ADS_COST,
    shopify: shopify.syncStatus(),
    isAdmin: isAdmin(req),
  });
});

// --- Shopify ---
router.get('/shopify/pending', (req, res) => {
  res.json({ orders: shopify.pendingOrders(), status: shopify.syncStatus() });
});
router.delete('/shopify/pending/:id', (req, res) => {
  const ok = shopify.dismissPending(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Order no longer waiting' });
  sales.logSalesActivity(req.user.name, 'Dismissed Shopify order', 'sale', req.params.id);
  res.json({ ok: true });
});
router.post('/shopify/sync', adminOnly, async (req, res) => {
  const r = await shopify.syncShopifyOrders();
  if (!r.ok && r.reason === 'not_configured') return res.status(400).json({ error: 'Shopify is not set up yet (add the Shopify settings in Render).' });
  res.json({ ...r, status: shopify.syncStatus() });
});
router.post('/shopify/coverage', async (req, res) => {
  const iso = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null);
  try {
    res.json(await shopify.checkCoverage(iso(req.body?.startISO), iso(req.body?.endISO)));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Send the weekly summary now, to yourself (admins) — to check it looks right.
router.post('/weekly-summary/test', adminOnly, async (req, res) => {
  const me = db.prepare('SELECT email FROM users WHERE id = ?').get(req.user.id);
  if (!me?.email) return res.status(400).json({ error: 'Your account has no email address' });
  try {
    const r = await require('../salesWeekly').sendWeeklySummary({ toEmails: [me.email] });
    res.json(r);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.KINDS = KINDS;
module.exports = router;

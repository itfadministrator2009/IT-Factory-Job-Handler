// ITF Sales Manager — Shopify orders. Every 15 minutes new Shopify order lines
// are copied into a review list ("Shopify Orders"); someone then adds each to
// All Sales (filling in the rest) or dismisses it. Same as the old Apps Script.
//
// Turned on by three settings in Render (never put these in code or chat):
//   SHOPIFY_STORE_DOMAIN   e.g. yourstore.myshopify.com
//   SHOPIFY_CLIENT_ID      the app's Client ID
//   SHOPIFY_CLIENT_SECRET  the app's Client secret
// Optional: SHOPIFY_API_VERSION (default 2024-01), SHOPIFY_FIRST_SYNC_DAYS
// (how far back the very first sync looks, default 7).
const { randomUUID } = require('crypto');
const { db } = require('./db');
const { getMeta, setMeta } = require('./sales');

const API_VERSION = process.env.SHOPIFY_API_VERSION || '2024-01';
const SYNC_EVERY_MS = 15 * 60 * 1000;

function domain() {
  return String(process.env.SHOPIFY_STORE_DOMAIN || '').trim().replace(/^https?:\/\//i, '').split('/')[0];
}
function configured() {
  return !!(domain() && process.env.SHOPIFY_CLIENT_ID && process.env.SHOPIFY_CLIENT_SECRET);
}

// Client ID + secret -> a temporary access token (kept until a minute before it expires).
let cachedToken = null;
let cachedUntil = 0;
async function accessToken(fetchImpl = fetch) {
  if (cachedToken && Date.now() < cachedUntil - 60000) return cachedToken;
  const res = await fetchImpl(`https://${domain()}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: process.env.SHOPIFY_CLIENT_ID,
      client_secret: process.env.SHOPIFY_CLIENT_SECRET,
    }).toString(),
  });
  if (!res.ok) throw new Error(`Shopify sign-in failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  cachedToken = data.access_token;
  cachedUntil = Date.now() + (Number(data.expires_in) || 86399) * 1000;
  return cachedToken;
}

async function fetchOrdersPage(url, fetchImpl = fetch) {
  const res = await fetchImpl(url, { headers: { 'X-Shopify-Access-Token': await accessToken(fetchImpl) } });
  if (!res.ok) throw new Error(`Shopify error (${res.status}): ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const link = res.headers.get('link') || '';
  const next = link.split(',').find((p) => p.includes('rel="next"'));
  const m = next && next.match(/<([^>]+)>/);
  return { orders: data.orders || [], nextUrl: m ? m[1] : null };
}

const ordersUrl = (params) => `https://${domain()}/admin/api/${API_VERSION}/orders.json?status=any&limit=250&${params}`;
const customerName = (o) => (o.customer ? `${o.customer.first_name || ''} ${o.customer.last_name || ''}`.trim() : '') || o.email || '';
const orderLabel = (o) => o.name || `#${o.order_number}`;
const normalizeOrderNo = (v) => String(v || '').trim().replace(/^#/, '').toLowerCase();

// Every order line already seen: waiting for review, or already added to Sales.
function knownKeys() {
  const keys = new Set();
  db.prepare('SELECT shopify_order_id, shopify_line_item_id FROM sales_shopify_pending').all()
    .forEach((r) => keys.add(`${r.shopify_order_id}-${r.shopify_line_item_id}`));
  db.prepare("SELECT shopifysourcekey FROM sales_items WHERE shopifysourcekey IS NOT NULL AND shopifysourcekey != ''").all()
    .forEach((r) => keys.add(String(r.shopifysourcekey)));
  return keys;
}

const insertPending = db.prepare(`INSERT OR IGNORE INTO sales_shopify_pending
  (id, shopify_order_id, shopify_line_item_id, order_number, order_date, customer, product_title, sku, quantity, price, staged_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

// One Shopify order -> new review lines (one per product line not seen before).
function stageOrder(order, keys) {
  let staged = 0;
  for (const item of order.line_items || []) {
    const key = `${order.id}-${item.id}`;
    if (keys.has(key)) continue;
    staged += insertPending.run(randomUUID(), String(order.id), String(item.id), orderLabel(order),
      order.created_at ? String(order.created_at).slice(0, 10) : '', customerName(order),
      item.title || '', item.sku || '', Number(item.quantity) || 1, String(item.price || '0'), Date.now()).changes;
    keys.add(key);
  }
  return staged;
}

let syncing = false;
async function syncShopifyOrders({ fetchImpl = fetch } = {}) {
  if (!configured()) return { ok: false, reason: 'not_configured' };
  if (syncing) return { ok: false, reason: 'busy' };
  syncing = true;
  const startedAt = new Date().toISOString();
  try {
    let cursor = getMeta('shopify_cursor');
    if (!cursor) {
      const days = Number(process.env.SHOPIFY_FIRST_SYNC_DAYS || 7);
      cursor = new Date(Date.now() - days * 86400000).toISOString();
    }
    const keys = knownKeys();
    let url = ordersUrl(`order=updated_at+asc&updated_at_min=${encodeURIComponent(cursor)}`);
    let staged = 0;
    let pages = 0;
    while (url && pages < 200) {
      const { orders, nextUrl } = await fetchOrdersPage(url, fetchImpl);
      db.transaction(() => { orders.forEach((o) => { staged += stageOrder(o, keys); }); })();
      url = nextUrl;
      pages += 1;
    }
    setMeta('shopify_cursor', startedAt);
    setMeta('shopify_last_sync_at', Date.now());
    setMeta('shopify_last_sync_ok', '1');
    setMeta('shopify_last_sync_error', '');
    setMeta('shopify_last_sync_staged', staged);
    if (staged) console.log(`[sales] Shopify: ${staged} new order line(s) waiting for review.`);
    return { ok: true, staged };
  } catch (err) {
    setMeta('shopify_last_sync_at', Date.now());
    setMeta('shopify_last_sync_ok', '0');
    setMeta('shopify_last_sync_error', err.message);
    console.error('[sales] Shopify sync failed:', err.message);
    return { ok: false, reason: 'error', error: err.message };
  } finally {
    syncing = false;
  }
}

function syncStatus() {
  const lastAt = Number(getMeta('shopify_last_sync_at')) || null;
  const ok = getMeta('shopify_last_sync_ok');
  return {
    configured: configured(),
    lastSyncAt: lastAt,
    ok: ok == null ? null : ok === '1',
    error: getMeta('shopify_last_sync_error') || '',
    lastStagedCount: Number(getMeta('shopify_last_sync_staged')) || 0,
  };
}

function pendingOrders() {
  return db.prepare('SELECT * FROM sales_shopify_pending ORDER BY staged_at DESC').all().map((r) => ({
    id: r.id, shopifyOrderId: r.shopify_order_id, shopifyLineItemId: r.shopify_line_item_id,
    orderNumber: r.order_number, orderDate: r.order_date, customer: r.customer, productTitle: r.product_title,
    sku: r.sku, quantity: r.quantity, price: r.price, stagedAt: r.staged_at,
  }));
}
function dismissPending(id) {
  return db.prepare('DELETE FROM sales_shopify_pending WHERE id = ?').run(id).changes > 0;
}

// Fresh from Shopify: which orders in the period are in All Sales (by order #)?
async function checkCoverage(startISO, endISO, { fetchImpl = fetch } = {}) {
  if (!configured()) throw new Error('Shopify is not set up yet.');
  const counts = {};
  let totalSalesRowsInPeriod = 0;
  let shopifySalesRowsInPeriod = 0;
  db.prepare("SELECT orderno, platform, selldate FROM sales_items WHERE kind = 'sale'").all().forEach((r) => {
    if (r.orderno) { const k = normalizeOrderNo(r.orderno); counts[k] = (counts[k] || 0) + 1; }
    const d = r.selldate || '';
    if (d && (!startISO || d >= startISO) && (!endISO || d <= endISO)) {
      totalSalesRowsInPeriod += 1;
      if (String(r.platform || '').toLowerCase() === 'shopify') shopifySalesRowsInPeriod += 1;
    }
  });
  let params = 'order=created_at+asc';
  if (startISO) params += `&created_at_min=${encodeURIComponent(`${startISO}T00:00:00Z`)}`;
  if (endISO) params += `&created_at_max=${encodeURIComponent(`${endISO}T23:59:59Z`)}`;
  let url = ordersUrl(params);
  const orders = [];
  let pages = 0;
  while (url && pages < 40) {
    const page = await fetchOrdersPage(url, fetchImpl);
    page.orders.forEach((o) => {
      const label = orderLabel(o);
      orders.push({
        orderNumber: label,
        orderDate: o.created_at ? String(o.created_at).slice(0, 10) : '',
        customer: customerName(o),
        productTitle: (o.line_items || []).map((i) => i.title).filter(Boolean).join(', '),
        price: o.total_price || '0',
        found: !!counts[normalizeOrderNo(label)],
      });
    });
    url = page.nextUrl;
    pages += 1;
  }
  orders.sort((a, b) => (a.found === b.found ? 0 : a.found ? 1 : -1)); // missing first
  const matched = orders.filter((o) => o.found);
  return {
    orders,
    matched: matched.length,
    missing: orders.length - matched.length,
    matchedSalesRows: matched.reduce((s, o) => s + (counts[normalizeOrderNo(o.orderNumber)] || 0), 0),
    totalSalesRowsInPeriod,
    shopifySalesRowsInPeriod,
  };
}

function startShopifySync() {
  if (!configured()) {
    console.log('[sales] Shopify sync is off (set SHOPIFY_STORE_DOMAIN, SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET to turn it on).');
    return;
  }
  console.log('[sales] Shopify sync on — checking for new orders every 15 minutes.');
  setTimeout(() => { syncShopifyOrders().catch(() => {}); }, 60 * 1000).unref?.();
  setInterval(() => { syncShopifyOrders().catch(() => {}); }, SYNC_EVERY_MS).unref?.();
}

module.exports = {
  configured, syncShopifyOrders, syncStatus, pendingOrders, dismissPending, checkCoverage,
  startShopifySync, knownKeys, normalizeOrderNo, _resetToken: () => { cachedToken = null; cachedUntil = 0; },
};

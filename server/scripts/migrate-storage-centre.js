// One-time data migration: pulls Items / Pallets / Clients / ClientOrders out of
// the live Storage Centre Google Sheet (via its Apps Script web app's
// ?action=exportForMigration endpoint — the same reliable plain-fetch JSON API
// that fixed the "google.script.run returns null on large payloads" bug) and
// loads them into this app's SQLite database.
//
// This is additive and safe to re-run: it skips any item/pallet/order whose id
// (or order number) already exists, and any client whose name already exists —
// so running it twice does not duplicate rows. It does NOT touch or delete the
// live Google Sheet; the Apps Script app keeps running as the system of record
// until the Work Desk version has full parity and is cut over, per plan.
//
// Usage:
//   STORAGE_CENTRE_URL="https://script.google.com/macros/s/XXXX/exec" \
//   STORAGE_CENTRE_MIGRATION_KEY="whatever-you-set-as-MIGRATION_KEY" \
//   node server/scripts/migrate-storage-centre.js
//
// STORAGE_CENTRE_MIGRATION_KEY must match the MIGRATION_KEY script property set
// in the Apps Script project (File > Project Settings > Script Properties) —
// this is what the exportForMigration action checks before releasing any data.

const { randomUUID } = require('crypto');
const { db } = require('../db');

const BASE_URL = process.env.STORAGE_CENTRE_URL;
const KEY = process.env.STORAGE_CENTRE_MIGRATION_KEY;

async function main() {
  if (!BASE_URL || !KEY) {
    console.error('Set STORAGE_CENTRE_URL and STORAGE_CENTRE_MIGRATION_KEY environment variables before running this script.');
    process.exit(1);
  }

  console.log('Fetching export from the live Storage Centre app…');
  const url = `${BASE_URL}?action=exportForMigration&key=${encodeURIComponent(KEY)}`;
  const res = await fetch(url);
  if (!res.ok) {
    console.error(`Export request failed: HTTP ${res.status}`);
    process.exit(1);
  }
  const data = await res.json();
  if (data.error) {
    console.error('Export was refused:', data.error);
    process.exit(1);
  }

  const { items = [], pallets = [], clients = [], clientLogins = [], orders = [] } = data;
  console.log(`Fetched ${items.length} items, ${pallets.length} pallets, ${clients.length} clients, ${orders.length} orders.`);

  let itemsInserted = 0, itemsSkipped = 0;
  const insertItem = db.prepare(`INSERT INTO storage_items
    (id, client, job_number, reference_number, storage_centre, location, quantity, condition, photo, item, make, model, serial, price_week, start_date, end_date, added_by, last_edited_by, asset_tag, po_number, order_number)
    VALUES (@id, @client, @jobNumber, @referenceNumber, @storageCentre, @location, @quantity, @condition, @photo, @item, @make, @model, @serial, @priceWeek, @startDate, @endDate, @addedBy, @lastEditedBy, @assetTag, @poNumber, @orderNumber)`);
  const findItem = db.prepare('SELECT id FROM storage_items WHERE id = ?');
  for (const it of items) {
    const legacyId = String(it.id || '');
    if (!legacyId) continue;
    if (findItem.get(legacyId)) { itemsSkipped++; continue; }
    insertItem.run({
      id: legacyId,
      client: it.client || null, jobNumber: it.jobNumber || null, referenceNumber: it.referenceNumber || null,
      storageCentre: it.storageCentre || null, location: it.location || null, quantity: it.quantity != null ? String(it.quantity) : null,
      condition: it.condition || null, photo: it.photo || null, item: it.item || null, make: it.make || null,
      model: it.model || null, serial: it.serial || null, priceWeek: Number(it.priceWeek) || null,
      startDate: formatDate(it.startDate), endDate: formatDate(it.endDate), addedBy: it.addedBy || null,
      lastEditedBy: it.lastEditedBy || null, assetTag: it.assetTag || null, poNumber: it.poNumber || null,
      orderNumber: it.orderNumber || null,
    });
    itemsInserted++;
  }
  console.log(`Items: inserted ${itemsInserted}, skipped ${itemsSkipped} (already present).`);

  let palletsInserted = 0, palletsSkipped = 0;
  const insertPallet = db.prepare(`INSERT INTO storage_pallets
    (id, client, storage_centre, location, price_week, start_date, end_date, notes, added_by, last_edited_by)
    VALUES (@id, @client, @storageCentre, @location, @priceWeek, @startDate, @endDate, @notes, @addedBy, @lastEditedBy)`);
  const findPallet = db.prepare('SELECT id FROM storage_pallets WHERE id = ?');
  for (const p of pallets) {
    const legacyId = String(p.id || '');
    if (!legacyId) continue;
    if (findPallet.get(legacyId)) { palletsSkipped++; continue; }
    insertPallet.run({
      id: legacyId, client: p.client || null, storageCentre: p.storageCentre || null, location: p.location || null,
      priceWeek: Number(p.priceWeek) || null, startDate: formatDate(p.startDate), endDate: formatDate(p.endDate),
      notes: p.notes || null, addedBy: p.addedBy || null, lastEditedBy: p.lastEditedBy || null,
    });
    palletsInserted++;
  }
  console.log(`Pallets: inserted ${palletsInserted}, skipped ${palletsSkipped} (already present).`);

  const loginByClient = new Map(clientLogins.map((l) => [l.client, l.username]));
  let clientsInserted = 0, clientsSkipped = 0;
  const insertClient = db.prepare('INSERT INTO storage_clients (id, client_name, username, added_by) VALUES (?, ?, ?, ?)');
  const findClient = db.prepare('SELECT id FROM storage_clients WHERE client_name = ?');
  for (const name of clients) {
    if (!name) continue;
    if (findClient.get(name)) { clientsSkipped++; continue; }
    // Passwords are NOT migrated: the old app hashed them with a different
    // (non-bcrypt) scheme, so there is no way to carry a working password
    // across. Any client with a portal login will need their password reset
    // once the client portal is built in Work Desk.
    insertClient.run(randomUUID(), name, loginByClient.get(name) || null, 'migration');
    clientsInserted++;
  }
  console.log(`Clients: inserted ${clientsInserted}, skipped ${clientsSkipped} (already present). Portal passwords were NOT migrated — reset them once the client portal ships.`);

  let ordersInserted = 0, ordersSkipped = 0;
  const insertOrder = db.prepare(`INSERT INTO storage_orders
    (id, order_number, client, devices, delivery_address, site_contact_name, site_contact_phone, date_to_be_delivered, config_information, notes, requestor, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const findOrder = db.prepare('SELECT id FROM storage_orders WHERE order_number = ?');
  for (const o of orders) {
    const orderNumber = o.orderNumber || null;
    if (orderNumber && findOrder.get(orderNumber)) { ordersSkipped++; continue; }
    insertOrder.run(
      randomUUID(), orderNumber, o.client || null, o.devices || null, o.address || null,
      o.siteContactName || null, o.siteContactPhone || null, o.deliveryDate || null,
      o.configInfo || null, o.notes || null, o.requestor || null, o.status || 'Pending'
    );
    ordersInserted++;
  }
  console.log(`Orders: inserted ${ordersInserted}, skipped ${ordersSkipped} (already present).`);

  console.log('Migration complete.');
}

// The sheet stores dates as Apps Script Date objects, which JSON.stringify turns
// into ISO 8601 strings (e.g. "2026-03-01T00:00:00.000Z") — trims that down to the
// plain YYYY-MM-DD this app's date inputs expect.
function formatDate(v) {
  if (!v) return null;
  const s = String(v);
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : s;
}

main().catch((err) => { console.error(err); process.exit(1); });

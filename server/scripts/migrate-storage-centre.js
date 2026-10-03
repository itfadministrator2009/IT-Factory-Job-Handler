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
//   node server/scripts/migrate-storage-centre.js [flags]
//
// Flags (see the ARGS block below): --inspect, --only-receiving-dispatch,
// --reset-receiving-dispatch. To replace the receiving/dispatch rows imported
// before the stock type/qty fix, run once with:
//   --only-receiving-dispatch --reset-receiving-dispatch
//
// STORAGE_CENTRE_MIGRATION_KEY must match the MIGRATION_KEY script property set
// in the Apps Script project (File > Project Settings > Script Properties) —
// this is what the exportForMigration action checks before releasing any data.

const { randomUUID, createHash } = require('crypto');
const { db } = require('../db');

const BASE_URL = process.env.STORAGE_CENTRE_URL;
const KEY = process.env.STORAGE_CENTRE_MIGRATION_KEY;

// Flags:
//   --inspect                     fetch the export and print the field names and a
//                                 few sample receiving/dispatch rows (raw, and as
//                                 they would be mapped), then exit WITHOUT writing.
//   --only-receiving-dispatch     import only the Receiving/Dispatch log.
//   --reset-receiving-dispatch    delete all existing Receiving/Dispatch rows before
//                                 importing them (use once to replace the rows that
//                                 came across before the stock type/qty fix).
const ARGS = new Set(process.argv.slice(2));
const INSPECT = ARGS.has('--inspect');
const ONLY_RD = ARGS.has('--only-receiving-dispatch');
const RESET_RD = ARGS.has('--reset-receiving-dispatch');

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

  const { items = [], pallets = [], clients = [], clientLogins = [], orders = [], receivingDispatch = [] } = data;
  console.log(`Fetched ${items.length} items, ${pallets.length} pallets, ${clients.length} clients, ${orders.length} orders, ${receivingDispatch.length} receiving/dispatch entries.`);

  if (INSPECT) {
    inspectExport(data);
    return;
  }

  if (ONLY_RD) {
    console.log('--only-receiving-dispatch: skipping items, pallets, clients and orders.');
  } else {
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
  }

  // ReceivingDispatch rows have no natural unique id in the old sheet, so a
  // deterministic hash of every field stands in as the primary key here —
  // re-running this script hashes the same row to the same id and skips it,
  // instead of re-importing it as a duplicate.
  //
  // --reset-receiving-dispatch clears the table first (inside the same
  // transaction as the re-import, so a failure leaves the old rows in place).
  // Use it once to replace the rows imported before the stock type/qty fix.
  let rdInserted = 0, rdSkipped = 0, rdCleared = 0, rdWithStock = 0;
  const insertRD = db.prepare(`INSERT INTO storage_receiving_dispatch
    (id, client, date_received, date_dispatched, rate, stock_received_type, stock_received_qty, stock_dispatched_type, stock_dispatched_qty, receiving, dispatch, saved_by, saved_on)
    VALUES (@id, @client, @dateReceived, @dateDispatched, @rate, @stockReceivedType, @stockReceivedQty, @stockDispatchedType, @stockDispatchedQty, @receiving, @dispatch, @savedBy, @savedOn)`);
  const findRD = db.prepare('SELECT id FROM storage_receiving_dispatch WHERE id = ?');
  const importRD = db.transaction(() => {
    if (RESET_RD) rdCleared = db.prepare('DELETE FROM storage_receiving_dispatch').run().changes;
    for (const e of receivingDispatch) {
      const fields = mapReceivingDispatch(e);
      if (fields.stockReceivedQty != null || fields.stockDispatchedQty != null) rdWithStock++;
      const id = createHash('sha1').update(JSON.stringify(fields)).digest('hex');
      if (findRD.get(id)) { rdSkipped++; continue; }
      insertRD.run({ id, ...fields });
      rdInserted++;
    }
  });
  importRD();
  if (RESET_RD) console.log(`Receiving/Dispatch: cleared ${rdCleared} existing row(s) first (--reset-receiving-dispatch).`);
  console.log(`Receiving/Dispatch: inserted ${rdInserted}, skipped ${rdSkipped} (already present). ${rdWithStock} of ${receivingDispatch.length} carry a stock received/dispatched quantity.`);
  if (receivingDispatch.length && rdWithStock === 0) {
    console.warn('WARNING: no receiving/dispatch row had a stock quantity. The export may use field names this script does not recognise — run with --inspect and check the field names it prints.');
  }

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

// getReceivingDispatchLog() in Code.gs formats dates as 'dd/MM/yyyy' (and
// 'savedOn' as 'dd/MM/yyyy HH:mm') text, not ISO — these convert that to the
// plain YYYY-MM-DD / YYYY-MM-DD HH:mm this app's date inputs and SQLite expect.
function formatDMY(v) {
  if (!v) return null;
  const s = String(v).trim();
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  // Some rows may come through as ISO Date strings instead of dd/MM/yyyy text.
  // A full timestamp is a Sydney-midnight Date serialised in UTC (e.g.
  // 2026-02-28T13:00:00Z for 1 March), so convert it back to the Sydney day.
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) {
    const d = new Date(s);
    if (!Number.isNaN(d.getTime())) return d.toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });
  }
  const iso = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return iso ? iso[1] : s;
}
function formatDMYTime(v) {
  if (!v) return null;
  const m = String(v).match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}:\d{2})$/);
  return m ? `${m[3]}-${m[2]}-${m[1]} ${m[4]}:00` : String(v);
}

// ---------------------------------------------------------------------------
// Receiving/Dispatch field mapping
// ---------------------------------------------------------------------------
// The old sheet keeps stock received/dispatched as separate Type and Qty
// columns. The first import ignored them (they came through null), so the fee
// could never be calculated. The export's exact key names aren't pinned down
// here, so each field accepts the likely spellings — camelCase keys and the
// sheet's column headings. Run with --inspect to see what the export really
// sends and confirm the mapping before writing anything.
const RD_KEYS = {
  stockReceivedType: ['stockReceivedType', 'receivedType', 'stockTypeReceived', 'receivedStockType', 'Stock Received Type', 'Stock Received (Type)', 'Received Type'],
  stockReceivedQty: ['stockReceivedQty', 'stockReceivedQuantity', 'receivedQty', 'receivedQuantity', 'qtyReceived', 'Stock Received Qty', 'Stock Received Quantity', 'Stock Received (Qty)', 'Received Qty'],
  stockDispatchedType: ['stockDispatchedType', 'dispatchedType', 'stockTypeDispatched', 'dispatchedStockType', 'Stock Dispatched Type', 'Stock Dispatched (Type)', 'Dispatched Type'],
  stockDispatchedQty: ['stockDispatchedQty', 'stockDispatchedQuantity', 'dispatchedQty', 'dispatchedQuantity', 'qtyDispatched', 'Stock Dispatched Qty', 'Stock Dispatched Quantity', 'Stock Dispatched (Qty)', 'Dispatched Qty'],
};

function pick(obj, keys) {
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null && String(obj[k]).trim() !== '') return obj[k];
  }
  // Fall back to a case/space-insensitive match on the key name.
  const norm = (k) => String(k).toLowerCase().replace(/[^a-z]/g, '');
  const wanted = new Set(keys.map(norm));
  for (const [k, v] of Object.entries(obj)) {
    if (wanted.has(norm(k)) && v !== undefined && v !== null && String(v).trim() !== '') return v;
  }
  return null;
}

function textOrNull(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s || null;
}

// "Pallets: 3" / "Pallets: 3 @ $25" in a notes field — only used when the
// dedicated Type/Qty columns are empty, and only when the text is exactly
// that shape, so ordinary notes are never misread as stock.
function parseStockShorthand(text) {
  if (!text) return null;
  const m = String(text).trim().match(/^([^:;@]+?):\s*(\d+(?:\.\d+)?)(?:\s*@\s*\$?\s*\d+(?:\.\d+)?)?$/);
  return m ? { type: m[1].trim(), qty: m[2] } : null;
}

// "Individual Item: 65 @ $5" -> { type: 'Individual Item', qty: '65', rate: 5 }.
// Returns null unless the text is exactly one such part and its quantity agrees
// with the Qty column (or the Qty column is empty).
function singleStockPart(typeText, qtyText) {
  if (!typeText) return null;
  const pieces = String(typeText).split(/[;\n]+/).map((s) => s.trim()).filter(Boolean);
  if (pieces.length !== 1) return null;
  const m = pieces[0].match(/^(.+?):\s*(\d+(?:\.\d+)?)\s*(?:@\s*\$?\s*(\d+(?:\.\d+)?))?\s*$/);
  if (!m) return null;
  if (qtyText != null && qtyText !== '' && Number(qtyText) !== Number(m[2])) return null;
  return { type: m[1].trim(), qty: m[2], rate: m[3] != null ? Number(m[3]) : null };
}

function mapReceivingDispatch(e) {
  let stockReceivedType = textOrNull(pick(e, RD_KEYS.stockReceivedType));
  let stockReceivedQty = textOrNull(pick(e, RD_KEYS.stockReceivedQty));
  let stockDispatchedType = textOrNull(pick(e, RD_KEYS.stockDispatchedType));
  let stockDispatchedQty = textOrNull(pick(e, RD_KEYS.stockDispatchedQty));

  if (stockReceivedQty == null) {
    const s = parseStockShorthand(e.receiving);
    if (s) { stockReceivedType = stockReceivedType || s.type; stockReceivedQty = s.qty; }
  }
  if (stockDispatchedQty == null) {
    const s = parseStockShorthand(e.dispatch);
    if (s) { stockDispatchedType = stockDispatchedType || s.type; stockDispatchedQty = s.qty; }
  }

  const rateRaw = e.rate == null ? '' : String(e.rate).replace(/[^0-9.\-]/g, '');
  let rate = rateRaw === '' ? null : (Number.isFinite(Number(rateRaw)) ? Number(rateRaw) : null);

  // The old sheet's Type column usually holds "Type: Qty @ $Rate" (e.g.
  // "Individual Item: 65 @ $5") with the Rate column empty. Where a side is a
  // single such part, split it into clean Type / Qty / Rate. A side with
  // several parts (or rates that disagree) is left as written — the app's fee
  // calculation reads the parts directly, so the fee is right either way.
  const recv = singleStockPart(stockReceivedType, stockReceivedQty);
  const disp = singleStockPart(stockDispatchedType, stockDispatchedQty);
  const partRates = [recv, disp].filter((p) => p && p.rate != null).map((p) => p.rate);
  const ratesAgree = partRates.every((r) => r === partRates[0]) && (rate == null || partRates.every((r) => r === rate));
  if (ratesAgree) {
    if (partRates.length && rate == null) rate = partRates[0];
    if (recv) { stockReceivedType = recv.type; stockReceivedQty = recv.qty; }
    if (disp) { stockDispatchedType = disp.type; stockDispatchedQty = disp.qty; }
  }

  return {
    client: textOrNull(e.client),
    dateReceived: formatDMY(e.dateReceived),
    dateDispatched: formatDMY(e.dateDispatched),
    rate,
    stockReceivedType, stockReceivedQty, stockDispatchedType, stockDispatchedQty,
    receiving: textOrNull(e.receiving),
    dispatch: textOrNull(e.dispatch),
    savedBy: textOrNull(e.savedBy),
    savedOn: formatDMYTime(e.savedOn),
  };
}

function inspectExport(data) {
  const rd = data.receivingDispatch || [];
  console.log('\n--inspect: nothing will be written.\n');
  console.log('Top-level keys in the export:', Object.keys(data).join(', '));
  const keys = new Set();
  rd.forEach((e) => Object.keys(e || {}).forEach((k) => keys.add(k)));
  console.log('Receiving/Dispatch field names:', [...keys].join(', ') || '(none)');
  rd.slice(0, 3).forEach((e, i) => {
    console.log(`\nSample ${i + 1} — raw:`);
    console.log(JSON.stringify(e, null, 2));
    console.log(`Sample ${i + 1} — as it will be imported:`);
    console.log(JSON.stringify(mapReceivingDispatch(e), null, 2));
  });
  const withStock = rd.filter((e) => {
    const m = mapReceivingDispatch(e);
    return m.stockReceivedQty != null || m.stockDispatchedQty != null;
  }).length;
  console.log(`\n${withStock} of ${rd.length} receiving/dispatch rows map to a stock quantity.`);

  // Fee each row will get in the app (same rule as rdFees in routes/storage.js).
  const parts = (t) => String(t || '').split(/[;\n]+/).map((x) => x.trim().match(/^(.+?):\s*(\d+(?:\.\d+)?)\s*(?:@\s*\$?\s*(\d+(?:\.\d+)?))?\s*$/)).filter(Boolean);
  const side = (t, q, r) => { const ps = parts(t); return ps.length ? ps.reduce((a, m) => a + Number(m[2]) * (m[3] != null ? Number(m[3]) : r), 0) : r * (Number(q) || 0); };
  let zero = 0, total = 0;
  console.log('\nFee per row (client | date | received | dispatched | fee):');
  rd.forEach((e) => {
    const m = mapReceivingDispatch(e);
    const r = Number(m.rate) || 0;
    const fee = side(m.stockReceivedType, m.stockReceivedQty, r) + side(m.stockDispatchedType, m.stockDispatchedQty, r);
    total += fee;
    if (!fee) zero++;
    const lbl = (t, q) => (t || q ? `${t || ''} x${q || ''}` : '-');
    console.log(`  ${m.client} | ${m.dateReceived || m.dateDispatched || '-'} | ${lbl(m.stockReceivedType, m.stockReceivedQty)} | ${lbl(m.stockDispatchedType, m.stockDispatchedQty)} | $${fee.toFixed(2)}${fee ? '' : '   <-- $0'}`);
  });
  console.log(`\nTotal fees: $${total.toFixed(2)}. Rows with a $0 fee: ${zero} of ${rd.length}.`);
}

if (require.main === module) {
  main().catch((err) => { console.error(err); process.exit(1); });
}

module.exports = { mapReceivingDispatch, parseStockShorthand, singleStockPart };

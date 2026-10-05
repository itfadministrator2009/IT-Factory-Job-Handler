// Storage Centre billing rules, shared by the Reports summary, the invoice PDF and
// the client portal so every figure comes from the same calculation.
//
// Storage cost mirrors the old Apps Script app's computeStorageCostForClient_:
// a client's items are grouped by storage centre + location; a group that has a
// pallet record (3-tier lookup: exact pallet > any pallet at that storage centre >
// any pallet for that client) is charged the pallet's weekly rate for the days the
// pallet overlaps the period; otherwise each item is charged its own weekly rate
// for the days it overlaps the period.
//
// Receiving/dispatch fees: see rdFees below.

const { db } = require('./db');

const ALL_PALLETS = '__ALL__';
const ALL_PALLETS_AT_CENTRE = '__ALL_AT_CENTRE__';

function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

function toQty(v) {
  if (v == null || v === '') return 0;
  const n = Number(String(v).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

// ---------------------------------------------------------------------------
// Receiving / dispatch fees
// ---------------------------------------------------------------------------
// The old app wrote the stock Type column as "Type: Qty @ $Rate" (several parts
// separated by ";" or new lines), e.g. "Individual Item: 65 @ $5", and often left
// the Rate column empty. When the type text has that shape, the fee comes from
// its own parts (each part's rate, falling back to the entry's rate). Otherwise
// it's the entry's rate × the Qty column.
function parseStockParts(text) {
  if (!text) return [];
  const parts = [];
  for (const piece of String(text).split(/[;\n]+/)) {
    const m = piece.trim().match(/^(.+?):\s*(\d+(?:\.\d+)?)\s*(?:@\s*\$?\s*(\d+(?:\.\d+)?))?\s*$/);
    if (m) parts.push({ type: m[1].trim(), qty: Number(m[2]), rate: m[3] != null ? Number(m[3]) : null });
  }
  return parts;
}
function sideFee(typeText, qty, rate) {
  const parts = parseStockParts(typeText);
  if (parts.length) return parts.reduce((t, p) => t + p.qty * (p.rate != null ? p.rate : rate), 0);
  return rate * toQty(qty);
}
// row uses DB column names (stock_received_type etc.).
function rdFees(row) {
  const rate = Number(row.rate) || 0;
  const received = round2(sideFee(row.stock_received_type, row.stock_received_qty, rate));
  const dispatched = round2(sideFee(row.stock_dispatched_type, row.stock_dispatched_qty, rate));
  return { received, dispatched, total: round2(received + dispatched) };
}

function stockText(type, qty) {
  if (parseStockParts(type).length) return String(type).split(/[;\n]+/).map((s) => s.trim()).filter(Boolean).join('; ');
  if (!type && (qty == null || qty === '')) return '';
  return `${type || 'Stock'} x ${qty ?? 0}`;
}

// Receiving/dispatch charges falling in [from, to] (YYYY-MM-DD strings). Each half
// of an entry is charged in the period its own date falls in: the received fee by
// date_received, the dispatched fee by date_dispatched — exactly as the old app's
// weekly invoicing did. An entry with no date on a side is not billed for that side.
function rdLinesInPeriod(rows, from, to) {
  const inRange = (d) => !!d && d >= from && d <= to;
  const lines = [];
  rows.forEach((row) => {
    const fees = rdFees(row);
    if (inRange(row.date_received) && (fees.received || row.stock_received_type || row.stock_received_qty)) {
      lines.push({ client: row.client, date: row.date_received, kind: 'Receiving', description: stockText(row.stock_received_type, row.stock_received_qty), rate: row.rate, amount: fees.received });
    }
    if (inRange(row.date_dispatched) && (fees.dispatched || row.stock_dispatched_type || row.stock_dispatched_qty)) {
      lines.push({ client: row.client, date: row.date_dispatched, kind: 'Dispatch', description: stockText(row.stock_dispatched_type, row.stock_dispatched_qty), rate: row.rate, amount: fees.dispatched });
    }
  });
  return lines.sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

// ---------------------------------------------------------------------------
// Storage cost
// ---------------------------------------------------------------------------
// Text is compared ignoring case and extra spaces, so "ITF Sydney Warehouse" and
// "ITF SYDNEY WAREHOUSE" are the same place and "Viridian" / "VIRIDIAN" the same client.
const lc = (v) => String(v || '').trim().replace(/\s+/g, ' ').toLowerCase();

function getPalletRate(pallets, client, storageCentre, location) {
  if (!location) return null;
  const c = lc(client); const s = lc(storageCentre); const l = lc(location);
  const exact = pallets.find((p) => lc(p.client) === c && lc(p.storageCentre) === s && lc(p.location) === l);
  if (exact) return exact;
  const centreWildcard = pallets.find((p) => lc(p.client) === c && lc(p.storageCentre) === s && p.location === ALL_PALLETS_AT_CENTRE);
  if (centreWildcard) return centreWildcard;
  return pallets.find((p) => lc(p.client) === c && p.location === ALL_PALLETS) || null;
}

function overlapDays(item, from, to) {
  if (!item.startDate) return 0;
  const itemStart = new Date(item.startDate + 'T00:00:00');
  const itemEnd = item.endDate ? new Date(item.endDate + 'T00:00:00') : new Date();
  const start = itemStart > from ? itemStart : from;
  const end = itemEnd < to ? itemEnd : to;
  if (start > end) return 0;
  const startMs = Date.UTC(start.getFullYear(), start.getMonth(), start.getDate());
  const endMs = Date.UTC(end.getFullYear(), end.getMonth(), end.getDate());
  return Math.floor((endMs - startMs) / 86400000) + 1;
}

// One line per storage centre + location group. Amounts are unrounded so the
// total matches the old calculation exactly; round when displaying.
function storageCostLines(client, allItems, pallets, from, to) {
  const groups = {};
  allItems.filter((i) => lc(i.client) === lc(client)).forEach((i) => {
    // One group per storage centre + location however it's capitalised, so a pallet
    // rate is charged once even when items spell the centre differently.
    const key = `${lc(i.storageCentre)}|||${lc(i.location)}`;
    if (!groups[key]) groups[key] = { storageCentre: i.storageCentre || '', location: i.location || '', items: [] };
    groups[key].items.push(i);
  });
  const lines = [];
  Object.values(groups).forEach((g) => {
    const palletRecord = g.location ? getPalletRate(pallets, client, g.storageCentre, g.location) : null;
    if (palletRecord) {
      const days = Math.max(palletRecord.startDate ? overlapDays(palletRecord, from, to) : Math.floor((to - from) / 86400000) + 1, 0);
      const ratePerWeek = Number(palletRecord.priceWeek) || 0;
      const amount = (ratePerWeek / 7) * days;
      if (days > 0) {
        lines.push({ kind: 'pallet', storageCentre: g.storageCentre, location: g.location, itemCount: g.items.length, days, ratePerWeek, amount });
      }
    } else {
      let amount = 0; let billedItems = 0; let itemDays = 0;
      g.items.forEach((i) => {
        const days = overlapDays(i, from, to);
        if (days > 0) { amount += ((Number(i.priceWeek) || 0) / 7) * days; billedItems += 1; itemDays += days; }
      });
      if (billedItems > 0) {
        lines.push({ kind: 'items', storageCentre: g.storageCentre, location: g.location, itemCount: billedItems, days: itemDays, ratePerWeek: null, amount });
      }
    }
  });
  return lines.sort((a, b) => `${a.storageCentre} ${a.location}`.localeCompare(`${b.storageCentre} ${b.location}`, undefined, { numeric: true }));
}

function computeStorageCostForClient(client, allItems, pallets, from, to) {
  return storageCostLines(client, allItems, pallets, from, to).reduce((t, l) => t + l.amount, 0);
}

// ---------------------------------------------------------------------------
// Data loading + per-client statement
// ---------------------------------------------------------------------------
function loadBillingData() {
  const allItems = db.prepare('SELECT client, storage_centre, location, price_week, start_date, end_date FROM storage_items').all()
    .map((r) => ({ client: r.client, storageCentre: r.storage_centre, location: r.location, priceWeek: r.price_week, startDate: r.start_date, endDate: r.end_date }));
  const pallets = db.prepare('SELECT client, storage_centre, location, price_week, start_date, end_date FROM storage_pallets').all()
    .map((r) => ({ client: r.client, storageCentre: r.storage_centre, location: r.location, priceWeek: r.price_week, startDate: r.start_date, endDate: r.end_date }));
  const rdRows = db.prepare('SELECT * FROM storage_receiving_dispatch').all();
  return { allItems, pallets, rdRows };
}

function parsePeriod(from, to) {
  const ok = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
  if (!ok(from) || !ok(to)) return null;
  if (from > to) return null;
  return { fromDate: new Date(`${from}T00:00:00`), toDate: new Date(`${to}T23:59:59`) };
}

// Everything billable for one client in a period. `data` lets callers reuse one load.
function clientStatement(client, from, to, data = loadBillingData()) {
  const period = parsePeriod(from, to);
  if (!period) throw new Error('from and to must be YYYY-MM-DD with from <= to');
  const storageLines = storageCostLines(client, data.allItems, data.pallets, period.fromDate, period.toDate)
    .map((l) => ({ ...l, amount: round2(l.amount) }));
  const rdLines = rdLinesInPeriod(data.rdRows.filter((r) => lc(r.client) === lc(client)), from, to);
  const storageTotal = round2(computeStorageCostForClient(client, data.allItems, data.pallets, period.fromDate, period.toDate));
  const rdTotal = round2(rdLines.reduce((t, l) => t + l.amount, 0));
  return { client, from, to, storageLines, rdLines, storageTotal, rdTotal, total: round2(storageTotal + rdTotal) };
}

// One name per client however it's capitalised: the most common spelling wins.
function displayNames(names) {
  const byKey = new Map();
  names.filter((n) => String(n || '').trim()).forEach((n) => {
    const k = lc(n); const s = String(n).trim();
    if (!byKey.has(k)) byKey.set(k, new Map());
    byKey.get(k).set(s, (byKey.get(k).get(s) || 0) + 1);
  });
  return [...byKey.values()].map((m) => [...m].sort((a, b) => b[1] - a[1])[0][0]).sort((a, b) => a.localeCompare(b));
}

// The Reports summary: one row per client with storage items or fees in the period.
function summary(from, to, data = loadBillingData()) {
  const period = parsePeriod(from, to);
  if (!period) throw new Error('from and to must be YYYY-MM-DD with from <= to');
  const feesByClient = {};
  rdLinesInPeriod(data.rdRows, from, to).forEach((l) => {
    if (!l.client) return;
    const f = feesByClient[lc(l.client)] || (feesByClient[lc(l.client)] = { receiving: 0, dispatch: 0 });
    if (l.kind === 'Receiving') f.receiving += l.amount; else f.dispatch += l.amount;
  });
  const clients = displayNames([...data.allItems.map((i) => i.client), ...data.rdRows.filter((r) => feesByClient[lc(r.client)]).map((r) => r.client)]);
  const rows = clients.map((client) => {
    const storageCost = round2(computeStorageCostForClient(client, data.allItems, data.pallets, period.fromDate, period.toDate));
    const f = feesByClient[lc(client)] || { receiving: 0, dispatch: 0 };
    const receivingFees = round2(f.receiving);
    const dispatchFees = round2(f.dispatch);
    const receivingDispatchFees = round2(f.receiving + f.dispatch);
    return { client, storageCost, receivingFees, dispatchFees, receivingDispatchFees, total: round2(storageCost + receivingDispatchFees) };
  });
  return { from, to, summary: rows, grandTotal: round2(rows.reduce((t, s) => t + s.total, 0)) };
}

module.exports = {
  ALL_PALLETS, ALL_PALLETS_AT_CENTRE,
  round2, toQty, parseStockParts, sideFee, rdFees, stockText, rdLinesInPeriod,
  getPalletRate, overlapDays, storageCostLines, computeStorageCostForClient,
  loadBillingData, parsePeriod, clientStatement, summary, displayNames, lc,
};

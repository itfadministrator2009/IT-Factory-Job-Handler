// Storage Centre staff tools ported from the old Apps Script app: billing gaps,
// the storage calculator, the dashboard figures, model-name cleanup and the
// spreadsheet import's value coercion. Billing rules come from storageBilling.js
// so every screen agrees with the invoices.
const { db } = require('./db');
const {
  round2, getPalletRate, overlapDays, storageCostLines, computeStorageCostForClient, parsePeriod,
} = require('./storageBilling');

const TZ = process.env.BACKUP_TIMEZONE || 'Australia/Sydney';

db.exec(`CREATE TABLE IF NOT EXISTS storage_meta (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT NOT NULL DEFAULT (datetime('now')))`);

function getMeta(key) {
  return db.prepare('SELECT value, updated_at FROM storage_meta WHERE key = ?').get(key) || null;
}
function setMeta(key, value) {
  db.prepare(`INSERT INTO storage_meta (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`).run(key, value);
}

const naturalCompare = (a, b) => String(a || '').localeCompare(String(b || ''), undefined, { numeric: true, sensitivity: 'base' });
const norm = (v) => String(v || '').trim().replace(/\s+/g, ' ').toLowerCase();

// Full item rows in the camelCase shape the billing helpers use.
function loadItems() {
  return db.prepare('SELECT * FROM storage_items').all().map((r) => ({
    id: r.id, client: r.client, jobNumber: r.job_number, referenceNumber: r.reference_number,
    storageCentre: r.storage_centre, location: r.location, quantity: r.quantity, condition: r.condition,
    item: r.item, make: r.make, model: r.model, serial: r.serial, priceWeek: r.price_week,
    startDate: r.start_date, endDate: r.end_date, assetTag: r.asset_tag, poNumber: r.po_number, orderNumber: r.order_number,
  }));
}
function loadPallets() {
  return db.prepare('SELECT * FROM storage_pallets').all().map((r) => ({
    id: r.id, client: r.client, storageCentre: r.storage_centre, location: r.location,
    priceWeek: r.price_week, startDate: r.start_date, endDate: r.end_date,
  }));
}

// Old app: an item is "In storage" when it has a start date and no end date.
const isInStorage = (i) => !!i.startDate && !i.endDate;

// ---------------------------------------------------------------------------
// Billing gaps — the old renderBillingGaps: items costing $0/week because they
// have no rate of their own and no pallet rate (> $0) covers their location.
// Like the old app it looks at every item, in storage or not.
// ---------------------------------------------------------------------------
function billingGaps(items = loadItems(), pallets = loadPallets()) {
  return items.filter((i) => {
    if ((Number(i.priceWeek) || 0) > 0) return false;
    if (!i.location) return true;
    const p = getPalletRate(pallets, i.client, i.storageCentre, i.location);
    return !p || (Number(p.priceWeek) || 0) <= 0;
  }).sort((a, b) => naturalCompare(a.client, b.client) || naturalCompare(a.location, b.location));
}

// ---------------------------------------------------------------------------
// Date presets (old getPresetRange), computed from today's date in Sydney.
// ---------------------------------------------------------------------------
function todayParts(date = new Date()) {
  const [y, m, d] = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(date).split('-').map(Number);
  return { y, m: m - 1, d };
}
const ymd = (dt) => `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
const U = (y, m, d) => new Date(Date.UTC(y, m, d));

function presetRange(preset, date = new Date()) {
  const { y, m, d } = todayParts(date);
  const today = U(y, m, d);
  if (preset === 'lastWeek') {
    const sinceMonday = (today.getUTCDay() + 6) % 7;
    const thisMonday = U(y, m, d - sinceMonday);
    return { from: ymd(U(y, m, d - sinceMonday - 7)), to: ymd(new Date(thisMonday.getTime() - 86400000)) };
  }
  if (preset === 'lastMonth') return { from: ymd(U(y, m - 1, 1)), to: ymd(U(y, m, 0)) };
  if (preset === 'lastQuarter') {
    const q = Math.floor(m / 3) * 3;
    return { from: ymd(U(y, q - 3, 1)), to: ymd(U(y, q, 0)) };
  }
  if (preset === 'lastYear') return { from: `${y - 1}-01-01`, to: `${y - 1}-12-31` };
  if (preset === 'lastFY') {
    const fyStart = m >= 6 ? y : y - 1;
    return { from: `${fyStart - 1}-07-01`, to: `${fyStart}-06-30` };
  }
  return null;
}
const PRESETS = ['lastWeek', 'lastMonth', 'lastQuarter', 'lastYear', 'lastFY'];

// ---------------------------------------------------------------------------
// Storage calculator — the old runCalculation. groupBy:
//   'all'      pallet rows (pallet rate) + item rows (everything else)
//   'location' one row per storage centre + location
//   'none'     one row per item at its own rate (ignores pallet rates, as before)
// ---------------------------------------------------------------------------
function calculator({ from, to, client, centre, groupBy = 'all' }, items = loadItems(), pallets = loadPallets()) {
  const period = parsePeriod(from, to);
  if (!period) throw new Error('from and to must be YYYY-MM-DD with from <= to');
  const { fromDate, toDate } = period;
  // Items with no client aren't billed anywhere, so they're left out here too.
  const scoped = items.filter((i) => i.client && (!client || i.client === client) && (!centre || norm(i.storageCentre) === norm(centre)));

  if (groupBy === 'none') {
    const rows = scoped.map((i) => {
      const days = overlapDays(i, fromDate, toDate);
      return { id: i.id, client: i.client, jobNumber: i.jobNumber, item: i.item, make: i.make, model: i.model, serial: i.serial, ratePerWeek: Number(i.priceWeek) || 0, days, cost: ((Number(i.priceWeek) || 0) / 7) * days };
    }).filter((r) => r.days > 0)
      .sort((a, b) => naturalCompare(a.client, b.client) || naturalCompare(a.jobNumber, b.jobNumber));
    const total = rows.reduce((t, r) => t + r.cost, 0);
    return { from, to, groupBy, rows: rows.map((r) => ({ ...r, cost: round2(r.cost) })), itemCount: rows.length, total: round2(total) };
  }

  const groups = {};
  scoped.forEach((i) => {
    const key = `${i.client}|||${i.storageCentre || ''}|||${i.location || ''}`;
    if (!groups[key]) groups[key] = { client: i.client, storageCentre: i.storageCentre || '', location: i.location || '', items: [] };
    groups[key].items.push(i);
  });
  const ordered = Object.values(groups).sort((a, b) => naturalCompare(a.location, b.location) || naturalCompare(a.storageCentre, b.storageCentre) || naturalCompare(a.client, b.client));

  const rows = [];
  let palletCount = 0; let itemRows = 0; let total = 0; let itemsOnPallets = 0;
  ordered.forEach((g) => {
    const pallet = g.location ? getPalletRate(pallets, g.client, g.storageCentre, g.location) : null;
    if (pallet) {
      const cost = storageCostLines(g.client, g.items, [pallet], fromDate, toDate).reduce((t, l) => t + l.amount, 0);
      if (groupBy === 'location') {
        rows.push({ type: 'Location', client: g.client, storageCentre: g.storageCentre, location: g.location, itemCount: g.items.length, billedAs: `Pallet rate (${money(pallet.priceWeek)}/wk)`, cost: round2(cost) });
      } else if (cost > 0) {
        rows.push({ type: 'Pallet', client: g.client, storageCentre: g.storageCentre, location: g.location, itemCount: g.items.length, billedAs: `Pallet rate (${money(pallet.priceWeek)}/wk)`, cost: round2(cost) });
      }
      if (cost > 0 || groupBy === 'location') { palletCount += 1; itemsOnPallets += g.items.length; }
      total += cost;
      return;
    }
    let groupCost = 0;
    g.items.forEach((i) => {
      const days = overlapDays(i, fromDate, toDate);
      if (days <= 0) return;
      const cost = ((Number(i.priceWeek) || 0) / 7) * days;
      groupCost += cost;
      if (groupBy === 'all') {
        itemRows += 1;
        rows.push({ type: 'Item', id: i.id, client: i.client, storageCentre: g.storageCentre, location: g.location, item: i.item, jobNumber: i.jobNumber, serial: i.serial, days, billedAs: 'Per item', cost: round2(cost) });
      }
    });
    if (groupBy === 'location') {
      palletCount += 1; itemsOnPallets += g.items.length;
      rows.push({ type: 'Location', client: g.client, storageCentre: g.storageCentre, location: g.location || '(none)', itemCount: g.items.length, billedAs: 'Sum of items', cost: round2(groupCost) });
    }
    total += groupCost;
  });
  return { from, to, groupBy, rows, palletCount, itemRows, itemCount: groupBy === 'location' ? itemsOnPallets : undefined, total: round2(total) };
}

function money(n) { return `$${(Number(n) || 0).toFixed(2)}`; }

// ---------------------------------------------------------------------------
// Dashboard — the old renderDashboard figures.
// ---------------------------------------------------------------------------
function dashboard(date = new Date(), items = loadItems(), pallets = loadPallets()) {
  const ranges = Object.fromEntries(PRESETS.map((p) => [p, presetRange(p, date)]));
  const clients = [...new Set(items.map((i) => i.client).filter(Boolean))].sort(naturalCompare);
  const costByClient = clients.map((client) => {
    const row = { client };
    PRESETS.forEach((p) => {
      const { fromDate, toDate } = parsePeriod(ranges[p].from, ranges[p].to);
      row[p] = round2(computeStorageCostForClient(client, items, pallets, fromDate, toDate));
    });
    return row;
  });
  const inStorage = items.filter(isInStorage);
  const countsByClient = {};
  inStorage.forEach((i) => { const k = i.client || '(no client)'; countsByClient[k] = (countsByClient[k] || 0) + 1; });
  const totalQuantity = inStorage.reduce((t, i) => t + (Number(String(i.quantity ?? '').replace(/[^0-9.\-]/g, '')) || 0), 0);

  // Locations in use (current items) that nobody has classified as pallet / not pallet.
  const classified = new Set(db.prepare('SELECT location_key FROM storage_locations_registry').all().map((r) => r.location_key));
  const unclassified = new Set();
  inStorage.forEach((i) => { const k = norm(i.location); if (k && !classified.has(k)) unclassified.add(k); });

  const backup = getMeta('last_backup_at');
  return {
    ranges,
    costByClient,
    itemsByClient: Object.entries(countsByClient).map(([client, count]) => ({ client, count })).sort((a, b) => b.count - a.count),
    stats: { inStorage: inStorage.length, clients: new Set(inStorage.map((i) => i.client).filter(Boolean)).size, totalQuantity },
    unclassifiedLocations: unclassified.size,
    lastBackupAt: backup ? backup.value : null,
    billingGaps: billingGaps(items, pallets).filter(isInStorage).length,
  };
}

// ---------------------------------------------------------------------------
// Model cleanup — old getModelSummaryForCleanup: exact trimmed make + model
// spellings with their counts and item ids. The client groups spellings that
// share a model token (e.g. "E77830") and offers to rename them to one.
// ---------------------------------------------------------------------------
function modelSummary(client, items = loadItems()) {
  const groups = {};
  items.filter((i) => !client || i.client === client).forEach((i) => {
    const make = String(i.make || '').trim();
    const model = String(i.model || '').trim();
    if (!make && !model) return;
    const key = `${make}\u0001${model}`;
    if (!groups[key]) groups[key] = { make, model, count: 0, ids: [] };
    groups[key].count += 1;
    groups[key].ids.push(i.id);
  });
  return Object.values(groups).sort((a, b) => b.count - a.count);
}

// ---------------------------------------------------------------------------
// Import coercion — old bulkSaveItems + parseLocalDate_.
// ---------------------------------------------------------------------------
// Accepts YYYY-MM-DD (or a longer ISO string), D/M/YYYY (Australian), an Excel
// serial number, or anything Date can parse. Returns YYYY-MM-DD or null.
function parseLocalDate(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number' || /^\d{4,6}(\.\d+)?$/.test(String(v).trim())) {
    const n = Number(v);
    if (n > 20000 && n < 80000) return ymd(new Date(Math.round((n - 25569) * 86400000)));
  }
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return valid(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/);
  if (m) {
    let y = +m[3];
    if (y < 100) y += 2000;
    return valid(y, +m[2], +m[1]);
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : ymd(U(d.getFullYear(), d.getMonth(), d.getDate()));
}
function valid(y, mo, d) {
  const dt = U(y, mo - 1, d);
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d ? ymd(dt) : null;
}
function toNumberOrNull(v) {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) && String(v).replace(/[^0-9.\-]/g, '') !== '' ? n : null;
}

module.exports = {
  getMeta, setMeta, loadItems, loadPallets, isInStorage, billingGaps, presetRange, PRESETS,
  calculator, dashboard, modelSummary, parseLocalDate, toNumberOrNull, naturalCompare,
};

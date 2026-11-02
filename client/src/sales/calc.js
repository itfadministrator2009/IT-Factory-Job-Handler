// ITF Sales Manager — the old Google Sheets app's maths, options and printing,
// shared by every Sales Manager page.
import qrcode from 'qrcode-generator';

export const ITEM_TYPES = ['Laptop', 'Desktop', 'AIO', 'Tablet', 'Phone', 'Monitor', 'Projector', 'Dock', 'Cable',
  'Hard Drive', 'PC Part', 'Watch', 'Bundle', 'Accessory', 'Other'];
export const PLATFORMS = ['eBay', 'Shopify', 'Direct', 'Value Grade'];
export const SALE_STATUSES = ['Sold', 'Pending', 'Refunded', 'Return to Inventory on Hand'];
export const INV_STATUSES = ['Not Tested', 'Tested', 'Listed'];
// Default labour cost per item type (inventory items).
export const LABOUR_COST_BY_TYPE = {
  Laptop: 35, Desktop: 35, AIO: 35, Tablet: 35, Phone: 20, Monitor: 5, Projector: 15, Dock: 5, Cable: 1,
  'Hard Drive': 15, 'PC Part': 5, Watch: 20, Bundle: 35, Accessory: 10, Other: 10,
};
export const DEFAULT_PACK_HANDLE = 5;
export const DEFAULT_ADS_COST = 35; // inventory items

// --- Formatting ---------------------------------------------------------------
export const num = (v) => parseFloat(v) || 0;
export const fmt = (n) => `${(Number(n) || 0) < 0 ? '-' : ''}$${Math.abs(Math.round((Number(n) || 0) * 100) / 100).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const fmtInt = (n) => (Number(n) || 0).toLocaleString('en-AU');
export const pct = (m) => `${Math.round((m || 0) * 10) / 10}%`;
export const str = (v) => (v === null || v === undefined ? '' : String(v));
const pad2 = (n) => String(n).padStart(2, '0');
export const toISODate = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
export function auDate(iso) {
  if (!iso) return '—';
  const p = String(iso).split('-');
  return p.length === 3 ? `${p[2].slice(0, 2)}/${p[1]}/${p[0]}` : String(iso);
}
export function parseAUDate(s) {
  const m = String(s || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return '';
  const dd = m[1].padStart(2, '0');
  const mm = m[2].padStart(2, '0');
  if (+dd < 1 || +dd > 31 || +mm < 1 || +mm > 12) return '';
  return `${m[3]}-${mm}-${dd}`;
}
export function formatBatteryHealth(v) {
  if (v === undefined || v === null || v === '') return '—';
  const s = String(v).trim();
  const m = s.match(/^(\d+(\.\d+)?)\s*%?$/);
  if (m) {
    let n = parseFloat(m[1]);
    if (n > 0 && n <= 1 && !s.includes('%')) n *= 100; // 0.84 -> 84%
    return `${Math.round(n)}%`;
  }
  return s;
}
export const daysInStock = (e) => (e.createdAt ? Math.floor((Date.now() - Number(e.createdAt)) / 86400000) : null);
export const platformClass = (p) => {
  const x = String(p || '').toLowerCase();
  return x === 'ebay' ? 'ebay' : x === 'shopify' ? 'shopify' : 'other';
};

// --- Weekly labour + Google Ads split ------------------------------------------
// Labour and Google Ads are fixed WEEKLY costs. Each Mon–Sun week (by sell date)
// the cost is divided across that week's sales; the current week only carries
// the part of the week that has passed so far (Wednesday = 3/7).
export function weekStartISO(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  if (!m) return '';
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return toISODate(d);
}
function weekFraction(weekStart) {
  const now = new Date();
  if (weekStart !== weekStartISO(toISODate(now))) return 1;
  return (((now.getDay() + 6) % 7) + 1) / 7;
}

// Built once per list of sales; gives each sale its share of the weekly costs.
export function makeCalc(sales, costs = { labour: 3000, ads: 1000 }) {
  const counts = {};
  sales.forEach((e) => { const w = weekStartISO(e.selldate); if (w) counts[w] = (counts[w] || 0) + 1; });
  const shares = {};
  Object.keys(counts).forEach((w) => {
    const f = weekFraction(w);
    shares[w] = { labour: (costs.labour * f) / counts[w], ads: (costs.ads * f) / counts[w] };
  });
  // extra: 1 for an unsaved sale (counts as one more order in its week).
  const share = (e, extra = 0) => {
    const w = weekStartISO(e.selldate);
    if (!w) return null;
    if (!extra) return shares[w] || null;
    const n = (counts[w] || 0) + extra;
    if (n <= 0) return null;
    const f = weekFraction(w);
    return { labour: (costs.labour * f) / n, ads: (costs.ads * f) / n };
  };
  const labour = (e, extra) => { const s = share(e, extra); return s ? s.labour : num(e.labour); };
  const ads = (e, extra) => { const s = share(e, extra); return s ? s.ads : num(e.adscost); };
  const revenue = (e) => num(e.sellprice) + num(e.extendedwarranty);
  const net = (e, extra) => revenue(e) - num(e.cost) - num(e.postage) - num(e.fees) - num(e.packhandle) - labour(e, extra) - ads(e, extra);
  const margin = (e, extra) => { const r = revenue(e); return r > 0 ? (net(e, extra) / r) * 100 : 0; };
  const other = (e) => num(e.packhandle) + labour(e) + ads(e);
  // Totals for a list of sales (dashboard, reports, weekly tables).
  const totals = (list) => {
    const t = { count: list.length, revenue: 0, cost: 0, postage: 0, fees: 0, postageFees: 0, packhandle: 0, labour: 0, ads: 0, other: 0, net: 0, marginSum: 0 };
    list.forEach((e) => {
      t.revenue += revenue(e); t.cost += num(e.cost); t.postage += num(e.postage); t.fees += num(e.fees);
      t.packhandle += num(e.packhandle); t.labour += labour(e); t.ads += ads(e); t.marginSum += margin(e);
    });
    t.postageFees = t.postage + t.fees;
    t.other = t.packhandle + t.labour + t.ads;
    t.net = t.revenue - t.cost - t.postageFees - t.other;
    t.avgMargin = t.count ? t.marginSum / t.count : 0;
    return t;
  };
  return { labour, ads, revenue, net, margin, other, totals, share };
}

// --- Report periods -------------------------------------------------------------
export function periodRange(period, custom = {}) {
  const now = new Date();
  let start;
  let end;
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7));
  if (period === 'week') {
    start = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() - 7);
    end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 6);
  } else if (period === 'month') {
    start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    end = new Date(now.getFullYear(), now.getMonth(), 0);
  } else if (period === 'quarter') {
    let q = Math.floor(now.getMonth() / 3) - 1;
    let y = now.getFullYear();
    if (q < 0) { q = 3; y -= 1; }
    start = new Date(y, q * 3, 1);
    end = new Date(y, q * 3 + 3, 0);
  } else if (period === 'year') {
    start = new Date(now.getFullYear() - 1, 0, 1);
    end = new Date(now.getFullYear() - 1, 11, 31);
  } else if (period === 'fy') {
    const fy = now.getMonth() >= 6 ? now.getFullYear() - 1 : now.getFullYear() - 2; // last Australian FY (1 Jul – 30 Jun)
    start = new Date(fy, 6, 1);
    end = new Date(fy + 1, 5, 30);
  } else if (period === 'custom') {
    const s = parseAUDate(custom.start);
    const e = parseAUDate(custom.end);
    start = s ? new Date(`${s}T00:00:00`) : null;
    end = e ? new Date(`${e}T00:00:00`) : null;
    if (!start && !end) return null;
    if (!start) start = new Date(2000, 0, 1);
    if (!end) end = now;
    if (start > end) [start, end] = [end, start];
  } else {
    return null; // all time
  }
  return { start, end, startISO: toISODate(start), endISO: toISODate(end) };
}

// Mon–Sun weeks covering a range (newest first), clipped to the range.
export function weeksIn(range) {
  const out = [];
  const rs = new Date(range.start.getFullYear(), range.start.getMonth(), range.start.getDate());
  const re = new Date(range.end.getFullYear(), range.end.getMonth(), range.end.getDate());
  let cur = new Date(rs.getFullYear(), rs.getMonth(), rs.getDate() - ((rs.getDay() + 6) % 7));
  for (let i = 0; cur <= re && i < 600; i += 1) {
    const ce = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate() + 6);
    const s = cur < rs ? rs : cur;
    const e = ce > re ? re : ce;
    out.push({ startISO: toISODate(s), endISO: toISODate(e) });
    cur = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate() + 7);
  }
  return out.reverse();
}
export function last52Weeks() {
  const now = new Date();
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7));
  return Array.from({ length: 52 }, (_, i) => {
    const s = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() - i * 7);
    const e = new Date(s.getFullYear(), s.getMonth(), s.getDate() + 6);
    return { startISO: toISODate(s), endISO: toISODate(e) };
  });
}

// --- Search / sort --------------------------------------------------------------
export const SEARCH_FIELDS = [['all', 'All Fields'], ['sku', 'SKU'], ['itemtype', 'Item'], ['make', 'Make'], ['model', 'Model'],
  ['serial', 'Serial'], ['orderno', 'Order#'], ['customer', 'Customer']];
export function matches(e, q, field, extra = []) {
  if (!q) return true;
  if (field !== 'all') return str(e[field]).toLowerCase().includes(q);
  return [e.sku, e.make, e.model, e.customer, e.serial, e.orderno, ...extra.map((f) => e[f])].map(str).join(' ').toLowerCase().includes(q);
}
const NATURAL = ['sku', 'orderno'];
export function sortItems(list, col, dir, valueOf) {
  const sign = dir === 'asc' ? 1 : -1;
  return [...list].sort((a, b) => {
    if (NATURAL.includes(col)) return sign * str(a[col]).localeCompare(str(b[col]), undefined, { numeric: true, sensitivity: 'base' });
    const av = valueOf(a, col);
    const bv = valueOf(b, col);
    if (av < bv) return -sign;
    if (av > bv) return sign;
    return 0;
  });
}

// --- Duplicate serials ----------------------------------------------------------
export function findDuplicateSerial(serial, excludeId, sales, inventory) {
  const k = str(serial).trim().toLowerCase();
  if (!k) return null;
  const hit = (list, sheet) => {
    const x = list.find((e) => e.id !== excludeId && str(e.serial).trim().toLowerCase() === k);
    return x ? { sheet, sku: x.sku || '(no SKU)', model: `${x.make || ''} ${x.model || ''}`.trim() } : null;
  };
  return hit(sales, 'All Sales') || hit(inventory, 'Inventory on Hand');
}
export function allDuplicateSerials(sales, inventory) {
  const by = {};
  const add = (e, sheet) => {
    const s = str(e.serial).trim();
    if (!s) return;
    const k = s.toLowerCase();
    (by[k] = by[k] || { serial: s, records: [] }).records.push({ sheet, sku: e.sku || '(no SKU)', model: `${e.make || ''} ${e.model || ''}`.trim(), id: e.id, kind: e.kind });
  };
  sales.forEach((e) => add(e, 'All Sales'));
  inventory.forEach((e) => add(e, 'Inventory on Hand'));
  return Object.values(by).filter((g) => g.records.length > 1);
}

// --- CSV --------------------------------------------------------------------------
export function downloadCSV(header, rows, filename) {
  const q = (v) => `"${str(v).replace(/"/g, '""')}"`;
  const csv = [header.map(q).join(','), ...rows.map((r) => r.map(q).join(','))].join('\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}
export function exportSales(list, calc, filename) {
  const header = ['SKU', 'Item', 'Make', 'Model', 'Serial', 'RAM', 'CPU', 'Processor', 'Capacity', 'Colour', 'Display', 'Extra', 'Battery Health', 'Platform', 'Order No', 'Customer', 'Sell Date', 'Listed Price', 'Sell Price', 'Extended Warranty', 'Cost', 'Postage', 'Fees', 'Pack/Handle Cost', 'Labour Cost', 'Google Ads Cost', 'Net Profit', 'Margin %', 'Warranty', 'Location', 'Stock Origin', 'Comments', 'Status', 'Added By', 'Last Edited By'];
  downloadCSV(header, list.map((e) => [e.sku, e.itemtype, e.make, e.model, e.serial, e.ram, e.cpu, e.processor, e.capacity, e.colour, e.display, e.extra, e.batteryhealth, e.platform, e.orderno, e.customer, e.selldate, e.listed, e.sellprice, e.extendedwarranty, e.cost, e.postage, e.fees, e.packhandle, calc.labour(e).toFixed(2), calc.ads(e).toFixed(2), calc.net(e).toFixed(2), calc.margin(e).toFixed(1), e.warranty, e.location, e.origin, e.comments, e.status || 'Sold', e.addedby, e.lasteditedby]), filename);
}
export function exportInventory(list, filename) {
  const header = ['SKU', 'Days in Stock', 'Item', 'Make', 'Model', 'Serial', 'RAM', 'CPU', 'Processor', 'Capacity', 'Colour', 'Display', 'Extra', 'Battery Health', 'Platform', 'Order No', 'Customer', 'Sell Date', 'Listed Price', 'Sell Price', 'Extended Warranty', 'Cost', 'Postage', 'Fees', 'Pack/Handle Cost', 'Labour Cost', 'Google Ads Cost', 'Warranty', 'Location', 'Stock Origin', 'Comments', 'Added By', 'Last Edited By', 'Status'];
  downloadCSV(header, list.map((e) => [e.sku, daysInStock(e) ?? '', e.itemtype, e.make, e.model, e.serial, e.ram, e.cpu, e.processor, e.capacity, e.colour, e.display, e.extra, e.batteryhealth, e.platform, e.orderno, e.customer, e.selldate, e.listed, e.sellprice, e.extendedwarranty, e.cost, e.postage, e.fees, e.packhandle, e.labour, e.adscost, e.warranty, e.location, e.origin, e.comments, e.addedby, e.lasteditedby, e.status || 'Not Tested']), filename);
}

export function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQ = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i += 1; } else inQ = false; } else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field); field = ''; rows.push(row); row = [];
    } else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.length > 1 || (r[0] && r[0].trim() !== ''));
}
// Column headings understood when importing (old app's exports, and the sheet itself).
export const IMPORT_MAP = {
  id: 'id', sku: 'sku', item: 'itemtype', itemtype: 'itemtype', make: 'make', model: 'model', serial: 'serial',
  ram: 'ram', cpu: 'cpu', processor: 'processor', capacity: 'capacity', colour: 'colour', display: 'display', extra: 'extra',
  'battery health': 'batteryhealth', batteryhealth: 'batteryhealth', platform: 'platform', 'order no': 'orderno',
  'order no.': 'orderno', orderno: 'orderno', customer: 'customer', 'sell date': 'selldate', selldate: 'selldate',
  'listed price': 'listed', listed: 'listed', 'sell price': 'sellprice', sellprice: 'sellprice', cost: 'cost',
  postage: 'postage', fees: 'fees', 'pack/handle cost': 'packhandle', packhandle: 'packhandle', 'labour cost': 'labour',
  labour: 'labour', 'google ads cost': 'adscost', adscost: 'adscost', 'stock origin': 'origin', origin: 'origin',
  warranty: 'warranty', location: 'location', comments: 'comments', status: 'status', 'added by': 'addedby',
  addedby: 'addedby', 'last edited by': 'lasteditedby', lasteditedby: 'lasteditedby', 'extended warranty': 'extendedwarranty',
  extendedwarranty: 'extendedwarranty', createdat: 'createdAt', shopifysourcekey: 'shopifysourcekey',
};
export function normalizeDate(v) {
  if (v instanceof Date && !Number.isNaN(v.getTime())) return toISODate(v);
  const s = str(v).trim();
  if (!s) return '';
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const au = parseAUDate(s);
  if (au) return au;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? '' : toISODate(d);
}
// Header row + data rows -> records using the field names above.
export function rowsToRecords(header, rows) {
  const idx = {};
  header.forEach((h, i) => { const f = IMPORT_MAP[str(h).trim().toLowerCase()]; if (f) idx[f] = i; });
  if (!Object.keys(idx).length) return null;
  return rows.filter((r) => r && r.some((c) => str(c).trim() !== '')).map((r) => {
    const rec = {};
    Object.entries(idx).forEach(([f, i]) => {
      const v = r[i];
      rec[f] = v instanceof Date ? v : (v === null || v === undefined ? '' : (typeof v === 'number' ? v : String(v).trim()));
    });
    if (rec.selldate) rec.selldate = normalizeDate(rec.selldate);
    if (rec.createdAt instanceof Date) rec.createdAt = rec.createdAt.getTime();
    else if (rec.createdAt) rec.createdAt = Number(rec.createdAt) || Date.parse(rec.createdAt) || '';
    if (typeof rec.sku === 'number') rec.sku = String(rec.sku);
    if (typeof rec.orderno === 'number') rec.orderno = String(rec.orderno);
    return rec;
  });
}

// --- Printing -----------------------------------------------------------------------
const esc = (s) => str(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function openPrint(title, css, body) {
  const w = window.open('', '_blank');
  if (!w) { alert('Please allow pop-ups for this site to print.'); return; }
  w.document.open();
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>${css}</style></head><body>${body}
<script>window.onload = function () { setTimeout(function () { window.print(); }, 150); };</script></body></html>`);
  w.document.close();
}
const PAGE_CSS = `body{font-family:Arial,Helvetica,sans-serif;color:#111;margin:24px;} h1{font-size:20px;margin:0 0 4px;}
.sub{color:#555;font-size:12px;margin-bottom:16px;} table{border-collapse:collapse;width:100%;}
th,td{text-align:left;padding:5px 8px;border-bottom:1px solid #ddd;font-size:11.5px;vertical-align:top;}
.kv th{width:34%;color:#444;font-weight:600;} .num{text-align:right;} thead th{background:#f3f2ee;}
tfoot td{font-weight:700;border-top:2px solid #111;} .stats{display:flex;flex-wrap:wrap;gap:10px;margin-bottom:14px;}
.stats div{border:1px solid #ddd;border-radius:6px;padding:6px 10px;font-size:11px;} .stats b{display:block;font-size:15px;}
.logo{height:38px;margin-bottom:10px;}`;
const header = (title, sub) => `<img class="logo" src="${window.location.origin}/logo-sidebar.png" alt="IT Factory" onerror="this.remove()"><h1>${esc(title)}</h1><div class="sub">${esc(sub)}</div>`;

export function printItem(item, isSale, calc) {
  const row = (k, v) => `<tr><th>${esc(k)}</th><td>${v === undefined || v === null || v === '' ? '—' : v}</td></tr>`;
  const rows = [
    row('SKU', esc(item.sku)), row('Item Type', esc(item.itemtype)), row('Make', esc(item.make)), row('Model', esc(item.model)),
    row('Serial', esc(item.serial)), row('RAM', esc(item.ram)), row('CPU', esc(item.cpu)), row('Processor', esc(item.processor)),
    row('Capacity', esc(item.capacity)), row('Colour', esc(item.colour)), row('Display', esc(item.display)), row('Extra', esc(item.extra)),
    row('Battery Health', esc(formatBatteryHealth(item.batteryhealth))), row('Platform', esc(item.platform)),
    row('Warranty', esc(item.warranty || 'No')), row('Location', esc(item.location)), row('Stock Origin', esc(item.origin)),
    row('Listed Price', fmt(item.listed)),
    ...(isSale ? [row('Order No.', esc(item.orderno)), row('Customer', esc(item.customer)), row('Sell Date', item.selldate ? auDate(item.selldate) : ''),
      row('Sell Price', fmt(item.sellprice)), row('Extended Warranty', fmt(item.extendedwarranty))] : [row('Sell Price (planned)', fmt(item.sellprice))]),
    row('Cost', fmt(item.cost)), row('Postage', fmt(item.postage)), row('Platform Fees', fmt(item.fees)), row('Pack/Handle Cost', fmt(item.packhandle)),
    row('Labour Cost', fmt(isSale ? calc.labour(item) : item.labour)), row('Google Ads Cost', fmt(isSale ? calc.ads(item) : item.adscost)),
    ...(isSale ? [row('Net Profit', fmt(calc.net(item))), row('Margin', pct(calc.margin(item)))] : []),
    row('Status', esc(item.status || (isSale ? 'Sold' : 'Not Tested'))), row('Comments/Notes', esc(item.comments).replace(/\n/g, '<br>')),
    row('Added By', esc(item.addedby)), row('Last Edited By', esc(item.lasteditedby)),
  ].join('');
  const title = `${item.make || ''} ${item.model || ''}`.trim() || item.sku || 'Item';
  openPrint(title, PAGE_CSS, `${header(title, `${isSale ? 'Sale Record' : 'Inventory Item'} — Printed ${auDate(toISODate(new Date()))}`)}<table class="kv">${rows}</table>`);
}

function qrSvg(text) {
  const qr = qrcode(0, 'M');
  qr.addData(String(text || 'NOSERIAL'), 'Byte');
  qr.make();
  const n = qr.getModuleCount();
  let d = '';
  for (let r = 0; r < n; r += 1) for (let c = 0; c < n; c += 1) if (qr.isDark(r, c)) d += `M${c + 2} ${r + 2}h1v1h-1z`;
  const m = n + 4;
  return `<svg viewBox="0 0 ${m} ${m}" shape-rendering="crispEdges" xmlns="http://www.w3.org/2000/svg"><rect width="${m}" height="${m}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}
// The old app's DYMO label: 89 × 36 mm, details on the left, QR code of the serial on the right.
// One label per page: a new page starts before each label after the first (a
// "no break after the last one" rule never matched — the page ends with a
// <script>), and each label is a touch under 36 mm so rounding can't spill onto
// a second, blank label.
export function printLabels(items) {
  const css = `@page{size:89mm 36mm;margin:0;} *{box-sizing:border-box;} body{margin:0;font-family:Arial,sans-serif;color:#000;}
.l{width:89mm;height:35.6mm;padding:2.5mm 5mm;overflow:hidden;display:flex;align-items:center;gap:4mm;}
.l+.l{page-break-before:always;break-before:page;} .i{flex:1;min-width:0;display:flex;flex-direction:column;justify-content:center;gap:0.4mm;}
.sku{font-size:8.5pt;font-weight:700;} .pl{font-size:7pt;font-weight:600;} .mo{font-size:9pt;font-weight:700;line-height:1.25;}
.sp{font-size:6.5pt;line-height:1.15;} .sb{font-size:6.8pt;line-height:1.15;word-break:break-word;}
.q{flex-shrink:0;display:flex;flex-direction:column;align-items:center;} .q svg{width:21mm;height:21mm;display:block;}
.sn{font-size:6.5pt;text-align:center;letter-spacing:0.5px;margin-top:0.8mm;}`;
  const body = items.map((it) => {
    const specs = [it.ram, it.cpu, it.capacity].filter(Boolean).join(' / ');
    return `<div class="l"><div class="i"><div class="sku">${esc(it.sku)}</div><div class="pl">${esc(it.platform)}</div>
      <div class="mo">${esc(it.make)} ${esc(it.model)}</div>${specs ? `<div class="sp">${esc(specs)}</div>` : ''}
      <div class="sb">Battery: ${esc(formatBatteryHealth(it.batteryhealth))}</div>${it.location ? `<div class="sb">${esc(it.location)}</div>` : ''}</div>
      <div class="q">${qrSvg(it.serial)}<div class="sn">${esc(it.serial)}</div></div></div>`;
  }).join('');
  openPrint(items.length === 1 ? `Label ${items[0].sku || ''}` : `${items.length} labels`, css, body);
}

export function printTable(title, sub, columns, rows, { stats = [], footer = null } = {}) {
  const th = columns.map((c) => `<th class="${c.num ? 'num' : ''}">${esc(c.label)}</th>`).join('');
  const tr = rows.map((r) => `<tr>${r.map((v, i) => `<td class="${columns[i].num ? 'num' : ''}">${esc(v)}</td>`).join('')}</tr>`).join('');
  const st = stats.length ? `<div class="stats">${stats.map(([k, v]) => `<div>${esc(k)}<b>${esc(v)}</b></div>`).join('')}</div>` : '';
  const ft = footer ? `<tfoot><tr>${footer.map((v, i) => `<td class="${columns[i].num ? 'num' : ''}">${esc(v)}</td>`).join('')}</tr></tfoot>` : '';
  openPrint(title, PAGE_CSS, `${header(title, sub)}${st}<table><thead><tr>${th}</tr></thead><tbody>${tr || `<tr><td colspan="${columns.length}">Nothing to show.</td></tr>`}</tbody>${ft}</table>`);
}

// Notes: "[dd/mm/yyyy hh:mm - Name] text" appended on a new line.
export function addNote(existing, text, who) {
  const t = str(text).trim();
  if (!t) return existing;
  const now = new Date();
  const line = `[${auDate(toISODate(now))} ${now.toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' })} - ${who || 'Unknown'}] ${t}`;
  return str(existing).trim() ? `${str(existing).trim()}\n${line}` : line;
}

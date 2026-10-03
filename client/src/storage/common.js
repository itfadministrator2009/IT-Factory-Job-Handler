// Shared Storage Centre helpers: the old app's date presets, formatting, CSV
// download, natural sort and duplicate detection.

// Local date as YYYY-MM-DD (never toISOString, which shifts to UTC and lands a
// day early in Sydney).
export function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function dmy(s) {
  const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : (s || '');
}

export const money = (n) => `$${(Number(n) || 0).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export const PRESET_LABELS = {
  lastWeek: 'Last week', lastMonth: 'Last month', lastQuarter: 'Last quarter', lastYear: 'Last year', lastFY: 'Last financial year',
};

// Old getPresetRange: Monday–Sunday weeks; Australian financial year (1 Jul – 30 Jun).
export function presetRange(preset, today = new Date()) {
  const y = today.getFullYear(); const m = today.getMonth(); const d = today.getDate();
  if (preset === 'lastWeek') {
    const since = (today.getDay() + 6) % 7;
    return { from: ymd(new Date(y, m, d - since - 7)), to: ymd(new Date(y, m, d - since - 1)) };
  }
  if (preset === 'lastMonth') return { from: ymd(new Date(y, m - 1, 1)), to: ymd(new Date(y, m, 0)) };
  if (preset === 'lastQuarter') { const q = Math.floor(m / 3) * 3; return { from: ymd(new Date(y, q - 3, 1)), to: ymd(new Date(y, q, 0)) }; }
  if (preset === 'lastYear') return { from: `${y - 1}-01-01`, to: `${y - 1}-12-31` };
  if (preset === 'lastFY') { const s = m >= 6 ? y : y - 1; return { from: `${s - 1}-07-01`, to: `${s}-06-30` }; }
  return null;
}

export const naturalCompare = (a, b) => String(a || '').localeCompare(String(b || ''), undefined, { numeric: true, sensitivity: 'base' });

export function downloadCsv(filename, rows) {
  const cell = (v) => {
    const t = v == null ? '' : String(v);
    return /[",\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  const csv = '﻿' + rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

export const isInStorage = (i) => !!i.startDate && !i.endDate;
export const itemStatus = (i) => (!i.startDate ? '' : i.endDate ? 'Out of Storage' : 'In storage');
export function weeksStored(i) {
  if (!i.startDate) return '';
  const start = new Date(`${i.startDate}T00:00:00`);
  const end = i.endDate ? new Date(`${i.endDate}T00:00:00`) : new Date();
  return Math.max(0, Math.ceil((end - start) / (7 * 86400000)));
}

// Old dedupeKey: same serial (any client), or — with no serial — the same
// client + job number + reference + item.
export function dedupeKey(i) {
  const serial = String(i.serial || '').trim().toLowerCase();
  if (serial) return `serial:${serial}`;
  const parts = [i.client, i.jobNumber, i.referenceNumber, i.item].map((v) => String(v || '').trim().toLowerCase());
  // A client name on its own isn't enough to call two items the same.
  return parts.slice(1).some(Boolean) ? `composite:${parts.join('|')}` : null;
}

// Groups of in-storage items sharing a key (old findDuplicateGroups).
export function findDuplicateGroups(items) {
  const byKey = new Map();
  items.filter(isInStorage).forEach((i) => {
    const k = dedupeKey(i);
    if (!k) return;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(i);
  });
  return [...byKey.entries()].filter(([, list]) => list.length > 1).map(([key, list]) => ({
    key, items: list,
    label: key.startsWith('serial:') ? `Serial ${list[0].serial}` : `${list[0].client || '—'} — ${list[0].item || '—'}`,
  }));
}

// Manifest fields in the old app's order: [key, label, input type].
export const ITEM_FIELDS = [
  ['client', 'Client', 'text'],
  ['jobNumber', 'Job Number', 'text'],
  ['referenceNumber', 'Reference Number', 'text'],
  ['poNumber', 'PO Number', 'text'],
  ['orderNumber', 'Order Number', 'text'],
  ['storageCentre', 'ITF Storage Centre', 'text'],
  ['location', 'Location', 'text'],
  ['quantity', 'Quantity', 'text'],
  ['condition', 'Condition', 'text'],
  ['item', 'Item', 'text'],
  ['make', 'Make', 'text'],
  ['model', 'Model', 'text'],
  ['serial', 'Serial', 'text'],
  ['assetTag', 'Asset Tag', 'text'],
  ['priceWeek', 'Storage Price Per Week (ex GST)', 'number'],
  ['startDate', 'Storage Start Date', 'date'],
  ['endDate', 'Storage End Date', 'date'],
];

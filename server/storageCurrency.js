// Currency each Storage Centre client is charged in. Rates are entered in that
// currency (e.g. US$ per item per week), so amounts are only labelled — never
// converted — and totals are kept separate for each currency.
const { db } = require('./db');

const CURRENCIES = {
  AUD: { code: 'AUD', symbol: '$', name: 'Australian dollars' },
  USD: { code: 'USD', symbol: 'US$', name: 'US dollars' },
};
const DEFAULT_CURRENCY = 'AUD';

function normCurrency(v) {
  const c = String(v || '').trim().toUpperCase();
  return CURRENCIES[c] ? c : null;
}

const key = (s) => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();

// { 'client name (lower case)': 'USD', ... } — only clients on the Clients list
// have a setting; anyone else is AUD.
function currencyMap() {
  const map = {};
  db.prepare('SELECT client_name, currency FROM storage_clients').all().forEach((r) => {
    map[key(r.client_name)] = normCurrency(r.currency) || DEFAULT_CURRENCY;
  });
  return map;
}

function currencyFor(client, map = currencyMap()) {
  return map[key(client)] || DEFAULT_CURRENCY;
}

function formatMoney(n, currency = DEFAULT_CURRENCY) {
  const sym = (CURRENCIES[currency] || CURRENCIES[DEFAULT_CURRENCY]).symbol;
  const v = Number(n) || 0;
  return `${v < 0 ? '-' : ''}${sym}${Math.abs(v).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// [{ currency: 'AUD', total }, { currency: 'USD', total }] from rows with
// { currency, total }; AUD first, then the rest. Only currencies that appear.
function totalsByCurrency(rows, field = 'total') {
  const t = {};
  rows.forEach((r) => { const c = r.currency || DEFAULT_CURRENCY; t[c] = (t[c] || 0) + (Number(r[field]) || 0); });
  return Object.keys(t).sort((a, b) => (a === DEFAULT_CURRENCY ? -1 : b === DEFAULT_CURRENCY ? 1 : a.localeCompare(b)))
    .map((c) => ({ currency: c, total: Math.round(t[c] * 100) / 100 }));
}

module.exports = { CURRENCIES, DEFAULT_CURRENCY, normCurrency, currencyMap, currencyFor, formatMoney, totalsByCurrency };

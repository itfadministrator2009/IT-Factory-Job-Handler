// Clients — the client-portal accounts (one login per client), shared by the
// ITF Storage Centre and the ITF Asset Tracker. Kept in the storage_clients
// table (unchanged). Mounted at /api/clients, and also at /api/storage/clients
// so existing Storage Centre pages keep working.
//
// Who can do what:
//   - open the page: admins, and anyone with Storage Centre or Asset Tracker access
//   - add clients, change names, logins, passwords, currency: admins and Storage Centre users
//   - link Asset Tracker customers: any of the above
//   - delete a client: admins only
//   - currency, stock counts and unlisted names: Storage Centre users and admins only
const express = require('express');
const { randomUUID } = require('crypto');
const bcrypt = require('bcryptjs');
const { db } = require('../db');
const { authRequired } = require('../auth');
const { isAdminRole, hasModuleAccess } = require('../permissions');
const { normCurrency, DEFAULT_CURRENCY } = require('../storageCurrency');

const router = express.Router();
router.use(authRequired);

function isAdmin(userId) {
  return isAdminRole(db.prepare('SELECT role FROM users WHERE id = ?').get(userId)?.role);
}

router.use((req, res, next) => {
  const admin = isAdmin(req.user.id);
  const storage = hasModuleAccess(req.user.id, 'storage');
  const assets = hasModuleAccess(req.user.id, 'assets');
  if (!admin && !storage && !assets) return res.status(403).json({ error: "You don't have access to Clients. Ask an admin to turn on Storage Centre or Asset Tracker for you." });
  req.clientsAccess = { admin, storage: admin || storage, assets: admin || assets, manage: admin || storage };
  next();
});


function rowToClient(row) {
  if (!row) return row;
  return { id: row.id, clientName: row.client_name, username: row.username, hasPortalLogin: !!row.password_hash, addedBy: row.added_by, createdAt: row.created_at, currency: normCurrency(row.currency) || DEFAULT_CURRENCY, assetCustomers: parseAssetCustomers(row.asset_customers) };
}

// Asset Tracker customer names linked to a portal client (what the client sees
// on the portal's Audited assets tab). Stored as a JSON list of names.
function parseAssetCustomers(v) {
  try { const a = JSON.parse(v || '[]'); return Array.isArray(a) ? a.filter((x) => typeof x === 'string') : []; } catch { return []; }
}
function cleanAssetCustomers(v) {
  if (!Array.isArray(v)) return null;
  const seen = new Set(); const out = [];
  v.map((x) => String(x || '').trim().replace(/\s+/g, ' ')).filter(Boolean).slice(0, 200).forEach((x) => {
    const k = x.toLowerCase(); if (!seen.has(k)) { seen.add(k); out.push(x); }
  });
  return out;
}

// Every Customer name used in the Asset Tracker (spellings grouped, most-used
// spelling shown), with how many assets each has — to link to a portal client.
router.get('/asset-customers', (req, res) => {
  const groups = new Map();
  db.prepare("SELECT json_extract(fields_json, '$.customer') AS c, COUNT(*) AS n FROM assets GROUP BY c").all().forEach(({ c, n }) => {
    const label = String(c ?? '').trim().replace(/\s+/g, ' ');
    if (!label) return;
    const k = label.toLowerCase();
    const g = groups.get(k) || { name: label, count: 0, bestN: -1 };
    g.count += n;
    if (n > g.bestN) { g.name = label; g.bestN = n; }
    groups.set(k, g);
  });
  res.json({ customers: [...groups.values()].map(({ name, count }) => ({ name, count })).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })) });
});

// The client list (like the old app's Clients sheet) plus, under `unlisted`,
// every other client name used on items, pallets, orders or receiving/dispatch
// entries, so nobody is missing from the page just because they were never
// added to the list. Names are compared ignoring case and extra spaces.
router.get('/', (req, res) => {
  const key = (s) => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();
  const itemCounts = {};
  db.prepare("SELECT client, COUNT(*) AS total, SUM(CASE WHEN start_date IS NOT NULL AND end_date IS NULL THEN 1 ELSE 0 END) AS in_storage FROM storage_items WHERE client IS NOT NULL AND trim(client) != '' GROUP BY client").all()
    .forEach((r) => {
      const k = key(r.client);
      const c = itemCounts[k] || (itemCounts[k] = { names: new Set(), total: 0, inStorage: 0 });
      c.names.add(r.client.trim()); c.total += r.total; c.inStorage += r.in_storage || 0;
    });
  const listed = db.prepare('SELECT * FROM storage_clients ORDER BY client_name COLLATE NOCASE').all();
  const listedKeys = new Set(listed.map((c) => key(c.client_name)));
  const clients = listed.map((c) => ({ ...rowToClient(c), itemCount: itemCounts[key(c.client_name)]?.total || 0, inStorageCount: itemCounts[key(c.client_name)]?.inStorage || 0 }));

  const others = new Map();
  const note = (name, source) => {
    const clean = String(name || '').trim().replace(/\s+/g, ' ');
    const k = key(clean);
    if (!k || listedKeys.has(k)) return;
    if (!others.has(k)) others.set(k, { clientName: clean, sources: new Set() });
    others.get(k).sources.add(source);
  };
  Object.values(itemCounts).forEach((c) => c.names.forEach((n) => note(n, 'items')));
  db.prepare("SELECT DISTINCT client FROM storage_pallets WHERE client IS NOT NULL").all().forEach((r) => note(r.client, 'pallet rates'));
  db.prepare("SELECT DISTINCT client FROM storage_orders WHERE client IS NOT NULL").all().forEach((r) => note(r.client, 'orders'));
  db.prepare("SELECT DISTINCT client FROM storage_receiving_dispatch WHERE client IS NOT NULL").all().forEach((r) => note(r.client, 'receiving/dispatch'));
  const unlisted = [...others.entries()].map(([k, o]) => ({
    clientName: o.clientName, sources: [...o.sources], itemCount: itemCounts[k]?.total || 0, inStorageCount: itemCounts[k]?.inStorage || 0,
  })).sort((a, b) => a.clientName.localeCompare(b.clientName, undefined, { sensitivity: 'base' }));

  if (!req.clientsAccess.storage) {
    // Asset Tracker only: who has a portal login and which customers are linked —
    // no currency, stock counts or names found on Storage Centre records.
    return res.json({ clients: clients.map((c) => ({ id: c.id, clientName: c.clientName, username: c.username, hasPortalLogin: c.hasPortalLogin, assetCustomers: c.assetCustomers, addedBy: c.addedBy, createdAt: c.createdAt })), unlisted: [] });
  }
  res.json({ clients, unlisted });
});

const PORTAL_MIN_PASSWORD = 8;

// Usernames are matched case-insensitively at portal login, so they must be
// unique ignoring case. Returns an error message, or null if OK.
function checkPortalLogin(username, password, exceptId) {
  if (username) {
    if (!/^[A-Za-z0-9._@-]{3,64}$/.test(username)) return 'Usernames are 3–64 characters: letters, numbers, . _ @ -';
    const clash = db.prepare('SELECT id FROM storage_clients WHERE lower(username) = lower(?) AND id != ?').get(username, exceptId || '');
    if (clash) return 'That username is already used by another client';
  }
  if (password && password.length < PORTAL_MIN_PASSWORD) return `Portal passwords must be at least ${PORTAL_MIN_PASSWORD} characters`;
  return null;
}

router.post('/', (req, res) => {
  if (!req.clientsAccess.manage) return res.status(403).json({ error: 'Only admins and Storage Centre users can add clients' });
  const { clientName, password } = req.body;
  const username = req.body.username ? String(req.body.username).trim() : null;
  if (!clientName || !clientName.trim()) return res.status(400).json({ error: 'A client name is required' });
  const existing = db.prepare('SELECT id FROM storage_clients WHERE lower(trim(client_name)) = lower(?)').get(clientName.trim());
  if (existing) return res.status(400).json({ error: 'A client with this name already exists' });
  if (password && !username) return res.status(400).json({ error: 'Set a username to go with the portal password' });
  const problem = checkPortalLogin(username, password);
  if (problem) return res.status(400).json({ error: problem });
  if (req.body.currency !== undefined && !normCurrency(req.body.currency)) return res.status(400).json({ error: 'Currency must be AUD or USD' });
  const id = randomUUID();
  const passwordHash = password ? bcrypt.hashSync(password, 10) : null;
  db.prepare('INSERT INTO storage_clients (id, client_name, username, password_hash, added_by, currency, asset_customers) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, clientName.trim(), username || null, passwordHash, req.user.name, normCurrency(req.body.currency) || DEFAULT_CURRENCY,
      JSON.stringify(cleanAssetCustomers(req.body.assetCustomers) || []));
  res.status(201).json({ client: rowToClient(db.prepare('SELECT * FROM storage_clients WHERE id = ?').get(id)) });
});

router.patch('/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM storage_clients WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Client not found' });
  // Asset Tracker-only users may change which customers are linked, nothing else.
  if (!req.clientsAccess.manage && Object.keys(req.body || {}).some((k) => k !== 'assetCustomers')) {
    return res.status(403).json({ error: 'Only admins and Storage Centre users can change client names, logins and passwords' });
  }
  const { clientName, password, removePortalAccess } = req.body;
  const username = req.body.username === undefined ? undefined : (req.body.username ? String(req.body.username).trim() : null);
  const problem = checkPortalLogin(username, password, existing.id);
  if (problem) return res.status(400).json({ error: problem });
  const finalUsername = username === undefined ? existing.username : username;
  if (password && !finalUsername) return res.status(400).json({ error: 'Set a username to go with the portal password' });
  const sets = [];
  const vals = [];
  if (clientName !== undefined) {
    if (!String(clientName).trim()) return res.status(400).json({ error: 'A client name is required' });
    const clash = db.prepare('SELECT id FROM storage_clients WHERE client_name = ? AND id != ?').get(String(clientName).trim(), existing.id);
    if (clash) return res.status(400).json({ error: 'A client with this name already exists' });
    sets.push('client_name = ?'); vals.push(String(clientName).trim());
  }
  if (username !== undefined) { sets.push('username = ?'); vals.push(username); }
  if (req.body.currency !== undefined) {
    const cur = normCurrency(req.body.currency);
    if (!cur) return res.status(400).json({ error: 'Currency must be AUD or USD' });
    sets.push('currency = ?'); vals.push(cur);
  }
  if (req.body.assetCustomers !== undefined) {
    const list = cleanAssetCustomers(req.body.assetCustomers);
    if (!list) return res.status(400).json({ error: 'assetCustomers must be a list of customer names' });
    sets.push('asset_customers = ?'); vals.push(JSON.stringify(list));
  }
  if (removePortalAccess) { sets.push('password_hash = NULL'); }
  else if (password) { sets.push('password_hash = ?'); vals.push(bcrypt.hashSync(password, 10)); }
  if (sets.length === 0) return res.status(400).json({ error: 'Nothing to update' });
  vals.push(req.params.id);
  db.prepare(`UPDATE storage_clients SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  res.json({ client: rowToClient(db.prepare('SELECT * FROM storage_clients WHERE id = ?').get(req.params.id)) });
});

router.delete('/:id', (req, res) => {
  if (!isAdmin(req.user.id)) return res.status(403).json({ error: 'Only admins can delete clients' });
  const result = db.prepare('DELETE FROM storage_clients WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Client not found' });
  res.json({ ok: true });
});

module.exports = router;

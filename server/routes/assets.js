const express = require('express');
const multer = require('multer');
const { randomUUID } = require('crypto');
const { db } = require('../db');
const { authRequired } = require('../auth');
const { isAdminRole, requireModule } = require('../permissions');
const { notifyAssetReport } = require('../email');
const { buildBatchPdf } = require('../storagePdf');

const router = express.Router();
router.use(authRequired);
router.use(requireModule('assets'));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

function isAdmin(userId) {
  return isAdminRole(db.prepare('SELECT role FROM users WHERE id = ?').get(userId)?.role);
}

function getFieldDefs() {
  return db.prepare('SELECT * FROM asset_field_defs ORDER BY sort_order, created_at').all()
    .map((f) => ({ ...f, options: f.options_json ? JSON.parse(f.options_json) : null, is_core: !!f.is_core }));
}

function withParsedFields(asset) {
  const creator = asset.created_by ? db.prepare('SELECT id, name FROM users WHERE id = ?').get(asset.created_by) : null;
  return { ...asset, fields: JSON.parse(asset.fields_json || '{}'), creator };
}

function logAssetAudit(assetId, field, oldValue, newValue, changedBy) {
  db.prepare('INSERT INTO asset_audit (id, asset_id, field, old_value, new_value, changed_by) VALUES (?, ?, ?, ?, ?, ?)')
    .run(randomUUID(), assetId, field, oldValue ?? null, newValue ?? null, changedBy);
}

function buildCsv(assets, defs) {
  const headers = ['Date Created', 'User Name', ...defs.map((f) => f.label)];
  const escape = (v) => {
    const s = v === undefined || v === null ? '' : Array.isArray(v) ? v.join(', ') : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headers.map(escape).join(',')];
  assets.forEach((a) => {
    const row = [a.created_at, a.creator?.name || '', ...defs.map((f) => a.fields[f.field_key])];
    lines.push(row.map(escape).join(','));
  });
  return lines.join('\r\n');
}

// ---------------------------------------------------------------------------
// Filters and customer names
// ---------------------------------------------------------------------------
// A field's value with capitals, surrounding spaces and doubled spaces ignored —
// so "ACME ", "Acme" and "acme" are one customer everywhere.
const norm = (key) => `lower(trim(replace(replace(replace(COALESCE(json_extract(fields_json, '$.${key}'), ''), '  ', ' '), '  ', ' '), '  ', ' ')))`;
const normText = (v) => String(v ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
const SERIAL = "upper(trim(COALESCE(json_extract(fields_json, '$.serial_number'), '')))";
const FILTER_KEYS = { category: 'category', status: 'status', sent_to: 'asset_sent_to', customer: 'customer' };
const NONE = '__none__'; // "Unspecified" — the field is blank

// WHERE clause for the asset list, select-all, export and batches: free-text q,
// exact field filters, duplicate serials only, and in-batch.
function buildWhere(query = {}) {
  const parts = []; const params = [];
  const q = String(query.q || '').trim();
  if (q) { parts.push('fields_json LIKE ?'); params.push(`%${q}%`); }
  Object.entries(FILTER_KEYS).forEach(([param, key]) => {
    const v = query[param];
    if (v == null || v === '') return;
    if (v === NONE) parts.push(`${norm(key)} = ''`);
    else { parts.push(`${norm(key)} = ?`); params.push(normText(v)); }
  });
  if (query.dupes === '1' || query.dupes === 'true') {
    parts.push(`${SERIAL} != '' AND ${SERIAL} IN (SELECT ${SERIAL} FROM assets GROUP BY ${SERIAL} HAVING COUNT(*) > 1)`);
  }
  if (query.batch) { parts.push('id IN (SELECT asset_id FROM asset_batch_items WHERE batch_id = ?)'); params.push(String(query.batch)); }
  return { where: parts.length ? `WHERE ${parts.join(' AND ')}` : '', params };
}

// Group spellings of the same customer; show the most-used spelling for each.
function canonicalCustomers() {
  const rows = db.prepare(`SELECT json_extract(fields_json, '$.customer') as c, COUNT(*) as n FROM assets GROUP BY c`).all();
  const groups = new Map();
  rows.forEach(({ c, n }) => {
    const key = normText(c);
    const g = groups.get(key) || { key, total: 0, best: null, bestN: -1 };
    g.total += n;
    const label = String(c ?? '').trim().replace(/\s+/g, ' ');
    // Most-used spelling wins; on a tie, prefer normal capitals over ALL CAPS.
    const better = n > g.bestN || (n === g.bestN && g.best === g.best?.toUpperCase() && label !== label.toUpperCase());
    if (label && better) { g.best = label; g.bestN = n; }
    groups.set(key, g);
  });
  return groups; // key -> { key, total, best }
}
const customerLabel = (groups, value) => (normText(value) ? (groups.get(normText(value))?.best || String(value).trim()) : 'Unspecified');

// Other assets already using this serial (ignoring capitals/spaces).
function serialConflicts(serial, excludeId = null) {
  const k = String(serial ?? '').trim().toUpperCase();
  if (!k) return [];
  return db.prepare(`SELECT id, fields_json FROM assets WHERE ${SERIAL} = ? AND id != ?`).all(k, excludeId || '')
    .map((r) => { const f = JSON.parse(r.fields_json || '{}'); return { id: r.id, assetTag: f.asset_tag || '', customer: f.customer || '', status: f.status || '' }; });
}
function duplicateSerialResponse(res, serial, matches) {
  return res.status(409).json({
    code: 'duplicate_serial',
    error: `Serial ${String(serial).trim()} is already on ${matches.length === 1 ? 'another asset' : `${matches.length} other assets`}${matches[0]?.assetTag ? ` (asset tag ${matches.map((m) => m.assetTag).filter(Boolean).join(', ')})` : ''}.`,
    matches,
  });
}

// ---------------------------------------------------------------------------
// Field definitions — this is what makes "add a field" and dropdown options
// possible without a code change: the list of fields and their types/options is
// data in this table, not hardcoded columns.
// ---------------------------------------------------------------------------

router.get('/field-defs', (req, res) => {
  res.json({ fields: getFieldDefs() });
});

router.post('/field-defs', (req, res) => {
  if (!isAdmin(req.user.id)) return res.status(403).json({ error: 'Only admins can add fields' });
  const { label, type, options } = req.body;
  if (!label || !label.trim()) return res.status(400).json({ error: 'A field label is required' });
  const validTypes = ['text', 'textarea', 'number', 'date', 'dropdown', 'multiselect'];
  if (!validTypes.includes(type)) return res.status(400).json({ error: 'Invalid field type' });

  const fieldKey = label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || `field_${Date.now()}`;
  const existing = db.prepare('SELECT id FROM asset_field_defs WHERE field_key = ?').get(fieldKey);
  if (existing) return res.status(400).json({ error: 'A field with a very similar name already exists' });

  const maxOrder = db.prepare('SELECT MAX(sort_order) as m FROM asset_field_defs').get().m || 0;
  const id = randomUUID();
  db.prepare('INSERT INTO asset_field_defs (id, field_key, label, type, options_json, is_core, sort_order) VALUES (?, ?, ?, ?, ?, 0, ?)')
    .run(id, fieldKey, label.trim(), type, (type === 'dropdown' || type === 'multiselect') ? JSON.stringify(options || []) : null, maxOrder + 1);
  res.status(201).json({ field: getFieldDefs().find((f) => f.id === id) });
});

router.patch('/field-defs/:id', (req, res) => {
  if (!isAdmin(req.user.id)) return res.status(403).json({ error: 'Only admins can edit fields' });
  const field = db.prepare('SELECT * FROM asset_field_defs WHERE id = ?').get(req.params.id);
  if (!field) return res.status(404).json({ error: 'Field not found' });

  const { label, options } = req.body;
  const updates = [];
  const params = [];
  if (label !== undefined) { updates.push('label = ?'); params.push(label); }
  if (options !== undefined) { updates.push('options_json = ?'); params.push(JSON.stringify(options)); }
  if (updates.length === 0) return res.status(400).json({ error: 'Nothing to update' });
  params.push(req.params.id);
  db.prepare(`UPDATE asset_field_defs SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  res.json({ field: getFieldDefs().find((f) => f.id === req.params.id) });
});

router.delete('/field-defs/:id', (req, res) => {
  if (!isAdmin(req.user.id)) return res.status(403).json({ error: 'Only admins can remove fields' });
  const field = db.prepare('SELECT * FROM asset_field_defs WHERE id = ?').get(req.params.id);
  if (!field) return res.status(404).json({ error: 'Field not found' });
  if (field.is_core) return res.status(400).json({ error: 'Built-in fields can\'t be removed, only edited' });
  db.prepare('DELETE FROM asset_field_defs WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// List + create
// ---------------------------------------------------------------------------

router.get('/', (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const offset = (page - 1) * limit;
  const { where, params: whereParams } = buildWhere(req.query);

  const total = db.prepare(`SELECT COUNT(*) as c FROM assets ${where}`).get(...whereParams).c;
  const rows = db.prepare(`SELECT * FROM assets ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...whereParams, limit, offset);
  res.json({ assets: rows.map(withParsedFields), total, page, totalPages: Math.max(1, Math.ceil(total / limit)) });
});

// Lightweight (ids only, no field data) — lets "Select all N matching assets" grab
// every id across every page for bulk actions, without pulling full records for
// however many hundreds of assets that might be.
router.get('/all-ids', (req, res) => {
  const { where, params: whereParams } = buildWhere(req.query);
  const rows = db.prepare(`SELECT id FROM assets ${where} ORDER BY created_at DESC`).all(...whereParams);
  res.json({ ids: rows.map((r) => r.id) });
});

router.post('/', (req, res) => {
  const { fields } = req.body;
  if (!fields || typeof fields !== 'object') return res.status(400).json({ error: 'fields object is required' });
  // Warn before a second asset gets the same serial (the page can then save anyway).
  if (!req.body.allowDuplicateSerial) {
    const matches = serialConflicts(fields.serial_number);
    if (matches.length) return duplicateSerialResponse(res, fields.serial_number, matches);
  }
  const id = randomUUID();
  db.prepare('INSERT INTO assets (id, fields_json, created_by) VALUES (?, ?, ?)').run(id, JSON.stringify(fields), req.user.id);
  const asset = db.prepare('SELECT * FROM assets WHERE id = ?').get(id);
  res.status(201).json({ asset: withParsedFields(asset) });
});

// ---------------------------------------------------------------------------
// Bulk actions, export/import, reports, and email defaults — ALL declared here,
// before the /:id wildcard routes below. Express matches routes in declaration
// order, so if these came after /:id, a request to e.g. PATCH /bulk-edit would be
// wrongly matched by PATCH /:id, treating "bulk-edit" as if it were a literal
// asset id (exactly the bug this ordering avoids).
// ---------------------------------------------------------------------------

// Bulk serial search: paste a list of serial numbers (one per line, or separated
// by commas/spaces) and get back every asset with one of those serials — to pick
// out a batch for an order, or to allocate a bunch to ITF Australia / Wholesale.
// Matching ignores capitals and surrounding spaces. Serials with no asset come
// back in notFound; serials on more than one asset come back in duplicates.
function parseSerialList(input) {
  const list = Array.isArray(input) ? input : String(input || '').split(/[\s,;]+/);
  const seen = new Set(); const out = [];
  list.map((v) => String(v || '').trim()).filter(Boolean).forEach((v) => {
    const k = v.toUpperCase();
    if (!seen.has(k)) { seen.add(k); out.push(v); }
  });
  return out;
}

function findBySerials(serials) {
  const rows = [];
  for (let i = 0; i < serials.length; i += 500) {
    const chunk = serials.slice(i, i + 500).map((v) => v.toUpperCase());
    rows.push(...db.prepare(`SELECT * FROM assets WHERE upper(trim(json_extract(fields_json, '$.serial_number'))) IN (${chunk.map(() => '?').join(',')})`).all(...chunk));
  }
  return rows;
}

router.post('/serial-search', (req, res) => {
  const serials = parseSerialList(req.body?.serials);
  if (!serials.length) return res.status(400).json({ error: 'Paste at least one serial number' });
  if (serials.length > 5000) return res.status(400).json({ error: 'At most 5000 serials at a time' });
  const bySerial = new Map();
  findBySerials(serials).forEach((row) => {
    const k = String(JSON.parse(row.fields_json || '{}').serial_number || '').trim().toUpperCase();
    if (!bySerial.has(k)) bySerial.set(k, []);
    bySerial.get(k).push(row);
  });
  // Keep the order the serials were pasted in.
  const assets = []; const notFound = []; const duplicates = [];
  serials.forEach((s) => {
    const hits = bySerial.get(s.toUpperCase()) || [];
    if (!hits.length) notFound.push(s);
    if (hits.length > 1) duplicates.push({ serial: s, count: hits.length });
    hits.forEach((r) => assets.push(withParsedFields(r)));
  });
  res.json({ assets, searched: serials.length, found: serials.length - notFound.length, notFound, duplicates });
});

// Values for the filter drop-downs: each field's options plus anything actually
// in use, and customers grouped regardless of capitals/spaces, with counts.
router.get('/filter-options', (req, res) => {
  const defs = getFieldDefs();
  const used = (key) => db.prepare(`SELECT DISTINCT trim(json_extract(fields_json, '$.${key}')) as v FROM assets WHERE trim(COALESCE(json_extract(fields_json, '$.${key}'), '')) != ''`).all().map((r) => r.v);
  const optionList = (key) => {
    const seen = new Map();
    [...(defs.find((d) => d.field_key === key)?.options || []), ...used(key)].forEach((v) => { if (!seen.has(normText(v))) seen.set(normText(v), v); });
    return [...seen.values()];
  };
  const customers = [...canonicalCustomers().values()].filter((g) => g.key)
    .map((g) => ({ value: g.best, count: g.total }))
    .sort((a, b) => a.value.localeCompare(b.value, undefined, { sensitivity: 'base', numeric: true }));
  res.json({ category: optionList('category'), status: optionList('status'), sent_to: optionList('asset_sent_to'), customer: customers });
});

// ---------------------------------------------------------------------------
// Allocation batches — a named group of assets for an order or allocation
// (e.g. "Wholesale – Buyer X – Oct"), with a packing list PDF.
// ---------------------------------------------------------------------------
const snapshotOf = (asset) => {
  const f = JSON.parse(asset.fields_json || '{}');
  const pick = ['asset_tag', 'category', 'manufacturer', 'model_name', 'model_number', 'serial_number', 'customer', 'status', 'asset_sent_to', 'buyer'];
  return JSON.stringify(Object.fromEntries(pick.filter((k) => f[k] != null && f[k] !== '').map((k) => [k, f[k]])));
};
function addToBatch(batchId, assetIds, userId) {
  const get = db.prepare('SELECT * FROM assets WHERE id = ?');
  const ins = db.prepare('INSERT OR IGNORE INTO asset_batch_items (id, batch_id, asset_id, snapshot_json, added_by) VALUES (?, ?, ?, ?, ?)');
  let added = 0;
  db.transaction(() => {
    assetIds.forEach((id) => {
      const a = get.get(id);
      if (a) added += ins.run(randomUUID(), batchId, id, snapshotOf(a), userId).changes;
    });
    db.prepare("UPDATE asset_batches SET updated_at = datetime('now') WHERE id = ?").run(batchId);
  })();
  return added;
}
function batchSummary(b) {
  const count = db.prepare('SELECT COUNT(*) as c FROM asset_batch_items WHERE batch_id = ?').get(b.id).c;
  const creator = b.created_by ? db.prepare('SELECT name FROM users WHERE id = ?').get(b.created_by)?.name : null;
  return { id: b.id, number: b.batch_number, name: b.name, notes: b.notes || '', count, createdBy: creator || '', createdAt: b.created_at, updatedAt: b.updated_at };
}
function batchItems(batchId) {
  const getAsset = db.prepare('SELECT * FROM assets WHERE id = ?');
  return db.prepare('SELECT * FROM asset_batch_items WHERE batch_id = ? ORDER BY added_at, rowid').all(batchId).map((it) => {
    const live = getAsset.get(it.asset_id);
    return { itemId: it.id, assetId: it.asset_id, deleted: !live, addedAt: it.added_at, fields: live ? JSON.parse(live.fields_json || '{}') : JSON.parse(it.snapshot_json || '{}') };
  });
}
const adminOnly = (req, res) => { if (isAdmin(req.user.id)) return false; res.status(403).json({ error: 'Only admins can change batches' }); return true; };

router.get('/batches', (req, res) => {
  res.json({ batches: db.prepare('SELECT * FROM asset_batches ORDER BY created_at DESC').all().map(batchSummary) });
});

router.post('/batches', (req, res) => {
  if (adminOnly(req, res)) return;
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Give the batch a name' });
  const ids = Array.isArray(req.body?.assetIds) ? req.body.assetIds : [];
  const id = randomUUID();
  const number = (db.prepare('SELECT MAX(batch_number) as m FROM asset_batches').get().m || 0) + 1;
  db.prepare('INSERT INTO asset_batches (id, batch_number, name, notes, created_by) VALUES (?, ?, ?, ?, ?)').run(id, number, name, String(req.body?.notes || '').trim() || null, req.user.id);
  const added = addToBatch(id, ids, req.user.id);
  res.status(201).json({ batch: batchSummary(db.prepare('SELECT * FROM asset_batches WHERE id = ?').get(id)), added });
});

router.get('/batches/:batchId', (req, res) => {
  const b = db.prepare('SELECT * FROM asset_batches WHERE id = ?').get(req.params.batchId);
  if (!b) return res.status(404).json({ error: 'Batch not found' });
  res.json({ batch: batchSummary(b), items: batchItems(b.id) });
});

router.patch('/batches/:batchId', (req, res) => {
  if (adminOnly(req, res)) return;
  const b = db.prepare('SELECT * FROM asset_batches WHERE id = ?').get(req.params.batchId);
  if (!b) return res.status(404).json({ error: 'Batch not found' });
  const name = req.body?.name !== undefined ? String(req.body.name).trim() : b.name;
  if (!name) return res.status(400).json({ error: 'Give the batch a name' });
  const notes = req.body?.notes !== undefined ? String(req.body.notes).trim() || null : b.notes;
  db.prepare("UPDATE asset_batches SET name = ?, notes = ?, updated_at = datetime('now') WHERE id = ?").run(name, notes, b.id);
  res.json({ batch: batchSummary(db.prepare('SELECT * FROM asset_batches WHERE id = ?').get(b.id)) });
});

router.post('/batches/:batchId/items', (req, res) => {
  if (adminOnly(req, res)) return;
  const b = db.prepare('SELECT id FROM asset_batches WHERE id = ?').get(req.params.batchId);
  if (!b) return res.status(404).json({ error: 'Batch not found' });
  const ids = Array.isArray(req.body?.assetIds) ? req.body.assetIds : [];
  if (!ids.length) return res.status(400).json({ error: 'Choose at least one asset' });
  res.json({ added: addToBatch(b.id, ids, req.user.id), batch: batchSummary(db.prepare('SELECT * FROM asset_batches WHERE id = ?').get(b.id)) });
});

router.post('/batches/:batchId/remove', (req, res) => {
  if (adminOnly(req, res)) return;
  const ids = Array.isArray(req.body?.assetIds) ? req.body.assetIds : [];
  const del = db.prepare('DELETE FROM asset_batch_items WHERE batch_id = ? AND asset_id = ?');
  let removed = 0;
  db.transaction(() => { ids.forEach((id) => { removed += del.run(req.params.batchId, id).changes; }); })();
  db.prepare("UPDATE asset_batches SET updated_at = datetime('now') WHERE id = ?").run(req.params.batchId);
  res.json({ removed });
});

// Deleting a batch only removes the grouping — the assets themselves stay.
router.delete('/batches/:batchId', (req, res) => {
  if (adminOnly(req, res)) return;
  const r = db.prepare('DELETE FROM asset_batches WHERE id = ?').run(req.params.batchId);
  if (!r.changes) return res.status(404).json({ error: 'Batch not found' });
  db.prepare('DELETE FROM asset_batch_items WHERE batch_id = ?').run(req.params.batchId);
  res.json({ ok: true });
});

router.get('/batches/:batchId/pdf', async (req, res) => {
  const b = db.prepare('SELECT * FROM asset_batches WHERE id = ?').get(req.params.batchId);
  if (!b) return res.status(404).json({ error: 'Batch not found' });
  try {
    const buffer = await buildBatchPdf(batchSummary(b), batchItems(b.id));
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `${req.query.download === '1' ? 'attachment' : 'inline'}; filename="batch-${b.batch_number}-${b.name.replace(/[^A-Za-z0-9._-]+/g, '_')}.pdf"`);
    res.send(buffer);
  } catch (err) {
    console.error('[assets] batch PDF failed:', err);
    res.status(500).json({ error: 'Could not make the packing list' });
  }
});

router.post('/bulk-delete', (req, res) => {
  if (!isAdmin(req.user.id)) return res.status(403).json({ error: 'Only admins can bulk-delete assets' });
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'ids array is required' });
  let deleted = 0;
  ids.forEach((id) => {
    const result = db.prepare('DELETE FROM assets WHERE id = ?').run(id);
    deleted += result.changes;
  });
  res.json({ ok: true, deleted });
});

router.patch('/bulk-edit', (req, res) => {
  if (!isAdmin(req.user.id)) return res.status(403).json({ error: 'Only admins can bulk-edit assets' });
  const { ids, updates } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'ids array is required' });
  if (!updates || typeof updates !== 'object' || Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'updates object is required' });
  }
  const defs = getFieldDefs();
  let updated = 0;
  ids.forEach((id) => {
    const asset = db.prepare('SELECT * FROM assets WHERE id = ?').get(id);
    if (!asset) return;
    const oldFields = JSON.parse(asset.fields_json || '{}');
    Object.keys(updates).forEach((key) => {
      if (JSON.stringify(oldFields[key]) !== JSON.stringify(updates[key])) {
        const label = defs.find((d) => d.field_key === key)?.label || key;
        logAssetAudit(id, label, oldFields[key], updates[key], req.user.id);
      }
    });
    const merged = { ...oldFields, ...updates };
    db.prepare("UPDATE assets SET fields_json = ?, updated_at = datetime('now') WHERE id = ?").run(JSON.stringify(merged), id);
    updated++;
  });
  res.json({ ok: true, updated });
});

router.post('/bulk-email', async (req, res) => {
  if (!isAdmin(req.user.id)) return res.status(403).json({ error: 'Only admins can email asset reports' });
  const { ids, recipients } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'ids array is required' });
  if (!Array.isArray(recipients) || recipients.length === 0) return res.status(400).json({ error: 'At least one recipient is required' });
  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const invalid = recipients.find((r) => typeof r !== 'string' || !emailPattern.test(r.trim()));
  if (invalid !== undefined) return res.status(400).json({ error: `"${invalid}" doesn't look like a valid email address` });

  const defs = getFieldDefs();
  const assets = ids.map((id) => db.prepare('SELECT * FROM assets WHERE id = ?').get(id)).filter(Boolean).map(withParsedFields);
  const csv = buildCsv(assets, defs);

  try {
    await notifyAssetReport({ toEmails: recipients, count: assets.length, csvBuffer: Buffer.from(csv, 'utf8') });
    res.json({ ok: true, sentTo: recipients, count: assets.length });
  } catch (err) {
    console.error('[assets] Could not send report email:', err.message);
    res.status(500).json({ error: 'Could not send email' });
  }
});

// Export exactly these assets (e.g. a bulk serial search result) as CSV.
router.post('/export', (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
  if (!ids.length) return res.status(400).json({ error: 'ids array is required' });
  const get = db.prepare('SELECT * FROM assets WHERE id = ?');
  const rows = ids.map((id) => get.get(id)).filter(Boolean).map(withParsedFields);
  const csv = buildCsv(rows, getFieldDefs());
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="asset-export-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(csv);
});

router.get('/email-defaults', (req, res) => {
  res.json({ recipients: [] });
});

router.get('/export', (req, res) => {
  const { where, params: whereParams } = buildWhere(req.query);
  const rows = db.prepare(`SELECT * FROM assets ${where} ORDER BY created_at DESC`).all(...whereParams).map(withParsedFields);
  const defs = getFieldDefs();
  const csv = buildCsv(rows, defs);
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="asset-export-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(csv);
});

router.post('/import', upload.single('file'), (req, res) => {
  if (!isAdmin(req.user.id)) return res.status(403).json({ error: 'Only admins can import assets' });
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const text = req.file.buffer.toString('utf8');
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length < 2) return res.status(400).json({ error: 'File has no data rows' });

  function parseCsvLine(line) {
    const cells = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQuotes) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (ch === '"') inQuotes = false;
        else cur += ch;
      } else if (ch === '"') inQuotes = true;
      else if (ch === ',') { cells.push(cur); cur = ''; }
      else cur += ch;
    }
    cells.push(cur);
    return cells;
  }

  // Turns a wide range of common date text (e.g. "Mon, Sep 21, 2026 4:28 PM", an
  // ISO string, "21/09/2026") into the 'YYYY-MM-DD HH:MM:SS' form SQLite expects.
  // Returns null if the text can't be parsed as a date at all, rather than
  // guessing — an unparsed date falls back to "now" instead of silently storing
  // something wrong.
  // Turns a wide range of common date text (e.g. "Mon, Sep 21, 2026 4:28 PM", an
  // ISO string, "21/09/2026") into the 'YYYY-MM-DD HH:MM:SS' UTC form SQLite and
  // the rest of this app expect.
  //
  // The wall-clock numbers in a historical spreadsheet like this one were written
  // in Sydney local time — they need to be converted to their UTC equivalent
  // before storing, or the app's existing "stored value is UTC, convert to the
  // viewer's local time for display" convention will silently shift every
  // timestamp by Sydney's UTC offset (10-11 hours, depending on daylight saving),
  // which is exactly what was pushing evening entries into the next calendar day.
  function parseHistoricalDate(text) {
    if (!text || !text.trim()) return null;
    const d = new Date(text.trim());
    if (isNaN(d.getTime())) return null;
    // Extracted with local getters, so these are the wall-clock numbers as
    // written in the source text, independent of the server's own timezone.
    const wallClock = { y: d.getFullYear(), mo: d.getMonth() + 1, day: d.getDate(), h: d.getHours(), mi: d.getMinutes(), s: d.getSeconds() };

    // Standard "guess, measure, correct" technique for converting a named-zone
    // wall-clock time to a UTC instant using only built-in Intl (no date library
    // needed, and it automatically accounts for daylight saving).
    const guessUtcMs = Date.UTC(wallClock.y, wallClock.mo - 1, wallClock.day, wallClock.h, wallClock.mi, wallClock.s);
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Australia/Sydney', hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(new Date(guessUtcMs));
    const get = (type) => parseInt(parts.find((p) => p.type === type).value, 10);
    const shownHour = get('hour') === 24 ? 0 : get('hour'); // Intl can report midnight as "24"
    const shownAsUtcMs = Date.UTC(get('year'), get('month') - 1, get('day'), shownHour, get('minute'), get('second'));
    const wantedMs = Date.UTC(wallClock.y, wallClock.mo - 1, wallClock.day, wallClock.h, wallClock.mi, wallClock.s);
    const correctedUtcMs = guessUtcMs + (wantedMs - shownAsUtcMs);

    const utc = new Date(correctedUtcMs);
    const pad = (n) => String(n).padStart(2, '0');
    return `${utc.getUTCFullYear()}-${pad(utc.getUTCMonth() + 1)}-${pad(utc.getUTCDate())} ${pad(utc.getUTCHours())}:${pad(utc.getUTCMinutes())}:${pad(utc.getUTCSeconds())}`;
  }

  const headerCells = parseCsvLine(lines[0]).map((h) => h.trim());
  const defs = getFieldDefs();
  const labelToKey = new Map(defs.map((f) => [f.label.toLowerCase(), f.field_key]));
  const dateCreatedIdx = headerCells.findIndex((h) => h.toLowerCase() === 'date created');
  const userNameIdx = headerCells.findIndex((h) => h.toLowerCase() === 'user name');
  const allUsers = db.prepare('SELECT id, name FROM users').all();
  const userByName = new Map(allUsers.map((u) => [u.name.trim().toLowerCase(), u.id]));

  let created = 0;
  const skippedColumns = [];
  // Rows whose serial is already on file (or earlier in the same file) are skipped
  // unless "import duplicates" was ticked — and listed back either way.
  const allowDuplicates = ['1', 'true', 'yes'].includes(String(req.body?.allowDuplicates || '').toLowerCase());
  const knownSerials = new Set(db.prepare(`SELECT ${SERIAL} as s FROM assets WHERE ${SERIAL} != ''`).all().map((r) => r.s));
  const duplicateSerials = [];
  const skippedRows = [];
  // "Import the skipped rows anyway": the page sends back just those row numbers.
  let onlyRows = null;
  try { const v = JSON.parse(req.body?.onlyRows || 'null'); if (Array.isArray(v)) onlyRows = new Set(v.map(Number)); } catch (e) { /* ignore */ }
  headerCells.forEach((h) => { if (!labelToKey.has(h.toLowerCase()) && h !== 'Date Created' && h !== 'User Name') skippedColumns.push(h); });

  const insertWithDate = db.prepare('INSERT INTO assets (id, fields_json, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?)');
  const insertDefault = db.prepare('INSERT INTO assets (id, fields_json, created_by) VALUES (?, ?, ?)');
  for (let i = 1; i < lines.length; i++) {
    if (onlyRows && !onlyRows.has(i)) continue;
    const cells = parseCsvLine(lines[i]);
    const fields = {};
    headerCells.forEach((h, idx) => {
      const key = labelToKey.get(h.toLowerCase());
      if (key && cells[idx] !== undefined && cells[idx] !== '') {
        const def = defs.find((d) => d.field_key === key);
        fields[key] = def?.type === 'multiselect' ? cells[idx].split(',').map((s) => s.trim()).filter(Boolean) : cells[idx];
      }
    });

    // A name in the sheet that doesn't match any real Work Desk account (very
    // likely for a bulk historical import) is kept as plain text on the record
    // itself, under a key no real field uses — so "who entered this" survives for
    // reporting even without a matching user account.
    let createdBy = req.user.id;
    if (userNameIdx >= 0 && cells[userNameIdx]) {
      const rawName = cells[userNameIdx].trim();
      const matchedId = userByName.get(rawName.toLowerCase());
      if (matchedId) createdBy = matchedId;
      else if (rawName) fields._imported_creator_name = rawName;
    }

    if (Object.keys(fields).length === 0) continue;

    const serialKey = String(fields.serial_number ?? '').trim().toUpperCase();
    if (serialKey && knownSerials.has(serialKey) && !onlyRows) {
      duplicateSerials.push(String(fields.serial_number).trim());
      if (!allowDuplicates) { skippedRows.push(i); continue; }
    }
    if (serialKey) knownSerials.add(serialKey);

    const historicalDate = dateCreatedIdx >= 0 ? parseHistoricalDate(cells[dateCreatedIdx]) : null;
    if (historicalDate) {
      insertWithDate.run(randomUUID(), JSON.stringify(fields), createdBy, historicalDate, historicalDate);
    } else {
      insertDefault.run(randomUUID(), JSON.stringify(fields), createdBy);
    }
    created++;
  }

  res.json({ ok: true, created, skippedColumns, duplicateSerials, skippedRows, duplicatesImported: allowDuplicates || !!onlyRows });
});

router.get('/reports/summary', (req, res) => {
  if (!isAdmin(req.user.id)) return res.status(403).json({ error: 'Only admins can view reports' });

  // ?customer= narrows the counts to one customer (any spelling); By Customer
  // always shows every customer so the page can switch between them.
  const { where: cw, params: cp } = buildWhere({ customer: req.query.customer || '' });
  const total = db.prepare(`SELECT COUNT(*) as c FROM assets ${cw}`).get(...cp).c;

  // Grouped by the imported name text when present (so 60 historical rows entered
  // by "Ian" show up as Ian's own bucket, not lumped under whichever admin actually
  // ran the import), falling back to the real account otherwise.
  const byTech = db.prepare(`
    SELECT COALESCE(json_extract(a.fields_json, '$._imported_creator_name'), u.name) as name, COUNT(*) as count
    FROM assets a LEFT JOIN users u ON u.id = a.created_by
    ${cw}
    GROUP BY COALESCE(json_extract(a.fields_json, '$._imported_creator_name'), a.created_by)
    ORDER BY count DESC
  `).all(...cp).map((r) => ({ name: r.name || 'Unassigned', count: r.count }));

  const byMonth = db.prepare(`
    SELECT strftime('%Y-%m', created_at) as period, COUNT(*) as count
    FROM assets ${cw} GROUP BY period ORDER BY period DESC
  `).all(...cp);

  const byYear = db.prepare(`
    SELECT strftime('%Y', created_at) as period, COUNT(*) as count
    FROM assets ${cw} GROUP BY period ORDER BY period DESC
  `).all(...cp);

  const byQuarter = db.prepare(`
    SELECT strftime('%Y', created_at) as year,
           ((CAST(strftime('%m', created_at) as INTEGER) - 1) / 3) + 1 as quarter,
           COUNT(*) as count
    FROM assets ${cw} GROUP BY year, quarter ORDER BY year DESC, quarter DESC
  `).all(...cp).map((r) => ({ period: `${r.year} Q${r.quarter}`, count: r.count }));

  // Spellings of the same customer ("ACME ", "Acme") count as one.
  const customers = canonicalCustomers();
  const byCompany = [...customers.values()]
    .map((g) => ({ company: g.key ? g.best || 'Unspecified' : 'Unspecified', count: g.total }))
    .sort((a, b) => b.count - a.count);

  // Asset class (the Category field) — counted per customer, status and where it
  // was sent, so the page can show the breakdown for all customers or just one.
  const classMerged = new Map();
  db.prepare(`
    SELECT COALESCE(NULLIF(trim(json_extract(fields_json, '$.category')), ''), 'Unspecified') as assetClass,
           ${norm('customer')} as customerKey,
           COALESCE(NULLIF(trim(json_extract(fields_json, '$.status')), ''), '') as status,
           COALESCE(NULLIF(trim(json_extract(fields_json, '$.asset_sent_to')), ''), '') as sentTo,
           COUNT(*) as count
    FROM assets ${cw} GROUP BY assetClass, customerKey, status, sentTo
  `).all(...cp).forEach((r) => {
    const customer = r.customerKey ? (customers.get(r.customerKey)?.best || r.customerKey) : 'Unspecified';
    const k = [r.assetClass, customer, r.status, r.sentTo].join('\u0001');
    const row = classMerged.get(k) || { assetClass: r.assetClass, customer, status: r.status, sentTo: r.sentTo, count: 0 };
    row.count += r.count;
    classMerged.set(k, row);
  });
  const classRows = [...classMerged.values()];

  res.json({ total, byTech, byMonth, byQuarter, byYear, byCompany, classRows });
});

// ---------------------------------------------------------------------------
// Single-asset routes — must come AFTER every literal path above.
// ---------------------------------------------------------------------------

router.get('/:id', (req, res) => {
  const asset = db.prepare('SELECT * FROM assets WHERE id = ?').get(req.params.id);
  if (!asset) return res.status(404).json({ error: 'Asset not found' });
  const audit = db.prepare('SELECT * FROM asset_audit WHERE asset_id = ? ORDER BY changed_at DESC').all(asset.id)
    .map((a) => ({ ...a, user: a.changed_by ? db.prepare('SELECT id, name FROM users WHERE id = ?').get(a.changed_by) : null }));
  res.json({ asset: withParsedFields(asset), audit });
});

router.patch('/:id', (req, res) => {
  const asset = db.prepare('SELECT * FROM assets WHERE id = ?').get(req.params.id);
  if (!asset) return res.status(404).json({ error: 'Asset not found' });
  const { fields } = req.body;
  if (!fields || typeof fields !== 'object') return res.status(400).json({ error: 'fields object is required' });

  const oldFields = JSON.parse(asset.fields_json || '{}');
  const serialChanged = 'serial_number' in fields
    && String(fields.serial_number ?? '').trim().toUpperCase() !== String(oldFields.serial_number ?? '').trim().toUpperCase();
  if (serialChanged && !req.body.allowDuplicateSerial) {
    const matches = serialConflicts(fields.serial_number, asset.id);
    if (matches.length) return duplicateSerialResponse(res, fields.serial_number, matches);
  }
  const defs = getFieldDefs();
  Object.keys(fields).forEach((key) => {
    const oldVal = oldFields[key];
    const newVal = fields[key];
    if (JSON.stringify(oldVal) !== JSON.stringify(newVal)) {
      const label = defs.find((d) => d.field_key === key)?.label || key;
      logAssetAudit(asset.id, label, Array.isArray(oldVal) ? oldVal.join(', ') : oldVal, Array.isArray(newVal) ? newVal.join(', ') : newVal, req.user.id);
    }
  });

  const merged = { ...oldFields, ...fields };
  db.prepare("UPDATE assets SET fields_json = ?, updated_at = datetime('now') WHERE id = ?").run(JSON.stringify(merged), req.params.id);
  const updated = db.prepare('SELECT * FROM assets WHERE id = ?').get(req.params.id);
  res.json({ asset: withParsedFields(updated) });
});

router.delete('/:id', (req, res) => {
  if (!isAdmin(req.user.id)) return res.status(403).json({ error: 'Only admins can delete assets' });
  const asset = db.prepare('SELECT id FROM assets WHERE id = ?').get(req.params.id);
  if (!asset) return res.status(404).json({ error: 'Asset not found' });
  db.prepare('DELETE FROM assets WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;

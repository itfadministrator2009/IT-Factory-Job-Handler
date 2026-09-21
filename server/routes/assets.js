const express = require('express');
const multer = require('multer');
const { randomUUID } = require('crypto');
const { db } = require('../db');
const { authRequired } = require('../auth');
const { isAdminRole } = require('../permissions');
const { notifyAssetReport } = require('../email');

const router = express.Router();
router.use(authRequired);

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
  const q = (req.query.q || '').trim();

  const where = q ? 'WHERE fields_json LIKE ?' : '';
  const whereParams = q ? [`%${q}%`] : [];

  const total = db.prepare(`SELECT COUNT(*) as c FROM assets ${where}`).get(...whereParams).c;
  const rows = db.prepare(`SELECT * FROM assets ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...whereParams, limit, offset);
  res.json({ assets: rows.map(withParsedFields), total, page, totalPages: Math.max(1, Math.ceil(total / limit)) });
});

router.post('/', (req, res) => {
  const { fields } = req.body;
  if (!fields || typeof fields !== 'object') return res.status(400).json({ error: 'fields object is required' });
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

router.get('/email-defaults', (req, res) => {
  res.json({ recipients: [] });
});

router.get('/export', (req, res) => {
  const q = (req.query.q || '').trim();
  const where = q ? 'WHERE fields_json LIKE ?' : '';
  const whereParams = q ? [`%${q}%`] : [];
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
  function parseHistoricalDate(text) {
    if (!text || !text.trim()) return null;
    const d = new Date(text.trim());
    if (isNaN(d.getTime())) return null;
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
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
  headerCells.forEach((h) => { if (!labelToKey.has(h.toLowerCase()) && h !== 'Date Created' && h !== 'User Name') skippedColumns.push(h); });

  const insertWithDate = db.prepare('INSERT INTO assets (id, fields_json, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?)');
  const insertDefault = db.prepare('INSERT INTO assets (id, fields_json, created_by) VALUES (?, ?, ?)');
  for (let i = 1; i < lines.length; i++) {
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

    const historicalDate = dateCreatedIdx >= 0 ? parseHistoricalDate(cells[dateCreatedIdx]) : null;
    if (historicalDate) {
      insertWithDate.run(randomUUID(), JSON.stringify(fields), createdBy, historicalDate, historicalDate);
    } else {
      insertDefault.run(randomUUID(), JSON.stringify(fields), createdBy);
    }
    created++;
  }

  res.json({ ok: true, created, skippedColumns });
});

router.get('/reports/summary', (req, res) => {
  if (!isAdmin(req.user.id)) return res.status(403).json({ error: 'Only admins can view reports' });

  const total = db.prepare('SELECT COUNT(*) as c FROM assets').get().c;

  // Grouped by the imported name text when present (so 60 historical rows entered
  // by "Ian" show up as Ian's own bucket, not lumped under whichever admin actually
  // ran the import), falling back to the real account otherwise.
  const byTech = db.prepare(`
    SELECT COALESCE(json_extract(a.fields_json, '$._imported_creator_name'), u.name) as name, COUNT(*) as count
    FROM assets a LEFT JOIN users u ON u.id = a.created_by
    GROUP BY COALESCE(json_extract(a.fields_json, '$._imported_creator_name'), a.created_by)
    ORDER BY count DESC
  `).all().map((r) => ({ name: r.name || 'Unassigned', count: r.count }));

  const byMonth = db.prepare(`
    SELECT strftime('%Y-%m', created_at) as period, COUNT(*) as count
    FROM assets GROUP BY period ORDER BY period DESC
  `).all();

  const byYear = db.prepare(`
    SELECT strftime('%Y', created_at) as period, COUNT(*) as count
    FROM assets GROUP BY period ORDER BY period DESC
  `).all();

  const byQuarter = db.prepare(`
    SELECT strftime('%Y', created_at) as year,
           ((CAST(strftime('%m', created_at) as INTEGER) - 1) / 3) + 1 as quarter,
           COUNT(*) as count
    FROM assets GROUP BY year, quarter ORDER BY year DESC, quarter DESC
  `).all().map((r) => ({ period: `${r.year} Q${r.quarter}`, count: r.count }));

  const byCompany = db.prepare(`
    SELECT COALESCE(json_extract(fields_json, '$.customer'), 'Unspecified') as company, COUNT(*) as count
    FROM assets GROUP BY company ORDER BY count DESC
  `).all();

  res.json({ total, byTech, byMonth, byQuarter, byYear, byCompany });
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

const express = require('express');
const { v4: uuid } = require('uuid');
const { db } = require('../db');
const { authRequired } = require('../auth');
const { isAdminRole, currentRole } = require('../permissions');

const router = express.Router();
router.use(authRequired);
router.use((req, res, next) => {
  if (!isAdminRole(currentRole(req.user.id))) return res.status(403).json({ error: 'Admin access required' });
  next();
});

function withParsed(t) {
  return { ...t, fields: JSON.parse(t.fields_json), items: JSON.parse(t.items_json) };
}

router.get('/', (req, res) => {
  const templates = db.prepare('SELECT * FROM job_templates ORDER BY name ASC').all().map(withParsed);
  res.json({ templates });
});

router.post('/', (req, res) => {
  const { name, fields, items } = req.body;
  if (!name || !fields) return res.status(400).json({ error: 'name and fields are required' });

  const id = uuid();
  db.prepare('INSERT INTO job_templates (id, name, fields_json, items_json, created_by) VALUES (?, ?, ?, ?, ?)')
    .run(id, name, JSON.stringify(fields), JSON.stringify(items || []), req.user.id);

  res.status(201).json({ template: withParsed(db.prepare('SELECT * FROM job_templates WHERE id = ?').get(id)) });
});

router.delete('/:id', (req, res) => {
  const result = db.prepare('DELETE FROM job_templates WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Template not found' });
  res.json({ ok: true });
});

module.exports = router;

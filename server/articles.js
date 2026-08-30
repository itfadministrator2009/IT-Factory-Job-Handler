const express = require('express');
const { v4: uuid } = require('uuid');
const { db } = require('../db');
const { authRequired } = require('../auth');

const router = express.Router();
router.use(authRequired);

function slugify(title) {
  return title.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

router.get('/', (req, res) => {
  const { q, category } = req.query;
  let sql = 'SELECT * FROM articles WHERE 1=1';
  const params = [];
  if (q) {
    sql += ' AND (title LIKE ? OR body LIKE ?)';
    params.push(`%${q}%`, `%${q}%`);
  }
  if (category) {
    sql += ' AND category = ?';
    params.push(category);
  }
  sql += ' ORDER BY updated_at DESC';
  const articles = db.prepare(sql).all(...params);
  res.json({ articles });
});

router.get('/:slugOrId', (req, res) => {
  const article = db.prepare('SELECT * FROM articles WHERE slug = ? OR id = ?').get(req.params.slugOrId, req.params.slugOrId);
  if (!article) return res.status(404).json({ error: 'Article not found' });
  res.json({ article });
});

router.post('/', (req, res) => {
  const { title, body, category } = req.body;
  if (!title || !body) return res.status(400).json({ error: 'title and body are required' });

  let slug = slugify(title);
  const existing = db.prepare('SELECT id FROM articles WHERE slug = ?').get(slug);
  if (existing) slug = `${slug}-${Date.now().toString(36)}`;

  const id = uuid();
  db.prepare(`
    INSERT INTO articles (id, title, slug, body, category, author_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, title, slug, body, category || 'General', req.user.id);

  const article = db.prepare('SELECT * FROM articles WHERE id = ?').get(id);
  res.status(201).json({ article });
});

router.patch('/:id', (req, res) => {
  const article = db.prepare('SELECT * FROM articles WHERE id = ?').get(req.params.id);
  if (!article) return res.status(404).json({ error: 'Article not found' });

  const fields = ['title', 'body', 'category'];
  const updates = [];
  const params = [];
  fields.forEach((f) => {
    if (req.body[f] !== undefined) {
      updates.push(`${f} = ?`);
      params.push(req.body[f]);
    }
  });
  if (updates.length === 0) return res.status(400).json({ error: 'No valid fields to update' });

  updates.push("updated_at = datetime('now')");
  params.push(req.params.id);
  db.prepare(`UPDATE articles SET ${updates.join(', ')} WHERE id = ?`).run(...params);

  const updated = db.prepare('SELECT * FROM articles WHERE id = ?').get(req.params.id);
  res.json({ article: updated });
});

router.delete('/:id', (req, res) => {
  const result = db.prepare('DELETE FROM articles WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Article not found' });
  res.json({ ok: true });
});

module.exports = router;

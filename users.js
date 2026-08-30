const express = require('express');
const bcrypt = require('bcryptjs');
const { v4: uuid } = require('uuid');
const { db } = require('../db');
const { authRequired } = require('../auth');

const router = express.Router();
router.use(authRequired);

// 'agent' is the old, pre-roles default every existing account has — treated as
// admin-equivalent so nobody loses access when this feature ships. New accounts
// only ever get 'admin' or 'user' going forward.
function isAdminRole(role) {
  return role === 'admin' || role === 'agent';
}

function adminRequired(req, res, next) {
  const user = db.prepare('SELECT role FROM users WHERE id = ?').get(req.user.id);
  if (!user || !isAdminRole(user.role)) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

function countAdmins() {
  return db.prepare("SELECT COUNT(*) as c FROM users WHERE role IN ('admin','agent')").get().c;
}

// Everyone can see the basic team list — used to populate the "Ticket Owner" dropdown
router.get('/', (req, res) => {
  const users = db.prepare('SELECT id, name, email FROM users ORDER BY name').all();
  res.json({ users });
});

// Admin-only: full user management
router.get('/admin', adminRequired, (req, res) => {
  const users = db.prepare('SELECT id, name, email, role, created_at FROM users ORDER BY created_at ASC').all();
  res.json({ users });
});

router.post('/admin', adminRequired, (req, res) => {
  const { name, email, password, role } = req.body;
  if (!name || !email || !password) {
    return res.status(400).json({ error: 'name, email, and password are required' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) return res.status(409).json({ error: 'Email already registered' });

  const finalRole = role === 'admin' ? 'admin' : 'user';
  const id = uuid();
  const password_hash = bcrypt.hashSync(password, 10);
  db.prepare('INSERT INTO users (id, name, email, password_hash, role) VALUES (?, ?, ?, ?, ?)')
    .run(id, name, email, password_hash, finalRole);

  const user = db.prepare('SELECT id, name, email, role, created_at FROM users WHERE id = ?').get(id);
  res.status(201).json({ user });
});

router.patch('/admin/:id', adminRequired, (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found' });

  const { role, name } = req.body;

  if (role !== undefined) {
    const finalRole = role === 'admin' ? 'admin' : 'user';
    // Refuse to demote the last remaining admin — that would lock everyone out of Settings.
    if (finalRole !== 'admin' && isAdminRole(target.role) && countAdmins() <= 1) {
      return res.status(400).json({ error: 'Cannot remove the last admin' });
    }
    db.prepare('UPDATE users SET role = ? WHERE id = ?').run(finalRole, req.params.id);
  }

  if (name !== undefined && name.trim()) {
    db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name.trim(), req.params.id);
  }

  const updated = db.prepare('SELECT id, name, email, role, created_at FROM users WHERE id = ?').get(req.params.id);
  res.json({ user: updated });
});

router.delete('/admin/:id', adminRequired, (req, res) => {
  if (req.params.id === req.user.id) {
    return res.status(400).json({ error: "You can't delete your own account" });
  }
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found' });

  if (isAdminRole(target.role) && countAdmins() <= 1) {
    return res.status(400).json({ error: 'Cannot delete the last admin' });
  }

  db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// Admin sets a new password for someone directly — for when they're locked out and
// email isn't set up, or just faster than waiting on a reset email.
router.post('/admin/:id/reset-password', adminRequired, (req, res) => {
  const target = db.prepare('SELECT id FROM users WHERE id = ?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found' });

  const { password } = req.body;
  if (!password || password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  const password_hash = bcrypt.hashSync(password, 10);
  db.prepare('UPDATE users SET password_hash = ?, reset_token = NULL, reset_token_expires = NULL WHERE id = ?')
    .run(password_hash, req.params.id);

  res.json({ ok: true });
});

module.exports = router;

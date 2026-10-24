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
  // Contractors (ITF Time Card only) aren't staff, so they never appear as job or project owners.
  const users = db.prepare("SELECT id, name, email FROM users WHERE role IS NOT 'contractor' ORDER BY name").all();
  res.json({ users });
});

// Admin-only: full user management
const USER_COLS = 'id, name, email, role, created_at, access_assets, access_storage, access_timecard, hourly_rate';
const toAdminUser = (u) => u && ({
  ...u, accessAssets: u.access_assets !== 0, accessStorage: u.access_storage !== 0, accessTimecard: u.access_timecard === 1,
  hourlyRate: u.hourly_rate > 0 ? u.hourly_rate : null,
});
// 'admin', 'user' (staff) or 'contractor' (ITF Time Card only).
const roleFrom = (role) => (role === 'admin' ? 'admin' : role === 'contractor' ? 'contractor' : 'user');
// Hourly rate (optional) — used for the Time Card's estimated pay. Blank clears it.
function rateFrom(v) {
  if (v === undefined) return undefined;
  if (v === null || String(v).trim() === '') return null;
  const n = Math.round(Number(v) * 100) / 100;
  if (!Number.isFinite(n) || n < 0 || n > 100000) return NaN;
  return n || null;
}

router.get('/admin', adminRequired, (req, res) => {
  const users = db.prepare(`SELECT ${USER_COLS} FROM users ORDER BY created_at ASC`).all().map(toAdminUser);
  res.json({ users });
});

router.post('/admin', adminRequired, (req, res) => {
  const { name, email, password, role, accessAssets, accessStorage, accessTimecard, hourlyRate } = req.body;
  if (!name || !email || !password) {
    return res.status(400).json({ error: 'name, email, and password are required' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }
  const rate = rateFrom(hourlyRate);
  if (Number.isNaN(rate)) return res.status(400).json({ error: 'Hourly rate must be a number' });

  const finalRole = roleFrom(role);
  const id = uuid();
  const password_hash = bcrypt.hashSync(password, 10);
  db.prepare('INSERT INTO users (id, name, email, password_hash, role, access_assets, access_storage, access_timecard, hourly_rate) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, name, email, password_hash, finalRole, accessAssets === false ? 0 : 1, accessStorage === false ? 0 : 1, accessTimecard ? 1 : 0, rate ?? null);

  const user = toAdminUser(db.prepare(`SELECT ${USER_COLS} FROM users WHERE id = ?`).get(id));
  res.status(201).json({ user });
});

router.patch('/admin/:id', adminRequired, (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found' });

  const { role, name, email, accessAssets, accessStorage, accessTimecard, hourlyRate } = req.body;

  const rate = rateFrom(hourlyRate);
  if (Number.isNaN(rate)) return res.status(400).json({ error: 'Hourly rate must be a number' });
  if (rate !== undefined) db.prepare('UPDATE users SET hourly_rate = ? WHERE id = ?').run(rate, req.params.id);

  // Which sections a (non-admin) user can open. Admins always have both.
  if (accessAssets !== undefined) db.prepare('UPDATE users SET access_assets = ? WHERE id = ?').run(accessAssets ? 1 : 0, req.params.id);
  if (accessStorage !== undefined) db.prepare('UPDATE users SET access_storage = ? WHERE id = ?').run(accessStorage ? 1 : 0, req.params.id);
  // ITF Time Card: a User also logs their own hours (contractors always do).
  if (accessTimecard !== undefined) db.prepare('UPDATE users SET access_timecard = ? WHERE id = ?').run(accessTimecard ? 1 : 0, req.params.id);

  if (role !== undefined) {
    const finalRole = roleFrom(role);
    // Refuse to demote the last remaining admin — that would lock everyone out of Settings.
    if (finalRole !== 'admin' && isAdminRole(target.role) && countAdmins() <= 1) {
      return res.status(400).json({ error: 'Cannot remove the last admin' });
    }
    db.prepare('UPDATE users SET role = ? WHERE id = ?').run(finalRole, req.params.id);
  }

  if (name !== undefined && name.trim()) {
    db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name.trim(), req.params.id);
  }

  // Email is intentionally not required to be unique — multiple techs can share one
  // inbox (see the login route, which checks every account with a given email).
  if (email !== undefined && email.trim()) {
    db.prepare('UPDATE users SET email = ? WHERE id = ?').run(email.trim(), req.params.id);
  }

  const updated = toAdminUser(db.prepare(`SELECT ${USER_COLS} FROM users WHERE id = ?`).get(req.params.id));
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
  db.prepare('UPDATE users SET password_hash = ?, reset_token = NULL, reset_token_expires = NULL, legacy_pw_hash = NULL, legacy_pw_salt = NULL WHERE id = ?')
    .run(password_hash, req.params.id);

  res.json({ ok: true });
});

module.exports = router;

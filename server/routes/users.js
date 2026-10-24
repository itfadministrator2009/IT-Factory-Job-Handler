const express = require('express');
const bcrypt = require('bcryptjs');
const { v4: uuid } = require('uuid');
const { db } = require('../db');
const { authRequired } = require('../auth');
const { logActivity } = require('../activity');

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

// Only the Super Admin can remove an admin account, take admin access away from
// someone, or change the Super Admin's own account.
const isSuperAdmin = (userId) => db.prepare('SELECT super_admin FROM users WHERE id = ?').get(userId)?.super_admin === 1;

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
const USER_COLS = 'id, name, email, role, created_at, access_assets, access_storage, access_timecard, hourly_rate, super_admin';
const toAdminUser = (u) => u && ({
  ...u, accessAssets: u.access_assets !== 0, accessStorage: u.access_storage !== 0, accessTimecard: u.access_timecard === 1,
  hourlyRate: u.hourly_rate > 0 ? u.hourly_rate : null, superAdmin: u.super_admin === 1,
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
  logActivity('user.created', { req, target: { type: 'user', id, name }, details: `Role: ${finalRole}` });
  res.status(201).json({ user });
});

router.patch('/admin/:id', adminRequired, (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found' });

  const { role, name, email, accessAssets, accessStorage, accessTimecard, hourlyRate } = req.body;

  if (!isSuperAdmin(req.user.id)) {
    if (target.super_admin === 1) return res.status(403).json({ error: "Only the Super Admin can change the Super Admin's account." });
    if (role !== undefined && isAdminRole(target.role) && roleFrom(role) !== 'admin') {
      return res.status(403).json({ error: 'Only the Super Admin can take admin access away from an admin.' });
    }
  }

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

  const after = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  const changes = [];
  const yn = (v) => (v ? 'on' : 'off');
  if (after.role !== target.role) changes.push(`Role: ${target.role} → ${after.role}`);
  if (after.name !== target.name) changes.push(`Name: ${target.name} → ${after.name}`);
  if (after.email !== target.email) changes.push(`Email: ${target.email} → ${after.email}`);
  if (!!after.access_assets !== !!target.access_assets) changes.push(`Asset Manager: ${yn(after.access_assets)}`);
  if (!!after.access_storage !== !!target.access_storage) changes.push(`Storage Centre: ${yn(after.access_storage)}`);
  if (!!after.access_timecard !== !!target.access_timecard) changes.push(`Time Card: ${yn(after.access_timecard)}`);
  if ((after.hourly_rate ?? null) !== (target.hourly_rate ?? null)) changes.push(`Hourly rate: ${target.hourly_rate ?? '—'} → ${after.hourly_rate ?? '—'}`);
  if (changes.length) logActivity('user.updated', { req, target: { type: 'user', id: after.id, name: after.name }, details: changes.join('; ') });

  const updated = toAdminUser(db.prepare(`SELECT ${USER_COLS} FROM users WHERE id = ?`).get(req.params.id));
  res.json({ user: updated });
});

router.delete('/admin/:id', adminRequired, (req, res) => {
  if (req.params.id === req.user.id) {
    return res.status(400).json({ error: "You can't delete your own account" });
  }
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found' });

  if (isAdminRole(target.role) && !isSuperAdmin(req.user.id)) {
    return res.status(403).json({ error: 'Only the Super Admin can remove an admin account.' });
  }
  if (isAdminRole(target.role) && countAdmins() <= 1) {
    return res.status(400).json({ error: 'Cannot delete the last admin' });
  }

  db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  db.prepare('DELETE FROM trusted_devices WHERE user_id = ?').run(req.params.id);
  logActivity('user.deleted', { req, target: { type: 'user', id: target.id, name: target.name }, details: target.email });
  res.json({ ok: true });
});

// Admin sets a new password for someone directly — for when they're locked out and
// email isn't set up, or just faster than waiting on a reset email.
router.post('/admin/:id/reset-password', adminRequired, (req, res) => {
  const target = db.prepare('SELECT id, name, super_admin FROM users WHERE id = ?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target.super_admin === 1 && target.id !== req.user.id && !isSuperAdmin(req.user.id)) {
    return res.status(403).json({ error: "Only the Super Admin can set the Super Admin's password." });
  }

  const { password } = req.body;
  if (!password || password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  const password_hash = bcrypt.hashSync(password, 10);
  db.prepare('UPDATE users SET password_hash = ?, reset_token = NULL, reset_token_expires = NULL, legacy_pw_hash = NULL, legacy_pw_salt = NULL WHERE id = ?')
    .run(password_hash, req.params.id);
  require('../twoStep').forgetDevices(req.params.id);
  logActivity('user.password_set', { req, target: { type: 'user', id: target.id, name: target.name } });

  res.json({ ok: true });
});

module.exports = router;

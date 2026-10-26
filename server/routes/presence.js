// "Who's online" — the old Storage Centre's heartbeat presence. Each signed-in
// page sends a heartbeat every minute; anyone seen in the last 150 seconds
// counts as online (same window as the old app). Signing out clears it.
const express = require('express');
const { db } = require('../db');
const { authRequired } = require('../auth');
const { logActivity } = require('../activity');

const ACTIVE_WINDOW_MS = 150 * 1000;

db.exec(`CREATE TABLE IF NOT EXISTS user_presence (
  user_id TEXT PRIMARY KEY,
  name TEXT,
  last_seen INTEGER NOT NULL
)`);

const router = express.Router();
router.use(authRequired);

function activeUsers() {
  return db.prepare('SELECT user_id, name, last_seen FROM user_presence WHERE last_seen > ? ORDER BY last_seen DESC')
    .all(Date.now() - ACTIVE_WINDOW_MS)
    .map((r) => ({ id: r.user_id, name: r.name, lastSeenMs: r.last_seen }));
}

router.post('/heartbeat', (req, res) => {
  const name = db.prepare('SELECT name FROM users WHERE id = ?').get(req.user.id)?.name || req.user.name || null;
  db.prepare(`INSERT INTO user_presence (user_id, name, last_seen) VALUES (?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET name = excluded.name, last_seen = excluded.last_seen`).run(String(req.user.id), name, Date.now());
  res.json({ users: activeUsers() });
});

router.get('/', (req, res) => {
  res.json({ users: activeUsers() });
});

// Refresh button: how many changes other people have made since this page loaded.
// GET /api/presence/changes?since=<ms> (no since = just the server's clock).
router.get('/changes', (req, res) => {
  res.json(require('../changeTracker').changesSince(req.query.since, req.user.id));
});

// Admin: log someone out of Work Desk on every device. Their current sign-in
// stops working at once (the page sends them to the login screen within a
// minute, or on their next click) and they drop off the online list.
function isAdmin(userId) {
  const row = db.prepare('SELECT role FROM users WHERE id = ?').get(userId);
  return !!row && (row.role === 'admin' || row.role === 'agent');
}
function logOut(userId) {
  db.prepare('UPDATE users SET session_version = COALESCE(session_version, 0) + 1 WHERE id = ?').run(userId);
  db.prepare('DELETE FROM user_presence WHERE user_id = ?').run(String(userId));
  // Logging someone out everywhere also means their next admin login asks for a code again.
  db.prepare('DELETE FROM trusted_devices WHERE user_id = ?').run(String(userId));
}

router.post('/:userId/logout', (req, res) => {
  if (!isAdmin(req.user.id)) return res.status(403).json({ error: 'Only admins can log people out' });
  if (String(req.params.userId) === String(req.user.id)) return res.status(400).json({ error: "Use Log out to sign yourself out" });
  const target = db.prepare('SELECT id, name FROM users WHERE id = ?').get(req.params.userId);
  if (!target) return res.status(404).json({ error: 'User not found' });
  logOut(target.id);
  logActivity('user.logged_out', { req, target: { type: 'user', id: target.id, name: target.name } });
  console.log(`[presence] ${req.user.name || req.user.id} logged out ${target.name}`);
  res.json({ ok: true, name: target.name, users: activeUsers() });
});

// Admin: log out everyone except yourself.
router.post('/logout-all', (req, res) => {
  if (!isAdmin(req.user.id)) return res.status(403).json({ error: 'Only admins can log people out' });
  const others = db.prepare('SELECT id FROM users WHERE id != ?').all(req.user.id);
  db.transaction(() => others.forEach((u) => logOut(u.id)))();
  logActivity('user.logged_out_all', { req, details: `${others.length} user${others.length === 1 ? '' : 's'}` });
  console.log(`[presence] ${req.user.name || req.user.id} logged out everyone else (${others.length})`);
  res.json({ ok: true, count: others.length, users: activeUsers() });
});

router.delete('/', (req, res) => {
  db.prepare('DELETE FROM user_presence WHERE user_id = ?').run(String(req.user.id));
  res.json({ ok: true });
});

module.exports = router;

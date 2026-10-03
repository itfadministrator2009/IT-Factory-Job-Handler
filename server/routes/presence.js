// "Who's online" — the old Storage Centre's heartbeat presence. Each signed-in
// page sends a heartbeat every minute; anyone seen in the last 150 seconds
// counts as online (same window as the old app). Signing out clears it.
const express = require('express');
const { db } = require('../db');
const { authRequired } = require('../auth');

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

router.delete('/', (req, res) => {
  db.prepare('DELETE FROM user_presence WHERE user_id = ?').run(String(req.user.id));
  res.json({ ok: true });
});

module.exports = router;

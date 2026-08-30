const express = require('express');
const { db } = require('../db');
const { authRequired } = require('../auth');
const { detectState } = require('../calendar');
const { isAdminRole, currentRole } = require('../permissions');

const router = express.Router();
router.use(authRequired);
router.use((req, res, next) => {
  if (!isAdminRole(currentRole(req.user.id))) return res.status(403).json({ error: 'Admin access required' });
  next();
});

router.get('/summary', (req, res) => {
  const { from, to } = req.query;
  const hasRange = !!(from && to);

  // ---- Jobs completed per week ----
  // With no range: last 8 weeks ending today (unchanged default). With a range: weekly
  // buckets spanning it, capped at 26 (~6 months) so an accidentally huge range never
  // produces an unreadably wide chart.
  let weekKeys;
  if (hasRange) {
    const start = new Date(`${from}T00:00:00Z`);
    const end = new Date(`${to}T00:00:00Z`);
    const keys = [];
    const cursor = new Date(start);
    while (cursor <= end && keys.length < 26) {
      keys.push(cursor.toISOString().slice(0, 10));
      cursor.setDate(cursor.getDate() + 7);
    }
    weekKeys = keys.length > 0 ? keys : [from];
  } else {
    const keys = [];
    for (let i = 7; i >= 0; i--) {
      const weekStart = new Date();
      weekStart.setDate(weekStart.getDate() - i * 7);
      keys.push(weekStart.toISOString().slice(0, 10));
    }
    weekKeys = keys;
  }
  weekKeys.sort();

  const resolvedRows = hasRange
    ? db.prepare('SELECT resolved_at FROM jobs WHERE resolved_at IS NOT NULL AND resolved_at >= ? AND resolved_at <= ?').all(`${from} 00:00:00`, `${to} 23:59:59`)
    : db.prepare("SELECT resolved_at FROM jobs WHERE resolved_at IS NOT NULL AND resolved_at >= datetime('now', '-56 days')").all();

  const weekBuckets = {};
  weekKeys.forEach((k) => { weekBuckets[k] = 0; });
  resolvedRows.forEach((r) => {
    const d = new Date(r.resolved_at.replace(' ', 'T') + 'Z');
    for (let i = weekKeys.length - 1; i >= 0; i--) {
      if (d >= new Date(weekKeys[i])) {
        weekBuckets[weekKeys[i]] += 1;
        break;
      }
    }
  });
  const completedPerWeek = weekKeys.map((k) => ({ weekStart: k, count: weekBuckets[k] }));

  // ---- Everything below is filtered by created_at when a range is given ----
  const dateFilter = hasRange ? 'AND created_at >= ? AND created_at <= ?' : '';
  const dateParams = hasRange ? [`${from} 00:00:00`, `${to} 23:59:59`] : [];
  // perTech joins jobs and users — both tables have a created_at column, so that
  // query needs it qualified (j.created_at) or SQLite rejects it as ambiguous.
  const dateFilterJ = hasRange ? 'AND j.created_at >= ? AND j.created_at <= ?' : '';

  const perTech = db.prepare(`
    SELECT u.name as name, COUNT(j.id) as total,
      SUM(CASE WHEN j.status IN ('Complete','Collected','Closed') THEN 1 ELSE 0 END) as completed
    FROM jobs j
    JOIN users u ON u.id = j.owner_id
    WHERE 1=1 ${dateFilterJ}
    GROUP BY j.owner_id
    ORDER BY total DESC
  `).all(...dateParams);

  // Unassigned count is always a current, whole-of-time snapshot (not filtered by
  // range) — it's an operational "needs attention now" number, not a historical one.
  const unassignedCount = db.prepare('SELECT COUNT(*) as c FROM jobs WHERE owner_id IS NULL').get().c;

  // State breakdown — reuses the same address-parsing logic as the calendar sync,
  // so a job counted as "NSW" here is the same job that got the NSW calendar category.
  const addresses = db.prepare(`SELECT site_address FROM jobs WHERE 1=1 ${dateFilter}`).all(...dateParams);
  const stateCounts = {};
  addresses.forEach(({ site_address }) => {
    const state = detectState(site_address) || 'Unknown';
    stateCounts[state] = (stateCounts[state] || 0) + 1;
  });
  const byState = Object.entries(stateCounts)
    .map(([state, count]) => ({ state, count }))
    .sort((a, b) => b.count - a.count);

  // Vehicle breakdown — grouped by the exact stored value (the dropdown's presets,
  // or whatever was typed into "Custom").
  const vehicles = db.prepare(`SELECT language FROM jobs WHERE 1=1 ${dateFilter}`).all(...dateParams);
  const vehicleCounts = {};
  vehicles.forEach(({ language }) => {
    const key = language && language.trim() ? language.trim() : 'Not set';
    vehicleCounts[key] = (vehicleCounts[key] || 0) + 1;
  });
  const byVehicle = Object.entries(vehicleCounts)
    .map(([vehicle, count]) => ({ vehicle, count }))
    .sort((a, b) => b.count - a.count);

  // Account breakdown — capped to the top 15 so one very active customer's history
  // doesn't turn this into an endless scroll.
  const accounts = db.prepare(`SELECT account_name FROM jobs WHERE 1=1 ${dateFilter}`).all(...dateParams);
  const accountCounts = {};
  accounts.forEach(({ account_name }) => {
    const key = account_name && account_name.trim() ? account_name.trim() : 'No account';
    accountCounts[key] = (accountCounts[key] || 0) + 1;
  });
  const byAccount = Object.entries(accountCounts)
    .map(([account, count]) => ({ account, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 15);

  res.json({ completedPerWeek, perTechnician: perTech, unassignedCount, byState, byVehicle, byAccount });
});

module.exports = router;

const express = require('express');
const { db } = require('../db');
const { authRequired } = require('../auth');
const { detectState } = require('../calendar');

const router = express.Router();
router.use(authRequired);

router.get('/summary', (req, res) => {
  const rows = db.prepare(`
    SELECT resolved_at FROM jobs WHERE resolved_at IS NOT NULL AND resolved_at >= datetime('now', '-56 days')
  `).all();

  const weekBuckets = {};
  for (let i = 7; i >= 0; i--) {
    const weekStart = new Date();
    weekStart.setDate(weekStart.getDate() - i * 7);
    const key = weekStart.toISOString().slice(0, 10);
    weekBuckets[key] = 0;
  }
  const weekKeys = Object.keys(weekBuckets).sort();

  rows.forEach((r) => {
    const d = new Date(r.resolved_at.replace(' ', 'T') + 'Z');
    for (let i = weekKeys.length - 1; i >= 0; i--) {
      if (d >= new Date(weekKeys[i])) {
        weekBuckets[weekKeys[i]] += 1;
        break;
      }
    }
  });

  const completedPerWeek = weekKeys.map((k) => ({ weekStart: k, count: weekBuckets[k] }));

  const resolvedJobs = db.prepare(`
    SELECT created_at, resolved_at FROM jobs WHERE resolved_at IS NOT NULL
  `).all();
  let avgResolutionHours = null;
  if (resolvedJobs.length > 0) {
    const totalHours = resolvedJobs.reduce((sum, j) => {
      const created = new Date(j.created_at.replace(' ', 'T') + 'Z');
      const resolved = new Date(j.resolved_at.replace(' ', 'T') + 'Z');
      return sum + (resolved - created) / (1000 * 60 * 60);
    }, 0);
    avgResolutionHours = totalHours / resolvedJobs.length;
  }

  const perTech = db.prepare(`
    SELECT u.name as name, COUNT(j.id) as total,
      SUM(CASE WHEN j.status IN ('Resolved','Closed') THEN 1 ELSE 0 END) as completed
    FROM jobs j
    JOIN users u ON u.id = j.owner_id
    GROUP BY j.owner_id
    ORDER BY total DESC
  `).all();

  const unassignedCount = db.prepare("SELECT COUNT(*) as c FROM jobs WHERE owner_id IS NULL").get().c;

  // State breakdown — reuses the same address-parsing logic as the calendar sync,
  // so a job counted as "NSW" here is the same job that got the NSW calendar category.
  const addresses = db.prepare('SELECT site_address FROM jobs').all();
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
  const vehicles = db.prepare('SELECT language FROM jobs').all();
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
  const accounts = db.prepare('SELECT account_name FROM jobs').all();
  const accountCounts = {};
  accounts.forEach(({ account_name }) => {
    const key = account_name && account_name.trim() ? account_name.trim() : 'No account';
    accountCounts[key] = (accountCounts[key] || 0) + 1;
  });
  const byAccount = Object.entries(accountCounts)
    .map(([account, count]) => ({ account, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 15);

  res.json({ completedPerWeek, avgResolutionHours, perTechnician: perTech, unassignedCount, byState, byVehicle, byAccount });
});

module.exports = router;

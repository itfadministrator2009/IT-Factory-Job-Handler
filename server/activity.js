// Activity log: who did what, and when. Written alongside the actions that matter
// (logins, user and access changes, timesheet approvals, log-outs, backups and
// restores) and shown to admins in Settings → Activity log. Logging never gets in
// the way: if a write fails, the action itself still goes ahead.
const { db } = require('./db');

const KEEP_DAYS = 730; // two years

// Readable labels for the page; the codes are what's stored.
const ACTIONS = {
  'auth.login': 'Logged in',
  'auth.login_failed': 'Failed to log in',
  'auth.code_sent': 'Was emailed a login code',
  'auth.code_failed': 'Entered a wrong login code',
  'auth.password_reset_requested': 'Asked for a password reset',
  'auth.password_reset': 'Reset their password',
  'user.created': 'Added a user',
  'user.updated': 'Changed a user',
  'user.deleted': 'Removed a user',
  'user.password_set': 'Set a user’s password',
  'user.logged_out': 'Logged a user out',
  'user.logged_out_all': 'Logged everyone out',
  'timecard.submitted': 'Sent a timesheet',
  'timecard.approved': 'Approved a timesheet',
  'timecard.declined': 'Declined a timesheet',
  'backup.started': 'Started a backup',
  'backup.failed': 'Backup failed',
  'backup.restored': 'Restored a full backup',
  'records.restored': 'Restored records',
  'settings.changed': 'Changed security settings',
};

function clientIp(req) {
  return (req && (req.ip || req.headers?.['x-forwarded-for'] || req.socket?.remoteAddress)) || null;
}

// who: { id, name } of the person acting (or null for the system / unknown).
function logActivity(action, { req, who, target, details } = {}) {
  try {
    let user = who;
    if (!user && req?.user?.id) {
      user = db.prepare('SELECT id, name FROM users WHERE id = ?').get(req.user.id) || { id: req.user.id, name: req.user.name };
    }
    db.prepare(`INSERT INTO activity_log (user_id, user_name, ip, action, target_type, target_id, target_name, details)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      user?.id || null, user?.name || null, clientIp(req), action,
      target?.type || null, target?.id != null ? String(target.id) : null, target?.name || null,
      details == null ? null : (typeof details === 'string' ? details : JSON.stringify(details)).slice(0, 2000),
    );
  } catch (err) {
    console.error('[activity] Could not record', action, err.message);
  }
}

function pruneActivity() {
  try {
    const n = db.prepare(`DELETE FROM activity_log WHERE at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?)`).run(`-${KEEP_DAYS} days`).changes;
    if (n) console.log(`[activity] Removed ${n} entr${n === 1 ? 'y' : 'ies'} older than ${KEEP_DAYS} days.`);
  } catch (err) { console.error('[activity] Prune failed:', err.message); }
}

// Newest first, with optional search / filters, 100 at a time.
function listActivity({ q, category, userId, from, to, before, limit = 100 } = {}) {
  const where = []; const args = [];
  if (q) {
    where.push('(user_name LIKE ? OR target_name LIKE ? OR details LIKE ? OR action LIKE ? OR ip LIKE ?)');
    const like = `%${String(q).trim()}%`; args.push(like, like, like, like, like);
  }
  if (category) { where.push('action LIKE ?'); args.push(`${category}.%`); }
  if (userId) { where.push('user_id = ?'); args.push(userId); }
  if (from) { where.push('at >= ?'); args.push(`${from}T00:00:00`); }
  if (to) { where.push('at <= ?'); args.push(`${to}T23:59:59.999Z`); }
  if (before) { where.push('id < ?'); args.push(Number(before)); }
  const n = Math.max(1, Math.min(500, Number(limit) || 100));
  const rows = db.prepare(`SELECT * FROM activity_log ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`).all(...args, n + 1);
  return {
    entries: rows.slice(0, n).map((r) => ({
      id: r.id, at: r.at, userId: r.user_id, userName: r.user_name, ip: r.ip,
      action: r.action, label: ACTIONS[r.action] || r.action,
      targetType: r.target_type, targetId: r.target_id, targetName: r.target_name, details: r.details,
    })),
    more: rows.length > n,
  };
}

module.exports = { logActivity, listActivity, pruneActivity, ACTIONS };

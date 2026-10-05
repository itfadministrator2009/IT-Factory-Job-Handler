const { db } = require('./db');

// Regular Users are restricted to jobs assigned to them. Admins (and the legacy
// 'agent' role every pre-existing account has) see and act on everything, matching
// the oversight they already have everywhere else in the app.
function isAdminRole(role) {
  return role === 'admin' || role === 'agent';
}

// True if this user is allowed to view/act on this job. `job` needs at least an
// `owner_id` field — callers typically already have the full job row from a query.
// Looks up the requester's role fresh from the database (not the JWT's embedded
// role) so a role change takes effect immediately rather than waiting for their
// token to expire — important since this is a real access-control boundary now,
// not just a display filter.
function canAccessJob(user, job) {
  if (!job) return false;
  if (isAdminRole(currentRole(user.id))) return true;
  return job.owner_id === user.id;
}

// Looks up the current role fresh from the database rather than trusting the JWT's
// embedded role, so a role change (e.g. promoted to Admin) takes effect immediately
// instead of waiting for the user's token to expire and be reissued.
function currentRole(userId) {
  return db.prepare('SELECT role FROM users WHERE id = ?').get(userId)?.role || 'user';
}

// ITF Asset Tracker ('assets') and ITF Storage Centre ('storage') can be switched
// on or off per user in Settings. Admins always have both. Read fresh from the
// database so a change applies on the user's very next request.
const MODULE_COLUMNS = { assets: 'access_assets', storage: 'access_storage' };
const MODULE_NAMES = { assets: 'the ITF Asset Tracker', storage: 'the ITF Storage Centre' };
function hasModuleAccess(userId, module) {
  const row = db.prepare('SELECT role, access_assets, access_storage FROM users WHERE id = ?').get(userId);
  if (!row) return false;
  if (isAdminRole(row.role)) return true;
  return row[MODULE_COLUMNS[module]] !== 0;
}
function requireModule(module) {
  return (req, res, next) => {
    if (hasModuleAccess(req.user.id, module)) return next();
    res.status(403).json({ error: `You don't have access to ${MODULE_NAMES[module]}. Ask an admin to turn it on in Settings.`, code: 'no_module_access' });
  };
}
// The signed-in user as the client sees it, including which sections they can use.
function publicUser(row) {
  if (!row) return null;
  const admin = isAdminRole(row.role);
  return {
    id: row.id, name: row.name, email: row.email, role: row.role,
    accessAssets: admin || row.access_assets !== 0,
    accessStorage: admin || row.access_storage !== 0,
  };
}

module.exports = { isAdminRole, canAccessJob, currentRole, hasModuleAccess, requireModule, publicUser };

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

module.exports = { isAdminRole, canAccessJob, currentRole };

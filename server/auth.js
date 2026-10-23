const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';

function signToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, role: user.role, name: user.name, sv: user.session_version || 0 },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
}

// What a contractor login can reach: their timesheets, their own account, and "online now".
const CONTRACTOR_PATHS = /^\/api\/(timecard|auth|presence)(\/|\?|$)/;

function authRequired(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header' });
  }
  const token = header.slice('Bearer '.length);
  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET);
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
  // Storage Centre client-portal tokens are signed with the same secret but are
  // NOT staff logins — they must never open a staff endpoint.
  if (payload && payload.kind === 'storage_client') {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
  // Logged out by an admin: a sign-in from before that no longer works.
  let row = null;
  try {
    row = require('./db').db.prepare('SELECT session_version, role FROM users WHERE id = ?').get(payload.id);
    if (row && (row.session_version || 0) !== (payload.sv || 0)) {
      return res.status(401).json({ error: 'You were logged out by an admin. Please log in again.', code: 'signed_out' });
    }
  } catch (err) { /* column not there yet: carry on */ }
  // Contractors only use ITF Time Card — nothing else in Work Desk.
  if (row && row.role === 'contractor' && !CONTRACTOR_PATHS.test(req.originalUrl || '')) {
    return res.status(403).json({ error: 'Contractor accounts can only use ITF Time Card.', code: 'contractor_only' });
  }
  req.user = payload;
  next();
}

// Storage Centre client portal: a separate token type for storage clients (rows in
// storage_clients, not staff users). Short-lived and scoped to one client.
function signStorageClientToken(client) {
  return jwt.sign(
    { kind: 'storage_client', clientId: client.id, clientName: client.client_name, username: client.username },
    JWT_SECRET,
    { expiresIn: '12h' }
  );
}

function storageClientRequired(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Please sign in' });
  }
  try {
    const payload = jwt.verify(header.slice('Bearer '.length), JWT_SECRET);
    if (payload.kind !== 'storage_client') throw new Error('wrong token type');
    req.storageClient = payload;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Your session has expired — please sign in again' });
  }
}

module.exports = { signToken, authRequired, signStorageClientToken, storageClientRequired, JWT_SECRET };

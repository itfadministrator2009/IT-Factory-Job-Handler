const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';

function signToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, role: user.role, name: user.name },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
}

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

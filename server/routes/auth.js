const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { v4: uuid } = require('uuid');
const { db } = require('../db');
const { publicUser } = require('../permissions');
const { signToken, authRequired } = require('../auth');
const { sendPasswordReset } = require('../email');
const { logActivity } = require('../activity');
const twoStep = require('../twoStep');

const router = express.Router();

const MIN_PASSWORD_LENGTH = 8;

// Rate limits protect against brute-forcing a password and against someone spamming
// registrations or reset emails. Keyed by IP; standard headers so a well-behaved
// client can see how many attempts it has left.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Please try again in a few minutes.' },
});
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many accounts created from this network. Please try again later.' },
});
const forgotPasswordLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 6,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many reset requests. Please try again later.' },
});
const resetPasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please try again in a few minutes.' },
});

router.post('/register', registerLimiter, (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) {
    return res.status(400).json({ error: 'name, email, and password are required' });
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` });
  }

  // The very first person to register becomes Admin automatically — there needs to be
  // at least one admin to manage everyone else. Everyone after that starts as a
  // regular User; an admin can promote them later from Settings → Users.
  const userCount = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
  const role = userCount === 0 ? 'admin' : 'user';

  const id = uuid();
  const password_hash = bcrypt.hashSync(password, 10);
  db.prepare(
    'INSERT INTO users (id, name, email, password_hash, role) VALUES (?, ?, ?, ?, ?)'
  ).run(id, name, email, password_hash, role);

  const user = { id, name, email, role };
  res.status(201).json({ token: signToken(user), user: publicUser({ ...user, access_assets: 1, access_storage: 1 }) });
});

// Two-step login codes: stricter limit, as each wrong guess counts.
const codeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please try again in a few minutes.' },
});

router.post('/login', loginLimiter, async (req, res) => {
  const { email, password, deviceToken } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'email and password are required' });

  // Email is no longer unique — multiple techs can share one inbox. Check every
  // account with this email and log in as whichever one's password actually matches.
  // Email matching ignores capitals and stray spaces.
  const candidates = db.prepare('SELECT * FROM users WHERE lower(email) = lower(?)').all(String(email).trim());
  let user = candidates.find((u) => bcrypt.compareSync(password, u.password_hash));
  // Contractors brought across from the old Time Card app: their old password
  // works once, then becomes their Work Desk password.
  if (!user) {
    user = candidates.find((u) => u.legacy_pw_hash && u.legacy_pw_salt
      && crypto.createHash('sha256').update(u.legacy_pw_salt + password, 'utf8').digest('hex') === String(u.legacy_pw_hash).toLowerCase());
    if (user) {
      db.prepare('UPDATE users SET password_hash = ?, legacy_pw_hash = NULL, legacy_pw_salt = NULL WHERE id = ?').run(bcrypt.hashSync(password, 10), user.id);
    }
  }
  if (!user) {
    logActivity('auth.login_failed', { req, details: `Email: ${String(email).trim().slice(0, 120)}` });
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  // Admins: emailed code first, unless this device is remembered.
  if (twoStep.needsTwoStep(user, deviceToken)) {
    try {
      const challenge = await twoStep.startChallenge(user);
      logActivity('auth.code_sent', { req, who: user });
      return res.json({ twoStep: true, ...challenge });
    } catch (err) {
      console.error('[2fa] Could not send code:', err.message);
      return res.status(502).json({ error: 'Could not email your login code. Try again in a minute.' });
    }
  }
  logActivity('auth.login', { req, who: user });
  res.json({ token: signToken(user), user: publicUser(user) });
});

// Second step: the emailed code. "remember" trusts this browser for 30 days.
router.post('/login/verify', codeLimiter, (req, res) => {
  const { challengeId, code, remember, deviceLabel } = req.body || {};
  const out = twoStep.verifyChallenge(challengeId, code);
  if (!out.ok) {
    if (out.userId) logActivity('auth.code_failed', { req, who: db.prepare('SELECT id, name FROM users WHERE id = ?').get(out.userId), details: out.error });
    return res.status(out.status).json({ error: out.error, expired: !!out.expired });
  }
  const deviceToken = remember ? twoStep.rememberDevice(out.user.id, deviceLabel || req.headers['user-agent']) : undefined;
  logActivity('auth.login', { req, who: out.user, details: remember ? 'With login code (remembered this device for 30 days)' : 'With login code' });
  res.json({ token: signToken(out.user), user: publicUser(out.user), deviceToken });
});

// The signed-in admin's remembered devices (Settings → Security & alerts).
router.get('/devices', authRequired, (req, res) => {
  res.json({ devices: twoStep.listDevices(req.user.id), twoStepOn: twoStep.twoStepEnabled() });
});
router.delete('/devices', authRequired, (req, res) => {
  res.json({ forgotten: twoStep.forgetDevices(req.user.id) });
});

// The current user fresh from the database, so role or access changes made in
// Settings show up without signing out and back in.
router.get('/me', authRequired, (req, res) => {
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!row) return res.status(401).json({ error: 'Account not found' });
  res.json({ user: publicUser(row) });
});

router.post('/forgot-password', forgotPasswordLimiter, (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'email is required' });

  const user = db.prepare('SELECT * FROM users WHERE lower(email) = lower(?)').get(String(email).trim());
  if (user) {
    const token = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    db.prepare('UPDATE users SET reset_token = ?, reset_token_expires = ? WHERE id = ?').run(token, expires, user.id);

    const base = process.env.FRONTEND_URL || 'http://localhost:5173';
    sendPasswordReset({ toEmail: user.email, resetUrl: `${base}/reset-password?token=${token}` });
    logActivity('auth.password_reset_requested', { req, who: user });
  }
  res.json({ ok: true });
});

router.post('/reset-password', resetPasswordLimiter, (req, res) => {
  const { token, password } = req.body;
  if (!token || !password) return res.status(400).json({ error: 'token and password are required' });
  if (password.length < MIN_PASSWORD_LENGTH) {
    return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` });
  }

  const user = db.prepare('SELECT * FROM users WHERE reset_token = ?').get(token);
  if (!user || !user.reset_token_expires || new Date(user.reset_token_expires) < new Date()) {
    return res.status(400).json({ error: 'This reset link is invalid or has expired' });
  }

  const password_hash = bcrypt.hashSync(password, 10);
  db.prepare('UPDATE users SET password_hash = ?, reset_token = NULL, reset_token_expires = NULL, legacy_pw_hash = NULL, legacy_pw_salt = NULL WHERE id = ?').run(password_hash, user.id);
  // A new password means remembered devices need the code again.
  twoStep.forgetDevices(user.id);
  logActivity('auth.password_reset', { req, who: user });
  res.json({ ok: true });
});

module.exports = router;

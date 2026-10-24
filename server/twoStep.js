// Two-step login for admins: after the right password, an admin is emailed a
// 6-digit code that's good for 10 minutes and 5 tries. They can tick "Remember this
// device" to skip the code on that browser for 30 days.
//
// On unless switched off in Settings → Security & alerts, or with ADMIN_2FA=off on
// Render (the emergency switch if email ever stops working). It's skipped when the
// server has no way to send email (local development).
const crypto = require('crypto');
const { v4: uuid } = require('uuid');
const { db } = require('./db');
const { getSetting } = require('./appSettings');
const { isAdminRole } = require('./permissions');

const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const DEVICE_DAYS = 30;
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

function emailConfigured() {
  try {
    const { hasSmtp } = require('./email');
    const { configured } = require('./calendar');
    return !!(configured || hasSmtp);
  } catch (e) { return false; }
}

function twoStepEnabled() {
  if (/^(off|false|0|no)$/i.test(process.env.ADMIN_2FA || '')) return false;
  if (/^(on|true|1|yes)$/i.test(process.env.ADMIN_2FA || '')) return true;
  return getSetting('admin_2fa', 'on') !== 'off' && emailConfigured();
}

function needsTwoStep(user, deviceToken) {
  if (!user || !isAdminRole(user.role) || !twoStepEnabled()) return false;
  return !trustedDevice(user.id, deviceToken);
}

function trustedDevice(userId, token) {
  if (!token) return false;
  const row = db.prepare('SELECT id, expires_at FROM trusted_devices WHERE user_id = ? AND token_hash = ?').get(userId, sha(token));
  if (!row || row.expires_at < Date.now()) return false;
  db.prepare("UPDATE trusted_devices SET last_used_at = datetime('now') WHERE id = ?").run(row.id);
  return true;
}

function maskEmail(email) {
  const [name, domain] = String(email || '').split('@');
  if (!domain) return email || '';
  return `${name.slice(0, 2)}${'•'.repeat(Math.max(1, Math.min(6, name.length - 2)))}@${domain}`;
}

// Starts a challenge and emails the code. Returns what the login page needs.
async function startChallenge(user) {
  db.prepare('DELETE FROM login_challenges WHERE user_id = ? OR expires_at < ?').run(user.id, Date.now());
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const id = uuid();
  db.prepare('INSERT INTO login_challenges (id, user_id, code_hash, expires_at) VALUES (?, ?, ?, ?)')
    .run(id, user.id, sha(`${id}:${code}`), Date.now() + CODE_TTL_MS);
  const { sendMail } = require('./email');
  await sendMail({
    to: user.email,
    subject: `Your Work Desk login code: ${code}`,
    text: `Your Work Desk login code is ${code}\n\nIt expires in 10 minutes. If you didn't just try to log in, change your password — someone may know it.`,
    html: `<div style="font-family:Arial,Helvetica,sans-serif;color:#16241f;max-width:480px">
      <p style="font-size:14px">Your Work Desk login code is</p>
      <p style="font-size:32px;font-weight:bold;letter-spacing:6px;margin:8px 0 16px;color:#155e6b">${code}</p>
      <p style="font-size:13px;color:#6b7570">It expires in 10 minutes. If you didn't just try to log in, change your password — someone may know it.</p></div>`,
  });
  if (!emailConfigured()) console.log(`[2fa:dev] Code for ${user.email}: ${code}`);
  return { challengeId: id, sentTo: maskEmail(user.email), expiresInMinutes: CODE_TTL_MS / 60000 };
}

// Checks a code. Returns { ok, user } or { ok: false, error, status }.
function verifyChallenge(challengeId, code) {
  const ch = db.prepare('SELECT * FROM login_challenges WHERE id = ?').get(String(challengeId || ''));
  if (!ch || ch.expires_at < Date.now()) return { ok: false, status: 400, error: 'That code has expired. Log in again to get a new one.', expired: true };
  if (ch.attempts >= MAX_ATTEMPTS) return { ok: false, userId: ch.user_id, status: 429, error: 'Too many wrong codes. Log in again to get a new one.', expired: true };
  const clean = String(code || '').replace(/\D/g, '');
  const good = clean.length === 6 && crypto.timingSafeEqual(Buffer.from(sha(`${ch.id}:${clean}`)), Buffer.from(ch.code_hash));
  if (!good) {
    db.prepare('UPDATE login_challenges SET attempts = attempts + 1 WHERE id = ?').run(ch.id);
    const left = MAX_ATTEMPTS - ch.attempts - 1;
    return { ok: false, userId: ch.user_id, status: 400, error: left > 0 ? `That code isn't right. ${left} ${left === 1 ? 'try' : 'tries'} left.` : 'Too many wrong codes. Log in again to get a new one.', expired: left <= 0 };
  }
  db.prepare('DELETE FROM login_challenges WHERE id = ?').run(ch.id);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(ch.user_id);
  if (!user) return { ok: false, status: 400, error: 'Account not found.' };
  return { ok: true, user };
}

function rememberDevice(userId, label) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO trusted_devices (id, user_id, token_hash, label, expires_at) VALUES (?, ?, ?, ?, ?)')
    .run(uuid(), userId, sha(token), String(label || '').slice(0, 120) || null, Date.now() + DEVICE_DAYS * 86400000);
  return token;
}

function listDevices(userId) {
  return db.prepare('SELECT id, label, created_at, last_used_at, expires_at FROM trusted_devices WHERE user_id = ? AND expires_at > ? ORDER BY created_at DESC')
    .all(userId, Date.now()).map((d) => ({ id: d.id, label: d.label, createdAt: d.created_at, lastUsedAt: d.last_used_at, expiresAt: new Date(d.expires_at).toISOString() }));
}
function forgetDevices(userId) {
  return db.prepare('DELETE FROM trusted_devices WHERE user_id = ?').run(userId).changes;
}

module.exports = { twoStepEnabled, emailConfigured, needsTwoStep, startChallenge, verifyChallenge, rememberDevice, listDevices, forgetDevices, maskEmail };

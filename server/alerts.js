// Error alerts: email the people listed in Settings → Security & alerts when
// something goes wrong on the server — a request that fails with a server error,
// a failed backup, or a background job (reminders, weekly invoicing) that breaks.
//
// Throttled so a burst of the same problem sends one email, not hundreds: each kind
// of problem alerts at most once every 30 minutes, and no more than 20 a day overall.
const { db } = require('./db');
const { getSetting } = require('./appSettings');

const THROTTLE_MS = 30 * 60 * 1000;
const DAILY_MAX = 20;
const lastSent = new Map();
let day = ''; let sentToday = 0;

// Who gets alerts: the list in Settings, else ALERT_EMAILS, else every admin.
function alertRecipients() {
  const listed = (getSetting('alert_emails') || process.env.ALERT_EMAILS || '')
    .split(/[,;\s]+/).map((s) => s.trim()).filter((s) => /\S+@\S+/.test(s));
  if (listed.length) return [...new Set(listed.map((e) => e.toLowerCase()))];
  return [...new Set(db.prepare("SELECT email FROM users WHERE role IN ('admin','agent') AND email IS NOT NULL AND email != ''").all()
    .map((r) => r.email.trim().toLowerCase()))];
}

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// key groups repeats of the same problem (e.g. "500 POST /api/jobs").
async function sendAlert(key, subject, details = '', { force = false } = {}) {
  if (getSetting('alerts_enabled', 'on') === 'off' && !force) return { sent: false, reason: 'off' };
  const now = Date.now();
  const today = new Date().toISOString().slice(0, 10);
  if (today !== day) { day = today; sentToday = 0; }
  if (!force) {
    if (now - (lastSent.get(key) || 0) < THROTTLE_MS) return { sent: false, reason: 'throttled' };
    if (sentToday >= DAILY_MAX) return { sent: false, reason: 'daily_limit' };
  }
  const to = alertRecipients();
  if (!to.length) return { sent: false, reason: 'no_recipients' };
  lastSent.set(key, now); sentToday += 1;
  const when = new Date().toLocaleString('en-AU', { timeZone: process.env.BACKUP_TIMEZONE || 'Australia/Sydney' });
  try {
    const { sendMail } = require('./email');
    await sendMail({
      to: to.join(','),
      subject: `Work Desk alert: ${subject}`,
      text: `${subject}\n\nWhen: ${when} (Sydney)\n\n${details}\n\nYou get this because you're listed for Work Desk alerts (Settings → Security & alerts). Repeats of the same problem are held back for 30 minutes.`,
      html: `<div style="font-family:Arial,Helvetica,sans-serif;color:#16241f;max-width:600px">
        <div style="background:#b23a2e;color:#fff;padding:12px 16px;border-radius:8px 8px 0 0;font-weight:bold">Work Desk alert</div>
        <div style="border:1px solid #e2e0d8;border-top:none;padding:16px;border-radius:0 0 8px 8px">
          <p style="font-size:15px;margin:0 0 10px"><b>${esc(subject)}</b></p>
          <p style="font-size:13px;color:#6b7570;margin:0 0 12px">${esc(when)} (Sydney)</p>
          ${details ? `<pre style="white-space:pre-wrap;font-size:12px;background:#f6f5f1;padding:10px;border-radius:6px;margin:0 0 12px">${esc(details)}</pre>` : ''}
          <p style="font-size:12px;color:#6b7570;margin:0">You get this because you're listed for Work Desk alerts (Settings → Security &amp; alerts). Repeats of the same problem are held back for 30 minutes.</p>
        </div></div>`,
    });
    return { sent: true, to };
  } catch (err) {
    console.error('[alerts] Could not send alert:', err.message);
    return { sent: false, reason: 'send_failed' };
  }
}

// Express middleware: alert on any response that ends with a server error (5xx),
// whichever route produced it.
function alertOnServerErrors(req, res, next) {
  res.on('finish', () => {
    if (res.statusCode < 500) return;
    const route = (req.baseUrl || '') + (req.route?.path || req.path || '');
    const key = `${res.statusCode} ${req.method} ${route}`;
    const err = res.locals?.alertError;
    sendAlert(key, `Server error on ${req.method} ${req.originalUrl.split('?')[0]}`,
      `Status ${res.statusCode}\nRoute: ${req.method} ${route}\nUser: ${req.user?.name || 'not signed in'}${err ? `\n\n${err.stack || err.message || err}` : ''}`).catch(() => {});
  });
  next();
}

// Final Express error handler: keeps a friendly reply and records the error for the alert.
function errorHandler(err, req, res, next) { // eslint-disable-line no-unused-vars
  console.error('[server] Unhandled error:', err);
  res.locals.alertError = err;
  if (res.headersSent) return;
  res.status(err.status && err.status < 500 ? err.status : 500).json({ error: err.status && err.status < 500 ? err.message : 'Something went wrong — please try again.' });
}

function _resetThrottle() { lastSent.clear(); sentToday = 0; }

module.exports = { sendAlert, alertRecipients, alertOnServerErrors, errorHandler, _resetThrottle };

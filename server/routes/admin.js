// Admin-only: the activity log and Settings → Security & alerts.
const express = require('express');
const { db } = require('../db');
const { authRequired } = require('../auth');
const { superAdminRequired } = require('../permissions');
const { listActivity, logActivity, ACTIONS } = require('../activity');
const { getSetting, setSetting } = require('../appSettings');
const { sendAlert, alertRecipients } = require('../alerts');
const twoStep = require('../twoStep');

const router = express.Router();
router.use(authRequired);
// Activity log and Security & alerts: the Super Admin only.
router.use(superAdminRequired);

const YMD = /^\d{4}-\d{2}-\d{2}$/;

router.get('/activity', (req, res) => {
  const { q, category, userId, from, to, before, limit } = req.query;
  res.json({
    ...listActivity({
      q: q ? String(q).slice(0, 100) : undefined,
      category: /^[a-z]+$/.test(category || '') ? category : undefined,
      userId: userId || undefined,
      from: YMD.test(from || '') ? from : undefined,
      to: YMD.test(to || '') ? to : undefined,
      before: before || undefined,
      limit: limit || undefined,
    }),
    people: db.prepare('SELECT DISTINCT user_id AS id, user_name AS name FROM activity_log WHERE user_id IS NOT NULL ORDER BY user_name COLLATE NOCASE').all(),
    actions: ACTIONS,
  });
});

function securityState(userId) {
  const envSwitch = (process.env.ADMIN_2FA || '').trim().toLowerCase();
  return {
    twoStep: {
      setting: getSetting('admin_2fa', 'on'),
      active: twoStep.twoStepEnabled(),
      emailConfigured: twoStep.emailConfigured(),
      envOverride: envSwitch || null,
    },
    myDevices: twoStep.listDevices(userId),
    alerts: {
      enabled: getSetting('alerts_enabled', 'on') !== 'off',
      emails: getSetting('alert_emails') || '',
      envEmails: process.env.ALERT_EMAILS || '',
      recipients: alertRecipients(),
    },
    healthUrl: '/api/health',
  };
}

router.get('/security', (req, res) => res.json(securityState(req.user.id)));

router.patch('/security', (req, res) => {
  const { twoStep: tsOn, alertsEnabled, alertEmails } = req.body || {};
  const changes = [];
  if (tsOn !== undefined) {
    setSetting('admin_2fa', tsOn ? 'on' : 'off');
    changes.push(`Two-step login for admins: ${tsOn ? 'on' : 'off'}`);
  }
  if (alertsEnabled !== undefined) {
    setSetting('alerts_enabled', alertsEnabled ? 'on' : 'off');
    changes.push(`Error alerts: ${alertsEnabled ? 'on' : 'off'}`);
  }
  if (alertEmails !== undefined) {
    const list = String(alertEmails || '').split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean);
    const bad = list.filter((e) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e));
    if (bad.length) return res.status(400).json({ error: `Not an email address: ${bad.join(', ')}` });
    setSetting('alert_emails', list.join(', '));
    changes.push(`Alert emails: ${list.length ? list.join(', ') : 'all admins'}`);
  }
  if (changes.length) logActivity('settings.changed', { req, details: changes.join('; ') });
  res.json(securityState(req.user.id));
});

router.post('/security/test-alert', async (req, res) => {
  const r = await sendAlert('test', 'Test alert', `${req.user.name || 'An admin'} sent this from Settings → Security & alerts to check alerts reach you. Nothing is wrong.`, { force: true });
  if (!r.sent) {
    const why = { no_recipients: 'There is nobody to send it to — add an alert email.', send_failed: 'The email could not be sent — check the Microsoft 365 / SMTP email setup.' };
    return res.status(400).json({ error: why[r.reason] || 'Could not send the test alert.' });
  }
  res.json({ sent: true, to: r.to });
});

module.exports = router;

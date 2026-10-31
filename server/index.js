require('dotenv').config();
const express = require('express');
const { db } = require('./db');
const cors = require('cors');

const authRoutes = require('./routes/auth');
const jobRoutes = require('./routes/jobs');
const userRoutes = require('./routes/users');
const articleRoutes = require('./routes/articles');
const inboundRoutes = require('./routes/inbound');
const attachmentRoutes = require('./routes/attachments');
const pdfRoutes = require('./routes/pdf');
const templateRoutes = require('./routes/templates');
const reportRoutes = require('./routes/reports');
const backupRoutes = require('./routes/backup');
const projectRoutes = require('./routes/projects');
const assetRoutes = require('./routes/assets');
const storageRoutes = require('./routes/storage');
const storagePortalRoutes = require('./routes/storagePortal');
const presenceRoutes = require('./routes/presence');
const recordRestoreRoutes = require('./routes/recordRestore');
const timecardRoutes = require('./routes/timecard');
const adminRoutes = require('./routes/admin');
const { alertOnServerErrors, errorHandler, sendAlert } = require('./alerts');
const { pruneActivity, logActivity } = require('./activity');
const { startBackupScheduler } = require('./backup');
const { startStorageWeeklyScheduler } = require('./storageWeekly');
const { startSalesWeeklyScheduler } = require('./salesWeekly');
const { startShopifySync } = require('./salesShopify');
const { startTimecardReminderScheduler } = require('./timecardReminders');
const { startDiskAlertScheduler } = require('./diskAlert');
const { startFileSync } = require('./fileStore');

const app = express();
// Render sits in front of the app as a reverse proxy, adding an X-Forwarded-For
// header. Without this, express-rate-limit can't correctly identify individual
// users by IP behind that proxy (and logs a validation warning on every request).
app.set('trust proxy', 1);

// Set FRONTEND_URL in production to lock this down to your actual frontend domain.
const allowedOrigin = process.env.FRONTEND_URL;
app.use(cors(allowedOrigin ? { origin: allowedOrigin } : {}));
// Raised from Express's 100kb default: a Projects entry can carry two embedded
// signature images (tech + site contact) plus every other field in one autosave
// PATCH, which a couple of signatures alone can push past the default limit.
app.use(express.json({ limit: '15mb' }));

// Alert admins by email when any request fails with a server error.
app.use(alertOnServerErrors);
// Note every successful change, for the refresh button's "New changes".
app.use(require('./changeTracker').trackChanges);

// Uptime checks (e.g. UptimeRobot) call this. It also proves the database answers,
// so a broken database shows as "down", not just a stopped server.
app.get('/api/health', (req, res) => {
  try {
    db.prepare('SELECT 1').get();
    res.json({ ok: true });
  } catch (err) {
    res.locals.alertError = err;
    res.status(503).json({ ok: false, error: 'Database not responding' });
  }
});
app.use('/api/auth', authRoutes);
app.use('/api/jobs', jobRoutes);
app.use('/api/users', userRoutes);
app.use('/api/articles', articleRoutes);
app.use('/api/inbound', inboundRoutes);
app.use('/api', attachmentRoutes);
app.use('/api/jobs', pdfRoutes);
app.use('/api/templates', templateRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/backup', backupRoutes);
app.use('/api/projects', projectRoutes);
app.use('/api/assets', assetRoutes);
app.use('/api/storage', storageRoutes);
// ITF Sales Manager — sales, inventory and Shopify orders (moved from Google Sheets).
app.use('/api/sales', require('./routes/sales'));
// Client-facing Storage Centre portal — its own login, separate from staff accounts.
app.use('/api/storage-portal', storagePortalRoutes);
app.use('/api/presence', presenceRoutes);
// Admin: restore single records (a job, an asset, a storage item…) from a backup.
app.use('/api/record-restore', recordRestoreRoutes);
// ITF Time Card — contractor timesheets, approved by Work Desk admins.
app.use('/api/timecard', timecardRoutes);
// Admin: activity log, security & alert settings.
app.use('/api/admin', adminRoutes);
app.use(errorHandler);

const PORT = process.env.PORT || 4000;
if (!process.env.JWT_SECRET) {
  console.warn('WARNING: JWT_SECRET is not set — using an insecure default. Set it in .env before deploying.');
}

// A last-resort safety net: an unhandled promise rejection anywhere in the app
// (a background email, calendar sync, or backup that forgot a .catch) would otherwise
// crash the entire server in modern Node. Logging and continuing is much safer for a
// service that's meant to stay up — a single failed background task should never take
// down every in-flight request.
process.on('unhandledRejection', (err) => {
  console.error('Unhandled promise rejection (server continues running):', err);
  sendAlert(`rejection ${String(err?.message || err).slice(0, 80)}`, 'A background task failed', String(err?.stack || err)).catch(() => {});
});

// A full backup restore replaces the database (and its activity log), so the
// restore is noted in a file and written into the restored log on the next start.
try {
  const fs = require('fs');
  const { DB_PATH } = require('./backup');
  const notePath = `${DB_PATH}.restored.json`;
  if (fs.existsSync(notePath)) {
    const n = JSON.parse(fs.readFileSync(notePath, 'utf8'));
    logActivity('backup.restored', { who: n.who, req: { ip: n.ip }, target: { type: 'backup', id: n.backupId, name: n.backupName || n.backupId }, details: `Restored ${n.at}. Safety copy of the database before the restore: ${n.safety}` });
    fs.unlinkSync(notePath);
  }
} catch (err) { console.error('[activity] Could not record the restore:', err.message); }
pruneActivity();
setInterval(pruneActivity, 24 * 60 * 60 * 1000).unref();

// One-off tidy of values like "64984.0" brought across from the old Google Sheet.
try { require('./storageTools').cleanTrailingZeroIds(); } catch (err) { console.error('[storage] Could not tidy ".0" values:', err.message); }
startBackupScheduler();
startStorageWeeklyScheduler();
startSalesWeeklyScheduler();
startShopifySync();
setInterval(() => { try { require('./sales').pruneSalesActivity(); } catch (e) { /* next time */ } }, 24 * 60 * 60 * 1000).unref();
startTimecardReminderScheduler();
startDiskAlertScheduler();
startFileSync();
app.listen(PORT, () => console.log(`Job log API running on port ${PORT}`));

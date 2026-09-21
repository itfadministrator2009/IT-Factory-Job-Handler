require('dotenv').config();
const express = require('express');
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
const { startBackupScheduler } = require('./backup');

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

app.get('/api/health', (req, res) => res.json({ ok: true }));
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
});

startBackupScheduler();
app.listen(PORT, () => console.log(`Job log API running on port ${PORT}`));

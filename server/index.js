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

const app = express();

// Set FRONTEND_URL in production to lock this down to your actual frontend domain.
const allowedOrigin = process.env.FRONTEND_URL;
app.use(cors(allowedOrigin ? { origin: allowedOrigin } : {}));
app.use(express.json());

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

const PORT = process.env.PORT || 4000;
if (!process.env.JWT_SECRET) {
  console.warn('WARNING: JWT_SECRET is not set — using an insecure default. Set it in .env before deploying.');
}
app.listen(PORT, () => console.log(`Job log API running on port ${PORT}`));

const express = require('express');
const { db } = require('../db');
const { authRequired } = require('../auth');
const { streamJobSheet, buildJobSheetBuffer, loadJobData } = require('../pdfBuilder');
const { sendJobSheetEmail } = require('../email');
const { buildDataDestructionCertificate, cleanRows, todaySydney } = require('../dataCertPdf');
const { canAccessJob } = require('../permissions');

const router = express.Router();
router.use(authRequired);

router.get('/:id/pdf', async (req, res) => {
  const job = db.prepare('SELECT owner_id FROM jobs WHERE id = ?').get(req.params.id);
  if (!job || !canAccessJob(req.user, job)) return res.status(404).json({ error: 'Job not found' });
  const ok = await streamJobSheet(req.params.id, res);
  if (!ok) res.status(404).json({ error: 'Job not found' });
});

router.post('/:id/email-pdf', async (req, res) => {
  const data = loadJobData(req.params.id);
  if (!data || !canAccessJob(req.user, data.job)) return res.status(404).json({ error: 'Job not found' });
  if (!data.job.email) return res.status(400).json({ error: 'This job has no contact email on file' });

  try {
    const pdfBuffer = await buildJobSheetBuffer(req.params.id);
    await sendJobSheetEmail({
      toEmail: data.job.email,
      jobNumber: data.job.job_number,
      subject: data.job.subject,
      pdfBuffer,
    });
    res.json({ ok: true, sentTo: data.job.email });
  } catch (err) {
    res.status(500).json({ error: 'Could not generate or send the job sheet' });
  }
});

// Certificate of Data Destruction for this job. The browser reads the customer's
// spreadsheet and sends its rows (item, make, model, serial); the customer name
// defaults to the job's account name and the date of issue to today.
router.post('/:id/data-destruction-certificate', async (req, res) => {
  const job = db.prepare('SELECT id, owner_id, job_number, account_name, contact_name FROM jobs WHERE id = ?').get(req.params.id);
  if (!job || !canAccessJob(req.user, job)) return res.status(404).json({ error: 'Job not found' });
  const rows = cleanRows(req.body?.rows);
  if (!rows.length) return res.status(400).json({ error: 'No devices found in the spreadsheet' });
  if (rows.length > 5000) return res.status(400).json({ error: 'Up to 5,000 devices per certificate' });
  const customer = String(req.body?.customer || job.account_name || job.contact_name || '').trim().slice(0, 120);
  const issueDate = /^\d{4}-\d{2}-\d{2}$/.test(String(req.body?.issueDate || '')) ? req.body.issueDate : todaySydney();
  try {
    const pdf = await buildDataDestructionCertificate({ customer, jobNumber: job.job_number, issueDate, rows });
    const safe = (s) => String(s).replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '');
    const filename = `${job.job_number}_${safe(customer) || 'Customer'}_Certificate_of_Data_Destruction.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('X-Filename', filename);
    res.setHeader('Access-Control-Expose-Headers', 'X-Filename');
    res.send(pdf);
  } catch (err) {
    console.error('[pdf] data destruction certificate failed:', err);
    res.status(500).json({ error: 'Could not create the certificate' });
  }
});

module.exports = router;

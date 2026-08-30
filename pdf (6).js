const express = require('express');
const { authRequired } = require('../auth');
const { streamJobSheet, buildJobSheetBuffer, loadJobData } = require('../pdfBuilder');
const { sendJobSheetEmail } = require('../email');

const router = express.Router();
router.use(authRequired);

router.get('/:id/pdf', async (req, res) => {
  const ok = await streamJobSheet(req.params.id, res);
  if (!ok) res.status(404).json({ error: 'Job not found' });
});

router.post('/:id/email-pdf', async (req, res) => {
  const data = loadJobData(req.params.id);
  if (!data) return res.status(404).json({ error: 'Job not found' });
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

module.exports = router;

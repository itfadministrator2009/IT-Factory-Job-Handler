const express = require('express');
const { v4: uuid } = require('uuid');
const { db, nextJobNumber } = require('../db');
const { notifyTicketCreated } = require('../email');

const router = express.Router();

function verifyToken(req, res, next) {
  const expected = process.env.INBOUND_WEBHOOK_TOKEN;
  if (!expected) {
    return res.status(501).json({ error: 'INBOUND_WEBHOOK_TOKEN is not configured on the server' });
  }
  if (req.query.token !== expected) {
    return res.status(401).json({ error: 'Invalid webhook token' });
  }
  next();
}

router.post('/email', verifyToken, express.urlencoded({ extended: true }), express.json(), (req, res) => {
  const { from, subject, text } = req.body;
  if (!from || !subject) {
    return res.status(400).json({ error: 'from and subject are required' });
  }

  const match = String(from).match(/^(.*)<(.+)>$/);
  const fromEmail = (match ? match[2] : from).trim().toLowerCase();
  const fromName = match ? match[1].trim().replace(/"/g, '') : fromEmail.split('@')[0];

  const id = uuid();
  const jobNumber = nextJobNumber();
  db.prepare(`
    INSERT INTO jobs (id, job_number, contact_name, email, subject, description, channel)
    VALUES (?, ?, ?, ?, ?, ?, 'Email')
  `).run(id, jobNumber, fromName, fromEmail, subject, text || '');

  notifyTicketCreated({ toEmail: fromEmail, ticketNumber: jobNumber, subject });

  res.status(201).json({ ok: true, job_number: jobNumber });
});

module.exports = router;

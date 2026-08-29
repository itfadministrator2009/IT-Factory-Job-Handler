const nodemailer = require('nodemailer');

const hasSmtp = !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);

let transporter = null;
if (hasSmtp) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}

const FROM = process.env.FROM_EMAIL || 'helpdesk@example.com';

async function sendMail({ to, subject, text, attachments }) {
  if (!to) return;
  if (!transporter) {
    console.log(`[email:dev-mode] To: ${to} | Subject: ${subject}\n${text}\n${attachments ? `(${attachments.length} attachment(s))` : ''}`);
    return;
  }
  try {
    await transporter.sendMail({ from: FROM, to, subject, text, attachments });
  } catch (err) {
    console.error('Email send failed:', err.message);
  }
}

function notifyNewReply({ toEmail, ticketNumber, subject, authorName, body, isAgentReply }) {
  return sendMail({
    to: toEmail,
    subject: `[Ticket #${ticketNumber}] New reply: ${subject}`,
    text: `${authorName} replied:\n\n${body}\n\n${isAgentReply ? 'Reply to this email or log in to continue the conversation.' : 'Log in to your helpdesk to continue the conversation.'}`,
  });
}

function notifyStatusChange({ toEmail, ticketNumber, subject, status }) {
  return sendMail({
    to: toEmail,
    subject: `[Ticket #${ticketNumber}] Status updated: ${status}`,
    text: `Your ticket "${subject}" is now marked as ${status}.`,
  });
}

function notifyTicketCreated({ toEmail, ticketNumber, subject }) {
  return sendMail({
    to: toEmail,
    subject: `[Ticket #${ticketNumber}] We received your request`,
    text: `Thanks for reaching out. We've opened ticket #${ticketNumber}: "${subject}" and an agent will follow up soon.`,
  });
}

function sendPasswordReset({ toEmail, resetUrl }) {
  return sendMail({
    to: toEmail,
    subject: 'Reset your Work Desk password',
    text: `We received a request to reset your password.\n\nClick the link below to choose a new one (expires in 1 hour):\n${resetUrl}\n\nIf you didn't request this, you can safely ignore this email.`,
  });
}

function sendJobSheetEmail({ toEmail, jobNumber, subject, pdfBuffer }) {
  return sendMail({
    to: toEmail,
    subject: `Job Sheet - #${jobNumber} - ${subject}`,
    text: `Please find attached the job sheet for job #${jobNumber}: "${subject}".`,
    attachments: [{ filename: `Job-${jobNumber}.pdf`, content: pdfBuffer, contentType: 'application/pdf' }],
  });
}

module.exports = { sendMail, notifyNewReply, notifyStatusChange, notifyTicketCreated, sendPasswordReset, sendJobSheetEmail, hasSmtp };

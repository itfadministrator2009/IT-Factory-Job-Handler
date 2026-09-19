const nodemailer = require('nodemailer');
const { getAccessToken, configured: graphConfigured } = require('./calendar');

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
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';
const LOGO_URL = `${FRONTEND_URL}/logo.jpg`;

// Sends via Microsoft Graph's sendMail API instead of SMTP — this sidesteps the
// "basic authentication disabled" (535 5.7.139) error many Microsoft 365 tenants now
// enforce by default, since Graph uses the same OAuth app-only token already used for
// the calendar and OneDrive backups, not a mailbox username/password.
async function sendViaGraph({ to, subject, text, html, attachments }) {
  const token = await getAccessToken();
  // `to` may be a single address or a comma-separated list — Graph needs each one as
  // its own entry in toRecipients, not one address field holding a joined string.
  const recipients = to.split(',').map((addr) => addr.trim()).filter(Boolean);
  const message = {
    subject,
    body: { contentType: html ? 'HTML' : 'Text', content: html || text },
    toRecipients: recipients.map((addr) => ({ emailAddress: { address: addr } })),
  };
  if (attachments && attachments.length > 0) {
    message.attachments = attachments.map((a) => ({
      '@odata.type': '#microsoft.graph.fileAttachment',
      name: a.filename,
      contentType: a.contentType || 'application/octet-stream',
      contentBytes: (Buffer.isBuffer(a.content) ? a.content : Buffer.from(a.content)).toString('base64'),
    }));
  }

  const res = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(FROM)}/sendMail`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, saveToSentItems: true }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Graph sendMail failed (${res.status}): ${errText}`);
  }
}

async function sendMail({ to, subject, text, html, attachments }) {
  if (!to) return;

  // Prefer Graph when Microsoft 365 is configured — falls back to SMTP (if set up)
  // or dev-mode logging if Graph fails, so one misconfigured path never blocks mail
  // entirely once at least one method is working.
  if (graphConfigured) {
    try {
      await sendViaGraph({ to, subject, text, html, attachments });
      return;
    } catch (err) {
      console.error('[email] Graph send failed, falling back:', err.message);
    }
  }

  if (!transporter) {
    console.log(`[email:dev-mode] To: ${to} | Subject: ${subject}\n${text}\n${attachments ? `(${attachments.length} attachment(s))` : ''}`);
    return;
  }
  try {
    await transporter.sendMail({ from: FROM, to, subject, text, html, attachments });
  } catch (err) {
    console.error('Email send failed:', err.message);
  }
}

// Shared wrapper so every branded email looks consistent — logo up top, a title,
// a block of body content, and a muted footer note.
function brandedEmail({ title, bodyHtml, footerNote }) {
  return `
<div style="background:#f6f5f1; padding:32px 16px; font-family:Arial,Helvetica,sans-serif;">
  <div style="max-width:480px; margin:0 auto; background:#ffffff; border-radius:12px; overflow:hidden; border:1px solid #e2e0d8;">
    <div style="background:#1e4d4b; padding:24px; text-align:center;">
      <div style="display:inline-block; background:#ffffff; border-radius:9px; padding:8px 16px;">
        <img src="${LOGO_URL}" alt="IT Factory" height="36" style="display:block; height:36px;" />
      </div>
      <div style="color:#ffffff; font-size:14px; font-weight:700; letter-spacing:0.02em; margin-top:10px;">WORK DESK</div>
    </div>
    <div style="padding:28px 28px 8px;">
      <h1 style="font-size:18px; color:#16241f; margin:0 0 16px;">${title}</h1>
      ${bodyHtml}
    </div>
    <div style="padding:16px 28px 24px; color:#6b7570; font-size:12px; line-height:1.5;">
      ${footerNote || ''}
    </div>
  </div>
</div>`;
}

function statusPillColor(status) {
  const colors = {
    Open: '#3a63ad', 'In Progress': '#c98a1f', 'On Hold': '#6b7570',
    Complete: '#3f7d4f', Collected: '#3f7d4f', Closed: '#777777',
  };
  return colors[status] || '#3a63ad';
}

function notifyNewReply({ toEmail, ticketNumber, subject, authorName, body, isAgentReply }) {
  const html = brandedEmail({
    title: `New reply on #${ticketNumber}`,
    bodyHtml: `
      <p style="font-size:14px; color:#333; line-height:1.6; margin:0 0 6px;">
        <strong>${authorName}</strong> replied on <strong>${subject}</strong>:
      </p>
      <div style="background:#f6f5f1; border-left:3px solid #1e4d4b; border-radius:6px; padding:14px 16px; margin:14px 0 20px; font-size:14px; color:#333; line-height:1.6; white-space:pre-wrap;">${body}</div>
      <p style="font-size:13px; color:#555; margin:0;">
        ${isAgentReply ? 'Reply to this email or log in to continue the conversation.' : 'Log in to your helpdesk to continue the conversation.'}
      </p>
    `,
  });

  return sendMail({
    to: toEmail,
    subject: `[Ticket #${ticketNumber}] New reply: ${subject}`,
    text: `${authorName} replied:\n\n${body}\n\n${isAgentReply ? 'Reply to this email or log in to continue the conversation.' : 'Log in to your helpdesk to continue the conversation.'}`,
    html,
  });
}

function notifyStatusChange({ toEmail, ticketNumber, subject, status }) {
  const html = brandedEmail({
    title: `Status updated — #${ticketNumber}`,
    bodyHtml: `
      <p style="font-size:14px; color:#333; line-height:1.6; margin:0 0 16px;">
        Your request <strong>"${subject}"</strong> is now:
      </p>
      <div style="text-align:center; margin:0 0 6px;">
        <span style="display:inline-block; background:${statusPillColor(status)}1a; color:${statusPillColor(status)}; font-weight:700; font-size:13px; padding:6px 18px; border-radius:999px;">${status}</span>
      </div>
    `,
  });

  return sendMail({
    to: toEmail,
    subject: `[Ticket #${ticketNumber}] Status updated: ${status}`,
    text: `Your ticket "${subject}" is now marked as ${status}.`,
    html,
  });
}

function notifyTicketCreated({ toEmail, ticketNumber, subject }) {
  const html = brandedEmail({
    title: 'We received your request',
    bodyHtml: `
      <p style="font-size:14px; color:#333; line-height:1.6; margin:0 0 16px;">
        Thanks for reaching out. We've opened <strong>ticket #${ticketNumber}</strong>:
      </p>
      <div style="background:#f6f5f1; border-radius:6px; padding:14px 16px; margin:0 0 20px; font-size:14px; color:#333; font-weight:600;">
        ${subject}
      </div>
      <p style="font-size:13px; color:#555; margin:0;">An agent will follow up soon.</p>
    `,
  });

  return sendMail({
    to: toEmail,
    subject: `[Ticket #${ticketNumber}] We received your request`,
    text: `Thanks for reaching out. We've opened ticket #${ticketNumber}: "${subject}" and an agent will follow up soon.`,
    html,
  });
}

function sendPasswordReset({ toEmail, resetUrl }) {
  const html = brandedEmail({
    title: 'Reset your password',
    bodyHtml: `
      <p style="font-size:14px; color:#333; line-height:1.6; margin:0 0 22px;">
        We received a request to reset your password. Click the button below to choose a new one — this link expires in 1 hour.
      </p>
      <div style="text-align:center; margin:0 0 22px;">
        <a href="${resetUrl}" style="background:#e8734a; color:#ffffff; text-decoration:none; font-weight:600; font-size:14px; padding:12px 28px; border-radius:8px; display:inline-block;">
          Reset Password
        </a>
      </div>
      <p style="font-size:12px; color:#888; word-break:break-all; margin:0 0 4px;">
        Or paste this link into your browser:<br/>
        <a href="${resetUrl}" style="color:#1e4d4b;">${resetUrl}</a>
      </p>
    `,
    footerNote: "If you didn't request this, you can safely ignore this email — your password won't change.",
  });

  return sendMail({
    to: toEmail,
    subject: 'Reset your Work Desk password',
    text: `We received a request to reset your password.\n\nClick the link below to choose a new one (expires in 1 hour):\n${resetUrl}\n\nIf you didn't request this, you can safely ignore this email.`,
    html,
  });
}

function sendJobSheetEmail({ toEmail, jobNumber, subject, pdfBuffer }) {
  const html = brandedEmail({
    title: `Job Sheet — #${jobNumber}`,
    bodyHtml: `
      <p style="font-size:14px; color:#333; line-height:1.6; margin:0 0 16px;">
        Please find attached the job sheet for:
      </p>
      <div style="background:#f6f5f1; border-radius:6px; padding:14px 16px; margin:0 0 8px; font-size:14px; color:#333; font-weight:600;">
        ${subject}
      </div>
    `,
  });

  return sendMail({
    to: toEmail,
    subject: `Job Sheet - #${jobNumber} - ${subject}`,
    text: `Please find attached the job sheet for job #${jobNumber}: "${subject}".`,
    html,
    attachments: [{ filename: `Job-${jobNumber}.pdf`, content: pdfBuffer, contentType: 'application/pdf' }],
  });
}

function notifyJobComplete({ toEmail, ticketNumber, subject, pdfBuffer }) {
  const html = brandedEmail({
    title: 'Your job is complete',
    bodyHtml: `
      <p style="font-size:14px; color:#333; line-height:1.6; margin:0 0 16px;">
        Good news — <strong>ticket #${ticketNumber}</strong> has been completed:
      </p>
      <div style="background:#f6f5f1; border-radius:6px; padding:14px 16px; margin:0 0 20px; font-size:14px; color:#333; font-weight:600;">
        ${subject}
      </div>
      <p style="font-size:13px; color:#555; margin:0;">
        ${pdfBuffer ? 'The completed job sheet, including sign-off, is attached.' : 'Thanks for choosing IT Factory.'}
      </p>
    `,
  });

  return sendMail({
    to: toEmail,
    subject: `[Ticket #${ticketNumber}] Job complete: ${subject}`,
    text: `Ticket #${ticketNumber} ("${subject}") has been completed.${pdfBuffer ? ' The completed job sheet is attached.' : ''}`,
    html,
    attachments: pdfBuffer ? [{ filename: `Job-${ticketNumber}.pdf`, content: pdfBuffer, contentType: 'application/pdf' }] : undefined,
  });
}

function notifyJobClosed({ toEmail, ticketNumber, subject }) {
  const html = brandedEmail({
    title: `Job closed — #${ticketNumber}`,
    bodyHtml: `
      <p style="font-size:14px; color:#333; line-height:1.6; margin:0 0 16px;">
        <strong>Ticket #${ticketNumber}</strong> has been closed:
      </p>
      <div style="background:#f6f5f1; border-radius:6px; padding:14px 16px; margin:0; font-size:14px; color:#333; font-weight:600;">
        ${subject}
      </div>
    `,
  });

  return sendMail({
    to: toEmail,
    subject: `[Ticket #${ticketNumber}] Closed: ${subject}`,
    text: `Ticket #${ticketNumber} ("${subject}") has been closed.`,
    html,
  });
}

function notifyJobAssigned({ toEmail, ticketNumber, subject, contactName }) {
  const html = brandedEmail({
    title: 'A job has been assigned to you',
    bodyHtml: `
      <p style="font-size:14px; color:#333; line-height:1.6; margin:0 0 16px;">
        <strong>Ticket #${ticketNumber}</strong> has been assigned to you:
      </p>
      <div style="background:#f6f5f1; border-radius:6px; padding:14px 16px; margin:0 0 8px; font-size:14px; color:#333; font-weight:600;">
        ${subject}
      </div>
      ${contactName ? `<p style="font-size:13px; color:#555; margin:8px 0 0;">Contact: ${contactName}</p>` : ''}
    `,
  });

  return sendMail({
    to: toEmail,
    subject: `[Ticket #${ticketNumber}] Assigned to you: ${subject}`,
    text: `Ticket #${ticketNumber} ("${subject}") has been assigned to you.`,
    html,
  });
}

// Sent when a Project entry is submitted — goes to the fixed internal distribution
// list (not the client), with the completed form attached as a PDF.
function notifyProjectEntryComplete({ toEmails, projectName, siteName, entryNumber, pdfBuffer }) {
  const siteLine = siteName ? ` — ${siteName}` : '';
  const html = brandedEmail({
    title: 'Job complete',
    bodyHtml: `
      <p style="font-size:14px; color:#333; line-height:1.6; margin:0 0 16px;">
        <strong>${projectName}</strong> — Entry #${entryNumber}${siteLine} has been completed.
      </p>
      <p style="font-size:13px; color:#555; margin:0;">
        ${pdfBuffer ? 'The completed form is attached as a PDF.' : ''}
      </p>
    `,
  });

  return sendMail({
    to: toEmails.join(','),
    subject: `${projectName} — Entry #${entryNumber} complete${siteLine}`,
    text: `${projectName} — Entry #${entryNumber}${siteLine} has been completed.${pdfBuffer ? ' The completed form is attached.' : ''}`,
    html,
    attachments: pdfBuffer ? [{ filename: `${projectName.replace(/[^a-z0-9]+/gi, '-')}-Entry-${entryNumber}.pdf`, content: pdfBuffer, contentType: 'application/pdf' }] : undefined,
  });
}

module.exports = {
  sendMail, notifyNewReply, notifyStatusChange, notifyTicketCreated, notifyJobComplete,
  notifyJobClosed, notifyJobAssigned, notifyProjectEntryComplete, sendPasswordReset,
  sendJobSheetEmail, hasSmtp,
};

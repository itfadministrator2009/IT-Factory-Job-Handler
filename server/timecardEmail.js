// ITF Time Card emails — the same four the old Time Card app sent:
//  • submitted   → every Work Desk admin ("Timesheet approval — …")
//  • approved    → accounts ("Approved for payment — …") and the contractor
//  • declined    → the contractor, with the reason
//  • reminder    → contractors who haven't sent this week's hours (Fridays)
const { sendMail } = require('./email');
const { db } = require('./db');
const { dmy } = require('./timecard');

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';
const LOGO_URL = `${FRONTEND_URL}/logo.jpg`;
const ACCOUNTS_EMAIL = () => process.env.TIMECARD_ACCOUNTS_EMAIL || 'accounts@itfactory.com.au';

const BADGES = {
  waiting: { text: 'Waiting on approval', color: '#8A5A0B', bg: '#FDF3E7' },
  approved: { text: 'Approved', color: '#4C7A1E', bg: '#E8F4DA' },
  declined: { text: 'Declined', color: '#B23A2E', bg: '#FBEAEA' },
};

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => `$${(Number(n) || 0).toFixed(2)}`;
const FONT = 'font-family:Arial,Helvetica,sans-serif;';
const TH = (h, align = 'left') => `<th align="${align}" style="padding:8px 6px;background:#16241f;color:#fff;font-size:10px;letter-spacing:0.6px;text-transform:uppercase;${FONT}">${h}</th>`;
const TD = (v, align = 'left') => `<td align="${align}" style="padding:8px 6px;border-bottom:1px solid #e2e0d8;color:#16241f;font-size:12px;${FONT}">${esc(v)}</td>`;

function shell(inner) {
  return `<div style="background:#f6f5f1;padding:32px 16px;${FONT}">
  <div style="max-width:640px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e2e0d8;">
    <div style="background:#1e4d4b;padding:20px 24px;">
      <div style="display:inline-block;background:#fff;border-radius:9px;padding:8px 16px;"><img src="${LOGO_URL}" alt="IT Factory" height="32" style="display:block;height:32px;" /></div>
      <span style="color:#fff;font-size:13px;font-weight:700;letter-spacing:0.04em;margin-left:12px;vertical-align:middle;">ITF TIME CARD</span>
    </div>
    ${inner}
  </div>
</div>`;
}

function timesheetHtml(week, { badge, introHtml }) {
  const b = BADGES[badge];
  const entries = week.entries.map((e) => `<tr>${TD(e.day)}${TD(dmy(e.date) || '—')}${TD(e.clientProject || '—')}${TD(e.start || '—')}${TD(e.finish || '—')}${TD(`${e.breakMins || 0}m`, 'right')}${TD(e.hours.toFixed(2), 'right')}${TD(e.task || '—')}</tr>`).join('');
  const expenses = week.expenses.length ? `
    <div style="padding:4px 24px 20px;">
      <div style="font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#6b7570;margin-bottom:8px;">Expenses</div>
      <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
        <tr>${TH('Date')}${TH('Type')}${TH('Description')}${TH('Amount', 'right')}</tr>
        ${week.expenses.map((x) => `<tr>${TD(dmy(x.date) || '—')}${TD(x.type)}${TD(x.description || '—')}${TD(money(x.amount), 'right')}</tr>`).join('')}
      </table>
      <div style="text-align:right;border-top:2px solid #16241f;margin-top:8px;padding-top:8px;font-size:13px;color:#16241f;"><b>Total expenses: ${money(week.expenseTotal)}</b></div>
    </div>` : '';
  return shell(`
    <div style="padding:24px 24px 6px;">
      <span style="display:inline-block;background:${b.bg};color:${b.color};border:1px solid ${b.color};border-radius:20px;padding:4px 12px;font-size:10px;letter-spacing:0.8px;text-transform:uppercase;font-weight:bold;">${esc(b.text)}</span>
      <div style="font-size:13.5px;color:#3d4a45;line-height:1.6;margin-top:14px;">${introHtml}</div>
      <div style="font-size:13px;color:#16241f;line-height:1.8;margin-top:12px;"><b>Contractor:</b> ${esc(week.fullName)}<br><b>Week ending:</b> ${esc(dmy(week.weekEnding))}</div>
    </div>
    <div style="padding:14px 24px;">
      <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
        <tr>${TH('Day')}${TH('Date')}${TH('Client / project')}${TH('Start')}${TH('Finish')}${TH('Break', 'right')}${TH('Hours', 'right')}${TH('Task')}</tr>
        ${entries}
      </table>
      <div style="text-align:right;border-top:2px solid #16241f;margin-top:8px;padding-top:10px;font-size:13px;color:#6b7570;">TOTAL HOURS <span style="font-size:22px;font-weight:bold;color:#155e6b;font-family:'Courier New',monospace;margin-left:8px;">${week.total.toFixed(2)}</span> hrs</div>
    </div>
    ${expenses}
    <div style="padding:6px 24px 24px;"><a href="${FRONTEND_URL}/timecard" style="background:#1e4d4b;color:#fff;text-decoration:none;padding:10px 18px;border-radius:6px;font-size:13px;display:inline-block;">Open ITF Time Card</a></div>`);
}

function timesheetText(week, intro) {
  const lines = [intro, '', `Contractor: ${week.fullName}`, `Week ending: ${dmy(week.weekEnding)}`, ''];
  week.entries.forEach((e) => lines.push(`${e.day} ${dmy(e.date) || ''}  ${e.clientProject || '-'}  ${e.start}-${e.finish}  break ${e.breakMins}m  ${e.hours.toFixed(2)} hrs  ${e.task || ''}`.trim()));
  lines.push('', `Total hours: ${week.total.toFixed(2)}`);
  if (week.expenses.length) {
    lines.push('', 'Expenses');
    week.expenses.forEach((x) => lines.push(`${dmy(x.date)}  ${x.type}  ${money(x.amount)}  ${x.description || ''}`.trim()));
    lines.push(`Total expenses: ${money(week.expenseTotal)}`);
  }
  return lines.join('\n');
}

function adminEmails() {
  const seen = new Set();
  return db.prepare("SELECT email FROM users WHERE role IN ('admin','agent') AND email IS NOT NULL AND email != ''").all()
    .map((r) => r.email.trim()).filter((e) => { const k = e.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
}

async function notifySubmitted(week) {
  const to = adminEmails();
  if (!to.length) return;
  await sendMail({
    to: to.join(','),
    subject: `Timesheet approval — ${week.fullName} — week ending ${dmy(week.weekEnding)}`,
    text: timesheetText(week, 'Please review and approve the timesheet below in ITF Time Card.'),
    html: timesheetHtml(week, { badge: 'waiting', introHtml: 'A new timesheet is ready for your review. Open ITF Time Card in Work Desk to approve or decline it.' }),
  });
}

async function notifyApproved(week) {
  const by = week.approvedBy; const on = dmy(week.approvalDate);
  await sendMail({
    to: ACCOUNTS_EMAIL(),
    subject: `Approved for payment — ${week.fullName} — week ending ${dmy(week.weekEnding)}`,
    text: timesheetText(week, `Approved by: ${by}\nApproval date: ${on}`),
    html: timesheetHtml(week, { badge: 'approved', introHtml: `This timesheet has been approved and is ready for payment.<br><br><b>Approved by:</b> ${esc(by)}<br><b>Approval date:</b> ${esc(on)}` }),
  });
  if (week.email) {
    await sendMail({
      to: week.email,
      subject: `Your timesheet has been approved — week ending ${dmy(week.weekEnding)}`,
      text: timesheetText(week, `Hi ${week.fullName || 'there'},\n\nYour timesheet for the week ending ${dmy(week.weekEnding)} has been approved by ${by} on ${on} and sent to accounts for payment. No action is needed from you.`),
      html: timesheetHtml(week, { badge: 'approved', introHtml: `Hi ${esc(week.fullName || 'there')}, your timesheet for the week ending ${esc(dmy(week.weekEnding))} has been approved by ${esc(by)} on ${esc(on)} and sent to accounts for payment. No action is needed from you.` }),
    });
  }
}

async function notifyDeclined(week) {
  if (!week.email) return;
  const intro = `your timesheet for the week ending ${dmy(week.weekEnding)} was declined by ${week.approvedBy} on ${dmy(week.approvalDate)}.`;
  await sendMail({
    to: week.email,
    subject: `Timesheet needs changes — week ending ${dmy(week.weekEnding)}`,
    text: timesheetText(week, `Hi ${week.fullName || 'there'}, ${intro}\n\nReason: ${week.declineReason}\n\nPlease log back in, make the changes and send it for approval again.`),
    html: timesheetHtml(week, { badge: 'declined', introHtml: `Hi ${esc(week.fullName || 'there')}, ${esc(intro)}<br><br><b>Reason:</b> ${esc(week.declineReason)}<br><br>Please log back in, make the changes and send it for approval again.` }),
  });
}

async function sendReminder({ name, email }) {
  const intro = `Hi ${name || 'there'}, this is a friendly reminder to log and submit your hours for this week. Open ITF Time Card to add your entries and send them for approval.`;
  await sendMail({
    to: email,
    subject: 'Reminder — submit your timesheet',
    text: intro,
    html: shell(`<div style="padding:24px;font-size:13.5px;color:#3d4a45;line-height:1.6;">${esc(intro)}</div>
      <div style="padding:0 24px 24px;"><a href="${FRONTEND_URL}/timecard" style="background:#1e4d4b;color:#fff;text-decoration:none;padding:10px 18px;border-radius:6px;font-size:13px;display:inline-block;">Open ITF Time Card</a></div>`),
  });
}

module.exports = { notifySubmitted, notifyApproved, notifyDeclined, sendReminder, adminEmails };

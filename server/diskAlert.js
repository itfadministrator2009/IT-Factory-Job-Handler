// Disk space warning: once an hour, check how full the server's disk is. At 90% or
// more, email the Super Admin. While it stays that full, remind them once a day;
// when it drops back under 90%, the warning resets (and the next time it fills up,
// they're told straight away). Sent whether or not error alerts are switched on.
const path = require('path');
const { db } = require('./db');
const { getSetting, setSetting } = require('./appSettings');

const THRESHOLD = 0.9;
const REMIND_MS = 24 * 60 * 60 * 1000;
const CHECK_MS = 60 * 60 * 1000;

const gb = (b) => `${(b / 1024 ** 3).toFixed(2)} GB`;
const mb = (b) => (b >= 1024 ** 3 ? gb(b) : `${(b / 1024 ** 2).toFixed(1)} MB`);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function superAdminEmails() {
  return [...new Set(db.prepare("SELECT email FROM users WHERE super_admin = 1 AND email IS NOT NULL AND email != ''").all()
    .map((r) => r.email.trim().toLowerCase()))];
}

function measure() {
  const { diskSpace, DB_PATH } = require('./diskUsage');
  return diskSpace(path.dirname(path.resolve(DB_PATH)));
}

// space: { total, free, used } in bytes (measured from the disk when not given).
// Returns what happened, for tests and logs.
async function checkDiskSpace({ space = measure(), now = Date.now() } = {}) {
  if (!space || !space.total) return { status: 'unknown' };
  const ratio = space.used / space.total;
  const pct = Math.round(ratio * 1000) / 10;
  if (ratio < THRESHOLD) {
    if (getSetting('disk_alert_last')) setSetting('disk_alert_last', null);
    return { status: 'ok', pct };
  }
  const last = Number(getSetting('disk_alert_last') || 0);
  if (last && now - last < REMIND_MS) return { status: 'held', pct };
  const to = superAdminEmails();
  if (!to.length) return { status: 'no_recipients', pct };

  let extra = '';
  try {
    const u = require('./diskUsage').diskUsage();
    const uploads = (u.uploads?.dirs || []).reduce((t, d) => t + d.bytes, 0);
    extra = `Database: ${mb(u.database.total)}\nUploaded files: ${mb(uploads)}`;
  } catch (e) { /* the totals are enough */ }

  const when = new Date(now).toLocaleString('en-AU', { timeZone: process.env.BACKUP_TIMEZONE || 'Australia/Sydney' });
  const subject = `Work Desk disk is ${pct}% full`;
  const lines = `Used: ${gb(space.used)} of ${gb(space.total)} (${pct}%)\nFree: ${gb(space.free)}${extra ? `\n${extra}` : ''}`;
  const advice = 'Open Settings → Disk usage in Work Desk to see what is using the space, or increase the disk size on Render. If the disk fills up completely, Work Desk can stop saving changes.';
  try {
    const { sendMail } = require('./email');
    await sendMail({
      to: to.join(','),
      subject,
      text: `${subject}\n\nWhen: ${when} (Sydney)\n\n${lines}\n\n${advice}\n\nYou get this because you're the Work Desk Super Admin. While the disk stays 90% full or more, you'll be reminded once a day.`,
      html: `<div style="font-family:Arial,Helvetica,sans-serif;color:#16241f;max-width:600px">
        <div style="background:#b23a2e;color:#fff;padding:12px 16px;border-radius:8px 8px 0 0;font-weight:bold">Work Desk: disk space low</div>
        <div style="border:1px solid #e2e0d8;border-top:none;padding:16px;border-radius:0 0 8px 8px">
          <p style="font-size:15px;margin:0 0 10px"><b>${esc(subject)}</b></p>
          <p style="font-size:13px;color:#6b7570;margin:0 0 12px">${esc(when)} (Sydney)</p>
          <pre style="white-space:pre-wrap;font-size:13px;background:#f6f5f1;padding:10px;border-radius:6px;margin:0 0 12px">${esc(lines)}</pre>
          <p style="font-size:13px;margin:0 0 12px">${esc(advice)}</p>
          <p style="font-size:12px;color:#6b7570;margin:0">You get this because you're the Work Desk Super Admin. While the disk stays 90% full or more, you'll be reminded once a day.</p>
        </div></div>`,
    });
  } catch (err) {
    console.error('[disk] Could not send the disk space email:', err.message);
    return { status: 'send_failed', pct };
  }
  setSetting('disk_alert_last', now);
  try { require('./activity').logActivity('settings.disk_alert', { details: `Disk ${pct}% full — emailed ${to.join(', ')}` }); } catch (e) { /* log is optional */ }
  return { status: 'sent', pct, to };
}

function startDiskAlertScheduler() {
  const run = () => checkDiskSpace().catch((err) => console.error('[disk] Check failed:', err.message));
  setTimeout(run, 60 * 1000).unref?.();
  setInterval(run, CHECK_MS).unref?.();
}

module.exports = { checkDiskSpace, startDiskAlertScheduler, THRESHOLD };

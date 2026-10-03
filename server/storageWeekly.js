// Weekly invoicing reminder — the old Storage Centre's Monday-morning email
// (sendWeeklyInvoicingReminder + its weekly trigger): last Monday–Sunday's
// storage, receiving and dispatch fees per client.
//
// Opt-in: it only runs when STORAGE_WEEKLY_REMINDER_EMAILS is set, so it won't
// double up with the old Apps Script trigger while both apps are running.
// Turn that trigger off (or delete it) when you set this.
//
// The last week sent is recorded in the database, so restarts, redeploys or a
// second instance never send the same week twice.
const { db } = require('./db');
const { summary } = require('./storageBilling');
const { notifyStorageWeeklyInvoicing } = require('./email');

const TZ = process.env.BACKUP_TIMEZONE || 'Australia/Sydney';
const SEND_DAY = 1; // Monday (0 = Sunday)
const SEND_HOUR = Number(process.env.STORAGE_WEEKLY_REMINDER_HOUR || 8);

db.exec(`CREATE TABLE IF NOT EXISTS storage_meta (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT NOT NULL DEFAULT (datetime('now')))`);

function recipients() {
  return (process.env.STORAGE_WEEKLY_REMINDER_EMAILS || '').split(',').map((s) => s.trim()).filter(Boolean);
}

// Local date/time parts in the business timezone.
function nowParts(date = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false, weekday: 'short',
  }).formatToParts(date).map((p) => [p.type, p.value]));
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday);
  return { ymd: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) % 24, weekday };
}

function addDays(ymd, n) {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// The most recently completed Monday–Sunday week, as YYYY-MM-DD strings.
function lastWeekRange(date = new Date()) {
  const { ymd, weekday } = nowParts(date);
  const daysSinceMonday = (weekday + 6) % 7;
  const thisMonday = addDays(ymd, -daysSinceMonday);
  return { from: addDays(thisMonday, -7), to: addDays(thisMonday, -1) };
}

const dmy = (ymd) => `${ymd.slice(8, 10)}/${ymd.slice(5, 7)}/${ymd.slice(0, 4)}`;

async function sendWeeklyInvoicingReminder({ toEmails = recipients(), range = lastWeekRange() } = {}) {
  if (!toEmails.length) return { ok: false, reason: 'not_configured' };
  const report = summary(range.from, range.to);
  // Like the old email: only clients with something to bill.
  const rows = report.summary.filter((r) => r.total > 0);
  const grandTotal = Math.round(rows.reduce((t, r) => t + r.total, 0) * 100) / 100;
  await notifyStorageWeeklyInvoicing({ toEmails, fromLabel: dmy(range.from), toLabel: dmy(range.to), rows, grandTotal });
  return { ok: true, from: range.from, to: range.to, clients: rows.length, grandTotal, sentTo: toEmails };
}

// Sends at most once per week, at/after the configured hour on Monday.
async function tick(date = new Date()) {
  if (!recipients().length) return null;
  const { weekday, hour } = nowParts(date);
  if (weekday !== SEND_DAY || hour < SEND_HOUR) return null;
  const range = lastWeekRange(date);
  const last = db.prepare("SELECT value FROM storage_meta WHERE key = 'weekly_invoicing_last_from'").get()?.value;
  if (last === range.from) return null;
  // Claim the week first so a second instance or an overlapping tick can't also send.
  const claimed = db.prepare(`INSERT INTO storage_meta (key, value) VALUES ('weekly_invoicing_last_from', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
    WHERE storage_meta.value IS NOT excluded.value`).run(range.from).changes;
  if (!claimed) return null;
  try {
    const result = await sendWeeklyInvoicingReminder({ range });
    console.log(`[storage] Weekly invoicing reminder sent for ${range.from}..${range.to} (${result.clients} client(s)).`);
    return result;
  } catch (err) {
    // Release the claim so the next hourly check retries.
    db.prepare("UPDATE storage_meta SET value = ? WHERE key = 'weekly_invoicing_last_from'").run(last || null);
    console.error('[storage] Weekly invoicing reminder failed:', err.message);
    return { ok: false, reason: 'send_failed', error: err.message };
  }
}

function startStorageWeeklyScheduler() {
  if (!recipients().length) {
    console.log('[storage] Weekly invoicing reminder is off (set STORAGE_WEEKLY_REMINDER_EMAILS to turn it on).');
    return;
  }
  console.log(`[storage] Weekly invoicing reminder on — Mondays from ${SEND_HOUR}:00 (${TZ}).`);
  tick().catch(() => {});
  setInterval(() => { tick().catch(() => {}); }, 15 * 60 * 1000);
}

module.exports = { startStorageWeeklyScheduler, sendWeeklyInvoicingReminder, lastWeekRange, tick, recipients };

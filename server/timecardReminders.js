// ITF Time Card — Friday-afternoon reminder (the old app's sendSubmissionReminders
// trigger, Fridays ~3pm). Emails each contractor who hasn't sent this week's
// timesheet, or who has a declined week still to fix.
//
// Opt-in: only runs when TIMECARD_REMINDERS=on, so it won't double up with the
// old Apps Script trigger while both apps are running. Turn that trigger off
// when you switch this on. The last Friday sent is recorded in the database, so
// restarts or redeploys never send twice.
const { db } = require('./db');
const { todayYmd, sundayOnOrAfter, addDays } = require('./timecard');
const { sendReminder } = require('./timecardEmail');

const TZ = process.env.BACKUP_TIMEZONE || 'Australia/Sydney';
const SEND_DAY = 5; // Friday
const SEND_HOUR = Number(process.env.TIMECARD_REMINDER_HOUR || 15);
const enabled = () => /^(on|true|1|yes)$/i.test(process.env.TIMECARD_REMINDERS || '');

function nowParts(date = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, hour: '2-digit', hour12: false, weekday: 'short',
  }).formatToParts(date).map((x) => [x.type, x.value]));
  return { hour: Number(p.hour) % 24, weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday) };
}

// Contractors (with an email) who still need to send hours for this week (Monday to
// Sunday), or who have a declined week to fix. A timesheet counts if its week ends
// this week or it was sent this week — the old app dated weeks by the day they were sent.
function contractorsToRemind(date = new Date()) {
  const ending = sundayOnOrAfter(todayYmd(date));
  const monday = addDays(ending, -6);
  return db.prepare("SELECT id, name, email FROM users WHERE role = 'contractor' AND email IS NOT NULL AND email != '' ORDER BY name").all()
    .filter((u) => {
      const sent = db.prepare(`SELECT 1 FROM timecard_weeks WHERE user_id = ? AND status IN ('Waiting on approval','Approved')
        AND ((week_ending BETWEEN ? AND ?) OR (submitted_date BETWEEN ? AND ?))`).get(u.id, monday, ending, monday, ending);
      const declined = db.prepare("SELECT 1 FROM timecard_weeks WHERE user_id = ? AND status = 'Declined'").get(u.id);
      return !sent || declined;
    });
}

async function sendReminders(date = new Date()) {
  const list = contractorsToRemind(date);
  for (const u of list) {
    try { await sendReminder(u); } catch (err) { console.error(`[timecard] Reminder to ${u.email} failed:`, err.message); }
  }
  return { sent: list.length, to: list.map((u) => u.name) };
}

async function tick(date = new Date()) {
  if (!enabled()) return null;
  const { weekday, hour } = nowParts(date);
  if (weekday !== SEND_DAY || hour < SEND_HOUR) return null;
  const today = todayYmd(date);
  const claimed = db.prepare(`INSERT INTO timecard_meta (key, value) VALUES ('reminder_last_sent', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
    WHERE timecard_meta.value IS NOT excluded.value`).run(today).changes;
  if (!claimed) return null;
  const result = await sendReminders(date);
  console.log(`[timecard] Friday reminders sent to ${result.sent} contractor(s).`);
  return result;
}

function startTimecardReminderScheduler() {
  if (!enabled()) {
    console.log('[timecard] Friday reminders are off (set TIMECARD_REMINDERS=on to send them from Work Desk).');
    return;
  }
  const run = () => tick().catch((err) => console.error('[timecard] Reminder tick failed:', err.message));
  setTimeout(run, 30 * 1000);
  setInterval(run, 10 * 60 * 1000).unref?.();
}

module.exports = { startTimecardReminderScheduler, contractorsToRemind, sendReminders, tick };

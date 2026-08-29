// Syncs newly-created jobs to a Microsoft 365 calendar (e.g. collections@itfactory.com.au)
// using an Azure AD app-only (client credentials) grant — no per-user login needed.
// See README for the Azure Portal setup steps required before this will actually send anything.

const TENANT_ID = process.env.MS_TENANT_ID;
const CLIENT_ID = process.env.MS_CLIENT_ID;
const CLIENT_SECRET = process.env.MS_CLIENT_SECRET;
const CALENDAR_USER = process.env.MS_CALENDAR_USER || 'collections@itfactory.com.au';
const TIMEZONE = process.env.MS_CALENDAR_TIMEZONE || 'AUS Eastern Standard Time';

const configured = !!(TENANT_ID && CLIENT_ID && CLIENT_SECRET);
if (!configured) {
  console.log('[calendar] Microsoft 365 calendar sync is not configured (MS_TENANT_ID/MS_CLIENT_ID/MS_CLIENT_SECRET not set) — jobs will not be added to a calendar.');
}

let cachedToken = null;
let tokenExpiresAt = 0;

async function getAccessToken() {
  // Reuse the cached token until shortly before it actually expires (tokens are typically valid ~60 min).
  if (cachedToken && Date.now() < tokenExpiresAt - 60_000) return cachedToken;

  const res = await fetch(`https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      scope: 'https://graph.microsoft.com/.default',
      grant_type: 'client_credentials',
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to get Microsoft Graph token (${res.status}): ${text}`);
  }

  const data = await res.json();
  cachedToken = data.access_token;
  tokenExpiresAt = Date.now() + data.expires_in * 1000;
  return cachedToken;
}

// Loosely parses free-text time strings like "10am", "2:30pm", "14:00" -> { hour, minute } or null
function parseTime(text) {
  if (!text) return null;
  const m = String(text).trim().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (!m) return null;

  let hour = parseInt(m[1], 10);
  const minute = m[2] ? parseInt(m[2], 10) : 0;
  const ampm = m[3] ? m[3].toLowerCase() : null;

  if (ampm === 'pm' && hour < 12) hour += 12;
  if (ampm === 'am' && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return null;

  return { hour, minute };
}

// Maps a detected Australian state/territory to the matching Outlook category —
// these category names must already exist in the target mailbox (Categorize menu);
// this doesn't create them, just assigns the matching one by name.
const STATE_CATEGORIES = {
  NSW: 'NSW Collections / Projects',
  VIC: 'VIC Collections / Projects',
  QLD: 'QLD Collections / Projects',
  WA: 'WA Collections / Projects',
  SA: 'SA Collections / Projects',
  TAS: 'TAS Collections / Projects',
  NT: 'NT Collections / Projects',
  ACT: 'ACT Collections / Projects',
};

// Order matters: longer/more-specific codes first so e.g. "NSW" isn't ever partially
// matched by a shorter code. All matched as whole words only (word boundaries), so
// "SA" won't match inside "Tasmania" and "ACT" won't match inside ordinary text.
const STATE_MATCH_ORDER = ['NSW', 'VIC', 'QLD', 'TAS', 'ACT', 'WA', 'SA', 'NT'];

function detectStateCategory(address) {
  if (!address) return null;
  for (const code of STATE_MATCH_ORDER) {
    const re = new RegExp(`\\b${code}\\b`, 'i');
    if (re.test(address)) return STATE_CATEGORIES[code];
  }
  return null;
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function formatLocalDateTime(d) {
  // Graph wants a naive local datetime string (no Z/offset) paired with a separate timeZone field.
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
}

function buildEventPayload(job) {
  const time = parseTime(job.scheduled_time);
  const subject = `Job #${job.job_number} - ${job.subject}`;
  const category = detectStateCategory(job.site_address);

  const bodyLines = [
    job.contact_name ? `Contact: ${job.contact_name}` : null,
    job.account_name ? `Account: ${job.account_name}` : null,
    job.phone ? `Phone: ${job.phone}` : null,
    job.site_address ? `Site: ${job.site_address}` : null,
    job.access_notes ? `Access notes: ${job.access_notes}` : null,
    job.description ? `\n${job.description}` : null,
  ].filter(Boolean).join('\n');

  const location = job.site_address ? { displayName: job.site_address } : undefined;
  const categories = category ? [category] : undefined;

  if (time) {
    const start = new Date(`${job.due_date}T00:00:00`);
    start.setHours(time.hour, time.minute, 0, 0);
    const end = new Date(start.getTime() + 60 * 60 * 1000); // 1-hour default duration
    return {
      subject,
      body: { contentType: 'Text', content: bodyLines },
      start: { dateTime: formatLocalDateTime(start), timeZone: TIMEZONE },
      end: { dateTime: formatLocalDateTime(end), timeZone: TIMEZONE },
      location,
      categories,
    };
  }

  // No parseable time — falls back to an all-day event on the due date instead of guessing a time.
  return {
    subject,
    body: { contentType: 'Text', content: bodyLines },
    start: { dateTime: `${job.due_date}T00:00:00`, timeZone: TIMEZONE },
    end: { dateTime: `${job.due_date}T00:00:00`, timeZone: TIMEZONE },
    isAllDay: true,
    location,
    categories,
  };
}

// Fire-and-forget from the caller's perspective — never throws, just logs and returns null
// on failure, so a calendar hiccup never blocks or breaks job creation itself.
async function createCalendarEvent(job) {
  if (!configured) return null;
  if (!job.due_date) return null; // nothing to schedule without a date

  try {
    const token = await getAccessToken();
    const payload = buildEventPayload(job);
    const res = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(CALENDAR_USER)}/events`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const text = await res.text();
      console.error('[calendar] Event creation failed:', res.status, text);
      return null;
    }

    const data = await res.json();
    return data.id;
  } catch (err) {
    console.error('[calendar] Sync error:', err.message);
    return null;
  }
}

module.exports = { createCalendarEvent, buildEventPayload, parseTime, detectStateCategory, configured };

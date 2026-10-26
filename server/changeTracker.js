// "New changes" for the refresh button: remembers when anything in Work Desk
// was last changed (any successful save / add / delete), and by whom, so open
// pages can show that someone else has changed something since they loaded.
// Kept in memory — after a server restart pages simply start counting afresh.

const KEEP = 200; // recent changes remembered
const IGNORE = /^\/api\/(presence|auth|health)(\/|\?|$)/; // heartbeats and sign-ins aren't changes
const recent = []; // { at, by }

function trackChanges(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS' || IGNORE.test(req.originalUrl)) return next();
  res.on('finish', () => {
    if (res.statusCode >= 400) return;
    recent.push({ at: Date.now(), by: req.user ? String(req.user.id) : 'other' });
    if (recent.length > KEEP) recent.splice(0, recent.length - KEEP);
  });
  next();
}

// How many changes other people have made since `since` (ms), plus the server's
// clock so a page can start counting from "now".
function changesSince(since, userId) {
  const s = Number(since) || 0;
  const me = String(userId);
  let byOthers = 0;
  let lastAt = 0;
  for (const c of recent) {
    if (c.at > s && c.by !== me) { byOthers += 1; lastAt = Math.max(lastAt, c.at); }
  }
  return { now: Date.now(), byOthers, lastAt: lastAt || null };
}

function resetChanges() { recent.length = 0; }

module.exports = { trackChanges, changesSince, resetChanges };

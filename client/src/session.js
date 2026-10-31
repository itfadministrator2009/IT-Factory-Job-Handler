// Work Desk sign-in, kept for this browser tab/app window only.
//
// - The sign-in lives in sessionStorage, so closing the app (or every tab of it)
//   signs you out: reopening asks for your email and password again.
// - Opening Work Desk in another tab while it's already open and signed in
//   borrows that sign-in, so links opened in a new tab still work.
// - 30 minutes with no clicks, typing or scrolling in any Work Desk tab signs
//   you out everywhere (see IdleLogout).
const TOKEN = 'helpdesk_token';
const USER = 'helpdesk_user';
const LAST_ACTIVE = 'helpdesk_last_activity'; // shared by every tab (localStorage)
const REASON = 'helpdesk_logout_reason';
export const IDLE_MS = 30 * 60 * 1000;

const ss = () => { try { return window.sessionStorage; } catch (e) { return null; } };
const ls = () => { try { return window.localStorage; } catch (e) { return null; } };

export function getToken() { return ss()?.getItem(TOKEN) || null; }
export function getStoredUser() {
  try { return JSON.parse(ss()?.getItem(USER) || 'null'); } catch (e) { return null; }
}
export function saveSession(token, user) {
  ss()?.setItem(TOKEN, token);
  ss()?.setItem(USER, JSON.stringify(user));
  markActive(true);
}
export function saveUser(user) { ss()?.setItem(USER, JSON.stringify(user)); }
export function clearSession() { ss()?.removeItem(TOKEN); ss()?.removeItem(USER); }

// Activity, shared across tabs so working in one tab keeps the others signed in.
let lastWrite = 0;
export function markActive(force) {
  const now = Date.now();
  if (!force && now - lastWrite < 10000) return; // at most every 10 seconds
  lastWrite = now;
  try { ls()?.setItem(LAST_ACTIVE, String(now)); } catch (e) { /* storage full or blocked */ }
}
export function lastActive() { return Number(ls()?.getItem(LAST_ACTIVE)) || 0; }
export function idleFor() { return Date.now() - lastActive(); }
export function isIdleExpired() { return idleFor() >= IDLE_MS; }

// Why you were sent to the login page ('idle'), shown there once.
export function setLogoutReason(r) { ss()?.setItem(REASON, r); }
export function takeLogoutReason() { const r = ss()?.getItem(REASON); ss()?.removeItem(REASON); return r; }

// Older versions kept the sign-in in localStorage (it survived closing the app).
export function dropOldSavedLogin() { ls()?.removeItem(TOKEN); ls()?.removeItem(USER); }

// --- Between tabs -------------------------------------------------------------
const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('workdesk-session') : null;
const logoutListeners = new Set();
if (channel) {
  channel.onmessage = (e) => {
    const m = e.data || {};
    // Another tab just opened: hand it our sign-in if we're signed in and active.
    if (m.type === 'need-session' && getToken() && !isIdleExpired()) {
      channel.postMessage({ type: 'session', to: m.from, token: getToken(), user: getStoredUser() });
    }
    if (m.type === 'logout') logoutListeners.forEach((fn) => fn(m.reason));
  };
}
export function onLogoutElsewhere(fn) { logoutListeners.add(fn); return () => logoutListeners.delete(fn); }
export function broadcastLogout(reason) { try { channel?.postMessage({ type: 'logout', reason }); } catch (e) { /* closed */ } }

// A new tab with no sign-in asks any open Work Desk tab for one (briefly).
export function borrowSessionFromOpenTab(waitMs = 400) {
  if (!channel || getToken()) return Promise.resolve(false);
  const id = Math.random().toString(36).slice(2);
  return new Promise((resolve) => {
    const ask = new BroadcastChannel('workdesk-session');
    const done = (ok) => { clearTimeout(t); ask.close(); resolve(ok); };
    ask.onmessage = (e) => {
      const m = e.data || {};
      if (m.type === 'session' && m.to === id && m.token && m.user) {
        ss()?.setItem(TOKEN, m.token);
        ss()?.setItem(USER, JSON.stringify(m.user));
        done(true);
      }
    };
    const t = setTimeout(() => done(false), waitMs);
    ask.postMessage({ type: 'need-session', from: id });
  });
}

// Run once before the app starts.
export async function startSession() {
  dropOldSavedLogin();
  if (!getToken()) await borrowSessionFromOpenTab();
  if (getToken() && isIdleExpired()) { clearSession(); setLogoutReason('idle'); }
}

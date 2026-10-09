import { useEffect, useRef, useState } from 'react';
import api from '../api';

// "N online now" — the old Storage Centre's presence indicator. A heartbeat
// every minute keeps you listed; anyone not seen for 150 seconds drops off.
// Shared across pages so moving between pages doesn't re-send it each time.
let cache = { at: 0, users: [] };
const listeners = new Set();
let timer = null;

async function beat() {
  try {
    const { data } = await api.post('/presence/heartbeat');
    cache = { at: Date.now(), users: data.users };
    listeners.forEach((fn) => fn(cache.users));
  } catch { /* offline or signed out — try again next tick */ }
}

// Click "N online now" to see who they are.
export default function WhoIsOnline({ me, meId }) {
  const [users, setUsers] = useState(cache.users);
  const [open, setOpen] = useState(false);
  const boxRef = useRef(null);
  useEffect(() => {
    listeners.add(setUsers);
    if (Date.now() - cache.at > 30000) beat();
    if (!timer) timer = setInterval(beat, 60000);
    return () => {
      listeners.delete(setUsers);
      if (!listeners.size) { clearInterval(timer); timer = null; }
    };
  }, []);

  // Refresh the list when it's opened; close on a click elsewhere or Escape.
  useEffect(() => {
    if (!open) return undefined;
    beat();
    const onDown = (e) => { if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  // You are always online while looking at this, even before the first heartbeat lands.
  const list = users.some((u) => String(u.id) === String(meId)) || !me ? users : [{ id: meId, name: me, lastSeenMs: Date.now() }, ...users];
  const sorted = [...list].sort((x, y) => (String(x.id) === String(meId) ? -1 : String(y.id) === String(meId) ? 1 : (x.name || '').localeCompare(y.name || '')));
  const count = Math.max(sorted.length, 1);
  const initialOf = (n) => (n || '?').trim().charAt(0).toUpperCase();

  return (
    <div ref={boxRef} className="online-box">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <span aria-hidden="true" className="online-avatar">{initialOf(me)}</span>
        <span style={{ fontSize: 12, lineHeight: 1.3, minWidth: 0 }}>
          <span style={{ display: 'block' }}>{me}</span>
          <button type="button" className="online-toggle" aria-expanded={open} aria-haspopup="true" onClick={() => setOpen((o) => !o)}
            title="See who's online">
            <span className="online-dot" />{count} online now
            <span className={`online-caret${open ? ' up' : ''}`} aria-hidden="true" />
          </button>
        </span>
      </div>
      {open && (
        <div className="online-list" role="dialog" aria-label="Who's online">
          <div className="online-list-head">Online now · {count}</div>
          <ul>
            {sorted.map((u) => {
              const mine = String(u.id) === String(meId);
              return (
                <li key={u.id}>
                  <span className="online-avatar small" aria-hidden="true">{initialOf(u.name)}<span className="online-dot on-avatar" /></span>
                  <span className="online-name">{u.name || 'Unknown user'}{mine && <span className="online-you"> (you)</span>}</span>
                  <span className="online-when">{seenText(u.lastSeenMs, mine)}</span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

function seenText(ms, mine) {
  if (mine) return 'now';
  const mins = Math.floor((Date.now() - (ms || 0)) / 60000);
  return mins < 1 ? 'now' : `${mins} min ago`;
}

export function resetPresence() {
  cache = { at: 0, users: [] };
}

import { useEffect, useState } from 'react';
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

export default function WhoIsOnline({ me }) {
  const [users, setUsers] = useState(cache.users);
  useEffect(() => {
    listeners.add(setUsers);
    if (Date.now() - cache.at > 30000) beat();
    if (!timer) timer = setInterval(beat, 60000);
    return () => {
      listeners.delete(setUsers);
      if (!listeners.size) { clearInterval(timer); timer = null; }
    };
  }, []);

  const names = users.map((u) => u.name).filter(Boolean);
  const count = Math.max(users.length, 1);
  const initial = (me || '?').trim().charAt(0).toUpperCase();
  return (
    <div title={names.length ? `Online now: ${names.join(', ')}` : undefined} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
      <span aria-hidden="true" style={{ width: 26, height: 26, borderRadius: '50%', background: '#fff', color: 'var(--teal)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 12, flexShrink: 0 }}>{initial}</span>
      <span style={{ fontSize: 12, lineHeight: 1.3 }}>
        <span style={{ display: 'block' }}>{me}</span>
        <span style={{ opacity: 0.75 }}><span style={{ display: 'inline-block', width: 7, height: 7, borderRadius: '50%', background: '#4caf6a', marginRight: 5 }} />{count} online now</span>
      </span>
    </div>
  );
}

export function resetPresence() {
  cache = { at: 0, users: [] };
}

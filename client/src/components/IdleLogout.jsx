import { useEffect, useState } from 'react';
import { markActive, idleFor, IDLE_MS } from '../session';

// Logs you out after 30 minutes with no clicks, typing, scrolling or touches in
// any Work Desk tab. For the last 2 minutes a bar counts down with a
// "Stay logged in" button.
const WARN_MS = 2 * 60 * 1000;
const EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart', 'scroll', 'mousemove'];

export default function IdleLogout({ onIdle }) {
  const [left, setLeft] = useState(null); // ms until logout, while warning

  useEffect(() => {
    const active = () => markActive();
    EVENTS.forEach((e) => window.addEventListener(e, active, { passive: true, capture: true }));
    markActive(true);
    const tick = () => {
      const remaining = IDLE_MS - idleFor();
      if (remaining <= 0) { onIdle(); return; }
      setLeft(remaining <= WARN_MS ? remaining : null);
    };
    const t = setInterval(tick, 1000);
    // Waking a laptop / returning to the tab: check straight away.
    const onVisible = () => { if (!document.hidden) tick(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(t);
      EVENTS.forEach((e) => window.removeEventListener(e, active, { capture: true }));
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [onIdle]);

  if (left == null) return null;
  const secs = Math.ceil(left / 1000);
  const mmss = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
  return (
    <div className="idle-warning" role="alert">
      <span>No activity for a while — you'll be logged out in <strong>{mmss}</strong>.</span>
      <button type="button" className="btn btn-accent btn-sm" onClick={() => { markActive(true); setLeft(null); }}>Stay logged in</button>
    </div>
  );
}

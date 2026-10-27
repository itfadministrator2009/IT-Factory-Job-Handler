import { useEffect, useRef, useState } from 'react';
import { RotateCw } from 'lucide-react';
import api from '../api';

// Refresh button: reloads the page you're on. It lights up ("New changes")
// when someone else has saved, added or deleted something anywhere in Work Desk
// since this page loaded. It never reloads by itself, so nothing half-typed is lost.
const POLL_MS = 20000;

export default function RefreshButton() {
  const since = useRef(null); // server time when this page loaded
  const [count, setCount] = useState(0);

  useEffect(() => {
    let stopped = false;
    async function check() {
      if (document.hidden) return; // no polling from background tabs
      try {
        const { data } = await api.get('/presence/changes', { params: since.current ? { since: since.current } : {} });
        if (stopped) return;
        if (since.current == null) since.current = data.now;
        else setCount(data.byOthers || 0);
      } catch (e) { /* offline or signed out: try again next time */ }
    }
    check();
    const t = setInterval(check, POLL_MS);
    const onVisible = () => { if (!document.hidden) check(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { stopped = true; clearInterval(t); document.removeEventListener('visibilitychange', onVisible); };
  }, []);

  const label = count > 0 ? `${count} new change${count === 1 ? '' : 's'} by others — refresh` : 'Refresh this page';
  return (
    <button type="button" className={'refresh-btn' + (count > 0 ? ' has-changes' : '')} title={label} aria-label={label}
      onClick={() => window.location.reload()}>
      <RotateCw size={16} />
      {count > 0 && <span>New changes</span>}
    </button>
  );
}

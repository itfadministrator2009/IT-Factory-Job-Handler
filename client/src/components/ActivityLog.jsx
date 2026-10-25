import { useEffect, useRef, useState } from 'react';
import { LogIn, ShieldAlert, Users, Clock, DatabaseBackup, RotateCcw, Settings2, Info } from 'lucide-react';
import api from '../api';
import SearchField from './SearchField';

// Settings → Activity log: who did what, newest first.
const CATEGORIES = [
  { key: '', label: 'Everything' },
  { key: 'auth', label: 'Logins' },
  { key: 'user', label: 'Users' },
  { key: 'timecard', label: 'Time Card' },
  { key: 'backup', label: 'Backups' },
  { key: 'records', label: 'Restores' },
  { key: 'settings', label: 'Security' },
];

const ICON = { auth: LogIn, user: Users, timecard: Clock, backup: DatabaseBackup, records: RotateCcw, settings: Settings2 };
const WARN = new Set(['auth.login_failed', 'auth.code_failed', 'backup.failed', 'user.deleted', 'user.logged_out_all', 'settings.disk_alert']);

const dayKey = (iso) => new Date(iso).toLocaleDateString('en-CA'); // yyyy-mm-dd, local
function dayLabel(key) {
  const today = new Date().toLocaleDateString('en-CA');
  const y = new Date(); y.setDate(y.getDate() - 1);
  if (key === today) return 'Today';
  if (key === y.toLocaleDateString('en-CA')) return 'Yesterday';
  return new Date(`${key}T12:00:00`).toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}
const timeOf = (iso) => new Date(iso).toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit' });
const cleanIp = (ip) => String(ip || '').replace(/^::ffff:/, '');

export default function ActivityLog() {
  const [q, setQ] = useState('');
  const [category, setCategory] = useState('');
  const [userId, setUserId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [entries, setEntries] = useState([]);
  const [people, setPeople] = useState([]);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const seq = useRef(0);

  function load(append = false) {
    const n = ++seq.current;
    setLoading(true);
    setError('');
    const params = { q: q.trim() || undefined, category: category || undefined, userId: userId || undefined, from: from || undefined, to: to || undefined };
    if (append && entries.length) params.before = entries[entries.length - 1].id;
    api.get('/admin/activity', { params }).then(({ data }) => {
      if (n !== seq.current) return;
      setEntries((prev) => (append ? [...prev, ...data.entries] : data.entries));
      setMore(data.more);
      setPeople(data.people || []);
    }).catch((err) => {
      if (n === seq.current) setError(err.response?.data?.error || 'Could not load the activity log');
    }).finally(() => { if (n === seq.current) setLoading(false); });
  }

  // Search waits for a pause in typing; the other filters apply straight away.
  useEffect(() => {
    const t = setTimeout(() => load(false), q ? 300 : 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, category, userId, from, to]);

  const groups = [];
  entries.forEach((e) => {
    const k = dayKey(e.at);
    if (!groups.length || groups[groups.length - 1].key !== k) groups.push({ key: k, items: [] });
    groups[groups.length - 1].items.push(e);
  });
  const filtered = !!(q || category || userId || from || to);

  return (
    <div className="mu">
      <div className="mu-head">
        <div>
          <h3>Activity log</h3>
          <p>Who did what, and when — logins, user and access changes, timesheet approvals, log-outs, backups and restores. Kept for two years.</p>
        </div>
      </div>

      <div className="mu-toolbar">
        <div className="mu-filters" role="tablist" aria-label="Show">
          {CATEGORIES.map((c) => (
            <button key={c.key} type="button" role="tab" aria-selected={category === c.key}
              className={'mu-filter' + (category === c.key ? ' active' : '')} onClick={() => setCategory(c.key)}>
              {c.label}
            </button>
          ))}
        </div>
      </div>
      <div className="al-filters">
        <SearchField value={q} onChange={setQ} placeholder="Search people, names, details, IP…" busy={loading && !!q} style={{ flex: '1 1 260px', maxWidth: 380 }} />
        <select value={userId} onChange={(e) => setUserId(e.target.value)} aria-label="Person" className="al-select">
          <option value="">Anyone</option>
          {people.map((p) => <option key={p.id} value={p.id}>{p.name || 'Unknown'}</option>)}
        </select>
        <label className="al-date"><span>From</span><input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="al-date"><span>To</span><input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} /></label>
        {filtered && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setQ(''); setCategory(''); setUserId(''); setFrom(''); setTo(''); }}>Clear filters</button>
        )}
      </div>

      {error && <div className="error-banner" style={{ marginBottom: 12 }}>{error}</div>}

      <div className="panel mu-panel">
        {!entries.length ? (
          <div className="mu-empty" style={{ padding: 32 }}>
            {loading ? 'Loading…' : filtered ? 'Nothing matches those filters.' : 'Nothing recorded yet. Activity shows here from now on.'}
          </div>
        ) : groups.map((g) => (
          <section key={g.key} className="al-day">
            <h4 className="al-dayhead">{dayLabel(g.key)}</h4>
            <ul className="al-list">
              {g.items.map((e) => {
                const cat = e.action.split('.')[0];
                const Icon = WARN.has(e.action) ? ShieldAlert : (ICON[cat] || Info);
                return (
                  <li key={e.id} className={'al-row' + (WARN.has(e.action) ? ' warn' : '')}>
                    <span className="al-time">{timeOf(e.at)}</span>
                    <span className={`al-icon al-${cat}`} aria-hidden="true"><Icon size={15} /></span>
                    <div className="al-body">
                      <div className="al-line">
                        <strong>{e.userName || (e.action.startsWith('backup.') || e.action === 'settings.disk_alert' ? 'Work Desk' : 'Someone')}</strong>
                        <span className="al-what">{e.label.charAt(0).toLowerCase() + e.label.slice(1)}</span>
                        {e.targetName && <span className="al-target">{e.targetName}</span>}
                      </div>
                      {e.details && <div className="al-details">{e.details}</div>}
                    </div>
                    {e.ip && <span className="al-ip" title="IP address">{cleanIp(e.ip)}</span>}
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>

      {more && (
        <div style={{ textAlign: 'center', marginTop: 14 }}>
          <button type="button" className="btn btn-ghost" onClick={() => load(true)} disabled={loading}>{loading ? 'Loading…' : 'Show older'}</button>
        </div>
      )}
    </div>
  );
}

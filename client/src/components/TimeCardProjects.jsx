// ITF Time Card → Projects: the list of clients / projects contractors choose
// from. Admins add, rename, hide and merge them; renaming or merging updates
// every time entry already logged under the old name.
import { useEffect, useMemo, useState } from 'react';
import { Plus, Pencil, Merge, X, Check, AlertTriangle } from 'lucide-react';
import api from '../api';
import SearchField from './SearchField';
import { hrs, dmy } from './TimeCardShared';

const errText = (err) => err.response?.data?.error || 'Something went wrong — please try again.';
// For spotting near-duplicates: same letters ignoring capitals, spaces and
// punctuation ("Westmead Hospital" / "westmead-hospital"), a short ending left off
// ("Westmead Hosp"), or a typo or two ("Westmaed Hospital").
const squash = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
function distance(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 3;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const cur = [i];
    for (let j = 1; j <= b.length; j += 1) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}
function looksSame(x, y) {
  const a = squash(x); const b = squash(y);
  if (a.length < 4 || b.length < 4) return false;
  // Different numbers mean different things ("Job #10" / "Job #23").
  if (a.replace(/\D/g, '') !== b.replace(/\D/g, '')) return false;
  if (a === b) return true;
  const [s, l] = a.length < b.length ? [a, b] : [b, a];
  if (l.startsWith(s) && l.length - s.length <= 4) return true;
  return s.length >= 6 && distance(a, b) <= 2;
}
function possibleDuplicates(list) {
  const parent = list.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < list.length; i += 1) {
    for (let j = i + 1; j < list.length; j += 1) {
      if (looksSame(list[i].name, list[j].name)) parent[find(j)] = find(i);
    }
  }
  const groups = new Map();
  list.forEach((p, i) => { const r = find(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(p); });
  return [...groups.values()].filter((g) => g.length > 1);
}

export default function TimeCardProjects() {
  const [list, setList] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [q, setQ] = useState('');
  const [show, setShow] = useState('active');
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(null); // { id, name }
  const [selected, setSelected] = useState([]);
  const [merging, setMerging] = useState(null); // [projects]
  const [keepId, setKeepId] = useState('');

  useEffect(() => {
    api.get('/timecard/admin/projects').then((r) => setList(r.data.projects)).catch((e) => setError(errText(e)));
  }, []);

  async function act(fn, ok) {
    setBusy(true); setError(''); setNotice('');
    try {
      const { data } = await fn();
      setList(data.projects);
      if (ok) setNotice(typeof ok === 'function' ? ok(data) : ok);
      return true;
    } catch (e) { setError(errText(e)); return false; } finally { setBusy(false); }
  }

  const counts = useMemo(() => ({
    active: (list || []).filter((p) => p.active).length,
    hidden: (list || []).filter((p) => !p.active).length,
    all: (list || []).length,
  }), [list]);
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (list || [])
      .filter((p) => (show === 'all' ? true : show === 'active' ? p.active : !p.active))
      .filter((p) => !needle || p.name.toLowerCase().includes(needle));
  }, [list, q, show]);
  const dupes = useMemo(() => possibleDuplicates(list || []), [list]);

  function openMerge(projects) {
    // Keep the most-used one by default.
    const keep = [...projects].sort((a, b) => b.entries - a.entries)[0];
    setKeepId(keep.id);
    setMerging(projects);
  }
  async function doMerge() {
    const fromIds = merging.map((p) => p.id).filter((id) => id !== keepId);
    const ok = await act(() => api.post('/timecard/admin/projects/merge', { fromIds, intoId: keepId }),
      (d) => `Merged into “${d.result.into}” — ${d.result.entries} time entr${d.result.entries === 1 ? 'y' : 'ies'} moved.`);
    if (ok) { setMerging(null); setSelected([]); }
  }

  if (!list) return <div className="empty-state">{error || 'Loading…'}</div>;
  const allChecked = rows.length > 0 && rows.every((p) => selected.includes(p.id));

  return (
    <div className="mu">
      <div className="mu-head">
        <div>
          <h3>Clients &amp; projects</h3>
          <p>The list contractors choose from when they log hours. Rename or merge to tidy up spellings — every time entry already logged follows. Hide ones that are finished; their past hours stay in reports.</p>
        </div>
        <form className="tcp-add" onSubmit={(e) => { e.preventDefault(); act(() => api.post('/timecard/admin/projects', { name: newName }), `Added “${newName.trim()}”.`).then((ok) => ok && setNewName('')); }}>
          <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="New client / project" aria-label="New client / project" maxLength={200} />
          <button type="submit" className="btn btn-primary" disabled={busy || !newName.trim()}><Plus size={15} /> Add</button>
        </form>
      </div>

      {error && <div className="error-banner" style={{ marginBottom: 12 }}>{error}</div>}
      {notice && <div className="success-banner" style={{ marginBottom: 12 }}>{notice}</div>}

      {dupes.length > 0 && (
        <div className="tcp-dupes">
          <AlertTriangle size={16} />
          <div>
            <strong>{dupes.length} possible duplicate{dupes.length === 1 ? '' : 's'}</strong>
            <div className="tcp-dupe-list">
              {dupes.slice(0, 6).map((g) => (
                <button key={g.map((p) => p.id).join()} type="button" className="tcp-dupe" onClick={() => openMerge(g)}>
                  {g.map((p) => `“${p.name}”`).join(' · ')} <span>Merge…</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      <div className="mu-toolbar">
        <div className="mu-filters" role="tablist" aria-label="Show">
          {[['active', 'In the list'], ['hidden', 'Hidden'], ['all', 'All']].map(([k, label]) => (
            <button key={k} type="button" role="tab" aria-selected={show === k} className={'mu-filter' + (show === k ? ' active' : '')} onClick={() => setShow(k)}>
              {label} <span className="mu-count">{counts[k]}</span>
            </button>
          ))}
        </div>
        <SearchField value={q} onChange={setQ} placeholder="Search clients / projects…" style={{ flex: '1 1 240px', maxWidth: 340 }} />
      </div>

      {selected.length > 0 && (
        <div className="tcp-selbar">
          <span>{selected.length} selected</span>
          <button type="button" className="btn btn-primary btn-sm" disabled={selected.length < 2} onClick={() => openMerge(list.filter((p) => selected.includes(p.id)))}
            title={selected.length < 2 ? 'Select two or more to merge' : ''}><Merge size={14} /> Merge selected</button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setSelected([])}>Clear</button>
        </div>
      )}

      <div className="panel mu-panel">
        <table className="mu-table tcp-table">
          <thead>
            <tr>
              <th style={{ width: 36 }}><input type="checkbox" aria-label="Select all shown" checked={allChecked}
                onChange={(e) => setSelected(e.target.checked ? [...new Set([...selected, ...rows.map((p) => p.id)])] : selected.filter((id) => !rows.some((p) => p.id === id)))} /></th>
              <th>Client / project</th>
              <th className="num">Entries</th>
              <th className="num">Hours</th>
              <th className="num">People</th>
              <th>Last used</th>
              <th className="c">In the list</th>
              <th className="r"><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={8} className="mu-empty">{q ? 'Nothing matches that search.' : show === 'hidden' ? 'Nothing hidden.' : 'No clients / projects yet. They’re added here, or when contractors type a new one.'}</td></tr>}
            {rows.map((p) => (
              <tr key={p.id} className={p.active ? '' : 'tcp-hidden'}>
                <td><input type="checkbox" aria-label={`Select ${p.name}`} checked={selected.includes(p.id)}
                  onChange={(e) => setSelected(e.target.checked ? [...selected, p.id] : selected.filter((id) => id !== p.id))} /></td>
                <td>
                  {editing?.id === p.id ? (
                    <form className="tcp-rename" onSubmit={(e) => { e.preventDefault(); act(() => api.patch(`/timecard/admin/projects/${p.id}`, { name: editing.name }), 'Renamed.').then((ok) => ok && setEditing(null)); }}>
                      <input value={editing.name} autoFocus maxLength={200} aria-label="New name" onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                        onKeyDown={(e) => { if (e.key === 'Escape') setEditing(null); }} />
                      <button type="submit" className="mu-act" disabled={busy || !editing.name.trim()} aria-label="Save name"><Check size={16} /></button>
                      <button type="button" className="mu-act" onClick={() => setEditing(null)} aria-label="Cancel"><X size={16} /></button>
                    </form>
                  ) : (
                    <div>
                      <div className="mu-name">{p.name}</div>
                      {p.createdBy && p.createdBy !== 'Existing timesheets' && <div className="mu-email">Added by {p.createdBy}</div>}
                    </div>
                  )}
                </td>
                <td className="num">{p.entries.toLocaleString('en-AU')}</td>
                <td className="num">{hrs(p.hours)}</td>
                <td className="num">{p.people}</td>
                <td className="nowrap">{p.lastUsed ? dmy(p.lastUsed) : '—'}</td>
                <td className="c">
                  <button type="button" role="switch" aria-checked={p.active} disabled={busy} className={'mu-switch' + (p.active ? ' on' : '')}
                    aria-label={`Show ${p.name} in the list`} title={p.active ? 'Hide from the list' : 'Show in the list'}
                    onClick={() => act(() => api.patch(`/timecard/admin/projects/${p.id}`, { active: !p.active }), p.active ? `“${p.name}” hidden — contractors won’t see it in the list.` : `“${p.name}” is back in the list.`)}>
                    <span className="mu-knob" />
                  </button>
                </td>
                <td className="r">
                  <span className="mu-actions">
                    <button type="button" className="mu-act" title="Rename" aria-label={`Rename ${p.name}`} onClick={() => setEditing({ id: p.id, name: p.name })}><Pencil size={15} /></button>
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {merging && (
        <div className="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="tcp-merge-title" onClick={(e) => { if (e.target === e.currentTarget) setMerging(null); }}>
          <div className="modal-card">
            <div className="modal-header">
              <h3 id="tcp-merge-title">Merge clients / projects</h3>
              <button type="button" onClick={() => setMerging(null)} aria-label="Close"><X size={18} /></button>
            </div>
            <p className="tc-muted" style={{ marginBottom: 12 }}>Choose the name to keep. Time entries under the others move to it, and the others leave the list. This can’t be undone automatically.</p>
            <div className="tcp-merge-list">
              {merging.map((p) => (
                <label key={p.id} className={'tcp-merge-opt' + (keepId === p.id ? ' on' : '')}>
                  <input type="radio" name="keep" checked={keepId === p.id} onChange={() => setKeepId(p.id)} />
                  <span className="tcp-merge-name">{p.name}</span>
                  <span className="tc-muted">{p.entries} entr{p.entries === 1 ? 'y' : 'ies'} · {hrs(p.hours)} hrs</span>
                </label>
              ))}
            </div>
            <div className="tc-actions" style={{ marginTop: 16 }}>
              <button type="button" className="btn btn-ghost" onClick={() => setMerging(null)}>Cancel</button>
              <button type="button" className="btn btn-primary" disabled={busy || !keepId} onClick={doMerge}>
                <Merge size={15} /> Merge into “{merging.find((p) => p.id === keepId)?.name}”
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

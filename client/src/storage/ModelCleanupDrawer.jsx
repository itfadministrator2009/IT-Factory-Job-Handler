import { useState } from 'react';
import api from '../api';
import Drawer from './Drawer';

// Old "Clean up model names": spellings that share a model token (e.g.
// "E77830") are grouped so they can be renamed to one spelling. Only Model
// changes; Make is left alone.
const extractModelToken = (model) => {
  const m = String(model || '').match(/\b([A-Za-z]\d[\dA-Za-z]{2,6})\b/);
  return m ? m[1].toUpperCase() : null;
};

function buildGroups(models) {
  const byToken = new Map();
  models.forEach((m) => {
    const token = extractModelToken(m.model);
    if (!token) return;
    if (!byToken.has(token)) byToken.set(token, []);
    byToken.get(token).push(m);
  });
  return [...byToken.entries()].filter(([, v]) => v.length > 1).map(([token, variants]) => {
    const sorted = [...variants].sort((a, b) => b.count - a.count);
    return { token, variants: sorted, total: sorted.reduce((t, v) => t + v.count, 0) };
  }).sort((a, b) => b.total - a.total);
}

function Group({ group, onApplied }) {
  const [checked, setChecked] = useState(() => new Set(group.variants.map((_, i) => i)));
  const [name, setName] = useState(group.variants[0].model);
  const [state, setState] = useState('idle');
  const picked = group.variants.filter((_, i) => checked.has(i));
  const itemCount = picked.reduce((t, v) => t + v.count, 0);

  async function apply() {
    if (!name.trim() || picked.length === 0) return;
    if (!confirm(`Rename ${itemCount} item(s) across ${picked.length} spelling(s) to "${name.trim()}"? This cannot be undone.`)) return;
    setState('saving');
    try {
      await api.post('/storage/items/rename-model', { ids: picked.flatMap((v) => v.ids), model: name.trim() });
      setState('done');
      onApplied();
    } catch (err) {
      alert(err.response?.data?.error || 'Could not rename');
      setState('idle');
    }
  }

  return (
    <div className="panel panel-pad" style={{ marginBottom: 10, opacity: state === 'done' ? 0.4 : 1 }}>
      <div style={{ fontWeight: 700, marginBottom: 6 }}>{group.token} — {group.total} item(s) across {group.variants.length} spelling(s)</div>
      {group.variants.map((v, i) => (
        <label key={`${v.make}|${v.model}`} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, padding: '2px 0' }}>
          <input type="checkbox" checked={checked.has(i)} disabled={state !== 'idle'}
            onChange={() => setChecked((p) => { const n = new Set(p); if (n.has(i)) n.delete(i); else n.add(i); return n; })} />
          <span>{v.make || '—'} — {v.model || '—'}</span>
          <span style={{ color: 'var(--muted)' }}>({v.count})</span>
        </label>
      ))}
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <input value={name} onChange={(e) => setName(e.target.value)} disabled={state !== 'idle'} style={{ flex: 1, border: '1px solid var(--line)', borderRadius: 8, padding: '7px 10px' }} />
        <button type="button" className="btn btn-accent btn-sm" onClick={apply} disabled={state !== 'idle' || !picked.length}>
          {state === 'done' ? 'Applied ✓' : state === 'saving' ? 'Applying…' : 'Apply'}
        </button>
      </div>
    </div>
  );
}

export default function ModelCleanupDrawer({ clients, onClose, onChanged }) {
  const [client, setClient] = useState('__ALL__');
  const [groups, setGroups] = useState(null);
  const [loading, setLoading] = useState(false);

  async function load() {
    setGroups(null);
    setLoading(true);
    try {
      const { data } = await api.get('/storage/model-summary', { params: { client } });
      setGroups(buildGroups(data.models));
    } finally {
      setLoading(false);
    }
  }

  return (
    <Drawer title="Clean up model names" subtitle="Finds model names that are the same model spelled differently, so you can rename them to one spelling." onClose={onClose}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'end', marginBottom: 14 }}>
        <div className="field" style={{ margin: 0, minWidth: 240 }}>
          <label>Client</label>
          <select value={client} onChange={(e) => { setClient(e.target.value); setGroups(null); }}>
            <option value="__ALL__">All clients</option>
            {clients.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <button type="button" className="btn btn-accent btn-sm" onClick={load} disabled={loading}>{loading ? 'Loading…' : 'Load model names'}</button>
      </div>
      {groups && (groups.length === 0
        ? <div className="empty-state">No inconsistent variants found.</div>
        : groups.map((g) => <Group key={g.token} group={g} onApplied={onChanged} />))}
    </Drawer>
  );
}

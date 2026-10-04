import { useEffect, useState } from 'react';
import api from '../api';
import { noteTime } from './common';

// The old app's "Notes" section. Shows every note under `keys` (newest first)
// and adds new ones under `addKey`. `labels` (optional) names where a note came
// from when it isn't the item's own, e.g. "client:HP" → "Client HP".
export default function NotesPanel({ keys, addKey, labels = {}, title = 'Notes' }) {
  const [notes, setNotes] = useState(null);
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const keyList = keys.join(',');

  function load() {
    api.get('/storage/item-notes', { params: { keys: keyList } }).then((r) => setNotes(r.data.notes)).catch(() => setNotes([]));
  }
  useEffect(() => { load(); }, [keyList]); // eslint-disable-line react-hooks/exhaustive-deps

  async function add() {
    if (!text.trim()) { setError('Write a note before adding it.'); return; }
    setSaving(true); setError('');
    try {
      await api.post('/storage/item-notes', { itemKey: addKey, note: text.trim() });
      setText('');
      load();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not add the note');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{ marginTop: 18 }}>
      <h4 style={{ fontSize: 14, marginBottom: 8 }}>{title}</h4>
      {!notes ? <div style={{ fontSize: 13, color: 'var(--muted)' }}>Loading…</div> : notes.length === 0 ? (
        <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 8 }}>No notes yet — add the first one below.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 10, maxHeight: 260, overflowY: 'auto' }}>
          {notes.map((n) => (
            <div key={n.id} style={{ borderLeft: '3px solid var(--line)', paddingLeft: 10 }}>
              <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                {noteTime(n.created_at)} — {n.author || 'Unknown'}
                {n.item_key !== addKey && <span> · on {labels[n.item_key] || n.item_key}</span>}
              </div>
              <div style={{ fontSize: 13, whiteSpace: 'pre-wrap' }}>{n.note}</div>
            </div>
          ))}
        </div>
      )}
      {error && <div className="error-banner">{error}</div>}
      <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="Add a note…" rows={2} maxLength={4000}
        style={{ width: '100%', border: '1px solid var(--line)', borderRadius: 8, padding: '8px 10px', fontFamily: 'inherit', fontSize: 13 }} />
      <button type="button" className="btn btn-ghost btn-sm" onClick={add} disabled={saving} style={{ marginTop: 6 }}>{saving ? 'Adding…' : 'Add note'}</button>
    </div>
  );
}

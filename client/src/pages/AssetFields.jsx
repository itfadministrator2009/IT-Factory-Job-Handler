import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus, Trash2, X } from 'lucide-react';
import Layout from '../components/Layout';
import api from '../api';

const TYPES = [
  { value: 'text', label: 'Short text' },
  { value: 'textarea', label: 'Long text' },
  { value: 'number', label: 'Number' },
  { value: 'date', label: 'Date' },
  { value: 'dropdown', label: 'Dropdown (pick one)' },
  { value: 'multiselect', label: 'Dropdown (pick multiple)' },
];

export default function AssetFields() {
  const [fields, setFields] = useState(null);
  const [showAdd, setShowAdd] = useState(false);
  const [newLabel, setNewLabel] = useState('');
  const [newType, setNewType] = useState('text');
  const [newOptionsText, setNewOptionsText] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [editingOptionsFor, setEditingOptionsFor] = useState(null);
  const [optionsDraft, setOptionsDraft] = useState('');

  function load() {
    api.get('/assets/field-defs').then((res) => setFields(res.data.fields));
  }
  useEffect(() => { load(); }, []);

  async function handleAddField(e) {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      const options = (newType === 'dropdown' || newType === 'multiselect')
        ? newOptionsText.split(',').map((s) => s.trim()).filter(Boolean)
        : undefined;
      await api.post('/assets/field-defs', { label: newLabel, type: newType, options });
      setNewLabel(''); setNewType('text'); setNewOptionsText('');
      setShowAdd(false);
      load();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not add field');
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteField(field) {
    if (!confirm(`Remove the "${field.label}" field? Existing assets keep their data, but it won't be editable here anymore.`)) return;
    await api.delete(`/assets/field-defs/${field.id}`);
    load();
  }

  function openEditOptions(field) {
    setEditingOptionsFor(field);
    setOptionsDraft((field.options || []).join(', '));
  }

  async function handleSaveOptions() {
    const options = optionsDraft.split(',').map((s) => s.trim()).filter(Boolean);
    await api.patch(`/assets/field-defs/${editingOptionsFor.id}`, { options });
    setEditingOptionsFor(null);
    load();
  }

  return (
    <Layout>
      <Link to="/assets" className="back-link">&larr; Back to Asset Tracker</Link>
      <div className="page-header">
        <div>
          <h1>Manage Fields</h1>
          <div className="subtitle">Add fields, and edit dropdown options — changes apply everywhere immediately.</div>
        </div>
        <button className="btn btn-accent" onClick={() => setShowAdd((s) => !s)}>
          <Plus size={16} /> {showAdd ? 'Cancel' : 'Add field'}
        </button>
      </div>

      {showAdd && (
        <div className="panel" style={{ padding: 24, marginBottom: 20, maxWidth: 480 }}>
          {error && <div className="error-banner">{error}</div>}
          <form onSubmit={handleAddField}>
            <div className="field">
              <label>Field name</label>
              <input value={newLabel} onChange={(e) => setNewLabel(e.target.value)} placeholder="e.g. Warranty Expiry" required autoFocus />
            </div>
            <div className="field">
              <label>Type</label>
              <select value={newType} onChange={(e) => setNewType(e.target.value)}>
                {TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </div>
            {(newType === 'dropdown' || newType === 'multiselect') && (
              <div className="field">
                <label>Options (comma-separated)</label>
                <input value={newOptionsText} onChange={(e) => setNewOptionsText(e.target.value)} placeholder="e.g. Yes, No, Unknown" />
              </div>
            )}
            <button className="btn btn-accent" type="submit" disabled={saving}>{saving ? 'Adding…' : 'Add field'}</button>
          </form>
        </div>
      )}

      <div className="panel" style={{ padding: fields?.length ? 0 : 20 }}>
        {!fields ? (
          <div className="empty-state">Loading…</div>
        ) : (
          <table className="ticket-table">
            <thead>
              <tr><th>Field</th><th>Type</th><th>Options</th><th></th></tr>
            </thead>
            <tbody>
              {fields.map((f) => (
                <tr key={f.id}>
                  <td>{f.label}{f.is_core && <span style={{ color: 'var(--muted)', fontSize: 12 }}> (built-in)</span>}</td>
                  <td>{TYPES.find((t) => t.value === f.type)?.label || f.type}</td>
                  <td style={{ maxWidth: 300, fontSize: 12, color: 'var(--muted)' }}>
                    {f.options ? f.options.join(', ') : '—'}
                  </td>
                  <td>
                    <div style={{ display: 'flex', gap: 6 }}>
                      {(f.type === 'dropdown' || f.type === 'multiselect') && (
                        <button type="button" className="btn btn-ghost btn-sm" onClick={() => openEditOptions(f)}>Edit options</button>
                      )}
                      {!f.is_core && (
                        <button type="button" className="btn btn-ghost btn-sm icon-btn" style={{ color: 'var(--danger)' }} onClick={() => handleDeleteField(f)} title="Remove field">
                          <Trash2 size={13} />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {editingOptionsFor && (
        <div className="modal-overlay" onClick={() => setEditingOptionsFor(null)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Options for "{editingOptionsFor.label}"</h3>
              <button type="button" onClick={() => setEditingOptionsFor(null)}><X size={18} /></button>
            </div>
            <div className="field">
              <label>Comma-separated list</label>
              <textarea value={optionsDraft} onChange={(e) => setOptionsDraft(e.target.value)} style={{ minHeight: 120 }} />
            </div>
            <button className="btn btn-accent" style={{ width: '100%', justifyContent: 'center' }} onClick={handleSaveOptions}>Save options</button>
          </div>
        </div>
      )}
    </Layout>
  );
}

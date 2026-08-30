import { useEffect, useState } from 'react';
import { Trash2, Plus } from 'lucide-react';
import api from '../api';
import Layout from '../components/Layout';

export default function Templates() {
  const [templates, setTemplates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('');
  const [subject, setSubject] = useState('');
  const [priority, setPriority] = useState('');
  const [classifications, setClassifications] = useState('');
  const [items, setItems] = useState([]);
  const [itemDesc, setItemDesc] = useState('');
  const [saving, setSaving] = useState(false);

  function load() {
    setLoading(true);
    api.get('/templates').then((res) => {
      setTemplates(res.data.templates);
      setLoading(false);
    });
  }
  useEffect(() => { load(); }, []);

  function addItem() {
    if (!itemDesc.trim()) return;
    setItems((prev) => [...prev, { description: itemDesc.trim(), qty: 1, reference: '' }]);
    setItemDesc('');
  }

  async function handleCreate(e) {
    e.preventDefault();
    setSaving(true);
    const fields = {};
    if (subject) fields.subject = subject;
    if (priority) fields.priority = priority;
    if (classifications) fields.classifications = classifications;
    try {
      await api.post('/templates', { name, fields, items });
      setName(''); setSubject(''); setPriority(''); setClassifications(''); setItems([]);
      setShowForm(false);
      load();
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id) {
    if (!confirm('Delete this template?')) return;
    await api.delete(`/templates/${id}`);
    load();
  }

  return (
    <Layout>
      <div className="page-header">
        <div>
          <h1>Job Templates</h1>
          <div className="subtitle">Pre-fill recurring job types when logging a new job.</div>
        </div>
        <button className="btn btn-accent" onClick={() => setShowForm((s) => !s)}>
          <Plus size={16} /> {showForm ? 'Cancel' : 'New template'}
        </button>
      </div>

      {showForm && (
        <div className="panel" style={{ padding: 24, marginBottom: 20, maxWidth: 620 }}>
          <form onSubmit={handleCreate}>
            <div className="field">
              <label htmlFor="tname">Template name<span className="req">*</span></label>
              <input id="tname" value={name} onChange={(e) => setName(e.target.value)} required placeholder="e.g. Printer Collection" />
            </div>
            <div className="form-grid" style={{ marginBottom: 14 }}>
              <div className="field">
                <label htmlFor="tsubject">Default subject</label>
                <input id="tsubject" value={subject} onChange={(e) => setSubject(e.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="tpriority">Default priority</label>
                <select id="tpriority" value={priority} onChange={(e) => setPriority(e.target.value)}>
                  <option value="">-None-</option>
                  <option>Low</option><option>Medium</option><option>High</option><option>Urgent</option>
                </select>
              </div>
              <div className="field span-2">
                <label htmlFor="tclass">Default classifications</label>
                <input id="tclass" value={classifications} onChange={(e) => setClassifications(e.target.value)} />
              </div>
            </div>

            <label style={{ fontSize: 13, fontWeight: 600, marginBottom: 8, display: 'block' }}>Default equipment items</label>
            {items.length > 0 && (
              <div className="items-table" style={{ marginBottom: 10 }}>
                {items.map((it, i) => (
                  <div key={i} className="items-table-row" style={{ gridTemplateColumns: '1fr 32px' }}>
                    <span>{it.description}</span>
                    <button type="button" className="danger" onClick={() => setItems((prev) => prev.filter((_, idx) => idx !== i))}>
                      <Trash2 size={13} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div className="item-add-row" style={{ gridTemplateColumns: '1fr auto', marginBottom: 18 }}>
              <input placeholder="Equipment description" value={itemDesc} onChange={(e) => setItemDesc(e.target.value)} />
              <button type="button" className="btn btn-ghost btn-sm" onClick={addItem}><Plus size={14} /> Add</button>
            </div>

            <button className="btn btn-accent" type="submit" disabled={saving || !name.trim()}>
              {saving ? 'Saving…' : 'Save template'}
            </button>
          </form>
        </div>
      )}

      <div className="panel" style={{ padding: templates.length ? 0 : 20 }}>
        {loading ? (
          <div className="empty-state">Loading…</div>
        ) : templates.length === 0 ? (
          <div className="empty-state">
            <h3>No templates yet</h3>
            <p>Create one for job types you log often.</p>
          </div>
        ) : (
          <table className="ticket-table">
            <thead>
              <tr><th>Name</th><th>Default subject</th><th>Items</th><th></th></tr>
            </thead>
            <tbody>
              {templates.map((t) => (
                <tr key={t.id}>
                  <td>{t.name}</td>
                  <td>{t.fields.subject || <span style={{ color: 'var(--muted)' }}>—</span>}</td>
                  <td>{t.items.length}</td>
                  <td>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => handleDelete(t.id)}>
                      <Trash2 size={13} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Layout>
  );
}

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Folder, X } from 'lucide-react';
import api from '../api';
import Layout from '../components/Layout';
import { useAuth } from '../context/AuthContext';

// A minimal starter template used when the "blank" option is picked on New Project —
// gives the admin one real section/field to build outward from rather than an empty
// shell, since the JSON is hand-edited for now (no drag-and-drop builder yet).
const BLANK_TEMPLATE = {
  sections: [
    {
      id: 'section_1',
      title: 'Section 1',
      repeatable: false,
      fields: [
        { id: 'field_1', type: 'text', label: 'Question text', required: true },
      ],
    },
  ],
};

export default function Projects() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin' || user?.role === 'agent';
  const [projects, setProjects] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [templateText, setTemplateText] = useState(JSON.stringify(BLANK_TEMPLATE, null, 2));
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  function load() {
    api.get('/projects').then((res) => setProjects(res.data.projects));
  }
  useEffect(() => { load(); }, []);

  async function handleCreate(e) {
    e.preventDefault();
    setError('');
    let template;
    try {
      template = JSON.parse(templateText);
    } catch (err) {
      setError('Template is not valid JSON — check for a missing comma or bracket.');
      return;
    }
    setSaving(true);
    try {
      const { data } = await api.post('/projects', { name, description, template });
      setShowForm(false);
      setName(''); setDescription(''); setTemplateText(JSON.stringify(BLANK_TEMPLATE, null, 2));
      navigate(`/projects/${data.project.id}`);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not create project');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Layout>
      <div className="page-header">
        <div>
          <h1>Projects</h1>
          <div className="subtitle">{isAdmin ? 'Every project folder, with its own form template.' : 'Projects you\'ve been assigned to.'}</div>
        </div>
        {isAdmin && (
          <button className="btn btn-accent" onClick={() => setShowForm((s) => !s)}>
            <Plus size={16} /> {showForm ? 'Cancel' : 'New project'}
          </button>
        )}
      </div>

      {showForm && (
        <div className="panel" style={{ padding: 24, marginBottom: 20, maxWidth: 640 }}>
          {error && <div className="error-banner">{error}</div>}
          <form onSubmit={handleCreate}>
            <div className="field">
              <label htmlFor="pname">Project name</label>
              <input id="pname" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Harvey Norman" required />
            </div>
            <div className="field">
              <label htmlFor="pdesc">Description</label>
              <input id="pdesc" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What this project covers" />
            </div>
            <div className="field">
              <label htmlFor="ptemplate">Form template (JSON)</label>
              <textarea
                id="ptemplate"
                value={templateText}
                onChange={(e) => setTemplateText(e.target.value)}
                style={{ fontFamily: 'monospace', fontSize: 12, minHeight: 220 }}
              />
              <p style={{ fontSize: 12, color: 'var(--muted)', marginTop: 6 }}>
                Sections can be <code>repeatable</code>. Field types: text, textarea, date, datetime, yesno, photo, signature, instruction.
                Add <code>visibleIf</code>/<code>requiredIf</code>: <code>{'{ field: "id", equals: "No" }'}</code> or <code>{'{ field: "id", notEmpty: true }'}</code> or <code>{'{ field: "id", empty: true }'}</code>.
              </p>
            </div>
            <button className="btn btn-accent" type="submit" disabled={saving}>
              {saving ? 'Creating…' : 'Create project'}
            </button>
          </form>
        </div>
      )}

      <div className="kb-grid">
        {!projects ? (
          <div className="empty-state">Loading…</div>
        ) : projects.length === 0 ? (
          <div className="empty-state">
            <h3>No projects yet</h3>
            <p>{isAdmin ? 'Create one to get started.' : "You haven't been assigned to any projects yet."}</p>
          </div>
        ) : (
          projects.map((p) => (
            <div key={p.id} className="panel kb-card" onClick={() => navigate(`/projects/${p.id}`)}>
              <h4><Folder size={15} style={{ verticalAlign: -2, marginRight: 6 }} />{p.name}</h4>
              {p.description && <p>{p.description}</p>}
              <p style={{ marginTop: 8 }}>{p.entryCount} {p.entryCount === 1 ? 'entry' : 'entries'} · {p.assignedCount} assigned</p>
            </div>
          ))
        )}
      </div>
    </Layout>
  );
}

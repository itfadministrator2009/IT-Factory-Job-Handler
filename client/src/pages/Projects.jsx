import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Folder } from 'lucide-react';
import api from '../api';
import Layout from '../components/Layout';
import { useAuth } from '../context/AuthContext';
import TemplateBuilder, { blankTemplate } from '../components/TemplateBuilder';

export default function Projects() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin' || user?.role === 'agent';
  const [projects, setProjects] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [sections, setSections] = useState(blankTemplate().sections);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  function load() {
    api.get('/projects').then((res) => setProjects(res.data.projects));
  }
  useEffect(() => { load(); }, []);

  async function handleCreate(e) {
    e.preventDefault();
    setError('');
    if (sections.length === 0) {
      setError('Add at least one section before creating the project.');
      return;
    }
    if (sections.some((s) => s.fields.length === 0)) {
      setError('Every section needs at least one question — remove any empty sections or add a question to them.');
      return;
    }
    setSaving(true);
    try {
      const { data } = await api.post('/projects', { name, description, template: { sections } });
      setShowForm(false);
      setName(''); setDescription(''); setSections(blankTemplate().sections);
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
        <div className="panel" style={{ padding: 24, marginBottom: 20, maxWidth: 760 }}>
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

            <h3 style={{ fontSize: 15, marginTop: 22, marginBottom: 14 }}>Form</h3>
            <TemplateBuilder sections={sections} onChange={setSections} />

            <button className="btn btn-accent" type="submit" disabled={saving} style={{ marginTop: 10 }}>
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

import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import api from '../api';
import Layout from '../components/Layout';

export default function ArticleForm() {
  const { id } = useParams();
  const isEdit = !!id;
  const navigate = useNavigate();

  const [title, setTitle] = useState('');
  const [category, setCategory] = useState('General');
  const [body, setBody] = useState('');
  const [loading, setLoading] = useState(isEdit);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!isEdit) return;
    api.get(`/articles/${id}`).then((res) => {
      setTitle(res.data.article.title);
      setCategory(res.data.article.category);
      setBody(res.data.article.body);
      setLoading(false);
    });
  }, [id, isEdit]);

  async function handleSubmit(e) {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      if (isEdit) {
        const { data } = await api.patch(`/articles/${id}`, { title, category, body });
        navigate(`/kb/${data.article.slug}`);
      } else {
        const { data } = await api.post('/articles', { title, category, body });
        navigate(`/kb/${data.article.slug}`);
      }
    } catch (err) {
      setError(err.response?.data?.error || 'Could not save article');
      setSaving(false);
    }
  }

  if (loading) return <Layout><div className="empty-state">Loading…</div></Layout>;

  return (
    <Layout>
      <div className="page-header">
        <div>
          <h1>{isEdit ? 'Edit article' : 'New article'}</h1>
          <div className="subtitle">Help customers help themselves.</div>
        </div>
      </div>
      <div className="panel" style={{ padding: 28, maxWidth: 640 }}>
        {error && <div className="error-banner">{error}</div>}
        <form onSubmit={handleSubmit}>
          <div className="field">
            <label htmlFor="title">Title</label>
            <input id="title" value={title} onChange={(e) => setTitle(e.target.value)} required />
          </div>
          <div className="field">
            <label htmlFor="category">Category</label>
            <input id="category" value={category} onChange={(e) => setCategory(e.target.value)} placeholder="e.g. Account, Billing, Getting Started" />
          </div>
          <div className="field">
            <label htmlFor="body">Content</label>
            <textarea id="body" style={{ minHeight: 220 }} value={body} onChange={(e) => setBody(e.target.value)} required />
          </div>
          <button className="btn btn-accent" type="submit" disabled={saving}>
            {saving ? 'Saving…' : isEdit ? 'Save changes' : 'Publish article'}
          </button>
        </form>
      </div>
    </Layout>
  );
}

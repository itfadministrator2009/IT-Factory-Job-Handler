import { useEffect, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { Pencil, Trash2 } from 'lucide-react';
import api from '../api';
import Layout from '../components/Layout';
import { useAuth } from '../context/AuthContext';

export default function ArticleView() {
  const { slug } = useParams();
  const { user } = useAuth();
  const navigate = useNavigate();
  const isAgent = user?.role === 'agent' || user?.role === 'admin';
  const [article, setArticle] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get(`/articles/${slug}`).then((res) => setArticle(res.data.article)).catch(() => setError('Article not found'));
  }, [slug]);

  async function handleDelete() {
    if (!confirm('Delete this article? This can\'t be undone.')) return;
    await api.delete(`/articles/${article.id}`);
    navigate('/kb');
  }

  if (error) return <Layout><div className="empty-state"><h3>{error}</h3></div></Layout>;
  if (!article) return <Layout><div className="empty-state">Loading…</div></Layout>;

  return (
    <Layout>
      <Link to="/kb" className="back-link">&larr; Back to knowledge base</Link>
      <div className="page-header">
        <div>
          <span className="pill pill-status-Pending" style={{ marginBottom: 8 }}>{article.category}</span>
          <h1 style={{ marginTop: 8 }}>{article.title}</h1>
        </div>
        {isAgent && (
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-ghost btn-sm" onClick={() => navigate(`/kb/${article.id}/edit`)}>
              <Pencil size={14} /> Edit
            </button>
            <button className="btn btn-ghost btn-sm" onClick={handleDelete}>
              <Trash2 size={14} /> Delete
            </button>
          </div>
        )}
      </div>
      <div className="panel" style={{ padding: 28, maxWidth: 720 }}>
        <div className="comment-body" style={{ fontSize: 15, lineHeight: 1.7 }}>{article.body}</div>
      </div>
    </Layout>
  );
}

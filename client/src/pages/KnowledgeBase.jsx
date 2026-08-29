import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, Plus, BookOpen } from 'lucide-react';
import api from '../api';
import Layout from '../components/Layout';
import { useAuth } from '../context/AuthContext';

export default function KnowledgeBase() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const isAgent = user?.role === 'agent' || user?.role === 'admin';

  const [articles, setArticles] = useState([]);
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    api.get('/articles', { params: q ? { q } : {} }).then((res) => {
      setArticles(res.data.articles);
      setLoading(false);
    });
  }, [q]);

  useEffect(() => { load(); }, [load]);

  const grouped = articles.reduce((acc, a) => {
    (acc[a.category] ||= []).push(a);
    return acc;
  }, {});

  return (
    <Layout>
      <div className="page-header">
        <div>
          <h1>Knowledge base</h1>
          <div className="subtitle">Answers to common questions — search before filing a ticket.</div>
        </div>
        {isAgent && (
          <button className="btn btn-accent" onClick={() => navigate('/kb/new')}>
            <Plus size={16} /> New article
          </button>
        )}
      </div>

      <div className="kb-search">
        <Search size={17} />
        <input
          type="text"
          placeholder="Search articles…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>

      {loading ? (
        <div className="empty-state">Loading…</div>
      ) : articles.length === 0 ? (
        <div className="empty-state">
          <BookOpen size={28} style={{ marginBottom: 10, opacity: 0.5 }} />
          <h3>No articles yet</h3>
          <p>{isAgent ? 'Write your first help article to get started.' : 'Check back soon, or file a ticket for help.'}</p>
        </div>
      ) : (
        Object.entries(grouped).map(([category, items]) => (
          <div key={category} style={{ marginBottom: 24 }}>
            <h3 className="kb-category-title">{category}</h3>
            <div className="kb-grid">
              {items.map((a) => (
                <div key={a.id} className="panel kb-card" onClick={() => navigate(`/kb/${a.slug}`)}>
                  <h4>{a.title}</h4>
                  <p>{a.body.slice(0, 110)}{a.body.length > 110 ? '…' : ''}</p>
                </div>
              ))}
            </div>
          </div>
        ))
      )}
    </Layout>
  );
}

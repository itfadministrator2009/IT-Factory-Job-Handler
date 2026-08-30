import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search } from 'lucide-react';
import api from '../api';
import Layout from '../components/Layout';
import { useAuth } from '../context/AuthContext';
import { StatusPill, PriorityPill } from '../components/Pill';
import { formatDMY } from '../utils/date';

export default function Dashboard() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [stats, setStats] = useState(null);
  const [recent, setRecent] = useState([]);
  const [q, setQ] = useState('');

  useEffect(() => {
    api.get('/jobs/stats/summary').then((res) => setStats(res.data)).catch((err) => {
      console.error('Could not load dashboard stats:', err);
    });
    api.get('/jobs').then((res) => setRecent(res.data.jobs.slice(0, 8))).catch((err) => {
      console.error('Could not load recent jobs:', err);
    });
  }, []);

  function handleSearch(e) {
    e.preventDefault();
    if (!q.trim()) return;
    navigate(`/jobs?q=${encodeURIComponent(q.trim())}`);
  }

  return (
    <Layout>
      <div className="page-header">
        <div>
          <h1>Good to see you, {user?.name?.split(' ')[0]}</h1>
          <div className="subtitle">
            {(user?.role === 'admin' || user?.role === 'agent')
              ? "Here's what's happening across the job log today."
              : "Here's what's on your plate today."}
          </div>
        </div>
        <button className="btn btn-accent" onClick={() => navigate('/jobs/new')}>Log new job</button>
      </div>

      <form className="kb-search" onSubmit={handleSearch} style={{ maxWidth: 480 }}>
        <Search size={17} />
        <input
          type="text"
          placeholder="Search jobs by subject, contact, account…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </form>

      {stats && (
        <div className="stat-grid">
          <div className="stat-card">
            <div className="num">{stats.total}</div>
            <div className="label">Total jobs</div>
          </div>
          <div className="stat-card">
            <div className="num">{stats.byStatus.Open}</div>
            <div className="label">Open</div>
          </div>
          <div className="stat-card">
            <div className="num">{stats.byStatus['In Progress']}</div>
            <div className="label">In progress</div>
          </div>
          <div className="stat-card">
            <div className="num">{stats.byStatus.Complete}</div>
            <div className="label">Complete</div>
          </div>
          <div className="stat-card">
            <div className="num">{stats.byStatus.Collected}</div>
            <div className="label">Collected</div>
          </div>
          <div className="stat-card">
            <div className="num">{stats.unassigned}</div>
            <div className="label">Unassigned</div>
          </div>
          <div className="stat-card">
            <div className="num" style={{ color: stats.overdue > 0 ? '#c23f1c' : undefined }}>{stats.overdue}</div>
            <div className="label">Overdue</div>
          </div>
        </div>
      )}

      <div className="panel" style={{ padding: 20 }}>
        <h3 style={{ marginBottom: 14 }}>Recent jobs</h3>
        {recent.length === 0 ? (
          <div className="empty-state">
            <h3>No jobs logged yet</h3>
            <p>Click "Log new job" to add your first one.</p>
          </div>
        ) : (
          <table className="ticket-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Subject</th>
                <th>Contact</th>
                <th>Account Name</th>
                <th>Due Date</th>
                <th>Ticket Owner</th>
                <th>Status</th>
                <th>Priority</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((j) => (
                <tr key={j.id} className="clickable" onClick={() => navigate(`/jobs/${j.id}`)}>
                  <td className="ticket-num">#{j.job_number}</td>
                  <td>{j.subject}</td>
                  <td>{j.contact_name}</td>
                  <td>{j.account_name || <span style={{ color: 'var(--muted)' }}>—</span>}</td>
                  <td>{j.due_date ? formatDMY(j.due_date) : <span style={{ color: 'var(--muted)' }}>—</span>}</td>
                  <td>{j.owner?.name || <span style={{ color: 'var(--muted)' }}>Unassigned</span>}</td>
                  <td><StatusPill status={j.status} /></td>
                  <td><PriorityPill priority={j.priority} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Layout>
  );
}

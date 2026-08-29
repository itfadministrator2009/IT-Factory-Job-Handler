import { useEffect, useState, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { AlertTriangle } from 'lucide-react';
import api from '../api';
import Layout from '../components/Layout';
import { StatusPill, PriorityPill } from '../components/Pill';
import { formatDMY } from '../utils/date';

const STATUSES = ['Open', 'In Progress', 'On Hold', 'Resolved', 'Closed'];

export default function JobList() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [jobs, setJobs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState('');
  const [priority, setPriority] = useState('');
  const [overdueOnly, setOverdueOnly] = useState(false);
  const [q, setQ] = useState(searchParams.get('q') || '');
  const [users, setUsers] = useState([]);
  const [selected, setSelected] = useState(new Set());
  const [bulkStatus, setBulkStatus] = useState('');
  const [bulkOwner, setBulkOwner] = useState('');
  const [applying, setApplying] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    const params = {};
    if (status) params.status = status;
    if (priority) params.priority = priority;
    if (q) params.q = q;
    if (overdueOnly) params.overdue = '1';
    api.get('/jobs', { params }).then((res) => {
      setJobs(res.data.jobs);
      setLoading(false);
    });
  }, [status, priority, q, overdueOnly]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { api.get('/users').then((res) => setUsers(res.data.users)); }, []);
  useEffect(() => { setSelected(new Set()); }, [jobs.length === 0]);

  function toggleSelect(jobId) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(jobId)) next.delete(jobId); else next.add(jobId);
      return next;
    });
  }

  function toggleSelectAll() {
    if (selected.size === jobs.length) setSelected(new Set());
    else setSelected(new Set(jobs.map((j) => j.id)));
  }

  async function applyBulk() {
    if (!bulkStatus && !bulkOwner) return;
    setApplying(true);
    try {
      const payload = { ids: Array.from(selected) };
      if (bulkStatus) payload.status = bulkStatus;
      if (bulkOwner) payload.owner_id = bulkOwner === 'unassigned' ? null : bulkOwner;
      await api.patch('/jobs/bulk', payload);
      setSelected(new Set());
      setBulkStatus('');
      setBulkOwner('');
      load();
    } finally {
      setApplying(false);
    }
  }

  return (
    <Layout>
      <div className="page-header">
        <div>
          <h1>Jobs</h1>
          <div className="subtitle">Every job logged by the team.</div>
        </div>
        <button className="btn btn-accent" onClick={() => navigate('/jobs/new')}>Log new job</button>
      </div>

      <div className="ticket-filters">
        <input
          type="text"
          placeholder="Search subject, contact, account…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All statuses</option>
          {STATUSES.map((s) => <option key={s}>{s}</option>)}
        </select>
        <select value={priority} onChange={(e) => setPriority(e.target.value)}>
          <option value="">All priorities</option>
          <option>Low</option>
          <option>Medium</option>
          <option>High</option>
          <option>Urgent</option>
        </select>
        <label className="checkbox-label" style={{ marginLeft: 4 }}>
          <input type="checkbox" checked={overdueOnly} onChange={(e) => setOverdueOnly(e.target.checked)} />
          Overdue only
        </label>
      </div>

      {selected.size > 0 && (
        <div className="bulk-toolbar">
          <span>{selected.size} selected</span>
          <select value={bulkStatus} onChange={(e) => setBulkStatus(e.target.value)}>
            <option value="">Set status…</option>
            {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <select value={bulkOwner} onChange={(e) => setBulkOwner(e.target.value)}>
            <option value="">Set owner…</option>
            <option value="unassigned">Unassigned</option>
            {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
          <button type="button" onClick={applyBulk} disabled={applying || (!bulkStatus && !bulkOwner)}>
            {applying ? 'Applying…' : 'Apply'}
          </button>
          <button type="button" className="clear-selection" onClick={() => setSelected(new Set())}>Clear</button>
        </div>
      )}

      <div className="panel" style={{ padding: jobs.length ? 0 : 20 }}>
        {loading ? (
          <div>{[...Array(5)].map((_, i) => <div key={i} className="skeleton-row" />)}</div>
        ) : jobs.length === 0 ? (
          <div className="empty-state">
            <h3>No jobs found</h3>
            <p>Try adjusting your filters, or log a new job.</p>
          </div>
        ) : (
          <table className="ticket-table">
            <thead>
              <tr>
                <th style={{ width: 32 }}>
                  <input type="checkbox" checked={selected.size === jobs.length} onChange={toggleSelectAll} />
                </th>
                <th>#</th>
                <th>Subject</th>
                <th>Contact</th>
                <th>Account</th>
                <th>Owner</th>
                <th>Status</th>
                <th>Priority</th>
                <th>Due</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((j) => (
                <tr key={j.id} className="clickable">
                  <td onClick={(e) => e.stopPropagation()}>
                    <input type="checkbox" checked={selected.has(j.id)} onChange={() => toggleSelect(j.id)} />
                  </td>
                  <td className="ticket-num" onClick={() => navigate(`/jobs/${j.id}`)}>#{j.job_number}</td>
                  <td onClick={() => navigate(`/jobs/${j.id}`)}>{j.subject}</td>
                  <td onClick={() => navigate(`/jobs/${j.id}`)}>{j.contact_name}</td>
                  <td onClick={() => navigate(`/jobs/${j.id}`)}>{j.account_name || <span style={{ color: 'var(--muted)' }}>—</span>}</td>
                  <td onClick={() => navigate(`/jobs/${j.id}`)}>{j.owner?.name || <span style={{ color: 'var(--muted)' }}>Unassigned</span>}</td>
                  <td onClick={() => navigate(`/jobs/${j.id}`)}><StatusPill status={j.status} /></td>
                  <td onClick={() => navigate(`/jobs/${j.id}`)}><PriorityPill priority={j.priority} /></td>
                  <td onClick={() => navigate(`/jobs/${j.id}`)}>
                      {j.overdue
                      ? <span className="overdue-badge"><AlertTriangle size={11} /> {formatDMY(j.due_date)}</span>
                      : (j.due_date ? formatDMY(j.due_date) : <span style={{ color: 'var(--muted)' }}>—</span>)}
                  </td>
                  <td onClick={() => navigate(`/jobs/${j.id}`)} style={{ color: 'var(--muted)' }}>{formatDate(j.updated_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Layout>
  );
}

function formatDate(s) {
  const d = new Date(s.replace(' ', 'T') + 'Z');
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

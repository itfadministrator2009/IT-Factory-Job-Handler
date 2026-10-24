// ITF Time Card — admin pages: Dashboard (hours summaries and project reports),
// Approvals (approve / decline sent timesheets) and Approved (print and CSV).
import { useEffect, useMemo, useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { Check, X, Download, Printer, ChevronDown, BellRing, UserPlus } from 'lucide-react';
import api from '../api';
import Layout from '../components/Layout';
import { Donut, StatTile, SERIES, CHART_COLORS } from '../components/Charts';
import { hrs, money, dmy, StatusPill, WeekDetail, printApprovedWeeks } from '../components/TimeCardShared';

const errText = (err) => err.response?.data?.error || 'Something went wrong — please try again.';

function Tabs({ pending }) {
  const cls = ({ isActive }) => `settings-tab${isActive ? ' active' : ''}`;
  return (
    <div className="settings-tabs" style={{ marginBottom: 18 }}>
      <NavLink to="/timecard/approvals" className={cls}>Approvals{pending ? ` (${pending})` : ''}</NavLink>
      <NavLink to="/timecard/dashboard" className={cls}>Dashboard</NavLink>
      <NavLink to="/timecard/approved" className={cls}>Approved</NavLink>
    </div>
  );
}

function Header({ subtitle }) {
  const navigate = useNavigate();
  return (
    <div className="page-header">
      <div>
        <h1>ITF Time Card</h1>
        <div className="subtitle">{subtitle}</div>
      </div>
      <button type="button" className="btn btn-ghost" onClick={() => navigate('/settings')} title="Add contractors in Settings → Team members, with the Contractor role">
        <UserPlus size={15} /> Add a contractor
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------
function PendingCard({ week, selected, onSelect, onDone, busy, setBusy }) {
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState('');
  const [err, setErr] = useState('');
  const act = async (fn) => {
    setBusy(true); setErr('');
    try { await fn(); onDone(); } catch (e) { setErr(errText(e)); } finally { setBusy(false); }
  };
  return (
    <div className={`panel tc-panel tc-approval${selected ? ' tc-selected' : ''}`}>
      <div className="tc-approval-head">
        <label className="tc-check" title="Select for Approve selected">
          <input type="checkbox" checked={selected} onChange={(e) => onSelect(e.target.checked)} aria-label={`Select ${week.fullName}`} />
        </label>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="tc-approval-name">{week.fullName}{week.total > 40 && <span className="tc-status tc-status-waiting" style={{ marginLeft: 8 }}>Over 40 hrs</span>}</div>
          <div className="tc-muted">Week ending {dmy(week.weekEnding)} · sent {dmy(week.submittedDate)}{week.expenses.length ? ` · ${money(week.expenseTotal)} expenses` : ''}</div>
        </div>
        <div className="tc-approval-hours">{hrs(week.total)}<small> hrs</small></div>
      </div>
      <WeekDetail week={week} />
      {err && <div className="tc-err" style={{ marginTop: 10 }}>{err}</div>}
      {declining ? (
        <div className="tc-decline-form">
          <label htmlFor={`why-${week.id}`} className="tc-label">Reason for declining (emailed to {week.fullName.split(' ')[0] || 'them'})</label>
          <textarea id={`why-${week.id}`} rows={2} value={reason} autoFocus onChange={(e) => setReason(e.target.value)} placeholder="e.g. Tuesday is missing the project name" />
          <div className="tc-actions">
            <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => { setDeclining(false); setReason(''); }}>Cancel</button>
            <button type="button" className="btn btn-sm tc-btn-danger" disabled={busy || !reason.trim()}
              onClick={() => act(() => api.post(`/timecard/admin/weeks/${week.id}/decline`, { reason }))}>Decline and email</button>
          </div>
        </div>
      ) : (
        <div className="tc-actions">
          <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => setDeclining(true)}><X size={14} /> Decline</button>
          <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => act(() => api.post(`/timecard/admin/weeks/${week.id}/approve`))}><Check size={14} /> Approve</button>
        </div>
      )}
    </div>
  );
}

function Reminders() {
  const [data, setData] = useState(null);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.get('/timecard/admin/reminders').then((r) => setData(r.data)).catch(() => {}); }, []);
  if (!data) return null;
  const n = data.contractors.length;
  async function send() {
    if (!confirm(`Email a reminder to ${n} contractor${n === 1 ? '' : 's'} now?`)) return;
    setBusy(true); setMsg('');
    try { const r = await api.post('/timecard/admin/reminders/send'); setMsg(`Reminder sent to ${r.data.sent} contractor${r.data.sent === 1 ? '' : 's'}.`); } catch (e) { setMsg(errText(e)); } finally { setBusy(false); }
  }
  return (
    <div className="panel tc-panel tc-reminders">
      <BellRing size={16} style={{ color: 'var(--teal)', flex: 'none' }} />
      <div style={{ flex: 1, minWidth: 200 }}>
        {n === 0 ? <span>Every contractor has sent this week's timesheet.</span> : (
          <span><strong>{n} contractor{n === 1 ? " hasn't" : "s haven't"}</strong> sent this week's timesheet (or {n === 1 ? 'has' : 'have'} a declined week to fix): {data.contractors.map((c) => c.name).join(', ')}.</span>
        )}
        <div className="tc-muted" style={{ marginTop: 2 }}>{data.automatic ? 'Reminders go out automatically on Friday afternoons.' : 'Automatic Friday reminders are off.'}{msg && ` ${msg}`}</div>
      </div>
      {n > 0 && <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={send}>Send reminder now</button>}
    </div>
  );
}

function Approvals({ state, reload }) {
  const [selected, setSelected] = useState(new Set());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const pending = state.pending;
  useEffect(() => { setSelected((s) => new Set([...s].filter((id) => pending.some((w) => w.id === id)))); }, [pending]);

  async function approveSelected() {
    if (!confirm(`Approve ${selected.size} timesheet${selected.size === 1 ? '' : 's'}? Accounts and each contractor will be emailed.`)) return;
    setBusy(true); setMsg('');
    try {
      const { data } = await api.post('/timecard/admin/approve-bulk', { weekIds: [...selected] });
      setMsg(data.failures.length ? `Approved ${data.approved.length}. Not approved: ${data.failures.map((f) => f.message).join('; ')}` : `Approved ${data.approved.length} timesheet${data.approved.length === 1 ? '' : 's'}.`);
      setSelected(new Set());
      reload();
    } catch (e) { setMsg(errText(e)); } finally { setBusy(false); }
  }

  return (
    <>
      <Reminders />
      <div className="tc-bulkbar">
        <h2 className="tc-h2" style={{ margin: 0 }}>Waiting on approval</h2>
        {pending.length > 1 && (
          <label className="tc-muted" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <input type="checkbox" checked={selected.size === pending.length} onChange={(e) => setSelected(new Set(e.target.checked ? pending.map((w) => w.id) : []))} /> Select all
          </label>
        )}
        {selected.size > 0 && <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={approveSelected}><Check size={14} /> Approve selected ({selected.size})</button>}
      </div>
      {msg && <div className="tc-info" style={{ marginBottom: 12 }}>{msg}</div>}
      {pending.length === 0 ? <div className="panel tc-panel"><p className="tc-empty">Nothing waiting on approval right now.</p></div>
        : pending.map((w) => (
          <PendingCard key={w.id} week={w} busy={busy} setBusy={setBusy} onDone={reload}
            selected={selected.has(w.id)} onSelect={(on) => setSelected((s) => { const n = new Set(s); if (on) n.add(w.id); else n.delete(w.id); return n; })} />
        ))}

      <div className="panel tc-panel">
        <h2 className="tc-h2">Recent decisions</h2>
        {state.recent.length === 0 ? <p className="tc-empty">No approvals or declines yet.</p> : (
          <div className="tc-table-wrap">
            <table className="tc-table">
              <thead><tr><th>Contractor</th><th>Week ending</th><th>Status</th><th>By</th><th>On</th><th className="num">Hours</th></tr></thead>
              <tbody>{state.recent.map((w) => (
                <tr key={w.id}>
                  <td>{w.fullName}</td><td>{dmy(w.weekEnding)}</td>
                  <td><StatusPill status={w.status} />{w.declineReason && <div className="tc-muted" style={{ marginTop: 3 }}>{w.declineReason}</div>}</td>
                  <td>{w.approvedBy}</td><td>{dmy(w.approvalDate)}</td><td className="num">{hrs(w.total)}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------
function Dashboard({ state }) {
  const s = state.hoursSummary;
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [range, setRange] = useState(null);
  const [rangeErr, setRangeErr] = useState('');
  const [project, setProject] = useState('');
  const [weekly, setWeekly] = useState(null);

  useEffect(() => {
    setWeekly(null);
    api.get(`/timecard/admin/project-weekly?project=${encodeURIComponent(project)}`).then((r) => setWeekly(r.data.rows)).catch(() => setWeekly([]));
  }, [project]);

  async function calc(e) {
    e.preventDefault(); setRangeErr(''); setRange(null);
    try { const r = await api.get(`/timecard/admin/range?from=${from}&to=${to}`); setRange(r.data.totalHours); } catch (err) { setRangeErr(errText(err)); }
  }

  // Top 7 projects get a colour; the rest fold into "Other".
  const donut = useMemo(() => {
    const rows = state.projectBreakdown;
    const top = rows.slice(0, 7).map((p, i) => ({ label: p.clientProject, value: p.totalHours, color: SERIES[i] }));
    const rest = rows.slice(7).reduce((t, p) => t + p.totalHours, 0);
    if (rest > 0) top.push({ label: `Other (${rows.length - 7} projects)`, value: Math.round(rest * 100) / 100, color: CHART_COLORS.neutral });
    return top;
  }, [state.projectBreakdown]);

  const tiles = [
    ['This month', s.thisMonth], ['Last month', s.lastMonth], ['Last quarter', s.lastQuarter],
    ['Last year', s.lastYear], ['Last financial year', s.lastFinancialYear],
  ];
  return (
    <>
      <div className="tc-tiles">
        {tiles.map(([label, v], i) => <StatTile key={label} label={label} value={Number(hrs(v))} sub="approved hours" accent={i === 0 ? CHART_COLORS.blue : '#16241f'} />)}
        <StatTile label="Awaiting approval" value={state.pending.length} sub="timesheets" accent={CHART_COLORS.orange} />
        <StatTile label="Contractors" value={state.contractors.length} sub="with a login" accent={CHART_COLORS.aqua} />
      </div>
      <p className="tc-muted" style={{ margin: '-6px 0 16px' }}>Approved hours are counted by each timesheet's week-ending date. The financial year runs 1 July – 30 June.</p>

      <form className="panel tc-panel tc-range" onSubmit={calc}>
        <h2 className="tc-h2" style={{ width: '100%' }}>Approved hours for a date range</h2>
        <div className="field"><label htmlFor="r-from">From</label><input id="r-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} required /></div>
        <div className="field"><label htmlFor="r-to">To</label><input id="r-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} required /></div>
        <button className="btn btn-ghost" type="submit">Calculate</button>
        <div className="tc-range-result">{range != null ? <>{hrs(range)}<small> hrs</small></> : '—'}</div>
        {rangeErr && <div className="tc-err" style={{ width: '100%' }}>{rangeErr}</div>}
      </form>

      <div className="tc-two">
        <div className="panel tc-panel">
          <h2 className="tc-h2">Hours by client / project (all time)</h2>
          {donut.length === 0 ? <p className="tc-empty">No approved hours yet.</p>
            : <Donut data={donut} centerValue={Math.round(state.projectBreakdown.reduce((t, p) => t + p.totalHours, 0))} centerLabel="approved hrs" size={180} onSelect={(d) => !d.label.startsWith('Other (') && setProject(d.label === '(No project)' ? '' : d.label)} />}
        </div>
        <div className="panel tc-panel">
          <h2 className="tc-h2">Weekly hours</h2>
          <div className="field" style={{ maxWidth: 360 }}>
            <label htmlFor="pw-project">Client / project</label>
            <select id="pw-project" value={project} onChange={(e) => setProject(e.target.value)}>
              <option value="">All projects</option>
              {state.projects.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </div>
          {weekly == null ? <p className="tc-empty">Loading…</p> : weekly.length === 0 ? <p className="tc-empty">No approved hours yet.</p> : (
            <div className="tc-table-wrap" style={{ maxHeight: 340, overflowY: 'auto' }}>
              <table className="tc-table">
                <thead><tr><th>Week ending</th><th className="num">Approved hours</th></tr></thead>
                <tbody>{weekly.map((r) => <tr key={r.weekEnding}><td>{dmy(r.weekEnding)}</td><td className="num strong">{hrs(r.totalHours)}</td></tr>)}</tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Approved
// ---------------------------------------------------------------------------
function Approved({ state }) {
  const [userId, setUserId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [weeks, setWeeks] = useState(null);
  const [open, setOpen] = useState(null);
  const [err, setErr] = useState('');
  const query = new URLSearchParams(Object.entries({ userId, from, to }).filter(([, v]) => v)).toString();

  useEffect(() => {
    setWeeks(null);
    api.get(`/timecard/admin/approved?${query}`).then((r) => setWeeks(r.data.weeks)).catch((e) => { setErr(errText(e)); setWeeks([]); });
  }, [query]);

  async function downloadCsv() {
    setErr('');
    try {
      const res = await api.get(`/timecard/admin/approved.csv?${query}`, { responseType: 'blob' });
      const url = URL.createObjectURL(res.data);
      const a = document.createElement('a');
      a.href = url; a.download = `approved-timesheets${userId ? `-${(state.contractors.find((c) => c.id === userId)?.name || '').replace(/\W+/g, '-').toLowerCase()}` : ''}.csv`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch (e) { setErr('Could not download the CSV.'); }
  }

  const who = state.contractors.find((c) => c.id === userId)?.name;
  const totals = (weeks || []).reduce((t, w) => ({ h: t.h + w.total, p: t.p + (w.estPay || 0), x: t.x + w.expenseTotal }), { h: 0, p: 0, x: 0 });
  return (
    <>
      <div className="panel tc-panel tc-filters">
        <div className="field"><label htmlFor="ap-user">Contractor</label>
          <select id="ap-user" value={userId} onChange={(e) => setUserId(e.target.value)}>
            <option value="">All contractors</option>
            {state.contractors.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select></div>
        <div className="field"><label htmlFor="ap-from">Week ending from</label><input id="ap-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
        <div className="field"><label htmlFor="ap-to">to</label><input id="ap-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></div>
        <div className="tc-filter-btns">
          <button type="button" className="btn btn-ghost" disabled={!weeks?.length} onClick={() => printApprovedWeeks(weeks, `Approved timesheets${who ? ` — ${who}` : ''}`)}><Printer size={15} /> Print</button>
          <button type="button" className="btn btn-ghost" onClick={downloadCsv}><Download size={15} /> Download CSV</button>
        </div>
      </div>
      {err && <div className="error-banner">{err}</div>}
      {weeks == null ? <div className="empty-state">Loading…</div> : weeks.length === 0 ? <div className="panel tc-panel"><p className="tc-empty">No approved weeks{who ? ` for ${who}` : ''}.</p></div> : (
        <div className="panel tc-panel">
          <div className="tc-muted" style={{ marginBottom: 10 }}>{weeks.length} week{weeks.length === 1 ? '' : 's'} · <strong>{hrs(totals.h)} hrs</strong>{totals.p ? <> · est. pay <strong>{money(totals.p)}</strong></> : null}{totals.x ? <> · expenses <strong>{money(totals.x)}</strong></> : null}</div>
          <ul className="tc-history">
            {weeks.map((w) => (
              <li key={w.id}>
                <button type="button" className="tc-history-head" aria-expanded={open === w.id} onClick={() => setOpen(open === w.id ? null : w.id)}>
                  <span className="tc-history-name">{w.fullName}</span>
                  <span className="tc-history-meta">Week ending {dmy(w.weekEnding)} · approved by {w.approvedBy} {dmy(w.approvalDate)}{w.estPay != null ? ` · est. ${money(w.estPay)}` : ''}</span>
                  <span className="tc-history-hours">{hrs(w.total)} hrs</span>
                  <ChevronDown size={15} className={open === w.id ? 'tc-rot' : ''} />
                </button>
                {open === w.id && <div className="tc-history-body"><WeekDetail week={w} /></div>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

const SUBTITLES = {
  approvals: 'Approve or decline the timesheets contractors have sent.',
  dashboard: 'Approved hours at a glance, by period and by client / project.',
  approved: 'Every approved timesheet — print it or download a CSV for payroll.',
};

export default function TimeCardAdmin({ view = 'approvals' }) {
  const [state, setState] = useState(null);
  const [error, setError] = useState('');
  const load = () => api.get('/timecard/admin').then((r) => { setState(r.data); setError(''); window.dispatchEvent(new Event('timecard:changed')); }).catch((e) => setError(errText(e)));
  useEffect(() => { load(); }, []);
  return (
    <Layout>
      <Header subtitle={SUBTITLES[view]} />
      <Tabs pending={state?.pending.length} />
      {error && <div className="error-banner">{error}</div>}
      {!state ? <div className="empty-state">{error ? '' : 'Loading…'}</div> : (
        view === 'dashboard' ? <Dashboard state={state} />
          : view === 'approved' ? <Approved state={state} />
            : <Approvals state={state} reload={load} />
      )}
    </Layout>
  );
}

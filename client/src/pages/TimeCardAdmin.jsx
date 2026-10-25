// ITF Time Card — admin pages: Dashboard (hours summaries and project reports),
// Approvals (approve / decline sent timesheets), Approved (print and CSV) and
// Reports (hours and pay for each person).
import { useEffect, useMemo, useState } from 'react';
import { NavLink, useNavigate, useSearchParams } from 'react-router-dom';
import { Check, X, Download, Printer, ChevronDown, ChevronUp, BellRing, UserPlus } from 'lucide-react';
import api from '../api';
import Layout from '../components/Layout';
import SearchField from '../components/SearchField';
import { Donut, StatTile, SERIES, CHART_COLORS } from '../components/Charts';
import { hrs, money, dmy, StatusPill, WeekDetail, printApprovedWeeks } from '../components/TimeCardShared';

const errText = (err) => err.response?.data?.error || 'Something went wrong — please try again.';

function Tabs({ pending }) {
  const cls = ({ isActive }) => `settings-tab${isActive ? ' active' : ''}`;
  return (
    <div className="settings-tabs" style={{ marginBottom: 18 }}>
      <NavLink to="/timecard/dashboard" className={cls}>Dashboard</NavLink>
      <NavLink to="/timecard/approvals" className={cls}>Approvals{pending ? ` (${pending})` : ''}</NavLink>
      <NavLink to="/timecard/approved" className={cls}>Approved</NavLink>
      <NavLink to="/timecard/reports" className={cls}>Reports</NavLink>
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
      <button type="button" className="btn btn-ghost" onClick={() => navigate('/settings')} title="Add casuals in Settings → Manage Users, with the Casual role">
        <UserPlus size={15} /> Add a casual
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
    if (!confirm(`Email a reminder to ${n} casual${n === 1 ? '' : 's'} now?`)) return;
    setBusy(true); setMsg('');
    try { const r = await api.post('/timecard/admin/reminders/send'); setMsg(`Reminder sent to ${r.data.sent} casual${r.data.sent === 1 ? '' : 's'}.`); } catch (e) { setMsg(errText(e)); } finally { setBusy(false); }
  }
  return (
    <div className="panel tc-panel tc-reminders">
      <BellRing size={16} style={{ color: 'var(--teal)', flex: 'none' }} />
      <div style={{ flex: 1, minWidth: 200 }}>
        {n === 0 ? <span>Every casual has sent this week's timesheet.</span> : (
          <span><strong>{n} casual{n === 1 ? " hasn't" : "s haven't"}</strong> sent this week's timesheet (or {n === 1 ? 'has' : 'have'} a declined week to fix): {data.contractors.map((c) => c.name).join(', ')}.</span>
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
    if (!confirm(`Approve ${selected.size} timesheet${selected.size === 1 ? '' : 's'}? Accounts and each casual will be emailed.`)) return;
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
              <thead><tr><th>Casual</th><th>Week ending</th><th>Status</th><th>By</th><th>On</th><th className="num">Hours</th></tr></thead>
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
// Hours per person: searchable, sortable; click someone to see their approved weeks.
const PEOPLE_COLS = [
  ['name', 'Name'], ['thisMonth', 'This month'], ['lastMonth', 'Last month'], ['thisFy', 'This financial year'],
  ['allTime', 'All time'], ['waiting', 'Waiting'], ['estPayThisMonth', 'Est. pay this month'], ['lastSent', 'Last sent'],
];
function PeopleHours({ people: allPeople }) {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState({ key: 'thisMonth', dir: -1 });
  // Custom dates: approved hours per person between two week-ending dates.
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [custom, setCustom] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  async function runCustom(e) {
    e.preventDefault(); setErr(''); setBusy(true);
    try {
      const r = await api.get(`/timecard/admin/hours?from=${from}&to=${to}`);
      setCustom(r.data);
      setSort({ key: 'custom', dir: -1 });
    } catch (x) { setErr(errText(x)); setCustom(null); } finally { setBusy(false); }
  }
  function clearCustom() {
    setCustom(null); setFrom(''); setTo('');
    setSort((s) => (s.key === 'custom' ? { key: 'thisMonth', dir: -1 } : s));
  }
  const people = allPeople.map((p) => ({ ...p, custom: custom ? (custom.hours[p.id] || 0) : 0 }));
  const cols = custom
    ? [...PEOPLE_COLS.slice(0, 4), ['custom', `${dmy(custom.from)} – ${dmy(custom.to)}`], ...PEOPLE_COLS.slice(4)]
    : PEOPLE_COLS;
  const q = query.trim().toLowerCase();
  const rows = people
    .filter((p) => !q || `${p.name} ${p.email}`.toLowerCase().includes(q))
    .sort((a, b) => {
      const av = a[sort.key] ?? ''; const bv = b[sort.key] ?? '';
      const c = typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv));
      return (c || a.name.localeCompare(b.name)) * (c ? sort.dir : 1);
    });
  const totals = rows.reduce((t, p) => ({
    thisMonth: t.thisMonth + p.thisMonth, lastMonth: t.lastMonth + p.lastMonth, thisFy: t.thisFy + p.thisFy,
    allTime: t.allTime + p.allTime, waiting: t.waiting + p.waiting, pay: t.pay + (p.estPayThisMonth || 0), custom: t.custom + p.custom,
  }), { thisMonth: 0, lastMonth: 0, thisFy: 0, allTime: 0, waiting: 0, pay: 0, custom: 0 });
  const by = (key) => setSort((s) => ({ key, dir: s.key === key ? -s.dir : (key === 'name' || key === 'lastSent' ? 1 : -1) }));
  return (
    <div className="panel tc-panel">
      <div className="tc-people-head">
        <div>
          <h2 className="tc-h2" style={{ marginBottom: 2 }}>Hours by person</h2>
          <p className="tc-muted">Approved hours, by each timesheet's week-ending date. Click someone to see their approved weeks.</p>
        </div>
        <SearchField value={query} onChange={setQuery} placeholder="Search by name or email" label="Search people" style={{ maxWidth: 300, flex: '1 1 220px' }} />
      </div>
      <form className="tc-pay-custom" onSubmit={runCustom}>
        <span className="tc-label">Custom dates</span>
        <div className="field"><label htmlFor="hrs-from">From</label><input id="hrs-from" type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} required /></div>
        <div className="field"><label htmlFor="hrs-to">To</label><input id="hrs-to" type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} required /></div>
        <button className="btn btn-ghost btn-sm" type="submit" disabled={busy}>{busy ? 'Working…' : 'Show'}</button>
        {custom && <button className="btn btn-ghost btn-sm" type="button" onClick={clearCustom}>Clear</button>}
        {err && <span className="tc-err">{err}</span>}
      </form>
      <div className="tc-table-wrap">
        <table className="tc-table tc-people">
          <thead>
            <tr>
              {cols.map(([key, label]) => (
                <th key={key} className={`${key === 'name' || key === 'lastSent' ? '' : 'num'}${key === 'custom' ? ' tc-pay-customcol' : ''}`} aria-sort={sort.key === key ? (sort.dir > 0 ? 'ascending' : 'descending') : 'none'}>
                  <button type="button" className="tc-sort" onClick={() => by(key)}>
                    {label}{sort.key === key && (sort.dir > 0 ? <ChevronUp size={12} /> : <ChevronDown size={12} />)}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.id} className="tc-click" onClick={() => navigate(`/timecard/approved?userId=${encodeURIComponent(p.id)}`)} title={`See ${p.name}'s approved weeks`}>
                <td>
                  <div className="strong">{p.name}{!p.active && <span className="tc-status tc-status-draft" style={{ marginLeft: 8 }}>No longer logs time</span>}</div>
                  <div className="tc-muted">{p.email}{p.hourlyRate ? ` · ${money(p.hourlyRate)}/hr` : ''}</div>
                </td>
                <td className="num strong">{hrs(p.thisMonth)}</td>
                <td className="num">{hrs(p.lastMonth)}</td>
                <td className="num">{hrs(p.thisFy)}</td>
                {custom && <td className="num strong tc-pay-customcol">{p.custom ? hrs(p.custom) : <span className="tc-muted">—</span>}</td>}
                <td className="num">{hrs(p.allTime)}</td>
                <td className="num">{p.waiting ? <span className="tc-waiting">{hrs(p.waiting)}</span> : <span className="tc-muted">—</span>}</td>
                <td className="num">{p.estPayThisMonth != null ? money(p.estPayThisMonth) : <span className="tc-muted">—</span>}</td>
                <td className="nowrap">{p.lastSent ? dmy(p.lastSent) : <span className="tc-muted">Never</span>}</td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={cols.length} className="tc-muted" style={{ textAlign: 'center', padding: 22 }}>{q ? `No one matches “${query}”.` : 'No one logs time yet.'}</td></tr>}
          </tbody>
          {rows.length > 1 && (
            <tfoot>
              <tr>
                <td className="strong">Total ({rows.length} {rows.length === 1 ? 'person' : 'people'})</td>
                <td className="num strong">{hrs(totals.thisMonth)}</td><td className="num strong">{hrs(totals.lastMonth)}</td>
                <td className="num strong">{hrs(totals.thisFy)}</td>
                {custom && <td className="num strong tc-pay-customcol">{hrs(totals.custom)}</td>}
                <td className="num strong">{hrs(totals.allTime)}</td>
                <td className="num strong">{hrs(totals.waiting)}</td><td className="num strong">{totals.pay ? money(totals.pay) : '—'}</td><td />
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );
}

// Paid to each person: approved hours × hourly rate, plus approved expenses, for
// finished periods and a custom date range (by week-ending date).
function PayCell({ v }) {
  if (!v || (!v.hours && !v.expenses)) return <span className="tc-muted">—</span>;
  return (
    <>
      <div className={v.noRate ? 'tc-muted' : 'strong'}>{v.noRate && !v.expenses ? 'No rate set' : money(v.total)}</div>
      <div className="tc-pay-sub">{hrs(v.hours)} hrs{v.expenses ? ` · ${money(v.expenses)} exp.` : ''}{v.noRate && v.expenses ? ' · no rate' : ''}</div>
    </>
  );
}
function PayByPerson({ people, pay }) {
  const [query, setQuery] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [custom, setCustom] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  async function run(e) {
    e.preventDefault(); setErr(''); setBusy(true);
    try { const r = await api.get(`/timecard/admin/pay?from=${from}&to=${to}`); setCustom(r.data); } catch (x) { setErr(errText(x)); setCustom(null); } finally { setBusy(false); }
  }
  const cols = [...pay.periods.map((p) => ({ key: p.key, label: p.label, sub: `${dmy(p.from)} – ${dmy(p.to)}`, data: pay.byPeriod[p.key] }))];
  if (custom) cols.push({ key: 'custom', label: 'Custom', sub: `${dmy(custom.from)} – ${dmy(custom.to)}`, data: custom.pay });
  const q = query.trim().toLowerCase();
  const rows = people.filter((p) => !q || `${p.name} ${p.email}`.toLowerCase().includes(q))
    .filter((p) => p.active || cols.some((c) => c.data[p.id]));
  const total = (c) => rows.reduce((t, p) => t + (c.data[p.id]?.total || 0), 0);
  const noRate = rows.some((p) => cols.some((c) => c.data[p.id]?.noRate));
  return (
    <div className="panel tc-panel">
      <div className="tc-people-head">
        <div>
          <h2 className="tc-h2" style={{ marginBottom: 2 }}>Paid to each person</h2>
          <p className="tc-muted">Approved timesheets only: hours × hourly rate, plus approved expenses. Counted by week-ending date.</p>
        </div>
        <SearchField value={query} onChange={setQuery} placeholder="Search by name or email" label="Search pay" style={{ maxWidth: 300, flex: '1 1 220px' }} />
      </div>
      <form className="tc-pay-custom" onSubmit={run}>
        <span className="tc-label">Custom dates</span>
        <div className="field"><label htmlFor="pay-from">From</label><input id="pay-from" type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} required /></div>
        <div className="field"><label htmlFor="pay-to">To</label><input id="pay-to" type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} required /></div>
        <button className="btn btn-ghost btn-sm" type="submit" disabled={busy}>{busy ? 'Working…' : 'Show'}</button>
        {custom && <button className="btn btn-ghost btn-sm" type="button" onClick={() => { setCustom(null); setFrom(''); setTo(''); }}>Clear</button>}
        {err && <span className="tc-err">{err}</span>}
      </form>
      <div className="tc-table-wrap">
        <table className="tc-table tc-people tc-pay">
          <thead>
            <tr>
              <th>Name</th>
              {cols.map((c) => <th key={c.key} className={`num${c.key === 'custom' ? ' tc-pay-customcol' : ''}`}>{c.label}<div className="tc-pay-range">{c.sub}</div></th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.id}>
                <td>
                  <div className="strong">{p.name}</div>
                  <div className="tc-muted">{p.hourlyRate ? `${money(p.hourlyRate)}/hr` : 'No hourly rate'}</div>
                </td>
                {cols.map((c) => <td key={c.key} className={`num${c.key === 'custom' ? ' tc-pay-customcol' : ''}`}><PayCell v={c.data[p.id]} /></td>)}
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={cols.length + 1} className="tc-muted" style={{ textAlign: 'center', padding: 22 }}>{q ? `No one matches “${query}”.` : 'No one logs time yet.'}</td></tr>}
          </tbody>
          {rows.length > 1 && (
            <tfoot>
              <tr>
                <td className="strong">Total</td>
                {cols.map((c) => <td key={c.key} className={`num strong${c.key === 'custom' ? ' tc-pay-customcol' : ''}`}>{money(total(c))}</td>)}
              </tr>
            </tfoot>
          )}
        </table>
      </div>
      {noRate && <p className="tc-muted" style={{ marginTop: 8 }}>“No rate set”: add an hourly rate in Settings → Manage Users to include their wages. Pay uses each person's current rate.</p>}
    </div>
  );
}

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
        <StatTile label="Casuals" value={state.contractors.length} sub="with a login" accent={CHART_COLORS.aqua} />
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
  const [params] = useSearchParams();
  const [userId, setUserId] = useState(() => params.get('userId') || '');
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
        <div className="field"><label htmlFor="ap-user">Casual</label>
          <select id="ap-user" value={userId} onChange={(e) => setUserId(e.target.value)}>
            <option value="">All casuals</option>
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
  approvals: 'Approve or decline the timesheets casuals have sent.',
  dashboard: 'Approved hours at a glance, by period and by client / project.',
  approved: 'Every approved timesheet — print it or download a CSV for payroll.',
  reports: 'Hours and pay for each person, by period or for your own dates.',
};

// Reports: hours by person and what each person was paid.
function Reports({ state }) {
  return (
    <>
      <PeopleHours people={state.people || []} />
      {state.pay && <PayByPerson people={state.people || []} pay={state.pay} />}
    </>
  );
}

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
          : view === 'reports' ? <Reports state={state} />
          : view === 'approved' ? <Approved state={state} />
            : <Approvals state={state} reload={load} />
      )}
    </Layout>
  );
}

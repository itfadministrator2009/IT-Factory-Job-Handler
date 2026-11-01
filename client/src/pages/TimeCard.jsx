// ITF Time Card — a contractor's own timesheet: log the week's hours and
// expenses, then send it to Work Desk admins for approval.
import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Send, Plus, Trash2, ChevronDown, Camera, Paperclip, X } from 'lucide-react';
import api from '../api';
import Layout from '../components/Layout';
import { useAuth } from '../context/AuthContext';
import {
  EXPENSE_TYPES, DAYS, hrs, money, dmy, computeHours, addDays, sundayOnOrAfter, dayNameOf,
  StatusPill, EntriesTable, ExpensesTable, WeekDetail,
} from '../components/TimeCardShared';

const blankEntry = { day: 'Monday', date: '', start: '', finish: '', breakMins: '0', clientProject: '', task: '' };
const blankExpense = { date: '', type: 'Fuel', amount: '', description: '', receipt: null };

// Receipt / invoice for an expense: take a photo with the phone's camera, or pick
// a photo or PDF that's already saved. Optional.
function ReceiptPicker({ file, onChange, disabled }) {
  const cameraRef = useRef(null);
  const fileRef = useRef(null);
  const [preview, setPreview] = useState('');
  useEffect(() => {
    if (!file || !/^image\//.test(file.type)) { setPreview(''); return undefined; }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  const pick = (e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) onChange(f); };
  return (
    <div className="tc-receipt">
      <span className="tc-receipt-label">Receipt / invoice <small>(optional)</small></span>
      {file ? (
        <div className="tc-receipt-chosen">
          {preview ? <img src={preview} alt="Receipt" /> : <Paperclip size={18} />}
          <span className="tc-receipt-name">{file.name}</span>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => onChange(null)} disabled={disabled}><X size={14} /> Remove</button>
        </div>
      ) : (
        <div className="tc-receipt-buttons">
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => cameraRef.current?.click()} disabled={disabled}><Camera size={15} /> Take photo</button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => fileRef.current?.click()} disabled={disabled}><Paperclip size={15} /> Choose file</button>
        </div>
      )}
      <input ref={cameraRef} type="file" accept="image/*" capture="environment" hidden onChange={pick} />
      <input ref={fileRef} type="file" accept="image/*,application/pdf" hidden onChange={pick} />
    </div>
  );
}

function HistoryList({ title, weeks, empty, describe }) {
  const [open, setOpen] = useState(null);
  return (
    <div className="panel tc-panel">
      <h2 className="tc-h2">{title}</h2>
      {weeks.length === 0 ? <p className="tc-empty">{empty}</p> : (
        <ul className="tc-history">
          {weeks.map((w) => (
            <li key={w.id}>
              <button type="button" className="tc-history-head" aria-expanded={open === w.id} onClick={() => setOpen(open === w.id ? null : w.id)}>
                <span className="tc-history-name">Week ending {dmy(w.weekEnding)}</span>
                <span className="tc-history-meta">{describe(w)}</span>
                <span className="tc-history-hours">{hrs(w.total)} hrs</span>
                <ChevronDown size={15} className={open === w.id ? 'tc-rot' : ''} />
              </button>
              {open === w.id && <div className="tc-history-body"><WeekDetail week={w} /></div>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function TimeCard() {
  const { user } = useAuth();
  const [state, setState] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [entry, setEntry] = useState(blankEntry);
  const [expense, setExpense] = useState(blankExpense);
  const [entryError, setEntryError] = useState('');
  const [expenseError, setExpenseError] = useState('');
  const [notice, setNotice] = useState('');

  async function run(fn, { onError = setError, after } = {}) {
    setBusy(true); setError(''); onError('');
    try {
      const { data } = await fn();
      setState(data);
      after?.(data);
    } catch (err) {
      onError(err.response?.data?.error || 'Something went wrong — please try again.');
    } finally { setBusy(false); }
  }

  useEffect(() => { run(() => api.get('/timecard/my')); }, []);

  const week = state?.week;
  const editable = week && (week.status === 'Not sent' || week.status === 'Declined');
  const preview = computeHours(entry.start, entry.finish, entry.breakMins);
  const openWeek = (ending) => { setNotice(''); run(() => api.get(`/timecard/my/week?ending=${ending}`)); };

  function setEntryDate(date) {
    setEntry((e) => ({ ...e, date, day: date ? dayNameOf(date) : e.day }));
  }

  function addEntry(ev) {
    ev.preventDefault();
    if (!entry.start || !entry.finish) { setEntryError('Enter a start and finish time.'); return; }
    run(() => api.post(`/timecard/my/weeks/${week.id}/entries`, { ...entry, breakMins: Number(entry.breakMins) || 0 }), {
      onError: setEntryError,
      after: () => setEntry((e) => ({ ...blankEntry, clientProject: e.clientProject })),
    });
  }

  function addExpense(ev) {
    ev.preventDefault();
    if (!expense.date || !(Number(expense.amount) > 0)) { setExpenseError('Enter a date and an amount.'); return; }
    const { receipt, ...fields } = expense;
    let body = fields;
    if (receipt) {
      body = new FormData();
      Object.entries(fields).forEach(([k, v]) => body.append(k, v));
      body.append('receipt', receipt, receipt.name);
    }
    run(() => api.post(`/timecard/my/weeks/${week.id}/expenses`, body), { onError: setExpenseError, after: () => setExpense(blankExpense) });
  }

  function clearWeek() {
    if (!confirm('Clear all entries and expenses for this week?')) return;
    run(() => api.post(`/timecard/my/weeks/${week.id}/clear`));
  }

  function submit() {
    const sentEnding = week.weekEnding;
    run(() => api.post(`/timecard/my/weeks/${week.id}/submit`), {
      after: () => setNotice(`Week ending ${dmy(sentEnding)} has been sent for approval. You'll get an email once it's approved.`),
    });
  }

  return (
    <Layout>
      <div className="page-header">
        <div>
          <h1>My timesheet</h1>
          <div className="subtitle">Log your hours and expenses for the week, then send it for approval.</div>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}
      {notice && <div className="success-banner" style={{ marginBottom: 14 }}><span>{notice}</span><button type="button" onClick={() => setNotice('')}>×</button></div>}

      {!state ? <div className="empty-state">{error ? '' : 'Loading…'}</div> : (
        <>
          <div className="panel tc-panel tc-weekbar">
            <div className="tc-weeknav">
              <button type="button" className="btn btn-ghost btn-sm icon-btn" disabled={busy} onClick={() => openWeek(addDays(week.weekEnding, -7))} title="Previous week" aria-label="Previous week"><ChevronLeft size={16} /></button>
              <div>
                <div className="tc-label">Week ending</div>
                <div className="tc-week-title">{dayNameOf(week.weekEnding) === 'Sunday' ? 'Sunday ' : ''}{dmy(week.weekEnding)}</div>
              </div>
              <button type="button" className="btn btn-ghost btn-sm icon-btn" disabled={busy} onClick={() => openWeek(addDays(week.weekEnding, 7))} title="Next week" aria-label="Next week"><ChevronRight size={16} /></button>
            </div>
            <div className="field tc-pick">
              <label htmlFor="tc-pick">Go to week</label>
              <input id="tc-pick" type="date" value="" onChange={(e) => e.target.value && openWeek(sundayOnOrAfter(e.target.value))} />
            </div>
            <div className="tc-weekstatus">
              <StatusPill status={week.status} />
              <div className="tc-weektotal"><span>{hrs(week.total)}</span> hrs</div>
            </div>
          </div>

          {week.status === 'Declined' && (
            <div className="tc-declined">
              <strong>Declined by {week.approvedBy || 'an admin'}{week.approvalDate ? ` on ${dmy(week.approvalDate)}` : ''}.</strong> Make the changes below, then send it again.
              <div className="tc-reason">Reason: {week.declineReason}</div>
            </div>
          )}
          {week.status === 'Waiting on approval' && <div className="tc-info">Sent on {dmy(week.submittedDate)} — waiting on approval. It can't be changed now.</div>}
          {week.status === 'Approved' && <div className="tc-info tc-info-ok">Approved by {week.approvedBy} on {dmy(week.approvalDate)} and sent to accounts for payment.</div>}

          {editable && (
            <form className="panel tc-panel" onSubmit={addEntry}>
              <h2 className="tc-h2">Add an entry</h2>
              <div className="tc-grid">
                <div className="field"><label htmlFor="tc-date">Date</label>
                  <input id="tc-date" type="date" value={entry.date} min={addDays(week.weekEnding, -6)} max={week.weekEnding} onChange={(e) => setEntryDate(e.target.value)} /></div>
                <div className="field"><label htmlFor="tc-day">Day</label>
                  <select id="tc-day" value={entry.day} onChange={(e) => setEntry({ ...entry, day: e.target.value })}>{DAYS.map((d) => <option key={d}>{d}</option>)}</select></div>
                <div className="field"><label htmlFor="tc-start">Start time</label>
                  <input id="tc-start" type="time" value={entry.start} onChange={(e) => setEntry({ ...entry, start: e.target.value })} /></div>
                <div className="field"><label htmlFor="tc-finish">Finish time</label>
                  <input id="tc-finish" type="time" value={entry.finish} onChange={(e) => setEntry({ ...entry, finish: e.target.value })} /></div>
                <div className="field"><label htmlFor="tc-break">Break (minutes)</label>
                  <input id="tc-break" type="number" min="0" step="5" inputMode="numeric" value={entry.breakMins} onChange={(e) => setEntry({ ...entry, breakMins: e.target.value })} /></div>
                <div className="field tc-span2"><label htmlFor="tc-project">Client / project</label>
                  <input id="tc-project" list="tc-projects" placeholder="e.g. Harvey Norman — Printer rollout" value={entry.clientProject} onChange={(e) => setEntry({ ...entry, clientProject: e.target.value })} />
                  <datalist id="tc-projects">{(state.projects || []).map((p) => <option key={p} value={p} />)}</datalist></div>
                <div className="field tc-span2"><label htmlFor="tc-task">Task / description</label>
                  <input id="tc-task" placeholder="What you worked on" value={entry.task} onChange={(e) => setEntry({ ...entry, task: e.target.value })} /></div>
              </div>
              <div className="tc-formfoot">
                <div className="tc-preview"><span className="tc-label">Hours worked</span><span className="tc-preview-val">{preview == null ? '—' : hrs(preview)}</span></div>
                {entryError && <div className="tc-err">{entryError}</div>}
                <button className="btn btn-accent" type="submit" disabled={busy}><Plus size={15} /> Add entry to week</button>
              </div>
            </form>
          )}

          <div className="panel tc-panel">
            <h2 className="tc-h2">Weekly log</h2>
            {week.entries.length === 0
              ? <p className="tc-empty">{editable ? 'No entries yet — add the first one above.' : 'No hours logged for this week.'}</p>
              : <EntriesTable entries={week.entries} busy={busy} onDelete={editable ? (e) => run(() => api.delete(`/timecard/my/weeks/${week.id}/entries/${e.id}`)) : undefined} />}
            <div className="tc-totalbar"><span className="tc-label">Total hours</span><span className="tc-total">{hrs(week.total)}<small> hrs</small></span></div>
          </div>

          <div className="panel tc-panel">
            <h2 className="tc-h2">Expenses</h2>
            {editable && (
              <form className="tc-grid tc-grid-exp" onSubmit={addExpense}>
                <div className="field"><label htmlFor="tc-xdate">Date</label>
                  <input id="tc-xdate" type="date" value={expense.date} onChange={(e) => setExpense({ ...expense, date: e.target.value })} /></div>
                <div className="field"><label htmlFor="tc-xtype">Type</label>
                  <select id="tc-xtype" value={expense.type} onChange={(e) => setExpense({ ...expense, type: e.target.value })}>{EXPENSE_TYPES.map((t) => <option key={t}>{t}</option>)}</select></div>
                <div className="field"><label htmlFor="tc-xamt">Amount ($)</label>
                  <input id="tc-xamt" type="number" min="0" step="0.01" inputMode="decimal" placeholder="0.00" value={expense.amount} onChange={(e) => setExpense({ ...expense, amount: e.target.value })} /></div>
                <div className="field tc-span2"><label htmlFor="tc-xdesc">Description</label>
                  <input id="tc-xdesc" maxLength={200} placeholder="e.g. Fuel to client site" value={expense.description} onChange={(e) => setExpense({ ...expense, description: e.target.value })} /></div>
                <div className="tc-span-all">
                  <ReceiptPicker file={expense.receipt} disabled={busy} onChange={(f) => setExpense({ ...expense, receipt: f })} />
                </div>
                <div className="tc-formfoot tc-span-all">
                  {expenseError && <div className="tc-err">{expenseError}</div>}
                  <button className="btn btn-ghost" type="submit" disabled={busy}><Plus size={15} /> Add expense</button>
                </div>
              </form>
            )}
            {week.expenses.length === 0
              ? <p className="tc-empty">No expenses for this week.</p>
              : <ExpensesTable expenses={week.expenses} busy={busy} onDelete={editable ? (x) => run(() => api.delete(`/timecard/my/weeks/${week.id}/expenses/${x.id}`)) : undefined} />}
            <div className="tc-totalbar"><span className="tc-label">Total expenses</span><span className="tc-total">{money(week.expenseTotal)}</span></div>
          </div>

          {editable && (
            <div className="panel tc-panel tc-sendbar">
              <div>
                <h2 className="tc-h2" style={{ marginBottom: 4 }}>Send for approval</h2>
                <p className="tc-muted">{week.entries.length ? `${hrs(week.total)} hrs${week.expenses.length ? ` and ${money(week.expenseTotal)} expenses` : ''} for the week ending ${dmy(week.weekEnding)}. Once sent it can't be changed unless it's declined.` : 'Add at least one entry first.'}</p>
              </div>
              <div className="tc-sendbtns">
                <button type="button" className="btn btn-ghost" disabled={busy || (!week.entries.length && !week.expenses.length)} onClick={clearWeek}><Trash2 size={15} /> Clear week</button>
                <button type="button" className="btn btn-accent" disabled={busy || !week.entries.length} onClick={submit}><Send size={15} /> Send for approval</button>
              </div>
            </div>
          )}

          <HistoryList title="Waiting on approval" weeks={state.pendingWeeks} empty="Nothing waiting on approval right now."
            describe={(w) => `Sent ${dmy(w.submittedDate)}`} />
          <HistoryList title="Approved weeks" weeks={state.approvedWeeks} empty="No approved weeks yet."
            describe={(w) => `Approved by ${w.approvedBy} on ${dmy(w.approvalDate)}`} />
          <p className="tc-muted" style={{ marginTop: 8 }}>Signed in as {user?.name}. Questions about a timesheet? Contact your IT Factory admin.</p>
        </>
      )}
    </Layout>
  );
}

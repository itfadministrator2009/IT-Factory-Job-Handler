// ITF Time Card — pieces shared by the contractor and admin pages.
import { formatDMY } from '../utils/date';
import api from '../api';

// Opens an expense's receipt photo / PDF in a new tab (it needs the sign-in token).
export async function openReceipt(expense) {
  const tab = window.open('', '_blank');
  try {
    const res = await api.get(`/timecard/expenses/${expense.id}/receipt`, { responseType: 'blob' });
    const url = URL.createObjectURL(new Blob([res.data], { type: expense.receipt?.mime || res.data.type }));
    if (tab) tab.location = url; else window.open(url, '_blank');
  } catch (err) {
    if (tab) tab.close();
    alert('Could not open the receipt.');
  }
}

export const EXPENSE_TYPES = ['Fuel', 'Parking', 'Tolls', 'Travel', 'Materials', 'Meals', 'Other'];
export const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

export const hrs = (n) => (Number(n) || 0).toFixed(2);
export const money = (n) => `$${(Number(n) || 0).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const dmy = (s) => formatDMY(s) || '—';

// Same maths as the server (and the old app): past-midnight shifts wrap round.
export function computeHours(start, finish, breakMins) {
  if (!start || !finish) return null;
  const [sh, sm] = start.split(':').map(Number);
  const [fh, fm] = finish.split(':').map(Number);
  let diff = (fh * 60 + fm) - (sh * 60 + sm);
  if (diff <= 0) diff += 24 * 60;
  diff -= Number(breakMins) || 0;
  return Math.max(0, Math.round((diff / 60) * 100) / 100);
}

const atNoon = (ymd) => new Date(`${ymd}T12:00:00Z`);
export function addDays(ymd, n) {
  const d = atNoon(ymd); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10);
}
// The Sunday that ends the week containing this date.
export function sundayOnOrAfter(ymd) {
  const wd = atNoon(ymd).getUTCDay();
  return wd === 0 ? ymd : addDays(ymd, 7 - wd);
}
export const dayNameOf = (ymd) => DAYS[(atNoon(ymd).getUTCDay() + 6) % 7];

const STATUS_CLASS = { 'Not sent': 'tc-status-draft', 'Waiting on approval': 'tc-status-waiting', Approved: 'tc-status-approved', Declined: 'tc-status-declined' };
export function StatusPill({ status }) {
  return <span className={`tc-status ${STATUS_CLASS[status] || 'tc-status-draft'}`}>{status}</span>;
}

export function EntriesTable({ entries, onDelete, busy }) {
  if (!entries.length) return null;
  return (
    <div className="tc-table-wrap">
      <table className="tc-table">
        <thead>
          <tr>
            <th>Day</th><th>Date</th><th>Client / project</th><th>Start</th><th>Finish</th>
            <th className="num">Break</th><th className="num">Hours</th><th>Task</th>{onDelete && <th aria-label="Delete" />}
          </tr>
        </thead>
        <tbody>
          {entries.map((e) => (
            <tr key={e.id}>
              <td>{e.day}</td><td className="nowrap">{dmy(e.date)}</td><td>{e.clientProject || '—'}</td>
              <td>{e.start || '—'}</td><td>{e.finish || '—'}</td>
              <td className="num">{e.breakMins} min</td><td className="num strong">{hrs(e.hours)}</td><td>{e.task || '—'}</td>
              {onDelete && (
                <td className="num">
                  <button type="button" className="tc-del" disabled={busy} onClick={() => onDelete(e)} title="Delete entry" aria-label="Delete entry">×</button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ExpensesTable({ expenses, onDelete, busy }) {
  if (!expenses.length) return null;
  return (
    <div className="tc-table-wrap">
      <table className="tc-table">
        <thead>
          <tr><th>Date</th><th>Type</th><th>Description</th><th>Receipt</th><th className="num">Amount</th>{onDelete && <th aria-label="Delete" />}</tr>
        </thead>
        <tbody>
          {expenses.map((x) => (
            <tr key={x.id}>
              <td className="nowrap">{dmy(x.date)}</td><td>{x.type}</td><td>{x.description || '—'}</td>
              <td>{x.receipt ? <button type="button" className="tc-receipt-link" onClick={() => openReceipt(x)} title={x.receipt.name}>View</button> : <span className="tc-muted">—</span>}</td>
              <td className="num strong">{money(x.amount)}</td>
              {onDelete && (
                <td className="num">
                  <button type="button" className="tc-del" disabled={busy} onClick={() => onDelete(x)} title="Delete expense" aria-label="Delete expense">×</button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// A week's hours and expenses, read-only — used in history lists and approvals.
export function WeekDetail({ week }) {
  return (
    <>
      <EntriesTable entries={week.entries} />
      {week.expenses.length > 0 && (
        <>
          <div className="tc-subhead">Expenses</div>
          <ExpensesTable expenses={week.expenses} />
          <div className="tc-subtotal">Total expenses <strong>{money(week.expenseTotal)}</strong></div>
        </>
      )}
    </>
  );
}

// Printable approved-weeks report, opened in its own window.
export function printApprovedWeeks(weeks, title) {
  const e = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const body = weeks.map((w) => `
    <section>
      <h2>${e(w.fullName)} <span>Week ending ${e(formatDMY(w.weekEnding))}</span></h2>
      <p class="meta">Approved by ${e(w.approvedBy)} on ${e(formatDMY(w.approvalDate))}
        · <b>${hrs(w.total)} hrs</b>${w.hourlyRate ? ` · ${money(w.hourlyRate)}/hr · est. pay <b>${money(w.estPay)}</b>` : ''}
        ${w.expenses.length ? ` · expenses <b>${money(w.expenseTotal)}</b>` : ''}</p>
      <table><thead><tr><th>Day</th><th>Date</th><th>Client / project</th><th>Start</th><th>Finish</th><th class="n">Break</th><th class="n">Hours</th><th>Task</th></tr></thead>
      <tbody>${w.entries.map((x) => `<tr><td>${e(x.day)}</td><td>${e(formatDMY(x.date))}</td><td>${e(x.clientProject)}</td><td>${e(x.start)}</td><td>${e(x.finish)}</td><td class="n">${x.breakMins}m</td><td class="n">${hrs(x.hours)}</td><td>${e(x.task)}</td></tr>`).join('')}</tbody></table>
      ${w.expenses.length ? `<table class="ex"><thead><tr><th>Expense date</th><th>Type</th><th>Description</th><th>Receipt</th><th class="n">Amount</th></tr></thead>
      <tbody>${w.expenses.map((x) => `<tr><td>${e(formatDMY(x.date))}</td><td>${e(x.type)}</td><td>${e(x.description)}</td><td>${x.receipt ? 'Attached' : '—'}</td><td class="n">${money(x.amount)}</td></tr>`).join('')}</tbody></table>` : ''}
    </section>`).join('');
  const totalHours = weeks.reduce((s, w) => s + w.total, 0);
  const totalPay = weeks.reduce((s, w) => s + (w.estPay || 0), 0);
  const totalExp = weeks.reduce((s, w) => s + w.expenseTotal, 0);
  const win = window.open('', '_blank');
  if (!win) { alert('Allow pop-ups for Work Desk to print.'); return; }
  win.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${e(title)}</title><style>
    body{font-family:Arial,Helvetica,sans-serif;color:#16241f;margin:24px;font-size:12px}
    h1{font-size:18px;margin:0 0 4px} .sum{color:#6b7570;margin:0 0 18px}
    section{break-inside:avoid;margin:0 0 18px;padding-top:10px;border-top:2px solid #16241f}
    h2{font-size:14px;margin:0} h2 span{font-weight:normal;color:#6b7570;margin-left:8px}
    .meta{margin:4px 0 8px;color:#3d4a45} table{width:100%;border-collapse:collapse;margin-bottom:6px}
    th{text-align:left;font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:#6b7570;border-bottom:1px solid #c9c7bd;padding:4px}
    td{padding:4px;border-bottom:1px solid #e8e6df} .n{text-align:right} .ex{width:70%}
  </style></head><body><h1>${e(title)}</h1>
  <p class="sum">${weeks.length} approved week${weeks.length === 1 ? '' : 's'} · ${hrs(totalHours)} hrs${totalPay ? ` · est. pay ${money(totalPay)}` : ''}${totalExp ? ` · expenses ${money(totalExp)}` : ''}</p>
  ${body || '<p>No approved weeks.</p>'}</body></html>`);
  win.document.close();
  win.focus();
  setTimeout(() => win.print(), 300);
}

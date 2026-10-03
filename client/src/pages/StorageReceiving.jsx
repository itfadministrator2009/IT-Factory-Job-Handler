import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Plus, Trash2, X, Pencil, Printer, Boxes, Package, Users, ClipboardList, BarChart3 } from 'lucide-react';
import api from '../api';
import Layout from '../components/Layout';
import { useAuth } from '../context/AuthContext';

const ALL = '__all__';

// Same fee rule as the server (rdFees in server/routes/storage.js). Entries
// migrated from the old app may hold the whole "Type: Qty @ $Rate" text in the
// Type field (e.g. "Individual Item: 65 @ $5"); then the fee comes from those
// parts. Otherwise it's the entry's rate × the Qty field.
function toQty(v) {
  if (v == null || v === '') return 0;
  const n = Number(String(v).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : 0;
}
function parseStockParts(text) {
  if (!text) return [];
  const parts = [];
  for (const piece of String(text).split(/[;\n]+/)) {
    const m = piece.trim().match(/^(.+?):\s*(\d+(?:\.\d+)?)\s*(?:@\s*\$?\s*(\d+(?:\.\d+)?))?\s*$/);
    if (m) parts.push({ type: m[1].trim(), qty: Number(m[2]), rate: m[3] != null ? Number(m[3]) : null });
  }
  return parts;
}
function sideFee(typeText, qty, rate) {
  const parts = parseStockParts(typeText);
  if (parts.length) return parts.reduce((t, p) => t + p.qty * (p.rate != null ? p.rate : rate), 0);
  return rate * toQty(qty);
}
function feesFor(v) {
  const rate = Number(v.rate) || 0;
  const received = sideFee(v.stockReceivedType, v.stockReceivedQty, rate);
  const dispatched = sideFee(v.stockDispatchedType, v.stockDispatchedQty, rate);
  return { received, dispatched, total: received + dispatched };
}

function money(n) {
  return `$${(Number(n) || 0).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// "Pallets: 3 @ $25.00" — the old app's display format. Blank when there's no stock.
function stockLabel(type, qty, rate) {
  if (!type && (qty == null || qty === '')) return '';
  // Already written in the old app's "Type: Qty @ $Rate" form — show it as-is.
  if (parseStockParts(type).length) return String(type).split(/[;\n]+/).map((s) => s.trim()).filter(Boolean).join('; ');
  const r = rate != null && rate !== '' ? ` @ ${money(rate)}` : '';
  return `${type || 'Stock'}: ${qty ?? 0}${r}`;
}

// YYYY-MM-DD -> DD/MM/YYYY for display; anything else is shown as-is.
function dmy(d) {
  if (!d) return '';
  const m = String(d).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : d;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function printEntry(e) {
  const fees = feesFor(e);
  const row = (label, value) => `<tr><th>${escapeHtml(label)}</th><td>${escapeHtml(value) || '&mdash;'}</td></tr>`;
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Receiving / Dispatch — ${escapeHtml(e.client)}</title>
<style>
  body { font-family: Arial, Helvetica, sans-serif; color: #111; margin: 32px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { color: #555; font-size: 13px; margin-bottom: 20px; }
  table { border-collapse: collapse; width: 100%; max-width: 640px; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #ddd; font-size: 14px; vertical-align: top; }
  th { width: 38%; color: #444; font-weight: 600; }
  .total th, .total td { font-weight: 700; border-top: 2px solid #111; }
  .notes { white-space: pre-wrap; }
</style></head><body>
<h1>IT Factory Storage Centre — Receiving / Dispatch</h1>
<div class="sub">Printed ${escapeHtml(new Date().toLocaleString('en-AU'))}</div>
<table>
  ${row('Client', e.client)}
  ${row('Date received', dmy(e.dateReceived))}
  ${row('Stock received', stockLabel(e.stockReceivedType, e.stockReceivedQty, e.rate))}
  ${row('Receiving fee', fees.received ? money(fees.received) : '')}
  ${row('Date dispatched', dmy(e.dateDispatched))}
  ${row('Stock dispatched', stockLabel(e.stockDispatchedType, e.stockDispatchedQty, e.rate))}
  ${row('Dispatch fee', fees.dispatched ? money(fees.dispatched) : '')}
  <tr class="total"><th>Total fee</th><td>${money(fees.total)}</td></tr>
  <tr><th>Receiving notes</th><td class="notes">${escapeHtml(e.receiving) || '&mdash;'}</td></tr>
  <tr><th>Dispatch notes</th><td class="notes">${escapeHtml(e.dispatch) || '&mdash;'}</td></tr>
  ${row('Saved by', e.savedBy)}
  ${row('Saved on', e.savedOn)}
</table>
<script>window.onload = function () { window.print(); };</script>
</body></html>`;
  const w = window.open('', '_blank');
  if (!w) { alert('Please allow pop-ups for this site to print.'); return; }
  w.document.open();
  w.document.write(html);
  w.document.close();
}

// The old app's receiving form: each side (received / dispatched) is a list of
// stock lines, each with its own rate, saved as "Type: Qty @ $Rate; ..." with
// the total quantity alongside — the same text the old sheet holds, so the fee
// logic reads old and new entries the same way.
const STOCK_TYPES = ['Individual Item', 'Pallet'];
const DEFAULT_RATE = { 'Individual Item': '5', Pallet: '10' };
const RATE_OPTIONS = [['0', '$0 (No charge)'], ['5', '$5 (Individual Item)'], ['10', '$10 (Pallet)']];

function linesFromEntry(type, qty, rate) {
  const parts = parseStockParts(type);
  if (parts.length) return parts.map((p) => ({ type: p.type, qty: String(p.qty), rate: p.rate != null ? String(p.rate) : (rate != null ? String(rate) : '') }));
  if (type || (qty != null && qty !== '')) return [{ type: type || 'Individual Item', qty: String(qty ?? ''), rate: rate != null ? String(rate) : '' }];
  return [];
}
function linesToText(lines) {
  return lines.map((l) => `${l.type}: ${l.qty}${l.rate !== '' && l.rate != null ? ` @ $${l.rate}` : ''}`).join('; ');
}
function linesQty(lines) {
  return lines.reduce((t, l) => t + (Number(l.qty) || 0), 0);
}
function linesFee(lines) {
  return lines.reduce((t, l) => t + (Number(l.qty) || 0) * (Number(l.rate) || 0), 0);
}

function StockLines({ label, lines, onChange }) {
  const [type, setType] = useState('Individual Item');
  const [qty, setQty] = useState('');
  const [rate, setRate] = useState('5');
  const [custom, setCustom] = useState('');
  function add() {
    const finalRate = rate === 'custom' ? custom : rate;
    if (!(Number(qty) > 0)) { alert('Enter a number of items greater than 0.'); return; }
    if (rate === 'custom' && (custom === '' || Number(custom) < 0)) { alert('Enter a custom rate of $0 or more.'); return; }
    onChange([...lines, { type, qty: String(qty), rate: String(finalRate) }]);
    setQty('');
  }
  return (
    <div className="span-2" style={{ gridColumn: '1 / -1' }}>
      <label style={{ display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 6 }}>{label}</label>
      {lines.map((l, idx) => (
        <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 10px', background: 'var(--bg, #f5f6f7)', borderRadius: 6, marginBottom: 4, fontSize: 13 }}>
          <span style={{ flex: 1 }}>{l.type}: <strong>{l.qty}</strong>{l.rate !== '' ? ` @ ${money(l.rate)}` : ''}</span>
          <span style={{ color: 'var(--muted)' }}>{money((Number(l.qty) || 0) * (Number(l.rate) || 0))}</span>
          <button type="button" className="btn btn-ghost btn-sm icon-btn" title="Remove" onClick={() => onChange(lines.filter((_, i) => i !== idx))}><Trash2 size={13} /></button>
        </div>
      ))}
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap', marginTop: 6 }}>
        <div className="field" style={{ margin: 0 }}>
          <label>Stock type</label>
          <select value={type} onChange={(e) => { setType(e.target.value); setRate(DEFAULT_RATE[e.target.value] || '5'); }}>
            {STOCK_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
        <div className="field" style={{ margin: 0, width: 110 }}>
          <label>Number of items</label>
          <input type="number" min="1" step="1" value={qty} onChange={(e) => setQty(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }} />
        </div>
        <div className="field" style={{ margin: 0 }}>
          <label>Rate</label>
          <select value={rate} onChange={(e) => setRate(e.target.value)}>
            {RATE_OPTIONS.map(([v, t]) => <option key={v} value={v}>{t}</option>)}
            <option value="custom">Custom…</option>
          </select>
        </div>
        {rate === 'custom' && (
          <div className="field" style={{ margin: 0, width: 100 }}>
            <label>Rate $</label>
            <input type="number" min="0" step="0.01" value={custom} onChange={(e) => setCustom(e.target.value)} />
          </div>
        )}
        <button type="button" className="btn btn-ghost" onClick={add}><Plus size={14} /> Add</button>
      </div>
      {lines.length > 0 && <div style={{ fontSize: 13, marginTop: 6 }}>Fee: <strong>{money(linesFee(lines))}</strong></div>}
    </div>
  );
}

const EMPTY_FORM = {
  client: '', mode: 'receiving', dateReceived: '', receiving: '', dateDispatched: '', dispatch: '',
  receivedLines: [], dispatchedLines: [],
};

export default function StorageReceiving() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin' || user?.role === 'agent';
  const [entries, setEntries] = useState(null);
  const [clientNames, setClientNames] = useState([]);
  const [clientFilter, setClientFilter] = useState(ALL);
  const [editing, setEditing] = useState(null); // null = closed, {} = new, entry = edit
  const [formValues, setFormValues] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState('');

  function load() {
    setLoadError('');
    api.get('/storage/receiving-dispatch')
      .then((res) => setEntries(res.data.entries))
      .catch((err) => setLoadError(err.response?.data?.error || 'Could not load entries'));
  }
  useEffect(() => {
    load();
    api.get('/storage/lists').then((res) => setClientNames(res.data.clients || [])).catch(() => {});
  }, []);

  // Clients for the filter: the master list plus any name that only appears on an entry.
  const filterClients = useMemo(() => {
    const names = new Set(clientNames.filter(Boolean));
    (entries || []).forEach((e) => e.client && names.add(e.client));
    return [...names].sort((a, b) => a.localeCompare(b));
  }, [clientNames, entries]);

  const visible = useMemo(() => {
    if (!entries) return null;
    return clientFilter === ALL ? entries : entries.filter((e) => e.client === clientFilter);
  }, [entries, clientFilter]);

  const visibleTotal = useMemo(() => (visible || []).reduce((t, e) => t + (Number(e.fee) || 0), 0), [visible]);

  function openAdd(prefill) {
    setFormValues({ ...EMPTY_FORM, client: clientFilter === ALL ? '' : clientFilter, ...(prefill || {}) });
    setError('');
    setEditing({});
  }

  function openEdit(e) {
    const receivedLines = linesFromEntry(e.stockReceivedType, e.stockReceivedQty, e.rate);
    const dispatchedLines = linesFromEntry(e.stockDispatchedType, e.stockDispatchedQty, e.rate);
    const hasReceiving = receivedLines.length || e.dateReceived || e.receiving;
    const hasDispatch = dispatchedLines.length || e.dateDispatched || e.dispatch;
    setFormValues({
      client: e.client || '', dateReceived: e.dateReceived || '', receiving: e.receiving || '',
      dateDispatched: e.dateDispatched || '', dispatch: e.dispatch || '', receivedLines, dispatchedLines,
      mode: hasReceiving && hasDispatch ? 'both' : (hasDispatch ? 'dispatch' : 'receiving'),
    });
    setError('');
    setEditing(e);
  }

  // Arriving from an order's "Send to dispatch": open a pre-filled dispatch entry.
  const location = useLocation();
  const navigate = useNavigate();
  const [matchSummary, setMatchSummary] = useState(null);
  useEffect(() => {
    const st = location.state;
    if (!st?.dispatchPrefill) return;
    const p = st.dispatchPrefill;
    openAdd({
      client: p.client, mode: 'dispatch', dateDispatched: p.dateDispatched, dispatch: p.dispatch,
      dispatchedLines: linesFromEntry(p.stockDispatchedType, p.stockDispatchedQty, null),
    });
    setMatchSummary(st.matchSummary || null);
    navigate(location.pathname, { replace: true, state: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.state]);

  const set = (field) => (ev) => setFormValues((p) => ({ ...p, [field]: ev.target.value }));
  const setLines = (field) => (lines) => setFormValues((p) => ({ ...p, [field]: lines }));

  async function handleSave(ev) {
    ev.preventDefault();
    const f = formValues;
    const showRec = f.mode !== 'dispatch';
    const showDis = f.mode !== 'receiving';
    const rec = showRec ? f.receivedLines : [];
    const dis = showDis ? f.dispatchedLines : [];
    const payload = {
      client: f.client,
      rate: null,
      dateReceived: showRec ? f.dateReceived : '',
      stockReceivedType: linesToText(rec), stockReceivedQty: rec.length ? String(linesQty(rec)) : '',
      receiving: showRec ? f.receiving : '',
      dateDispatched: showDis ? f.dateDispatched : '',
      stockDispatchedType: linesToText(dis), stockDispatchedQty: dis.length ? String(linesQty(dis)) : '',
      dispatch: showDis ? f.dispatch : '',
    };
    setSaving(true);
    setError('');
    try {
      if (editing?.id) await api.patch(`/storage/receiving-dispatch/${editing.id}`, payload);
      else await api.post('/storage/receiving-dispatch', payload);
      setEditing(null);
      setMatchSummary(null);
      load();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not save');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id) {
    if (!confirm('Delete this entry?')) return;
    try {
      await api.delete(`/storage/receiving-dispatch/${id}`);
      load();
    } catch (err) {
      alert(err.response?.data?.error || 'Could not delete');
    }
  }

  const preview = { received: linesFee(formValues.mode === 'dispatch' ? [] : formValues.receivedLines), dispatched: linesFee(formValues.mode === 'receiving' ? [] : formValues.dispatchedLines) };
  preview.total = preview.received + preview.dispatched;

  return (
    <Layout>
      <div className="page-header">
        <div>
          <h1>Storage Centre — Receiving / Dispatch</h1>
          <div className="subtitle">
            {visible ? `${visible.length} entr${visible.length === 1 ? 'y' : 'ies'} · fees ${money(visibleTotal)}` : 'Loading…'}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Link to="/storage" className="btn btn-ghost btn-sm"><Boxes size={14} /> Manifest</Link>
          <Link to="/storage/pallets" className="btn btn-ghost btn-sm"><Package size={14} /> Pallets</Link>
          <Link to="/storage/clients" className="btn btn-ghost btn-sm"><Users size={14} /> Clients</Link>
          <Link to="/storage/orders" className="btn btn-ghost btn-sm"><ClipboardList size={14} /> Orders</Link>
          <Link to="/storage/reports" className="btn btn-ghost btn-sm"><BarChart3 size={14} /> Reports</Link>
          <button className="btn btn-accent" onClick={() => openAdd()}><Plus size={16} /> New entry</button>
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
        <label htmlFor="rd-client-filter" style={{ fontSize: 13, color: 'var(--muted)' }}>Client</label>
        <select id="rd-client-filter" value={clientFilter} onChange={(e) => setClientFilter(e.target.value)} style={{ minWidth: 220 }}>
          <option value={ALL}>All clients</option>
          {filterClients.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>

      {loadError && <div className="error-banner">{loadError}</div>}

      <div className="panel" style={{ padding: 0 }}>
        {!visible ? (
          <div className="empty-state">Loading…</div>
        ) : visible.length === 0 ? (
          <div className="empty-state"><h3>No entries{clientFilter === ALL ? ' yet' : ' for this client'}</h3></div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="ticket-table">
              <thead>
                <tr>
                  <th>Client</th>
                  <th>Date Received</th>
                  <th>Stock Received</th>
                  <th>Date Dispatched</th>
                  <th>Stock Dispatched</th>
                  <th style={{ textAlign: 'right' }}>Fee</th>
                  <th>Notes</th>
                  <th>Saved</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {visible.map((e) => {
                  const notes = [e.receiving && `Receiving: ${e.receiving}`, e.dispatch && `Dispatch: ${e.dispatch}`].filter(Boolean).join('\n');
                  return (
                    <tr key={e.id}>
                      <td>{e.client}</td>
                      <td>{dmy(e.dateReceived)}</td>
                      <td>{stockLabel(e.stockReceivedType, e.stockReceivedQty, e.rate)}</td>
                      <td>{dmy(e.dateDispatched)}</td>
                      <td>{stockLabel(e.stockDispatchedType, e.stockDispatchedQty, e.rate)}</td>
                      <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>{money(e.fee)}</td>
                      <td style={{ maxWidth: 260, whiteSpace: 'pre-wrap', fontSize: 12, color: 'var(--muted)' }}>{notes}</td>
                      <td style={{ color: 'var(--muted)', fontSize: 12, whiteSpace: 'nowrap' }}>{e.savedBy}<br />{e.savedOn}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        <button type="button" className="btn btn-ghost btn-sm icon-btn" title="Edit" onClick={() => openEdit(e)}><Pencil size={13} /></button>
                        <button type="button" className="btn btn-ghost btn-sm icon-btn" title="Print" onClick={() => printEntry(e)}><Printer size={13} /></button>
                        {isAdmin && (
                          <button type="button" className="btn btn-ghost btn-sm icon-btn" title="Delete" style={{ color: 'var(--danger)' }} onClick={() => handleDelete(e.id)}><Trash2 size={13} /></button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {editing && (
        <div className="modal-overlay" onClick={() => !saving && setEditing(null)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 680 }}>
            <div className="modal-header">
              <h3>{editing.id ? 'Edit' : 'New'} Receiving / Dispatch entry</h3>
              {!saving && <button type="button" onClick={() => setEditing(null)}><X size={18} /></button>}
            </div>
            {error && <div className="error-banner">{error}</div>}
            {matchSummary && !editing.id && (
              <div style={{ padding: '8px 12px', borderRadius: 6, marginBottom: 12, fontSize: 13,
                background: matchSummary.unmatched.length === 0 ? '#e6f2e8' : (matchSummary.matched.length ? '#fbf1dc' : '#fbe1db') }}>
                {matchSummary.deviceCount === 0 ? 'This order lists no devices to match on the manifest.'
                  : matchSummary.unmatched.length === 0
                    ? `All ${matchSummary.matched.length} device(s) matched — their storage end date is now ${dmy(matchSummary.endDate)} on the manifest.`
                    : `${matchSummary.matched.length} of ${matchSummary.deviceCount} device(s) matched and had their storage end date set to ${dmy(matchSummary.endDate)}. Not matched (update the manifest by hand): ${matchSummary.unmatched.join(', ')}`}
              </div>
            )}
            <form onSubmit={handleSave}>
              <div className="form-grid">
                <div className="field">
                  <label>Client</label>
                  <input list="rd-client-options" value={formValues.client} onChange={set('client')} required />
                  <datalist id="rd-client-options">
                    {filterClients.map((c) => <option key={c} value={c} />)}
                  </datalist>
                </div>
                <div className="field">
                  <label>Entry type</label>
                  <select value={formValues.mode} onChange={set('mode')}>
                    <option value="receiving">Receiving</option>
                    <option value="dispatch">Dispatch</option>
                    <option value="both">Receiving and dispatch</option>
                  </select>
                </div>

                {formValues.mode !== 'dispatch' && (
                  <>
                    <div className="field"><label>Date received</label><input type="date" value={formValues.dateReceived} onChange={set('dateReceived')} /></div>
                    <div className="field" />
                    <StockLines label="Stock received" lines={formValues.receivedLines} onChange={setLines('receivedLines')} />
                    <div className="field span-2"><label>Receiving notes</label><textarea rows={2} value={formValues.receiving} onChange={set('receiving')} /></div>
                  </>
                )}
                {formValues.mode !== 'receiving' && (
                  <>
                    <div className="field"><label>Date dispatched</label><input type="date" value={formValues.dateDispatched} onChange={set('dateDispatched')} /></div>
                    <div className="field" />
                    <StockLines label="Stock dispatched" lines={formValues.dispatchedLines} onChange={setLines('dispatchedLines')} />
                    <div className="field span-2"><label>Dispatch notes</label><textarea rows={4} value={formValues.dispatch} onChange={set('dispatch')} /></div>
                  </>
                )}
              </div>

              <div style={{ marginTop: 12, fontSize: 13, color: 'var(--muted)' }}>
                Total fee: <strong style={{ color: 'var(--text, inherit)' }}>{money(preview.total)}</strong>
              </div>

              <button className="btn btn-accent" type="submit" disabled={saving} style={{ marginTop: 16 }}>{saving ? 'Saving…' : 'Save'}</button>
            </form>
          </div>
        </div>
      )}
    </Layout>
  );
}

import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus, Trash2, X, Pencil, Printer, Boxes, Package, Users, ClipboardList, BarChart3 } from 'lucide-react';
import api from '../api';
import Layout from '../components/Layout';
import { useAuth } from '../context/AuthContext';

const ALL = '__all__';

// Same fee rule as the server (rdFees in server/routes/storage.js): the entry's
// rate applies to both the received and the dispatched quantity.
function toQty(v) {
  if (v == null || v === '') return 0;
  const n = Number(String(v).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : 0;
}
function feesFor(v) {
  const rate = Number(v.rate) || 0;
  const received = rate * toQty(v.stockReceivedQty);
  const dispatched = rate * toQty(v.stockDispatchedQty);
  return { received, dispatched, total: received + dispatched };
}

function money(n) {
  return `$${(Number(n) || 0).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// "Pallets: 3 @ $25.00" — the old app's display format. Blank when there's no stock.
function stockLabel(type, qty, rate) {
  if (!type && (qty == null || qty === '')) return '';
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

const EMPTY_FORM = {
  client: '', rate: '', dateReceived: '', stockReceivedType: '', stockReceivedQty: '',
  dateDispatched: '', stockDispatchedType: '', stockDispatchedQty: '', receiving: '', dispatch: '',
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

  function openAdd() {
    setFormValues({ ...EMPTY_FORM, client: clientFilter === ALL ? '' : clientFilter });
    setError('');
    setEditing({});
  }

  function openEdit(e) {
    const v = {};
    Object.keys(EMPTY_FORM).forEach((k) => { v[k] = e[k] ?? ''; });
    setFormValues(v);
    setError('');
    setEditing(e);
  }

  const set = (field) => (ev) => setFormValues((p) => ({ ...p, [field]: ev.target.value }));

  async function handleSave(ev) {
    ev.preventDefault();
    setSaving(true);
    setError('');
    try {
      if (editing?.id) await api.patch(`/storage/receiving-dispatch/${editing.id}`, formValues);
      else await api.post('/storage/receiving-dispatch', formValues);
      setEditing(null);
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

  const preview = feesFor(formValues);

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
          <button className="btn btn-accent" onClick={openAdd}><Plus size={16} /> New entry</button>
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
            <form onSubmit={handleSave}>
              <div className="form-grid">
                <div className="field">
                  <label>Client</label>
                  <input list="rd-client-options" value={formValues.client} onChange={set('client')} required />
                  <datalist id="rd-client-options">
                    {filterClients.map((c) => <option key={c} value={c} />)}
                  </datalist>
                </div>
                <div className="field"><label>Rate ($ per unit)</label><input type="number" step="0.01" min="0" value={formValues.rate} onChange={set('rate')} /></div>

                <div className="field"><label>Date Received</label><input type="date" value={formValues.dateReceived} onChange={set('dateReceived')} /></div>
                <div className="field" />
                <div className="field"><label>Stock Received — Type</label><input placeholder="e.g. Pallets" value={formValues.stockReceivedType} onChange={set('stockReceivedType')} /></div>
                <div className="field"><label>Stock Received — Qty</label><input type="number" step="any" min="0" value={formValues.stockReceivedQty} onChange={set('stockReceivedQty')} /></div>

                <div className="field"><label>Date Dispatched</label><input type="date" value={formValues.dateDispatched} onChange={set('dateDispatched')} /></div>
                <div className="field" />
                <div className="field"><label>Stock Dispatched — Type</label><input placeholder="e.g. Pallets" value={formValues.stockDispatchedType} onChange={set('stockDispatchedType')} /></div>
                <div className="field"><label>Stock Dispatched — Qty</label><input type="number" step="any" min="0" value={formValues.stockDispatchedQty} onChange={set('stockDispatchedQty')} /></div>

                <div className="field span-2"><label>Receiving notes</label><textarea rows={2} value={formValues.receiving} onChange={set('receiving')} /></div>
                <div className="field span-2"><label>Dispatch notes</label><textarea rows={2} value={formValues.dispatch} onChange={set('dispatch')} /></div>
              </div>

              <div style={{ marginTop: 12, fontSize: 13, color: 'var(--muted)' }}>
                Fee: received {money(preview.received)} + dispatched {money(preview.dispatched)} = <strong style={{ color: 'var(--text, inherit)' }}>{money(preview.total)}</strong>
              </div>

              <button className="btn btn-accent" type="submit" disabled={saving} style={{ marginTop: 16 }}>{saving ? 'Saving…' : 'Save'}</button>
            </form>
          </div>
        </div>
      )}
    </Layout>
  );
}

import { useEffect, useState } from 'react';
import { Printer, Download } from 'lucide-react';
import api from '../api';
import Layout from '../components/Layout';
import RangePicker from '../storage/RangePicker';
import { dmy, money, downloadCsv, PRESET_LABELS } from '../storage/common';

// Old "Storage calculator": storage cost for a period, by pallet/item, by
// location, or per item, filtered by client and storage centre.
const MODES = [
  ['all', 'Pallets and individual items'],
  ['location', 'By location (pallet)'],
  ['none', 'Individual items (own rates only)'],
];

function columns(groupBy) {
  if (groupBy === 'none') {
    return [['Client', (r) => r.client], ['Job #', (r) => r.jobNumber], ['Item', (r) => r.item], ['Make', (r) => r.make], ['Model', (r) => r.model], ['Serial', (r) => r.serial], ['Weekly rate', (r) => money(r.ratePerWeek), true], ['Days in period', (r) => r.days, true], ['Cost', (r) => money(r.cost), true]];
  }
  if (groupBy === 'location') {
    return [['Location', (r) => r.location], ['Client', (r) => r.client], ['Storage centre', (r) => r.storageCentre], ['Items on pallet', (r) => r.itemCount, true], ['Billed as', (r) => r.billedAs], ['Cost', (r) => money(r.cost), true]];
  }
  return [['Type', (r) => r.type], ['Client', (r) => r.client], ['Storage centre', (r) => r.storageCentre],
    ['Location / item', (r) => (r.type === 'Pallet' ? `${r.location} (${r.itemCount} item${r.itemCount === 1 ? '' : 's'})` : [r.item, r.location && `@ ${r.location}`].filter(Boolean).join(' '))],
    ['Job #', (r) => (r.type === 'Pallet' ? '—' : r.jobNumber)], ['Serial', (r) => (r.type === 'Pallet' ? '—' : r.serial)], ['Billed as', (r) => r.billedAs], ['Total cost', (r) => money(r.cost), true]];
}

export default function StorageCalculator() {
  const [lists, setLists] = useState({ clients: [], storageCentres: [] });
  const [groupBy, setGroupBy] = useState('all');
  const [client, setClient] = useState('');
  const [centre, setCentre] = useState('');
  const [range, setRange] = useState(null);
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => { api.get('/storage/lists').then((r) => setLists(r.data)); }, []);

  async function run() {
    if (!range) { alert('Choose a date range'); return; }
    setLoading(true); setError('');
    try {
      const { data } = await api.get('/storage/reports/calculator', { params: { from: range.from, to: range.to, groupBy, client: client || undefined, centre: centre || undefined } });
      setResult({ ...data, client, centre, rangeLabel: range.preset === 'custom' ? 'Custom range' : PRESET_LABELS[range.preset] });
    } catch (err) {
      setError(err.response?.data?.error || 'Could not calculate');
    } finally {
      setLoading(false);
    }
  }

  const cols = result ? columns(result.groupBy) : [];
  const itemsLine = !result ? '' : result.groupBy === 'all'
    ? `${result.palletCount} pallet(s), ${result.itemRows} individually-billed item(s)`
    : result.groupBy === 'location' ? `${result.itemCount} item(s) across ${result.palletCount} location(s)` : `${result.itemCount} item(s)`;
  const summary = result ? [
    ['Date range', `${result.rangeLabel} (${dmy(result.from)} – ${dmy(result.to)})`],
    ['Client', result.client || 'All clients'],
    ...(result.centre ? [['Storage centre', result.centre]] : []),
    ['Items', itemsLine],
    ['Total cost (ex GST)', money(result.total)],
  ] : [];

  return (
    <Layout>
      <div className="page-header">
        <div>
          <h1>Storage calculator</h1>
          <div className="subtitle">Storage cost for any period, using the same rules as the invoices (ex GST)</div>
        </div>
      </div>

      <div className="panel panel-pad no-print" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
          <div className="field" style={{ margin: 0, minWidth: 240 }}>
            <label>Show totals by</label>
            <select value={groupBy} onChange={(e) => setGroupBy(e.target.value)}>{MODES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
          </div>
          <div className="field" style={{ margin: 0, minWidth: 200 }}>
            <label>Client</label>
            <select value={client} onChange={(e) => setClient(e.target.value)}>
              <option value="">All clients</option>
              {lists.clients.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div className="field" style={{ margin: 0, minWidth: 200 }}>
            <label>Storage centre</label>
            <select value={centre} onChange={(e) => setCentre(e.target.value)}>
              <option value="">All storage centres</option>
              {lists.storageCentres.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
        </div>
        <RangePicker value={range} onChange={setRange} />
        <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
          <button type="button" className="btn btn-accent" onClick={run} disabled={loading}>{loading ? 'Calculating…' : 'Calculate'}</button>
          <button type="button" className="btn btn-ghost" onClick={() => { setGroupBy('all'); setClient(''); setCentre(''); setRange(null); setResult(null); }}>Clear filter</button>
          {result && <button type="button" className="btn btn-ghost" onClick={() => window.print()}><Printer size={14} /> Print</button>}
          {result && (
            <button type="button" className="btn btn-ghost" onClick={() => downloadCsv('storage-cost-calculation.csv', [
              cols.map(([l]) => l), ...result.rows.map((r) => cols.map(([, f]) => f(r))), [], ...summary,
            ])}><Download size={14} /> Export CSV</button>
          )}
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}
      {result && (
        <>
          <div className="panel panel-pad" style={{ marginBottom: 16 }}>
            <table style={{ fontSize: 14 }}>
              <tbody>{summary.map(([l, v]) => <tr key={l}><td style={{ color: 'var(--muted)', paddingRight: 24 }}>{l}</td><td style={{ fontWeight: l.startsWith('Total') ? 700 : 400 }}>{v}</td></tr>)}</tbody>
            </table>
          </div>
          <div className="panel" style={{ padding: 0 }}>
            {result.rows.length === 0 ? <div className="empty-state">Nothing billable in this period.</div> : (
              <div style={{ overflowX: 'auto' }}>
                <table className="ticket-table">
                  <thead><tr>{cols.map(([l, , right]) => <th key={l} style={right ? { textAlign: 'right' } : undefined}>{l}</th>)}</tr></thead>
                  <tbody>{result.rows.map((r, i) => <tr key={r.id || i}>{cols.map(([l, f, right]) => <td key={l} style={right ? { textAlign: 'right' } : undefined}>{f(r)}</td>)}</tr>)}</tbody>
                  <tfoot><tr><td colSpan={cols.length - 1} style={{ textAlign: 'right', fontWeight: 700 }}>Total</td><td style={{ textAlign: 'right', fontWeight: 700 }}>{money(result.total)}</td></tr></tfoot>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </Layout>
  );
}

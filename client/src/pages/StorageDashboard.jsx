import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, DatabaseBackup, MapPin } from 'lucide-react';
import api from '../api';
import Layout from '../components/Layout';
import { PRESET_LABELS, dmy, money } from '../storage/common';

const PERIODS = ['lastWeek', 'lastMonth', 'lastQuarter', 'lastYear', 'lastFY'];

// Horizontal bars, one series (one hue, no legend — the heading names it).
// Values are labelled at the bar end; hovering shows the exact figure and share.
function BarList({ rows, format, total }) {
  const max = Math.max(...rows.map((r) => r.value), 0) || 1;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(120px, 220px) 1fr', gap: '6px 12px', alignItems: 'center' }}>
      {rows.map((r) => {
        const share = total ? ` (${Math.round((r.value / total) * 100)}%)` : '';
        return (
          <div key={r.label} style={{ display: 'contents' }}>
            <div style={{ fontSize: 13, textAlign: 'right', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.label}>{r.label}</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }} title={`${r.label}: ${format(r.value)}${share}`}>
              <div style={{ height: 18, width: `${Math.max((r.value / max) * 100, 0.5)}%`, maxWidth: 'calc(100% - 110px)', background: 'var(--teal)', borderRadius: '0 4px 4px 0' }} />
              <span style={{ fontSize: 12, color: 'var(--ink)', whiteSpace: 'nowrap' }}>{format(r.value)}<span style={{ color: 'var(--muted)' }}>{share}</span></span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function hoursAgo(iso) {
  return Math.round((Date.now() - new Date(iso).getTime()) / 3600000);
}

export default function StorageDashboard() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [period, setPeriod] = useState('lastMonth');

  useEffect(() => {
    api.get('/storage/dashboard').then((r) => setData(r.data)).catch(() => setError('Could not load the dashboard'));
  }, []);

  const costRows = useMemo(() => (data ? data.costByClient.map((r) => ({ label: r.client, value: r[period] })).filter((r) => r.value > 0).sort((a, b) => b.value - a.value) : []), [data, period]);
  const costTotal = costRows.reduce((t, r) => t + r.value, 0);
  const itemRows = useMemo(() => (data ? data.itemsByClient.map((r) => ({ label: r.client, value: r.count })) : []), [data]);

  return (
    <Layout>
      <div className="page-header">
        <div>
          <h1>Storage Centre — Dashboard</h1>
          <div className="subtitle">Storage cost by client (ex GST) and what's in storage now</div>
        </div>
      </div>
      {error && <div className="error-banner">{error}</div>}
      {!data ? !error && <div className="empty-state">Loading…</div> : (
        <>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
            {data.unclassifiedLocations > 0 && (
              <div className="panel panel-pad" style={{ background: '#fbf1dc', display: 'flex', gap: 10, alignItems: 'center' }}>
                <MapPin size={16} /> <span style={{ flex: 1 }}><strong>{data.unclassifiedLocations}</strong> location(s) in use aren't classified as pallet / not pallet yet.</span>
                <Link to="/storage/locations" className="btn btn-ghost btn-sm">Classify</Link>
              </div>
            )}
            {data.billingGaps > 0 && (
              <div className="panel panel-pad" style={{ background: '#fbf1dc', display: 'flex', gap: 10, alignItems: 'center' }}>
                <AlertTriangle size={16} /> <span style={{ flex: 1 }}><strong>{data.billingGaps}</strong> item(s) in storage are costing $0/wk (no item or pallet rate).</span>
                <Link to="/storage" className="btn btn-ghost btn-sm">Open Manifest</Link>
              </div>
            )}
            <div className="panel panel-pad" style={{ display: 'flex', gap: 10, alignItems: 'center', ...(!data.lastBackupAt || hoursAgo(data.lastBackupAt) > 36 ? { background: '#fbe9e4', color: 'var(--danger)' } : {}) }}>
              <DatabaseBackup size={16} />
              {data.lastBackupAt
                ? <span>Last backup: {new Date(data.lastBackupAt).toLocaleString('en-AU', { timeZone: 'Australia/Sydney', dateStyle: 'medium', timeStyle: 'short' })} ({hoursAgo(data.lastBackupAt)} hours ago){hoursAgo(data.lastBackupAt) > 36 ? ' — overdue' : ''}</span>
                : <span>No backups recorded yet (the nightly OneDrive backup records itself here once it runs).</span>}
            </div>
          </div>

          <div className="stat-grid" style={{ marginBottom: 16 }}>
            <div className="stat-card"><div className="num">{data.stats.inStorage}</div><div className="label">Items in storage</div></div>
            <div className="stat-card"><div className="num">{data.stats.clients}</div><div className="label">Clients</div></div>
            <div className="stat-card"><div className="num">{data.stats.totalQuantity}</div><div className="label">Total quantity</div></div>
          </div>

          <div className="panel panel-pad" style={{ marginBottom: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
              <h3 style={{ fontSize: 15 }}>Storage cost by client — {PRESET_LABELS[period].toLowerCase()} <span style={{ color: 'var(--muted)', fontWeight: 400, fontSize: 13 }}>({dmy(data.ranges[period].from)} – {dmy(data.ranges[period].to)})</span></h3>
              <div className="chip-row">
                {PERIODS.map((p) => <button key={p} type="button" className={`chip${p === period ? ' active' : ''}`} onClick={() => setPeriod(p)}>{PRESET_LABELS[p]}</button>)}
              </div>
            </div>
            {costRows.length === 0 ? <div className="empty-state">No storage charges in this period.</div> : (
              <>
                <BarList rows={costRows.slice(0, 10)} format={money} total={costTotal} />
                <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 10 }}>
                  Total {money(costTotal)}{costRows.length > 10 ? ` · showing top 10 of ${costRows.length} clients` : ''}
                </div>
              </>
            )}
          </div>

          <div className="panel" style={{ padding: 0, marginBottom: 16 }}>
            <div style={{ overflowX: 'auto' }}>
              <table className="ticket-table">
                <thead><tr><th>Client</th>{PERIODS.map((p) => <th key={p} style={{ textAlign: 'right' }}>{PRESET_LABELS[p]}</th>)}</tr></thead>
                <tbody>
                  {data.costByClient.map((r) => (
                    <tr key={r.client}><td>{r.client}</td>{PERIODS.map((p) => <td key={p} style={{ textAlign: 'right' }}>{money(r[p])}</td>)}</tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="panel panel-pad">
            <h3 style={{ fontSize: 15, marginBottom: 14 }}>Items in storage per client</h3>
            {itemRows.length === 0 ? <div className="empty-state">Nothing in storage.</div>
              : <BarList rows={itemRows} format={(n) => `${n} item${n === 1 ? '' : 's'}`} total={itemRows.reduce((t, r) => t + r.value, 0)} />}
          </div>
        </>
      )}
    </Layout>
  );
}

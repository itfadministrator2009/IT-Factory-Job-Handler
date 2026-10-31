import { useEffect, useMemo, useState } from 'react';
import { Search, Download, X, Filter, ChevronLeft, ChevronRight } from 'lucide-react';
import portalApi from './portalApi';
import { BarList, ColumnChart, Donut, StatTile, CHART_COLORS as C, SERIES } from '../components/Charts';

// Client portal → Audited assets: the client's assets from the ITF Asset Tracker
// (matched on the Customer names IT Factory linked to their login). The server
// only ever sends device details, condition, data wiping, job number, audit
// month and comments.

const FILTERS = [
  { param: 'month', label: 'Audit month' },
  { param: 'category', label: 'Category' },
  { param: 'job', label: 'Job number', wide: true },
];
const NONE = '__none__';
const PAGE = 100;
const join = (v) => (Array.isArray(v) ? v.join(', ') : v ?? '');
const sydneyDate = (utc) => {
  const ms = Date.parse(`${String(utc || '').replace(' ', 'T')}Z`);
  return Number.isNaN(ms) ? '' : new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Sydney', day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date(ms));
};
// Short summary of a multi-select condition list ("Ok" shows as OK).
const condText = (v) => { const a = Array.isArray(v) ? v : v ? [v] : []; return a.join(', '); };

function Card({ title, subtitle, children, span }) {
  return (
    <section className="panel" style={{ padding: 18, gridColumn: span ? '1 / -1' : undefined, minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
        <h3 style={{ fontSize: 15, flex: 1 }}>{title}</h3>
        {subtitle && <span style={{ fontSize: 12, color: 'var(--muted)' }}>{subtitle}</span>}
      </div>
      {children}
    </section>
  );
}

function AssetDetail({ asset, fields, onClose }) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 760, width: '95vw', maxHeight: '90vh', overflowY: 'auto' }}>
        <div className="modal-header">
          <h3>{asset.fields.asset_tag || asset.fields.serial_number || 'Asset'}</h3>
          <button type="button" onClick={onClose}><X size={18} /></button>
        </div>
        <dl style={{ display: 'grid', gridTemplateColumns: 'minmax(140px, 220px) 1fr', gap: '8px 16px', margin: 0, fontSize: 14 }}>
          <dt style={{ color: 'var(--muted)' }}>Date added</dt><dd style={{ margin: 0 }}>{sydneyDate(asset.createdAt)}</dd>
          {fields.map((f) => {
            const v = asset.fields[f.key];
            if (v == null || v === '' || (Array.isArray(v) && !v.length)) return null;
            return [
              <dt key={`${f.key}-l`} style={{ color: 'var(--muted)' }}>{f.label}</dt>,
              <dd key={`${f.key}-v`} style={{ margin: 0, whiteSpace: f.type === 'textarea' ? 'pre-wrap' : undefined }}>
                {Array.isArray(v) ? (
                  <span style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap' }}>
                    {v.map((x) => <span key={x} className="pill" style={{ background: '#eef3f2', color: '#1d4d50' }}>{x}</span>)}
                  </span>
                ) : String(v)}
              </dd>,
            ];
          })}
        </dl>
      </div>
    </div>
  );
}

export default function AuditedAssets() {
  const [options, setOptions] = useState(null);
  const [filters, setFilters] = useState({ month: '', category: '', job: '' });
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [list, setList] = useState(null);
  const [summary, setSummary] = useState(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(null);
  const [exporting, setExporting] = useState(false);

  const params = useMemo(() => {
    const p = { q: search };
    Object.entries(filters).forEach(([k, v]) => { if (v) p[k] = v; });
    return p;
  }, [filters, search]);

  useEffect(() => {
    portalApi.get('/assets/options').then((r) => setOptions(r.data)).catch((err) => setError(err.response?.data?.error || 'Could not load your assets'));
  }, []);
  useEffect(() => {
    setSummary(null);
    portalApi.get('/assets/summary', { params }).then((r) => setSummary(r.data)).catch(() => {});
  }, [params]);
  useEffect(() => {
    setList(null);
    portalApi.get('/assets', { params: { ...params, page, limit: PAGE } })
      .then((r) => setList(r.data)).catch((err) => setError(err.response?.data?.error || 'Could not load your assets'));
  }, [params, page]);

  const setFilter = (k, v) => { setFilters((f) => ({ ...f, [k]: v })); setPage(1); };
  const clearAll = () => { setFilters({ month: '', category: '', job: '' }); setQuery(''); setSearch(''); setPage(1); };
  const anyFilter = search || Object.values(filters).some(Boolean);

  async function exportCsv() {
    setExporting(true);
    try {
      const res = await portalApi.get('/assets/export', { params, responseType: 'blob' });
      const name = /filename="([^"]+)"/.exec(res.headers['content-disposition'] || '')?.[1] || 'audited-assets.csv';
      const url = URL.createObjectURL(res.data);
      const a = document.createElement('a'); a.href = url; a.download = name;
      document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
    } catch (err) {
      setError('Could not download the spreadsheet');
    } finally {
      setExporting(false);
    }
  }

  const fields = options?.fields || [];
  const months = (summary?.byMonth || []).map((m) => ({ label: m.label, short: m.label.replace(/^(\w{3})\w*\s+(\d{2})(\d{2})$/, '$1 $3'), value: m.count }));
  const cats = (summary?.byCategory || []).slice(0, 10).map((c) => ({ label: c.label, value: c.count }));
  const makes = (() => {
    const rows = summary?.byManufacturer || [];
    const shown = rows.filter((r) => r.label !== '(not set)').slice(0, 7).map((r, i) => ({ label: r.label, value: r.count, color: SERIES[i] }));
    const rest = rows.filter((r) => !shown.some((s) => s.label === r.label)).reduce((t, r) => t + r.count, 0);
    return rest ? [...shown, { label: 'Other / not set', value: rest, color: C.neutral }] : shown;
  })();
  const services = (summary?.byService || []).slice(0, 10).map((s) => ({ label: s.label, value: s.count }));

  return (
    <>
      {error && <div className="error-banner">{error}</div>}

      <div className="filter-bar">
        <span className="filter-bar-title"><Filter size={14} /> Filter</span>
        <form onSubmit={(e) => { e.preventDefault(); setSearch(query.trim()); setPage(1); }} style={{ display: 'flex', gap: 6, flex: '1 1 260px', minWidth: 220 }}>
          <div style={{ position: 'relative', flex: 1 }}>
            <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--muted)' }} />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search asset tag, serial, model, job…" style={{ paddingLeft: 30, width: '100%', height: '100%', minHeight: 44, boxSizing: 'border-box' }} />
          </div>
          <button type="submit" className="btn btn-ghost btn-sm">Search</button>
        </form>
        {FILTERS.map(({ param, label, wide }) => (
          <label key={param} className={`filter-field${filters[param] ? ' active' : ''}${wide ? ' wide' : ''}`}>
            <span className="filter-field-label">{label}</span>
            <select aria-label={label} value={filters[param]} onChange={(e) => setFilter(param, e.target.value)}>
              <option value="">All</option>
              {(options?.[param] || []).filter((o) => o.value).map((o) => <option key={o.value} value={o.value}>{o.value} ({o.count})</option>)}
              {(options?.[param] || []).some((o) => !o.value) && <option value={NONE}>(not set)</option>}
            </select>
          </label>
        ))}
        {anyFilter && <button type="button" className="filter-clear" onClick={clearAll}><X size={13} /> Clear filters</button>}
        <button type="button" className="btn btn-ghost btn-sm" style={{ marginLeft: 'auto', alignSelf: 'center' }} disabled={exporting || !list?.total} onClick={exportCsv}>
          <Download size={14} /> {exporting ? 'Preparing…' : 'Download spreadsheet'}
        </button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 14, marginBottom: 18 }}>
        <StatTile label="Audited assets" value={summary?.total ?? 0} accent="#16241f" sub={anyFilter ? 'matching your filters' : 'all audited assets'} />
        <StatTile label="Audit months" value={(summary?.byMonth || []).filter((m) => m.label !== '(not set)').length} accent={C.blue} />
        <StatTile label="Categories" value={(summary?.byCategory || []).filter((m) => m.label !== '(not set)').length} accent={C.aqua} />
        <StatTile label="Data wiped / shredded" value={summary?.dataWiped ?? 0} accent={C.violet}
          sub={summary?.total ? `${Math.round(((summary.dataWiped || 0) / summary.total) * 100)}% of these assets` : undefined} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(480px, 100%), 1fr))', gap: 18, marginBottom: 18 }}>
        <Card title="Assets by audit month" span>
          {summary ? <ColumnChart data={months} color={C.blue} height={210} /> : <p className="muted">Loading…</p>}
        </Card>
        <Card title="By category">
          {summary ? <BarList data={cats} color={C.aqua} /> : <p className="muted">Loading…</p>}
        </Card>
        <Card title="By manufacturer">
          {summary ? <Donut data={makes} centerLabel="assets" /> : <p className="muted">Loading…</p>}
        </Card>
        <Card title="Data wiping & services" subtitle="assets with each one ticked" span>
          {summary ? <BarList data={services} color={C.violet} emptyText="No services recorded yet." labelWidth={170} /> : <p className="muted">Loading…</p>}
        </Card>
      </div>

      <div className="panel" style={{ padding: 0 }}>
        {!list ? <div className="empty-state">Loading…</div> : list.assets.length === 0 ? (
          <div className="empty-state"><h3>{anyFilter ? 'No assets match' : 'No audited assets yet'}</h3></div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="ticket-table">
              <thead>
                <tr>
                  <th>Asset tag</th><th>Category</th><th>Make</th><th>Model</th><th>Serial</th><th>Client tag</th>
                  <th>Specs</th><th>Data wiping</th><th>Job #</th><th>Audit month</th><th>Date</th>
                </tr>
              </thead>
              <tbody>
                {list.assets.map((a) => {
                  const f = a.fields;
                  return (
                    <tr key={a.id} className="clickable" onClick={() => setOpen(a)}>
                      <td>{f.asset_tag}</td>
                      <td>{f.category}</td>
                      <td>{f.manufacturer}</td>
                      <td>{[f.model_name, f.model_number].filter(Boolean).join(' ')}</td>
                      <td style={{ fontFamily: 'var(--font-mono, monospace)' }}>{f.serial_number}</td>
                      <td>{f.client_asset_tag}</td>
                      <td style={{ fontSize: 13 }}>{[f.cpu_gen, f.ram, f.hdd].filter(Boolean).join(' · ')}</td>
                      <td style={{ fontSize: 13 }}>{condText(f.condition_services)}</td>
                      <td>{join(f.zoho_ticket_number)}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>{f.audit_month}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>{sydneyDate(a.createdAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {list && list.totalPages > 1 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, justifyContent: 'center', marginTop: 12, fontSize: 13 }}>
          <button type="button" className="btn btn-ghost btn-sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}><ChevronLeft size={14} /> Previous</button>
          <span>Page {list.page} of {list.totalPages} · {list.total.toLocaleString('en-AU')} assets</span>
          <button type="button" className="btn btn-ghost btn-sm" disabled={page >= list.totalPages} onClick={() => setPage((p) => p + 1)}>Next <ChevronRight size={14} /></button>
        </div>
      )}
      <p style={{ fontSize: 12, color: 'var(--muted)', marginTop: 10 }}>Click an asset to see its full audit details, including condition and comments.</p>

      {open && <AssetDetail asset={open} fields={fields} onClose={() => setOpen(null)} />}
    </>
  );
}

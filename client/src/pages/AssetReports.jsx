import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Printer } from 'lucide-react';
import Layout from '../components/Layout';
import api from '../api';
import { Donut, BarList, ColumnChart, StatTile, CHART_COLORS as C, SERIES } from '../components/Charts';

// ITF Asset Tracker reports: headline numbers, then charts (status, where sent,
// asset class, customer, monthly intake, technician), then the detailed asset
// class table. A customer can be picked at the top to see everything for just
// that customer. Every number, slice and bar opens the matching assets.
const NONE = '__none__';
const STATUS_ORDER = ['Available', 'Sold'];
const SENT_ORDER = ['ITF Australia', 'Wholesale', 'Return to Client', 'E-Waste'];
const STATUS_COLORS = { Available: C.blue, Sold: C.orange };
const SENT_COLORS = { 'ITF Australia': C.blue, Wholesale: C.orange, 'Return to Client': C.aqua, 'E-Waste': C.yellow };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function assetsLink(filters) {
  const p = new URLSearchParams();
  Object.entries(filters).forEach(([k, v]) => { if (v) p.set(k, v); });
  return `/assets?${p.toString()}`;
}

// The last 12 months, oldest first, with empty months shown as 0.
function lastTwelveMonths(byMonth) {
  const counts = new Map(byMonth.map((r) => [r.period, r.count]));
  const now = new Date();
  const out = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    out.push({ label: `${MONTHS[d.getMonth()]} ${d.getFullYear()}`, short: `${MONTHS[d.getMonth()]}${d.getMonth() === 0 || i === 11 ? ` ${String(d.getFullYear()).slice(2)}` : ''}`, value: counts.get(key) || 0 });
  }
  return out;
}

function Card({ title, subtitle, children, span = 1, action }) {
  return (
    <section className="panel" style={{ padding: 18, gridColumn: span === 2 ? '1 / -1' : undefined, minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
        <h3 style={{ fontSize: 15, flex: 1 }}>{title}</h3>
        {subtitle && <span style={{ fontSize: 12, color: 'var(--muted)' }}>{subtitle}</span>}
        {action}
      </div>
      {children}
    </section>
  );
}

export default function AssetReports() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const customer = params.get('customer') || '';
  const [data, setData] = useState(null);
  const [customers, setCustomers] = useState([]);
  const [error, setError] = useState('');

  useEffect(() => {
    setData(null);
    api.get('/assets/reports/summary', { params: customer ? { customer } : {} })
      .then((res) => { setData(res.data); if (!customer) setCustomers(res.data.byCompany); })
      .catch((err) => setError(err.response?.data?.error || 'Could not load reports'));
  }, [customer]);
  // The customer list always comes from the all-customer view.
  useEffect(() => {
    if (customer && !customers.length) api.get('/assets/reports/summary').then((r) => setCustomers(r.data.byCompany)).catch(() => {});
  }, [customer, customers.length]);

  const pickCustomer = (c) => {
    const next = new URLSearchParams(params);
    if (c) next.set('customer', c); else next.delete('customer');
    setParams(next, { replace: true });
  };
  const cust = customer === 'Unspecified' ? NONE : customer;
  const link = (f) => assetsLink({ customer: cust, ...f });

  const rows = useMemo(() => data?.classRows || [], [data]);
  const sumBy = (key) => {
    const m = new Map();
    rows.forEach((r) => m.set(r[key], (m.get(r[key]) || 0) + r.count));
    return m;
  };
  const byStatus = sumBy('status');
  const bySent = sumBy('sentTo');
  const total = data?.total || 0;

  const statusData = [
    ...STATUS_ORDER.map((s) => ({ label: s, value: byStatus.get(s) || 0, color: STATUS_COLORS[s], to: link({ status: s }) })),
    ...[...byStatus.keys()].filter((s) => s && !STATUS_ORDER.includes(s)).map((s, i) => ({ label: s, value: byStatus.get(s), color: SERIES[2 + i] || C.violet, to: link({ status: s }) })),
    { label: 'No status', value: byStatus.get('') || 0, color: C.neutral, to: link({ status: NONE }) },
  ];
  const sentData = [
    ...SENT_ORDER.map((s) => ({ label: s, value: bySent.get(s) || 0, color: SENT_COLORS[s], to: link({ sent_to: s }) })),
    ...[...bySent.keys()].filter((s) => s && !SENT_ORDER.includes(s)).map((s, i) => ({ label: s, value: bySent.get(s), color: SERIES[4 + i] || C.violet, to: link({ sent_to: s }) })),
    { label: 'Not sent yet', value: bySent.get('') || 0, color: C.neutral, to: link({ sent_to: NONE }) },
  ];

  // Asset class bars, split by status.
  const classData = useMemo(() => {
    const m = new Map();
    rows.forEach((r) => {
      const c = m.get(r.assetClass) || { label: r.assetClass, value: 0, parts: {} };
      c.value += r.count;
      const k = STATUS_ORDER.includes(r.status) ? r.status : 'other';
      c.parts[k] = (c.parts[k] || 0) + r.count;
      m.set(r.assetClass, c);
    });
    return [...m.values()].sort((a, b) => b.value - a.value)
      .map((c) => ({ ...c, to: link({ category: c.label === 'Unspecified' ? NONE : c.label }) }));
  }, [rows]); // eslint-disable-line react-hooks/exhaustive-deps

  // Customers: top 10 bars, the rest folded into "Other customers".
  const customerBars = useMemo(() => {
    const list = (customers || []).filter((c) => c.count > 0);
    const top = list.slice(0, 10).map((c) => ({ label: c.company, value: c.count, customer: c.company }));
    const rest = list.slice(10);
    if (rest.length) top.push({ label: `Other customers (${rest.length})`, value: rest.reduce((t, c) => t + c.count, 0) });
    return top;
  }, [customers]);

  const months = data ? lastTwelveMonths(data.byMonth) : [];
  const monthsTotal = months.reduce((t, m) => t + m.value, 0);
  const quarters = data ? [...data.byQuarter].slice(0, 8).reverse().map((q) => ({ label: q.period, value: q.count })) : [];
  const years = data ? data.byYear.map((y) => ({ label: y.period, value: y.count })) : [];
  const techs = data ? data.byTech.slice(0, 12).map((t) => ({ label: t.name, value: t.count })) : [];
  const available = byStatus.get('Available') || 0;
  const sold = byStatus.get('Sold') || 0;

  return (
    <Layout>
      <div className="page-header no-print">
        <div>
          <h1>Asset Reports</h1>
          <div className="subtitle">{customer ? <>Showing <strong>{customer}</strong> only.</> : 'Every asset on file.'} Click any chart, bar or number to see those assets.</div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <select value={customer} onChange={(e) => pickCustomer(e.target.value)} aria-label="Customer" style={{ minWidth: 230, fontWeight: customer ? 600 : 400 }}>
            <option value="">All customers</option>
            {customers.map((c) => <option key={c.company} value={c.company}>{c.company} ({c.count})</option>)}
          </select>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => window.print()}><Printer size={14} /> Print</button>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}
      {!data && !error && <div className="empty-state">Loading…</div>}

      {data && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 14, marginBottom: 18 }}>
            <StatTile label="Total assets" value={total} accent="#16241f" sub={customer || 'All customers'} onClick={() => navigate(link({}))} />
            <StatTile label="Available" value={available} accent={C.blue} sub={`${total ? Math.round((available / total) * 100) : 0}% of assets`} onClick={() => navigate(link({ status: 'Available' }))} />
            <StatTile label="Sold" value={sold} accent={C.orange} sub={`${total ? Math.round((sold / total) * 100) : 0}% of assets`} onClick={() => navigate(link({ status: 'Sold' }))} />
            <StatTile label="Sent to ITF Australia" value={bySent.get('ITF Australia') || 0} accent={C.blue} onClick={() => navigate(link({ sent_to: 'ITF Australia' }))} />
            <StatTile label="Sent to Wholesale" value={bySent.get('Wholesale') || 0} accent={C.orange} onClick={() => navigate(link({ sent_to: 'Wholesale' }))} />
          </div>

          <div className="report-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(420px, 100%), 1fr))', gap: 18, marginBottom: 18 }}>
            <Card title="Status">
              <Donut data={statusData} centerLabel="assets" navigate={navigate} />
            </Card>
            <Card title="Where assets were sent">
              <Donut data={sentData} centerLabel="assets" navigate={navigate} />
            </Card>

            <Card title="By asset class" subtitle="split by status">
              <BarList data={classData} navigate={navigate}
                segments={[{ key: 'Available', label: 'Available', color: C.blue }, { key: 'Sold', label: 'Sold', color: C.orange }, { key: 'other', label: 'No status', color: C.neutral }]} />
            </Card>
            <Card title="By customer" subtitle={customer ? 'click a customer to switch' : 'click a customer to see just them'}>
              <BarList data={customerBars} color={C.aqua} labelWidth={170}
                onSelect={(d) => d.customer && pickCustomer(d.customer === customer ? '' : d.customer)} />
            </Card>

            <Card title="Assets added per month" subtitle={`last 12 months · ${monthsTotal.toLocaleString('en-AU')} in total`} span={2}>
              <ColumnChart data={months} color={C.blue} height={220} />
            </Card>

            <Card title="By technician" subtitle={data.byTech.length > 12 ? 'top 12' : undefined}>
              <BarList data={techs} color={C.violet} />
            </Card>
            <Card title="By quarter" subtitle={quarters.length ? 'last 8 quarters' : undefined}>
              <ColumnChart data={quarters} color={C.aqua} height={200} />
              {years.length > 0 && (
                <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginTop: 12, fontSize: 13, color: 'var(--muted)' }}>
                  {years.map((y) => <span key={y.label}>{y.label}: <strong style={{ color: 'var(--ink, #16241f)' }}>{y.value.toLocaleString('en-AU')}</strong></span>)}
                </div>
              )}
            </Card>
          </div>

          <AssetClassTable rows={rows} cust={cust} />
        </>
      )}
    </Layout>
  );
}

// The detailed numbers behind the charts: each asset class with Available /
// Sold and where they were sent. Every number opens those assets.
function AssetClassTable({ rows, cust }) {
  const statuses = [...STATUS_ORDER, ...new Set(rows.map((r) => r.status).filter((v) => v && !STATUS_ORDER.includes(v)))];
  const sentTos = [...SENT_ORDER.filter((v) => rows.some((r) => r.sentTo === v)), ...new Set(rows.map((r) => r.sentTo).filter((v) => v && !SENT_ORDER.includes(v)))];
  const classes = useMemo(() => {
    const m = new Map();
    rows.forEach((r) => {
      const c = m.get(r.assetClass) || { name: r.assetClass, total: 0, status: {}, sent: {} };
      c.total += r.count;
      if (r.status) c.status[r.status] = (c.status[r.status] || 0) + r.count;
      if (r.sentTo) c.sent[r.sentTo] = (c.sent[r.sentTo] || 0) + r.count;
      m.set(r.assetClass, c);
    });
    return [...m.values()].sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
  }, [rows]);
  const sum = (fn) => classes.reduce((t, c) => t + (fn(c) || 0), 0);
  const cell = { textAlign: 'right', fontVariantNumeric: 'tabular-nums' };
  const cls = (name) => (name === 'Unspecified' ? NONE : name);
  const num = (n, filters) => (n ? <Link to={assetsLink({ customer: cust, ...filters })} title="Show these assets">{n.toLocaleString('en-AU')}</Link> : '—');

  return (
    <Card title="Asset class detail" subtitle="the numbers behind the charts" span={2}>
      {classes.length === 0 ? <p style={{ fontSize: 13, color: 'var(--muted)' }}>No data yet.</p> : (
        <div style={{ overflowX: 'auto' }}>
          <table className="ticket-table">
            <thead>
              <tr>
                <th>Asset class</th>
                <th style={cell}>Total</th>
                {statuses.map((s) => <th key={s} style={cell}>{s}</th>)}
                {sentTos.map((s) => <th key={s} style={cell}>Sent to {s}</th>)}
              </tr>
            </thead>
            <tbody>
              {classes.map((c) => (
                <tr key={c.name}>
                  <td>{c.name}</td>
                  <td style={{ ...cell, fontWeight: 600 }}>{num(c.total, { category: cls(c.name) })}</td>
                  {statuses.map((s) => <td key={s} style={cell}>{num(c.status[s], { category: cls(c.name), status: s })}</td>)}
                  {sentTos.map((s) => <td key={s} style={cell}>{num(c.sent[s], { category: cls(c.name), sent_to: s })}</td>)}
                </tr>
              ))}
              <tr style={{ fontWeight: 700 }}>
                <td>Total</td>
                <td style={cell}>{num(sum((c) => c.total), {})}</td>
                {statuses.map((s) => <td key={s} style={cell}>{num(sum((c) => c.status[s]), { status: s })}</td>)}
                {sentTos.map((s) => <td key={s} style={cell}>{num(sum((c) => c.sent[s]), { sent_to: s })}</td>)}
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

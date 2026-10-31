import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, Printer } from 'lucide-react';
import Layout from '../components/Layout';
import useSalesData from '../sales/useSalesData';
import { fmt, fmtInt, pct, num, str, printTable, auDate, toISODate } from '../sales/calc';

// "Sales By Product" (mode 'products') and "Inventory by Model" (mode 'models'):
// items grouped by make + model and item type.
export default function SalesGrouped({ mode }) {
  const isProducts = mode === 'products';
  const navigate = useNavigate();
  const { sales, inventory, calc, loading, error } = useSalesData({ sales: true, inventory: !isProducts });
  const [q, setQ] = useState('');
  const [sort, setSort] = useState({ col: 'count', dir: 'desc' });
  const list = isProducts ? sales : inventory;

  const groups = useMemo(() => {
    const g = {};
    (list || []).forEach((e) => {
      const label = `${str(e.make).trim()} ${str(e.model).trim()}`.trim() || '(no make/model)';
      const key = `${label.toLowerCase()}|${e.itemtype || ''}`;
      const x = (g[key] = g[key] || { product: label, itemtype: e.itemtype || '', count: 0, revenue: 0, net: 0, marginSum: 0, totalcost: 0, listedSum: 0 });
      x.count += 1;
      if (isProducts) { x.revenue += num(e.sellprice) + num(e.extendedwarranty); x.net += calc.net(e); x.marginSum += calc.margin(e); } else { x.totalcost += num(e.cost); x.listedSum += num(e.listed); }
    });
    let out = Object.values(g).map((x) => ({ ...x, avgmargin: x.count ? x.marginSum / x.count : 0, avglisted: x.count ? x.listedSum / x.count : 0 }));
    const ql = q.trim().toLowerCase();
    if (ql) out = out.filter((x) => x.product.toLowerCase().includes(ql));
    const sign = sort.dir === 'asc' ? 1 : -1;
    out.sort((a, b) => {
      const av = ['product', 'itemtype'].includes(sort.col) ? a[sort.col].toLowerCase() : a[sort.col];
      const bv = ['product', 'itemtype'].includes(sort.col) ? b[sort.col].toLowerCase() : b[sort.col];
      return av < bv ? -sign : av > bv ? sign : 0;
    });
    return out;
  }, [list, q, sort, calc, isProducts]);

  const th = (col, label, isNum) => (
    <th key={col} className={`${isNum ? 'num' : ''} sortable`}
      onClick={() => setSort((s) => (s.col === col ? { col, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { col, dir: isNum ? 'desc' : 'asc' }))}>
      {label}{sort.col === col ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ''}</th>
  );
  const cols = isProducts
    ? [{ label: 'Item' }, { label: 'Product' }, { label: 'Sold', num: true }, { label: 'Revenue', num: true }, { label: 'Net profit', num: true }, { label: 'Avg. margin', num: true }]
    : [{ label: 'Item' }, { label: 'Model' }, { label: 'On hand', num: true }, { label: 'Total cost', num: true }, { label: 'Avg. listed', num: true }];
  const rowOf = (g) => (isProducts ? [g.itemtype, g.product, fmtInt(g.count), fmt(g.revenue), fmt(g.net), pct(g.avgmargin)] : [g.itemtype, g.product, fmtInt(g.count), fmt(g.totalcost), fmt(g.avglisted)]);

  return (
    <Layout>
      <div className="page-header">
        <div>
          <h1>{isProducts ? 'Sales by Product' : 'Inventory by Model'}</h1>
          <div className="subtitle">{fmtInt(groups.length)} {isProducts ? 'products' : 'models'}{isProducts ? '' : ' · double-click a model to see those items'}</div>
        </div>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => printTable(isProducts ? 'Sales by Product' : 'Inventory by Model', `Printed ${auDate(toISODate(new Date()))}`, cols, groups.map(rowOf))}><Printer size={14} /> Print</button>
      </div>
      {error && <div className="error-banner">{error}</div>}
      <div className="filters">
        <div className="search-input" style={{ flex: '1 1 260px' }}><Search size={15} /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder={isProducts ? 'Search products…' : 'Search models…'} /></div>
        {q && <button type="button" className="btn btn-ghost btn-sm" onClick={() => setQ('')}>Clear filter</button>}
      </div>
      {loading ? <div className="panel panel-pad">Loading…</div> : (
        <div className="panel sales-table-wrap">
          <table className="ticket-table">
            <thead><tr>
              {th('itemtype', 'Item')}{th('product', isProducts ? 'Product' : 'Model')}{th('count', isProducts ? 'Sold' : 'On hand', true)}
              {isProducts ? <>{th('revenue', 'Revenue', true)}{th('net', 'Net profit', true)}{th('avgmargin', 'Avg. margin', true)}</> : <>{th('totalcost', 'Total cost', true)}{th('avglisted', 'Avg. listed', true)}</>}
            </tr></thead>
            <tbody>
              {groups.map((g) => (
                <tr key={`${g.product}|${g.itemtype}`} style={isProducts ? undefined : { cursor: 'pointer' }}
                  onDoubleClick={isProducts ? undefined : () => navigate('/sales/inventory', { state: { model: g.product } })}
                  title={isProducts ? undefined : 'Double-click to see these items in Inventory on Hand'}>
                  <td>{g.itemtype}</td><td>{g.product}</td><td className="num">{fmtInt(g.count)}</td>
                  {isProducts ? <>
                    <td className="num">{fmt(g.revenue)}</td><td className={`num ${g.net < 0 ? 'neg' : 'pos'}`}>{fmt(g.net)}</td><td className={`num ${g.net < 0 ? 'neg' : 'pos'}`}>{pct(g.avgmargin)}</td>
                  </> : <><td className="num">{fmt(g.totalcost)}</td><td className="num">{fmt(g.avglisted)}</td></>}
                </tr>
              ))}
            </tbody>
          </table>
          {!groups.length && <div className="empty-state" style={{ padding: 30 }}>Nothing to show yet.</div>}
        </div>
      )}
    </Layout>
  );
}

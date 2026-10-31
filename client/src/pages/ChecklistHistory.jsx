import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Search, Printer, Download, Trash2, Tag, RefreshCw, Pencil, X, Camera, ExternalLink } from 'lucide-react';
import api from '../api';
import Layout from '../components/Layout';
import useFitHeight from '../sales/useFitHeight';
import {
  useChecklistConfig, DEVICE_ORDER, itemsOf, requiredItemsOf, makeModel, auDate, auDateTime, gradeClass, driveLink, photoUrl, photoDataUrl,
  printChecklists, printChecklistList, MULTILINE_FIELDS,
} from '../checklist/common';

const SORTS = [
  ['assetId', 'Asset ID'], ['date', 'Date'], ['technician', 'Technician'], ['makeModel', 'Make / model'], ['serial', 'Serial number'],
  ['grade', 'Cosmetic grade'], ['checked', 'Items checked'], ['photos', 'Photos'], ['platform', 'Platform'],
];
const csvCell = (v) => { const s = v === null || v === undefined ? '' : String(v); return /["\n,\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

// Saved History — every saved checklist for one device type.
export default function ChecklistHistory() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const { config, error: cfgError } = useChecklistConfig();
  const deviceKey = params.get('device') || 'laptop';
  const device = config?.deviceTypes[deviceKey];
  const [entries, setEntries] = useState(null);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const [q, setQ] = useState('');
  const [gradeF, setGradeF] = useState('');
  const [platformF, setPlatformF] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [sort, setSort] = useState(null);
  const [selected, setSelected] = useState(new Set());
  const [open, setOpen] = useState(null); // entry id in the detail view
  const [platformModal, setPlatformModal] = useState(false);
  const [busy, setBusy] = useState('');
  const fitRef = useFitHeight();

  const load = useCallback(async () => {
    setError('');
    try {
      const r = await api.get('/checklist/entries', { params: { device: deviceKey } });
      setEntries(r.data.entries);
    } catch (err) { setError(err.response?.data?.error || 'Could not load Saved History'); }
  }, [deviceKey]);
  useEffect(() => { setEntries(null); setSelected(new Set()); load(); }, [load]);

  // Pass/fail items only, like the form's progress bar (the "tick if applicable" features don't count).
  const reqItems = device ? requiredItemsOf(device) : [];
  const total = reqItems.length;
  const checkedOf = (e) => e.items.filter((i) => reqItems.includes(i)).length;
  const shown = useMemo(() => {
    let list = entries || [];
    const ql = q.trim().toLowerCase();
    if (ql) list = list.filter((e) => [e.assetId, e.technician, e.grade, e.platform, e.notes, e.date, ...Object.values(e.info || {})].join(' ').toLowerCase().includes(ql));
    if (gradeF) list = list.filter((e) => e.grade === gradeF);
    if (platformF) list = list.filter((e) => (platformF === '(none)' ? !e.platform : e.platform === platformF));
    if (from) list = list.filter((e) => e.date && e.date >= from);
    if (to) list = list.filter((e) => e.date && e.date <= to);
    if (sort) {
      const gi = (l) => { const i = config.cosmeticGrades.findIndex((g) => g.label === l); return i === -1 ? 999 : i; };
      const val = (e) => ({
        assetId: e.assetId, date: e.date, technician: e.technician.toLowerCase(), makeModel: makeModel(e).toLowerCase(),
        serial: String(e.info?.['Serial Number'] || '').toLowerCase(), grade: gi(e.grade), checked: checkedOf(e),
        photos: e.photoCount || 0, platform: (e.platform || '').toLowerCase(),
      })[sort.col];
      const sign = sort.dir === 'asc' ? 1 : -1;
      list = [...list].sort((a, b) => { const x = val(a); const y = val(b); return x < y ? -sign : x > y ? sign : 0; });
    }
    return list;
  }, [entries, q, gradeF, platformF, from, to, sort, config]);

  const filtered = !!(q || gradeF || platformF || from || to);
  const pick = (id, on) => setSelected((s) => { const n = new Set(s); if (on) n.add(id); else n.delete(id); return n; });
  const allOn = shown.length > 0 && shown.every((e) => selected.has(e.id));
  const selList = shown.filter((e) => selected.has(e.id));

  const del = async (ids) => {
    if (!window.confirm(ids.length === 1 ? 'Delete this saved checklist? This cannot be undone.' : `Delete ${ids.length} saved checklists? This cannot be undone.`)) return;
    try {
      const r = await api.post('/checklist/entries/delete', { ids });
      setMsg(`Deleted ${r.data.deleted} ${r.data.deleted === 1 ? 'entry' : 'entries'}.`);
      setSelected(new Set()); setOpen(null); load();
    } catch (err) { setError(err.response?.data?.error || 'Could not delete'); }
  };
  const retry = async (e) => {
    setBusy(e.id);
    try {
      await api.post(`/checklist/entries/${e.id}/sync`);
      setMsg(`${e.assetId} is now in Sales Manager → Inventory on Hand.`); load();
    } catch (err) { setError(err.response?.data?.error || 'Could not add it to Sales Manager'); }
    setBusy('');
  };
  const printFull = async (list) => {
    setBusy('print');
    try {
      const out = [];
      for (const e of list) {
        const full = (await api.get(`/checklist/entries/${e.id}`)).data.entry;
        const pics = [];
        for (const p of full.photos) pics.push(await photoDataUrl(p.id).catch(() => null));
        out.push({ entry: full, photos: pics });
      }
      printChecklists(config, out);
    } catch (err) { setError(err.response?.data?.error || 'Could not print'); }
    setBusy('');
  };
  const exportCsv = () => {
    if (!shown.length) return;
    const header = ['Asset ID', 'Date', 'Technician', 'Last Edited By', ...device.infoFields, 'Cosmetic Grade', 'Items Checked', 'Total Items', 'Photos', 'Platform', 'In Sales Manager', 'Condition Notes'];
    const lines = [header.map(csvCell).join(',')];
    shown.forEach((e) => lines.push([e.assetId, auDate(e.date), e.technician, e.lastEditedBy, ...device.infoFields.map((f) => e.info?.[f] || ''),
      e.grade, checkedOf(e), total, e.photoCount || 0, e.platform, e.platform === 'ITF Australia' ? (e.salesItemId ? 'Yes' : 'No') : 'n/a', e.notes].map(csvCell).join(',')));
    const url = URL.createObjectURL(new Blob([`﻿${lines.join('\r\n')}`], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url; a.download = `ITF-Asset-Checklist-${device.label.replace(/\s+/g, '-')}-${new Date().toISOString().slice(0, 10)}.csv`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const th = (col, label) => (
    <th key={col} className="sortable" onClick={() => setSort((s) => (s?.col === col ? { col, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { col, dir: 'asc' }))}>
      {label}{sort?.col === col ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ''}
    </th>
  );
  const syncCell = (e) => (e.salesItemId ? <span title="In Sales Manager → Inventory on Hand">✅</span>
    : e.platform === 'ITF Australia' ? <button type="button" className="btn btn-ghost btn-sm" disabled={busy === e.id} onClick={(ev) => { ev.stopPropagation(); retry(e); }}><RefreshCw size={12} /> Retry</button> : '—');

  const err0 = cfgError || error;
  return (
    <Layout>
      <div className="page-header">
        <div><h1>Saved History</h1><div className="subtitle">{device ? `${device.label} checklists` : ' '}{entries ? ` · ${filtered ? `showing ${shown.length} of ${entries.length}` : `${entries.length} ${entries.length === 1 ? 'entry' : 'entries'}`}` : ''}</div></div>
        <div className="ck-head-links">
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => printChecklistList(config, deviceKey, shown)} disabled={!shown.length}><Printer size={14} /> Print list</button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={exportCsv} disabled={!shown.length}><Download size={14} /> Export CSV</button>
          <Link to={`/checklist/new/${deviceKey}`} className="btn btn-accent btn-sm">New {device?.label || ''} checklist</Link>
        </div>
      </div>
      {err0 && <div className="error-banner">{err0}</div>}
      {msg && <div className="success-banner"><span>{msg}</span><button type="button" onClick={() => setMsg('')} aria-label="Dismiss"><X size={14} /></button></div>}
      {config && (
        <div className="period-tabs">
          {DEVICE_ORDER.filter((k) => config.deviceTypes[k]).map((k) => (
            <button key={k} type="button" className={`btn btn-sm ${k === deviceKey ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setParams({ device: k })}>{config.deviceTypes[k].label}</button>
          ))}
        </div>
      )}
      <div className="filters">
        <div className="search-input" style={{ flex: '1 1 240px' }}><Search size={15} /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search this list…" /></div>
        <select value={gradeF} onChange={(e) => setGradeF(e.target.value)} aria-label="Grade">
          <option value="">All grades</option>{config?.cosmeticGrades.map((g) => <option key={g.code} value={g.label}>{g.label}</option>)}
        </select>
        <select value={platformF} onChange={(e) => setPlatformF(e.target.value)} aria-label="Platform">
          <option value="">All platforms</option>{config?.platformOptions.map((p) => <option key={p}>{p}</option>)}<option value="(none)">No platform</option>
        </select>
        <label className="inline-field">From <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="inline-field">To <input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        {filtered && <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setQ(''); setGradeF(''); setPlatformF(''); setFrom(''); setTo(''); }}>Clear filters</button>}
      </div>
      {selected.size > 0 && (
        <div className="bulk-toolbar">
          <strong>{selected.size} selected</strong>
          <button type="button" onClick={() => printFull(selList)} disabled={busy === 'print'}><Printer size={14} /> {busy === 'print' ? 'Preparing…' : 'Print selected'}</button>
          <button type="button" onClick={() => setPlatformModal(true)}><Tag size={14} /> Set platform</button>
          <button type="button" onClick={() => del([...selected])}><Trash2 size={14} /> Delete selected</button>
          <button type="button" onClick={() => setSelected(new Set())}>Clear selection</button>
        </div>
      )}
      {!entries || !config ? <div className="panel panel-pad">Loading…</div> : (
        <>
          <div className="panel sales-table-wrap ck-history-table" ref={fitRef}>
            <table className="ticket-table sales-table">
              <thead><tr>
                <th className="c"><input type="checkbox" aria-label="Select all shown" checked={allOn} onChange={(e) => setSelected((s) => { const n = new Set(s); shown.forEach((x) => (e.target.checked ? n.add(x.id) : n.delete(x.id))); return n; })} /></th>
                {SORTS.filter(([c]) => (c === 'makeModel' ? device.infoFields.includes('Model') : c === 'serial' ? device.infoFields.includes('Serial Number') : c === 'checked' ? total > 0 : true)).map(([c, l]) => th(c, l))}
                <th>Sales Mgr</th><th />
              </tr></thead>
              <tbody>
                {shown.map((e) => (
                  <tr key={e.id} className={`clickable${selected.has(e.id) ? ' row-picked' : ''}`} onClick={() => setOpen(e.id)}>
                    <td className="c" onClick={(ev) => ev.stopPropagation()}><input type="checkbox" checked={selected.has(e.id)} onChange={(ev) => pick(e.id, ev.target.checked)} aria-label={`Select ${e.assetId}`} /></td>
                    <td className="mono"><strong>{e.assetId}</strong></td>
                    <td>{auDate(e.date)}</td>
                    <td>{e.technician}{e.lastEditedBy && e.lastEditedBy !== e.technician ? <span className="ck-edited" title={`Last edited by ${e.lastEditedBy}`}> ✎ edited</span> : ''}</td>
                    {device.infoFields.includes('Model') && <td className="cell-nowrap">{makeModel(e)}</td>}
                    {device.infoFields.includes('Serial Number') && <td className="mono">{e.info?.['Serial Number']}</td>}
                    <td>{e.grade ? <span className={`ck-grade ${gradeClass(config, e.grade)}`}>{e.grade}</span> : ''}</td>
                    {total > 0 && <td>{checkedOf(e)} / {total}</td>}
                    <td>{e.photoCount ? <><Camera size={13} /> {e.photoCount}</> : '—'}</td>
                    <td>{e.platform || '—'}</td>
                    <td onClick={(ev) => ev.stopPropagation()}>{syncCell(e)}</td>
                    <td onClick={(ev) => ev.stopPropagation()}><button type="button" className="row-menu-btn" title="Delete" aria-label={`Delete ${e.assetId}`} onClick={() => del([e.id])}><Trash2 size={15} /></button></td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!shown.length && <div className="empty-state" style={{ padding: 30 }}>{entries.length ? 'No entries match your search or filters.' : 'No saved entries yet for this checklist.'}</div>}
          </div>
          <div className="ck-cards">
            {shown.map((e) => (
              <div key={e.id} className={`ck-card${selected.has(e.id) ? ' picked' : ''}`} onClick={() => setOpen(e.id)}>
                <div className="ck-card-head">
                  <label onClick={(ev) => ev.stopPropagation()}><input type="checkbox" checked={selected.has(e.id)} onChange={(ev) => pick(e.id, ev.target.checked)} /> <strong className="mono">{e.assetId}</strong></label>
                  <span className="muted">{auDate(e.date)}</span>
                </div>
                <div>{makeModel(e) || e.info?.['Product Type'] || '—'}</div>
                <div className="muted">{e.technician}{e.info?.['Serial Number'] ? ` · ${e.info['Serial Number']}` : ''}</div>
                <div className="ck-card-foot">
                  {e.grade && <span className={`ck-grade ${gradeClass(config, e.grade)}`}>{e.grade}</span>}
                  {total > 0 && <span className="muted">{checkedOf(e)} / {total}</span>}
                  {e.platform && <span className="muted">{e.platform}</span>}
                  <span onClick={(ev) => ev.stopPropagation()}>{e.platform === 'ITF Australia' ? syncCell(e) : null}</span>
                </div>
              </div>
            ))}
            {!shown.length && <div className="panel panel-pad muted">{entries.length ? 'No entries match your search or filters.' : 'No saved entries yet for this checklist.'}</div>}
          </div>
        </>
      )}
      {open && <EntryDetail id={open} config={config} onClose={() => setOpen(null)} onEdit={() => navigate(`/checklist/edit/${open}`)} onDelete={() => del([open])} onPrint={(e) => printFull([e])} />}
      {platformModal && <PlatformModal config={config} count={selected.size} onClose={() => setPlatformModal(false)}
        onApply={async (platform) => {
          try {
            const r = await api.post('/checklist/entries/bulk-platform', { ids: [...selected], platform });
            setMsg(`Platform set on ${r.data.updated} ${r.data.updated === 1 ? 'entry' : 'entries'}${r.data.synced ? ` — ${r.data.synced} added to Sales Manager` : ''}.`);
            setPlatformModal(false); setSelected(new Set()); load();
          } catch (err) { setError(err.response?.data?.error || 'Could not update'); }
        }} />}
    </Layout>
  );
}

// One saved checklist, in full.
function EntryDetail({ id, config, onClose, onEdit, onDelete, onPrint }) {
  const [e, setE] = useState(null);
  const [urls, setUrls] = useState({});
  useEffect(() => {
    let alive = true;
    const made = [];
    api.get(`/checklist/entries/${id}`).then(async (r) => {
      if (!alive) return;
      setE(r.data.entry);
      for (const p of r.data.entry.photos) {
        try { const u = await photoUrl(p.id); made.push(u); if (alive) setUrls((m) => ({ ...m, [p.id]: u })); } catch { /* skip */ }
      }
    }).catch(() => setE(false));
    return () => { alive = false; made.forEach((u) => URL.revokeObjectURL(u)); };
  }, [id]);
  const device = e ? config.deviceTypes[e.deviceKey] : null;
  const ticked = new Set(e?.items || []);
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card ck-modal-wide" onClick={(ev) => ev.stopPropagation()}>
        <div className="modal-header"><h3>{e ? `${device.label} — ${e.assetId}` : 'Checklist'}</h3><button type="button" onClick={onClose} aria-label="Close"><X size={18} /></button></div>
        {e === null && <div className="muted">Loading…</div>}
        {e === false && <div className="error-banner">This checklist no longer exists.</div>}
        {e && (
          <div className="ck-detail">
            <div className="ck-meta">
              <div><strong>Date</strong>{auDate(e.date) || '—'}</div>
              <div><strong>Technician</strong>{e.technician || '—'}</div>
              <div><strong>Saved</strong>{auDateTime(e.createdAt) || '—'}</div>
              {e.lastEditedBy && <div><strong>Last edited by</strong>{e.lastEditedBy}</div>}
              {device.infoFields.map((f) => <div key={f} className={MULTILINE_FIELDS.includes(f) ? 'wide' : ''}><strong>{f}</strong>{e.info?.[f] || '—'}</div>)}
              <div><strong>Cosmetic grade</strong>{e.grade ? <span className={`ck-grade ${gradeClass(config, e.grade)}`}>{e.grade}</span> : '—'}</div>
              <div><strong>Platform</strong>{e.platform || '—'}</div>
              {e.platform === 'ITF Australia' && <div><strong>Sales Manager</strong>{e.salesItemId ? 'In Inventory on Hand' : 'Not added yet'}</div>}
            </div>
            {device.sections.map((s) => (
              <div key={s.title}>
                <h4>{s.title}</h4>
                <ul className="ck-detail-items">{s.items.map((i) => <li key={i} className={ticked.has(i) ? 'y' : 'n'}>{i}</li>)}</ul>
              </div>
            ))}
            <h4>Condition notes</h4>
            <div className="ck-notes">{e.notes || '—'}</div>
            {(e.photos.length > 0 || e.drivePhotoIds.length > 0) && (
              <>
                <h4>Photos</h4>
                <div className="ck-photos">
                  {e.photos.map((p) => <div key={p.id} className="ck-thumb big">{urls[p.id] ? <a href={urls[p.id]} target="_blank" rel="noreferrer"><img src={urls[p.id]} alt="" /></a> : <span>Loading…</span>}</div>)}
                  {e.drivePhotoIds.map((d) => <div key={d} className="ck-thumb drive"><a href={driveLink(d)} target="_blank" rel="noreferrer"><ExternalLink size={14} /> Google Drive photo</a></div>)}
                </div>
              </>
            )}
          </div>
        )}
        {e && (
          <div className="ck-detail-actions">
            <button type="button" className="btn btn-ghost" onClick={onEdit}><Pencil size={14} /> Edit</button>
            <button type="button" className="btn btn-ghost" onClick={() => onPrint(e)}><Printer size={14} /> Print</button>
            <button type="button" className="btn btn-ghost danger-text" onClick={onDelete}><Trash2 size={14} /> Delete</button>
          </div>
        )}
      </div>
    </div>
  );
}

function PlatformModal({ config, count, onClose, onApply }) {
  const [v, setV] = useState('');
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header"><h3>Set platform</h3><button type="button" onClick={onClose} aria-label="Close"><X size={18} /></button></div>
        <p className="muted" style={{ marginTop: 0 }}>For {count} selected {count === 1 ? 'entry' : 'entries'}. Choosing ITF Australia adds any that aren't there yet to Sales Manager → Inventory on Hand.</p>
        <div className="field"><label>Platform</label>
          <select value={v} onChange={(e) => setV(e.target.value)}>
            <option value="">(no platform)</option>{config.platformOptions.map((p) => <option key={p}>{p}</option>)}
          </select>
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
          <button type="button" className="btn btn-ghost" style={{ flex: 1 }} onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-accent" style={{ flex: 1 }} onClick={() => onApply(v)}>Apply</button>
        </div>
      </div>
    </div>
  );
}

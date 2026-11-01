import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Plus, X } from 'lucide-react';
import api from '../api';

const SHOW = 150; // rows drawn at once — type to narrow down the rest

// A drop-down you can type in to search, for Model Name, Model Number and Customer
// on an asset. Lists every value already used (most used first) — the ones that go
// with the chosen Manufacturer / Model Name come first — and "+ Add" puts a new
// value on the list.
export default function ComboField({ field, label, value, onChange, manufacturer = '', modelName = '' }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [values, setValues] = useState(null);
  const [active, setActive] = useState(0);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState('');
  const box = useRef(null);
  const list = useRef(null);
  const scopeKey = `${manufacturer}|${modelName}`;
  const loadedFor = useRef(null);

  function load() {
    if (loadedFor.current === scopeKey && values) return;
    loadedFor.current = scopeKey;
    api.get('/assets/value-options', { params: { field, manufacturer, model_name: modelName } })
      .then((r) => setValues(r.data.values))
      .catch(() => setValues([]));
  }
  // The make/model changed: the next open re-sorts the list for it.
  useEffect(() => { loadedFor.current = null; }, [scopeKey]);

  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => { if (box.current && !box.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const q = text.trim().toLowerCase();
  const { first, rest, exact } = useMemo(() => {
    const hit = (values || []).filter((v) => !q || v.value.toLowerCase().includes(q));
    // Values starting with what's typed come before ones that only contain it.
    const order = (a, b) => (q ? (b.value.toLowerCase().startsWith(q) - a.value.toLowerCase().startsWith(q)) : 0);
    return {
      first: hit.filter((v) => v.match).sort(order),
      rest: hit.filter((v) => !v.match).sort(order),
      exact: (values || []).some((v) => v.value.toLowerCase() === q),
    };
  }, [values, q]);
  const shown = [...first, ...rest].slice(0, SHOW);
  const firstShown = Math.min(first.length, SHOW);
  const canAdd = q && !exact;
  const scopeName = field === 'model_number' ? [manufacturer, modelName].filter(Boolean).join(' ') : manufacturer;

  function openList() {
    setText('');
    setActive(0);
    setError('');
    setOpen(true);
    load();
  }
  function pick(v) {
    onChange(v);
    setOpen(false);
    setText('');
  }
  async function add() {
    const v = text.trim();
    if (!v) return;
    setAdding(true);
    setError('');
    try {
      const r = await api.post('/assets/value-options', { field, value: v, manufacturer, modelName });
      setValues((vs) => (vs && !vs.some((x) => x.value === r.data.value) ? [{ value: r.data.value, count: 0, match: true }, ...vs] : vs));
      pick(r.data.value);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not add it');
    } finally {
      setAdding(false);
    }
  }
  function onKey(e) {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(i + 1, shown.length - (canAdd ? 0 : 1))); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      if (active < shown.length) pick(shown[active].value);
      else if (canAdd) add();
    } else if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); }
  }
  useEffect(() => { setActive(0); }, [q]);
  useEffect(() => {
    list.current?.querySelector('.combo-opt.active')?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  return (
    <div className="combo" ref={box}>
      {!open ? (
        <button type="button" className="combo-display" onClick={openList}>
          <span className={value ? '' : 'combo-placeholder'}>{value || '-Select-'}</span>
          {value && (
            <span role="button" tabIndex={-1} className="combo-clear" title="Clear" onClick={(e) => { e.stopPropagation(); onChange(''); }}><X size={14} /></span>
          )}
          <ChevronDown size={16} />
        </button>
      ) : (
        <input autoFocus className="combo-input" value={text} placeholder={`Search or add ${label.toLowerCase()}…`}
          onChange={(e) => setText(e.target.value)} onKeyDown={onKey} onBlur={() => setOpen(false)} />
      )}
      {open && (
        <div className="combo-menu" ref={list}>
          {!values ? <div className="combo-note">Loading…</div> : (
            <>
              {shown.map((v, i) => (
                <div key={v.value}>
                  {i === 0 && firstShown > 0 && scopeName && <div className="combo-group">{scopeName}</div>}
                  {i === firstShown && firstShown > 0 && <div className="combo-group">Others</div>}
                  <div className={`combo-opt${i === active ? ' active' : ''}${v.value === value ? ' chosen' : ''}`}
                    onMouseEnter={() => setActive(i)} onMouseDown={(e) => { e.preventDefault(); pick(v.value); }}>
                    <span>{v.value}</span>
                    {v.count > 0 && <span className="combo-count">{v.count.toLocaleString('en-AU')}</span>}
                  </div>
                </div>
              ))}
              {!shown.length && !canAdd && <div className="combo-note">Nothing on the list yet — type to add one.</div>}
              {first.length + rest.length > SHOW && <div className="combo-note">Showing {SHOW} of {(first.length + rest.length).toLocaleString('en-AU')} — type to narrow down.</div>}
              {canAdd && (
                <div className={`combo-opt combo-add${active === shown.length ? ' active' : ''}`}
                  onMouseEnter={() => setActive(shown.length)} onMouseDown={(e) => { e.preventDefault(); if (!adding) add(); }}>
                  <Plus size={14} /> {adding ? 'Adding…' : <>Add “{text.trim()}” as a new {label.toLowerCase()}</>}
                </div>
              )}
              {error && <div className="combo-note" style={{ color: 'var(--danger)' }}>{error}</div>}
            </>
          )}
        </div>
      )}
    </div>
  );
}

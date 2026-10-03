import { useState } from 'react';
import { PRESET_LABELS, presetRange, dmy } from './common';

// The old app's date chips: Last week / month / quarter / year / financial
// year, or a custom range. Clicking the active chip again clears it.
export default function RangePicker({ value, onChange }) {
  const [custom, setCustom] = useState(value?.preset === 'custom');
  const [from, setFrom] = useState(value?.from || '');
  const [to, setTo] = useState(value?.to || '');

  function choose(preset) {
    setCustom(false);
    if (value?.preset === preset) { onChange(null); return; }
    onChange({ preset, ...presetRange(preset) });
  }

  return (
    <div>
      <div className="chip-row">
        {Object.keys(PRESET_LABELS).map((p) => (
          <button key={p} type="button" className={`chip${value?.preset === p ? ' active' : ''}`} onClick={() => choose(p)}>{PRESET_LABELS[p]}</button>
        ))}
        <button type="button" className={`chip${custom ? ' active' : ''}`} onClick={() => setCustom((c) => !c)}>Custom date range</button>
      </div>
      {custom && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'end', marginTop: 10, flexWrap: 'wrap' }}>
          <div className="field" style={{ margin: 0 }}><label>From</label><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
          <div className="field" style={{ margin: 0 }}><label>To</label><input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></div>
          <button type="button" className="btn btn-ghost btn-sm" disabled={!from || !to || from > to} onClick={() => onChange({ preset: 'custom', from, to })}>Apply</button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setFrom(''); setTo(''); setCustom(false); onChange(null); }}>Clear dates</button>
        </div>
      )}
      {value && (
        <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 8 }}>
          Showing {value.preset === 'custom' ? 'custom range' : PRESET_LABELS[value.preset].toLowerCase()}: {dmy(value.from)} – {dmy(value.to)}
        </div>
      )}
    </div>
  );
}

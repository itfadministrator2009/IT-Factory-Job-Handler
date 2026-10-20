import { useEffect, useState } from 'react';

const CUSTOM = '__custom__';

// A dropdown of set choices plus "Other — type your own…", which shows a text
// box. The value saved is always plain text: the chosen option or what was
// typed. A saved value that isn't one of the options opens as custom text.
export default function SelectOrCustom({ id, value, onChange, options, placeholder = 'Type your own…' }) {
  const isOption = (v) => options.includes(v);
  const [custom, setCustom] = useState(() => !!value && !isOption(value));

  // When the form loads a job, switch to the text box if its value is custom.
  useEffect(() => {
    if (value && !isOption(value)) setCustom(true);
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps

  const selectValue = custom ? CUSTOM : (value || '');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <select
        id={id}
        value={selectValue}
        onChange={(e) => {
          const v = e.target.value;
          if (v === CUSTOM) { setCustom(true); onChange(isOption(value) ? '' : (value || '')); }
          else { setCustom(false); onChange(v); }
        }}
      >
        <option value="">-None-</option>
        {options.map((o) => <option key={o} value={o}>{o}</option>)}
        <option value={CUSTOM}>Other — type your own…</option>
      </select>
      {custom && (
        <input
          aria-label={`${placeholder}`}
          value={value || ''}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          autoFocus={!value}
        />
      )}
    </div>
  );
}

import { useRef, useState } from 'react';
import { X } from 'lucide-react';

// Several email addresses in one box. Each address becomes a tag when you press
// Enter, comma, semicolon, space or Tab, or click away; pasting a list splits it.
// Backspace in the empty box removes the last tag. Invalid addresses show in red.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const isEmail = (a) => EMAIL.test(a);
const split = (text) => text.split(/[\s,;]+/).map((a) => a.trim()).filter(Boolean);

export function addEmails(list, text) {
  const out = [...list];
  split(text).forEach((a) => { if (!out.some((b) => b.toLowerCase() === a.toLowerCase())) out.push(a); });
  return out;
}

export default function EmailChips({ value, onChange, draft, onDraftChange, placeholder, id }) {
  const inputRef = useRef(null);
  const [focused, setFocused] = useState(false);
  const commit = () => { if (draft.trim()) { onChange(addEmails(value, draft)); onDraftChange(''); } };

  return (
    <div className={`email-chips${focused ? ' focused' : ''}`} onClick={() => inputRef.current?.focus()}>
      {value.map((a) => (
        <span key={a.toLowerCase()} className={`email-chip${isEmail(a) ? '' : ' bad'}`} title={isEmail(a) ? a : 'Not a valid email address'}>
          {a}
          <button type="button" aria-label={`Remove ${a}`} onClick={(e) => { e.stopPropagation(); onChange(value.filter((b) => b !== a)); }}><X size={12} /></button>
        </span>
      ))}
      <input
        id={id}
        ref={inputRef}
        type="email"
        multiple
        value={draft}
        placeholder={value.length ? 'Add another…' : placeholder}
        onChange={(e) => {
          const v = e.target.value;
          if (/[\s,;]/.test(v)) { onChange(addEmails(value, v)); onDraftChange(''); } else onDraftChange(v);
        }}
        onKeyDown={(e) => {
          if ((e.key === 'Enter' || e.key === 'Tab') && draft.trim()) { e.preventDefault(); commit(); }
          else if (e.key === 'Enter') e.preventDefault();
          else if (e.key === 'Backspace' && !draft && value.length) onChange(value.slice(0, -1));
        }}
        onPaste={(e) => {
          const text = e.clipboardData.getData('text');
          if (/[\s,;]/.test(text.trim())) { e.preventDefault(); onChange(addEmails(value, draft + ' ' + text)); onDraftChange(''); }
        }}
        onFocus={() => setFocused(true)}
        onBlur={() => { setFocused(false); commit(); }}
      />
    </div>
  );
}

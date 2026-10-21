import { useEffect, useRef } from 'react';
import { Search, X, Loader2 } from 'lucide-react';

// A rounded search box: magnifier (or a spinner while searching), a clear
// button once something is typed, and "/" to jump to it from anywhere on the page.
export default function SearchField({ value, onChange, placeholder, label = 'Search', busy = false, style }) {
  const ref = useRef(null);

  useEffect(() => {
    function onKey(e) {
      const t = e.target;
      const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
      if (e.key === '/' && !typing && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        ref.current?.focus();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className={'search-field' + (value ? ' has-value' : '')} style={style}>
      <span className="search-field-icon" aria-hidden="true">
        {busy ? <Loader2 size={16} className="spin" /> : <Search size={16} />}
      </span>
      <input
        ref={ref}
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Escape' && value) { e.preventDefault(); onChange(''); } }}
        placeholder={placeholder}
        aria-label={label}
        autoComplete="off"
        spellCheck={false}
      />
      {value ? (
        <button type="button" className="search-field-clear" onClick={() => { onChange(''); ref.current?.focus(); }} aria-label="Clear search" title="Clear (Esc)">
          <X size={14} />
        </button>
      ) : (
        <kbd className="search-field-key" title="Press / to search">/</kbd>
      )}
    </div>
  );
}

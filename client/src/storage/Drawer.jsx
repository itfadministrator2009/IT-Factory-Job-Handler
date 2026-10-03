import { X } from 'lucide-react';

// Right-hand panel used by the Storage Centre tools (the old app's drawers).
export default function Drawer({ title, subtitle, onClose, width = 760, children, busy }) {
  return (
    <div className="modal-overlay" onClick={() => !busy && onClose()}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: width, width: '95vw', maxHeight: '90vh', display: 'flex', flexDirection: 'column' }}>
        <div className="modal-header">
          <div>
            <h3>{title}</h3>
            {subtitle && <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 4, fontWeight: 400 }}>{subtitle}</div>}
          </div>
          {!busy && <button type="button" onClick={onClose} aria-label="Close"><X size={18} /></button>}
        </div>
        <div style={{ overflowY: 'auto', flex: 1 }}>{children}</div>
      </div>
    </div>
  );
}

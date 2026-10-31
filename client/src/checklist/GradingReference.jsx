import { X } from 'lucide-react';

// The cosmetic grading guide: the rules, then what each grade means.
export default function GradingReference({ config, onClose }) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card ck-modal-wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header"><h3>Cosmetic grading reference</h3><button type="button" onClick={onClose} aria-label="Close"><X size={18} /></button></div>
        <ul className="ck-guidelines">
          {config.cosmeticGuidelines.map((g) => <li key={g}>{g}</li>)}
        </ul>
        <div className="ck-table-scroll">
          <table className="ck-grade-table">
            <thead><tr><th>Condition</th><th>Cosmetic condition</th><th>Functional condition</th></tr></thead>
            <tbody>
              {config.cosmeticGrades.map((g) => (
                <tr key={g.code}><td><strong>{g.label}</strong></td><td>{g.cosmetic}</td><td>{g.functional}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

import { Plus, Trash2, ChevronUp, ChevronDown } from 'lucide-react';

export const FIELD_TYPES = [
  { value: 'text', label: 'Short text' },
  { value: 'textarea', label: 'Long text' },
  { value: 'date', label: 'Date' },
  { value: 'datetime', label: 'Date & time' },
  { value: 'yesno', label: 'Yes / No' },
  { value: 'photo', label: 'Photo' },
  { value: 'signature', label: 'Signature' },
  { value: 'instruction', label: 'Instructions (no answer needed)' },
];

function newSectionId() { return `section_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`; }
function newFieldId() { return `field_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`; }

export function blankTemplate() {
  return { sections: [] };
}

// A visual builder for a project's form template — sections containing questions,
// with optional conditional logic — that produces the exact same JSON structure the
// backend and the entry form already expect, without anyone needing to write JSON
// by hand. `sections` / `onChange` work just like controlled input value/onChange.
export default function TemplateBuilder({ sections, onChange }) {
  function updateSection(idx, patch) {
    const next = [...sections];
    next[idx] = { ...next[idx], ...patch };
    onChange(next);
  }
  function addSection() {
    onChange([...sections, { id: newSectionId(), title: '', repeatable: false, fields: [] }]);
  }
  function removeSection(idx) {
    if (!confirm('Remove this whole section, including its questions?')) return;
    onChange(sections.filter((_, i) => i !== idx));
  }
  function moveSection(idx, dir) {
    const target = idx + dir;
    if (target < 0 || target >= sections.length) return;
    const next = [...sections];
    [next[idx], next[target]] = [next[target], next[idx]];
    onChange(next);
  }

  function updateField(sIdx, fIdx, patch) {
    const fields = [...sections[sIdx].fields];
    fields[fIdx] = { ...fields[fIdx], ...patch };
    updateSection(sIdx, { fields });
  }
  function addField(sIdx) {
    const fields = [...sections[sIdx].fields, { id: newFieldId(), type: 'text', label: '', required: false }];
    updateSection(sIdx, { fields });
  }
  function removeField(sIdx, fIdx) {
    updateSection(sIdx, { fields: sections[sIdx].fields.filter((_, i) => i !== fIdx) });
  }
  function moveField(sIdx, fIdx, dir) {
    const fields = sections[sIdx].fields;
    const target = fIdx + dir;
    if (target < 0 || target >= fields.length) return;
    const next = [...fields];
    [next[fIdx], next[target]] = [next[target], next[fIdx]];
    updateSection(sIdx, { fields: next });
  }

  return (
    <div>
      {sections.map((section, sIdx) => (
        <SectionEditor
          key={section.id}
          section={section}
          isFirst={sIdx === 0}
          isLast={sIdx === sections.length - 1}
          onUpdate={(patch) => updateSection(sIdx, patch)}
          onRemove={() => removeSection(sIdx)}
          onMove={(dir) => moveSection(sIdx, dir)}
          onAddField={() => addField(sIdx)}
          onUpdateField={(fIdx, patch) => updateField(sIdx, fIdx, patch)}
          onRemoveField={(fIdx) => removeField(sIdx, fIdx)}
          onMoveField={(fIdx, dir) => moveField(sIdx, fIdx, dir)}
        />
      ))}
      {sections.length === 0 && (
        <p style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 14 }}>
          No sections yet — add one to start building the form.
        </p>
      )}
      <button type="button" className="btn btn-ghost btn-sm" onClick={addSection}>
        <Plus size={13} /> Add section
      </button>
    </div>
  );
}

function SectionEditor({ section, isFirst, isLast, onUpdate, onRemove, onMove, onAddField, onUpdateField, onRemoveField, onMoveField }) {
  return (
    <div className="panel" style={{ padding: 18, marginBottom: 16 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 10, flexWrap: 'wrap' }}>
        <input
          value={section.title}
          onChange={(e) => onUpdate({ title: e.target.value })}
          placeholder="Section title (e.g. Site Info)"
          style={{ flex: 2, minWidth: 200, fontWeight: 600 }}
        />
        <label className="checkbox-label">
          <input type="checkbox" checked={!!section.repeatable} onChange={(e) => onUpdate({ repeatable: e.target.checked })} />
          Repeatable — person can add more than one
        </label>
        <div style={{ display: 'flex', gap: 4, marginLeft: 'auto' }}>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => onMove(-1)} disabled={isFirst} title="Move up"><ChevronUp size={13} /></button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => onMove(1)} disabled={isLast} title="Move down"><ChevronDown size={13} /></button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onRemove} title="Remove section"><Trash2 size={13} /></button>
        </div>
      </div>

      {section.repeatable && (
        <input
          value={section.instruction || ''}
          onChange={(e) => onUpdate({ instruction: e.target.value })}
          placeholder="Optional instructions shown above this repeatable section"
          style={{ marginBottom: 14, width: '100%' }}
        />
      )}

      {section.fields.map((field, fIdx) => (
        <FieldEditor
          key={field.id}
          field={field}
          isFirst={fIdx === 0}
          isLast={fIdx === section.fields.length - 1}
          // Conditional logic can only reference an earlier question in the SAME
          // section (matching what the entry form and PDF actually support) —
          // instructions are excluded since they never hold an answerable value.
          precedingFields={section.fields.slice(0, fIdx).filter((f) => f.type !== 'instruction')}
          onUpdate={(patch) => onUpdateField(fIdx, patch)}
          onRemove={() => onRemoveField(fIdx)}
          onMove={(dir) => onMoveField(fIdx, dir)}
        />
      ))}
      {section.fields.length === 0 && (
        <p style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 10 }}>No questions in this section yet.</p>
      )}
      <button type="button" className="btn btn-ghost btn-sm" onClick={onAddField}>
        <Plus size={13} /> Add question
      </button>
    </div>
  );
}

function FieldEditor({ field, isFirst, isLast, precedingFields, onUpdate, onRemove, onMove }) {
  const isInstruction = field.type === 'instruction';
  return (
    <div className="panel" style={{ padding: 12, marginBottom: 10, background: 'var(--paper)' }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <input
          value={field.label}
          onChange={(e) => onUpdate({ label: e.target.value })}
          placeholder={isInstruction ? 'Instruction text to display' : 'Question text'}
          style={{ flex: 2, minWidth: 200 }}
        />
        <select
          value={field.type}
          onChange={(e) => onUpdate({ type: e.target.value, ...(e.target.value === 'instruction' ? { required: false } : {}) })}
          style={{ flex: 1, minWidth: 150 }}
        >
          {FIELD_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
        </select>
        {!isInstruction && (
          <label className="checkbox-label" style={{ flexShrink: 0 }}>
            <input type="checkbox" checked={!!field.required} onChange={(e) => onUpdate({ required: e.target.checked })} />
            Required
          </label>
        )}
        <div style={{ display: 'flex', gap: 4, flexShrink: 0, marginLeft: 'auto' }}>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => onMove(-1)} disabled={isFirst} title="Move up"><ChevronUp size={13} /></button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => onMove(1)} disabled={isLast} title="Move down"><ChevronDown size={13} /></button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onRemove} title="Remove question"><Trash2 size={13} /></button>
        </div>
      </div>

      {!isInstruction && (
        <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--line)' }}>
          <ConditionEditor
            label="Only show this question conditionally"
            condition={field.visibleIf}
            availableFields={precedingFields}
            onChange={(cond) => onUpdate({ visibleIf: cond || undefined })}
          />
          <ConditionEditor
            label="Only require this question conditionally"
            condition={field.requiredIf}
            availableFields={precedingFields}
            onChange={(cond) => onUpdate({ requiredIf: cond || undefined })}
          />
        </div>
      )}
    </div>
  );
}

function ConditionEditor({ label, condition, availableFields, onChange }) {
  const enabled = !!condition;
  const targetField = enabled ? availableFields.find((f) => f.id === condition.field) : null;
  const mode = !condition ? 'notEmpty' : condition.equals !== undefined ? 'equals' : condition.empty ? 'empty' : 'notEmpty';

  return (
    <div style={{ marginBottom: 8 }}>
      <label className="checkbox-label">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => onChange(e.target.checked ? { field: availableFields[0]?.id || '', notEmpty: true } : null)}
          disabled={availableFields.length === 0}
        />
        {label}
      </label>
      {availableFields.length === 0 && (
        <p style={{ fontSize: 12, color: 'var(--muted)', margin: '2px 0 0 22px' }}>Add another question above this one first to make it conditional.</p>
      )}
      {enabled && availableFields.length > 0 && (
        <div style={{ display: 'flex', gap: 6, marginTop: 6, marginLeft: 22, flexWrap: 'wrap' }}>
          <select value={condition.field} onChange={(e) => onChange({ ...condition, field: e.target.value })}>
            {availableFields.map((f) => <option key={f.id} value={f.id}>{f.label || '(untitled question)'}</option>)}
          </select>
          <select
            value={mode}
            onChange={(e) => {
              const nextMode = e.target.value;
              if (nextMode === 'equals') onChange({ field: condition.field, equals: '' });
              else if (nextMode === 'empty') onChange({ field: condition.field, empty: true });
              else onChange({ field: condition.field, notEmpty: true });
            }}
          >
            <option value="notEmpty">has been answered</option>
            <option value="empty">has been left blank</option>
            <option value="equals">equals…</option>
          </select>
          {mode === 'equals' && (
            targetField?.type === 'yesno' ? (
              <select value={condition.equals} onChange={(e) => onChange({ ...condition, equals: e.target.value })}>
                <option value="">-Select-</option>
                <option value="Yes">Yes</option>
                <option value="No">No</option>
              </select>
            ) : (
              <input
                value={condition.equals}
                onChange={(e) => onChange({ ...condition, equals: e.target.value })}
                placeholder="value"
                style={{ width: 120 }}
              />
            )
          )}
        </div>
      )}
    </div>
  );
}

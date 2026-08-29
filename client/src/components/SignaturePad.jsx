import { useEffect, useRef, useState } from 'react';
import SignaturePadLib from 'signature_pad';
import { X } from 'lucide-react';

export default function SignaturePad({ defaultName, onSave, onClose, onSkip, skipLabel, title }) {
  const canvasRef = useRef(null);
  const padRef = useRef(null);
  const [name, setName] = useState(defaultName || '');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    function resize() {
      const ratio = Math.max(window.devicePixelRatio || 1, 1);
      canvas.width = canvas.offsetWidth * ratio;
      canvas.height = canvas.offsetHeight * ratio;
      canvas.getContext('2d').scale(ratio, ratio);
      padRef.current?.clear();
    }
    padRef.current = new SignaturePadLib(canvas, { backgroundColor: 'rgb(255,255,255)', penColor: 'rgb(20,20,20)' });
    resize();
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);

  function clear() {
    padRef.current?.clear();
  }

  async function handleSave() {
    if (!name.trim()) return;
    if (padRef.current.isEmpty()) return;
    setSaving(true);
    const dataUrl = padRef.current.toDataURL('image/png');
    try {
      await onSave(name.trim(), dataUrl);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>{title || 'Capture signature'}</h3>
          <button type="button" onClick={onClose}><X size={18} /></button>
        </div>

        <div className="field">
          <label htmlFor="sig-name">Customer name</label>
          <input id="sig-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Full name" />
        </div>

        <label style={{ fontSize: 13, fontWeight: 600, marginBottom: 5, display: 'block' }}>Signature</label>
        <div className="signature-canvas-wrap">
          <canvas ref={canvasRef} className="signature-canvas" />
        </div>
        <div className="signature-actions">
          <button type="button" className="btn btn-ghost btn-sm" onClick={clear}>Clear</button>
          <div style={{ display: 'flex', gap: 8 }}>
            {onSkip && (
              <button type="button" className="btn btn-ghost btn-sm" onClick={onSkip}>{skipLabel || 'Skip for now'}</button>
            )}
            <button type="button" className="btn btn-accent btn-sm" onClick={handleSave} disabled={saving || !name.trim()}>
              {saving ? 'Saving…' : 'Save signature'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

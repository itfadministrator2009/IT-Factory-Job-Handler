import { useEffect, useRef, useState } from 'react';
import SignaturePadLib from 'signature_pad';
import { X } from 'lucide-react';

export default function SignaturePad({ defaultName, defaultComments, onSave, onClose }) {
  const canvasRef = useRef(null);
  const padRef = useRef(null);
  const [name, setName] = useState(defaultName || '');
  const [comments, setComments] = useState(defaultComments || '');
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
      await onSave(name.trim(), dataUrl, comments.trim());
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card sign-off-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>Job sign-off</h3>
          <button type="button" onClick={onClose}><X size={18} /></button>
        </div>

        <div className="sign-off-scroll">
          <div className="field">
            <label htmlFor="sig-name">Customer name</label>
            <input id="sig-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Full name" />
          </div>

          <div className="field">
            <label htmlFor="sig-comments">Comments</label>
            <textarea
              id="sig-comments"
              value={comments}
              onChange={(e) => setComments(e.target.value)}
              placeholder="Any notes about the job or the sign-off…"
              rows={3}
            />
          </div>

          <label style={{ fontSize: 13, fontWeight: 600, marginBottom: 5, display: 'block' }}>Signature</label>
          <div className="signature-canvas-wrap">
            <canvas ref={canvasRef} className="signature-canvas" />
          </div>
        </div>

        <div className="signature-actions">
          <button type="button" className="btn btn-ghost btn-sm" onClick={clear}>Clear signature</button>
          <button type="button" className="btn btn-accent btn-sm" onClick={handleSave} disabled={saving || !name.trim()}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

import { useEffect, useRef, useState } from 'react';
import { X, Camera } from 'lucide-react';

// Scan barcodes (serial numbers, asset tags) with a phone/tablet/laptop camera.
// Uses the browser's own barcode reader where it has one (Chrome/Edge on Android
// and desktop); otherwise loads the ZXing reader on demand (iPhone/iPad Safari,
// Firefox), so nothing extra is downloaded until someone actually scans.
//
// continuous: keep scanning and call onScan for each new code (bulk serial search);
// otherwise close after the first code (filling in one field).
const ZXING_URL = 'https://cdn.jsdelivr.net/npm/@zxing/library@0.21.3/umd/index.min.js';
let zxingLoading = null;
function loadZxing() {
  if (window.ZXing) return Promise.resolve(window.ZXing);
  if (!zxingLoading) {
    zxingLoading = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = ZXING_URL;
      s.async = true;
      s.onload = () => (window.ZXing ? resolve(window.ZXing) : reject(new Error('Scanner did not load')));
      s.onerror = () => { zxingLoading = null; reject(new Error('Could not load the scanner — check the internet connection')); };
      document.head.appendChild(s);
    });
  }
  return zxingLoading;
}

function beep() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx();
    const o = ctx.createOscillator(); const g = ctx.createGain();
    o.frequency.value = 1200; g.gain.value = 0.08;
    o.connect(g); g.connect(ctx.destination);
    o.start(); o.stop(ctx.currentTime + 0.09);
    o.onended = () => ctx.close();
  } catch (e) { /* no sound */ }
  try { navigator.vibrate?.(60); } catch (e) { /* no vibration */ }
}

export default function BarcodeScanner({ onScan, onClose, continuous = false, title = 'Scan barcode' }) {
  const videoRef = useRef(null);
  const [error, setError] = useState('');
  const [starting, setStarting] = useState(true);
  const [scanned, setScanned] = useState([]);
  const last = useRef({ text: '', at: 0 });
  // Kept in refs so a parent re-render doesn't restart the camera.
  const onScanRef = useRef(onScan);
  onScanRef.current = onScan;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    let stopped = false;
    let stream = null; let raf = 0; let reader = null;
    const seen = new Set();

    function handle(text) {
      const code = String(text || '').trim();
      if (!code || stopped) return;
      const now = Date.now();
      // The same code stays in view for a moment — only count it once (and, when
      // scanning a list, only once per session).
      if (code === last.current.text && now - last.current.at < 2500) return;
      last.current = { text: code, at: now };
      if (continuous) {
        if (seen.has(code.toUpperCase())) return;
        seen.add(code.toUpperCase());
      }
      beep();
      onScanRef.current?.(code);
      if (continuous) setScanned((p) => (p.includes(code) ? p : [code, ...p]));
      else { stopped = true; onCloseRef.current?.(); }
    }

    async function start() {
      if (!navigator.mediaDevices?.getUserMedia) {
        setError('This browser cannot use the camera. Open the app over https in Chrome or Safari.');
        setStarting(false);
        return;
      }
      try {
        if ('BarcodeDetector' in window) {
          const formats = await window.BarcodeDetector.getSupportedFormats?.() || undefined;
          const detector = new window.BarcodeDetector(formats ? { formats } : undefined);
          stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
          if (stopped) return;
          const v = videoRef.current;
          v.srcObject = stream;
          await v.play();
          setStarting(false);
          const tick = async () => {
            if (stopped) return;
            try {
              if (v.readyState >= 2) {
                const codes = await detector.detect(v);
                if (codes[0]) handle(codes[0].rawValue);
              }
            } catch (e) { /* frame not ready */ }
            raf = requestAnimationFrame(tick);
          };
          raf = requestAnimationFrame(tick);
        } else {
          const ZXing = await loadZxing();
          if (stopped) return;
          reader = new ZXing.BrowserMultiFormatReader();
          await reader.decodeFromConstraints({ video: { facingMode: 'environment' } }, videoRef.current, (result) => {
            if (result) handle(result.getText());
          });
          setStarting(false);
        }
      } catch (err) {
        setStarting(false);
        setError(err?.name === 'NotAllowedError'
          ? 'Camera access was blocked. Allow the camera for this site in the browser settings, then try again.'
          : err?.name === 'NotFoundError' || err?.name === 'OverconstrainedError'
            ? 'No camera was found on this device.'
            : (err?.message || 'Could not start the camera'));
      }
    }
    start();

    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      try { reader?.reset(); } catch (e) { /* already stopped */ }
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [continuous]);

  return (
    <div className="modal-overlay" onClick={onClose} style={{ zIndex: 1100 }}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 520 }}>
        <div className="modal-header">
          <h3><Camera size={16} style={{ verticalAlign: -2, marginRight: 6 }} />{title}</h3>
          <button type="button" onClick={onClose}><X size={18} /></button>
        </div>
        {error ? <div className="error-banner">{error}</div> : (
          <>
            <div style={{ position: 'relative', background: '#111', borderRadius: 8, overflow: 'hidden', aspectRatio: '4 / 3' }}>
              <video ref={videoRef} playsInline muted style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
              <div style={{ position: 'absolute', left: '10%', right: '10%', top: '42%', height: '16%', border: '2px solid rgba(255,255,255,0.85)', borderRadius: 6, pointerEvents: 'none' }} />
              {starting && <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: 14 }}>Starting camera…</div>}
            </div>
            <p style={{ fontSize: 12, color: 'var(--muted)', margin: '8px 0 0' }}>
              Hold the barcode inside the box. {continuous ? 'Keep scanning — each new code is added. Close when done.' : 'It fills in as soon as it reads the code.'}
            </p>
          </>
        )}
        {continuous && scanned.length > 0 && (
          <div style={{ marginTop: 10, fontSize: 13 }}>
            <strong>{scanned.length} scanned</strong>
            <div style={{ fontFamily: 'monospace', fontSize: 12, maxHeight: 110, overflowY: 'auto', marginTop: 4 }}>{scanned.join(', ')}</div>
          </div>
        )}
        {continuous && <button type="button" className="btn btn-accent" style={{ marginTop: 12 }} onClick={onClose}>Done</button>}
      </div>
    </div>
  );
}

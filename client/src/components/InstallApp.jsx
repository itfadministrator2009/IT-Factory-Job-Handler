import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Download, X, Share, PlusSquare } from 'lucide-react';

// "Install app" in the side menu. Chrome / Edge / Android offer their own install
// prompt; iPhone and iPad don't, so there we show the two taps it takes.
let deferred = null;
const listeners = new Set();
if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e; listeners.forEach((f) => f()); });
  window.addEventListener('appinstalled', () => { deferred = null; listeners.forEach((f) => f()); });
}

const standalone = () => window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone === true;
const isIos = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

export default function InstallApp() {
  const [, force] = useState(0);
  const [iosHelp, setIosHelp] = useState(false);
  useEffect(() => { const f = () => force((n) => n + 1); listeners.add(f); return () => listeners.delete(f); }, []);

  if (standalone()) return null;
  const canPrompt = !!deferred;
  if (!canPrompt && !isIos()) return null;

  async function install() {
    if (!deferred) { setIosHelp(true); return; }
    deferred.prompt();
    try { await deferred.userChoice; } catch (e) { /* dismissed */ }
    deferred = null;
    force((n) => n + 1);
  }

  return (
    <>
      <button type="button" className="install-app" onClick={install}><Download size={13} /> Install app</button>
      {iosHelp && createPortal(
        <div className="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="ios-install-title" onClick={(e) => { if (e.target === e.currentTarget) setIosHelp(false); }}>
          <div className="modal-card">
            <div className="modal-header">
              <h3 id="ios-install-title">Add Work Desk to your home screen</h3>
              <button type="button" onClick={() => setIosHelp(false)} aria-label="Close"><X size={18} /></button>
            </div>
            <ol className="install-steps">
              <li>Tap the <b>Share</b> button <Share size={15} /> at the bottom of Safari (top on iPad).</li>
              <li>Scroll down and tap <b>Add to Home Screen</b> <PlusSquare size={15} />.</li>
              <li>Tap <b>Add</b>. Work Desk opens from its own icon, full screen, and you stay logged in.</li>
            </ol>
            <p className="tc-muted">Using Chrome on iPhone? Open this page in Safari first.</p>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}

import { useCallback, useRef } from 'react';

// Sizes a scrolling table to end at the bottom of the window, so the table has
// its own scrollbar and the page itself doesn't scroll as well. On phones
// (narrow screens) it leaves the page to scroll as normal.
// Use it as a ref: <div ref={fitRef} className="sales-table-wrap">.
export default function useFitHeight(bottomGap = 40) {
  const cleanup = useRef(null);
  return useCallback((el) => {
    if (cleanup.current) { cleanup.current(); cleanup.current = null; }
    if (!el) return;
    const fit = () => {
      if (window.innerWidth < 760) { el.style.maxHeight = ''; return; }
      const top = el.getBoundingClientRect().top + window.scrollY;
      el.style.maxHeight = `${Math.max(260, Math.floor(window.innerHeight - top - bottomGap))}px`;
    };
    fit();
    // Refit when the window changes size or anything above the table moves.
    const ro = new ResizeObserver(fit);
    ro.observe(el.closest('.main') || document.body);
    window.addEventListener('resize', fit);
    cleanup.current = () => { ro.disconnect(); window.removeEventListener('resize', fit); };
  }, [bottomGap]);
}

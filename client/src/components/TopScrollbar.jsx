import { useEffect, useRef, useState } from 'react';

// A second left-right scrollbar shown above a wide table, kept in step with the
// table's own scrollbar at the bottom. Hidden when the table fits.
export default function TopScrollbar({ targetRef }) {
  const barRef = useRef(null);
  const [width, setWidth] = useState(0);
  const [needed, setNeeded] = useState(false);

  useEffect(() => {
    const target = targetRef.current;
    const bar = barRef.current;
    if (!target || !bar) return undefined;
    const measure = () => {
      setWidth(target.scrollWidth);
      setNeeded(target.scrollWidth > target.clientWidth + 1);
      bar.scrollLeft = target.scrollLeft;
    };
    measure();
    // Whichever bar is moved, the other follows (only when it differs, so they don't echo).
    const follow = (from, to) => () => {
      if (Math.abs(to.scrollLeft - from.scrollLeft) > 0.5) to.scrollLeft = from.scrollLeft;
    };
    const onTarget = follow(target, bar);
    const onBar = follow(bar, target);
    target.addEventListener('scroll', onTarget, { passive: true });
    bar.addEventListener('scroll', onBar, { passive: true });
    const ro = new ResizeObserver(measure);
    ro.observe(target);
    if (target.firstElementChild) ro.observe(target.firstElementChild);
    return () => {
      target.removeEventListener('scroll', onTarget);
      bar.removeEventListener('scroll', onBar);
      ro.disconnect();
    };
  }, [targetRef]);

  return (
    <div ref={barRef} className="top-scrollbar" style={needed ? undefined : { display: 'none' }} aria-hidden="true">
      <div style={{ width, height: 1 }} />
    </div>
  );
}

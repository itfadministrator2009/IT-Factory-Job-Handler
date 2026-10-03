import { useMemo } from 'react';
import qrcode from 'qrcode-generator';

// QR code drawn as an SVG (scales cleanly when printed). Error correction M,
// same as the old app's labels.
export default function QrCode({ text, size = 260, title }) {
  const { count, path } = useMemo(() => {
    const qr = qrcode(0, 'M');
    qr.addData(text, 'Byte');
    qr.make();
    const n = qr.getModuleCount();
    let d = '';
    for (let r = 0; r < n; r += 1) {
      for (let c = 0; c < n; c += 1) if (qr.isDark(r, c)) d += `M${c + 4} ${r + 4}h1v1h-1z`;
    }
    return { count: n + 8, path: d };
  }, [text]);
  return (
    <svg width={size} height={size} viewBox={`0 0 ${count} ${count}`} shapeRendering="crispEdges" role="img" aria-label={title || 'QR code'}>
      <rect width={count} height={count} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}

import { useState } from 'react';
import { Tag, X, Printer } from 'lucide-react';
import qrcode from 'qrcode-generator';
import { formatDMY } from '../utils/date';

// "Print Label" on a job: a label for the boxes/pallets from that job, showing
// date collected, job number, account, site address, classification and data
// destruction, plus a QR code that opens the job in Work Desk.

// Sizes in mm: pad = margin, num = job number, row = detail text, qr = QR code.
const SIZES = {
  '100x150': { label: '100 × 150 mm (4 × 6" shipping label)', w: 100, h: 150, pad: 6, num: 20, cap: 4, row: 5.4, qr: 30 },
  '62x100': { label: '62 × 100 mm (Brother 62 mm roll)', w: 62, h: 100, pad: 4, num: 12, cap: 2.8, row: 3.5, qr: 19 },
  '100x50': { label: '100 × 50 mm', w: 100, h: 50, pad: 3.5, num: 9, cap: 2.4, row: 3, qr: 15, wide: true },
  A4: { label: 'A4 page', w: 210, h: 297, pad: 15, num: 42, cap: 8, row: 11, qr: 60 },
};
const SIZE_KEY = 'workdesk-job-label-size';

function savedSize() {
  try { const s = localStorage.getItem(SIZE_KEY); return SIZES[s] ? s : '100x150'; } catch (e) { return '100x150'; }
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function qrSvg(text) {
  const qr = qrcode(0, 'M');
  qr.addData(text, 'Byte');
  qr.make();
  const n = qr.getModuleCount();
  let d = '';
  for (let r = 0; r < n; r += 1) for (let c = 0; c < n; c += 1) if (qr.isDark(r, c)) d += `M${c + 2} ${r + 2}h1v1h-1z`;
  const m = n + 4;
  return `<svg viewBox="0 0 ${m} ${m}" shape-rendering="crispEdges" xmlns="http://www.w3.org/2000/svg"><rect width="${m}" height="${m}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}

// The date the job was collected: the job's date, or else the day it was
// marked done.
export function dateCollected(job) {
  return formatDMY(job.due_date || job.resolved_at || job.created_at) || '';
}

export function labelRows(job) {
  return [
    ['Date Collected', dateCollected(job)],
    ['Account', job.account_name || job.contact_name || ''],
    ['Site Address', job.site_address || ''],
    ['Classification', job.classifications || ''],
    ['Data Destruction', job.data_destruction || ''],
  ];
}

function labelHtml(job, sizeKey, copies) {
  const s = SIZES[sizeKey];
  const mm = (x) => `${x}mm`;
  const wide = !!s.wide; // 100×50: short label, tighter rows
  const url = `${window.location.origin}/jobs/${job.id}`;
  const rows = labelRows(job).map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v) || '&mdash;'}</td></tr>`).join('');
  const one = `<section class="label${wide ? ' wide' : ''}">
    <div class="top">
      <div><div class="cap">Job Number</div><div class="num">#${esc(job.job_number)}</div></div>
      <div class="qr">${qrSvg(url)}</div>
    </div>
    <table>${rows}</table>
    <div class="foot">IT Factory</div>
  </section>`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>Label — Job #${esc(job.job_number)}</title>
<style>
  @page { size: ${s.w}mm ${s.h}mm; margin: 0; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; font-family: Arial, Helvetica, sans-serif; color: #000; }
  .label { width: ${s.w}mm; height: ${s.h}mm; padding: ${mm(s.pad)}; display: flex; flex-direction: column; overflow: hidden; page-break-after: always; break-after: page; }
  .label:last-child { page-break-after: auto; break-after: auto; }
  .top { display: flex; justify-content: space-between; align-items: center; gap: ${mm(s.row * 0.6)}; border-bottom: ${mm(s.row * 0.12)} solid #000; padding-bottom: ${mm(s.row * 0.5)}; margin-bottom: ${mm(s.row * 0.4)}; }
  .cap { font-size: ${mm(s.cap)}; text-transform: uppercase; letter-spacing: 0.05em; font-weight: 700; }
  .num { font-size: ${mm(s.num)}; font-weight: 800; line-height: 1; margin-top: ${mm(s.cap * 0.25)}; }
  .qr svg { width: ${mm(s.qr)}; height: ${mm(s.qr)}; display: block; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; vertical-align: top; padding: ${mm(s.row * (wide ? 0.25 : 0.45))} 0; border-bottom: ${mm(Math.max(s.row * 0.05, 0.2))} solid #888; font-size: ${mm(s.row)}; line-height: 1.2; }
  th { width: 38%; font-weight: 700; padding-right: ${mm(s.row * 0.4)}; }
  td { font-weight: 400; word-break: break-word; }
  .foot { margin-top: auto; padding-top: ${mm(s.row * 0.4)}; font-size: ${mm(s.cap)}; color: #333; }
  .wide .foot { display: none; }
</style></head><body>${Array.from({ length: copies }, () => one).join('')}
<script>window.onload = function () { setTimeout(function () { window.print(); }, 150); };</script>
</body></html>`;
}

export default function PrintJobLabel({ job }) {
  const [open, setOpen] = useState(false);
  const [size, setSize] = useState(savedSize);
  const [copies, setCopies] = useState(1);

  function print() {
    try { localStorage.setItem(SIZE_KEY, size); } catch (e) { /* not saved */ }
    const n = Math.min(Math.max(parseInt(copies, 10) || 1, 1), 50);
    const w = window.open('', '_blank');
    if (!w) { alert('Please allow pop-ups for this site to print the label.'); return; }
    w.document.open();
    w.document.write(labelHtml(job, size, n));
    w.document.close();
    setOpen(false);
  }

  const rows = labelRows(job);

  return (
    <>
      <button className="btn btn-ghost btn-sm" onClick={() => setOpen(true)}>
        <Tag size={14} /> Print Label
      </button>
      {open && (
        <div className="modal-overlay" onClick={() => setOpen(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 480 }}>
            <div className="modal-header">
              <h3>Print label — Job #{job.job_number}</h3>
              <button type="button" onClick={() => setOpen(false)}><X size={18} /></button>
            </div>
            <div style={{ border: '1px solid var(--border, #ddd)', borderRadius: 8, padding: 14, marginBottom: 14, background: '#fff', color: '#000' }}>
              <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Job Number</div>
              <div style={{ fontSize: 30, fontWeight: 800, lineHeight: 1.1, marginBottom: 8 }}>#{job.job_number}</div>
              <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
                <tbody>
                  {rows.map(([k, v]) => (
                    <tr key={k} style={{ borderTop: '1px solid #e5e5e5' }}>
                      <th style={{ textAlign: 'left', padding: '4px 8px 4px 0', width: '38%', verticalAlign: 'top' }}>{k}</th>
                      <td style={{ padding: '4px 0', color: v ? '#000' : '#999' }}>{v || 'not set'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {(!job.classifications || !job.data_destruction) && (
              <p style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 12 }}>
                Classification and Data Destruction are set with <strong>Edit details</strong>.
              </p>
            )}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 90px', gap: 10 }}>
              <div className="field">
                <label htmlFor="label-size">Label size</label>
                <select id="label-size" value={size} onChange={(e) => setSize(e.target.value)}>
                  {Object.entries(SIZES).map(([k, s]) => <option key={k} value={k}>{s.label}</option>)}
                </select>
              </div>
              <div className="field">
                <label htmlFor="label-copies">Copies</label>
                <input id="label-copies" type="number" min="1" max="50" value={copies} onChange={(e) => setCopies(e.target.value)} />
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
              <button type="button" className="btn btn-ghost" onClick={() => setOpen(false)} style={{ flex: 1 }}>Cancel</button>
              <button type="button" className="btn btn-accent" onClick={print} style={{ flex: 1 }}><Printer size={14} /> Print</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

import { useEffect, useState } from 'react';
import api from '../api';

// ITF Asset Checklist helpers shared by every page.

// The checklist content (device types, items, grades) comes from the server so
// the forms and the saved data always agree. Kept for the session once loaded.
let cached = null;
export function useChecklistConfig() {
  const [state, setState] = useState(cached);
  const [error, setError] = useState('');
  useEffect(() => {
    if (cached) return;
    api.get('/checklist/config')
      .then((r) => { cached = r.data; setState(r.data); })
      .catch((err) => setError(err.response?.data?.error || 'Could not load the checklist settings'));
  }, []);
  return { config: state?.config || null, isAdmin: !!state?.isAdmin, me: state?.me || '', error };
}

// Device types in the order they're shown, with their emoji.
export const DEVICE_ICONS = { laptop: '💻', desktop: '🖥️', aio: '🖥️', iphone: '📱', ipad: '📱', monitor: '🖵', otherEquipment: '🔌' };
export const DEVICE_ORDER = ['laptop', 'desktop', 'aio', 'iphone', 'ipad', 'monitor', 'otherEquipment'];
// Free-form fields shown as a text box instead of a one-line input.
export const MULTILINE_FIELDS = ['Ports', 'Additional Details'];

export const itemsOf = (device) => (device?.sections || []).flatMap((s) => s.items);
// Pass/fail items only (the "tick if applicable" features don't count).
export const requiredItemsOf = (device) => itemsOf(device).filter((i) => !(device.optionalItems || []).includes(i));
export const makeModel = (e) => [e.info?.Make, e.info?.Model].filter(Boolean).join(' ');
export const auDate = (iso) => {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : '';
};
export const auDateTime = (ms) => (ms ? new Date(ms).toLocaleString('en-AU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');
export const todayISO = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney' }).format(new Date());
export function gradeClass(config, label) {
  const g = (config?.cosmeticGrades || []).find((x) => x.label === label);
  return g ? `grade-${g.code.replace('-', 'minus').replace('+', 'plus')}` : '';
}
export const driveLink = (id) => `https://drive.google.com/file/d/${encodeURIComponent(id)}/view`;

// A saved photo as an object URL (photos need the sign-in, so they're fetched).
export async function photoUrl(id) {
  const r = await api.get(`/checklist/photos/${id}`, { responseType: 'blob' });
  return URL.createObjectURL(r.data);
}
export async function photoDataUrl(id) {
  const r = await api.get(`/checklist/photos/${id}`, { responseType: 'blob' });
  return new Promise((resolve) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => resolve(null);
    fr.readAsDataURL(r.data);
  });
}

// Shrinks a camera photo (longest side 1600px, JPEG) before it's uploaded.
export function shrinkImage(file, maxDim = 1600, quality = 0.82) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      c.toBlob((blob) => resolve(blob ? new File([blob], (file.name || 'photo').replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' }) : file), 'image/jpeg', quality);
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(file); };
    img.src = url;
  });
}

// --- Printing ---------------------------------------------------------------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const PRINT_CSS = `body{font-family:Arial,Helvetica,sans-serif;color:#111;margin:22px;font-size:13px}
.hdr{display:flex;align-items:center;gap:14px;border-bottom:2px solid #0f2c4c;padding-bottom:10px;margin-bottom:14px}
.hdr img{height:40px} h1{font-size:18px;margin:0;color:#0f2c4c} .aid{font-family:Consolas,monospace;font-weight:700;font-size:15px;color:#1b4272;margin-top:2px}
.meta{display:grid;grid-template-columns:repeat(3,1fr);gap:8px 20px;margin-bottom:14px}
.meta strong{display:block;color:#5b6774;font-weight:600;font-size:10.5px;text-transform:uppercase}
.meta .wide{grid-column:1/-1;white-space:pre-wrap}
h2{font-size:12.5px;text-transform:uppercase;letter-spacing:.4px;color:#0f2c4c;border-bottom:1px solid #dde3ea;padding-bottom:4px;margin:12px 0 8px}
ul{list-style:none;margin:0;padding:0;columns:2;column-gap:24px} li{break-inside:avoid;padding-left:20px;position:relative;margin-bottom:4px}
li.y:before{content:"\\2611";position:absolute;left:0} li.n:before{content:"\\2610";position:absolute;left:0}
.notes{white-space:pre-wrap;border:1px solid #dde3ea;border-radius:6px;padding:8px 10px;min-height:30px}
.photos{display:flex;flex-wrap:wrap;gap:10px} .photos img{width:150px;height:150px;object-fit:cover;border:1px solid #dde3ea;border-radius:8px}
table{border-collapse:collapse;width:100%} th,td{border-bottom:1px solid #dde3ea;padding:6px 8px;text-align:left;font-size:12px} th{background:#eef4fb}
.page{page-break-after:always} .page:last-child{page-break-after:auto}`;
function openPrint(title, body) {
  const w = window.open('', '_blank');
  if (!w) { alert('Please allow pop-ups for this site to print.'); return; }
  w.document.open();
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>${PRINT_CSS}</style></head><body>${body}
<script>window.onload=function(){setTimeout(function(){window.print();},250);};</script></body></html>`);
  w.document.close();
}
const logo = () => `<img src="${window.location.origin}/logo-sidebar.png" alt="IT Factory" onerror="this.remove()">`;

// One checklist as a report. `photos` are data URLs (already loaded).
export function checklistReportHtml(config, entry, photos = []) {
  const device = config.deviceTypes[entry.deviceKey];
  const ticked = new Set(entry.items);
  const info = device.infoFields.map((f) => `<div${MULTILINE_FIELDS.includes(f) ? ' class="wide"' : ''}><strong>${esc(f)}</strong>${esc(entry.info?.[f] || '—')}</div>`).join('');
  const sections = device.sections.map((s) => `<h2>${esc(s.title)}</h2><ul>${s.items.map((i) => `<li class="${ticked.has(i) ? 'y' : 'n'}">${esc(i)}</li>`).join('')}</ul>`).join('');
  const drive = entry.drivePhotoIds?.length ? `<p>${entry.drivePhotoIds.length} older photo(s) kept in Google Drive.</p>` : '';
  const pics = photos.length || drive ? `<h2>Photos</h2><div class="photos">${photos.filter(Boolean).map((p) => `<img src="${p}" alt="">`).join('')}</div>${drive}` : '';
  return `<div class="page"><div class="hdr">${logo()}<div><h1>${esc(device.label)} Asset Checklist</h1><div class="aid">${esc(entry.assetId)}</div></div></div>
<div class="meta"><div><strong>Date</strong>${esc(auDate(entry.date) || '—')}</div><div><strong>Technician</strong>${esc(entry.technician || '—')}</div>
<div><strong>Saved</strong>${esc(auDateTime(entry.createdAt) || '—')}</div>${entry.lastEditedBy ? `<div><strong>Last edited by</strong>${esc(entry.lastEditedBy)}</div>` : ''}
${info}<div><strong>Cosmetic grade</strong>${esc(entry.grade || '—')}</div><div><strong>Platform</strong>${esc(entry.platform || '—')}</div>
${entry.platform === 'ITF Australia' ? `<div><strong>Sales Manager</strong>${entry.salesItemId ? 'In Inventory on Hand' : 'Not added yet'}</div>` : ''}</div>
${sections}<h2>Condition notes</h2><div class="notes">${entry.notes ? esc(entry.notes) : '&nbsp;'}</div>${pics}</div>`;
}
export function printChecklists(config, list) {
  // list: [{ entry, photos }]
  openPrint(list.length === 1 ? list[0].entry.assetId : `${list.length} checklists`, list.map((x) => checklistReportHtml(config, x.entry, x.photos)).join(''));
}
export function printChecklistList(config, deviceKey, entries) {
  const device = config.deviceTypes[deviceKey];
  const total = itemsOf(device).length;
  const rows = entries.map((e) => `<tr><td>${esc(e.assetId)}</td><td>${esc(auDate(e.date))}</td><td>${esc(e.technician)}</td><td>${esc(makeModel(e))}</td>
<td>${esc(e.info?.['Serial Number'] || '')}</td><td>${esc(e.grade)}</td><td>${total ? `${e.items.length} / ${total}` : ''}</td><td>${esc(e.platform)}</td></tr>`).join('');
  const printed = new Date().toLocaleDateString('en-AU');
  openPrint(`${device.label} checklists`, `<div class="hdr">${logo()}<div><h1>${esc(device.label)} Asset Checklist</h1>
<div class="aid">Printed ${esc(printed)} — ${entries.length} ${entries.length === 1 ? 'entry' : 'entries'}</div></div></div>
<table><thead><tr><th>Asset ID</th><th>Date</th><th>Technician</th><th>Make / model</th><th>Serial</th><th>Grade</th><th>Items</th><th>Platform</th></tr></thead><tbody>${rows}</tbody></table>`);
}

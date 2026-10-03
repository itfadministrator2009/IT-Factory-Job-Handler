// Storage Centre PDFs: the client order / delivery docket and the client invoice.
// Same letterhead and palette as the Job Sheet (pdfBuilder.js).
const path = require('path');
const PDFDocument = require('pdfkit');

const LOGO_PATH = path.join(__dirname, 'assets', 'logo.jpg');
const COMPANY = {
  name: process.env.COMPANY_NAME || 'IT FACTORY PTY LTD',
  addressLines: (process.env.COMPANY_ADDRESS || '3 Allen Place|Wetherill Park, Sydney, NSW, 2164').split('|'),
  abn: process.env.COMPANY_ABN || 'ABN:14 137 802 272',
  phone: process.env.COMPANY_PHONE || 'Phone:1300 589 579',
};
// Optional GST on invoices, as a percentage (e.g. 10). Unset/0 = no GST line.
const GST_RATE = Number(process.env.STORAGE_GST_RATE || 0) || 0;
// Optional payment details printed at the foot of invoices ("|" = new line).
const PAYMENT_LINES = (process.env.STORAGE_INVOICE_PAYMENT_DETAILS || '').split('|').map((s) => s.trim()).filter(Boolean);

const TEAL = '#1e4d4b';
const LINE = '#c9c7bd';
const MUTED = '#6b7570';
const SHADE = '#f4f3ef';

function money(n) {
  return `$${(Number(n) || 0).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function dmy(s) {
  if (!s) return '';
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : String(s);
}
function todaySydney() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney' }).format(new Date());
}

function toBuffer(draw) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40, bufferPages: true });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    try {
      draw(doc);
      // Page numbers in the footer.
      const range = doc.bufferedPageRange();
      for (let i = range.start; i < range.start + range.count; i++) {
        doc.switchToPage(i);
        // Writing below the bottom margin would make pdfkit add a blank page, so
        // drop the margin while the footer is drawn.
        const savedBottom = doc.page.margins.bottom;
        doc.page.margins.bottom = 0;
        const bottom = doc.page.height - 28;
        doc.fontSize(7.5).fillColor(MUTED).font('Helvetica')
          .text(`Page ${i + 1} of ${range.count}`, doc.page.margins.left, bottom, { width: doc.page.width - doc.page.margins.left - doc.page.margins.right, align: 'right', lineBreak: false });
        doc.page.margins.bottom = savedBottom;
      }
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

// Letterhead + right-hand meta box + title bar. Returns the y to continue from.
function header(doc, title, metaRows) {
  const left = doc.page.margins.left;
  const width = doc.page.width - left - doc.page.margins.right;
  const top = doc.page.margins.top;
  try { doc.image(LOGO_PATH, left, top, { width: 130 }); } catch (e) { /* no logo */ }
  doc.fontSize(8).fillColor(MUTED).font('Helvetica');
  let infoY = top + 58;
  [...COMPANY.addressLines, COMPANY.abn, COMPANY.phone].forEach((line) => { doc.text(line, left, infoY, { width: 220 }); infoY += 11; });

  const boxW = 230; const boxX = left + width - boxW; const labelW = 100; const valueW = boxW - labelW - 10;
  let rowY = top;
  const heights = metaRows.map(([, v]) => Math.max(20, doc.fontSize(8.5).heightOfString(String(v || '—'), { width: valueW }) + 12));
  const boxH = heights.reduce((a, b) => a + b, 0);
  doc.roundedRect(boxX, top, boxW, boxH, 4).strokeColor(TEAL).stroke();
  metaRows.forEach(([label, value], i) => {
    if (i > 0) doc.moveTo(boxX, rowY).lineTo(boxX + boxW, rowY).strokeColor(LINE).stroke();
    doc.fontSize(8.5).font('Helvetica-Bold').fillColor('#333').text(label, boxX + 10, rowY + 6, { width: labelW - 10 });
    doc.font('Helvetica').fillColor('#111').text(String(value || '—'), boxX + labelW, rowY + 6, { width: valueW });
    rowY += heights[i];
  });

  let y = Math.max(infoY + 16, top + boxH + 18);
  doc.rect(left, y, width, 22).fill(TEAL);
  doc.fontSize(11).fillColor('white').font('Helvetica-Bold').text(title, left, y + 6, { width, align: 'center' });
  return y + 22 + 14;
}

function ensureSpace(doc, y, needed) {
  if (y + needed <= doc.page.height - doc.page.margins.bottom - 20) return y;
  doc.addPage();
  return doc.page.margins.top;
}

// Two-column label/value table (label shaded).
function infoTable(doc, rows, y) {
  const left = doc.page.margins.left;
  const width = doc.page.width - left - doc.page.margins.right;
  const labelW = 140; const valueW = width - labelW - 20;
  rows.forEach(([label, value]) => {
    const text = value == null || value === '' ? '—' : String(value);
    const rowH = Math.max(20, doc.fontSize(8.5).font('Helvetica').heightOfString(text, { width: valueW }) + 10);
    y = ensureSpace(doc, y, rowH);
    doc.rect(left, y, labelW, rowH).fill(SHADE);
    doc.rect(left, y, width, rowH).strokeColor(LINE).stroke();
    doc.moveTo(left + labelW, y).lineTo(left + labelW, y + rowH).strokeColor(LINE).stroke();
    doc.fontSize(8.5).fillColor('#333').font('Helvetica-Bold').text(label, left + 8, y + 6, { width: labelW - 16 });
    doc.font('Helvetica').fillColor('#111').text(text, left + labelW + 10, y + 5, { width: valueW });
    y += rowH;
  });
  return y;
}

// Table with a header row; columns: [{ label, width (fraction), align }]. Repeats
// the header on each new page.
function table(doc, columns, rows, y) {
  const left = doc.page.margins.left;
  const width = doc.page.width - left - doc.page.margins.right;
  const widths = columns.map((c) => c.width * width);
  const drawHead = (yy) => {
    doc.rect(left, yy, width, 18).fill(SHADE);
    let x = left;
    columns.forEach((c, i) => {
      doc.fontSize(8).font('Helvetica-Bold').fillColor('#333').text(c.label, x + 6, yy + 5, { width: widths[i] - 12, align: c.align || 'left' });
      x += widths[i];
    });
    return yy + 18;
  };
  y = ensureSpace(doc, y, 40);
  y = drawHead(y);
  rows.forEach((r) => {
    const h = Math.max(18, ...r.map((cell, i) => doc.fontSize(8.5).font('Helvetica').heightOfString(String(cell ?? ''), { width: widths[i] - 12 }) + 8));
    if (y + h > doc.page.height - doc.page.margins.bottom - 20) { doc.addPage(); y = drawHead(doc.page.margins.top); }
    let x = left;
    r.forEach((cell, i) => {
      doc.fontSize(8.5).font('Helvetica').fillColor('#111').text(String(cell ?? ''), x + 6, y + 4, { width: widths[i] - 12, align: columns[i].align || 'left' });
      x += widths[i];
    });
    doc.moveTo(left, y + h).lineTo(left + width, y + h).strokeColor(LINE).stroke();
    y += h;
  });
  return y;
}

function sectionTitle(doc, text, y) {
  y = ensureSpace(doc, y, 40);
  doc.fontSize(9.5).fillColor(TEAL).font('Helvetica-Bold').text(text, doc.page.margins.left, y);
  return y + 15;
}

// ---------------------------------------------------------------------------
// Client order / delivery docket
// ---------------------------------------------------------------------------
// `order` uses the API's camelCase shape (rowToOrder in routes/storage.js).
function buildOrderPdf(order) {
  return toBuffer((doc) => {
    let y = header(doc, 'CLIENT ORDER / DELIVERY DOCKET', [
      ['ORDER NO:', order.orderNumber],
      ['ORDER DATE:', dmy(String(order.createdAt || '').slice(0, 10))],
      ['DELIVER BY:', dmy(order.dateToBeDelivered)],
      ['STATUS:', order.status],
    ]);
    y = infoTable(doc, [
      ['CLIENT:', order.client],
      ['DELIVERY ADDRESS:', order.deliveryAddress],
      ['SITE CONTACT:', order.siteContactName],
      ['CONTACT PHONE:', order.siteContactPhone],
      ['REQUESTED BY:', order.requestor],
      ...(order.trackingNumber ? [['TRACKING NO:', order.trackingNumber]] : []),
    ], y);
    y += 16;

    const devices = String(order.devices || '').split(/\r?\n|,\s*(?=\S)/).map((s) => s.trim()).filter(Boolean);
    y = sectionTitle(doc, `DEVICES${devices.length ? ` (${devices.length})` : ''}`, y);
    if (devices.length) {
      y = table(doc, [{ label: '#', width: 0.08, align: 'right' }, { label: 'Device / serial', width: 0.72 }, { label: 'Checked', width: 0.2, align: 'center' }],
        devices.map((d, i) => [i + 1, d, '[   ]']), y);
    } else {
      y = infoTable(doc, [['DEVICES:', '—']], y);
    }
    y += 16;

    if (order.configInformation || order.notes) {
      y = sectionTitle(doc, 'DETAILS', y);
      y = infoTable(doc, [['CONFIGURATION:', order.configInformation], ['NOTES:', order.notes]], y);
      y += 16;
    }

    // Sign-off
    y = ensureSpace(doc, y, 110);
    y = sectionTitle(doc, 'RECEIVED BY', y);
    const left = doc.page.margins.left;
    const width = doc.page.width - left - doc.page.margins.right;
    const col = width / 3;
    ['Name', 'Signature', 'Date'].forEach((label, i) => {
      const x = left + i * col;
      doc.moveTo(x + 4, y + 40).lineTo(x + col - 12, y + 40).strokeColor('#999').stroke();
      doc.fontSize(8).fillColor(MUTED).font('Helvetica').text(label, x + 4, y + 44);
    });
  });
}

// ---------------------------------------------------------------------------
// Client invoice
// ---------------------------------------------------------------------------
function invoiceReference(statement) {
  const slug = String(statement.client || '').toUpperCase().replace(/[^A-Z0-9]+/g, '').slice(0, 8) || 'CLIENT';
  return `INV-${slug}-${String(statement.to).replace(/-/g, '')}`;
}

// `statement` comes from storageBilling.clientStatement.
function buildInvoicePdf(statement) {
  const subtotal = statement.total;
  const gst = GST_RATE ? Math.round(subtotal * GST_RATE) / 100 : 0;
  const total = Math.round((subtotal + gst) * 100) / 100;
  return toBuffer((doc) => {
    let y = header(doc, GST_RATE ? 'TAX INVOICE — STORAGE' : 'STORAGE INVOICE', [
      ['INVOICE REF:', invoiceReference(statement)],
      ['INVOICE DATE:', dmy(todaySydney())],
      ['PERIOD:', `${dmy(statement.from)} – ${dmy(statement.to)}`],
      ['BILL TO:', statement.client],
    ]);

    y = sectionTitle(doc, 'STORAGE', y);
    if (statement.storageLines.length) {
      y = table(doc, [
        { label: 'Storage centre', width: 0.2 }, { label: 'Location', width: 0.2 }, { label: 'Basis', width: 0.32 },
        { label: 'Days', width: 0.1, align: 'right' }, { label: 'Amount', width: 0.18, align: 'right' },
      ], statement.storageLines.map((l) => [
        l.storageCentre || '—', l.location || '—',
        l.kind === 'pallet'
          ? `Pallet @ ${money(l.ratePerWeek)}/week (${l.itemCount} item${l.itemCount === 1 ? '' : 's'})`
          : `${l.itemCount} item${l.itemCount === 1 ? '' : 's'} at their weekly rates (${l.days} item-days)`,
        l.kind === 'pallet' ? l.days : '', money(l.amount),
      ]), y);
    } else {
      doc.fontSize(8.5).fillColor(MUTED).font('Helvetica').text('No storage charges in this period.', doc.page.margins.left, y);
      y += 16;
    }
    y += 14;

    y = sectionTitle(doc, 'RECEIVING / DISPATCH', y);
    if (statement.rdLines.length) {
      y = table(doc, [
        { label: 'Date', width: 0.14 }, { label: 'Type', width: 0.16 }, { label: 'Stock', width: 0.52 }, { label: 'Amount', width: 0.18, align: 'right' },
      ], statement.rdLines.map((l) => [dmy(l.date), l.kind, l.description || '—', money(l.amount)]), y);
    } else {
      doc.fontSize(8.5).fillColor(MUTED).font('Helvetica').text('No receiving or dispatch charges in this period.', doc.page.margins.left, y);
      y += 16;
    }
    y += 18;

    // Totals box
    const left = doc.page.margins.left;
    const width = doc.page.width - left - doc.page.margins.right;
    const rows = [
      ['Storage', money(statement.storageTotal)],
      ['Receiving / dispatch', money(statement.rdTotal)],
      ...(GST_RATE ? [['Subtotal (ex GST)', money(subtotal)], [`GST (${GST_RATE}%)`, money(gst)]] : []),
    ];
    y = ensureSpace(doc, y, rows.length * 18 + 40);
    const boxW = 250; const boxX = left + width - boxW;
    rows.forEach(([label, value]) => {
      doc.fontSize(9).font('Helvetica').fillColor('#333').text(label, boxX, y, { width: 150 });
      doc.text(value, boxX + 150, y, { width: boxW - 150, align: 'right' });
      y += 16;
    });
    doc.rect(boxX, y + 2, boxW, 24).fill(TEAL);
    doc.fontSize(10.5).font('Helvetica-Bold').fillColor('white')
      .text(GST_RATE ? 'TOTAL (inc GST)' : 'TOTAL (ex GST)', boxX + 8, y + 9, { width: 140 })
      .text(money(total), boxX + 150, y + 9, { width: boxW - 158, align: 'right' });
    y += 32;
    if (!GST_RATE) {
      // Same note as the old app's invoices.
      doc.fontSize(8.5).font('Helvetica').fillColor(MUTED)
        .text('This total excludes GST. Please add GST as applicable.', boxX, y, { width: boxW, align: 'right' });
      y += 14;
    }
    y += 8;

    if (PAYMENT_LINES.length) {
      y = sectionTitle(doc, 'PAYMENT DETAILS', y);
      doc.fontSize(8.5).font('Helvetica').fillColor('#111');
      PAYMENT_LINES.forEach((line) => { doc.text(line, left, y); y += 12; });
    }
  });
}

// Receiving / dispatch only — the old Invoicing tab's per-client PDF.
function buildRdInvoicePdf({ client, from, to, lines, total }) {
  return toBuffer((doc) => {
    let y = header(doc, 'RECEIVING / DISPATCH INVOICE', [
      ['INVOICE REF:', `RD-${invoiceReference({ client, to })}`],
      ['INVOICE DATE:', dmy(todaySydney())],
      ['PERIOD:', `${dmy(from)} – ${dmy(to)}`],
      ['BILL TO:', client],
    ]);
    if (lines.length) {
      y = table(doc, [
        { label: 'Stock', width: 0.5 }, { label: 'Date', width: 0.14 }, { label: 'Billed as', width: 0.16 },
        { label: 'Cost (ex GST)', width: 0.2, align: 'right' },
      ], lines.map((l) => [l.description || '—', dmy(l.date), l.kind, money(l.amount)]), y);
    } else {
      doc.fontSize(8.5).fillColor(MUTED).font('Helvetica').text('No receiving or dispatch charges in this period.', doc.page.margins.left, y);
      y += 16;
    }
    y += 18;
    const left = doc.page.margins.left;
    const width = doc.page.width - left - doc.page.margins.right;
    const gst = GST_RATE ? Math.round(total * GST_RATE) / 100 : 0;
    const rows = GST_RATE ? [['Subtotal (ex GST)', money(total)], [`GST (${GST_RATE}%)`, money(gst)]] : [];
    y = ensureSpace(doc, y, rows.length * 18 + 40);
    const boxW = 250; const boxX = left + width - boxW;
    rows.forEach(([label, value]) => {
      doc.fontSize(9).font('Helvetica').fillColor('#333').text(label, boxX, y, { width: 150 });
      doc.text(value, boxX + 150, y, { width: boxW - 150, align: 'right' });
      y += 16;
    });
    doc.rect(boxX, y + 2, boxW, 24).fill(TEAL);
    doc.fontSize(10.5).font('Helvetica-Bold').fillColor('white')
      .text(GST_RATE ? 'TOTAL (inc GST)' : 'TOTAL (ex GST)', boxX + 8, y + 9, { width: 140 })
      .text(money(Math.round((total + gst) * 100) / 100), boxX + 150, y + 9, { width: boxW - 158, align: 'right' });
    y += 32;
    if (!GST_RATE) {
      doc.fontSize(8.5).font('Helvetica').fillColor(MUTED)
        .text('This total excludes GST. Please add GST as applicable.', boxX, y, { width: boxW, align: 'right' });
      y += 14;
    }
    if (PAYMENT_LINES.length) {
      y += 8;
      y = sectionTitle(doc, 'PAYMENT DETAILS', y);
      doc.fontSize(8.5).font('Helvetica').fillColor('#111');
      PAYMENT_LINES.forEach((line) => { doc.text(line, left, y); y += 12; });
    }
  });
}

module.exports = { buildOrderPdf, buildInvoicePdf, buildRdInvoicePdf, invoiceReference };

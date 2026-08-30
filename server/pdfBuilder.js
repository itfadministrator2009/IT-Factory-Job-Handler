const path = require('path');
const PDFDocument = require('pdfkit');
const { PDFDocument: PDFLibDocument } = require('pdf-lib');
const { db } = require('./db');

const LOGO_PATH = path.join(__dirname, 'assets', 'logo.jpg');
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');
const COMPANY = {
  addressLines: (process.env.COMPANY_ADDRESS || '3 Allen Place|Wetherill Park, Sydney, NSW, 2164').split('|'),
  abn: process.env.COMPANY_ABN || 'ABN:14 137 802 272',
  phone: process.env.COMPANY_PHONE || 'Phone:1300 589 579',
};

const TEAL = '#1e4d4b';
const LINE = '#c9c7bd';
const MUTED = '#6b7570';

function fmtDate(s) {
  if (!s) return '';
  const d = new Date(s.length <= 10 ? `${s}T00:00:00` : s.replace(' ', 'T') + 'Z');
  if (isNaN(d)) return s;
  return d.toLocaleDateString('en-AU', { day: '2-digit', month: '2-digit', year: '2-digit' });
}

// Draws the job sheet. If the job hasn't been signed in-app yet, the sign-off boxes
// are left blank and their exact coordinates are recorded in `fieldPositions` so the
// caller can turn them into real fillable PDF form fields afterward.
function drawJobSheet(doc, job, items, owner, attachments, fieldPositions) {
  const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const left = doc.page.margins.left;
  let y = doc.page.margins.top;
  let pageIndex = 0;
  const isSigned = !!job.signature_data;

  function addPage() {
    doc.addPage();
    pageIndex += 1;
    return doc.page.margins.top;
  }

  try {
    doc.image(LOGO_PATH, left, y, { width: 130 });
  } catch (e) { /* logo missing — continue without it */ }

  doc.fontSize(8).fillColor(MUTED).font('Helvetica');
  let infoY = y + 58;
  COMPANY.addressLines.forEach((line) => { doc.text(line, left, infoY, { width: 200 }); infoY += 11; });
  doc.text(COMPANY.abn, left, infoY, { width: 200 }); infoY += 11;
  doc.text(COMPANY.phone, left, infoY, { width: 200 });

  const boxW = 220;
  const boxX = left + pageWidth - boxW;
  const valueW = boxW - 110;
  const metaRows = [
    ['DATE:', fmtDate(job.due_date) || fmtDate(job.created_at)],
    ['TIME:', job.scheduled_time || '—'],
    ['JOB REFERENCE:', `#${job.job_number}`],
    ['TECHNICIAN:', owner?.name || '—'],
    ['VEHICLE:', job.language || '—'],
  ];
  // Row heights are computed per-row (not fixed) so a long value — like a full vehicle
  // description — wraps onto a second line instead of overflowing past the box border.
  // Extra bottom padding (14 instead of 10) so a wrapped second line doesn't crowd the border.
  const metaRowHeights = metaRows.map(([, value]) => Math.max(20, doc.heightOfString(value, { width: valueW }) + 14));
  const boxTotalH = metaRowHeights.reduce((a, b) => a + b, 0);

  doc.roundedRect(boxX, y, boxW, boxTotalH, 4).stroke(TEAL);
  let metaRowY = y;
  metaRows.forEach(([label, value], i) => {
    const rowH = metaRowHeights[i];
    if (i > 0) doc.moveTo(boxX, metaRowY).lineTo(boxX + boxW, metaRowY).strokeColor(LINE).stroke();
    // The label is vertically centered in the row — otherwise a short label looks stuck
    // to the top of a taller row whenever the value wraps onto a second line.
    doc.fontSize(8.5).font('Helvetica-Bold');
    const labelH = doc.heightOfString(label, { width: 100 });
    doc.fillColor('#333').text(label, boxX + 10, metaRowY + (rowH - labelH) / 2, { width: 100 });
    doc.font('Helvetica').fillColor('#111').text(value, boxX + 100, metaRowY + 7, { width: valueW });
    metaRowY += rowH;
  });

  y = Math.max(infoY + 20, y + boxTotalH + 20);

  doc.rect(left, y, pageWidth, 22).fill(TEAL);
  doc.fontSize(11).fillColor('white').font('Helvetica-Bold').text('JOB SHEET', left, y + 6, { width: pageWidth, align: 'center' });
  y += 22 + 14;

  doc.fontSize(9).fillColor('#111').font('Helvetica-Bold').text('Subject: ', left, y, { continued: true });
  doc.font('Helvetica').text(job.subject);
  y += 18;

  function infoTable(rows, startY) {
    const labelW = 140;
    let ry = startY;
    rows.forEach(([label, value]) => {
      const rowH = Math.max(20, doc.heightOfString(value || '—', { width: pageWidth - labelW - 20 }) + 10);
      doc.rect(left, ry, pageWidth, rowH).strokeColor(LINE).stroke();
      doc.moveTo(left + labelW, ry).lineTo(left + labelW, ry + rowH).strokeColor(LINE).stroke();
      doc.rect(left, ry, labelW, rowH).fill('#f4f3ef');
      doc.fontSize(8.5).fillColor('#333').font('Helvetica-Bold').text(label, left + 10, ry + 6, { width: labelW - 20 });
      doc.font('Helvetica').fillColor('#111').text(value || '—', left + labelW + 10, ry + 6, { width: pageWidth - labelW - 20 });
      ry += rowH;
    });
    return ry;
  }

  y = infoTable([
    ['BUSINESS NAME:', job.account_name || job.contact_name],
    ['ADDRESS:', job.site_address],
    ['PRIMARY CONTACT:', job.contact_name],
    ['CONTACT NUMBER:', job.phone],
    ['SITE ACCESS NOTES:', job.access_notes],
  ], y);

  y += 16;

  if (items.length > 0) {
    doc.fontSize(9).fillColor('#111').font('Helvetica-Bold').text('EQUIPMENT / ITEMS', left, y);
    y += 16;

    const col1 = pageWidth * 0.55;
    const col2 = pageWidth * 0.12;
    const col3 = pageWidth * 0.33;
    const headerH = 18;

    doc.rect(left, y, pageWidth, headerH).fill('#f4f3ef');
    doc.fontSize(8).fillColor('#333').font('Helvetica-Bold');
    doc.text('DESCRIPTION', left + 6, y + 5, { width: col1 - 10 });
    doc.text('QTY', left + col1, y + 5, { width: col2, align: 'center' });
    doc.text('REFERENCE / SERIAL', left + col1 + col2 + 6, y + 5, { width: col3 - 10 });
    doc.rect(left, y, pageWidth, headerH).strokeColor(LINE).stroke();
    y += headerH;

    items.forEach((item) => {
      const rowH = Math.max(18, doc.heightOfString(item.description, { width: col1 - 10 }) + 8);
      doc.rect(left, y, pageWidth, rowH).strokeColor(LINE).stroke();
      doc.moveTo(left + col1, y).lineTo(left + col1, y + rowH).strokeColor(LINE).stroke();
      doc.moveTo(left + col1 + col2, y).lineTo(left + col1 + col2, y + rowH).strokeColor(LINE).stroke();
      doc.fontSize(8.5).fillColor('#111').font('Helvetica');
      doc.text(item.description, left + 6, y + 5, { width: col1 - 10 });
      doc.text(String(item.qty), left + col1, y + 5, { width: col2, align: 'center' });
      doc.text(item.reference || '—', left + col1 + col2 + 6, y + 5, { width: col3 - 10 });
      y += rowH;
    });

    y += 16;
  }

  if (job.description) {
    doc.fontSize(9).fillColor('#111').font('Helvetica-Bold').text('JOB DESCRIPTION', left, y);
    y += 14;
    const descH = doc.heightOfString(job.description, { width: pageWidth - 20 }) + 12;
    doc.rect(left, y, pageWidth, descH).strokeColor(LINE).stroke();
    doc.fontSize(9).font('Helvetica').fillColor('#111').text(job.description, left + 10, y + 6, { width: pageWidth - 20 });
    y += descH + 16;
  }

  // COMMENTS — a free-text box below Job Description, made fillable the same way as
  // the sign-off fields (only while the job hasn't been signed off in-app yet). Once
  // signed, whatever was captured (in-app or via the fillable PDF) shows as static text.
  {
    const commentsText = job.comments || '';
    const commentsH = isSigned
      ? Math.max(50, doc.heightOfString(commentsText || ' ', { width: pageWidth - 12 }) + 16)
      : 50;
    doc.fontSize(9).fillColor('#111').font('Helvetica-Bold').text('COMMENTS', left, y);
    y += 14;
    doc.rect(left, y, pageWidth, commentsH).strokeColor(LINE).stroke();
    if (isSigned) {
      if (commentsText) {
        doc.fontSize(9).font('Helvetica').fillColor('#111').text(commentsText, left + 6, y + 6, { width: pageWidth - 12 });
      }
    } else if (fieldPositions) {
      fieldPositions.comments = { pageIndex, x: left + 6, y: y + 4, width: pageWidth - 12, height: commentsH - 8 };
    }
    y += commentsH + 16;
  }

  if (job.customer_reference) {
    const noteH = 26;
    doc.rect(left, y, pageWidth, noteH).strokeColor(LINE).stroke();
    doc.moveTo(left + 80, y).lineTo(left + 80, y + noteH).strokeColor(LINE).stroke();
    doc.rect(left, y, 80, noteH).fill('#f4f3ef');
    doc.fontSize(8.5).fillColor('#333').font('Helvetica-Bold').text('NOTES:', left + 8, y + 8);
    doc.font('Helvetica').fillColor('#111').text(job.customer_reference, left + 90, y + 8, { width: pageWidth - 100 });
    y += noteH + 20;
  }

  const sigRowH = 24;
  const sigBoxH = 60;
  const neededHeight = sigRowH * 2 + sigBoxH + 20;
  if (y + neededHeight > doc.page.height - doc.page.margins.bottom) {
    y = addPage();
  }

  // CUSTOMER NAME row
  doc.rect(left, y, 90, sigRowH).fill('#f4f3ef');
  doc.rect(left, y, pageWidth, sigRowH).strokeColor(LINE).stroke();
  doc.moveTo(left + 90, y).lineTo(left + 90, y + sigRowH).strokeColor(LINE).stroke();
  doc.fontSize(8.5).fillColor('#333').font('Helvetica-Bold').text('CUSTOMER NAME:', left + 8, y + 8, { width: 80 });
  if (isSigned) {
    doc.font('Helvetica').fillColor('#111').text(job.signature_name || '—', left + 98, y + 8);
  } else if (fieldPositions) {
    fieldPositions.customerName = { pageIndex, x: left + 96, y: y + 3, width: pageWidth - 106, height: sigRowH - 6 };
  }
  y += sigRowH;

  // CUSTOMER SIGNATURE box
  doc.rect(left, y, 90, sigBoxH).fill('#f4f3ef');
  doc.rect(left, y, pageWidth, sigBoxH).strokeColor(LINE).stroke();
  doc.moveTo(left + 90, y).lineTo(left + 90, y + sigBoxH).strokeColor(LINE).stroke();
  doc.fontSize(8.5).fillColor('#333').font('Helvetica-Bold').text('CUSTOMER SIGNATURE:', left + 8, y + 8, { width: 80 });
  if (isSigned && job.signature_data) {
    try {
      const base64 = job.signature_data.replace(/^data:image\/\w+;base64,/, '');
      const imgBuffer = Buffer.from(base64, 'base64');
      doc.image(imgBuffer, left + 100, y + 5, { fit: [pageWidth - 120, sigBoxH - 10] });
    } catch (e) { /* corrupt signature data — leave the box blank */ }
  } else if (fieldPositions) {
    fieldPositions.customerSignature = { pageIndex, x: left + 96, y: y + 5, width: pageWidth - 106, height: sigBoxH - 10 };
  }
  y += sigBoxH;

  // DATE row
  doc.rect(left, y, 90, sigRowH).fill('#f4f3ef');
  doc.rect(left, y, pageWidth, sigRowH).strokeColor(LINE).stroke();
  doc.moveTo(left + 90, y).lineTo(left + 90, y + sigRowH).strokeColor(LINE).stroke();
  doc.fontSize(8.5).fillColor('#333').font('Helvetica-Bold').text('DATE:', left + 8, y + 8, { width: 80 });
  if (isSigned) {
    doc.font('Helvetica').fillColor('#111').text(job.signature_at ? fmtDate(job.signature_at) : '—', left + 98, y + 8);
  } else if (fieldPositions) {
    fieldPositions.date = { pageIndex, x: left + 96, y: y + 3, width: pageWidth - 106, height: sigRowH - 6 };
  }
  y += sigRowH;

  if (fieldPositions) fieldPositions.pageHeight = doc.page.height;

  // ---- Attachments ----
  if (attachments && attachments.length > 0) {
    const imageAttachments = attachments.filter((a) => a.mime_type && a.mime_type.startsWith('image/'));
    const otherAttachments = attachments.filter((a) => !(a.mime_type && a.mime_type.startsWith('image/')));

    if (otherAttachments.length > 0) {
      y += 16;
      if (y + 60 > doc.page.height - doc.page.margins.bottom) {
        y = addPage();
      }
      doc.fontSize(9).fillColor('#111').font('Helvetica-Bold').text('OTHER ATTACHMENTS', left, y);
      y += 16;
      otherAttachments.forEach((a) => {
        doc.fontSize(8.5).font('Helvetica').fillColor('#333').text(`• ${a.original_name}`, left, y, { width: pageWidth });
        y += 14;
      });
    }

    imageAttachments.forEach((att) => {
      addPage();
      const pw = doc.page.width - doc.page.margins.left - doc.page.margins.right;
      const pl = doc.page.margins.left;
      let py = doc.page.margins.top;
      doc.fontSize(9).fillColor('#111').font('Helvetica-Bold').text(`Attachment: ${att.original_name}`, pl, py, { width: pw });
      py += 18;
      const availableHeight = doc.page.height - py - doc.page.margins.bottom;
      try {
        const filePath = path.join(UPLOAD_DIR, att.stored_name);
        doc.image(filePath, pl, py, { fit: [pw, availableHeight] });
      } catch (e) { /* unreadable or unsupported image — skip rather than fail the whole PDF */ }
    });
  }
}

function loadJobData(jobId) {
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
  if (!job) return null;
  const owner = job.owner_id ? db.prepare('SELECT name FROM users WHERE id = ?').get(job.owner_id) : null;
  const items = db.prepare('SELECT * FROM job_items WHERE job_id = ? ORDER BY sort_order ASC').all(jobId);
  const attachments = db.prepare('SELECT * FROM attachments WHERE job_id = ? ORDER BY created_at ASC').all(jobId);
  return { job, owner, items, attachments };
}

// Draws the base PDF with pdfkit, then — only if the job hasn't been signed in-app —
// overlays real fillable AcroForm fields (Customer Name, Signature, Date) on top of
// the blank sign-off boxes using pdf-lib, so the customer can type/sign directly in
// any standard PDF reader (Adobe, Preview, Chrome, etc).
async function renderJobSheet(jobId) {
  const data = loadJobData(jobId);
  if (!data) return null;

  const fieldPositions = {};
  const baseBuffer = await new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40 });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    drawJobSheet(doc, data.job, data.items, data.owner, data.attachments, fieldPositions);
    doc.end();
  });

  if (data.job.signature_data) {
    // Already signed in-app — nothing to make fillable, ship the static PDF as-is.
    return { buffer: baseBuffer, jobNumber: data.job.job_number };
  }

  const pdfDoc = await PDFLibDocument.load(baseBuffer);
  const form = pdfDoc.getForm();
  const pages = pdfDoc.getPages();

  function addField(name, pos, options = {}) {
    if (!pos) return;
    const page = pages[pos.pageIndex];
    const pdfY = fieldPositions.pageHeight - pos.y - pos.height;
    const field = form.createTextField(name);
    field.addToPage(page, { x: pos.x, y: pdfY, width: pos.width, height: pos.height, borderWidth: 0 });
    field.setFontSize(10);
    if (options.multiline) field.enableMultiline();
  }

  addField('customer_name', fieldPositions.customerName);
  addField('customer_signature', fieldPositions.customerSignature);
  addField('date', fieldPositions.date);
  addField('comments', fieldPositions.comments, { multiline: true });

  try { form.updateFieldAppearances(); } catch (e) { /* non-fatal — fields still fillable without pre-rendered appearances */ }

  const filledBytes = await pdfDoc.save();
  return { buffer: Buffer.from(filledBytes), jobNumber: data.job.job_number };
}

async function streamJobSheet(jobId, res) {
  const result = await renderJobSheet(jobId);
  if (!result) return false;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="Job-${result.jobNumber}.pdf"`);
  res.send(result.buffer);
  return true;
}

async function buildJobSheetBuffer(jobId) {
  const result = await renderJobSheet(jobId);
  if (!result) throw new Error('Job not found');
  return result.buffer;
}

module.exports = { streamJobSheet, buildJobSheetBuffer, loadJobData };

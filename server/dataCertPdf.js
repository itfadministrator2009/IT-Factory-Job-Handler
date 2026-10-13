// Certificate of Data Destruction — the same layout as the Word certificate IT
// Factory sends customers: logo and company details at the top of every page,
// date of issue / customer / job reference, the certification statement, a
// table of every device (Item, Make, Model, Serial Number) and the ISO /
// Blancco badges along the bottom of every page.
const path = require('path');
const PDFDocument = require('pdfkit');

const LOGO_PATH = path.join(__dirname, 'assets', 'logo.jpg');
const FOOTER_PATH = path.join(__dirname, 'assets', 'cert-footer.jpg');

const COMPANY = {
  address: (process.env.CERT_COMPANY_ADDRESS || '3 Allen Place,|Wetherill Park NSW 2164').split('|'),
  abn: process.env.CERT_COMPANY_ABN || '14 137 802 272',
  phone: process.env.CERT_COMPANY_PHONE || '1300 589 579',
  email: process.env.CERT_COMPANY_EMAIL || 'collections@itfactory.com.au',
  website: process.env.CERT_COMPANY_WEBSITE || 'www.itfactory.com.au',
};

const GREEN = '#70ad47';
const STATEMENT = 'This document is to certify that the below devices containing any hard drives / media, have been securely and '
  + 'environmentally Data Sanitised / Shredded to ISO 27001 Compliance by IT Factory PTY LTD.';
const COLUMNS = [
  { key: 'item', label: 'ITEM', share: 0.21 },
  { key: 'make', label: 'MAKE', share: 0.24 },
  { key: 'model', label: 'MODEL', share: 0.23 },
  { key: 'serial', label: 'SERIAL NUMBER', share: 0.32 },
];

// "2026-10-13" → "13/10/2026"; anything else is shown as given.
function dmy(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  return m ? `${m[3]}/${m[2]}/${m[1]}` : String(s || '');
}

function todaySydney() {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Sydney', day: '2-digit', month: '2-digit', year: 'numeric' })
    .formatToParts(new Date()).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

// Fit text into a cell: shrink a little, then cut with "…" if still too long.
function fitText(doc, text, width, size) {
  let s = size;
  doc.fontSize(s);
  while (doc.widthOfString(text) > width && s > 6.5) { s -= 0.5; doc.fontSize(s); }
  if (doc.widthOfString(text) <= width) return { text, size: s };
  let t = text;
  while (t.length > 1 && doc.widthOfString(`${t}…`) > width) t = t.slice(0, -1);
  return { text: `${t}…`, size: s };
}

function buildDataDestructionCertificate({ customer, jobNumber, issueDate, rows }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margins: { top: 28, bottom: 20, left: 36, right: 36 }, info: { Title: 'Certificate of Data Destruction', Author: 'IT Factory PTY LTD' } });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const left = doc.page.margins.left;
    const width = doc.page.width - left - doc.page.margins.right;
    const pageH = doc.page.height;
    const footerW = 410; // badge strip (991×268 image) across the bottom
    const footerH = Math.round(footerW * 268 / 991);
    const footerTop = pageH - doc.page.margins.bottom - footerH;
    const rowH = 15;
    const headH = 14;

    // Logo + company details + job details. Returns the y below them.
    function header() {
      const top = doc.page.margins.top;
      try { doc.image(LOGO_PATH, left - 4, top + 6, { width: 200 }); } catch { /* logo missing */ }

      const divX = left + width - 165; // the thin vertical line between labels and values
      const labelW = 90;
      const lineGap = 11.2;
      let y = top;
      const pair = (label, values, bold) => {
        doc.font('Helvetica-Bold').fontSize(8.6).fillColor('#000');
        const blockH = values.length * lineGap;
        doc.text(label, divX - 6 - labelW, y + (blockH - lineGap) / 2, { width: labelW, align: 'right', lineBreak: false });
        doc.font(bold ? 'Helvetica-Bold' : 'Helvetica');
        values.forEach((v, i) => doc.text(v, divX + 6, y + i * lineGap, { width: 165 - 6, lineBreak: false }));
        y += blockH + 1.5;
      };
      const block1Top = y;
      pair('Address', COMPANY.address);
      pair('ABN', [COMPANY.abn]);
      pair('Phone', [COMPANY.phone]);
      pair('Email', [COMPANY.email]);
      pair('Website', [COMPANY.website]);
      doc.moveTo(divX, block1Top - 1).lineTo(divX, y - 2).lineWidth(0.8).strokeColor('#000').stroke();

      y += 10;
      const block2Top = y;
      pair('Date of Issue', [dmy(issueDate)]);
      pair('Customer', [customer || '']);
      pair('Job Reference No.', [jobNumber ? `#${jobNumber}` : '']);
      doc.moveTo(divX, block2Top - 1).lineTo(divX, y - 2).lineWidth(0.8).strokeColor('#000').stroke();
      return y + 8;
    }

    function footer() {
      try {
        doc.image(FOOTER_PATH, left + (width - footerW) / 2, footerTop, { width: footerW, height: footerH });
      } catch { /* badges missing */ }
    }

    function tableHead(y) {
      let x = left;
      doc.rect(left, y, width, headH).fill(GREEN);
      doc.font('Helvetica').fontSize(8).fillColor('#fff');
      COLUMNS.forEach((c) => {
        const w = width * c.share;
        doc.text(c.label, x, y + 3.5, { width: w, align: 'center', lineBreak: false });
        if (x > left) doc.moveTo(x, y).lineTo(x, y + headH).lineWidth(0.6).strokeColor('#fff').stroke();
        x += w;
      });
      return y + headH;
    }

    function tableRow(y, r) {
      let x = left;
      doc.lineWidth(0.6).strokeColor('#000');
      doc.rect(left, y, width, rowH).stroke();
      doc.font('Helvetica').fillColor('#000');
      COLUMNS.forEach((c) => {
        const w = width * c.share;
        if (x > left) doc.moveTo(x, y).lineTo(x, y + rowH).stroke();
        const { text, size } = fitText(doc, String(r[c.key] ?? '').trim() || 'N/A', w - 6, 9);
        doc.fontSize(size).text(text, x + 3, y + (rowH - size) / 2 + 0.5, { width: w - 6, align: 'center', lineBreak: false });
        x += w;
      });
      return y + rowH;
    }

    // Page 1: header, title, statement, then the table.
    let y = header();
    y += 6;
    doc.font('Helvetica-Bold').fontSize(19).fillColor('#000')
      .text('CERTIFICATE OF DATA DESTRUCTION', left, y, { width, align: 'center' });
    y += 26;
    doc.moveTo(left, y).lineTo(left + width, y).lineWidth(0.8).strokeColor('#000').stroke();
    y += 8;
    doc.font('Helvetica').fontSize(8.6).fillColor('#000');
    doc.text(STATEMENT, left + 10, y, { width: width - 20, align: 'center', lineGap: 2 });
    y = doc.y + 10;
    y = tableHead(y);
    footer();

    const bottom = footerTop - 12;
    rows.forEach((r) => {
      if (y + rowH > bottom) {
        doc.addPage();
        y = header();
        y += 6;
        y = tableHead(y);
        footer();
      }
      y = tableRow(y, r);
    });

    doc.end();
  });
}

// Turns whatever the browser sent into clean rows (only the four columns, as text).
function cleanRows(input) {
  if (!Array.isArray(input)) return [];
  const s = (v) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
  return input
    .map((r) => ({ item: s(r?.item), make: s(r?.make), model: s(r?.model), serial: s(r?.serial) }))
    .filter((r) => r.item || r.make || r.model || r.serial);
}

module.exports = { buildDataDestructionCertificate, cleanRows, todaySydney, dmy };

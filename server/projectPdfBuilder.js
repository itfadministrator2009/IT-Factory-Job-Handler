const PDFDocument = require('pdfkit');
const path = require('path');

const TEAL = '#1e4d4b';
const MUTED = '#6b7570';
const LINE = '#c9c7bd';

function fmtDate(s) {
  if (!s) return '—';
  const d = new Date(s.replace(' ', 'T') + 'Z');
  if (isNaN(d)) return s;
  return d.toLocaleString('en-AU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

// Same conditional-logic engine as server/routes/projects.js and the frontend form —
// a field the tech never actually saw (visibleIf false) must not appear in the PDF
// either, or the document would show questions that were never really "asked".
function matchesCondition(cond, instanceAnswers) {
  if (!cond) return true;
  const val = instanceAnswers[cond.field];
  if (cond.equals !== undefined) return val === cond.equals;
  if (cond.notEmpty) return val !== undefined && val !== null && val !== '';
  if (cond.empty) return val === undefined || val === null || val === '';
  return true;
}
function isFieldVisible(field, instanceAnswers) {
  return matchesCondition(field.visibleIf, instanceAnswers);
}

// Renders a completed (submitted) project entry as a read-only PDF — walks the same
// template.sections structure the form itself is built from, so it always matches
// whatever a project's template actually contains, not a fixed layout.
function buildProjectEntryPdf(project, entry, photos, uploadDir) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40 });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const left = doc.page.margins.left;
    const bottom = doc.page.height - doc.page.margins.bottom;

    function ensureSpace(needed) {
      if (doc.y + needed > bottom) doc.addPage();
    }

    // ---- Header ----
    const headerY = doc.y;
    doc.rect(left, headerY, pageWidth, 26).fill(TEAL);
    doc.fillColor('white').fontSize(13).font('Helvetica-Bold').text(project.name, left + 10, headerY + 7, { width: pageWidth - 20, lineBreak: false });
    doc.y = headerY + 26 + 10;

    doc.fillColor('#111').fontSize(11).font('Helvetica-Bold').text(`Entry #${entry.entry_number}${entry.site_name ? ' — ' + entry.site_name : ''}`);
    doc.fillColor(MUTED).fontSize(9).font('Helvetica').text(`Submitted: ${fmtDate(entry.submitted_at)}`);
    doc.moveDown(0.8);

    const template = project.template;
    const answers = entry.answers || {};

    function photosFor(fieldId, repeatIndex) {
      const key = repeatIndex === undefined ? null : repeatIndex;
      return photos.filter((p) => p.field_id === fieldId && (p.repeat_index ?? null) === key);
    }

    function renderField(field, instanceAnswers, repeatIndex) {
      if (field.type === 'instruction') return;
      if (!isFieldVisible(field, instanceAnswers)) return; // never shown to the tech — leave it out of the record too
      const value = instanceAnswers[field.id];

      ensureSpace(20);
      doc.fontSize(9).font('Helvetica-Bold').fillColor('#333').text(field.label, left, doc.y, { width: pageWidth });

      if (field.type === 'photo') {
        const fps = photosFor(field.id, repeatIndex);
        if (fps.length === 0) {
          doc.fontSize(9).font('Helvetica').fillColor(MUTED).text('No photo attached');
        } else {
          fps.forEach((p) => {
            ensureSpace(190);
            try {
              doc.image(path.join(uploadDir, p.stored_name), left, doc.y, { fit: [Math.min(pageWidth, 260), 170] });
              doc.y += 170;
              doc.moveDown(0.2);
            } catch (e) {
              doc.fontSize(9).fillColor('#a23a1c').text('(could not load image)');
            }
          });
        }
      } else if (field.type === 'signature') {
        if (value) {
          try {
            const base64 = value.replace(/^data:image\/\w+;base64,/, '');
            const buf = Buffer.from(base64, 'base64');
            ensureSpace(90);
            doc.image(buf, left, doc.y, { fit: [200, 80] });
            doc.y += 80;
          } catch (e) {
            doc.fontSize(9).fillColor('#a23a1c').text('(signature could not be rendered)');
          }
        } else {
          doc.fontSize(9).font('Helvetica').fillColor(MUTED).text('Not signed');
        }
      } else {
        doc.fontSize(9).font('Helvetica').fillColor('#111').text(value || '—', left, doc.y, { width: pageWidth });
      }
      doc.moveDown(0.5);
    }

    template.sections.forEach((section) => {
      ensureSpace(40);
      doc.moveDown(0.3);
      doc.fontSize(12).font('Helvetica-Bold').fillColor(TEAL).text(section.title, left, doc.y, { width: pageWidth });
      doc.moveTo(left, doc.y + 2).lineTo(left + pageWidth, doc.y + 2).strokeColor(LINE).stroke();
      doc.moveDown(0.5);

      if (section.repeatable) {
        const instances = Array.isArray(answers[section.id]) ? answers[section.id] : [];
        if (instances.length === 0) {
          doc.fontSize(9).font('Helvetica').fillColor(MUTED).text('None recorded.');
        }
        instances.forEach((instanceAnswers, idx) => {
          ensureSpace(24);
          doc.fontSize(10).font('Helvetica-Bold').fillColor('#333').text(`${section.title} #${idx + 1}`, left, doc.y, { width: pageWidth });
          doc.moveDown(0.3);
          section.fields.forEach((field) => renderField(field, instanceAnswers, idx));
          doc.moveDown(0.3);
        });
      } else {
        const instanceAnswers = answers[section.id] || {};
        section.fields.forEach((field) => renderField(field, instanceAnswers, undefined));
      }
    });

    doc.end();
  });
}

module.exports = { buildProjectEntryPdf };

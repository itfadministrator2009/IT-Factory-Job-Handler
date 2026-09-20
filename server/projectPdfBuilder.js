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
    console.log(`[pdf-trace] page dimensions: width=${doc.page.width} height=${doc.page.height} bottom-threshold=${bottom}`);
    let pageAddCount = 0;

    function ensureSpace(needed) {
      if (doc.y + needed > bottom) {
        pageAddCount++;
        console.log(`[pdf-trace] addPage() #${pageAddCount} triggered: doc.y=${doc.y.toFixed(1)} + needed=${needed.toFixed(1)} > bottom=${bottom.toFixed(1)}`);
        doc.addPage();
        console.log(`[pdf-trace]   after addPage(): doc.y=${doc.y.toFixed(1)}`);
      }
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

    // Draws an image scaled to fit within maxW x maxH — computed exactly from the
    // image's real dimensions (via doc.openImage) rather than relying on pdfkit's
    // `fit` option and then guessing how tall the result actually was. This is what
    // was actually causing photos to overlap the text below them: the previous code
    // assumed a fixed height after drawing, which didn't always match reality.
    // Returns the exact height it used, so the caller can advance the cursor by
    // precisely that amount — never too little (which caused the overlap) and never
    // an unnecessarily large guess either.
    function drawImageFitted(src, x, y, maxW, maxH) {
      const img = doc.openImage(src);
      const scale = Math.min(maxW / img.width, maxH / img.height);
      const w = img.width * scale;
      const h = img.height * scale;
      doc.image(img, x, y, { width: w, height: h });
      return h;
    }

    function renderField(field, instanceAnswers, repeatIndex) {
      if (field.type === 'instruction') return;
      if (!isFieldVisible(field, instanceAnswers)) return; // never shown to the tech — leave it out of the record too
      const value = instanceAnswers[field.id];
      console.log(`[pdf-trace] field "${field.id}" (${field.type}) start: doc.y=${doc.y.toFixed(1)}`);

      // Measure the label's actual height first — some labels in a template like this
      // run 150+ characters and wrap to 2-3 lines, so a fixed small reservation isn't
      // enough and was letting labels run into whatever content followed them.
      doc.fontSize(9).font('Helvetica-Bold');
      const labelHeight = doc.heightOfString(field.label, { width: pageWidth });
      ensureSpace(labelHeight + 4);
      doc.fillColor('#333').text(field.label, left, doc.y, { width: pageWidth });
      console.log(`[pdf-trace]   after label (measured height=${labelHeight.toFixed(1)}): doc.y=${doc.y.toFixed(1)}`);

      if (field.type === 'photo') {
        const fps = photosFor(field.id, repeatIndex);
        console.log(`[pdf-trace]   photo field has ${fps.length} photo(s) attached`);
        if (fps.length === 0) {
          doc.fontSize(9).font('Helvetica').fillColor(MUTED).text('No photo attached');
        } else {
          fps.forEach((p, pi) => {
            const maxW = Math.min(pageWidth, 260);
            const maxH = 170;
            ensureSpace(maxH + 20);
            try {
              const fullPath = path.join(uploadDir, p.stored_name);
              const fileExists = require('fs').existsSync(fullPath);
              const fileSize = fileExists ? require('fs').statSync(fullPath).size : -1;
              console.log(`[pdf-trace]   photo #${pi} file="${p.stored_name}" exists=${fileExists} size=${fileSize} doc.y before=${doc.y.toFixed(1)}`);
              const actualHeight = drawImageFitted(fullPath, left, doc.y, maxW, maxH);
              console.log(`[pdf-trace]   photo #${pi} drawn, computed height=${actualHeight.toFixed(1)}`);
              doc.y += actualHeight;
              doc.moveDown(0.4);
              console.log(`[pdf-trace]   after photo #${pi}: doc.y=${doc.y.toFixed(1)}`);
            } catch (e) {
              console.log(`[pdf-trace]   photo #${pi} FAILED TO LOAD: ${e.message}`);
              doc.fontSize(9).fillColor('#a23a1c').text('(could not load image)');
            }
          });
        }
      } else if (field.type === 'signature') {
        if (value) {
          try {
            const base64 = value.replace(/^data:image\/\w+;base64,/, '');
            const buf = Buffer.from(base64, 'base64');
            const maxW = 200, maxH = 80;
            ensureSpace(maxH + 20);
            const actualHeight = drawImageFitted(buf, left, doc.y, maxW, maxH);
            doc.y += actualHeight;
            doc.moveDown(0.2);
          } catch (e) {
            console.log(`[pdf-trace]   signature FAILED TO RENDER: ${e.message}`);
            doc.fontSize(9).fillColor('#a23a1c').text('(signature could not be rendered)');
          }
        } else {
          doc.fontSize(9).font('Helvetica').fillColor(MUTED).text('Not signed');
        }
      } else {
        // Text/textarea/date/yesno answers — same measure-first approach as the label,
        // since a long free-text answer can wrap just as far as a long label can.
        const text = value || '—';
        doc.fontSize(9).font('Helvetica');
        const valueHeight = doc.heightOfString(text, { width: pageWidth });
        ensureSpace(valueHeight + 4);
        doc.fillColor('#111').text(text, left, doc.y, { width: pageWidth });
        console.log(`[pdf-trace]   value type=${typeof value} length=${String(text).length} measured height=${valueHeight.toFixed(1)}`);
      }
      doc.moveDown(0.5);
      console.log(`[pdf-trace] field "${field.id}" end: doc.y=${doc.y.toFixed(1)}`);
    }

    template.sections.forEach((section) => {
      console.log(`[pdf-trace] === section "${section.id}" start: doc.y=${doc.y.toFixed(1)} ===`);
      doc.fontSize(12).font('Helvetica-Bold');
      const titleHeight = doc.heightOfString(section.title, { width: pageWidth });
      ensureSpace(titleHeight + 10);
      doc.moveDown(0.3);
      doc.fillColor(TEAL).text(section.title, left, doc.y, { width: pageWidth });
      doc.moveTo(left, doc.y + 2).lineTo(left + pageWidth, doc.y + 2).strokeColor(LINE).stroke();
      doc.moveDown(0.5);

      if (section.repeatable) {
        const instances = Array.isArray(answers[section.id]) ? answers[section.id] : [];
        if (instances.length === 0) {
          doc.fontSize(9).font('Helvetica').fillColor(MUTED).text('None recorded.');
        }
        instances.forEach((instanceAnswers, idx) => {
          const instanceLabel = `${section.title} #${idx + 1}`;
          doc.fontSize(10).font('Helvetica-Bold');
          const instanceLabelHeight = doc.heightOfString(instanceLabel, { width: pageWidth });
          ensureSpace(instanceLabelHeight + 6);
          doc.fillColor('#333').text(instanceLabel, left, doc.y, { width: pageWidth });
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

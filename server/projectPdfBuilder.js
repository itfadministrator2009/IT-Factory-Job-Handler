const PDFDocument = require('pdfkit');
const sharp = require('sharp');
const path = require('path');

const TEAL = '#1e4d4b';
const MUTED = '#6b7570';
const LINE = '#c9c7bd';

// Photos are only ever displayed at a small size in this PDF (a few centimetres), so
// there's no reason to embed a phone camera's full 12MP original — pdfkit embeds
// JPEGs almost as-is without recompressing, so a handful of untouched 2-3MB photos
// was the entire reason these PDFs were running to 13MB+. Resizing to roughly the
// actual display resolution first cuts that down to a small fraction of the size
// with no visible quality loss at the size they're actually shown.
const PHOTO_MAX_DIMENSION = 1000; // px, longest side
const PHOTO_JPEG_QUALITY = 78;

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

// Resizes and recompresses a photo down to roughly its real display resolution before
// it's ever handed to pdfkit. .rotate() with no arguments auto-orients the image
// according to its EXIF data first — a welcome side effect, since pdfkit itself
// ignores EXIF orientation and would otherwise embed some phone photos sideways.
async function loadResizedPhoto(srcPath) {
  return sharp(srcPath)
    .rotate()
    .resize({ width: PHOTO_MAX_DIMENSION, height: PHOTO_MAX_DIMENSION, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: PHOTO_JPEG_QUALITY })
    .toBuffer();
}

// Renders a completed (submitted) project entry as a read-only PDF — walks the same
// template.sections structure the form itself is built from, so it always matches
// whatever a project's template actually contains, not a fixed layout.
function buildProjectEntryPdf(project, entry, photos, uploadDir) {
  return new Promise((resolve, reject) => {
    // Sets the PDF's own internal title metadata — Chrome/Edge's built-in PDF viewer
    // uses this (not the blob URL, which has no meaningful name) as the suggested
    // filename when someone clicks Save from within the viewer. Strips characters
    // that aren't safe in a filename.
    const rawTitle = `${project.name} - ${entry.site_name || `Entry ${entry.entry_number}`}`;
    const safeTitle = rawTitle.replace(/[\\/:*?"<>|]/g, '').trim();
    const doc = new PDFDocument({ size: 'A4', margin: 40, info: { Title: safeTitle } });
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

    // Draws an image scaled to fit within maxW x maxH — computed exactly from the
    // image's real dimensions (via doc.openImage) rather than relying on pdfkit's
    // `fit` option and guessing how tall the result was.
    function drawImageFitted(src, x, y, maxW, maxH) {
      const img = doc.openImage(src);
      const scale = Math.min(maxW / img.width, maxH / img.height);
      const w = img.width * scale;
      const h = img.height * scale;
      doc.image(img, x, y, { width: w, height: h });
      return h;
    }

    async function renderField(field, instanceAnswers, repeatIndex) {
      if (field.type === 'instruction') return;
      if (!isFieldVisible(field, instanceAnswers)) return; // never shown to the tech — leave it out of the record too
      const value = instanceAnswers[field.id];

      // Measure the label's actual height first — some labels in a template like this
      // run 150+ characters and wrap to 2-3 lines, so a fixed small reservation isn't
      // enough and was letting labels run into whatever content followed them.
      doc.fontSize(9).font('Helvetica-Bold');
      const labelHeight = doc.heightOfString(field.label, { width: pageWidth });
      ensureSpace(labelHeight + 4);
      doc.fillColor('#333').text(field.label, left, doc.y, { width: pageWidth });

      if (field.type === 'photo') {
        const fps = photosFor(field.id, repeatIndex);
        if (fps.length === 0) {
          doc.fontSize(9).font('Helvetica').fillColor(MUTED).text('No photo attached');
        } else {
          for (const p of fps) {
            const maxW = Math.min(pageWidth, 260);
            const maxH = 170;
            ensureSpace(maxH + 20);
            try {
              const resizedBuffer = await loadResizedPhoto(path.join(uploadDir, p.stored_name));
              // The cursor position is captured BEFORE drawing and set explicitly
              // afterward (not read back from doc.y) — some real-world photos were
              // found to make pdfkit silently move the cursor during doc.image()
              // itself, which caused content to overlap on a single page previously.
              const startY = doc.y;
              const actualHeight = drawImageFitted(resizedBuffer, left, startY, maxW, maxH);
              doc.y = startY + actualHeight;
              doc.moveDown(0.4);
            } catch (e) {
              doc.fontSize(9).fillColor('#a23a1c').text('(could not load image)');
            }
          }
        }
      } else if (field.type === 'signature') {
        if (value) {
          try {
            const base64 = value.replace(/^data:image\/\w+;base64,/, '');
            const buf = Buffer.from(base64, 'base64');
            const maxW = 200, maxH = 80;
            ensureSpace(maxH + 20);
            const startY = doc.y;
            const actualHeight = drawImageFitted(buf, left, startY, maxW, maxH);
            doc.y = startY + actualHeight;
            doc.moveDown(0.2);
          } catch (e) {
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
      }
      doc.moveDown(0.5);
    }

    (async () => {
      for (const section of template.sections) {
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
          for (let idx = 0; idx < instances.length; idx++) {
            const instanceAnswers = instances[idx];
            const instanceLabel = `${section.title} #${idx + 1}`;
            doc.fontSize(10).font('Helvetica-Bold');
            const instanceLabelHeight = doc.heightOfString(instanceLabel, { width: pageWidth });
            ensureSpace(instanceLabelHeight + 6);
            doc.fillColor('#333').text(instanceLabel, left, doc.y, { width: pageWidth });
            doc.moveDown(0.3);
            for (const field of section.fields) {
              await renderField(field, instanceAnswers, idx);
            }
            doc.moveDown(0.3);
          }
        } else {
          const instanceAnswers = answers[section.id] || {};
          for (const field of section.fields) {
            await renderField(field, instanceAnswers, undefined);
          }
        }
      }

      doc.end();
    })().catch(reject);
  });
}

module.exports = { buildProjectEntryPdf };

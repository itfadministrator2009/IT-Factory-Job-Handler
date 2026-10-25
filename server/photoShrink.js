// Shrinks photos so they don't fill the server disk. Phone photos (3–6 MB,
// 4000+ px) are resized to fit 1600 px and re-saved as a normal-quality JPEG
// (about 200–400 KB), which still looks sharp on screen and on the PDFs.
//
// Used two ways: every new upload is shrunk as it arrives, and an admin can
// shrink the photos already stored (Settings → Disk usage). A photo is only
// replaced when the new file is clearly smaller; anything that can't be read
// as an image is left exactly as it was.
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { db } = require('./db');

sharp.cache(false);     // small server: don't hold decoded images in memory
sharp.concurrency(1);

const MAX_SIDE = 1600;
const JPEG_QUALITY = 80;
const MIN_BYTES = 500 * 1024; // smaller files are left alone (already small, or already shrunk)

// Same folder the upload routes use.
const fileStore = require('./fileStore');
const UPLOAD_DIR = fileStore.UPLOAD_DIR;

const PHOTO_EXT = ['.jpg', '.jpeg', '.png', '.heic', '.heif', '.webp', '.tif', '.tiff'];
function isPhoto(mime, name) {
  const m = String(mime || '').toLowerCase();
  if (m.startsWith('image/') && !m.includes('svg') && !m.includes('gif')) return true;
  return PHOTO_EXT.includes(path.extname(String(name || '')).toLowerCase());
}

const statSize = (p) => { try { return fs.statSync(p).size; } catch (e) { return 0; } };

// Shrinks one file in place (or, for a HEIC/TIFF photo, replaces it with a .jpg
// next to it). Returns what changed, or null when the file was left as it was.
async function shrinkFile(filePath, { mime, force = false } = {}) {
  const before = statSize(filePath);
  if (!before) return null;
  if (!force && before < MIN_BYTES) return null;

  let meta;
  try { meta = await sharp(filePath, { failOn: 'none' }).metadata(); } catch (e) { return null; } // not an image sharp can read
  const fmt = meta.format;
  // PNGs (screenshots, diagrams) stay PNG; everything else becomes JPEG.
  const keepPng = fmt === 'png';
  const toJpeg = !keepPng;
  const ext = path.extname(filePath).toLowerCase();
  const renames = toJpeg && !['.jpg', '.jpeg'].includes(ext);

  const tmp = `${filePath}.shrinking`;
  try {
    let img = sharp(filePath, { failOn: 'none' })
      .rotate() // apply the phone's orientation before the EXIF data is dropped
      .resize({ width: MAX_SIDE, height: MAX_SIDE, fit: 'inside', withoutEnlargement: true });
    img = keepPng ? img.png({ compressionLevel: 9, palette: false }) : img.flatten({ background: '#ffffff' }).jpeg({ quality: JPEG_QUALITY, mozjpeg: true });
    await img.toFile(tmp);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (x) { /* none */ }
    return null;
  }

  const after = statSize(tmp);
  // Not worth it (already a small, well-compressed image) — keep the original,
  // unless it's a HEIC/TIFF that browsers can't show anyway.
  if (!renames && (!after || after > before * 0.9)) {
    try { fs.unlinkSync(tmp); } catch (x) { /* none */ }
    return null;
  }

  const newPath = renames ? filePath.slice(0, filePath.length - ext.length) + '.jpg' : filePath;
  fs.renameSync(tmp, newPath);
  if (renames && newPath !== filePath) { try { fs.unlinkSync(filePath); } catch (x) { /* gone */ } }
  return {
    before,
    after,
    newName: path.basename(newPath),
    newMime: toJpeg ? 'image/jpeg' : (mime || 'image/png'),
    renamed: renames,
  };
}

const jpgName = (name) => String(name || '').replace(/\.(heic|heif|tiff?|webp|png)$/i, '') + '.jpg';

// For a multer file that has just been saved: shrinks it if it's a photo and
// returns the details to store (filename, mimetype, size, originalname).
async function shrinkUpload(file) {
  const out = { filename: file.filename, mimetype: file.mimetype, size: file.size, originalname: file.originalname };
  if (!isPhoto(file.mimetype, file.originalname)) return out;
  try {
    const r = await shrinkFile(file.path, { mime: file.mimetype });
    if (!r) return out;
    return {
      filename: r.newName,
      mimetype: r.newMime,
      size: r.after,
      originalname: r.renamed ? jpgName(file.originalname) : file.originalname,
    };
  } catch (e) {
    console.error('[photos] could not shrink upload:', e.message);
    return out;
  }
}

// ---------------------------------------------------------------------------
// Shrinking the photos already stored — runs in the background, one photo at a
// time, and can be checked on while it runs.
// ---------------------------------------------------------------------------
let job = null; // { running, total, done, shrunk, skipped, failed, before, after, startedAt, finishedAt }

function photoRows() {
  const rows = [];
  try {
    db.prepare('SELECT id, stored_name, original_name, mime_type FROM attachments').all()
      .forEach((r) => rows.push({ table: 'attachments', ...r }));
  } catch (e) { /* none */ }
  try {
    db.prepare('SELECT id, stored_name, original_name, mime_type FROM project_entry_photos').all()
      .forEach((r) => rows.push({ table: 'project_entry_photos', ...r }));
  } catch (e) { /* none */ }
  return rows.filter((r) => isPhoto(r.mime_type, r.original_name || r.stored_name));
}

async function runShrinkExisting(uploadDir = UPLOAD_DIR) {
  const rows = photoRows();
  job.total = rows.length;
  for (const r of rows) {
    let filePath = path.join(uploadDir, r.stored_name);
    try {
      // Moved to Cloudflare R2: bring it back only if it's big enough to be worth shrinking.
      if (!fs.existsSync(filePath)) {
        const cloudSize = fileStore.cloudSize(r.stored_name);
        filePath = cloudSize != null && cloudSize >= MIN_BYTES ? await fileStore.fetchLocal(r.stored_name, uploadDir) : null;
      }
      const res = filePath ? await shrinkFile(filePath, { mime: r.mime_type }) : null;
      if (res) {
        job.shrunk += 1; job.before += res.before; job.after += res.after;
        if (r.table === 'attachments') {
          db.prepare('UPDATE attachments SET stored_name = ?, mime_type = ?, size = ?, original_name = ? WHERE id = ?')
            .run(res.newName, res.newMime, res.after, res.renamed ? jpgName(r.original_name) : r.original_name, r.id);
        } else {
          db.prepare('UPDATE project_entry_photos SET stored_name = ?, mime_type = ?, original_name = ? WHERE id = ?')
            .run(res.newName, res.newMime, res.renamed ? jpgName(r.original_name) : r.original_name, r.id);
        }
        // Keep Cloudflare R2 in step with the smaller file.
        if (res.newName !== r.stored_name) { fileStore.remove(r.stored_name, uploadDir); fileStore.offloadSoon(res.newName, { dir: uploadDir, contentType: res.newMime }); } else fileStore.changed(res.newName, { dir: uploadDir, contentType: res.newMime });
      } else {
        job.skipped += 1;
      }
    } catch (e) {
      job.failed += 1;
      console.error('[photos] could not shrink', r.stored_name, e.message);
    }
    job.done += 1;
    await new Promise((resolve) => setImmediate(resolve)); // keep the app responsive
  }
}

function startShrinkExisting(uploadDir) {
  if (job && job.running) return job;
  job = { running: true, total: 0, done: 0, shrunk: 0, skipped: 0, failed: 0, before: 0, after: 0, startedAt: new Date().toISOString(), finishedAt: null };
  const current = job;
  current.promise = runShrinkExisting(uploadDir)
    .catch((e) => { current.error = e.message; console.error('[photos] shrink failed:', e); })
    .finally(() => { current.running = false; current.finishedAt = new Date().toISOString(); console.log(`[photos] shrank ${current.shrunk} photo(s), ${current.before} → ${current.after} bytes`); });
  return current;
}

function shrinkStatus() {
  if (!job) return { running: false, total: 0, done: 0 };
  const { promise, ...rest } = job;
  return rest;
}

module.exports = { shrinkFile, shrinkUpload, startShrinkExisting, shrinkStatus, isPhoto, MAX_SIDE };

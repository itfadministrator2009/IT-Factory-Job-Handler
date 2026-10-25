// Where uploaded files (job attachments and project photos) are kept.
//
// Without Cloudflare R2 set up, everything stays in the upload folder on the
// server disk, exactly as before.
//
// With R2 set up (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and
// R2_BUCKET on Render), R2 becomes the main home for every file:
//  - a new upload is saved to the disk first, then copied to R2 straight away;
//  - files already on the disk are copied across in the background;
//  - a file is only removed from the disk once R2 has it at the same size,
//    and only after it has been there an hour (recent files open fastest);
//  - when a file isn't on the disk, Work Desk reads it from R2.
// The bucket stays private: every file is still sent through Work Desk, which
// checks who is asking before anything is shown.
const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');
const { db } = require('./db');

const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads'));
const KEEP_LOCAL_MS = 60 * 60 * 1000;
const SYNC_EVERY_MS = 10 * 60 * 1000;

db.exec(`CREATE TABLE IF NOT EXISTS cloud_files (
  name TEXT PRIMARY KEY,
  size INTEGER NOT NULL,
  stored_at TEXT NOT NULL DEFAULT (datetime('now'))
)`);

const env = () => ({
  account: process.env.R2_ACCOUNT_ID, key: process.env.R2_ACCESS_KEY_ID,
  secret: process.env.R2_SECRET_ACCESS_KEY, bucket: process.env.R2_BUCKET,
});
let testBackend = null;
function enabled() {
  if (testBackend) return true;
  const e = env();
  return !!(e.account && e.key && e.secret && e.bucket);
}

// R2_ACCOUNT_ID is the 32-character Account ID. Also accept it pasted as the
// whole S3 endpoint ("https://<id>.r2.cloudflarestorage.com/…"), with spaces.
function accountId(value) {
  let v = String(value || '').trim().replace(/^https?:\/\//i, '');
  v = v.split('/')[0].replace(/\.(eu\.|fedramp\.)?r2\.cloudflarestorage\.com$/i, '');
  return v.trim();
}
const looksLikeAccountId = (v) => /^[0-9a-f]{32}$/i.test(v);

// Plain-English pointers for the usual setup mistakes.
function hintFor(message) {
  const m = String(message || '');
  if (/R2_ACCOUNT_ID/.test(m)) return '';
  if (/handshake|EPROTO|ENOTFOUND|getaddrinfo|certificate|ECONNREFUSED/i.test(m)) {
    return ' — this usually means R2_ACCOUNT_ID on Render is wrong. It must be the 32-character Account ID from Cloudflare (R2 Object Storage → Account Details), not the Access Key ID.';
  }
  if (/InvalidAccessKeyId|SignatureDoesNotMatch|Unauthorized|AccessDenied|403/i.test(m)) {
    return ' — check R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY on Render, and that the API token can read and write this bucket.';
  }
  if (/NoSuchBucket/i.test(m)) return ' — check R2_BUCKET on Render matches the bucket name in Cloudflare exactly.';
  return '';
}

// The R2 connection (Cloudflare R2 speaks the Amazon S3 language).
let r2 = null;
function backend() {
  if (testBackend) return testBackend;
  if (!enabled()) return null;
  const e = env();
  const sig = `${e.account}|${e.key}|${e.bucket}`;
  if (r2 && r2.sig === sig) return r2;
  const acct = accountId(e.account);
  if (!process.env.R2_ENDPOINT && !looksLikeAccountId(acct)) {
    throw new Error('R2_ACCOUNT_ID on Render doesn\'t look like a Cloudflare Account ID. It should be 32 letters (a–f) and numbers, found in Cloudflare under R2 Object Storage → Account Details');
  }
  const { S3Client, PutObjectCommand, HeadObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
  const client = new S3Client({
    region: 'auto',
    // R2_ENDPOINT is only needed for an EU-jurisdiction bucket (…eu.r2.cloudflarestorage.com).
    endpoint: process.env.R2_ENDPOINT || `https://${acct}.r2.cloudflarestorage.com`,
    forcePathStyle: true,
    // The newer default checksums aren't fully supported by R2 (Cloudflare's advice).
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    credentials: { accessKeyId: e.key.trim(), secretAccessKey: e.secret.trim() },
  });
  const Bucket = e.bucket.trim();
  const missing = (err) => err?.$metadata?.httpStatusCode === 404 || err?.name === 'NotFound' || err?.name === 'NoSuchKey';
  r2 = {
    sig,
    async put(name, filePath, size, contentType) {
      await client.send(new PutObjectCommand({ Bucket, Key: name, Body: fs.createReadStream(filePath), ContentLength: size, ContentType: contentType || 'application/octet-stream' }));
    },
    async head(name) {
      try { const r = await client.send(new HeadObjectCommand({ Bucket, Key: name })); return { size: Number(r.ContentLength) }; } catch (err) { if (missing(err)) return null; throw err; }
    },
    async get(name) {
      try {
        const r = await client.send(new GetObjectCommand({ Bucket, Key: name }));
        return { stream: r.Body, size: Number(r.ContentLength), contentType: r.ContentType };
      } catch (err) { if (missing(err)) return null; throw err; }
    },
    async del(name) { await client.send(new DeleteObjectCommand({ Bucket, Key: name })); },
  };
  return r2;
}

// Stored names are generated by Work Desk (uuid + extension); refuse anything else.
const safe = (name) => typeof name === 'string' && name.length > 0 && name === path.basename(name) && !name.startsWith('.');
const localPath = (name, dir = UPLOAD_DIR) => path.join(dir, name);
const statSize = (p) => { try { return fs.statSync(p).size; } catch (e) { return -1; } };
const cloudRow = (name) => db.prepare('SELECT size FROM cloud_files WHERE name = ?').get(name);
const remember = (name, size) => db.prepare(`INSERT INTO cloud_files (name, size) VALUES (?, ?)
  ON CONFLICT(name) DO UPDATE SET size = excluded.size, stored_at = datetime('now')`).run(name, size);

const state = { lastSyncAt: null, lastError: null, moved: 0, syncing: false, removedLocal: 0 };
function noteError(err, what) {
  state.lastError = { at: new Date().toISOString(), message: `${what}: ${err.message || err}${hintFor(err.message || err)}` };
  console.error(`[files] ${what}:`, err.message || err);
  try {
    require('./alerts').sendAlert('cloud-files', 'Could not reach Cloudflare R2',
      `${what}: ${err.message || err}${hintFor(err.message || err)}\n\nFiles are kept safely on the server disk until R2 works again. Check the R2_* settings on Render.`).catch(() => {});
  } catch (e) { /* alert is optional */ }
}

// Copies one file from the disk to R2 and checks R2 has all of it.
async function offload(name, { dir = UPLOAD_DIR, contentType } = {}) {
  if (!enabled() || !safe(name)) return false;
  const p = localPath(name, dir);
  const size = statSize(p);
  if (size < 0) return false;
  const row = cloudRow(name);
  if (row && row.size === size) return true;
  const b = backend();
  await b.put(name, p, size, contentType);
  const check = await b.head(name);
  if (!check || check.size !== size) throw new Error(`R2 has ${check ? check.size : 'no'} bytes of ${name}, expected ${size}`);
  remember(name, size);
  state.moved += 1;
  return true;
}

// A new upload: copy it to R2 now, without making the person wait.
function offloadSoon(name, opts) {
  if (!enabled()) return;
  offload(name, opts).catch((err) => noteError(err, `Copying ${name} to R2`));
}

// Is the file anywhere we can read it from? (Used where a quick yes/no is needed.)
function hasFile(name, dir = UPLOAD_DIR) {
  if (!safe(name)) return false;
  return fs.existsSync(localPath(name, dir)) || (enabled() && !!cloudRow(name));
}

async function fromCloud(name) {
  if (!enabled() || !safe(name)) return null;
  const obj = await backend().get(name);
  if (obj && !cloudRow(name)) remember(name, obj.size); // R2 had it all along
  return obj;
}

async function streamToBuffer(stream) {
  if (stream && typeof stream.transformToByteArray === 'function') return Buffer.from(await stream.transformToByteArray());
  const chunks = [];
  for await (const c of stream) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return Buffer.concat(chunks);
}

// The whole file in memory (for building PDFs), or null if it can't be found.
async function readBuffer(name, dir = UPLOAD_DIR) {
  if (!safe(name)) return null;
  const p = localPath(name, dir);
  if (fs.existsSync(p)) return fs.promises.readFile(p);
  const obj = await fromCloud(name);
  return obj ? streamToBuffer(obj.stream) : null;
}

// Makes sure the file is on the disk (fetching it back from R2 if needed) and
// returns its path, or null. The local copy is tidied away again later.
async function fetchLocal(name, dir = UPLOAD_DIR) {
  if (!safe(name)) return null;
  const p = localPath(name, dir);
  if (fs.existsSync(p)) return p;
  const obj = await fromCloud(name);
  if (!obj) return null;
  const tmp = `${p}.downloading`;
  try {
    await pipeline(obj.stream, fs.createWriteStream(tmp));
    fs.renameSync(tmp, p);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch (e) { /* none */ }
    throw err;
  }
  return p;
}

// Sends a file to the browser: from the disk when it's there, otherwise from R2.
async function send(res, name, { dir = UPLOAD_DIR, downloadName, contentType } = {}) {
  const p = safe(name) ? localPath(name, dir) : null;
  if (p && fs.existsSync(p)) {
    if (downloadName) return res.download(p, downloadName);
    return res.sendFile(p);
  }
  let obj = null;
  try { obj = await fromCloud(name); } catch (err) {
    noteError(err, `Reading ${name} from R2`);
    return res.status(502).json({ error: 'Could not load the file from storage — please try again.' });
  }
  if (!obj) return res.status(404).json({ error: 'File missing' });
  res.setHeader('Content-Type', contentType || obj.contentType || 'application/octet-stream');
  if (obj.size >= 0) res.setHeader('Content-Length', String(obj.size));
  res.setHeader('Cache-Control', 'private, max-age=3600');
  if (downloadName) res.attachment(downloadName);
  try { await pipeline(obj.stream, res); } catch (err) { if (!res.headersSent) res.status(502).end(); else res.destroy(err); }
  return undefined;
}

// Deletes a file everywhere (the record that used it has been deleted).
function remove(name, dir = UPLOAD_DIR) {
  if (!safe(name)) return;
  fs.unlink(localPath(name, dir), () => {});
  if (enabled()) {
    db.prepare('DELETE FROM cloud_files WHERE name = ?').run(name);
    Promise.resolve().then(() => backend().del(name)).catch((err) => console.error('[files] Could not delete', name, 'from R2:', err.message));
  }
}

// The file changed on the disk under the same name (a photo was shrunk): copy it again.
function changed(name, opts) {
  db.prepare('DELETE FROM cloud_files WHERE name = ?').run(name);
  offloadSoon(name, opts);
}

// Every file name a record in Work Desk points at.
function referencedFiles() {
  const rows = [];
  try { rows.push(...db.prepare('SELECT stored_name AS name, mime_type AS mime FROM attachments').all()); } catch (e) { /* none */ }
  try { rows.push(...db.prepare('SELECT stored_name AS name, mime_type AS mime FROM project_entry_photos').all()); } catch (e) { /* none */ }
  return rows.filter((r) => safe(r.name));
}

// Removes disk copies that R2 holds in full and that are over an hour old.
function sweepLocal({ dir = UPLOAD_DIR, olderThanMs = KEEP_LOCAL_MS, now = Date.now() } = {}) {
  if (!enabled()) return 0;
  let removed = 0;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return 0; }
  for (const e of entries) {
    if (!e.isFile() || !safe(e.name)) continue;
    const row = cloudRow(e.name);
    if (!row) continue;
    const p = localPath(e.name, dir);
    let st;
    try { st = fs.statSync(p); } catch (x) { continue; }
    if (st.size !== row.size || now - st.mtimeMs < olderThanMs) continue;
    try { fs.unlinkSync(p); removed += 1; } catch (x) { /* in use — next time */ }
  }
  state.removedLocal += removed;
  return removed;
}

// Copies every file still only on the disk to R2, then tidies the disk.
async function syncAll({ dir = UPLOAD_DIR, olderThanMs } = {}) {
  if (!enabled() || state.syncing) return { skipped: true };
  state.syncing = true;
  let copied = 0; let failed = 0;
  try {
    for (const r of referencedFiles()) {
      const p = localPath(r.name, dir);
      if (!fs.existsSync(p)) continue;
      const row = cloudRow(r.name);
      if (row && row.size === statSize(p)) continue;
      try { await offload(r.name, { dir, contentType: r.mime }); copied += 1; } catch (err) {
        failed += 1;
        noteError(err, `Copying ${r.name} to R2`);
        if (failed >= 3) break; // R2 unreachable or keys wrong — try again next round
      }
    }
    const removed = sweepLocal({ dir, olderThanMs });
    state.lastSyncAt = new Date().toISOString();
    if (!failed) state.lastError = null;
    if (copied) {
      try { require('./activity').logActivity('files.moved', { details: `Copied ${copied} file${copied === 1 ? '' : 's'} to Cloudflare R2${removed ? `; freed ${removed} from the server disk` : ''}` }); } catch (e) { /* optional */ }
    }
    return { copied, failed, removed };
  } finally { state.syncing = false; }
}

function status(dir = UPLOAD_DIR) {
  const on = enabled();
  const out = { enabled: on, bucket: on ? (env().bucket || 'test') : null, ...state };
  if (!on) return out;
  const t = db.prepare('SELECT COUNT(*) AS files, COALESCE(SUM(size), 0) AS bytes FROM cloud_files').get();
  out.files = t.files; out.bytes = t.bytes;
  out.waiting = referencedFiles().filter((r) => fs.existsSync(localPath(r.name, dir)) && !cloudRow(r.name)).length;
  return out;
}

let timer = null;
function startFileSync() {
  if (!enabled()) { console.log('[files] Cloudflare R2 is not set up — uploads stay on the server disk.'); return; }
  console.log(`[files] Cloudflare R2 is set up (bucket ${env().bucket}) — copying uploads there.`);
  const run = () => syncAll().catch((err) => noteError(err, 'Copying files to R2'));
  setTimeout(run, 30 * 1000).unref?.();
  timer = setInterval(run, SYNC_EVERY_MS);
  timer.unref?.();
}

function _setBackend(b) { testBackend = b; r2 = null; }

module.exports = {
  UPLOAD_DIR, enabled, accountId, hintFor, offload, offloadSoon, hasFile, readBuffer, fetchLocal, send, remove, changed,
  syncAll, sweepLocal, status, startFileSync, _setBackend,
  cloudSize: (name) => (safe(name) ? cloudRow(name)?.size ?? null : null),
  cloudNames: () => db.prepare('SELECT name FROM cloud_files').all().map((r) => r.name),
  getCloud: (name) => fromCloud(name),
};

// Left-over uploaded files: photos and attachments that no job or project uses
// any more (for example left behind when a job was deleted). Found on the Render
// disk and in Cloudflare R2, and removed only when the Super Admin asks.
//
// Kept safe:
//  - only files with Work Desk's own upload names (a uuid, e.g. 3f2a…-….jpg);
//  - anything a record restore could still bring back is kept;
//  - files less than a day old are kept (an upload may still be finishing).
const fs = require('fs');
const path = require('path');
const { db } = require('./db');
const fileStore = require('./fileStore');

const DAY = 24 * 60 * 60 * 1000;
const UPLOAD_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\.[A-Za-z0-9]{1,8})?$/i;

function inUse() {
  const names = new Set();
  for (const table of ['attachments', 'project_entry_photos']) {
    try { db.prepare(`SELECT stored_name FROM ${table}`).all().forEach((r) => names.add(r.stored_name)); } catch (e) { /* table missing */ }
  }
  let restorable = '';
  try {
    restorable = db.prepare("SELECT COALESCE(before_json, '') || ' ' || COALESCE(after_json, '') AS t FROM record_restore_log").all().map((r) => r.t).join('\n');
  } catch (e) { /* no restore log */ }
  return (name) => names.has(name) || (restorable && restorable.includes(name));
}

function findLeftovers({ dirs = [fileStore.UPLOAD_DIR], olderThanMs = DAY, now = Date.now() } = {}) {
  const used = inUse();
  const found = [];
  for (const dir of [...new Set(dirs.map((d) => path.resolve(d)))]) {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { continue; }
    for (const e of entries) {
      if (!e.isFile() || !UPLOAD_NAME.test(e.name) || used(e.name)) continue;
      let st;
      try { st = fs.statSync(path.join(dir, e.name)); } catch (x) { continue; }
      if (now - st.mtimeMs < olderThanMs) continue;
      found.push({ where: 'render', dir, name: e.name, bytes: st.size });
    }
  }
  if (fileStore.enabled()) {
    const onDisk = new Set(found.map((f) => f.name));
    for (const r of db.prepare('SELECT name, size, stored_at FROM cloud_files').all()) {
      if (!UPLOAD_NAME.test(r.name) || used(r.name) || onDisk.has(r.name)) continue;
      const at = Date.parse(`${String(r.stored_at).replace(' ', 'T')}Z`);
      if (Number.isFinite(at) && now - at < olderThanMs) continue;
      found.push({ where: 'cloud', name: r.name, bytes: r.size });
    }
  }
  return found;
}

function summary(opts) {
  const list = findLeftovers(opts);
  return { files: list.length, bytes: list.reduce((t, f) => t + f.bytes, 0) };
}

function removeLeftovers(opts, who) {
  const list = findLeftovers(opts);
  let removed = 0; let bytes = 0;
  for (const f of list) {
    if (f.where === 'render') {
      try { fs.unlinkSync(path.join(f.dir, f.name)); } catch (e) { continue; }
      if (fileStore.enabled()) fileStore.remove(f.name, f.dir); // its R2 copy too, if any
    } else {
      fileStore.remove(f.name);
    }
    removed += 1; bytes += f.bytes;
  }
  if (removed) {
    try {
      require('./activity').logActivity('files.leftovers_removed', { who, details: `Removed ${removed} left-over file${removed === 1 ? '' : 's'} (${(bytes / 1024 ** 2).toFixed(1)} MB) that no job or project used` });
    } catch (e) { /* log only */ }
  }
  return { removed, bytes };
}

module.exports = { findLeftovers, summary, removeLeftovers, UPLOAD_NAME };

// Minimal zip reader (stored + deflate entries) using Node's built-in zlib, so
// the Storage Centre restore can open the backup zips without another package.
// Reads the central directory, which is where sizes are reliable.
const zlib = require('zlib');

function readZip(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  // End of central directory record: signature 0x06054b50, within the last 64KB + 22 bytes.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a zip file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = {};
  for (let n = 0; n < count; n += 1) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Damaged zip file');
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    if (buf.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('Damaged zip file');
    const dataStart = localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28);
    const data = buf.subarray(dataStart, dataStart + compSize);
    if (method === 0) files[name] = Buffer.from(data);
    else if (method === 8) files[name] = zlib.inflateRawSync(data);
    else throw new Error(`Unsupported compression in ${name}`);
  }
  return files;
}

// RFC 4180 CSV (quoted fields, "" escapes, embedded commas/newlines), BOM stripped.
function parseCsv(text) {
  const t = String(text).replace(/^﻿/, '');
  const rows = []; let row = []; let field = ''; let quoted = false;
  for (let i = 0; i < t.length; i += 1) {
    const c = t[i];
    if (quoted) {
      if (c === '"' && t[i + 1] === '"') { field += '"'; i += 1; } else if (c === '"') quoted = false; else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; } else if (c === '\n' || c === '\r') {
      if (c === '\r' && t[i + 1] === '\n') i += 1;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  const [header = [], ...data] = rows.filter((r) => r.some((v) => v !== ''));
  return data.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}

module.exports = { readZip, parseCsv };

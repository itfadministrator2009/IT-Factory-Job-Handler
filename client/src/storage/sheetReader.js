// Reads the first sheet of an .xlsx or a .csv into a header row + data rows.
// Shared by Import stock and Match & update.

// Excel stores dates as day numbers; the reader turns them into Dates at UTC
// midnight, so the calendar date is read from the UTC parts.
export const utcYmd = (d) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;

// Plain CSV (quoted fields, "" escapes, commas/newlines inside quotes). Values
// stay as typed text, so "3/8/2026" reaches the server as day/month.
export function parseCsv(text) {
  const rows = []; let row = []; let field = ''; let quoted = false;
  const t = text.replace(/^\ufeff/, '');
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
  return rows;
}

const sheetKey = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// preferSheet: for a whole workbook, read the tab with that name if it has one
// (e.g. "LocationsRegistry"); otherwise the first tab.
async function readFileRows(file, preferSheet) {
  if (/\.csv$/i.test(file.name)) return { sheet: file.name, rows: parseCsv(await file.text()) };
  if (!/\.xlsx$/i.test(file.name)) throw new Error('Use an .xlsx or .csv file (old .xls files: open in Excel and Save As .xlsx).');
  if (preferSheet) {
    const mod = await import('read-excel-file/browser');
    const sheets = await mod.default(file);
    const hit = sheets.find((s) => sheetKey(s.sheet) === sheetKey(preferSheet));
    const use = hit || sheets[0];
    return { sheet: use.sheet, rows: use.data };
  }
  const { readSheet } = await import('read-excel-file/browser');
  return { sheet: 'first sheet', rows: await readSheet(file) };
}

export async function readSpreadsheet(file, preferSheet) {
  const { sheet, rows: all } = await readFileRows(file, preferSheet);
  const rows = all.filter((r) => r.some((v) => String(v ?? '').trim() !== ''));
  return { sheet, headers: (rows[0] || []).map((h) => String(h ?? '').trim()), data: rows.slice(1) };
}

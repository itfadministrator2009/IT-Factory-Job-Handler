// Formats a "YYYY-MM-DD" date string as "DD/MM/YYYY" for display.
// Deliberately does simple string splitting rather than parsing into a Date object —
// a Date-based conversion of a bare date (no time) can shift by a day depending on
// the browser's local timezone, which a plain split avoids entirely.
export function formatDMY(s) {
  if (!s) return '';
  const [year, month, day] = s.split('-');
  if (!year || !month || !day) return s;
  return `${day}/${month}/${year}`;
}

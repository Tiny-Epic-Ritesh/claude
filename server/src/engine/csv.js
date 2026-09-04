/**
 * One CSV writer, for every export in the product.
 *
 * There were four copies of the escape function before this, one per export
 * route, and they had already begun to differ. That matters more than it
 * sounds: a comma or a quote in a client's name is the difference between a
 * file that opens in Excel and a file that opens shifted by one column, and the
 * person who spots it is the person who was given the file.
 *
 * Also here because P3-01, P3-22, P3-23, P3-24 and P3-25 add four more exports.
 * Four more copies would have been the point at which they stopped agreeing.
 */

/**
 * Escape one value for CSV.
 *
 * A leading `=`, `+`, `-` or `@` is prefixed with a quote. Those characters make
 * Excel and Sheets treat the cell as a formula, so a name like `=cmd|...` in an
 * exported record becomes something the spreadsheet tries to run when a
 * colleague opens it. That is a real attack on the person we hand the file to,
 * and it costs one character to close.
 */
export function escapeCell(value) {
  if (value === null || value === undefined) return '';

  let s = String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Rows to CSV text.
 *
 * `columns` may be a list of keys, or of `{ key, label }` where the file should
 * read differently from the database. Omitted, it takes the keys of the first
 * row — fine for a uniform result set and wrong for a ragged one, which is why
 * it is worth passing.
 */
export function toCsv(rows = [], columns = null) {
  const cols = (columns ?? Object.keys(rows[0] ?? {})).map(
    (c) => (typeof c === 'string' ? { key: c, label: c } : c),
  );
  if (!cols.length) return '';

  return [
    cols.map((c) => escapeCell(c.label ?? c.key)).join(','),
    ...rows.map((r) => cols.map((c) => escapeCell(r[c.key])).join(',')),
  ].join('\n');
}

/**
 * Send rows as a downloadable file.
 *
 * The BOM is deliberate: without it Excel on Windows reads the file as the
 * system codepage, and every rupee sign and every name with an accent in it
 * arrives mangled. Every reader that matters here is on Windows.
 */
export function sendCsv(res, filename, rows, columns = null) {
  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}-${stamp}.csv"`);
  return res.send(`﻿${toCsv(rows, columns)}`);
}

/**
 * Neutralise spreadsheet formula injection in a CSV cell.
 *
 * Excel, LibreOffice and Google Sheets evaluate a cell whose text starts with
 * `=`, `+`, `-` or `@` (or a tab / carriage return ahead of one) as a formula,
 * and quoting the field in the CSV does not stop them. Waypoint names and notes
 * come from files we did not write, so a waypoint called `=HYPERLINK(...)` would
 * run when the datasheet is opened. Prefixing a `'` makes the cell plain text.
 *
 * Only strings are touched: numeric cells (a negative elevation) stay numbers.
 */
export function csvSafeCell<T>(value: T): T | string {
  if (typeof value !== 'string') return value;
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

/** `csvSafeCell` over every cell of a table. */
export function csvSafeRows<T>(rows: T[][]): (T | string)[][] {
  return rows.map(row => row.map(csvSafeCell));
}

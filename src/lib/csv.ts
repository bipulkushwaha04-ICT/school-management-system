/**
 * Escapes one CSV cell. Text that a spreadsheet would run as a formula
 * (=, +, -, @, tab, CR at the start) is prefixed with ' so exported data
 * can't execute in Excel or Google Sheets. Plain numbers are left alone.
 */
export function csvCell(value: unknown): string {
  let text =
    value == null ? "" : value instanceof Date ? value.toISOString() : String(value);
  if (/^[=+\-@\t\r]/.test(text) && !/^[-+]?\d+(\.\d+)?$/.test(text)) {
    text = `'${text}`;
  }
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(header: unknown[], rows: unknown[][], eol = "\r\n"): string {
  return [header, ...rows].map((row) => row.map(csvCell).join(",")).join(eol);
}

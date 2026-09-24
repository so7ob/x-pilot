/**
 * Minimal RFC 4180 CSV writer (pure, no chrome APIs).
 *
 * - Fields containing commas, quotes, CR, or LF are double-quoted and inner
 *   quotes are doubled.
 * - Rows end with CRLF; sections are separated by one blank line.
 * - A UTF-8 BOM is emitted by default so spreadsheet apps (Excel) open
 *   Arabic/RTL content with correct encoding.
 */

export interface CsvSection {
  /** Optional section title row (single cell, emitted verbatim). */
  title?: string;
  /** Optional header row. */
  header?: string[];
  /** Data rows; undefined/null become empty fields. */
  rows?: (string | number | undefined | null)[][];
}

export function csvField(value: string | number | undefined | null): string {
  const text = value === undefined || value === null ? '' : String(value);
  if (/[",\r\n]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
  return text;
}

export function csvRow(fields: (string | number | undefined | null)[]): string {
  return fields.map(csvField).join(',');
}

export function buildCsv(sections: CsvSection[], { bom = true }: { bom?: boolean } = {}): string {
  const body = sections
    .map((section) => {
      const lines: string[] = [];
      if (section.title !== undefined) lines.push(csvRow([section.title]));
      if (section.header) lines.push(csvRow(section.header));
      for (const row of section.rows ?? []) lines.push(csvRow(row));
      return lines.join('\r\n');
    })
    .filter((block) => block.length > 0)
    .join('\r\n\r\n');
  return (bom ? '\uFEFF' : '') + body + '\r\n';
}

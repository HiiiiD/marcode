import type { Element } from 'hast';
import { hastText } from './hast-text';

/** `thead`/`tbody` → row → `th`/`td`, in document order, header row first. */
export function tableRows(table: Element): string[][] {
  const rows: string[][] = [];
  for (const section of table.children) {
    if (section.type !== 'element' || (section.tagName !== 'thead' && section.tagName !== 'tbody')) {
      continue;
    }
    for (const tr of section.children) {
      if (tr.type !== 'element' || tr.tagName !== 'tr') { continue; }
      rows.push(
        tr.children
          .filter((c): c is Element => c.type === 'element' && (c.tagName === 'th' || c.tagName === 'td'))
          .map((c) => hastText(c)),
      );
    }
  }
  return rows;
}

/**
 * A tab/newline in a cell would otherwise be indistinguishable from a
 * column/row break once pasted — collapsed to a space rather than escaped,
 * since TSV has no quoting convention spreadsheet apps agree on.
 */
export function toTsv(rows: string[][]): string {
  return rows.map((r) => r.map((c) => c.replace(/[\t\n]/g, ' ')).join('\t')).join('\n');
}

const CSV_NEEDS_QUOTING = /[",\r\n]/;

function csvCell(value: string): string {
  return CSV_NEEDS_QUOTING.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function toCsv(rows: string[][]): string {
  return rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
}

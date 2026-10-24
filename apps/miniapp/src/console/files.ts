/**
 * Files in and out of the console:
 *  - CSV export for Excel (UTF-8 BOM, ";" separator, CRLF), built in the browser from paged
 *    API responses so the Worker never formats tens of thousands of rows (10 ms CPU limit);
 *  - reading the old client base: .csv (UTF-8 or Windows-1251, ";" "," or tab) and .xlsx
 *    (a minimal reader: fflate unzips, DOMParser reads the first sheet; dates via cell styles).
 */
import type { unzipSync as UnzipSync } from 'fflate';

export const EXPORT_CAP = 50_000;

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  let s = String(v);
  // Formula injection guard: a cell starting with = + - @ is shown as text by Excel.
  // Numbers and phones ("+998901234567") are left as they are.
  if (/^[=+\-@]/.test(s) && !/^-?\d+([.,]\d+)?$/.test(s) && !/^\+\d{7,15}$/.test(s)) s = `'${s}`;
  return /[";\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function csvLine(cells: unknown[]): string {
  return cells.map(csvCell).join(';');
}

export function downloadCsv(fileName: string, header: string[], lines: string[]) {
  const blob = new Blob(['﻿', csvLine(header), '\r\n', lines.join('\r\n'), '\r\n'], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 1000);
}

// ------------------------------------------------------------------ CSV in

function decodeText(buf: ArrayBuffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf).replace(/^﻿/, '');
  } catch {
    return new TextDecoder('windows-1251').decode(buf); // old Russian Excel "CSV (разделители — точка с запятой)"
  }
}

export function parseCsv(text: string): string[][] {
  const firstLine = text.slice(0, text.search(/\r?\n/) >>> 0 || text.length);
  const counts = [';', ',', '\t'].map((d) => [d, firstLine.split(d).length] as const).sort((a, b) => b[1] - a[1]);
  const sep = counts[0]![1] > 1 ? counts[0]![0] : ';';
  const rows: string[][] = [];
  let row: string[] = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === sep) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

// ------------------------------------------------------------------ XLSX in

const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 30, 36, 45, 46, 47, 50, 57]);

function colIndex(ref: string): number {
  let n = 0;
  for (const ch of ref.replace(/\d+$/, '')) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

const xml = (s: string) => new DOMParser().parseFromString(s, 'application/xml');
const byTag = (doc: Document | Element, tag: string) => Array.from(doc.getElementsByTagNameNS('*', tag));

export async function parseXlsx(buf: ArrayBuffer): Promise<unknown[][]> {
  const { unzipSync, strFromU8 } = (await import('fflate')) as { unzipSync: typeof UnzipSync; strFromU8: (u: Uint8Array) => string };
  const files = unzipSync(new Uint8Array(buf), { filter: (f) => f.name.startsWith('xl/') && !f.name.startsWith('xl/media/') });
  const text = (name: string) => (files[name] ? strFromU8(files[name]!) : null);
  const wb = text('xl/workbook.xml');
  if (!wb) throw new Error('Это не файл Excel (.xlsx)');
  const firstSheet = byTag(xml(wb), 'sheet')[0];
  const rid = firstSheet?.getAttribute('r:id') ?? firstSheet?.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id');
  let sheetPath = 'xl/worksheets/sheet1.xml';
  const rels = text('xl/_rels/workbook.xml.rels');
  if (rels && rid) {
    const rel = byTag(xml(rels), 'Relationship').find((r) => r.getAttribute('Id') === rid);
    const target = rel?.getAttribute('Target');
    if (target) sheetPath = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
  }
  const sheet = text(sheetPath);
  if (!sheet) throw new Error('В файле не найден лист с данными');

  const shared = (() => {
    const s = text('xl/sharedStrings.xml');
    if (!s) return [] as string[];
    return byTag(xml(s), 'si').map((si) => byTag(si, 't').map((t) => t.textContent ?? '').join(''));
  })();

  // Which style indexes are dates: built-in date formats + custom formats containing d/m/y (not in quotes/brackets).
  const dateStyles = new Set<number>();
  const styles = text('xl/styles.xml');
  if (styles) {
    const doc = xml(styles);
    const custom = new Map<number, string>();
    for (const f of byTag(doc, 'numFmt')) custom.set(Number(f.getAttribute('numFmtId')), f.getAttribute('formatCode') ?? '');
    const cellXfs = byTag(doc, 'cellXfs')[0];
    if (cellXfs) {
      Array.from(cellXfs.children).forEach((xf, i) => {
        const id = Number(xf.getAttribute('numFmtId') ?? 0);
        const code = (custom.get(id) ?? '').replace(/"[^"]*"|\[[^\]]*\]/g, '');
        if (BUILTIN_DATE_FORMATS.has(id) || /[dy]|m{3,}/i.test(code) || /d.*m|m.*y/i.test(code)) dateStyles.add(i);
      });
    }
  }

  const out: unknown[][] = [];
  for (const r of byTag(xml(sheet), 'row')) {
    const rowIdx = Number(r.getAttribute('r') ?? out.length + 1) - 1;
    const row: unknown[] = [];
    let next = 0;
    for (const c of byTag(r, 'c')) {
      const ref = c.getAttribute('r');
      const col = ref ? colIndex(ref) : next;
      next = col + 1;
      const t = c.getAttribute('t');
      const v = byTag(c, 'v')[0]?.textContent ?? null;
      let val: unknown = null;
      if (t === 's') val = v === null ? null : shared[Number(v)] ?? '';
      else if (t === 'inlineStr') val = byTag(c, 't').map((x) => x.textContent ?? '').join('');
      else if (t === 'str' || t === 'e') val = v;
      else if (t === 'b') val = v === '1';
      else if (t === 'd') val = v ? new Date(v) : null;
      else if (v !== null) {
        const n = Number(v);
        const s = Number(c.getAttribute('s') ?? -1);
        val = dateStyles.has(s) && n > 0 && n < 80_000 ? new Date(Math.round((n - 25569) * 86_400_000)) : n;
      }
      row[col] = val;
    }
    out[rowIdx] = row;
  }
  for (let i = 0; i < out.length; i++) if (!out[i]) out[i] = [];
  return out;
}

/** Read an uploaded base: .xlsx or .csv/.txt. */
export async function readTable(file: File): Promise<unknown[][]> {
  const buf = await file.arrayBuffer();
  const isZip = new Uint8Array(buf.slice(0, 2)).join(',') === '80,75'; // "PK"
  if (/\.xlsx$/i.test(file.name) || isZip) return parseXlsx(buf);
  if (/\.xls$/i.test(file.name)) throw new Error('Старый формат .xls не поддерживается: в Excel выберите «Сохранить как» → «Книга Excel (.xlsx)» или CSV');
  return parseCsv(decodeText(buf));
}

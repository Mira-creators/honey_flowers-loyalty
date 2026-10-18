/**
 * CSV for Excel in ru/uz locales: ';' separator, CRLF line ends, UTF-8 with BOM
 * (otherwise Excel shows Cyrillic as mojibake), dates as 'YYYY-MM-DD HH:MM' Tashkent.
 */

export const CSV_BOM = '\uFEFF';
export const CSV_SEP = ';';

/** Quote a cell when it contains the separator, a quote, a line break or leading/trailing spaces. */
export function csvCell(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (/[";\r\n]/.test(s) || s !== s.trim()) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function csvLine(cells: ReadonlyArray<string | number | null | undefined>): string {
  return cells.map(csvCell).join(CSV_SEP) + '\r\n';
}

/** ISO instant → 'YYYY-MM-DD HH:MM' in Asia/Tashkent (UTC+5, no DST). '' for null / '' input. */
export function tashkentMinute(iso: string | null | undefined): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const d = new Date(t + 5 * 3_600_000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

/** A streamed text/csv response: the generator yields lines (already CSV-formatted); the BOM goes first. */
export function csvResponse(filename: string, lines: AsyncIterable<string>): Response {
  const enc = new TextEncoder();
  const it = lines[Symbol.asyncIterator]();
  let first = true;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await it.next();
        if (done) {
          if (first) controller.enqueue(enc.encode(CSV_BOM));
          controller.close();
          return;
        }
        controller.enqueue(enc.encode((first ? CSV_BOM : '') + value));
        first = false;
      } catch (e) {
        controller.error(e);
      }
    },
    cancel() {
      void it.return?.();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${filename.replace(/[^\w.-]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      'cache-control': 'no-store',
    },
  });
}

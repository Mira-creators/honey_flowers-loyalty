// Strict RFC 4180 parser (separator ';', CRLF), used to verify the CSV exports byte by byte.
export function parseCsv(text, sep = ';') {
  const rows = [];
  let row = [];
  let cell = '';
  let i = 0;
  let quoted = false;
  const errors = [];
  while (i < text.length) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i += 2; continue; }
        quoted = false; i++;
        if (i < text.length && text[i] !== sep && text[i] !== '\r') errors.push(`char after closing quote at ${i}`);
        continue;
      }
      cell += ch; i++; continue;
    }
    if (ch === '"') {
      if (cell !== '') errors.push(`quote inside an unquoted cell at ${i}`);
      quoted = true; i++; continue;
    }
    if (ch === sep) { row.push(cell); cell = ''; i++; continue; }
    if (ch === '\r') {
      if (text[i + 1] !== '\n') errors.push(`bare CR at ${i}`);
      row.push(cell); rows.push(row); row = []; cell = ''; i += 2; continue;
    }
    if (ch === '\n') { errors.push(`bare LF at ${i}`); row.push(cell); rows.push(row); row = []; cell = ''; i++; continue; }
    cell += ch; i++;
  }
  if (quoted) errors.push('unterminated quote');
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); errors.push('last line without CRLF'); }
  return { rows, errors };
}

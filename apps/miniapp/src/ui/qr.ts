import qrcode from 'qrcode-generator';

/** Real QR for the client's code. Payload format "HF:<code>" — the Worker accepts it in staff lookup. */
export function qrSvg(code: string): string {
  const q = qrcode(0, 'M');
  q.addData('HF:' + code);
  q.make();
  return q.createSvgTag({ cellSize: 6, margin: 2, scalable: true });
}

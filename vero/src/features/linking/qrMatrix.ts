/**
 * QR code matrix generation (pure). Uses the encoder core of the `qrcode`
 * package directly, so nothing platform-specific (canvas, fs, TextEncoder) is
 * pulled into the React Native bundle.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const QRCodeCore: {
  create(
    data: { data: Uint8Array; mode: 'byte' }[],
    options?: { errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H' }
  ): { modules: { size: number; data: Uint8Array } };
} = require('qrcode/lib/core/qrcode');
import { utf8Bytes } from '../discovery/sha256';

export interface QrMatrix {
  size: number;
  /** row-major, 1 = dark module */
  modules: Uint8Array;
}

export function qrMatrix(text: string, errorCorrectionLevel: 'L' | 'M' | 'Q' | 'H' = 'M'): QrMatrix {
  const qr = QRCodeCore.create([{ data: utf8Bytes(text), mode: 'byte' }], { errorCorrectionLevel });
  return { size: qr.modules.size, modules: Uint8Array.from(qr.modules.data, (v) => (v ? 1 : 0)) };
}

/** SVG path covering every dark module, offset by a quiet zone of `margin` modules. */
export function qrPath(matrix: QrMatrix, margin = 4): string {
  let d = '';
  for (let y = 0; y < matrix.size; y++) {
    let x = 0;
    while (x < matrix.size) {
      if (!matrix.modules[y * matrix.size + x]) {
        x++;
        continue;
      }
      // merge horizontal runs into one rectangle
      let run = 1;
      while (x + run < matrix.size && matrix.modules[y * matrix.size + x + run]) run++;
      d += `M${x + margin} ${y + margin}h${run}v1h-${run}z`;
      x += run;
    }
  }
  return d;
}

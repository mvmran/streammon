// The CSV's pan_map column ('p1'): the packed pan map (src/dsp/csv-codec.js) compressed
// with deflate-raw. CompressionStream is async and a browser (or Node 20.12+) API, which is
// why this lives here and not in src/dsp. A real stereo mix is about 600 characters a
// second, a mono service about 130.

import { packPan, unpackPan, toBase64Url, tagged } from '../dsp/csv-codec.js';

async function pipe(bytes, stream) {
  const out = new Blob([bytes]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(out).arrayBuffer());
}

export async function encodePan(grid) {
  if (!grid) return '';
  return 'p1' + toBase64Url(await pipe(packPan(grid), new CompressionStream('deflate-raw')));
}

// The grid, or null for an empty or damaged cell.
export async function decodePan(text) {
  const packed = tagged('p1', text);
  if (!packed) return null;
  try {
    return unpackPan(await pipe(packed, new DecompressionStream('deflate-raw')));
  } catch {
    return null;
  }
}

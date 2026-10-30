// Compact text encodings for the CSV's per-second chart data: Stereo by band, the
// 1/3-octave spectrum and the full pan map, one cell each instead of a column per number.
//
// Spreadsheet-safe by construction, so Excel and Google Sheets open and re-save them
// unchanged: only A-Z a-z 0-9 - _ (URL-safe base64, no padding), always starting with a
// lowercase tag and a format version ('s1', 'b1', 'p1'), so a value is never read as a
// formula (= + - @), a number, a date or TRUE/FALSE, and never holds a comma, quote or line
// break. The longest (a pan map) stays far below Excel's 32,767 characters per cell.
//
// Pure JS (no browser or Node APIs, like the rest of src/dsp): the spectrum and band codes,
// and the pan map's packing. Compressing the packed pan map needs CompressionStream, so that
// part, and the 'p1' code, is in src/ui/pan-codec.js.

import { OCTAVE_CENTRES, THIRD_OCTAVE_CENTRES } from './bands.js';
import { PAN_COLS, PAN_ROWS } from './pan.js';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const INDEX = new Map([...ALPHABET].map((c, i) => [c, i]));

export function toBase64Url(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    const chars = i + 2 < bytes.length ? 4 : i + 1 < bytes.length ? 3 : 2;
    for (let k = 0; k < chars; k++) out += ALPHABET[(n >> (18 - 6 * k)) & 63];
  }
  return out;
}

export function fromBase64Url(text) {
  const bytes = new Uint8Array(Math.floor((text.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < text.length; i += 4) {
    let n = 0;
    const chars = Math.min(4, text.length - i);
    for (let k = 0; k < 4; k++) {
      const v = k < chars ? INDEX.get(text[i + k]) : 0;
      if (v === undefined) throw new Error('not a valid encoded value');
      n = (n << 6) | v;
    }
    for (let k = 0; k < chars - 1; k++) bytes[o++] = (n >> (16 - 8 * k)) & 255;
  }
  return bytes;
}

// What every encoded value looks like (the tests hold the encoders to it).
export const SAFE_CODE = /^[a-z][0-9][A-Za-z0-9_-]*$/;

// The bytes of a value with this tag, or null: a damaged cell (hand-edited, or re-encoded
// by some tool) loses that second's chart, not the whole file.
export function tagged(tag, text) {
  if (typeof text !== 'string' || !text.startsWith(tag)) return null;
  try {
    return fromBase64Url(text.slice(tag.length));
  } catch {
    return null;
  }
}

// A level byte: 0.5 dB steps, 1 = −127 dB … 255 = 0 dB; 0 = nothing (−∞ or none).
const levelByte = (db) => (db === null || !(db > -127.25) ? 0 : Math.min(255, Math.max(1, Math.round((db + 127.5) * 2))));
const byteLevel = (b) => (b === 0 ? -Infinity : b / 2 - 127.5);

// ---------------------------------------------------------------------------
// Spectrum: the 29 1/3-octave levels (dB), one level byte each.

export function encodeSpectrum(levels) {
  if (!levels) return '';
  return 's1' + toBase64Url(Uint8Array.from(levels, levelByte));
}

export function decodeSpectrum(text) {
  const bytes = tagged('s1', text);
  if (!bytes || bytes.length < THIRD_OCTAVE_CENTRES.length) return null;
  return Array.from(bytes.subarray(0, THIRD_OCTAVE_CENTRES.length), byteLevel);
}

// ---------------------------------------------------------------------------
// Stereo by band: per octave, correlation (int16, 1/32767 steps, so 0.999 and 0.995 stay
// apart), balance (int16, 0.01 dB) and level (a level byte). Missing values: −32768.

const NONE16 = -32768;
const putInt16 = (view, at, v) => view.setInt16(at, v, false);

export function encodeBands(bands) {
  if (!bands) return '';
  const view = new DataView(new ArrayBuffer(OCTAVE_CENTRES.length * 5));
  bands.forEach((b, i) => {
    const corr = b && Number.isFinite(b.correlation) ? Math.round(Math.max(-1, Math.min(1, b.correlation)) * 32767) : NONE16;
    const bal = b && Number.isFinite(b.balanceDb) ? Math.round(Math.max(-327, Math.min(327, b.balanceDb)) * 100) : NONE16;
    putInt16(view, i * 5, corr);
    putInt16(view, i * 5 + 2, bal);
    view.setUint8(i * 5 + 4, levelByte(b ? b.levelDb : null));
  });
  return 'b1' + toBase64Url(new Uint8Array(view.buffer));
}

export function decodeBands(text) {
  const bytes = tagged('b1', text);
  if (!bytes || bytes.length < OCTAVE_CENTRES.length * 5) return null;
  const view = new DataView(bytes.buffer);
  return OCTAVE_CENTRES.map((fc, i) => {
    const corr = view.getInt16(i * 5, false), bal = view.getInt16(i * 5 + 2, false);
    return { fc, correlation: corr === NONE16 ? null : corr / 32767, balanceDb: bal === NONE16 ? null : bal / 100, levelDb: byteLevel(view.getUint8(i * 5 + 4)) };
  });
}

// ---------------------------------------------------------------------------
// Pan map: the full grid (energy per cell, PAN_ROWS × PAN_COLS, row 0 = lowest band).
// Per band: its loudest cell as a level byte, then every cell in 3 dB steps below it, 4 bits
// each (15 = the loudest, 1 = 42 dB below; 0 = more than about 43.5 dB below, or empty), so
// about the map's 45 dB display range. src/ui/pan-codec.js compresses this ('p1').

const STEP_DB = 3;
const STEPS = 15;
const PER_ROW = 1 + Math.ceil(PAN_COLS / 2);

export function packPan(grid) {
  const bytes = new Uint8Array(PAN_ROWS * PER_ROW);
  for (let row = 0; row < PAN_ROWS; row++) {
    let top = 0;
    for (let c = 0; c < PAN_COLS; c++) top = Math.max(top, grid[row * PAN_COLS + c]);
    const o = row * PER_ROW;
    if (!(top > 0)) continue; // all zero: nothing in this band
    bytes[o] = levelByte(10 * Math.log10(top));
    const topKept = byteLevel(bytes[o]); // steps are counted from the stored level
    for (let c = 0; c < PAN_COLS; c++) {
      const v = grid[row * PAN_COLS + c];
      const n = v > 0 ? STEPS - Math.round(Math.max(0, topKept - 10 * Math.log10(v)) / STEP_DB) : 0;
      if (n > 0) bytes[o + 1 + (c >> 1)] |= c & 1 ? n : n << 4;
    }
  }
  return bytes;
}

export function unpackPan(bytes) {
  if (!bytes || bytes.length < PAN_ROWS * PER_ROW) return null;
  const grid = new Float64Array(PAN_ROWS * PAN_COLS);
  for (let row = 0; row < PAN_ROWS; row++) {
    const o = row * PER_ROW;
    if (!bytes[o]) continue;
    const topDb = byteLevel(bytes[o]);
    for (let c = 0; c < PAN_COLS; c++) {
      const b = bytes[o + 1 + (c >> 1)];
      const n = c & 1 ? b & 15 : b >> 4;
      if (n) grid[row * PAN_COLS + c] = Math.pow(10, (topDb - (STEPS - n) * STEP_DB) / 10);
    }
  }
  return grid;
}

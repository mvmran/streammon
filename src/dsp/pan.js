// The pan map's data, without drawing: where the sound sits left to right at each
// 1/3-octave band, from separate left and right AnalyserNode spectra (display grade, like
// the spectrum). Each FFT bin is placed by its share of energy between the sides,
// (R² − L²) / (R² + L²), the same scale as the stereo-by-band balance axis. Used by the
// pan map view, by the extension's offscreen document (for the CSV), and to redraw a
// saved CSV's per-band summary.

import { THIRD_OCTAVE_CENTRES } from './bands.js';

export const PAN_COLS = 41; // pan cells, odd so the centre has its own column
export const PAN_ROWS = THIRD_OCTAVE_CENTRES.length;
const EDGE = Math.pow(2, 1 / 6);
export const PAN_F_LO = THIRD_OCTAVE_CENTRES[0] / EDGE;
export const PAN_F_HI = THIRD_OCTAVE_CENTRES[PAN_ROWS - 1] * EDGE;
const SMOOTH_S = 1; // time constant of the energy average
// Summed AnalyserNode bin powers (Blackman window, 1/N scaling, magnitude smoothing 0.5)
// read about 9 dB below the band's true level: measured with noise at 100 Hz, 1 kHz, 8 kHz.
const BIN_SUM_TO_DBFS = 9;

// Band level (dBFS, per channel) of a row from its summed cell energies, and back.
export const rowDb = (sum) => (sum > 0 ? 10 * Math.log10(sum / 2) + BIN_SUM_TO_DBFS : -Infinity);
const rowSum = (db) => 2 * Math.pow(10, (db - BIN_SUM_TO_DBFS) / 10);
// Column c's position, −1 (left) … +1 (right).
const colPos = (c) => (c / (PAN_COLS - 1)) * 2 - 1;

export class PanGrid {
  constructor() {
    this.acc = new Float64Array(PAN_ROWS * PAN_COLS);
    this.reset();
  }

  reset() {
    this.grid = null; // smoothed energy per cell (row-major, row 0 = lowest band)
  }

  // left, right: dB per FFT bin (AnalyserNode.getFloatFrequencyData) for each channel;
  // dt: seconds since the previous frame, which times the average.
  update(left, right, sampleRate, dt) {
    const acc = this.acc;
    acc.fill(0);
    const binHz = sampleRate / 2 / left.length;
    const logSpan = Math.log(PAN_F_HI / PAN_F_LO);
    for (let b = 1; b < left.length; b++) {
      const f = b * binHz;
      if (f < PAN_F_LO) continue;
      if (f >= PAN_F_HI) break;
      const l = Math.pow(10, left[b] / 10), r = Math.pow(10, right[b] / 10);
      const e = l + r;
      if (!(e > 1e-12)) continue;
      const row = Math.min(PAN_ROWS - 1, Math.floor((Math.log(f / PAN_F_LO) / logSpan) * PAN_ROWS));
      const col = Math.round((((r - l) / e + 1) / 2) * (PAN_COLS - 1));
      acc[row * PAN_COLS + col] += e;
    }
    if (!this.grid) this.grid = Float64Array.from(acc);
    else {
      const a = 1 - Math.exp(-dt / SMOOTH_S);
      for (let i = 0; i < acc.length; i++) this.grid[i] += (acc[i] - this.grid[i]) * a;
    }
  }

  summary() {
    return this.grid ? panSummary(this.grid) : null;
  }
}

// Per band (row 0 = lowest), for the CSV: its level (dBFS), where its energy sits on
// average (pos, −1 left … +1 right) and how far it spreads around that (width, the
// standard deviation in the same units: about 0 for one panned source, larger for a wide
// mix or for sources on both sides).
export function panSummary(grid) {
  const out = [];
  for (let row = 0; row < PAN_ROWS; row++) {
    let e = 0, m = 0;
    for (let c = 0; c < PAN_COLS; c++) {
      const v = grid[row * PAN_COLS + c];
      e += v;
      m += v * colPos(c);
    }
    if (!(e > 0)) {
      out.push({ levelDb: -Infinity, pos: null, width: null });
      continue;
    }
    const pos = m / e;
    let s = 0;
    for (let c = 0; c < PAN_COLS; c++) s += grid[row * PAN_COLS + c] * (colPos(c) - pos) ** 2;
    out.push({ levelDb: rowDb(e), pos, width: Math.sqrt(s / e) });
  }
  return out;
}

// A grid drawn from a summary (a saved CSV): each band's energy spread as a bell around its
// average position, as wide as its spread (at least one column).
export function gridFromSummary(summary) {
  const grid = new Float64Array(PAN_ROWS * PAN_COLS);
  const minWidth = 1 / (PAN_COLS - 1); // half a column's span
  summary.forEach((b, row) => {
    if (!b || !Number.isFinite(b.levelDb) || !Number.isFinite(b.pos)) return;
    const w = Math.max(minWidth, b.width || 0);
    const weights = Array.from({ length: PAN_COLS }, (_, c) => Math.exp(-((colPos(c) - b.pos) ** 2) / (2 * w * w)));
    const total = weights.reduce((a, x) => a + x, 0);
    const sum = rowSum(b.levelDb);
    weights.forEach((x, c) => (grid[row * PAN_COLS + c] = (sum * x) / total));
  });
  return grid;
}

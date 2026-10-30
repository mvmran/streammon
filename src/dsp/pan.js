// The pan map's data, without drawing: where the sound sits left to right at each
// 1/3-octave band, from separate left and right AnalyserNode spectra (display grade, like
// the spectrum). Each FFT bin is placed by its share of energy between the sides,
// (R² − L²) / (R² + L²), the same scale as the stereo-by-band balance axis. Used by the
// pan map view's data in the web app, by the extension's offscreen document (which sends
// its grid to the dashboards), and for the CSV's pan_map column (csv-codec.js).

import { THIRD_OCTAVE_CENTRES } from './bands.js';

export const PAN_COLS = 41; // pan cells, odd so the centre has its own column
export const PAN_ROWS = THIRD_OCTAVE_CENTRES.length;
export const PAN_EDGE = Math.pow(2, 1 / 6); // a 1/3-octave band's edges: centre ÷ and × this
export const PAN_F_LO = THIRD_OCTAVE_CENTRES[0] / PAN_EDGE;
export const PAN_F_HI = THIRD_OCTAVE_CENTRES[PAN_ROWS - 1] * PAN_EDGE;
const SMOOTH_S = 1; // time constant of the energy average
// Summed AnalyserNode bin powers (Blackman window, 1/N scaling, magnitude smoothing 0.5)
// read about 9 dB below the band's true level: measured with noise at 100 Hz, 1 kHz, 8 kHz.
const BIN_SUM_TO_DBFS = 9;

// Band level (dBFS, per channel) of a row from its summed cell energies.
export const rowDb = (sum) => (sum > 0 ? 10 * Math.log10(sum / 2) + BIN_SUM_TO_DBFS : -Infinity);

// Pan cell c's position, −1 (left) … +1 (right).
export const colPos = (c) => (c / (PAN_COLS - 1)) * 2 - 1;

// The view's grid is a running ~1 s average; the CSV gets each second's own average
// (takeSecond), like the spectrum columns, so a row isn't a second behind them.
export class PanGrid {
  constructor() {
    this.acc = new Float64Array(PAN_ROWS * PAN_COLS);
    this.second = new Float64Array(PAN_ROWS * PAN_COLS);
    this.reset();
  }

  reset() {
    this.grid = null; // smoothed energy per cell (row-major, row 0 = lowest band)
    this.lastT = null; // audio-clock time of the latest frame (s)
    this.second.fill(0);
    this.frames = 0;
  }

  // left, right: dB per FFT bin (AnalyserNode.getFloatFrequencyData) for each channel;
  // t: the analyzer frame's audio-clock time (s), which times the average.
  update(left, right, sampleRate, t) {
    const dt = this.lastT === null || !(t > this.lastT) ? 0.1 : Math.min(t - this.lastT, 60);
    this.lastT = t;
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
    for (let i = 0; i < acc.length; i++) this.second[i] += acc[i];
    this.frames++;
    if (!this.grid) this.grid = Float64Array.from(acc);
    else {
      const a = 1 - Math.exp(-dt / SMOOTH_S);
      for (let i = 0; i < acc.length; i++) this.grid[i] += (acc[i] - this.grid[i]) * a;
    }
  }

  // The mean grid of the frames since the last call (null if none), for the CSV row.
  takeSecond() {
    if (!this.frames) return null;
    const out = Float64Array.from(this.second, (v) => v / this.frames);
    this.second.fill(0);
    this.frames = 0;
    return out;
  }
}

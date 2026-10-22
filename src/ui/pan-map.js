// Pan vs frequency map: where the sound sits left to right (across) at each 1/3-octave
// band (up), brighter for more energy. Each FFT bin is placed by its share of energy
// between the sides, (R² − L²) / (R² + L²), the same scale as the stereo-by-band balance
// axis. Fed from separate left and right AnalyserNode spectra; display only.

import { THIRD_OCTAVE_CENTRES } from '../dsp/bands.js';
import { STEREO_RULES } from '../dsp/stereobands.js';
import { css, fmtDb } from './format.js';

const COLS = 41; // pan cells, odd so the centre has its own column
const ROWS = THIRD_OCTAVE_CENTRES.length;
const EDGE = Math.pow(2, 1 / 6);
const F_LO = THIRD_OCTAVE_CENTRES[0] / EDGE;
const F_HI = THIRD_OCTAVE_CENTRES[ROWS - 1] * EDGE;
const RANGE_DB = 45; // shown below the loudest cell (less hides diffuse orchestral bass)
const SMOOTH_S = 1; // time constant of the energy average
const BAL_MARKS = [3, 6, 10]; // 20 dB would fall inside the edge column
// Summed AnalyserNode bin powers (Blackman window, 1/N scaling, magnitude smoothing 0.5)
// read about 9 dB below the band's true level: measured with noise at 100 Hz, 1 kHz, 8 kHz.
const BIN_SUM_TO_DBFS = 9;
// Rows (1/3 octaves) quieter than this are mostly the source's own noise, e.g. two mic
// capsules' independent hiss, which would spread across the map as a fake wide image.
// Stereo by band's -70 dBFS per octave is about -75 dBFS per 1/3 octave.
const ROW_FLOOR_DB = STEREO_RULES.judgeDb - 5;
// Same ramp as the spectrogram (dark surface -> blue -> near white).
const RAMP = ['#1a1a19', '#104281', '#1c5cab', '#2a78d6', '#5598e7', '#86b6ef', '#cde2fb', '#ffffff'];

const labelHz = (f) => (f >= 1000 ? `${Math.round(f / 100) / 10}k` : String(Math.round(f)));
const fmtHz = (f) => (f >= 1000 ? `${(f / 1000).toFixed(f >= 10000 ? 1 : 2)} kHz` : `${Math.round(f)} Hz`);
const balancePos = (db) => {
  const g = Math.pow(10, db / 10);
  return (g - 1) / (g + 1);
};
// Pan position (-1…1) back to dB, R over L.
const posDb = (u) => 10 * Math.log10((1 + u) / Math.max(1e-6, 1 - u));
// The edge columns collect everything at least this much louder on one side (19 dB).
const EDGE_DB = Math.round(-posDb(-1 + 1 / (COLS - 1)));
const fmtBalance = (db) => (Math.abs(db) < 0.25 ? 'centre' : `${db < 0 ? 'L' : 'R'} ${Math.abs(db).toFixed(1)} dB`);
// Band level (dBFS, per channel) of a row from its summed cell energies.
const rowDb = (sum) => (sum > 0 ? 10 * Math.log10(sum / 2) + BIN_SUM_TO_DBFS : -Infinity);

function buildLut() {
  const rgb = RAMP.map((h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)));
  const lut = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const f = (i / 255) * (rgb.length - 1);
    const k = Math.min(rgb.length - 2, Math.floor(f));
    const u = f - k;
    for (let c = 0; c < 3; c++) lut[i * 3 + c] = rgb[k][c] + (rgb[k + 1][c] - rgb[k][c]) * u;
  }
  return lut;
}

export class PanMapView {
  constructor(canvas) {
    this.canvas = canvas;
    this.tooltip = document.getElementById('tooltip');
    this.cssHeight = Number(canvas.getAttribute('height')) || 260;
    this.lut = buildLut();
    this.grid = null; // smoothed energy per cell (row-major, row 0 = lowest band)
    this.acc = new Float64Array(ROWS * COLS);
    this.img = document.createElement('canvas');
    this.img.width = COLS;
    this.img.height = ROWS;
    this.imgData = this.img.getContext('2d').createImageData(COLS, ROWS);
    this.hover = null;
    new ResizeObserver(() => this.resize()).observe(canvas.parentElement);
    canvas.addEventListener('pointermove', (e) => {
      this.hover = e;
      this.showTip();
    });
    canvas.addEventListener('pointerleave', () => {
      this.hover = null;
      this.tooltip.hidden = true;
    });
    this.resize();
  }

  get plot() {
    return { l: 42, r: this.w - 10, t: 8, b: this.h - 36 };
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = this.canvas.parentElement.clientWidth;
    if (!w) return;
    this.w = w;
    this.h = this.cssHeight;
    this.canvas.style.height = `${this.h}px`;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(this.h * dpr);
    this.canvas.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
    this.draw();
  }

  clear() {
    this.grid = null;
    this.draw();
  }

  // left, right: dB per FFT bin (AnalyserNode.getFloatFrequencyData) for each channel.
  update(left, right, sampleRate, dt) {
    const acc = this.acc;
    acc.fill(0);
    const binHz = sampleRate / 2 / left.length;
    const logSpan = Math.log(F_HI / F_LO);
    for (let b = 1; b < left.length; b++) {
      const f = b * binHz;
      if (f < F_LO) continue;
      if (f >= F_HI) break;
      const l = Math.pow(10, left[b] / 10), r = Math.pow(10, right[b] / 10);
      const e = l + r;
      if (!(e > 1e-12)) continue;
      const row = Math.min(ROWS - 1, Math.floor((Math.log(f / F_LO) / logSpan) * ROWS));
      const col = Math.round((((r - l) / e + 1) / 2) * (COLS - 1));
      acc[row * COLS + col] += e;
    }
    if (!this.grid) this.grid = Float64Array.from(acc);
    else {
      const a = 1 - Math.exp(-dt / SMOOTH_S);
      for (let i = 0; i < acc.length; i++) this.grid[i] += (acc[i] - this.grid[i]) * a;
    }
    this.dirty = true;
  }

  // Draws the latest grid: call it on animation frames (update() may run while hidden).
  render() {
    if (!this.dirty) return;
    this.dirty = false;
    this.draw();
    if (this.hover) this.showTip();
  }

  draw() {
    if (!this.w) return;
    const ctx = this.canvas.getContext('2d');
    const w = this.w, h = this.h, p = this.plot;
    ctx.clearRect(0, 0, w, h);
    let tooQuiet = false;
    ctx.font = '11px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = RAMP[0];
    ctx.fillRect(p.l, p.t, p.r - p.l, p.b - p.t);
    if (this.grid) {
      // Brightness is relative to the loudest cell among the rows loud enough to judge;
      // quieter rows stay dark.
      const judged = [];
      let top = 0;
      for (let row = 0; row < ROWS; row++) {
        let sum = 0;
        for (let col = 0; col < COLS; col++) sum += this.grid[row * COLS + col];
        judged[row] = rowDb(sum) >= ROW_FLOOR_DB;
        if (judged[row]) for (let col = 0; col < COLS; col++) top = Math.max(top, this.grid[row * COLS + col]);
      }
      const ictx = this.img.getContext('2d');
      const data = this.imgData;
      const topDb = 10 * Math.log10(top || 1e-30);
      for (let row = 0; row < ROWS; row++) {
        for (let col = 0; col < COLS; col++) {
          const v = this.grid[row * COLS + col];
          const t = judged[row] && v > 0 ? (10 * Math.log10(v) - (topDb - RANGE_DB)) / RANGE_DB : 0;
          const k = Math.max(0, Math.min(255, Math.round(t * 255)));
          const o = ((ROWS - 1 - row) * COLS + col) * 4;
          data.data[o] = this.lut[k * 3];
          data.data[o + 1] = this.lut[k * 3 + 1];
          data.data[o + 2] = this.lut[k * 3 + 2];
          data.data[o + 3] = 255;
        }
      }
      ictx.putImageData(data, 0, 0);
      // Hard-edged cells: smoothing blurred blobs over the gaps between FFT bins.
      ctx.imageSmoothingEnabled = false;
      // Cell centres span the plot: column 0 sits on the left edge, the last on the right.
      const cw = (p.r - p.l) / (COLS - 1);
      ctx.save();
      ctx.beginPath();
      ctx.rect(p.l, p.t, p.r - p.l, p.b - p.t);
      ctx.clip();
      ctx.drawImage(this.img, p.l - cw / 2, p.t, p.r - p.l + cw, p.b - p.t);
      ctx.restore();
      tooQuiet = !judged.some(Boolean);
    }
    // Axes: frequency up the left, balance along the bottom (as on stereo by band).
    ctx.strokeStyle = css('--axis');
    ctx.lineWidth = 1;
    const cx = (p.l + p.r) / 2;
    ctx.beginPath();
    ctx.moveTo(Math.round(cx) + 0.5, p.t);
    ctx.lineTo(Math.round(cx) + 0.5, p.b);
    ctx.stroke();
    ctx.fillStyle = css('--muted');
    ctx.strokeStyle = css('--muted');
    ctx.textAlign = 'right';
    for (const f of [62.5, 250, 1000, 4000, 16000]) {
      const y = p.b - (Math.log(f / F_LO) / Math.log(F_HI / F_LO)) * (p.b - p.t);
      ctx.fillText(labelHz(f), p.l - 5, y);
    }
    const xOf = (db) => cx + balancePos(db) * ((p.r - p.l) / 2);
    const ly = p.b + 11;
    const taken = [];
    const label = (text, x, align) => {
      const tw = ctx.measureText(text).width;
      const x0 = align === 'left' ? x : align === 'right' ? x - tw : x - tw / 2;
      if (taken.some(([a, b]) => x0 < b + 6 && x0 + tw > a - 6)) return;
      taken.push([x0, x0 + tw]);
      ctx.textAlign = align;
      ctx.fillText(text, x, ly);
    };
    for (const db of BAL_MARKS) {
      for (const x of [xOf(-db), xOf(db)]) {
        ctx.beginPath();
        ctx.moveTo(Math.round(x) + 0.5, p.b);
        ctx.lineTo(Math.round(x) + 0.5, p.b + 4);
        ctx.stroke();
      }
    }
    label('C', cx, 'center');
    label(`L ≥${EDGE_DB}`, p.l, 'left');
    label(`R ≥${EDGE_DB}`, p.r, 'right');
    for (const db of BAL_MARKS) {
      label(String(db), xOf(-db), 'center');
      label(String(db), xOf(db), 'center');
    }
    ctx.textAlign = 'center';
    ctx.fillText('balance: dB louder on that side', cx, p.b + 27);
    if (tooQuiet) {
      const text = `Too quiet to place: every band is below ${fmtDb(ROW_FLOOR_DB, 0)} dBFS`;
      const tw = ctx.measureText(text).width, my = (p.t + p.b) / 2;
      ctx.fillStyle = RAMP[0];
      ctx.fillRect(cx - tw / 2 - 6, my - 9, tw + 12, 18);
      ctx.fillStyle = css('--muted');
      ctx.fillText(text, cx, my);
    }
  }

  showTip() {
    const e = this.hover, p = this.plot, tip = this.tooltip;
    if (!this.grid || e.offsetX < p.l || e.offsetX > p.r || e.offsetY < p.t || e.offsetY > p.b) {
      tip.hidden = true;
      return;
    }
    const u = ((e.offsetX - p.l) / (p.r - p.l)) * 2 - 1;
    const col = Math.round(((u + 1) / 2) * (COLS - 1));
    const row = Math.min(ROWS - 1, Math.floor(((p.b - e.offsetY) / (p.b - p.t)) * ROWS));
    const fc = THIRD_OCTAVE_CENTRES[row];
    const v = this.grid[row * COLS + col];
    let sum = 0;
    for (let c = 0; c < COLS; c++) sum += this.grid[row * COLS + c];
    const band = rowDb(sum);
    const side = col === 0 ? 'L' : col === COLS - 1 ? 'R' : null;
    const r = (k, val) => `<div class="row"><span class="k">${k}</span><span class="val">${val}</span></div>`;
    tip.className = 'tooltip';
    tip.innerHTML = [
      `<div class="k">${fmtHz(fc / EDGE)} – ${fmtHz(fc * EDGE)}</div>`,
      r('Position', side ? `${side} ${EDGE_DB} dB or more` : fmtBalance(posDb((col / (COLS - 1)) * 2 - 1))),
      r('Cell', v > 0 ? `${fmtDb(10 * Math.log10(v))} dB` : '--'),
      r('Band level', Number.isFinite(band) ? `${fmtDb(band)} dBFS` : '--'),
      band < ROW_FLOOR_DB ? `<div class="k">Too quiet to place: mostly noise</div>` : '',
    ].join('');
    tip.hidden = false;
    const tw = tip.offsetWidth;
    tip.style.left = `${e.clientX + 14 + tw > window.innerWidth ? e.clientX - 14 - tw : e.clientX + 14}px`;
    tip.style.top = `${Math.max(4, e.clientY - 20)}px`;
  }
}

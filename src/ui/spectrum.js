// Spectrum display: 1/3-octave bars, a waterfall spectrogram below them on the same
// frequency axis, and octave balance. Fed from an AnalyserNode, which is fine for
// display (measurements use raw samples).

import { thirdOctaveLevels, THIRD_OCTAVE_CENTRES, bandLevels, OCTAVE_CENTRES } from '../dsp/bands.js';
import { css, fmtDb, frameStep } from './format.js';

const DB_MIN = -100;
const SAVED_ROW_PX = 4; // a saved CSV's spectrogram: pixel rows per second (about 2 min shown)
const BASE_HZ = 1000; // 1/3-octave band k is centred on 1000 · 2^((k − 16) / 3) Hz
// Below this the bars, the octave balance and the spectrogram use the finer spectrum
// (engine.analyserFine) when there is one.
export const FINE_MAX_HZ = 200;
const DB_MAX = -10;
// Shared frequency axis: the outer edges of the first and last 1/3-octave bands, so each
// bar sits exactly above its own stretch of the spectrogram (log scale).
const F_LO = THIRD_OCTAVE_CENTRES[0] / Math.pow(2, 1 / 6);
const F_HI = THIRD_OCTAVE_CENTRES[THIRD_OCTAVE_CENTRES.length - 1] * Math.pow(2, 1 / 6);
// Plot margins in CSS px, the same for both canvases so their frequency axes line up.
const PLOT_L = 34;
const PLOT_R = 6;
const AXIS_B = 20; // frequency labels under each plot
// The octave-balance centres (31 Hz … 16 kHz) are every third 1/3-octave band from index 1.
const isOctaveCentre = (i) => i % 3 === 1;
const BALANCE_SHOWN = OCTAVE_CENTRES.length - 1; // the balance lists 31 Hz to 8 kHz

// Sequential single-hue ramp (dark surface -> blue -> near white) for the spectrogram.
const RAMP = ['#1a1a19', '#104281', '#1c5cab', '#2a78d6', '#5598e7', '#86b6ef', '#cde2fb', '#ffffff'];

// The first bins of the finer analyser, up to just past FINE_MAX_HZ: { db, binHz }.
const fineBufs = new WeakMap();
export function readFine(analyser, sampleRate) {
  const binHz = sampleRate / analyser.fftSize;
  const n = Math.min(analyser.frequencyBinCount, Math.ceil(FINE_MAX_HZ / binHz) + 2);
  let db = fineBufs.get(analyser);
  if (!db || db.length !== n) fineBufs.set(analyser, (db = new Float32Array(n)));
  analyser.getFloatFrequencyData(db); // fills only as many bins as the array holds
  return { db, binHz };
}

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

const labelHz = (f) => (f >= 1000 ? `${Math.round(f / 100) / 10}k` : String(Math.round(f)));
const fmtHz = (f) => (f >= 1000 ? `${(f / 1000).toFixed(f >= 10000 ? 1 : 2)} kHz` : `${Math.round(f)} Hz`);
// Fraction of the way along the log frequency axis, and back.
const axisPos = (f) => Math.log(f / F_LO) / Math.log(F_HI / F_LO);
const axisFreq = (u) => F_LO * Math.pow(F_HI / F_LO, u);

function placeTip(tip, e) {
  const tw = tip.offsetWidth;
  const left = e.clientX + 14 + tw > window.innerWidth ? e.clientX - 14 - tw : e.clientX + 14;
  tip.style.left = `${left}px`;
  tip.style.top = `${Math.max(4, e.clientY - 20)}px`;
}

const tipRow = (k, v) => `<div class="row"><span class="k">${k}</span><span class="val">${v}</span></div>`;

export class SpectrumView {
  constructor({ bands, sgram, balance }) {
    this.bands = bands;
    this.sgram = sgram;
    this.balanceEl = balance;
    this.tooltip = document.getElementById('tooltip');
    this.lut = buildLut();
    this.sgFloor = DB_MIN; // spectrogram colour floor (dB), set from the display settings
    this.data = null;
    this.levels = null; // latest 1/3-octave levels (dB)
    this.lastT = null; // audio-clock time of the latest frame (s)
    this.octPower = null; // smoothed linear power per octave
    this.thirdPower = null; // smoothed linear power per 1/3 octave (the average line)
    this.bandHover = null; // { i, e } while the pointer is over a bar
    this.sgHover = null; // pointer event while over the spectrogram
    // Spectrogram history: one byte per pixel (the colour index, 0.35 dB steps) in a ring
    // of rows, newest drawn at the top, plus each row's time on the audio clock.
    // Rows are added per 100 ms analyzer frame, even while the page is hidden (no
    // animation frames then); drawing waits for render(), called on animation frames.
    this.sg = null;
    // The height attribute is the CSS height. Read it once: setting canvas.height to the
    // device-pixel size rewrites the attribute, so re-reading it would compound the
    // display scale on every resize (the canvas grows until Chrome can't draw it).
    this.cssHeight = new Map([bands, sgram].map((c) => [c, Number(c.getAttribute('height')) || 200]));
    for (const c of [bands, sgram]) new ResizeObserver(() => this.resize(c)).observe(c.parentElement);
    this.bindHover();
    this.buildBalance();
  }

  resize(c) {
    const dpr = window.devicePixelRatio || 1;
    const w = c.parentElement.clientWidth;
    const h = this.cssHeight.get(c);
    if (!w) return;
    c.style.height = `${h}px`;
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
    if (c === this.sgram) {
      this.sw = w;
      this.sh = h;
      this.resizeHistory(dpr);
      this.drawSpectrogram();
    } else {
      c.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
      this.bw = w;
      this.bh = h;
      if (this.levels) this.drawBands();
    }
  }

  // (Re)allocates the history for the current plot size, keeping what fits: the
  // frequency axis scales with the width, so old columns are resampled.
  resizeHistory(dpr) {
    const x0 = Math.round(PLOT_L * dpr);
    const cols = Math.max(1, Math.round((this.sw - PLOT_R) * dpr) - x0);
    const rows = Math.max(1, Math.round((this.sh - AXIS_B) * dpr));
    const old = this.sg;
    const sg = { dpr, x0, cols, rows, vals: new Uint8Array(cols * rows), times: new Float64Array(rows), head: 0, count: 0, colBins: null };
    sg.buf = document.createElement('canvas');
    sg.buf.width = cols;
    sg.buf.height = rows;
    sg.bctx = sg.buf.getContext('2d');
    sg.row = sg.bctx.createImageData(cols, 1);
    if (old && old.count) {
      sg.count = Math.min(old.count, rows);
      for (let k = 0; k < sg.count; k++) {
        const src = ((old.head - k + old.rows) % old.rows) * old.cols;
        const dst = ((rows - k) % rows) * cols;
        for (let x = 0; x < cols; x++) sg.vals[dst + x] = old.vals[src + Math.floor((x * old.cols) / cols)];
        sg.times[(rows - k) % rows] = old.times[(old.head - k + old.rows) % old.rows];
      }
    }
    this.sg = sg;
    this.repaintHistory();
  }

  // Spectrogram colour floor (dB): quieter shows as background. The history on screen is
  // re-mapped to the new scale (what was below the old floor stays background).
  setSpectrogramFloor(db) {
    const floor = Math.max(-140, Math.min(DB_MAX - 30, Number.isFinite(db) ? db : DB_MIN));
    if (floor === this.sgFloor) return;
    const sg = this.sg;
    if (sg && sg.count) {
      const map = new Uint8Array(256);
      for (let k = 1; k < 256; k++) {
        const v = this.sgFloor + (k / 255) * (DB_MAX - this.sgFloor);
        map[k] = Math.max(0, Math.min(255, Math.round(((v - floor) / (DB_MAX - floor)) * 255)));
      }
      for (let i = 0; i < sg.vals.length; i++) sg.vals[i] = map[sg.vals[i]];
    }
    this.sgFloor = floor;
    if (sg) {
      this.repaintHistory();
      this.drawSpectrogram();
    }
  }

  // Redraws the whole history image from the stored values.
  repaintHistory() {
    const sg = this.sg;
    const img = sg.bctx.createImageData(sg.cols, sg.rows);
    const px = img.data;
    for (let k = 0; k < sg.rows; k++) {
      const src = ((sg.head - k + sg.rows) % sg.rows) * sg.cols;
      for (let x = 0; x < sg.cols; x++) {
        const v = k < sg.count ? sg.vals[src + x] : 0;
        const o = (k * sg.cols + x) * 4;
        px[o] = this.lut[v * 3];
        px[o + 1] = this.lut[v * 3 + 1];
        px[o + 2] = this.lut[v * 3 + 2];
        px[o + 3] = 255;
      }
    }
    sg.bctx.putImageData(img, 0, 0);
  }

  bindHover() {
    const hide = () => {
      this.bandHover = null;
      this.sgHover = null;
      this.tooltip.hidden = true;
      if (this.levels) this.drawBands();
    };
    this.bands.addEventListener('pointermove', (e) => {
      const n = THIRD_OCTAVE_CENTRES.length;
      const slot = (this.bw - PLOT_L - PLOT_R) / n;
      const i = Math.floor((e.offsetX - PLOT_L) / slot);
      if (!this.levels || i < 0 || i >= n) return hide();
      const changed = !this.bandHover || this.bandHover.i !== i;
      this.bandHover = { i, e };
      if (changed) this.drawBands();
      this.showBandTip();
    });
    this.sgram.addEventListener('pointermove', (e) => {
      this.sgHover = e;
      this.showSpectrogramTip();
    });
    this.bands.addEventListener('pointerleave', hide);
    this.sgram.addEventListener('pointerleave', hide);
  }

  showBandTip() {
    const { i, e } = this.bandHover;
    const fc = THIRD_OCTAVE_CENTRES[i];
    const j = Math.floor(i / 3); // octave index: bars 3j..3j+2 make up octave j
    const lines = [
      `<div class="k">${labelHz(fc)} band · ${fmtHz(fc / Math.pow(2, 1 / 6))} – ${fmtHz(fc * Math.pow(2, 1 / 6))}</div>`,
      tipRow('Now', `${fmtDb(this.levels[i])} dB`),
      tipRow('5 s average', `${fmtDb(10 * Math.log10(this.thirdPower[i]))} dB`),
    ];
    if (j < BALANCE_SHOWN && this.octPower) {
      const d = 10 * Math.log10(this.octPower[j]) - 10 * Math.log10(this.octPower[OCTAVE_CENTRES.indexOf(500)]);
      lines.push(tipRow(`In the ${labelHz(OCTAVE_CENTRES[j])} octave`, `${fmtDb(d)} dB vs 500 Hz`));
    } else if (j >= BALANCE_SHOWN) {
      lines.push(`<div class="k">${labelHz(OCTAVE_CENTRES[j])} octave (not in the balance)</div>`);
    }
    this.showTip(lines, e);
  }

  showSpectrogramTip() {
    const sg = this.sg, e = this.sgHover;
    if (!sg || !e) return;
    const x = Math.floor(e.offsetX * sg.dpr) - sg.x0;
    const k = Math.floor(e.offsetY * sg.dpr);
    if (x < 0 || x >= sg.cols || k < 0 || k >= sg.count) {
      this.tooltip.hidden = true;
      return;
    }
    const r = (sg.head - k + sg.rows) % sg.rows;
    const v = sg.vals[r * sg.cols + x];
    const db = this.sgFloor + (v / 255) * (DB_MAX - this.sgFloor);
    const age = sg.times[sg.head] - sg.times[r];
    this.showTip([
      `<div class="k">${fmtHz(axisFreq((x + 0.5) / sg.cols))}</div>`,
      tipRow('Time', k === 0 ? 'newest row' : `${fmtDb(-age)} s`),
      tipRow('Level', v === 0 ? `≤ ${fmtDb(this.sgFloor, 0)} dB` : `${fmtDb(db)} dB`),
      `<div class="k small">${this.saved ? 'its 1/3-octave band, from the CSV' : 'loudest FFT bin in this pixel'}</div>`,
    ], e);
  }

  showTip(lines, e) {
    const tip = this.tooltip;
    tip.className = 'tooltip';
    tip.innerHTML = lines.join('');
    tip.hidden = false;
    placeTip(tip, e);
  }

  buildBalance() {
    this.balanceRows = OCTAVE_CENTRES.slice(0, BALANCE_SHOWN).map((f) => {
      const row = document.createElement('div');
      row.style.display = 'contents';
      row.className = f === 500 ? 'ref' : '';
      row.innerHTML = `<span class="f">${labelHz(f)} Hz</span><span class="track"><span class="bar"></span></span><span class="v">--</span>`;
      this.balanceEl.append(row);
      return { bar: row.querySelector('.bar'), v: row.querySelector('.v') };
    });
  }

  clear() {
    this.saved = false; // showing a saved CSV's second (showSaved), not live audio
    this.octPower = null;
    this.balanceDb = null;
    this.balanceAge = 0; // the first readings wait for half a second of the new average
    this.lastT = null;
    // Nothing left to draw: a pending render() would read the cleared values.
    this.dirty = false;
    this.balanceDirty = false;
    this.thirdPower = null;
    this.levels = null;
    this.fine = null;
    if (this.sg) {
      this.sg.count = 0;
      this.repaintHistory();
      this.drawSpectrogram();
    }
    if (this.bw) this.bands.getContext('2d').clearRect(0, 0, this.bw, this.bh);
    for (const r of this.balanceRows) {
      r.bar.style.width = '0';
      r.v.textContent = '--';
    }
  }

  // One analyzer frame. t: the frame's time on the audio clock (s), which places the
  // spectrogram row and times the averages. fineAnalyser: a longer FFT of the same audio,
  // used below FINE_MAX_HZ.
  update(analyser, sampleRate, t, fineAnalyser = null) {
    if (!this.data || this.data.length !== analyser.frequencyBinCount) this.data = new Float32Array(analyser.frequencyBinCount);
    analyser.getFloatFrequencyData(this.data);
    this.updateData(this.data, sampleRate, t, fineAnalyser ? readFine(fineAnalyser, sampleRate) : null);
  }

  // Same as update() for spectrum data (dB per FFT bin) obtained elsewhere; fine:
  // { db, binHz } (see readFine). Data without a frame time is dropped: its row couldn't be
  // placed on the audio clock.
  updateData(data, sampleRate, t, fine = null) {
    if (!Number.isFinite(t)) return;
    const dt = frameStep(this.lastT, t);
    this.lastT = t;
    this.data = data;
    this.fine = fine;
    this.levels = thirdOctaveLevels(data, sampleRate, fine);
    const power = this.levels.map((l) => Math.pow(10, l / 10));
    const a = 1 - Math.exp(-dt / 5);
    if (!this.thirdPower) this.thirdPower = power;
    else this.thirdPower = this.thirdPower.map((p, i) => p + (power[i] - p) * a);
    this.addSpectrogramRow(sampleRate, t);
    this.updateBalance(sampleRate, dt);
    this.dirty = true;
  }

  // A saved CSV's second (rows[i].spectrumDb: its 1/3-octave levels in dB): the bars, the
  // 5 s average line and the octave balance over the 5 s up to it, and a coarse spectrogram
  // of the seconds before it, SAVED_ROW_PX pixel rows per second, each band one flat colour.
  showSaved(rows, i) {
    const row = rows[i];
    if (!row || !row.spectrumDb) return this.clear();
    this.saved = true;
    this.levels = row.spectrumDb.map((v) => (v === null ? -Infinity : v));
    const n = this.levels.length;
    const sum = new Float64Array(n);
    let k = 0;
    for (let j = Math.max(0, i - 4); j <= i; j++) {
      const s = rows[j].spectrumDb;
      if (!s) continue;
      for (let q = 0; q < n; q++) sum[q] += s[q] === null ? 0 : Math.pow(10, s[q] / 10);
      k++;
    }
    this.thirdPower = Array.from(sum, (p) => p / k);
    // An octave band is its three 1/3-octave bands (bars 3j..3j+2).
    this.octPower = OCTAVE_CENTRES.map((_, j) => this.thirdPower.slice(3 * j, 3 * j + 3).reduce((a, b) => a + b, 0));
    const ref = 10 * Math.log10(this.octPower[OCTAVE_CENTRES.indexOf(500)]);
    this.balanceDb = this.balanceRows.map((r, j) => 10 * Math.log10(this.octPower[j]) - ref);
    this.renderBalance();
    this.paintSaved(rows, i);
    this.dirty = true;
  }

  // The coarse spectrogram for showSaved. A band level is the sum over its FFT bins, so it is
  // spread back over them (as if an 8192-point FFT at 48 kHz; 32768-point below
  // FINE_MAX_HZ) to land near the live picture's colours.
  paintSaved(rows, i) {
    const sg = this.sg;
    if (!sg) return;
    const half = Math.pow(2, 1 / 6);
    const perBin = THIRD_OCTAVE_CENTRES.map((fc) => 10 * Math.log10(Math.max(1, (fc * (half - 1 / half)) / (fc <= FINE_MAX_HZ ? 48000 / 32768 : 48000 / 8192))));
    const band = new Int32Array(sg.cols);
    for (let x = 0; x < sg.cols; x++) {
      const f = axisFreq((x + 0.5) / sg.cols);
      band[x] = Math.max(0, Math.min(THIRD_OCTAVE_CENTRES.length - 1, Math.round(3 * Math.log2(f / BASE_HZ)) + 16));
    }
    sg.count = Math.min(sg.rows, (i + 1) * SAVED_ROW_PX);
    sg.head = 0;
    for (let k = 0; k < sg.count; k++) {
      const r = rows[i - Math.floor(k / SAVED_ROW_PX)];
      const at = (sg.rows - k) % sg.rows;
      sg.times[at] = r.t - (k % SAVED_ROW_PX) / SAVED_ROW_PX;
      const base = at * sg.cols;
      for (let x = 0; x < sg.cols; x++) {
        const v = r.spectrumDb ? r.spectrumDb[band[x]] : null;
        sg.vals[base + x] = v === null ? 0 : Math.max(0, Math.min(255, Math.round(((v - perBin[band[x]] - this.sgFloor) / (DB_MAX - this.sgFloor)) * 255)));
      }
    }
    sg.colBins = null; // live rows rebuild their column map
    this.repaintHistory();
  }

  // Draws what changed since the last call: call it on animation frames.
  render() {
    if (!this.dirty) return;
    this.dirty = false;
    if (this.balanceDirty) this.renderBalance();
    this.drawBands();
    this.drawSpectrogram();
    if (this.bandHover) this.showBandTip();
    if (this.sgHover) this.showSpectrogramTip();
  }

  // Frequency labels under a plot, at the octave-balance centres.
  drawFreqAxis(ctx, l, r, b) {
    ctx.fillStyle = css('--muted');
    ctx.strokeStyle = css('--muted');
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const f of OCTAVE_CENTRES) {
      const x = Math.round(l + axisPos(f) * (r - l)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, b);
      ctx.lineTo(x, b + 4);
      ctx.stroke();
      ctx.fillText(labelHz(f), x, b + 12);
    }
  }

  // Live bars, plus a thin line for the ~5 s power average: the same averaging as the
  // octave balance, so the line and the balance agree while the bars move.
  drawBands() {
    if (!this.bw || !this.levels) return;
    const levels = this.levels;
    const ctx = this.bands.getContext('2d');
    const w = this.bw, h = this.bh;
    const l = PLOT_L, r = w - PLOT_R, t = 6, b = h - AXIS_B;
    ctx.clearRect(0, 0, w, h);
    ctx.font = '11px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'right';
    ctx.fillStyle = css('--muted');
    ctx.strokeStyle = css('--grid');
    for (let v = -100; v <= DB_MAX; v += 20) {
      const y = Math.round(b - ((v - DB_MIN) / (DB_MAX - DB_MIN)) * (b - t)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(l, y);
      ctx.lineTo(r, y);
      ctx.stroke();
      ctx.fillText(String(v).replace('-', '−'), l - 4, y);
    }
    const n = levels.length;
    const slot = (r - l) / n;
    const bar = Math.max(1, slot - 2); // 2px surface gap between bars
    const yOf = (db) => b - ((Math.max(DB_MIN, Math.min(DB_MAX, db)) - DB_MIN) / (DB_MAX - DB_MIN)) * (b - t);
    for (let i = 0; i < n; i++) {
      // Darker bars: the centres of the octave-balance bands.
      ctx.fillStyle = css(isOctaveCentre(i) ? '--series-1-dark' : '--series-1');
      const y = yOf(levels[i]);
      const x = l + i * slot + 1;
      if (b - y > 0.5) {
        ctx.beginPath();
        ctx.roundRect(x, y, bar, b - y, [Math.min(4, bar / 2), Math.min(4, bar / 2), 0, 0]);
        ctx.fill();
      }
    }
    if (this.bandHover) {
      ctx.fillStyle = 'rgba(255,255,255,0.08)';
      ctx.fillRect(l + this.bandHover.i * slot, t, slot, b - t);
    }
    ctx.strokeStyle = css('--text-2');
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    this.thirdPower.forEach((p, i) => {
      const y = yOf(10 * Math.log10(p));
      if (i === 0) ctx.moveTo(l + slot / 2, y);
      else ctx.lineTo(l + i * slot + slot / 2, y);
    });
    ctx.stroke();
    this.drawBalanceLabels(ctx, l, slot, t, yOf);
    ctx.lineWidth = 1;
    this.drawFreqAxis(ctx, l, r, b);
  }

  // Adds the newest row at the top of the history (each pixel: the loudest FFT bin in
  // its frequency range). t: audio-clock time of the row (s).
  addSpectrogramRow(sampleRate, t) {
    const sg = this.sg;
    if (!sg) return;
    const nb = this.data.length;
    const fine = this.fine;
    const fineHz = fine ? fine.binHz : 0;
    if (!sg.colBins || sg.sampleRate !== sampleRate || sg.nb !== nb || sg.fineHz !== fineHz) {
      // Columns below FINE_MAX_HZ read the finer spectrum (sg.fineCols of them), the rest the main one.
      const binHz = sampleRate / 2 / nb;
      sg.fineCols = 0;
      if (fine) while (sg.fineCols < sg.cols && axisFreq((sg.fineCols + 1) / sg.cols) <= FINE_MAX_HZ) sg.fineCols++;
      sg.colBins = new Int32Array(sg.cols + 1);
      for (let x = 0; x <= sg.cols; x++) {
        const f = axisFreq(x / sg.cols);
        sg.colBins[x] = x < sg.fineCols ? Math.max(1, Math.min(fine.db.length - 1, Math.round(f / fineHz))) : Math.max(1, Math.min(nb - 1, Math.round(f / binHz)));
      }
      // Where the last fine column ends, in fine bins (colBins[fineCols] is a main bin).
      sg.fineEnd = sg.fineCols ? Math.max(sg.colBins[sg.fineCols - 1] + 1, Math.round(axisFreq(sg.fineCols / sg.cols) / fineHz)) : 0;
      // Its bins are narrower, so broadband sound reads about 6 dB lower per bin there and
      // looks a little darker below FINE_MAX_HZ. Not compensated: a tone (hum, a bass note)
      // reads the same in both, and naming tones is what the bottom of the picture is for.
      sg.sampleRate = sampleRate;
      sg.nb = nb;
      sg.fineHz = fineHz;
    }
    sg.head = (sg.head + 1) % sg.rows;
    sg.count = Math.min(sg.rows, sg.count + 1);
    sg.times[sg.head] = t;
    const base = sg.head * sg.cols;
    const px = sg.row.data;
    for (let x = 0; x < sg.cols; x++) {
      const src = x < sg.fineCols ? fine.db : this.data;
      const b0 = sg.colBins[x], b1 = Math.max(b0, (x + 1 === sg.fineCols ? sg.fineEnd : sg.colBins[x + 1]) - 1);
      let v = -Infinity;
      for (let b = b0; b <= b1 && b < src.length; b++) if (src[b] > v) v = src[b];
      const k = Math.max(0, Math.min(255, Math.round(((v - this.sgFloor) / (DB_MAX - this.sgFloor)) * 255)));
      sg.vals[base + x] = k;
      px[x * 4] = this.lut[k * 3];
      px[x * 4 + 1] = this.lut[k * 3 + 1];
      px[x * 4 + 2] = this.lut[k * 3 + 2];
      px[x * 4 + 3] = 255;
    }
    sg.bctx.drawImage(sg.buf, 0, 1);
    sg.bctx.putImageData(sg.row, 0, 0);
  }

  // History image plus axes: time down the left (newest at the top), frequency below.
  drawSpectrogram() {
    const sg = this.sg;
    if (!sg) return;
    const c = this.sgram;
    const ctx = c.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.drawImage(sg.buf, sg.x0, 0);
    ctx.setTransform(sg.dpr, 0, 0, sg.dpr, 0, 0);
    ctx.font = '11px system-ui, sans-serif';
    ctx.lineWidth = 1;
    const plotB = sg.rows / sg.dpr;
    this.drawFreqAxis(ctx, sg.x0 / sg.dpr, (sg.x0 + sg.cols) / sg.dpr, plotB);
    // Time labels every 5 s, placed by each row's audio-clock time (rows are 100 ms apart,
    // so the labels hold still).
    ctx.textAlign = 'right';
    ctx.fillText('now', PLOT_L - 4, 6);
    if (!sg.count) return;
    const newest = sg.times[sg.head];
    const step = this.saved ? 30 : 5; // a saved CSV's rows are 1 s apart, not 100 ms
    let next = step;
    for (let k = 1; k < sg.count; k++) {
      const age = newest - sg.times[(sg.head - k + sg.rows) % sg.rows];
      if (age < next) continue;
      const y = Math.round(k / sg.dpr) + 0.5;
      if (y > plotB - 6) break;
      ctx.beginPath();
      ctx.moveTo(PLOT_L - 3, y);
      ctx.lineTo(PLOT_L, y);
      ctx.stroke();
      ctx.fillText(next >= 60 ? `−${next / 60} min` : `−${next} s`, PLOT_L - 5, y);
      next = Math.floor(age / step) * step + step;
    }
  }

  // The octave-balance readings (dB vs 500 Hz) on the average line at each octave centre
  // (the darker bars), so the shape and the numbers read at one glance.
  drawBalanceLabels(ctx, l, slot, t, yOf) {
    if (!this.balanceDb) return;
    ctx.font = '600 10px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    this.balanceDb.forEach((d, j) => {
      if (!Number.isFinite(d)) return;
      const i = 3 * j + 1; // the octave's centre 1/3-octave band
      const x = l + i * slot + slot / 2;
      const y = yOf(10 * Math.log10(this.thirdPower[i]));
      ctx.fillStyle = css('--text-2');
      ctx.beginPath();
      ctx.arc(x, y, 2.5, 0, Math.PI * 2);
      ctx.fill();
      const text = fmtDb(d);
      const tw = ctx.measureText(text).width;
      const ly = y - 12 < t + 7 ? y + 12 : y - 12; // above the point, or below near the top
      ctx.fillStyle = 'rgba(20, 20, 19, 0.82)';
      ctx.beginPath();
      ctx.roundRect(x - tw / 2 - 3, ly - 7, tw + 6, 14, 3);
      ctx.fill();
      ctx.fillStyle = css('--text');
      ctx.fillText(text, x, ly);
    });
  }

  updateBalance(sampleRate, dt) {
    const levels = bandLevels(this.data, sampleRate, OCTAVE_CENTRES, 1, this.fine);
    const power = levels.map((l) => Math.pow(10, l / 10));
    const a = 1 - Math.exp(-dt / 5);
    if (!this.octPower) this.octPower = power;
    else this.octPower = this.octPower.map((p, i) => p + (power[i] - p) * a);
    // The average updates every frame; the readings only twice a second (DOM layout is
    // costly), and the bars are written in render(), so not while the page is hidden.
    this.balanceAge = (this.balanceAge || 0) + dt;
    if (this.balanceAge < 0.5) return;
    this.balanceAge = 0;
    const ref = 10 * Math.log10(this.octPower[OCTAVE_CENTRES.indexOf(500)]);
    // Kept for the labels on the spectrum's average line, so both show the same numbers.
    this.balanceDb = this.balanceRows.map((r, i) => 10 * Math.log10(this.octPower[i]) - ref);
    this.balanceDirty = true;
  }

  renderBalance() {
    this.balanceDirty = false;
    if (!this.balanceDb) return;
    this.balanceRows.forEach((r, i) => {
      const d = this.balanceDb[i];
      if (!Number.isFinite(d)) return;
      const c = Math.max(-24, Math.min(24, d));
      const pct = (Math.abs(c) / 24) * 50;
      r.bar.style.left = c >= 0 ? '50%' : `${50 - pct}%`;
      r.bar.style.width = `${pct}%`;
      r.v.textContent = fmtDb(d);
    });
  }
}

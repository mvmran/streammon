// Spectrum display: 1/3-octave bars, scrolling spectrogram and octave balance.
// Fed from an AnalyserNode, which is fine for display (measurements use raw samples).

import { thirdOctaveLevels, THIRD_OCTAVE_CENTRES, bandLevels, OCTAVE_CENTRES } from '../dsp/bands.js';
import { css, fmtDb } from './format.js';

const DB_MIN = -100;
const DB_MAX = -10;
const SG_MIN = 30; // spectrogram frequency range (Hz)
const SG_MAX = 20000;

// Sequential single-hue ramp (dark surface -> blue -> near white) for the spectrogram.
const RAMP = ['#1a1a19', '#104281', '#1c5cab', '#2a78d6', '#5598e7', '#86b6ef', '#cde2fb', '#ffffff'];

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

export class SpectrumView {
  constructor({ bands, sgram, balance }) {
    this.bands = bands;
    this.sgram = sgram;
    this.balanceEl = balance;
    this.lut = buildLut();
    this.data = null;
    this.octPower = null; // smoothed linear power per octave
    this.thirdPower = null; // smoothed linear power per 1/3 octave (the average line)
    // The height attribute is the CSS height. Read it once: setting canvas.height to the
    // device-pixel size rewrites the attribute, so re-reading it would compound the
    // display scale on every resize (the canvas grows until Chrome can't draw it).
    this.cssHeight = new Map([bands, sgram].map((c) => [c, Number(c.getAttribute('height')) || 200]));
    for (const c of [bands, sgram]) new ResizeObserver(() => this.resize(c)).observe(c.parentElement);
    this.buildBalance();
  }

  resize(c) {
    const dpr = window.devicePixelRatio || 1;
    const w = c.parentElement.clientWidth;
    const h = this.cssHeight.get(c);
    if (!w) return;
    c.style.height = `${h}px`;
    if (c === this.sgram) {
      // One device pixel per column; keep the existing image when resizing.
      const old = c.width ? c.getContext('2d').getImageData(0, 0, c.width, c.height) : null;
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
      const ctx = c.getContext('2d');
      ctx.fillStyle = RAMP[0];
      ctx.fillRect(0, 0, c.width, c.height);
      if (old) ctx.putImageData(old, c.width - old.width, 0);
      this.rowBins = null;
    } else {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
      c.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
      this.bw = w;
      this.bh = h;
    }
  }

  buildBalance() {
    this.balanceRows = OCTAVE_CENTRES.slice(0, -1).map((f) => {
      const row = document.createElement('div');
      row.style.display = 'contents';
      row.className = f === 500 ? 'ref' : '';
      row.innerHTML = `<span class="f">${labelHz(f)} Hz</span><span class="track"><span class="bar"></span></span><span class="v">--</span>`;
      this.balanceEl.append(row);
      return { bar: row.querySelector('.bar'), v: row.querySelector('.v') };
    });
  }

  clear() {
    this.octPower = null;
    this.thirdPower = null;
    const c = this.sgram;
    const ctx = c.getContext('2d');
    ctx.fillStyle = RAMP[0];
    ctx.fillRect(0, 0, c.width, c.height);
    if (this.bw) this.bands.getContext('2d').clearRect(0, 0, this.bw, this.bh);
    for (const r of this.balanceRows) {
      r.bar.style.width = '0';
      r.v.textContent = '--';
    }
  }

  // dt: seconds since the last update, for the octave-balance smoothing.
  update(analyser, sampleRate, dt) {
    if (!this.data || this.data.length !== analyser.frequencyBinCount) this.data = new Float32Array(analyser.frequencyBinCount);
    analyser.getFloatFrequencyData(this.data);
    this.updateData(this.data, sampleRate, dt);
  }

  // Same as update() for spectrum data (dB per FFT bin) obtained elsewhere.
  updateData(data, sampleRate, dt) {
    this.data = data;
    this.drawBands(sampleRate, dt);
    this.drawSpectrogramColumn(sampleRate);
    this.updateBalance(sampleRate, dt);
  }

  // Live bars, plus a thin line for the ~5 s power average: the same averaging as the
  // octave balance, so the line and the balance agree while the bars move.
  drawBands(sampleRate, dt) {
    const levels = thirdOctaveLevels(this.data, sampleRate);
    const power = levels.map((l) => Math.pow(10, l / 10));
    const a = 1 - Math.exp(-dt / 5);
    if (!this.thirdPower) this.thirdPower = power;
    else this.thirdPower = this.thirdPower.map((p, i) => p + (power[i] - p) * a);
    if (!this.bw) return;
    const ctx = this.bands.getContext('2d');
    const w = this.bw, h = this.bh;
    const l = 34, r = w - 6, t = 6, b = h - 20;
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
    ctx.fillStyle = css('--series-1');
    ctx.textAlign = 'center';
    for (let i = 0; i < n; i++) {
      const v = Math.max(DB_MIN, Math.min(DB_MAX, levels[i]));
      const y = b - ((v - DB_MIN) / (DB_MAX - DB_MIN)) * (b - t);
      const x = l + i * slot + 1;
      if (b - y > 0.5) {
        ctx.beginPath();
        ctx.roundRect(x, y, bar, b - y, [Math.min(4, bar / 2), Math.min(4, bar / 2), 0, 0]);
        ctx.fill();
      }
    }
    const yOf = (db) => b - ((Math.max(DB_MIN, Math.min(DB_MAX, db)) - DB_MIN) / (DB_MAX - DB_MIN)) * (b - t);
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
    ctx.lineWidth = 1;
    ctx.fillStyle = css('--muted');
    for (let i = 1; i < n; i += 3) {
      ctx.fillText(labelHz(THIRD_OCTAVE_CENTRES[i]), l + i * slot + slot / 2, h - 8);
    }
    ctx.fillStyle = css('--series-1');
  }

  drawSpectrogramColumn(sampleRate) {
    const c = this.sgram;
    const ctx = c.getContext('2d');
    const H = c.height;
    if (!H) return;
    const nb = this.data.length;
    const binHz = sampleRate / 2 / nb;
    if (!this.rowBins || this.rowBins.length !== H) {
      // Log-frequency rows: each row maps to a range of FFT bins.
      this.rowBins = new Int32Array(H + 1);
      for (let y = 0; y <= H; y++) {
        const f = SG_MAX * Math.pow(SG_MIN / SG_MAX, y / H);
        this.rowBins[y] = Math.max(1, Math.min(nb - 1, Math.round(f / binHz)));
      }
      this.col = ctx.createImageData(1, H);
    }
    ctx.drawImage(c, -1, 0);
    const px = this.col.data;
    for (let y = 0; y < H; y++) {
      const b0 = this.rowBins[y + 1], b1 = Math.max(b0, this.rowBins[y]);
      let v = -Infinity;
      for (let b = b0; b <= b1; b++) if (this.data[b] > v) v = this.data[b];
      const k = Math.max(0, Math.min(255, Math.round(((v - DB_MIN) / (DB_MAX - DB_MIN)) * 255)));
      px[y * 4] = this.lut[k * 3];
      px[y * 4 + 1] = this.lut[k * 3 + 1];
      px[y * 4 + 2] = this.lut[k * 3 + 2];
      px[y * 4 + 3] = 255;
    }
    ctx.putImageData(this.col, c.width - 1, 0);
  }

  updateBalance(sampleRate, dt) {
    const levels = bandLevels(this.data, sampleRate, OCTAVE_CENTRES, 1);
    const power = levels.map((l) => Math.pow(10, l / 10));
    const a = 1 - Math.exp(-dt / 5);
    if (!this.octPower) this.octPower = power;
    else this.octPower = this.octPower.map((p, i) => p + (power[i] - p) * a);
    // The average updates every call; the bars only twice a second (DOM layout is costly).
    this.balanceAge = (this.balanceAge || 0) + dt;
    if (this.balanceAge < 0.5) return;
    this.balanceAge = 0;
    const ref = 10 * Math.log10(this.octPower[OCTAVE_CENTRES.indexOf(500)]);
    this.balanceRows.forEach((r, i) => {
      const d = 10 * Math.log10(this.octPower[i]) - ref;
      if (!Number.isFinite(d)) return;
      const c = Math.max(-24, Math.min(24, d));
      const pct = (Math.abs(c) / 24) * 50;
      r.bar.style.left = c >= 0 ? '50%' : `${50 - pct}%`;
      r.bar.style.width = `${pct}%`;
      r.v.textContent = fmtDb(d);
    });
  }
}

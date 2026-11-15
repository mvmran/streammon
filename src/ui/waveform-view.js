// Waveform panel: one capture (src/dsp/waveform.js) drawn sample by sample, with the clipped
// peaks in red (flat tops while the status is CLIPPING, and full-scale runs) and the clip
// ceiling of each 100 ms frame per polarity as a faint dashed line.
// Zoom with the buttons, Ctrl + wheel or a double-click; drag (or Shift + wheel) to pan.

import { css, fmtDb, fmtDuration } from './format.js';
import { ceilingAt } from '../dsp/waveform.js';
import { DEFAULT_CLIP_OPTIONS } from '../dsp/clipdetect.js';

const MIN_VIEW = 24; // samples across the plot at the deepest zoom
const TICK_MS = [0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000];
const GRID_DB = [-1, -3, -6, -12, -20];
const lin = (db) => Math.pow(10, db / 20);

export class WaveformView {
  constructor(canvas, { onView } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.cssHeight = Number(canvas.getAttribute('height')) || 300;
    this.onView = onView; // after every zoom or pan (the panel's readout)
    this.cap = null;
    this.message = '';
    this.a = 0; // view: samples [a, b)
    this.b = 1;
    this.hover = null;
    this.touched = 0; // performance.now() of the last zoom / pan by hand
    this.tooltip = document.getElementById('tooltip');
    new ResizeObserver(() => this.resize()).observe(canvas.parentElement);
    this.bindPointer();
    this.resize();
  }

  get plot() {
    return { l: 52, r: this.w - 12, t: 8, b: this.h - 22 };
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
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.draw();
  }

  clear(message = '') {
    this.cap = null;
    this.message = message;
    this.hover = null;
    this.tooltip.hidden = true;
    this.draw();
    if (this.onView) this.onView();
  }

  // Shows a capture: around its focus (an event's flattest moment) at `focusMs` wide, or
  // whole when it has none.
  show(cap, focusMs = 25) {
    this.cap = cap;
    this.message = '';
    // The amplitude scale: the capture's peak with a little room, at most full scale.
    let peak = 0;
    for (const x of cap.right ? [cap.left, cap.right] : [cap.left]) for (let i = 0; i < x.length; i++) if (Math.abs(x[i]) > peak) peak = Math.abs(x[i]);
    peak = (peak / 32767) * cap.scale;
    this.yMax = Math.max(0.01, Math.min(cap.scale, peak * 1.08));
    if (cap.focus != null) this.zoomTo(cap.focus, (focusMs / 1000) * cap.sampleRate);
    else this.fit();
  }

  get width() {
    return this.b - this.a;
  }

  fit() {
    if (!this.cap) return;
    this.setView(0, this.cap.n);
  }

  zoomTo(centre, width) {
    this.setView(centre - width / 2, centre + width / 2);
  }

  // Zoom by `factor` (< 1 in) keeping sample `at` under the same spot.
  zoom(factor, at = (this.a + this.b) / 2) {
    if (!this.cap) return;
    const w = Math.max(MIN_VIEW, Math.min(this.cap.n, this.width * factor));
    const u = (at - this.a) / this.width;
    this.setView(at - u * w, at - u * w + w);
  }

  pan(samples) {
    this.setView(this.a + samples, this.b + samples);
  }

  setView(a, b) {
    if (!this.cap) return;
    const n = this.cap.n;
    let w = Math.max(Math.min(MIN_VIEW, n), Math.min(n, b - a));
    a = Math.max(0, Math.min(n - w, a));
    this.a = a;
    this.b = a + w;
    this.draw();
    if (this.onView) this.onView();
  }

  // The previous / next clipped peak (dir −1 / 1) from the view's centre, centred. A view
  // wider than 100 ms (an overview) goes to the first / last one in it instead, zoomed in to
  // about 25 ms. False when there is none that way.
  jump(dir) {
    const c = this.cap;
    if (!c || !c.marks.length) return false;
    const wide = this.width > 0.1 * c.sampleRate;
    const mid = wide ? (dir > 0 ? this.a : this.b) : (this.a + this.b) / 2;
    const eps = 0.5;
    const runs = dir > 0 ? c.marks.filter((r) => (r.s + r.e) / 2 > mid + eps) : c.marks.filter((r) => (r.s + r.e) / 2 < mid - eps).reverse();
    if (!runs.length) return false;
    const r = runs[0];
    const width = wide ? 0.025 * c.sampleRate : this.width;
    this.touched = performance.now();
    this.zoomTo((r.s + r.e) / 2, width);
    return true;
  }

  // What the view covers, for the panel's readout.
  get viewInfo() {
    const c = this.cap;
    if (!c) return null;
    return {
      ms: (this.width / c.sampleRate) * 1000,
      from: c.t0 + this.a / c.sampleRate,
      clipped: c.marks.filter((r) => r.e > this.a && r.s < this.b).length,
      allClipped: c.marks.length,
      allFull: c.marks.filter((r) => r.kind === 'full').length,
    };
  }

  // ---------------------------------------------------------------------------
  // Pointer

  sampleAt(x) {
    const p = this.plot;
    return this.a + ((x - p.l) / (p.r - p.l)) * this.width;
  }

  bindPointer() {
    const cv = this.canvas;
    cv.style.touchAction = 'pan-y';
    let drag = null;
    cv.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !this.cap) return;
      drag = { x: e.offsetX, a: this.a };
      cv.setPointerCapture(e.pointerId);
      cv.style.cursor = 'grabbing';
    });
    cv.addEventListener('pointermove', (e) => {
      if (drag && e.buttons & 1) {
        const p = this.plot;
        const ds = ((drag.x - e.offsetX) / (p.r - p.l)) * this.width;
        this.touched = performance.now();
        this.setView(drag.a + ds, drag.a + ds + this.width);
      } else drag = null;
      this.hover = { x: e.offsetX, y: e.offsetY, cx: e.clientX, cy: e.clientY };
      this.draw();
    });
    const end = () => {
      drag = null;
      cv.style.cursor = '';
    };
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) cv.addEventListener(type, end);
    cv.addEventListener('pointerleave', () => {
      this.hover = null;
      this.tooltip.hidden = true;
      this.draw();
    });
    // Ctrl/⌘ + wheel zooms (a plain wheel keeps scrolling the page); Shift + wheel, or a
    // sideways wheel, pans.
    cv.addEventListener('wheel', (e) => {
      if (!this.cap) return;
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        this.touched = performance.now();
        this.zoom(Math.pow(1.0018, e.deltaY), this.sampleAt(e.offsetX));
      } else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        e.preventDefault();
        const d = e.shiftKey ? e.deltaY || e.deltaX : e.deltaX;
        const p = this.plot;
        this.touched = performance.now();
        this.pan((d / (p.r - p.l)) * this.width);
      }
    }, { passive: false });
    cv.addEventListener('dblclick', (e) => {
      if (!this.cap) return;
      this.touched = performance.now();
      this.zoom(e.shiftKey ? 4 : 0.25, this.sampleAt(e.offsetX));
    });
  }

  // ---------------------------------------------------------------------------
  // Drawing

  draw() {
    const ctx = this.ctx;
    if (!this.w) return;
    ctx.clearRect(0, 0, this.w, this.h);
    const p = this.plot;
    const c = this.cap;
    if (!c) {
      ctx.fillStyle = css('--muted');
      ctx.font = '13px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(this.message, (p.l + p.r) / 2, (p.t + p.b) / 2);
      return;
    }
    const chans = c.right ? [c.left, c.right] : [c.left];
    const laneH = (p.b - p.t) / chans.length;
    const k = c.scale / 32767;
    chans.forEach((x, ch) => {
      const top = p.t + ch * laneH;
      const mid = top + laneH / 2;
      const half = laneH / 2 - 4;
      const y = (v) => mid - (v / this.yMax) * half;
      this.drawLaneGrid(ctx, p, top, laneH, y, ch, chans.length);
      this.drawCeilings(ctx, p, y);
      ctx.save();
      ctx.beginPath();
      ctx.rect(p.l, top, p.r - p.l, laneH);
      ctx.clip();
      this.drawTrace(ctx, p, x, k, y, 0, c.n, css('--series-1'), 1.25);
      for (const r of c.marks) {
        if (r.ch !== ch || r.e <= this.a || r.s >= this.b) continue;
        // Drawn a little past the top so a short flat top still shows at a wide view.
        this.drawTrace(ctx, p, x, k, y, Math.max(0, r.s - 1), Math.min(c.n, r.e + 1), css('--critical'), 3);
        this.markClip(ctx, p, r, top);
      }
      ctx.restore();
    });
    this.drawTimeAxis(ctx, p);
    if (this.hover) this.drawHover(ctx, p, chans, laneH, k);
  }

  xOf(i) {
    const p = this.plot;
    return p.l + ((i - this.a) / this.width) * (p.r - p.l);
  }

  drawLaneGrid(ctx, p, top, laneH, y, ch, lanes) {
    ctx.font = '11px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'right';
    ctx.lineWidth = 1;
    // 0 line, then dB gridlines that fit the scale, both polarities.
    const levels = GRID_DB.filter((db) => lin(db) < this.yMax * 0.98);
    const shown = levels.filter((db, i) => i === 0 || Math.abs(y(lin(levels[i - 1])) - y(lin(db))) >= 16);
    for (const db of shown) {
      for (const s of [1, -1]) {
        const yy = Math.round(y(s * lin(db))) + 0.5;
        ctx.strokeStyle = css('--grid');
        ctx.beginPath();
        ctx.moveTo(p.l, yy);
        ctx.lineTo(p.r, yy);
        ctx.stroke();
        ctx.fillStyle = css('--muted');
        ctx.fillText(fmtDb(db, 0), p.l - 6, yy);
      }
    }
    // Full scale, when it is on the scale.
    if (this.yMax >= 0.999) {
      ctx.strokeStyle = css('--axis');
      for (const s of [1, -1]) {
        const yy = Math.round(y(s)) + 0.5;
        ctx.beginPath();
        ctx.moveTo(p.l, yy);
        ctx.lineTo(p.r, yy);
        ctx.stroke();
      }
    }
    const y0 = Math.round(y(0)) + 0.5;
    ctx.strokeStyle = css('--axis');
    ctx.beginPath();
    ctx.moveTo(p.l, y0);
    ctx.lineTo(p.r, y0);
    ctx.stroke();
    // The lane's name inside the plot, on a backing so the trace can't hide it.
    const name = lanes > 1 ? (ch ? 'R' : 'L') : 'L = R';
    ctx.font = '600 11px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    const tw = ctx.measureText(name).width;
    ctx.fillStyle = css('--surface');
    ctx.fillRect(p.l + 4, top + 4, tw + 8, 16);
    ctx.fillStyle = css('--text-2');
    ctx.fillText(name, p.l + 8, top + 6);
    if (ch > 0) {
      ctx.strokeStyle = css('--axis');
      ctx.beginPath();
      ctx.moveTo(p.l, Math.round(top) + 0.5);
      ctx.lineTo(p.r, Math.round(top) + 0.5);
      ctx.stroke();
    }
  }

  // Each frame's clip ceiling per polarity, faint and dashed, for reference.
  drawCeilings(ctx, p, y) {
    const c = this.cap;
    const o = DEFAULT_CLIP_OPTIONS;
    const frames = c.ceilings.length / 2;
    for (let f = 0; f < frames; f++) {
      const s = Math.max(this.a, c.ceilStart + f * c.frameLen);
      const e = Math.min(this.b, c.ceilStart + (f + 1) * c.frameLen);
      if (e <= s) continue;
      const x0 = Math.max(p.l, this.xOf(s)), x1 = Math.min(p.r, this.xOf(e));
      for (const [pol, sign] of [[0, 1], [1, -1]]) {
        const db = c.ceilings[f * 2 + pol];
        if (!(db > o.minCeilingDb)) continue;
        const yc = Math.round(y(sign * lin(db))) + 0.5;
        ctx.strokeStyle = css('--muted');
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.moveTo(x0, yc);
        ctx.lineTo(x1, yc);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
  }

  // Samples [s, e) of `x` within the view: min/max per pixel column when zoomed out, a line
  // through the samples when zoomed in, with a dot on each once they are 6 px apart.
  drawTrace(ctx, p, x, k, y, s, e, colour, width) {
    const a = Math.max(s, Math.floor(this.a) - 1), b = Math.min(e, Math.ceil(this.b) + 1);
    if (b <= a) return;
    const pxPerSample = (p.r - p.l) / this.width;
    ctx.strokeStyle = ctx.fillStyle = colour;
    ctx.lineWidth = width;
    ctx.lineJoin = 'round';
    if (pxPerSample < 1) {
      // One vertical stroke per pixel column covering its samples' range.
      const x0 = Math.floor(this.xOf(a)), x1 = Math.ceil(this.xOf(b));
      ctx.beginPath();
      let prevLo = null, prevHi = null;
      for (let px = Math.max(p.l, x0); px < Math.min(p.r, x1); px++) {
        const i0 = Math.max(a, Math.floor(this.sampleAt(px)));
        const i1 = Math.min(b, Math.max(i0 + 1, Math.floor(this.sampleAt(px + 1))));
        let lo = Infinity, hi = -Infinity;
        for (let i = i0; i < i1; i++) {
          const v = x[i];
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
        if (lo === Infinity) continue;
        // Join to the neighbouring column so steep edges have no gaps.
        if (prevLo !== null) {
          lo = Math.min(lo, prevHi);
          hi = Math.max(hi, prevLo);
        }
        prevLo = lo;
        prevHi = hi;
        const yTop = y(hi * k), yBot = y(lo * k);
        ctx.moveTo(px + 0.5, yTop);
        ctx.lineTo(px + 0.5, Math.max(yBot, yTop + 1));
      }
      ctx.lineWidth = width > 2 ? 2 : 1;
      ctx.stroke();
      return;
    }
    ctx.beginPath();
    for (let i = a; i < b; i++) {
      const px = this.xOf(i), py = y(x[i] * k);
      if (i === a) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();
    if (pxPerSample >= 6) {
      const r = width > 2 ? 2.5 : 2;
      for (let i = a; i < b; i++) {
        ctx.beginPath();
        ctx.arc(this.xOf(i), y(x[i] * k), r, 0, 2 * Math.PI);
        ctx.fill();
      }
    }
  }

  // A tick along the top of the lane for each clipped peak, so they show at any zoom.
  markClip(ctx, p, r, top) {
    const x0 = Math.max(p.l, this.xOf(r.s)), x1 = Math.min(p.r, this.xOf(r.e));
    ctx.fillStyle = css('--critical');
    ctx.fillRect(x0, top + 1, Math.max(2, x1 - x0), r.kind === 'full' ? 6 : 3);
  }

  drawTimeAxis(ctx, p) {
    const c = this.cap;
    const sr = c.sampleRate;
    const msPerPx = ((this.width / sr) * 1000) / (p.r - p.l);
    const step = TICK_MS.find((s) => s / msPerPx >= 90) || TICK_MS[TICK_MS.length - 1];
    const digits = step >= 1000 ? 0 : step >= 100 ? 1 : step >= 10 ? 2 : step >= 1 ? 3 : 4;
    const t0 = c.t0 * 1000; // ms, session time
    const from = t0 + (this.a / sr) * 1000, to = t0 + (this.b / sr) * 1000;
    ctx.font = '11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let ms = Math.ceil(from / step) * step; ms <= to; ms += step) {
      const x = Math.round(this.xOf(((ms - t0) / 1000) * sr)) + 0.5;
      ctx.strokeStyle = css('--grid');
      ctx.beginPath();
      ctx.moveTo(x, p.t);
      ctx.lineTo(x, p.b);
      ctx.stroke();
      ctx.fillStyle = css('--muted');
      ctx.fillText(fmtTime(ms / 1000, digits), x, p.b + 5);
    }
  }

  drawHover(ctx, p, chans, laneH, k) {
    const h = this.hover, c = this.cap, tip = this.tooltip;
    if (h.x < p.l || h.x > p.r || h.y < p.t || h.y > p.b) {
      tip.hidden = true;
      return;
    }
    const i = Math.max(0, Math.min(c.n - 1, Math.round(this.sampleAt(h.x))));
    const x = Math.round(this.xOf(i)) + 0.5;
    ctx.strokeStyle = css('--text-2');
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, p.t);
    ctx.lineTo(x, p.b);
    ctx.stroke();
    const ch = Math.min(chans.length - 1, Math.floor((h.y - p.t) / laneH));
    const v = chans[ch][i] * k;
    const pol = v < 0 ? 1 : 0;
    const ceil = ceilingAt(c, i, pol);
    const run = c.marks.find((r) => r.ch === ch && r.s <= i && i < r.e);
    const row = (key, val) => `<div class="row"><span class="k">${key}</span><span class="val">${val}</span></div>`;
    const level = v === 0 ? '−∞' : fmtDb(20 * Math.log10(Math.abs(v)), 2);
    tip.className = 'tooltip';
    tip.innerHTML = [
      `<div class="k">${fmtTime(c.t0 + i / c.sampleRate, 4)} · sample ${i + 1} of ${c.n}</div>`,
      row(chans.length > 1 ? (ch ? 'Right' : 'Left') : 'Left = right', `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(4)}`),
      row('Level', `${level} dBFS`),
      row(`Ceiling (${pol ? '−' : '+'})`, Number.isFinite(ceil) ? `${fmtDb(ceil)} dBFS` : '--'),
      run ? `<div class="k">Clipped, ${run.kind === 'full' ? 'at full scale' : 'flat top'}: ${run.e - run.s} samples (${(((run.e - run.s) / c.sampleRate) * 1000).toFixed(2)} ms)</div>` : '',
    ].join('');
    tip.hidden = false;
    const tw = tip.offsetWidth;
    tip.style.left = `${h.cx + 14 + tw > window.innerWidth ? h.cx - 14 - tw : h.cx + 14}px`;
    tip.style.top = `${Math.max(4, h.cy - 20)}px`;
  }
}

// Session time as m:ss.ddd (h:mm:ss.ddd past an hour).
export function fmtTime(sec, digits = 3) {
  const m = Math.pow(10, digits);
  const r = Math.round(Math.max(0, sec) * m);
  const whole = Math.floor(r / m);
  return fmtDuration(whole) + (digits ? '.' + String(r - whole * m).padStart(digits, '0') : '');
}

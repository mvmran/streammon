// Stereo by octave band: one dot per band, placed by balance (left/right) and L/R
// correlation (mono at the top, out of phase at the bottom); dot size follows the band's
// level and its shade the frequency (dark = bass, light = treble), with the band named
// beside it. Bands below JUDGE_DB are outlined and left out of the summary line. Fed from frame.bands (src/dsp/stereobands.js).

import { css, fmtDb } from './format.js';
import { STEREO_RULES } from '../dsp/stereobands.js';

// Ordinal one-hue ramp, validated for the dark surface: five shades, two octaves each.
const SHADES = ['#184f95', '#2a78d6', '#5598e7', '#86b6ef', '#cde2fb'];
const shadeOf = (i) => SHADES[Math.min(SHADES.length - 1, Math.floor(i / 2))];
const LEVEL_RANGE = 40; // dB below the loudest band at which a dot reaches minimum size
const HIDE_BELOW = 50; // dB below the loudest band: too quiet to place reliably
// Below this a band is mostly the source's own noise (e.g. two mic capsules' independent
// hiss reads as near-zero or negative correlation): drawn as an outline, not judged.
const JUDGE_DB = STEREO_RULES.judgeDb;
const R_MIN = 1.2, R_MAX = 7; // dot radius (CSS px); hover still finds small dots within 12 px
const BAL_TICK = 6; // dB, gridlines either side of centre
const BAL_MARKS = [3, 6, 10, 20]; // dB, labelled ticks either side (the edges are one side only)
// Rough area where the bands of a healthy stereo mix sit: a half-ellipse hanging from the
// mono line, ±3 dB of balance wide and down to correlation +0.2 at the centre. A guide, not
// a rule: bass belongs near the top, wide reverb or keys can dip a little below.
const ZONE_BAL_DB = 3;
const ZONE_CORR = 0.2;

const labelHz = (f) => (f >= 1000 ? `${Math.round(f / 100) / 10}k` : String(Math.round(f)));
// Balance in dB (R over L) to -1…+1: the share of energy, (R² − L²) / (R² + L²).
const balancePos = (db) => {
  const g = Math.pow(10, db / 10);
  return (g - 1) / (g + 1);
};
const fmtBalance = (db) => (Math.abs(db) < 0.05 ? 'centre' : `${db < 0 ? 'L' : 'R'} ${Math.abs(db).toFixed(1)} dB`);

export class StereoBandsView {
  constructor(canvas, note) {
    this.canvas = canvas;
    this.note = note;
    this.tooltip = document.getElementById('tooltip');
    this.cssHeight = Number(canvas.getAttribute('height')) || 220;
    this.bands = null;
    this.dots = []; // drawn dots, for hover: { x, y, r, band }
    this.hover = null; // pointer event
    this.addLegend();
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

  addLegend() {
    const el = document.createElement('div');
    el.className = 'stereo-legend small';
    el.innerHTML =
      '<span>31 Hz</span>' +
      SHADES.map((c) => `<span class="sw" style="background:${c}"></span>`).join('') +
      '<span>16k</span><span class="sep">size = level</span>' +
      '<span class="sep"><span class="zone"></span> healthy mix</span>';
    this.canvas.parentElement.after(el);
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

  render(bands) {
    this.bands = bands || null;
    this.draw();
    this.renderNote();
    if (this.hover) this.showTip();
  }

  clear() {
    this.render(null);
    if (this.note) this.note.textContent = '--';
  }

  // Bands loud enough to place, with their position and size.
  placed() {
    const bands = this.bands;
    if (!bands) return [];
    const valid = bands.map((b, i) => ({ ...b, i })).filter((b) => b.correlation !== null);
    if (!valid.length) return [];
    const top = Math.max(...valid.map((b) => b.levelDb));
    return valid
      .filter((b) => b.levelDb > top - HIDE_BELOW)
      .map((b) => ({ ...b, rel: b.levelDb - top }));
  }

  draw() {
    if (!this.w) return;
    const ctx = this.canvas.getContext('2d');
    const w = this.w, h = this.h;
    const p = { l: 42, r: w - 10, t: 10, b: h - 36 };
    const cx = (p.l + p.r) / 2;
    const xOf = (db) => cx + balancePos(db) * ((p.r - p.l) / 2);
    const yOf = (c) => p.t + ((1 - c) / 2) * (p.b - p.t);
    ctx.clearRect(0, 0, w, h);
    ctx.font = '11px system-ui, sans-serif';
    ctx.textBaseline = 'middle';

    // Out-of-phase half, then the grid.
    ctx.fillStyle = 'rgba(255,255,255,0.035)';
    ctx.fillRect(p.l, yOf(0), p.r - p.l, p.b - yOf(0));
    ctx.strokeStyle = css('--grid');
    ctx.lineWidth = 1;
    ctx.fillStyle = css('--muted');
    ctx.textAlign = 'right';
    for (const c of [1, 0.5, 0, -0.5, -1]) {
      const y = Math.round(yOf(c)) + 0.5;
      ctx.strokeStyle = css(c === 0 ? '--axis' : '--grid');
      ctx.beginPath();
      ctx.moveTo(p.l, y);
      ctx.lineTo(p.r, y);
      ctx.stroke();
      ctx.fillText(c > 0 ? `+${c}` : String(c).replace('-', '−'), p.l - 5, y);
    }
    ctx.save();
    ctx.translate(8, (p.t + p.b) / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.fillText('correlation', 0, 0);
    ctx.restore();
    for (const db of [-BAL_TICK, 0, BAL_TICK]) {
      const x = Math.round(xOf(db)) + 0.5;
      ctx.strokeStyle = css(db === 0 ? '--axis' : '--grid');
      ctx.beginPath();
      ctx.moveTo(x, p.t);
      ctx.lineTo(x, p.b);
      ctx.stroke();
    }
    // Healthy-mix zone.
    const zx = xOf(ZONE_BAL_DB) - cx, zy = yOf(ZONE_CORR) - yOf(1);
    ctx.beginPath();
    ctx.ellipse(cx, yOf(1), zx, zy, 0, 0, Math.PI);
    ctx.closePath();
    ctx.fillStyle = 'rgba(255,255,255,0.05)';
    ctx.fill();
    ctx.setLineDash([4, 3]);
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.stroke();
    ctx.setLineDash([]);
    // Balance axis: ticks at BAL_MARKS on both sides, labelled where they fit (the scale is
    // compressed towards the edges, which mean one channel only).
    ctx.fillStyle = css('--muted');
    ctx.strokeStyle = css('--muted');
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
        const xx = Math.round(x) + 0.5;
        ctx.beginPath();
        ctx.moveTo(xx, p.b);
        ctx.lineTo(xx, p.b + 4);
        ctx.stroke();
      }
    }
    label('C', cx, 'center');
    label('L only', p.l, 'left');
    label('R only', p.r, 'right');
    for (const db of BAL_MARKS) {
      label(String(db), xOf(-db), 'center');
      label(String(db), xOf(db), 'center');
    }
    ctx.textAlign = 'center';
    ctx.fillText('balance: dB louder on that side', cx, p.b + 27);
    ctx.textAlign = 'left';
    ctx.fillText('mono', p.l + 4, p.t + 8);
    ctx.fillText('out of phase', p.l + 4, p.b - 8);

    // Dots, quietest first so the loudest sit on top, each with a 2px surface ring
    // drawn outside the dot so small dots keep their full size.
    const placed = this.placed().sort((a, b) => a.rel - b.rel);
    this.dots = placed.map((b) => ({
      x: xOf(b.balanceDb),
      y: yOf(b.correlation),
      r: R_MIN + (R_MAX - R_MIN) * Math.max(0, Math.min(1, (b.rel + LEVEL_RANGE) / LEVEL_RANGE)),
      band: b,
    }));
    for (const d of this.dots) {
      if (d.band.levelDb >= JUDGE_DB) {
        ctx.beginPath();
        ctx.arc(d.x, d.y, d.r + 1, 0, 2 * Math.PI);
        ctx.lineWidth = 2;
        ctx.strokeStyle = css('--surface');
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(d.x, d.y, d.r, 0, 2 * Math.PI);
        ctx.fillStyle = shadeOf(d.band.i);
        ctx.fill();
      } else {
        ctx.beginPath();
        ctx.arc(d.x, d.y, Math.max(d.r, 2.5), 0, 2 * Math.PI);
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = shadeOf(d.band.i);
        ctx.stroke();
      }
    }
    // Band names beside the dots, loudest first, skipping any that would overlap.
    ctx.lineWidth = 1;
    ctx.fillStyle = css('--text-2');
    ctx.font = '10px system-ui, sans-serif';
    const boxes = [];
    for (const d of [...this.dots].reverse()) {
      const text = labelHz(d.band.fc);
      const tw = ctx.measureText(text).width;
      let x = d.x + d.r + 3;
      if (x + tw > w - 2) x = d.x - d.r - 3 - tw;
      const box = { x0: x - 1, x1: x + tw + 1, y0: d.y - 6, y1: d.y + 6 };
      if (boxes.some((o) => box.x0 < o.x1 && box.x1 > o.x0 && box.y0 < o.y1 && box.y1 > o.y0)) continue;
      boxes.push(box);
      ctx.textAlign = 'left';
      ctx.fillText(text, x, d.y);
    }
  }

  // One line under the plot: what stands out, judged on bands within 30 dB of the loudest.
  renderNote() {
    if (!this.note) return;
    const placed = this.placed();
    const main = placed.filter((b) => b.rel > -30 && b.levelDb >= JUDGE_DB);
    if (!main.length) {
      this.note.textContent = placed.length ? `Too quiet to judge: every band is below ${fmtDb(JUDGE_DB, 0)} dBFS` : '--';
      return;
    }
    const parts = [];
    if (main.every((b) => b.correlation >= 0.99 && Math.abs(b.balanceDb) < 0.5)) {
      parts.push('All bands mono and centred');
    } else {
      const widest = main.reduce((a, b) => (b.correlation < a.correlation ? b : a));
      parts.push(`Widest: ${labelHz(widest.fc)} (corr ${widest.correlation.toFixed(2)})`);
      const off = main.reduce((a, b) => (Math.abs(b.balanceDb) > Math.abs(a.balanceDb) ? b : a));
      if (Math.abs(off.balanceDb) >= 1) parts.push(`most off-centre: ${labelHz(off.fc)}, ${fmtBalance(off.balanceDb)}`);
      const flipped = main.filter((b) => b.correlation < 0).map((b) => labelHz(b.fc));
      if (flipped.length) parts.push(`out of phase: ${flipped.join(', ')}`);
    }
    this.note.textContent = parts.join(' · ');
  }

  showTip() {
    const e = this.hover;
    let best = null, bestD = Infinity;
    for (const d of this.dots) {
      const dist = Math.hypot(d.x - e.offsetX, d.y - e.offsetY);
      if (dist < Math.max(12, d.r + 4) && dist < bestD) {
        best = d;
        bestD = dist;
      }
    }
    const tip = this.tooltip;
    if (!best) {
      tip.hidden = true;
      return;
    }
    const b = best.band;
    const row = (k, v) => `<div class="row"><span class="k">${k}</span><span class="val">${v}</span></div>`;
    tip.className = 'tooltip';
    tip.innerHTML = [
      `<div class="k">${labelHz(b.fc)} octave</div>`,
      row('Correlation', b.correlation.toFixed(2)),
      row('Balance', fmtBalance(b.balanceDb)),
      row('Level', `${fmtDb(b.levelDb)} dBFS`),
      b.levelDb < JUDGE_DB ? `<div class="k">Too quiet to judge: mostly noise</div>` : '',
    ].join('');
    tip.hidden = false;
    const tw = tip.offsetWidth;
    tip.style.left = `${e.clientX + 14 + tw > window.innerWidth ? e.clientX - 14 - tw : e.clientX + 14}px`;
    tip.style.top = `${Math.max(4, e.clientY - 20)}px`;
  }
}

// Canvas time-series chart used for loudness history, the peak strip and the file
// timeline. One y axis, thin lines, recessive grid, crosshair tooltip on hover.

import { css, fmtDb } from './format.js';

const STATUS_COLOUR = { CLIPPING: '--critical', LIMITED: '--warning', CLEAN: '--good' };
const STATUS_FAINT = new Set(['CLEAN']); // drawn at reduced opacity: the normal state
const X_STEPS = [5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];

export class TimeChart {
  // opts: { yMin, yMax, yStep, series: [{ key, label, colour, format(v), axis: 'right' }],
  //         right: { min, max, step, unit, span: [from, to] } (a second scale on the right for
  //         axis: 'right' series, over the [from, to] fraction of the plot height, 0 = bottom), band: { from, to, label },
  //         refs: (chart) => [{ y, label, dash }], statusStrip, statusKey, statusColours,
  //         statusFaint, xFormat(t), onClick(t), onScrub(t), canScrub(), unit }
  // onScrub(t) is called while the pointer is held down and dragged across the plot (once
  // per animation frame at most), and on pressing.
  constructor(canvas, opts) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.opts = { yStep: 10, unit: 'dB', ...opts };
    this.cssHeight = Number(canvas.getAttribute('height')) || 200;
    this.rows = [];
    this.xStart = 0;
    this.xEnd = 60;
    this.hoverX = null;
    this.cursor = null;
    this.tooltip = document.getElementById('tooltip');
    this.addLegend();
    new ResizeObserver(() => this.resize()).observe(canvas.parentElement);
    canvas.addEventListener('pointermove', (e) => this.onHover(e));
    canvas.addEventListener('pointerleave', () => {
      this.hoverX = null;
      this.tooltip.hidden = true;
      this.draw();
    });
    if (opts.onClick) canvas.addEventListener('click', (e) => opts.onClick(this.tAt(e)));
    if (opts.onScrub) this.addScrub(opts.onScrub, opts.canScrub);
    this.resize();
  }

  // canScrub(): whether a press should scrub now (a saved CSV), so audio files keep plain
  // clicks: capturing the pointer would also turn a drag released off the canvas into a
  // click on it.
  addScrub(onScrub, canScrub = () => true) {
    const canvas = this.canvas;
    canvas.style.touchAction = 'pan-y'; // a horizontal drag scrubs; a vertical one still scrolls
    let held = false, t = 0, frame = 0;
    const fire = () => {
      frame = 0;
      if (held) onScrub(t);
    };
    const scrub = (e) => {
      t = this.tAt(e);
      if (!frame) frame = requestAnimationFrame(fire);
    };
    canvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !canScrub()) return;
      held = true;
      canvas.setPointerCapture(e.pointerId); // keeps scrubbing past the plot's edges
      scrub(e);
    });
    // Only while the button is still down: a release can go missing (Alt+Tab mid-drag).
    canvas.addEventListener('pointermove', (e) => {
      if (held && e.buttons & 1) scrub(e);
      else held = false;
    });
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) canvas.addEventListener(type, () => (held = false));
  }

  addLegend() {
    const { series } = this.opts;
    if (series.length < 2) return;
    const el = document.createElement('div');
    el.className = 'legend small';
    el.style.cssText = 'display:flex;gap:16px;margin-top:6px;color:var(--text-2)';
    for (const s of series) {
      const item = document.createElement('span');
      item.style.cssText = 'display:inline-flex;align-items:center;gap:6px';
      item.innerHTML = `<span style="width:14px;height:3px;border-radius:2px;background:var(${s.colour})"></span>${s.label}`;
      el.append(item);
    }
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
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.stale = true;
    this.draw();
  }

  setData(rows, xStart, xEnd) {
    this.rows = rows;
    this.xStart = xStart;
    this.xEnd = Math.max(xEnd, xStart + 1);
    this.stale = true;
    this.draw();
  }

  setCursor(t) {
    this.cursor = t;
    this.draw();
  }

  get plot() {
    const strip = this.opts.statusStrip ? 10 : 0;
    return { l: 46, r: this.w - (this.opts.right ? 42 : 12), t: 8, b: this.h - 22 - strip, strip };
  }

  x(t) {
    const p = this.plot;
    return p.l + ((t - this.xStart) / (this.xEnd - this.xStart)) * (p.r - p.l);
  }

  y(v) {
    const p = this.plot;
    const { yMin, yMax } = this.opts;
    const c = Math.max(yMin, Math.min(yMax, v));
    return p.b - ((c - yMin) / (yMax - yMin)) * (p.b - p.t);
  }

  // y for a series value, on the right-hand scale for axis: 'right' series.
  ys(s, v) {
    const r = this.opts.right;
    if (s.axis !== 'right' || !r) return this.y(v);
    return this.yRight(Math.max(r.min, Math.min(r.max, v)));
  }

  yRight(v) {
    const p = this.plot, r = this.opts.right;
    const [from, to] = r.span || [0, 1];
    const f = from + ((v - r.min) / (r.max - r.min)) * (to - from);
    return p.b - f * (p.b - p.t);
  }

  tAt(e) {
    const r = this.canvas.getBoundingClientRect();
    const p = this.plot;
    const f = (e.clientX - r.left - p.l) / (p.r - p.l);
    return this.xStart + Math.max(0, Math.min(1, f)) * (this.xEnd - this.xStart);
  }

  nearest(t) {
    const rows = this.rows;
    if (!rows.length) return null;
    let lo = 0, hi = rows.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (rows[mid].t < t) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0 && Math.abs(rows[lo - 1].t - t) < Math.abs(rows[lo].t - t)) lo--;
    return rows[lo];
  }

  onHover(e) {
    const row = this.nearest(this.tAt(e));
    if (!row || row.t < this.xStart || row.t > this.xEnd) return;
    this.hoverX = row.t;
    this.draw();
    const lines = [`<div class="k">${this.opts.xFormat(row.t, row)}</div>`];
    for (const s of this.opts.series) {
      const v = row[s.key];
      const text = s.format ? (Number.isFinite(v) ? s.format(v) : '--') : fmtDb(v);
      lines.push(`<div class="row"><span class="sw" style="background:var(${s.colour})"></span><span class="k">${s.label}</span><span class="val">${text}</span></div>`);
    }
    const sk = this.opts.statusKey || 'status';
    if (row[sk]) lines.push(`<div class="row"><span class="k">Status</span><span class="val">${row[sk]}</span></div>`);
    const tip = this.tooltip;
    tip.innerHTML = lines.join('');
    tip.hidden = false;
    const tw = tip.offsetWidth;
    const left = e.clientX + 14 + tw > window.innerWidth ? e.clientX - 14 - tw : e.clientX + 14;
    tip.style.left = `${left}px`;
    tip.style.top = `${Math.max(4, e.clientY - 20)}px`;
  }

  // The plot without the playhead and hover marks is kept as an image until the data, the
  // range or the size changes, so moving those (hovering, scrubbing a 2-hour CSV's
  // timeline) only copies it and draws the marks.
  draw() {
    if (!this.w) return;
    if (this.stale || !this.base) {
      this.base ??= document.createElement('canvas');
      if (this.base.width !== this.canvas.width || this.base.height !== this.canvas.height) {
        this.base.width = this.canvas.width;
        this.base.height = this.canvas.height;
      }
      const bctx = this.base.getContext('2d');
      bctx.setTransform(this.ctx.getTransform());
      this.drawPlot(bctx);
      this.stale = false;
    }
    const ctx = this.ctx;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.drawImage(this.base, 0, 0);
    ctx.restore();
    this.drawMarks(ctx);
  }

  drawPlot(ctx) {
    const o = this.opts;
    const p = this.plot;
    ctx.clearRect(0, 0, this.w, this.h);
    ctx.font = '11px system-ui, sans-serif';
    ctx.textBaseline = 'middle';

    // Target band.
    if (o.band) {
      ctx.fillStyle = 'rgba(255,255,255,0.07)';
      const y1 = this.y(o.band.to), y2 = this.y(o.band.from);
      ctx.fillRect(p.l, y1, p.r - p.l, y2 - y1);
      ctx.fillStyle = css('--text-2');
      ctx.textAlign = 'left';
      ctx.fillText(o.band.label, p.l + 6, y1 + 9);
    }

    // Horizontal grid and y labels.
    ctx.strokeStyle = css('--grid');
    ctx.lineWidth = 1;
    ctx.fillStyle = css('--muted');
    ctx.textAlign = 'right';
    for (let v = Math.ceil(o.yMin / o.yStep) * o.yStep; v <= o.yMax; v += o.yStep) {
      const y = Math.round(this.y(v)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(p.l, y);
      ctx.lineTo(p.r, y);
      ctx.stroke();
      ctx.fillText(String(v).replace('-', '−'), p.l - 6, y);
    }
    ctx.save();
    ctx.translate(10, (p.t + p.b) / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.fillText(o.unit, 0, 0);
    ctx.restore();
    // Right-hand scale: labels only, placed on the left scale's gridlines when the steps line up.
    if (o.right) {
      const r = o.right;
      ctx.textAlign = 'left';
      for (let v = r.min; v <= r.max + 1e-9; v += r.step) {
        const y = this.yRight(v);
        const text = (v > 0 ? `+${v}` : String(Math.round(v * 100) / 100)).replace('-', '−');
        ctx.fillText(text, p.r + 6, Math.round(y) + 0.5);
      }
      ctx.save();
      ctx.translate(this.w - 6, (this.yRight(r.min) + this.yRight(r.max)) / 2);
      ctx.rotate(Math.PI / 2);
      ctx.textAlign = 'center';
      ctx.fillText(r.unit, 0, 0);
      ctx.restore();
    }

    // X ticks.
    const span = this.xEnd - this.xStart;
    const step = X_STEPS.find((s) => span / s <= 8) || 3600;
    ctx.textAlign = 'center';
    ctx.fillStyle = css('--muted');
    for (let t = Math.ceil(this.xStart / step) * step; t <= this.xEnd; t += step) {
      const x = Math.round(this.x(t)) + 0.5;
      ctx.strokeStyle = css('--grid');
      ctx.beginPath();
      ctx.moveTo(x, p.t);
      ctx.lineTo(x, p.b);
      ctx.stroke();
      ctx.fillText(o.xFormat(t), x, this.h - 9);
    }
    // Baseline.
    ctx.strokeStyle = css('--axis');
    ctx.beginPath();
    ctx.moveTo(p.l, p.b + 0.5);
    ctx.lineTo(p.r, p.b + 0.5);
    ctx.stroke();

    // Reference lines, directly labelled.
    const refs = (o.refs ? o.refs(this) : []).filter((r) => Number.isFinite(r.y) && r.y >= o.yMin && r.y <= o.yMax);
    refs.sort((a, b) => b.y - a.y);
    let lastLabel = -Infinity;
    for (const ref of refs) {
      const y = Math.round(this.y(ref.y)) + 0.5;
      // Label above the line, or below it when that would collide with the previous label.
      let ly = y - 8;
      if (ly - lastLabel < 13) ly = Math.max(y + 9, lastLabel + 13);
      lastLabel = ly;
      ctx.strokeStyle = ref.colour ? css(ref.colour) : css('--text-2');
      ctx.setLineDash(ref.dash || [4, 4]);
      ctx.beginPath();
      ctx.moveTo(p.l, y);
      ctx.lineTo(p.r, y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = css('--text-2');
      ctx.textAlign = 'right';
      ctx.fillText(ref.label, p.r - 4, ly);
    }

    // Visible rows.
    const rows = this.rows;
    let first = 0;
    while (first < rows.length && rows[first].t < this.xStart) first++;
    const dt = rows.length > 1 ? rows[1].t - rows[0].t : 1;

    // Status strip under the plot.
    if (o.statusStrip) {
      const sy = p.b + 3;
      const bw = Math.max(1, this.x(this.xStart + dt) - this.x(this.xStart));
      const key = o.statusKey || 'status';
      const colours = o.statusColours || STATUS_COLOUR;
      const faint = o.statusFaint || STATUS_FAINT;
      for (let i = first; i < rows.length; i++) {
        const c = colours[rows[i][key]];
        if (!c) continue;
        ctx.globalAlpha = faint.has(rows[i][key]) ? 0.35 : 1;
        ctx.fillStyle = css(c);
        const x = this.x(rows[i].t - dt);
        ctx.fillRect(x, sy, bw + 0.5, p.strip - 4);
      }
      ctx.globalAlpha = 1;
    }

    // Series.
    ctx.save();
    ctx.beginPath();
    ctx.rect(p.l, p.t - 2, p.r - p.l, p.b - p.t + 4);
    ctx.clip();
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    for (const s of o.series) {
      ctx.strokeStyle = css(s.colour);
      ctx.beginPath();
      let pen = false;
      for (let i = Math.max(0, first - 1); i < rows.length; i++) {
        const v = rows[i][s.key];
        if (!Number.isFinite(v) || (s.axis !== 'right' && v < o.yMin - 20)) {
          pen = false;
          continue;
        }
        const x = this.x(rows[i].t), y = this.ys(s, v);
        if (pen) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
        pen = true;
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  // Playhead and hover crosshair.
  drawMarks(ctx) {
    const o = this.opts;
    const p = this.plot;
    // Playhead.
    if (this.cursor !== null && this.cursor >= this.xStart && this.cursor <= this.xEnd) {
      const x = Math.round(this.x(this.cursor)) + 0.5;
      ctx.strokeStyle = css('--text');
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x, p.t);
      ctx.lineTo(x, p.b + p.strip);
      ctx.stroke();
    }

    // Hover crosshair and markers.
    const row = this.hoverX !== null ? this.nearest(this.hoverX) : null; // none once cleared
    if (row) {
      const x = Math.round(this.x(row.t)) + 0.5;
      ctx.strokeStyle = css('--muted');
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, p.t);
      ctx.lineTo(x, p.b);
      ctx.stroke();
      for (const s of o.series) {
        const v = row[s.key];
        if (!Number.isFinite(v)) continue;
        ctx.fillStyle = css(s.colour);
        ctx.strokeStyle = css('--surface');
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(x, this.ys(s, v), 4.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    }
  }
}

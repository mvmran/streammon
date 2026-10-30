// Mains hum panel: status, measurements and the harmonic bar chart.
// Shared by the web app, the extension dashboard and (in part) the side panel; every
// element is optional and looked up by id.

import { css, fmtDb } from './format.js';
import { harmonicList } from '../dsp/hum.js';

const STATUS_ICON = { PRESENT: '⚠', 'NOT DETECTED': '✓', MASKED: '…', IDLE: '' };
const SIGNATURE = {
  odd: 'odd-dominant: ground loop / unbalanced-line buzz',
  even: 'even-dominant: rectifier / power-supply buzz',
  mixed: 'mixed odd and even harmonics',
};
const IDS = {
  status: 'hum-status', statusText: 'hum-status-text', statusIcon: 'hum-status-icon', statusDetail: 'hum-status-detail',
  mains: 'hum-mains', freq: 'hum-freq', level: 'hum-level', prominence: 'hum-prom', signature: 'hum-signature',
  quiet: 'hum-quiet', below: 'hum-below', projected: 'hum-projected', projectedLabel: 'hum-projected-label',
  harmonics: 'hum-harmonics',
};

function setText(node, text) {
  if (node && node.textContent !== text) node.textContent = text;
}

// Hum in the latest pause (a quiet second): its level and the mains harmonics in it. With
// fewer than three harmonics it is a plain hum, not buzz (and doesn't count for the alert).
function pauseText(p, mainsHz) {
  if (!p) return 'no pause yet';
  const ago = `${Math.round(p.ageSec)} s ago`;
  if (p.levelDb === null) return `none, ${ago}`;
  return `${fmtDb(p.levelDb)} dBFS (${harmonicList(p.lines.map((k) => k * mainsHz))}), ${ago}`;
}

// NOT DETECTED only says no steady hum stands out through the programme: a faint one can
// still show in the pauses, and the panel shouldn't say "nothing" next to that.
const RECENT_PAUSE_SEC = 60;
function notDetectedText(r) {
  const p = r.pause;
  if (p && p.levelDb !== null && p.ageSec <= RECENT_PAUSE_SEC) return `No steady hum through the programme; buzz in pauses at ${fmtDb(p.levelDb)} dBFS`;
  return `Nothing at ${r.mainsHz} Hz; a hum at ${fmtDb(r.maskReferenceDb, 0)} dBFS would show`;
}

export class HumView {
  // getConfig() returns the alert configuration (its .hum section holds the hum settings).
  constructor(getConfig, doc = document) {
    this.getConfig = getConfig;
    this.el = Object.fromEntries(Object.entries(IDS).map(([k, id]) => [k, doc.getElementById(id)]));
    this.result = null;
    if (this.el.harmonics) {
      this.bars = this.el.harmonics;
      this.cssHeight = Number(this.bars.getAttribute('height')) || 160;
      new ResizeObserver(() => this.drawHarmonics()).observe(this.bars.parentElement);
    }
    this.reset();
  }

  reset() {
    this.result = null;
    this.renderStatus('IDLE', 'Waiting for audio');
    for (const k of ['freq', 'level', 'prominence', 'signature', 'quiet', 'below', 'projected']) setText(this.el[k], '--');
    this.renderMains();
    this.drawHarmonics();
  }

  renderMains() {
    setText(this.el.mains, `${this.getConfig().hum.mainsFrequencyHz} Hz mains`);
  }

  renderStatus(status, detail) {
    const s = this.el.status;
    if (s && s.dataset.status !== status) s.dataset.status = status;
    setText(this.el.statusText, status === 'IDLE' ? '--' : status);
    setText(this.el.statusIcon, STATUS_ICON[status] || '');
    setText(this.el.statusDetail, detail);
  }

  render(r) {
    this.result = r;
    this.renderMains();
    const detail =
      r.status === 'PRESENT'
        ? `Steady ${r.fundamentalHz.toFixed(2)} Hz tone, ${fmtDb(r.prominenceDb, 0)} dB above its surroundings`
        : r.status === 'MASKED'
          ? 'Programme too loud near the mains frequency to judge'
          : notDetectedText(r);
    this.renderStatus(r.status, detail);
    const present = r.status === 'PRESENT';
    setText(this.el.freq, present ? `${r.fundamentalHz.toFixed(2)} Hz` : '--');
    setText(this.el.level, present ? `${fmtDb(r.levelDb)} dBFS` : '--');
    setText(this.el.prominence, present ? `${fmtDb(r.prominenceDb, 0)} dB` : '--');
    let sig = '--';
    if (present && !r.harmonicsSettled) sig = 'measuring harmonics\u2026';
    else if (present && r.signature) sig = `${SIGNATURE[r.signature]}${r.signatureTentative ? ' (tentative)' : ''}`;
    else if (present) sig = 'harmonics below the noise floor';
    setText(this.el.signature, sig);
    setText(this.el.quiet, pauseText(r.pause, r.mainsHz));
    setText(this.el.below, present && r.belowProgrammeDb !== null ? `${r.belowProgrammeDb.toFixed(0)} dB below short-term loudness` : '--');
    setText(this.el.projectedLabel, `At ${r.speechTargetLufs} LUFS speech`);
    setText(this.el.projected, present && r.projectedDb !== null ? `hum would be ${fmtDb(r.projectedDb)} dBFS` : '--');
    this.drawHarmonics();
  }

  // Harmonics k = 1…10 in dB relative to the fundamental (phase-locked average). Solid:
  // clearly above its own noise floor; faded: tentative; outline: below the floor.
  drawHarmonics() {
    const c = this.bars;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const w = c.parentElement.clientWidth;
    const h = this.cssHeight;
    if (!w) return;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
      c.style.height = `${h}px`;
    }
    const ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.font = '11px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    const r = this.result;
    const l = 34, rt = w - 6, t = 8, b = h - 20;
    const yMin = -40, yMax = 10;
    const y = (v) => b - ((Math.max(yMin, Math.min(yMax, v)) - yMin) / (yMax - yMin)) * (b - t);
    ctx.strokeStyle = css('--grid');
    ctx.fillStyle = css('--muted');
    ctx.textAlign = 'right';
    for (let v = yMin; v <= yMax; v += 10) {
      const yy = Math.round(y(v)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(l, yy);
      ctx.lineTo(rt, yy);
      ctx.stroke();
      ctx.fillText(String(v).replace('-', '−'), l - 4, yy);
    }
    if (!r || r.status !== 'PRESENT' || !r.harmonicsSettled) {
      ctx.textAlign = 'center';
      ctx.fillText(r && r.status === 'PRESENT' ? 'Measuring harmonics\u2026 (about 20 s)' : 'Shown when hum is present', (l + rt) / 2, (t + b) / 2);
      return;
    }
    const n = r.harmonics.length;
    const slot = (rt - l) / n;
    const bw = Math.max(2, slot - 2); // 2px surface gap
    const zero = y(0);
    ctx.textAlign = 'center';
    for (const hm of r.harmonics) {
      const x = l + (hm.k - 1) * slot + 1;
      // Bars rise from the bottom of the scale like level meters, so the fundamental
      // (0 dB by definition) shows as the reference bar. A harmonic below its noise floor
      // is only known to be below that floor: its outline shows the floor, an upper limit.
      const clear = hm.k === 1 || hm.significant;
      const fund = r.harmonics[0].averageDb;
      const v = clear || hm.tentative ? hm.relativeDb : hm.floorDb - fund;
      const top = y(Number.isFinite(v) ? v : yMin), bottom = b;
      ctx.globalAlpha = clear ? 1 : hm.tentative ? 0.45 : 1;
      if (clear || hm.tentative) {
        ctx.fillStyle = css('--series-2');
        ctx.fillRect(x, top, bw, Math.max(1, bottom - top));
      } else {
        ctx.strokeStyle = css('--muted');
        ctx.strokeRect(x + 0.5, top + 0.5, bw - 1, Math.max(1, bottom - top - 1));
      }
      ctx.globalAlpha = 1;
      ctx.fillStyle = css('--muted');
      ctx.fillText(String(Math.round(hm.freq)), x + bw / 2, h - 8);
    }
    ctx.strokeStyle = css('--axis');
    ctx.beginPath();
    ctx.moveTo(l, Math.round(zero) + 0.5);
    ctx.lineTo(rt, Math.round(zero) + 0.5);
    ctx.stroke();
  }
}

// Event log panel: clip/limit episodes, hum and stereo changes, and alerts, newest first.
// Bounded in the DOM.

import { fmtDb, fmtDuration, escapeHtml } from './format.js';

const MAX_ROWS = 500;
const MAX_KEPT = 5000;

const fmtHz = (f) => `${f.toFixed(2)} Hz`;

const DETECTOR_NAMES = { dwell: 'dwell', pileup: 'pile-up', fullscale: 'full scale' };

export class EventLog {
  constructor(body, empty, { onSeek } = {}) {
    this.body = body;
    this.empty = empty;
    this.onSeek = onSeek;
    this.entries = [];
    body.addEventListener('click', (e) => {
      const tr = e.target.closest('tr[data-t]');
      if (tr && this.onSeek) this.onSeek(Number(tr.dataset.t));
    });
  }

  clear() {
    this.entries = [];
    this.body.textContent = '';
    this.empty.hidden = false;
  }

  // entry: { clock, t, kind: 'CLIPPING' | 'LIMITED' | 'CLEAN' | 'hum' | 'stereo' | 'alert' | 'info', title, ceilingDb, detail, seekable }
  add(entry) {
    this.entries.push(entry);
    if (this.entries.length > MAX_KEPT) this.entries.shift();
    const tr = document.createElement('tr');
    if (entry.seekable) {
      tr.className = 'seekable';
      tr.dataset.t = String(Math.max(0, entry.t - 2));
      tr.title = 'Play from here';
    }
    tr.innerHTML = `<td>${escapeHtml(entry.clock || '')}</td><td>${fmtDuration(entry.t)}</td><td><span class="ev ev-${entry.kind}">${escapeHtml(entry.title)}</span></td><td>${Number.isFinite(entry.ceilingDb) ? `${fmtDb(entry.ceilingDb)} dBFS` : ''}</td><td>${escapeHtml(entry.detail || '')}</td>`;
    this.body.prepend(tr);
    while (this.body.rows.length > MAX_ROWS) this.body.lastElementChild.remove();
    this.empty.hidden = true;
  }

  // Converts an analyzer status event to a log entry.
  static fromEvent(e, clock, seekable = false) {
    if (e.type.startsWith('hum-')) return EventLog.fromHumEvent(e, clock, seekable);
    if (e.type === 'stereo') return EventLog.fromStereoEvent(e, clock, seekable);
    const det = e.detectors.map((d) => DETECTOR_NAMES[d] || d).join(' + ');
    if (e.type === 'start') {
      return {
        clock,
        t: e.t,
        kind: e.status,
        title: e.status === 'CLIPPING' ? 'Clipping started' : 'Limiting started',
        ceilingDb: e.ceilingDb,
        detail: [det && `detector: ${det}`, e.status === 'CLIPPING' ? `pile-up ${e.pileRatio.toFixed(2)}` : ''].filter(Boolean).join(' · '),
        seekable,
      };
    }
    return {
      clock,
      t: e.t,
      kind: 'CLEAN',
      title: e.status === 'CLIPPING' ? 'Clipping ended' : 'Limiting ended',
      ceilingDb: e.ceilingDb,
      detail: [`lasted ${fmtDuration(e.duration)}`, det && `detectors: ${det}`, e.fullScaleSamples ? `${e.fullScaleSamples} full-scale samples` : ''].filter(Boolean).join(' · '),
      seekable,
    };
  }

  static fromStereoEvent(e, clock, seekable = false) {
    const was = e.previous ? `was ${e.previous} for ${fmtDuration(e.previousSeconds)}` : '';
    return { clock, t: e.t, kind: 'stereo', title: `Stereo: ${e.status}`, detail: [e.detail, was].filter(Boolean).join(' · '), seekable };
  }

  static fromHumEvent(e, clock, seekable = false) {
    const base = { clock, t: e.t, kind: 'hum', seekable };
    if (e.type === 'hum-onset') return { ...base, title: 'Mains hum detected', detail: `${fmtDb(e.levelDb)} dBFS at ${fmtHz(e.frequencyHz)} (${e.mainsHz} Hz mains)` };
    if (e.type === 'hum-offset') return { ...base, kind: 'CLEAN', title: 'Mains hum gone', detail: `now ${e.status.toLowerCase()} · lasted ${fmtDuration(e.duration)}` };
    if (e.type === 'hum-step') return { ...base, title: 'Hum level step', detail: `${fmtDb(e.beforeDb)} → ${fmtDb(e.afterDb)} dBFS (${fmtDb(e.changeDb)} dB)` };
    return { ...base, kind: e.warning ? 'alert' : 'info', title: e.warning ? 'Hum settings' : 'Mains setting', detail: e.message };
  }
}

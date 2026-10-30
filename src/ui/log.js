// Event log panel: clip/limit episodes, hum and stereo changes, and alerts, newest first.
// Bounded in the DOM.

import { fmtDb, fmtDuration, escapeHtml } from './format.js';

const MAX_ROWS = 500;
const MAX_KEPT = 5000;

const fmtHz = (f) => `${f.toFixed(2)} Hz`;

const DETECTOR_NAMES = { dwell: 'dwell', pileup: 'pile-up', fullscale: 'full scale' };

// Inserts an entry into a list kept in time order (equal times keep arrival order) and
// returns its index. Entries usually arrive in order, so the search starts at the end.
export function insertByTime(list, entry) {
  let i = list.length;
  while (i > 0 && list[i - 1].t > entry.t) i--;
  list.splice(i, 0, entry);
  return i;
}

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
  // Kept in time order: a stereo change arrives about 10 s after the time it carries.
  add(entry) {
    const i = insertByTime(this.entries, entry);
    const above = this.entries.length - 1 - i; // newer entries, shown above it
    if (this.entries.length > MAX_KEPT) this.entries.shift();
    if (above >= MAX_ROWS) return;
    const tr = document.createElement('tr');
    if (entry.seekable) {
      tr.className = 'seekable';
      tr.dataset.t = String(Math.max(0, entry.t - 2));
      tr.title = 'Play from here';
    }
    tr.innerHTML = `<td>${escapeHtml(entry.clock || '')}</td><td>${fmtDuration(entry.t)}</td><td><span class="ev ev-${entry.kind}">${escapeHtml(entry.title)}</span></td><td>${Number.isFinite(entry.ceilingDb) ? `${fmtDb(entry.ceilingDb)} dBFS` : ''}</td><td>${escapeHtml(entry.detail || '')}</td>`;
    this.body.insertBefore(tr, this.body.rows[above] || null);
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
    // STEREO only comes from file analysis, which judges just MONO and CHANNEL DEAD.
    const word = (status) => (status === 'STEREO' ? 'stereo (not mono, no dead channel)' : status);
    const was = e.previous ? `was ${word(e.previous)} for ${fmtDuration(e.previousSeconds)}` : '';
    const detail = e.status === 'STEREO' ? '' : e.detail;
    return { clock, t: e.t, kind: 'stereo', title: `Stereo: ${word(e.status)}`, detail: [detail, was].filter(Boolean).join(' · '), seekable };
  }

  static fromHumEvent(e, clock, seekable = false) {
    const base = { clock, t: e.t, kind: 'hum', seekable };
    if (e.type === 'hum-onset') return { ...base, title: 'Mains hum detected', detail: `${fmtDb(e.levelDb)} dBFS at ${fmtHz(e.frequencyHz)} (${e.mainsHz} Hz mains)` };
    if (e.type === 'hum-offset') {
      // Still PRESENT but below the alert level, or not detected / masked.
      const now = e.belowDb != null ? `now below ${fmtDb(e.belowDb, 0)} dBFS` : `now ${e.status.toLowerCase()}`;
      return { ...base, kind: 'CLEAN', title: e.belowDb != null ? 'Mains hum quieter' : 'Mains hum gone', detail: `${now} · lasted ${fmtDuration(e.duration)}` };
    }
    if (e.type === 'hum-step') return { ...base, title: 'Hum level step', detail: `${fmtDb(e.beforeDb)} → ${fmtDb(e.afterDb)} dBFS (${fmtDb(e.changeDb)} dB)` };
    return { ...base, kind: e.warning ? 'alert' : 'info', title: e.warning ? 'Hum settings' : 'Mains setting', detail: e.message };
  }
}

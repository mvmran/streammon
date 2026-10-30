// The event log's rules, fed one second at a time: clip status episodes, stereo status
// changes and hum episodes. Shared by StreamAnalyzer (live and file analysis) and the
// CSV import, which replays a saved session's rows through the same rules.

import { CLEAN } from './clipdetect.js';
import { STEREO_RULES } from './stereobands.js';
import { PRESENT, NOT_DETECTED } from './hum.js';

// Which hum gets logged. A faint hum at the edge of detection flips in and out of PRESENT
// (live 2026-10-30: 152 onsets in 2 h for an inaudible -89 dBFS hum), so an episode is
// logged only for hum at or above the alert level for onSeconds in a row, dated from when
// it began, and ends after offSeconds without it. On that session: 6 entries.
export const HUM_LOG = { onSeconds: 10, offSeconds: 30 };

// Status episodes: a 'start' when the status worsens or changes, and an 'end' (with
// duration and the detectors seen) when it leaves that status. `c` is one second's clip
// result: { status, detectors, dwellRate, fullScaleSamples, ceilingDb, pileRatio }.
export class ClipEpisodes {
  constructor(emit) {
    this.emit = emit;
    this.reset();
  }

  reset() {
    this.status = CLEAN;
    this.episode = null;
  }

  update(c, t) {
    if (c.status === this.status) {
      if (this.episode) {
        for (const d of c.detectors) if (!this.episode.detectors.includes(d)) this.episode.detectors.push(d);
        this.episode.maxDwellRate = Math.max(this.episode.maxDwellRate, c.dwellRate);
        this.episode.fullScaleSamples += c.fullScaleSamples;
      }
      return;
    }
    this.end(t);
    this.status = c.status;
    if (c.status !== CLEAN) {
      // The status is evaluated at the end of each second, so the episode began a second ago.
      const start = Math.max(0, t - 1);
      this.episode = {
        status: c.status,
        start,
        ceilingDb: c.ceilingDb,
        detectors: [...c.detectors],
        maxDwellRate: c.dwellRate,
        fullScaleSamples: c.fullScaleSamples,
        pileRatio: c.pileRatio,
      };
      this.emit({ ...this.episode, type: 'start', t: start, detectors: [...c.detectors] });
    }
  }

  // Closes any open episode (also at the end of a file or session).
  end(t) {
    if (!this.episode) return;
    const e = this.episode;
    this.emit({ ...e, type: 'end', t, duration: t - e.start, detectors: [...e.detectors] });
    this.episode = null;
  }

  finish(t) {
    this.end(t);
    this.status = CLEAN;
  }
}

// Reports a stereo status change once the new status has been judged for
// STEREO_RULES.logSeconds in a row, dated from when it began. A second too quiet to
// judge (no status) breaks the run, so quiet gaps don't count towards it.
export class StereoLog {
  constructor(emit) {
    this.emit = emit;
    this.reset();
  }

  reset() {
    this.candidate = null;
    this.since = 0;
    this.run = 0;
    this.logged = null;
    this.loggedSince = 0;
  }

  update(status, detail, t) {
    if (status !== this.candidate) {
      this.candidate = status;
      this.since = Math.max(0, t - 1);
      this.run = 0;
    }
    if (!status) return;
    this.run++;
    if (status === this.logged || this.run < STEREO_RULES.logSeconds) return;
    this.emit({ type: 'stereo', t: this.since, status, detail, previous: this.logged, previousSeconds: this.logged ? this.since - this.loggedSince : 0 });
    this.logged = status;
    this.loggedSince = this.since;
  }
}

// Hum episodes (HUM_LOG). A second counts when the hum is PRESENT at or above the alert
// level; an episode is logged after onSeconds of those in a row (dated from the first),
// and ends offSeconds after the last one (dated then). `h` is the second's hum reading:
// { status, present, levelDb, fundamentalHz, refHarmonic }; `opt` the hum options
// ({ alertLevelDbfs, mainsFrequencyHz }), read each second as they can change.
export class HumLog {
  constructor(emit) {
    this.emit = emit;
    this.reset();
  }

  reset() {
    this.run = 0;
    this.since = 0;
    this.active = false;
    this.start = 0;
    this.lastT = 0;
  }

  update(h, t, opt) {
    const counts = h && h.present && h.levelDb >= opt.alertLevelDbfs;
    if (!counts) {
      this.run = 0;
      if (this.active && t - this.lastT >= HUM_LOG.offSeconds) {
        this.active = false;
        const still = !!(h && h.status === PRESENT);
        this.emit({ type: 'hum-offset', t: this.lastT, status: h ? h.status : NOT_DETECTED, duration: this.lastT - this.start, belowDb: still ? opt.alertLevelDbfs : null, mainsHz: opt.mainsFrequencyHz });
      }
      return;
    }
    if (this.run++ === 0) this.since = Math.max(0, t - 1);
    this.lastT = t;
    if (this.active || this.run < HUM_LOG.onSeconds) return;
    this.active = true;
    this.start = this.since;
    this.emit({ type: 'hum-onset', t: this.since, levelDb: h.levelDb, frequencyHz: h.fundamentalHz, harmonic: h.refHarmonic, mainsHz: opt.mainsFrequencyHz });
  }
}

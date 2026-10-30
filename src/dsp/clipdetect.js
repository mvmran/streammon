// Clipping detection that works below 0 dBFS.
//
// A stage before the last gain change (e.g. the M32 output into a sound card, which is
// then turned down) can hard-clip, so the flat tops sit at some arbitrary level such as
// -3.5 dBFS. AAC encoding then adds ripple to those flat tops, so we never look for
// identical consecutive samples. Three detectors:
//
//  1. Dwell: a rolling ceiling per polarity (99.9th percentile of |x| over ~10 s). Count
//     runs where the signal stays within `dwellDb` of that ceiling for >= `dwellMinMs`.
//     Clipped audio dwells there often (13-17 runs/s); clean audio rarely (< 1/s);
//     heavy limiting sits in between (~3.6/s).
//  2. Full scale: runs of >= 3 consecutive samples with |x| >= 0.999.
//  3. Peak pinning: the share of 100 ms blocks (over the last 10 s) whose peak lands within
//     1 dB of the ceiling. A limiter pins nearly every block's peak to the same level
//     (0.6-1.0); clean programme peaks wander (< 0.5). This is the "flat line" on the
//     peak strip chart, and catches limiting whose peaks are too brief to dwell.
//  4. Histogram pile-up: sample density in the 1 dB below the ceiling vs the band
//     3-4 dB below. Clipping piles samples up against a hard wall (ratio ~0.55-1.0 on at
//     least one polarity); limited and clean audio roll off smoothly (~0.15-0.35).
//
// Status: CLIPPING if full-scale runs occur, or the signal dwells on its ceiling
// (>= `dwellRate`) and the histogram shows a wall there. LIMITED if it dwells without a
// wall, or its peaks are pinned. Otherwise CLEAN. A status is held for `holdSec` so the display doesn't flicker.

export const CLEAN = 'CLEAN';
export const LIMITED = 'LIMITED';
export const CLIPPING = 'CLIPPING';

const SEVERITY = { [CLEAN]: 0, [LIMITED]: 1, [CLIPPING]: 2 };

// A session's verdict from its seconds per status: overall is CLIPPING if any second
// clipped, LIMITED if at least a quarter were limited; worst is the worst status seen.
export function sessionStatus(secs) {
  const total = secs[CLEAN] + secs[LIMITED] + secs[CLIPPING];
  let overall = CLEAN;
  if (secs[CLIPPING] > 0) overall = CLIPPING;
  else if (total && secs[LIMITED] / total >= 0.25) overall = LIMITED;
  const worst = Object.keys(secs).reduce((w, s) => (secs[s] && SEVERITY[s] > SEVERITY[w] ? s : w), CLEAN);
  return { overall, worst, total };
}

export const DEFAULT_CLIP_OPTIONS = {
  ceilingPercentile: 99.9,
  ceilingWindowSec: 10,
  dwellDb: 1,
  dwellMinMs: 0.42, // 20 samples at 48 kHz
  fullScale: 0.999,
  fullScaleMinRun: 3,
  pileUpperDb: [-1, 0], // band relative to ceiling
  pileLowerDb: [-4, -3],
  statusWindowSec: 3, // dwell rate is averaged over this many seconds
  holdSec: 2, // a status is held this long after its last evidence
  // Calibrated against test-audio/ (see test/run-tests.js).
  dwellRate: 3, // runs/s: the signal is sitting on its ceiling (limiting or clipping)
  pileClipRatio: 0.45, // a hard wall at that ceiling means clipping
  pinDb: 1,
  pinWindowSec: 10,
  pinFraction: 0.55, // share of 100 ms block peaks within `pinDb` of the ceiling
  minCeilingDb: -40, // ignore near-silence
};

const HIST_MIN_DB = -60;
const HIST_MAX_DB = 6;
const HIST_RES = 20; // bins per dB
const HIST_BINS = (HIST_MAX_DB - HIST_MIN_DB) * HIST_RES;
const DB_PER_LOG2 = 20 * Math.log10(2);
const SEGMENT_SEC = 0.5;

function binOf(a) {
  const b = Math.floor((Math.log2(a) * DB_PER_LOG2 - HIST_MIN_DB) * HIST_RES);
  return b < 0 ? 0 : b >= HIST_BINS ? HIST_BINS - 1 : b;
}

// Level (dB) exceeded by (100 - pct)% of the samples in histogram `h` (total `n`, counted
// if null), or -Infinity if it is empty.
function percentileDb(h, n, pct) {
  if (n === null) {
    n = 0;
    for (let b = 0; b < HIST_BINS; b++) n += h[b];
  }
  if (n === 0) return -Infinity;
  const want = n * (1 - pct / 100);
  let acc = 0;
  for (let b = HIST_BINS - 1; b >= 0; b--) {
    acc += h[b];
    if (acc >= want) return HIST_MIN_DB + (b + 1) / HIST_RES;
  }
  return HIST_MIN_DB;
}

// Rolling histogram of |x| (dB) for one polarity, built from fixed-length segments.
class RollingLevelHistogram {
  constructor(segments) {
    this.segs = Array.from({ length: segments }, () => new Uint32Array(HIST_BINS));
    this.segTotals = new Float64Array(segments);
    this.total = new Float64Array(HIST_BINS);
    this.totalN = 0;
    this.pos = 0;
  }

  reset() {
    for (const s of this.segs) s.fill(0);
    this.segTotals.fill(0);
    this.total.fill(0);
    this.totalN = 0;
    this.pos = 0;
  }

  get current() {
    return this.segs[this.pos];
  }

  // Folds the current segment into the total and starts a new one, dropping the oldest.
  advance() {
    const cur = this.segs[this.pos];
    let n = 0;
    for (let b = 0; b < HIST_BINS; b++) {
      this.total[b] += cur[b];
      n += cur[b];
    }
    this.segTotals[this.pos] = n;
    this.totalN += n;
    this.pos = (this.pos + 1) % this.segs.length;
    const old = this.segs[this.pos];
    if (this.segTotals[this.pos] > 0) {
      for (let b = 0; b < HIST_BINS; b++) this.total[b] -= old[b];
      this.totalN -= this.segTotals[this.pos];
      this.segTotals[this.pos] = 0;
      old.fill(0);
    }
  }

  percentileDb(pct) {
    return percentileDb(this.total, this.totalN, pct);
  }

  bandCount(loDb, hiDb) {
    const lo = Math.max(0, Math.round((loDb - HIST_MIN_DB) * HIST_RES));
    const hi = Math.min(HIST_BINS, Math.round((hiDb - HIST_MIN_DB) * HIST_RES));
    let s = 0;
    for (let b = lo; b < hi; b++) s += this.total[b];
    return s;
  }
}

export class ClipDetector {
  constructor(sampleRate, options = {}) {
    this.sampleRate = sampleRate;
    this.opt = { ...DEFAULT_CLIP_OPTIONS, ...options };
    this.segLen = Math.round(sampleRate * SEGMENT_SEC);
    const segments = Math.round(this.opt.ceilingWindowSec / SEGMENT_SEC);
    // [positive, negative] polarity; both channels feed the same histograms.
    this.hist = [new RollingLevelHistogram(segments), new RollingLevelHistogram(segments)];
    this.dwellMin = Math.max(2, Math.round((this.opt.dwellMinMs / 1000) * sampleRate));
    this.pinLen = Math.round(sampleRate * 0.1);
    this.pinned = new Uint8Array(Math.round(this.opt.pinWindowSec * 10));
    this.reset();
  }

  reset() {
    for (const h of this.hist) h.reset();
    this.segN = 0;
    this.ceilingDb = [-Infinity, -Infinity];
    // Linear dwell band per polarity: within +/- dwellDb of the ceiling.
    this.threshold = [Infinity, Infinity];
    this.upper = [Infinity, Infinity];
    this.pileRatio = [0, 0];
    // Per channel x polarity run state.
    this.dwellRun = [[0, 0], [0, 0]];
    this.fsRun = [[0, 0], [0, 0]];
    this.segDwell = [0, 0]; // per channel, in the current segment (not yet validated)
    this.dwellRuns = [0, 0]; // per channel, validated, since last takeSecond()
    this.fsRuns = 0;
    this.fsSamples = 0;
    this.blockPeak = 0;
    this.blockN = 0;
    this.pinned.fill(0);
    this.pinPos = 0;
    this.pinCount = 0; // blocks recorded, up to pinned.length
    this.history = []; // dwell runs/s for the last `statusWindowSec` seconds
    this.rawHistory = []; // unheld status for the last `holdSec` seconds
  }

  // Processes one channel's block. Call once per channel, then `endBlock(n)`.
  processChannel(ch, x, n = x.length) {
    const [hp, hn] = [this.hist[0].current, this.hist[1].current];
    const [tp, tn] = this.threshold;
    const [up, un] = this.upper;
    const fsLevel = this.opt.fullScale;
    const minRun = this.dwellMin;
    const fsMin = this.opt.fullScaleMinRun;
    const dr = this.dwellRun[ch];
    const fr = this.fsRun[ch];
    let dPos = dr[0], dNeg = dr[1], fPos = fr[0], fNeg = fr[1];
    let dwell = 0, fsRuns = 0, fsSamples = 0, peak = this.blockPeak;

    for (let i = 0; i < n; i++) {
      const v = x[i];
      if (v > 0) {
        hp[binOf(v)]++;
        if (v > peak) peak = v;
        if (v >= tp && v <= up) dPos++;
        else { if (dPos >= minRun) dwell++; dPos = 0; }
        if (dNeg >= minRun) dwell++;
        dNeg = 0;
        if (v >= fsLevel) { fPos++; fsSamples++; }
        else { if (fPos >= fsMin) fsRuns++; fPos = 0; }
        if (fNeg >= fsMin) fsRuns++;
        fNeg = 0;
      } else if (v < 0) {
        const a = -v;
        hn[binOf(a)]++;
        if (a > peak) peak = a;
        if (a >= tn && a <= un) dNeg++;
        else { if (dNeg >= minRun) dwell++; dNeg = 0; }
        if (dPos >= minRun) dwell++;
        dPos = 0;
        if (a >= fsLevel) { fNeg++; fsSamples++; }
        else { if (fNeg >= fsMin) fsRuns++; fNeg = 0; }
        if (fPos >= fsMin) fsRuns++;
        fPos = 0;
      } else {
        if (dPos >= minRun) dwell++;
        if (dNeg >= minRun) dwell++;
        if (fPos >= fsMin) fsRuns++;
        if (fNeg >= fsMin) fsRuns++;
        dPos = dNeg = fPos = fNeg = 0;
      }
    }
    dr[0] = dPos; dr[1] = dNeg; fr[0] = fPos; fr[1] = fNeg;
    this.blockPeak = peak;
    this.segDwell[ch] += dwell;
    this.fsRuns += fsRuns;
    this.fsSamples += fsSamples;
  }

  // Advances time by `n` frames (after all channels of the block were processed).
  endBlock(n) {
    this.blockN += n;
    if (this.blockN >= this.pinLen) {
      this.blockN -= this.pinLen;
      const c = Math.max(this.ceilingDb[0], this.ceilingDb[1]);
      const lo = Math.pow(10, (c - this.opt.pinDb) / 20);
      const hi = Math.pow(10, (c + this.opt.pinDb) / 20);
      const pk = this.blockPeak;
      this.pinned[this.pinPos] = c > this.opt.minCeilingDb && pk >= lo && pk <= hi ? 1 : 0;
      this.pinPos = (this.pinPos + 1) % this.pinned.length;
      if (this.pinCount < this.pinned.length) this.pinCount++;
      this.blockPeak = 0;
    }
    this.segN += n;
    while (this.segN >= this.segLen) {
      this.segN -= this.segLen;
      // If the level rose past the ceiling during this segment, the ceiling was stale and
      // its dwell runs are an artefact of the rise, not of a flat top.
      let stale = false;
      for (let p = 0; p < 2; p++) {
        const segCeil = percentileDb(this.hist[p].current, null, this.opt.ceilingPercentile);
        if (segCeil > this.ceilingDb[p] + this.opt.dwellDb) stale = true;
      }
      for (let c = 0; c < 2; c++) {
        if (!stale) this.dwellRuns[c] += this.segDwell[c];
        this.segDwell[c] = 0;
      }
      for (const h of this.hist) h.advance();
      this.updateCeiling();
    }
  }

  updateCeiling() {
    const o = this.opt;
    for (let p = 0; p < 2; p++) {
      const h = this.hist[p];
      const c = h.percentileDb(o.ceilingPercentile);
      this.ceilingDb[p] = c;
      this.threshold[p] = c > o.minCeilingDb ? Math.pow(10, (c - o.dwellDb) / 20) : Infinity;
      this.upper[p] = Math.pow(10, (c + o.dwellDb) / 20);
      const upper = h.bandCount(c + o.pileUpperDb[0], c + o.pileUpperDb[1]);
      const lower = h.bandCount(c + o.pileLowerDb[0], c + o.pileLowerDb[1]);
      const widthRatio = (o.pileLowerDb[1] - o.pileLowerDb[0]) / (o.pileUpperDb[1] - o.pileUpperDb[0]);
      this.pileRatio[p] = lower > 0 ? (upper / lower) * widthRatio : 0;
    }
  }

  // Closes a 1-second interval (call once per second of audio) and returns the
  // detector readings plus the combined status for that second.
  takeSecond(seconds = 1) {
    const o = this.opt;
    const dwell = Math.max(this.dwellRuns[0], this.dwellRuns[1]) / seconds;
    const fs = this.fsRuns;
    const fsSamples = this.fsSamples;
    this.dwellRuns[0] = this.dwellRuns[1] = 0;
    this.fsRuns = 0;
    this.fsSamples = 0;

    this.history.push(dwell);
    if (this.history.length > o.statusWindowSec) this.history.shift();
    const dwellRate = this.history.reduce((a, b) => a + b, 0) / this.history.length;
    const pile = Math.max(this.pileRatio[0], this.pileRatio[1]);
    const ceilingDb = Math.max(this.ceilingDb[0], this.ceilingDb[1]);

    const detectors = [];
    if (fs > 0) detectors.push('fullscale');
    const dwelling = dwellRate >= o.dwellRate;
    if (dwelling && pile >= o.pileClipRatio) detectors.push('dwell', 'pileup');
    let pinned = 0;
    for (let i = 0; i < this.pinCount; i++) pinned += this.pinned[i];
    pinned = this.pinCount ? pinned / this.pinCount : 0;

    let raw;
    if (detectors.length) {
      raw = CLIPPING;
      // Peaks pinned by clipping are not evidence of a limiter once the clipping stops.
      for (let i = 1; i <= Math.min(10, this.pinCount); i++) this.pinned[(this.pinPos - i + this.pinned.length) % this.pinned.length] = 0;
    } else {
      raw = dwelling || pinned >= o.pinFraction ? LIMITED : CLEAN;
    }
    this.rawHistory.push(raw);
    if (this.rawHistory.length > o.holdSec) this.rawHistory.shift();
    const status = this.rawHistory.includes(CLIPPING) ? CLIPPING : this.rawHistory.includes(LIMITED) ? LIMITED : CLEAN;

    return {
      status,
      raw,
      detectors,
      dwellRate,
      dwell,
      pileRatio: pile,
      pinned,
      ceilingDb,
      ceilingPosDb: this.ceilingDb[0],
      ceilingNegDb: this.ceilingDb[1],
      fullScaleRuns: fs,
      fullScaleSamples: fsSamples,
    };
  }
}

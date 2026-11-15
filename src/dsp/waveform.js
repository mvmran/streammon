// Waveform captures: a moment's raw samples together with what the clip detector saw
// there (its ceiling per 100 ms frame, and the plateaus it counts), for the Waveform panel
// and the JSON log. Pure JS: it runs in the AudioWorklet (WaveRing, via StreamAnalyzer),
// on the page and in Node tests.
//
// A snapshot is { sampleRate, start, left, right, frameLen, ceilStart, ceilings }:
//   start      the first sample's index in session time (samples since the analyzer started)
//   left/right Float32Array copies (right may be the same array for a mono source)
//   ceilings   Float32Array [pos0, neg0, pos1, neg1, …]: the ceiling (dBFS) in force during
//              each 100 ms frame, from the frame holding sample 0 on
//   ceilStart  where that first frame starts, relative to sample 0 (≤ 0)
// A capture (buildCapture) is a cut of a snapshot with the samples as Int16, the plateau
// runs found in it and the moment to show first.

import { ClipDetector, DEFAULT_CLIP_OPTIONS } from './clipdetect.js';

export const WAVE = {
  ringSec: 10, // kept by the analyzer: what Freeze shows
  searchSec: 3, // an event capture looks for plateaus over the last 3 s (the dwell rate's window)
  eventSec: 0.5, // and keeps this much around the flattest moment
  focusMs: 25, // the stretch the flattest moment is judged over, and the first view of an event
  fullScaleWeight: 10, // a full-scale run counts this many times a plateau's length
};

// The last few seconds of a stereo stream with the clip ceiling of each 100 ms frame.
// StreamAnalyzer calls push() for every block and endFrame() at the end of each frame.
export class WaveRing {
  constructor(sampleRate, seconds = WAVE.ringSec, frameLen = Math.round(sampleRate * 0.1)) {
    this.sampleRate = sampleRate;
    this.frameLen = frameLen;
    this.cap = Math.round(sampleRate * seconds);
    this.L = new Float32Array(this.cap);
    this.R = new Float32Array(this.cap);
    this.ceilCap = Math.ceil(this.cap / frameLen) + 2;
    this.ceil = new Float32Array(this.ceilCap * 2);
    this.reset();
  }

  reset() {
    this.total = 0; // samples pushed
    this.frames = 0; // frames ended
    this.cur = [-Infinity, -Infinity]; // the ceiling in force during the current frame
  }

  push(l, r, n = l.length) {
    let i = 0;
    while (i < n) {
      const at = this.total % this.cap;
      const k = Math.min(n - i, this.cap - at);
      this.L.set(l.subarray(i, i + k), at);
      this.R.set(r.subarray(i, i + k), at);
      i += k;
      this.total += k;
    }
  }

  // `ceilingDb` is [pos, neg] as the frame ends: it is in force during the next frame.
  endFrame(ceilingDb) {
    const at = (this.frames % this.ceilCap) * 2;
    this.ceil[at] = this.cur[0];
    this.ceil[at + 1] = this.cur[1];
    this.frames++;
    this.cur = [ceilingDb[0], ceilingDb[1]];
  }

  // The last `seconds` (at most what is kept), as copies.
  snapshot(seconds) {
    const n = Math.min(this.total, this.cap, Math.round(seconds * this.sampleRate));
    const start = this.total - n;
    const left = new Float32Array(n), right = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const at = (start + i) % this.cap;
      left[i] = this.L[at];
      right[i] = this.R[at];
    }
    const f0 = Math.floor(start / this.frameLen);
    const f1 = n ? Math.floor((this.total - 1) / this.frameLen) : f0 - 1;
    const ceilings = new Float32Array(Math.max(0, f1 - f0 + 1) * 2);
    for (let f = f0; f <= f1; f++) {
      const j = (f - f0) * 2;
      if (f < this.frames) {
        const at = (f % this.ceilCap) * 2;
        ceilings[j] = this.ceil[at];
        ceilings[j + 1] = this.ceil[at + 1];
      } else {
        ceilings[j] = this.cur[0];
        ceilings[j + 1] = this.cur[1];
      }
    }
    return { sampleRate: this.sampleRate, start, left, right, frameLen: this.frameLen, ceilStart: f0 * this.frameLen - start, ceilings };
  }
}

// The same snapshot taken from a whole decoded file, samples [from, to): the ceilings are
// rebuilt by running a ClipDetector over the 10 s before, from a segment boundary, which
// gives exactly the ceilings the file analysis (and playback from the start) had there.
export function bufferSnapshot(left, right, sampleRate, from, to, clipOptions = {}) {
  from = Math.max(0, Math.min(left.length, Math.round(from)));
  to = Math.max(from, Math.min(left.length, Math.round(to)));
  const det = new ClipDetector(sampleRate, clipOptions);
  const frameLen = Math.round(sampleRate * 0.1);
  const segments = Math.round(det.opt.ceilingWindowSec / 0.5);
  let s = Math.max(0, (Math.floor(from / det.segLen) - segments - 1) * det.segLen);
  s = Math.floor(s / frameLen) * frameLen;
  const f0 = Math.floor(from / frameLen);
  const f1 = to > from ? Math.floor((to - 1) / frameLen) : f0 - 1;
  const ceilings = new Float32Array(Math.max(0, f1 - f0 + 1) * 2);
  for (let f = s / frameLen; f <= f1; f++) {
    if (f >= f0) {
      ceilings[(f - f0) * 2] = det.ceilingDb[0];
      ceilings[(f - f0) * 2 + 1] = det.ceilingDb[1];
    }
    if (f === f1) break; // the last frame's samples don't change its own ceiling
    const a = f * frameLen, b = Math.min(left.length, a + frameLen);
    det.processChannel(0, left.subarray(a, b), b - a);
    det.processChannel(1, right.subarray(a, b), b - a);
    det.endBlock(b - a);
  }
  return {
    sampleRate,
    start: from,
    left: left.slice(from, to),
    right: right === left ? null : right.slice(from, to),
    frameLen,
    ceilStart: f0 * frameLen - from,
    ceilings,
  };
}

const sameSamples = (a, b) => {
  if (!b || a === b) return true;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};

// The plateaus the dwell detector counts, by its own rule: runs of at least dwellMinMs
// within ±dwellDb of the ceiling in force, per channel and polarity; and full-scale runs
// (|x| ≥ fullScale for fullScaleMinRun samples). Data is Float32 or Int16 with a `scale`
// (sample = value / 32767 * scale). [{ kind: 'dwell' | 'full', ch, pol: 1 | -1, s, e }],
// e exclusive, sorted by start. Runs cut by either end of the data are kept if long enough.
export function findRuns(snap, clipOptions = {}) {
  const o = { ...DEFAULT_CLIP_OPTIONS, ...clipOptions };
  const sr = snap.sampleRate;
  const minRun = Math.max(2, Math.round((o.dwellMinMs / 1000) * sr));
  const k = snap.scale ? snap.scale / 32767 : 1;
  const chans = sameSamples(snap.left, snap.right) ? [snap.left] : [snap.left, snap.right];
  const runs = [];
  const frames = snap.ceilings.length / 2;
  const bandOf = (c) => (c > o.minCeilingDb ? [Math.pow(10, (c - o.dwellDb) / 20), Math.pow(10, (c + o.dwellDb) / 20)] : [Infinity, Infinity]);
  chans.forEach((x, ch) => {
    const n = x.length;
    // Open run starts per [dwell+, dwell−, full+, full−], -1 when none.
    const open = [-1, -1, -1, -1];
    const close = (j, i) => {
      const s = open[j];
      if (s < 0) return;
      open[j] = -1;
      const full = j >= 2;
      if (i - s >= (full ? o.fullScaleMinRun : minRun)) runs.push({ kind: full ? 'full' : 'dwell', ch, pol: j % 2 ? -1 : 1, s, e: i });
    };
    let frame = -2, lo = [Infinity, Infinity], hi = [Infinity, Infinity];
    for (let i = 0; i < n; i++) {
      const f = Math.floor((i - snap.ceilStart) / snap.frameLen);
      if (f !== frame) {
        frame = f;
        const fi = Math.max(0, Math.min(frames - 1, f));
        const bp = bandOf(frames ? snap.ceilings[fi * 2] : -Infinity), bn = bandOf(frames ? snap.ceilings[fi * 2 + 1] : -Infinity);
        lo = [bp[0], bn[0]];
        hi = [bp[1], bn[1]];
      }
      const v = x[i] * k;
      if (v > 0) {
        if (v >= lo[0] && v <= hi[0]) { if (open[0] < 0) open[0] = i; } else close(0, i);
        close(1, i);
        if (v >= o.fullScale) { if (open[2] < 0) open[2] = i; } else close(2, i);
        close(3, i);
      } else if (v < 0) {
        const a = -v;
        if (a >= lo[1] && a <= hi[1]) { if (open[1] < 0) open[1] = i; } else close(1, i);
        close(0, i);
        if (a >= o.fullScale) { if (open[3] < 0) open[3] = i; } else close(3, i);
        close(2, i);
      } else {
        for (let j = 0; j < 4; j++) close(j, i);
      }
    }
    for (let j = 0; j < 4; j++) close(j, n);
  });
  return runs.sort((a, b) => a.s - b.s || a.ch - b.ch);
}

// The centre (sample index) of the `focusMs` stretch holding the most plateau, full-scale
// runs weighted up; only runs ending after `from` count. null when there are none.
export function flattestMoment(runs, n, sampleRate, from = 0) {
  const bin = Math.max(1, Math.round(sampleRate / 1000)); // 1 ms
  const bins = new Float64Array(Math.ceil(n / bin) + 1);
  let any = false;
  for (const r of runs) {
    if (r.e <= from) continue;
    const w = r.kind === 'full' ? WAVE.fullScaleWeight : 1;
    for (let i = Math.max(r.s, from); i < r.e; i += bin) bins[Math.floor(i / bin)] += w * Math.min(bin, r.e - i);
    any = true;
  }
  if (!any) return null;
  const width = Math.max(1, Math.round(WAVE.focusMs));
  let sum = 0, best = -1, at = 0;
  for (let b = 0; b < bins.length; b++) {
    sum += bins[b];
    if (b >= width) sum -= bins[b - width];
    if (sum > best) {
      best = sum;
      at = b;
    }
  }
  return Math.min(n - 1, Math.max(0, Math.round((at + 1 - width / 2) * bin)));
}

// A capture of snapshot samples [from, to): Int16 samples (right null when it equals left),
// the ceilings of the frames it covers, its plateau runs and the sample to show first.
// `info`: { kind: 'event' | 'freeze' | 'moment', key, label, status, focus (snapshot index) }.
export function buildCapture(snap, from = 0, to = snap.left.length, info = {}, clipOptions = {}) {
  const n = to - from;
  const left = snap.left.subarray(from, to);
  const right = snap.right ? snap.right.subarray(from, to) : null;
  const mono = sameSamples(left, right);
  let peak = 0;
  for (const x of mono ? [left] : [left, right]) for (let i = 0; i < n; i++) {
    const a = Math.abs(x[i]);
    if (a > peak) peak = a;
  }
  const scale = peak > 1 ? peak : 1; // overs (tab capture, decoded files) are kept
  const q = (x) => {
    const y = new Int16Array(n);
    const g = 32767 / scale;
    for (let i = 0; i < n; i++) y[i] = Math.round(x[i] * g);
    return y;
  };
  const fl = snap.frameLen;
  const k0 = Math.max(0, Math.floor((from - snap.ceilStart) / fl));
  const k1 = Math.min(snap.ceilings.length / 2 - 1, Math.floor((to - 1 - snap.ceilStart) / fl));
  const sub = {
    sampleRate: snap.sampleRate,
    left: left,
    right: mono ? null : right,
    frameLen: fl,
    ceilStart: snap.ceilStart + k0 * fl - from,
    ceilings: Array.from(snap.ceilings.subarray(k0 * 2, (k1 + 1) * 2)),
  };
  const runs = findRuns(sub, clipOptions);
  const focus = info.focus != null ? info.focus - from : null;
  return {
    key: info.key || null,
    kind: info.kind || 'moment',
    label: info.label || '',
    status: info.status || null,
    t0: (snap.start + from) / snap.sampleRate, // session time of the first sample
    sampleRate: snap.sampleRate,
    n,
    scale,
    left: q(left),
    right: mono ? null : q(right),
    frameLen: fl,
    ceilStart: sub.ceilStart,
    ceilings: sub.ceilings,
    runs,
    focus: focus != null && focus >= 0 && focus < n ? focus : null,
  };
}

// An event capture: the eventSec around the flattest moment of the snapshot's last
// searchSec (the end of the snapshot is when the status changed).
export function eventCapture(snap, info = {}, clipOptions = {}) {
  const n = snap.left.length;
  const sr = snap.sampleRate;
  const from = Math.max(0, n - Math.round(WAVE.searchSec * sr));
  const runs = findRuns(snap, clipOptions);
  const len = Math.min(n, Math.round(WAVE.eventSec * sr));
  const centre = flattestMoment(runs, n, sr, from) ?? n - Math.round(len / 2);
  const a = Math.max(0, Math.min(n - len, centre - Math.round(len / 2)));
  return buildCapture(snap, a, a + len, { kind: 'event', ...info, focus: centre }, clipOptions);
}

// A capture of the whole snapshot (Freeze, or a moment of a file), shown whole at first,
// or `focus` (snapshot index) when given.
export function wholeCapture(snap, info = {}, clipOptions = {}) {
  return buildCapture(snap, 0, snap.left.length, { kind: 'freeze', ...info }, clipOptions);
}

// The ceiling (dBFS) for capture sample i and polarity (0 positive, 1 negative).
export function ceilingAt(c, i, pol) {
  const frames = c.ceilings.length / 2;
  if (!frames) return -Infinity;
  const f = Math.max(0, Math.min(frames - 1, Math.floor((i - c.ceilStart) / c.frameLen)));
  return c.ceilings[f * 2 + pol];
}

// ---------------------------------------------------------------------------
// JSON (the log export): samples as base64 of little-endian Int16.

function b64(int16) {
  const bytes = new Uint8Array(int16.length * 2);
  for (let i = 0; i < int16.length; i++) {
    const v = int16[i] & 0xffff;
    bytes[2 * i] = v & 0xff;
    bytes[2 * i + 1] = v >> 8;
  }
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function unb64(text) {
  const s = atob(text);
  const y = new Int16Array(s.length >> 1);
  for (let i = 0; i < y.length; i++) {
    const v = s.charCodeAt(2 * i) | (s.charCodeAt(2 * i + 1) << 8);
    y[i] = v >= 0x8000 ? v - 0x10000 : v;
  }
  return y;
}

export function captureJson(c) {
  return {
    key: c.key,
    kind: c.kind,
    label: c.label,
    status: c.status,
    startSeconds: c.t0,
    startSample: Math.round(c.t0 * c.sampleRate), // session time in samples (exact)
    sampleRate: c.sampleRate,
    samples: c.n,
    encoding: 'int16le-base64, sample = value / 32767 * scale; right null = same as left',
    scale: c.scale,
    left: b64(c.left),
    right: c.right ? b64(c.right) : null,
    frameLen: c.frameLen,
    ceilStart: c.ceilStart,
    ceilingsDbfs: c.ceilings.map((v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null)),
    plateaus: c.runs.map((r) => ({ kind: r.kind, ch: r.ch, pol: r.pol, start: r.s, end: r.e })),
    focus: c.focus,
  };
}

export function captureFromJson(j) {
  return {
    key: j.key,
    kind: j.kind,
    label: j.label,
    status: j.status,
    t0: j.startSample != null ? j.startSample / j.sampleRate : j.startSeconds,
    sampleRate: j.sampleRate,
    n: j.samples,
    scale: j.scale,
    left: unb64(j.left),
    right: j.right ? unb64(j.right) : null,
    frameLen: j.frameLen,
    ceilStart: j.ceilStart,
    ceilings: j.ceilingsDbfs.map((v) => (v === null ? -Infinity : v)),
    runs: j.plateaus.map((r) => ({ kind: r.kind, ch: r.ch, pol: r.pol, s: r.start, e: r.end })),
    focus: j.focus,
  };
}

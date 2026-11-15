// Waveform captures: a moment's raw samples with the peaks that were clipped, for the
// Waveform panel and the JSON log. Pure JS: it runs in the AudioWorklet (WaveRing, via
// StreamAnalyzer), on the page and in Node tests.
//
// A peak is marked clipped (findClipped) when
//   - it reaches full scale: fullScaleMinRun samples or more at |x| >= fullScale; or
//   - it has a flat top that fed a CLIPPING verdict (its second, or one of the next
//     statusWindowSec - 1 whose dwell average covers it, reads CLIPPING): the top stays within CLIP.topDb
//     of its own maximum at least CLIP.flatRatio times as long as the wave took to climb the
//     last 6 dB to it (a rounded peak: about 1), for at least CLIP.minTopMs; it comes within
//     CLIP.nearCeilingDb of the clip ceiling; and at least CLIP.wallCount other flat tops of
//     the same polarity sit at the same level (± CLIP.wallDb) within ± CLIP.wallSec; or
//   - it holds level at the ceiling, also only where it fed a CLIPPING verdict: at least
//     CLIP.levelMinMs of samples, all within CLIP.levelNearDb of the clip ceiling, stay within
//     CLIP.levelDb of each other (only that level stretch is marked; a ripple sample poking
//     above a plateau doesn't cut it short).
// Two rules because clipping looks two ways after encoding: the 18 Oct recordings' tops
// ripple by about ±0.5 dB, so they are long against the climb (the first rule: 7-15/s); the
// 2026-11-15 service (tab capture, a hard ceiling at -6 dBFS) has level tops on slower waves,
// whose long climb hid them from the first rule (about 0.4/s) but not the second.
// Measured with both, ignoring the status (per second): 18 Oct 30 min 10.3, the service's
// three freezes 11-12, the limited recording 1.6, speech 0.48, clean ones 0-0.58; with the
// status condition, limited and clean audio 0. A tolerance of 0.2 dB caught 6-9/s of the
// service's tops (clean ≤ 0.2/s); 0.3 dB/0.25 ms 13-15/s but clean up to 0.9/s. One peak's shape can't tell a limiter's occasional flat-ish top from a
// clip, so the status (which judges many peaks) decides when flat tops count.
//
// A snapshot is { sampleRate, start, left, right, frameLen, ceilStart, ceilings, secLen,
// secStart, statuses }:
//   start      the first sample's index in session time (samples since the analyzer started)
//   left/right Float32Array copies (right null or the same samples for a mono source)
//   ceilings   Float32Array [pos0, neg0, pos1, neg1, …]: the ceiling (dBFS) in force during
//              each 100 ms frame, from the frame holding sample 0 on; ceilStart is where that
//              frame starts relative to sample 0 (≤ 0)
//   statuses   Uint8Array: the clip status of each second (STATUS_CODE), from the second
//              holding sample 0 on (secStart ≤ 0, secLen samples each); NO_STATUS = not judged

import { ClipDetector, DEFAULT_CLIP_OPTIONS, CLEAN, LIMITED, CLIPPING } from './clipdetect.js';

export const WAVE = {
  ringSec: 5, // kept by the analyzer: what Freeze shows (also holds a clipping capture's 5 s)
  // A clipping capture is taken afterSec after the second that turned the status CLIPPING
  // (held that long at least), covering beforeSec before that second, the second, and after:
  // the clipping that turned it and what followed, with history for the ceiling.
  beforeSec: 2,
  afterSec: 2,
  eventSec: 0.5, // a capture keeps this much around the moment with most clipped peaks
  focusMs: 25, // the stretch that moment is judged over, and the first view of a capture
  fullScaleWeight: 10, // a full-scale run counts this many times a flat top's length
};

export const CLIP = {
  nearCeilingDb: 1.5,
  topDb: 0.5, // AAC leaves about this much ripple on a clipped top
  flatRatio: 3,
  minTopMs: 0.3,
  wallCount: 6,
  wallDb: 0.5,
  wallSec: 1,
  levelNearDb: 0.5,
  levelDb: 0.3,
  levelMinMs: 0.3,
};

export const STATUS_CODE = { [CLEAN]: 0, [LIMITED]: 1, [CLIPPING]: 2 };
export const NO_STATUS = 255;

// The last few seconds of a stereo stream with the clip ceiling of each 100 ms frame and
// the status of each second. StreamAnalyzer calls push() for every block, endFrame() at the
// end of each frame and endSecond() at the end of each second.
export class WaveRing {
  constructor(sampleRate, seconds = WAVE.ringSec, frameLen = Math.round(sampleRate * 0.1)) {
    this.sampleRate = sampleRate;
    this.frameLen = frameLen;
    this.secLen = frameLen * 10;
    this.cap = Math.round(sampleRate * seconds);
    this.L = new Float32Array(this.cap);
    this.R = new Float32Array(this.cap);
    this.ceilCap = Math.ceil(this.cap / frameLen) + 2;
    this.ceil = new Float32Array(this.ceilCap * 2);
    this.secCap = Math.ceil(this.cap / this.secLen) + 2;
    this.stat = new Uint8Array(this.secCap);
    this.reset();
  }

  reset() {
    this.total = 0; // samples pushed
    this.frames = 0; // frames ended
    this.seconds = 0; // seconds ended
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

  // The status judged for the second that just ended.
  endSecond(status) {
    this.stat[this.seconds % this.secCap] = STATUS_CODE[status] ?? NO_STATUS;
    this.seconds++;
  }

  // The last `seconds` (at most what is kept), as copies. The second still running has no
  // status yet: it takes the last one (a status is held for 2 s anyway).
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
      const src = f < this.frames ? this.ceil.subarray((f % this.ceilCap) * 2) : this.cur;
      ceilings[j] = src[0];
      ceilings[j + 1] = src[1];
    }
    const s0 = Math.floor(start / this.secLen);
    const s1 = n ? Math.floor((this.total - 1) / this.secLen) : s0 - 1;
    const statuses = new Uint8Array(Math.max(0, s1 - s0 + 1));
    const last = this.seconds ? this.stat[(this.seconds - 1) % this.secCap] : NO_STATUS;
    for (let s = s0; s <= s1; s++) statuses[s - s0] = s < this.seconds ? this.stat[s % this.secCap] : last;
    return {
      sampleRate: this.sampleRate, start, left, right,
      frameLen: this.frameLen, ceilStart: f0 * this.frameLen - start, ceilings,
      secLen: this.secLen, secStart: s0 * this.secLen - start, statuses,
    };
  }
}

// The same snapshot taken from a whole decoded file, samples [from, to). The ceilings are
// rebuilt by running a ClipDetector over the 10 s before, from a segment boundary, which
// gives exactly the ceilings the file analysis had there; `rowStatuses` are the analysis
// rows' statuses (row j: second j).
export function bufferSnapshot(left, right, sampleRate, from, to, rowStatuses = [], clipOptions = {}) {
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
  const secLen = frameLen * 10;
  const s0 = Math.floor(from / secLen);
  const s1 = to > from ? Math.floor((to - 1) / secLen) : s0 - 1;
  const statuses = new Uint8Array(Math.max(0, s1 - s0 + 1));
  for (let k = s0; k <= s1; k++) statuses[k - s0] = STATUS_CODE[rowStatuses[k]] ?? NO_STATUS;
  return {
    sampleRate,
    start: from,
    left: left.slice(from, to),
    right: right === left ? null : right.slice(from, to),
    frameLen,
    ceilStart: f0 * frameLen - from,
    ceilings,
    secLen,
    secStart: s0 * secLen - from,
    statuses,
  };
}

const sameSamples = (a, b) => {
  if (!b || a === b) return true;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};

// The ceiling (dBFS) for sample i and polarity (0 positive, 1 negative).
export function ceilingAt(c, i, pol) {
  const frames = c.ceilings.length / 2;
  if (!frames) return -Infinity;
  const f = Math.max(0, Math.min(frames - 1, Math.floor((i - c.ceilStart) / c.frameLen)));
  return c.ceilings[f * 2 + pol];
}

// Whether the flat top at sample i fed a CLIPPING verdict: its own second or one of the next
// `ahead` (the status judges a 3 s average, so it turns a second or two after the clipping
// that turned it) reads CLIPPING.
export function inClipping(c, i, ahead) {
  if (!c.statuses || !c.statuses.length) return false;
  const k = Math.floor((i - c.secStart) / c.secLen);
  for (let j = Math.max(0, k); j <= Math.min(c.statuses.length - 1, k + ahead); j++) if (c.statuses[j] === STATUS_CODE[CLIPPING]) return true;
  return false;
}

// The longest stretch of x[s..e) whose magnitudes are all at least `lo` and within a factor
// 1/k (k < 1) of each other: { s, e } (e exclusive), or null.
function levelRun(x, s, e, lo, k) {
  let best = null;
  for (let i = s; i < e; i++) {
    let mx = Math.abs(x[i]), mn = mx;
    if (mx < lo) continue;
    let j = i + 1;
    for (; j < e; j++) {
      const a = Math.abs(x[j]);
      if (a < lo) break;
      const nmx = a > mx ? a : mx, nmn = a < mn ? a : mn;
      if (nmn < nmx * k) break;
      mx = nmx;
      mn = nmn;
    }
    if (!best || j - i > best.e - best.s) best = { s: i, e: j };
  }
  return best;
}

// The clipped peaks of a snapshot (see the top of this file): [{ kind: 'flat' | 'full', ch,
// pol: 1 | -1, s, e, peakDb }] with [s, e) the flat top or the full-scale run, sorted by start.
export function findClipped(snap, clipOptions = {}) {
  const o = { ...DEFAULT_CLIP_OPTIONS, ...clipOptions };
  const sr = snap.sampleRate;
  const chans = sameSamples(snap.left, snap.right) ? [snap.left] : [snap.left, snap.right];
  const minTop = Math.max(2, Math.round((CLIP.minTopMs / 1000) * sr));
  const topK = Math.pow(10, -CLIP.topDb / 20);
  const full = [], flat = [], level = [];
  const levelMin = Math.max(2, Math.round((CLIP.levelMinMs / 1000) * sr));
  const levelK = Math.pow(10, -CLIP.levelDb / 20);
  chans.forEach((x, ch) => {
    const n = x.length;
    // Full-scale runs, per polarity.
    let fs = -1, fsPol = 0;
    const closeFs = (i) => {
      if (fs >= 0 && i - fs >= o.fullScaleMinRun) full.push({ kind: 'full', ch, pol: fsPol, s: fs, e: i, peakDb: 0 });
      fs = -1;
    };
    for (let i = 0; i < n; i++) {
      const v = x[i];
      const pol = v >= o.fullScale ? 1 : v <= -o.fullScale ? -1 : 0;
      if (pol !== fsPol || !pol) closeFs(i);
      if (pol && fs < 0) fs = i;
      fsPol = pol;
    }
    closeFs(n);
    // Half-cycles (runs of one sign) whose peak comes near the ceiling.
    let s = 0;
    for (let i = 1; i <= n; i++) {
      if (i < n && (x[i] > 0) === (x[s] > 0) && x[i] !== 0) continue;
      if (x[s] !== 0) {
        let m = 0, at = s;
        for (let j = s; j < i; j++) {
          const a = Math.abs(x[j]);
          if (a > m) (m = a), (at = j);
        }
        const pol = x[s] > 0 ? 1 : -1;
        const peakDb = 20 * Math.log10(m);
        const ceil = ceilingAt(snap, at, pol > 0 ? 0 : 1);
        if (ceil > o.minCeilingDb && peakDb >= ceil - CLIP.nearCeilingDb) {
          const top = m * topK, half = m / 2;
          let a = at, b = at;
          while (a > s && Math.abs(x[a - 1]) >= top) a--;
          while (b < i - 1 && Math.abs(x[b + 1]) >= top) b++;
          let r = a, f = b;
          while (r > s && Math.abs(x[r - 1]) >= half) r--;
          while (f < i - 1 && Math.abs(x[f + 1]) >= half) f++;
          const w = b - a + 1, climb = (a - r + (f - b)) / 2;
          if (w >= minTop && w >= CLIP.flatRatio * Math.max(1, climb)) flat.push({ kind: 'flat', ch, pol, s: a, e: b + 1, peakDb, at });
          if (peakDb >= ceil - CLIP.levelNearDb) {
            const run = levelRun(x, s, i, Math.pow(10, (ceil - CLIP.levelNearDb) / 20), levelK);
            if (run && run.e - run.s >= levelMin) level.push({ kind: 'flat', ch, pol, s: run.s, e: run.e, peakDb, at });
          }
        }
      }
      s = i;
    }
  });
  // Flat tops count where many sit at one level, when they fed a CLIPPING verdict.
  const ahead = Math.max(0, o.statusWindowSec - 1);
  flat.sort((p, q) => p.at - q.at);
  const reach = CLIP.wallSec * sr;
  const clipped = [];
  const done = new Set(); // `${ch}:${at}` of half-cycles marked
  for (let i = 0; i < flat.length; i++) {
    const p = flat[i];
    if (!inClipping(snap, p.at, ahead)) continue;
    let others = 0;
    for (let j = i - 1; j >= 0 && p.at - flat[j].at <= reach; j--) if (flat[j].pol === p.pol && Math.abs(flat[j].peakDb - p.peakDb) <= CLIP.wallDb) others++;
    for (let j = i + 1; j < flat.length && flat[j].at - p.at <= reach; j++) if (flat[j].pol === p.pol && Math.abs(flat[j].peakDb - p.peakDb) <= CLIP.wallDb) others++;
    if (others >= CLIP.wallCount) {
      clipped.push({ kind: 'flat', ch: p.ch, pol: p.pol, s: p.s, e: p.e, peakDb: p.peakDb });
      done.add(`${p.ch}:${p.at}`);
    }
  }
  // Held level, for peaks the first rule didn't mark.
  for (const p of level) if (!done.has(`${p.ch}:${p.at}`) && inClipping(snap, p.at, ahead)) clipped.push({ kind: 'flat', ch: p.ch, pol: p.pol, s: p.s, e: p.e, peakDb: p.peakDb });
  return [...clipped, ...full].sort((p, q) => p.s - q.s || p.ch - q.ch);
}

// The centre (sample index) of the `focusMs` stretch holding the most clipped peaks
// (full-scale runs weighted up); only marks ending after `from` count. null when none.
export function busiestMoment(marks, n, sampleRate, from = 0) {
  const bin = Math.max(1, Math.round(sampleRate / 1000)); // 1 ms
  const bins = new Float64Array(Math.ceil(n / bin) + 1);
  let any = false;
  for (const r of marks) {
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

// The centre (sample index) of the `focusMs` stretch where the most samples sit within
// dwellDb of their polarity's ceiling (the squarest stretch, what the dwell and pile-up
// detectors respond to); for a capture with no clipped peak marked. null if none get there.
export function squarestMoment(snap, from = 0, to = snap.left.length, clipOptions = {}) {
  const o = { ...DEFAULT_CLIP_OPTIONS, ...clipOptions };
  const chans = sameSamples(snap.left, snap.right) ? [snap.left] : [snap.left, snap.right];
  const width = Math.max(1, Math.round((WAVE.focusMs / 1000) * snap.sampleRate));
  const near = new Uint8Array(to - from);
  for (let i = from; i < to; i++) {
    const lo = [Math.pow(10, (ceilingAt(snap, i, 0) - o.dwellDb) / 20), Math.pow(10, (ceilingAt(snap, i, 1) - o.dwellDb) / 20)];
    for (const x of chans) {
      const v = x[i];
      if ((v > 0 && v >= lo[0]) || (v < 0 && -v >= lo[1])) near[i - from]++;
    }
  }
  let sum = 0, best = 0, at = -1;
  for (let i = 0; i < near.length; i++) {
    sum += near[i];
    if (i >= width) sum -= near[i - width];
    if (sum > best) (best = sum), (at = i);
  }
  return at < 0 ? null : from + Math.max(0, at + 1 - Math.round(width / 2));
}

// A capture of snapshot samples [from, to), given the snapshot's clipped peaks: Int16
// samples (right null when it equals left), the ceilings of the frames it covers, the marks
// inside it and the sample to show first. `info`: { kind: 'event' | 'freeze' | 'moment',
// key, label, status, focus (snapshot index) }.
export function buildCapture(snap, from, to, marks, info = {}) {
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
    ceilStart: snap.ceilStart + k0 * fl - from,
    ceilings: Array.from(snap.ceilings.subarray(k0 * 2, (k1 + 1) * 2)),
    marks: marks
      .filter((r) => r.e > from && r.s < to)
      .map((r) => ({ ...r, s: Math.max(0, r.s - from), e: Math.min(n, r.e - from) })),
    focus: focus != null && focus >= 0 && focus < n ? focus : null,
  };
}

// An event capture: the eventSec around the moment with most clipped peaks in the snapshot,
// else its squarest moment (see squarestMoment), else its last eventSec.
export function eventCapture(snap, info = {}, clipOptions = {}) {
  const n = snap.left.length;
  const sr = snap.sampleRate;
  const marks = findClipped(snap, clipOptions);
  const len = Math.min(n, Math.round(WAVE.eventSec * sr));
  const centre = busiestMoment(marks, n, sr) ?? squarestMoment(snap, 0, n, clipOptions) ?? n - Math.round(len / 2);
  const a = Math.max(0, Math.min(n - len, centre - Math.round(len / 2)));
  return buildCapture(snap, a, a + len, marks, { kind: 'event', ...info, focus: centre });
}

// Snapshot samples [from, to) (default: all of it), with marks judged on the whole snapshot
// (so a flat top near the edge still has its neighbours), first shown when `info.focus` is
// true at the busiest moment of clipped peaks, else the squarest; otherwise whole.
export function rangeCapture(snap, info = {}, from = 0, to = snap.left.length, clipOptions = {}) {
  const marks = findClipped(snap, clipOptions);
  let focus = null;
  if (info.focus === true) {
    const inside = marks.filter((r) => r.e > from && r.s < to);
    focus = busiestMoment(inside, snap.left.length, snap.sampleRate) ?? squarestMoment(snap, from, to, clipOptions);
  }
  return buildCapture(snap, from, to, marks, { kind: 'freeze', ...info, focus });
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
    // Clipped peaks: 'flat' = flat top while CLIPPING, 'full' = full-scale run; start/end are
    // sample indexes in this capture (end exclusive), ch 0 = left (or both when mono).
    clipped: c.marks.map((r) => ({ kind: r.kind, ch: r.ch, pol: r.pol, start: r.s, end: r.e, peakDbfs: Math.round(r.peakDb * 100) / 100 })),
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
    marks: j.clipped.map((r) => ({ kind: r.kind, ch: r.ch, pol: r.pol, s: r.start, e: r.end, peakDb: r.peakDbfs })),
    focus: j.focus,
  };
}

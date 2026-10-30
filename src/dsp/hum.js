// Powerline (mains) hum detection.
//
// Lock-in measurement at k·f0 (k = 1…harmonics) on a 2 kHz copy of the mono mix:
//  - two decimation stages (IIR low-pass, then keep every Nth sample);
//  - for each harmonic, a grid of rotating phasors at k·f0 + m·Δ (Δ = 1/detectWindow,
//    m = -15…15) accumulates complex sums in 0.5 s segments, referenced to absolute time;
//  - a Hann-windowed DFT over any whole number of segments is then exact:
//    Hann(f_m) = ½X(m) − ¼e^{-jθ}X(m−1) − ¼e^{+jθ}X(m+1) with the rectangular sums X.
// All of the per-sample work is phasor rotation and accumulation into preallocated
// Float64Arrays; the per-hop work (every 0.5 s) is a few hundred complex sums.
//
// Hum vs music: a mains harmonic sits within ±lockToleranceHz·k of k·f0, stands out
// from its ±3.5 Hz neighbours, keeps a coherent phase, persists, and holds a steady level.
// Bass notes near 50 Hz (G1 49.0, A1 55.0, G2 98) fail the frequency test at 4 s resolution,
// and drifting or decaying notes fail coherence, persistence or steadiness.

export const PRESENT = 'PRESENT';
export const NOT_DETECTED = 'NOT DETECTED';
export const MASKED = 'MASKED';

export const DEFAULT_HUM_OPTIONS = {
  mainsFrequencyHz: 50, // 50 or 60
  harmonics: 10,
  searchToleranceHz: 0.3, // peak search around k·f0 for the fundamental (×k for harmonic k)
  lockToleranceHz: 0.25, // measured frequency must stay within ±this·k of k·f0
  controlOffsetHz: 3.5, // off-frequency control measurements at f ± this
  bandHalfWidthHz: 5, // programme "mains band" for the masking decision: f0 ± this
  detectWindowSec: 4, // present/absent decision (0.25 Hz resolution)
  displayWindowSec: 1, // live level readout
  hopSec: 0.5,
  historySec: 10,
  minProminenceDb: 18, // calibrated: real hum 29-39 dB, bass notes <= 12 dB, a stray 59.9 Hz tone 10-20 dB
  persistenceSec: 5, // locked for at least this long out of the last historySec
  maxPhaseResidualRad: 0.5, // phase coherence between consecutive windows
  maxLevelStdDb: 2, // steadiness, apart from logged level steps
  quietRmsDbfs: -50, // programme below this counts as a quiet passage
  alertLevelDbfs: -85,
  speechTargetLufs: -18,
  levelStepEventDb: 6,
  harmonicAverageSec: 30, // time constant of the phase-locked harmonic average
  harmonicSignificanceDb: 10, // averaged harmonic beats the averaged controls by this: clear
  harmonicTentativeDb: 6, // …or by this: tentative (shown, and the signature says so)
  harmonicSettleSec: 20, // averaging time (while present) before harmonics are judged
};

// Validates user configuration. Unknown or out-of-range values fall back to defaults,
// with a warning for each (shown in the event log).
export function validateHumOptions(input = {}) {
  const o = { ...DEFAULT_HUM_OPTIONS };
  const warnings = [];
  for (const [k, v] of Object.entries(input || {})) {
    if (!(k in DEFAULT_HUM_OPTIONS)) continue;
    if (k === 'mainsFrequencyHz') {
      if (Number(v) === 50 || Number(v) === 60) o.mainsFrequencyHz = Number(v);
      else warnings.push(`Mains frequency ${v} Hz is not 50 or 60 Hz; using 50 Hz`);
    } else if (typeof v === 'number' && Number.isFinite(v)) {
      o[k] = v;
    } else {
      warnings.push(`Hum setting ${k} = ${v} is invalid; using ${DEFAULT_HUM_OPTIONS[k]}`);
    }
  }
  o.harmonics = Math.max(1, Math.min(10, Math.round(o.harmonics)));
  // The window/hop structure has to stay whole segments.
  const segs = Math.round(o.detectWindowSec / o.hopSec);
  const dsegs = Math.round(o.displayWindowSec / o.hopSec);
  if (segs < 2 || dsegs < 1 || segs % dsegs !== 0) {
    warnings.push('Hum window settings are inconsistent; using the defaults');
    o.detectWindowSec = DEFAULT_HUM_OPTIONS.detectWindowSec;
    o.displayWindowSec = DEFAULT_HUM_OPTIONS.displayWindowSec;
    o.hopSec = DEFAULT_HUM_OPTIONS.hopSec;
  }
  return { options: o, warnings };
}

// ---------------------------------------------------------------------------
// Filters

function lowpassBiquad(fs, fc, q) {
  const K = Math.tan((Math.PI * fc) / fs);
  const n = 1 / (1 + K / q + K * K);
  return { b0: K * K * n, b1: 2 * K * K * n, b2: K * K * n, a1: 2 * (K * K - 1) * n, a2: (1 - K / q + K * K) * n };
}

// Butterworth section Qs for orders 4 and 8.
const BW4 = [0.5411961, 1.3065630];
const BW8 = [0.5097956, 0.6013449, 0.8999762, 2.5629154];

function biquadGain(c, f, fs) {
  const w = (2 * Math.PI * f) / fs;
  const cr = (b0, b1, b2) => [b0 + b1 * Math.cos(w) + b2 * Math.cos(2 * w), -(b1 * Math.sin(w) + b2 * Math.sin(2 * w))];
  const [nr, ni] = cr(c.b0, c.b1, c.b2);
  const [dr, di] = cr(1, c.a1, c.a2);
  return Math.hypot(nr, ni) / Math.hypot(dr, di);
}

// Cascade of biquads with Float64 state, processed one sample at a time.
class Cascade {
  constructor(sections) {
    this.c = sections;
    this.s = new Float64Array(sections.length * 2);
  }

  step(x) {
    const s = this.s;
    for (let i = 0; i < this.c.length; i++) {
      const c = this.c[i];
      const y = c.b0 * x + s[2 * i];
      s[2 * i] = c.b1 * x - c.a1 * y + s[2 * i + 1];
      s[2 * i + 1] = c.b2 * x - c.a2 * y;
      x = y;
    }
    return x;
  }

  reset() {
    this.s.fill(0);
  }
}

const db = (a) => (a > 0 ? 20 * Math.log10(a) : -Infinity);
const pdb = (p) => (p > 0 ? 10 * Math.log10(p) : -Infinity);
const wrap = (a) => a - 2 * Math.PI * Math.round(a / (2 * Math.PI));

// Hann window response at a fractional bin offset, normalised to 1 at 0.
function hannGain(d) {
  d = Math.abs(d);
  if (d < 1e-9) return 1;
  if (Math.abs(d - 1) < 1e-9) return 0.5;
  return Math.sin(Math.PI * d) / (Math.PI * d) / (1 - d * d);
}

// ---------------------------------------------------------------------------

export class HumDetector {
  // onResult(result) every hop; onEvent(event) for onset/offset/level steps.
  constructor(sampleRate, options = {}, { onResult = null, onEvent = null } = {}) {
    this.sampleRate = sampleRate;
    this.onResult = onResult;
    this.onEvent = onEvent;
    this.configure(options);
  }

  configure(input) {
    const { options, warnings } = validateHumOptions(input);
    this.opt = options;
    this.configWarnings = warnings;
    const o = options;
    const sr = this.sampleRate;

    // Decimation: sr -> ~8 kHz -> ~2 kHz.
    this.d1 = Math.max(1, Math.round(sr / 8000));
    const fs1 = sr / this.d1;
    this.d2 = 4;
    this.fsd = fs1 / this.d2;
    const fcA = Math.min(0.2 * fs1, 0.45 * sr);
    const fcB = 0.35 * this.fsd;
    this.stageA = new Cascade(BW4.map((q) => lowpassBiquad(sr, fcA, q)));
    this.stageB = new Cascade(BW8.map((q) => lowpassBiquad(fs1, fcB, q)));
    this.filterGain = (f) =>
      this.stageA.c.reduce((g, c) => g * biquadGain(c, f, sr), 1) * this.stageB.c.reduce((g, c) => g * biquadGain(c, f, fs1), 1);

    // Segment / window geometry in decimated samples.
    this.H = Math.round(o.hopSec * this.fsd); // samples per segment (= hop)
    this.S = Math.round(o.detectWindowSec / o.hopSec); // segments per detect window
    this.Sd = Math.round(o.displayWindowSec / o.hopSec); // segments per display window
    this.N = this.S * this.H;
    this.delta = this.fsd / this.N; // grid spacing (Hz) = detect resolution
    this.dispStep = this.S / this.Sd; // display-window Hann neighbour offset in grid steps
    this.segStep = this.S; // single-segment Hann neighbour offset (quiet measurement)
    this.ctrl = Math.round(o.controlOffsetHz / this.delta);
    this.bandBins = Math.round(o.bandHalfWidthHz / this.delta);
    this.M = Math.max(this.ctrl + 1, this.segStep, this.bandBins) + 1; // grid half-width
    const G = 2 * this.M + 1;
    this.G = G;
    const K = o.harmonics;
    this.K = K;
    const count = K * G;

    // Phasors (rotation per decimated sample) and current segment accumulators.
    this.pr = new Float64Array(count);
    this.pi = new Float64Array(count);
    this.rr = new Float64Array(count);
    this.ri = new Float64Array(count);
    this.ar = new Float64Array(count);
    this.ai = new Float64Array(count);
    this.freqs = new Float64Array(count);
    for (let k = 1; k <= K; k++) {
      for (let m = -this.M; m <= this.M; m++) {
        const i = (k - 1) * G + (m + this.M);
        const f = k * o.mainsFrequencyHz + m * this.delta;
        this.freqs[i] = f;
        const w = (2 * Math.PI * f) / this.fsd;
        this.rr[i] = Math.cos(w);
        this.ri[i] = -Math.sin(w);
      }
    }
    this.gain = Float64Array.from({ length: K }, (_, k) => this.filterGain((k + 1) * o.mainsFrequencyHz));

    // Ring of past segment sums: S segments × count complex values.
    this.segRe = new Float64Array(this.S * count);
    this.segIm = new Float64Array(this.S * count);
    this.winRe = new Float64Array(count); // scratch: window sums
    this.winIm = new Float64Array(count);

    // Programme level: full-band mean square per segment.
    this.segMs = new Float64Array(this.S);
    this.hist = Math.round(o.historySec / o.hopSec);
    this.reset();
  }

  reset() {
    this.stageA.reset();
    this.stageB.reset();
    this.pr.fill(1);
    this.pi.fill(0);
    this.ar.fill(0);
    this.ai.fill(0);
    this.segRe.fill(0);
    this.segIm.fill(0);
    this.segMs.fill(0);
    this.n1 = 0; // stage-1 decimation counter
    this.n2 = 0; // stage-2 decimation counter
    this.inSeg = 0; // decimated samples in the current segment
    this.msAcc = 0; // full-band sum of squares in the current segment
    this.segIndex = 0; // completed segments
    this.track = [1, 3].map(() => []); // per reference harmonic: recent hop measurements
    this.status = null;
    this.statusSince = 0;
    this.level = { est: null, stepAt: -Infinity };
    this.devRun = 0;
    this.devSum = 0;
    this.devStart = 0;
    this.avgRe = new Float64Array(this.K); // phase-locked harmonic averages
    this.avgIm = new Float64Array(this.K);
    // The same average of the two control bins (index 2k-2: below, 2k-1: above): noise floor.
    this.ctlRe = new Float64Array(2 * this.K);
    this.ctlIm = new Float64Array(2 * this.K);
    this.mainsPhase = 0; // tracked mains phase (fundamental-equivalent, relative to f0)
    this.avgSince = null; // when the harmonic averages (re)started, while present
    this.lastPresentT = -Infinity;
    this.lastPassT = -Infinity;
    this.quiet = null; // { levelDb, t }
    this.last = null;
  }

  // Feeds stereo audio; any block size. Loudness context (short-term / integrated LUFS)
  // comes from the caller, for the audibility estimate.
  process(left, right, n = left.length) {
    const d1 = this.d1, d2 = this.d2;
    for (let i = 0; i < n; i++) {
      const x = 0.5 * (left[i] + right[i]);
      this.msAcc += x * x;
      const y = this.stageA.step(x);
      if (++this.n1 < d1) continue;
      this.n1 = 0;
      const z = this.stageB.step(y);
      if (++this.n2 < d2) continue;
      this.n2 = 0;
      this.decimated(z);
    }
  }

  decimated(z) {
    const { pr, pi, rr, ri, ar, ai } = this;
    const count = pr.length;
    for (let i = 0; i < count; i++) {
      const c = pr[i], s = pi[i];
      ar[i] += z * c;
      ai[i] += z * s;
      pr[i] = c * rr[i] - s * ri[i];
      pi[i] = c * ri[i] + s * rr[i];
    }
    if (++this.inSeg === this.H) this.endSegment();
  }

  endSegment() {
    const count = this.pr.length;
    const slot = this.segIndex % this.S;
    const off = slot * count;
    this.segRe.set(this.ar, off);
    this.segIm.set(this.ai, off);
    this.ar.fill(0);
    this.ai.fill(0);
    // Keep the phasors on the unit circle.
    for (let i = 0; i < count; i++) {
      const g = 1 / Math.hypot(this.pr[i], this.pi[i]);
      this.pr[i] *= g;
      this.pi[i] *= g;
    }
    this.segMs[slot] = this.msAcc / (this.H * this.d1 * this.d2);
    this.msAcc = 0;
    this.inSeg = 0;
    this.segIndex++;
    if (this.segIndex >= this.S) this.hop();
  }

  // Sum of the last `nseg` segments into winRe/winIm.
  sumSegments(nseg) {
    const count = this.pr.length;
    this.winRe.fill(0);
    this.winIm.fill(0);
    for (let j = 0; j < nseg; j++) {
      const off = ((this.segIndex - 1 - j) % this.S) * count;
      for (let i = 0; i < count; i++) {
        this.winRe[i] += this.segRe[off + i];
        this.winIm[i] += this.segIm[off + i];
      }
    }
  }

  // Hann-windowed DFT at grid point m of harmonic k over the window currently summed
  // in winRe/winIm, which starts at segment `s0` and spans `nseg` segments. The Hann
  // neighbours are `step` grid points away. Returns [re, im] scaled to sine amplitude.
  hann(k, m, s0, nseg, step) {
    const G = this.G, M = this.M;
    const i = (k - 1) * G + (m + M);
    const im1 = i - step, ip1 = i + step;
    // θ = 2π·n0/Nw with n0 = s0·H, Nw = nseg·H: a whole number of turns over nseg.
    const th = (2 * Math.PI * (s0 % nseg)) / nseg;
    const c = Math.cos(th), s = Math.sin(th);
    const re = 0.5 * this.winRe[i] - 0.25 * (c * this.winRe[im1] + s * this.winIm[im1]) - 0.25 * (c * this.winRe[ip1] - s * this.winIm[ip1]);
    const imv = 0.5 * this.winIm[i] - 0.25 * (c * this.winIm[im1] - s * this.winRe[im1]) - 0.25 * (c * this.winIm[ip1] + s * this.winRe[ip1]);
    const scale = 4 / (nseg * this.H) / this.gain[k - 1];
    return [re * scale, imv * scale];
  }

  // Phase at grid point m converted to the reference frequency k·f0, for a window
  // starting at segment s0 and `nseg` long: adds 2π·m·Δ·t_centre (exact, in turns).
  refPhase(re, im, m, s0) {
    const turns = (m * (2 * s0 + this.S)) / (2 * this.S); // m·Δ·t_c with Δ = 1/(S·hop)
    return wrap(Math.atan2(im, re) + 2 * Math.PI * (turns - Math.floor(turns)));
  }

  hop() {
    const o = this.opt;
    const S = this.S;
    const s0 = this.segIndex - S; // first segment of the detect window
    const t = (this.segIndex * this.H) / this.fsd; // time at the end of the window (s)
    const tc = t - o.detectWindowSec / 2;
    this.sumSegments(S);

    const amp = (k, m) => {
      const [re, im] = this.hann(k, m, s0, S, 1);
      return Math.hypot(re, im);
    };

    // Reference harmonics (1 and 3): peak search, prominence, frequency lock, phase.
    const ref = [1, 3].map((k, r) => {
      if (k > this.K) return null;
      const ms = Math.min(this.M - 2, Math.ceil((o.searchToleranceHz * k) / this.delta));
      let best = -1, bm = 0;
      const mags = new Map();
      for (let m = -ms - 1; m <= ms + 1; m++) {
        const a = amp(k, m);
        mags.set(m, a);
        if (a > best) {
          best = a;
          bm = m;
        }
      }
      const interior = Math.abs(bm) <= ms;
      // Parabolic interpolation on dB around the peak.
      let dm = 0, peakDb = db(best);
      if (interior) {
        const a = db(mags.get(bm - 1)), b = db(best), c = db(mags.get(bm + 1));
        const den = a - 2 * b + c;
        if (den < 0) {
          dm = Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / den));
          peakDb = b - 0.25 * (a - c) * dm;
        }
      }
      const freq = k * o.mainsFrequencyHz + (bm + dm) * this.delta;
      const ctlDb = db(Math.max(amp(k, -this.ctrl), amp(k, this.ctrl)));
      const prominence = peakDb - ctlDb;
      const locked = interior && Math.abs(freq - k * o.mainsFrequencyHz) <= o.lockToleranceHz * k;
      const [pre, pim] = this.hann(k, bm, s0, S, 1);
      const phase = this.refPhase(pre, pim, bm, s0);
      const pass = locked && prominence >= o.minProminenceDb;
      const tr = this.track[r];
      tr.push({ seg: this.segIndex, t: tc, levelDb: peakDb, freq, phase, pass, prominence });
      if (tr.length > this.hist) tr.shift();
      return { k, levelDb: peakDb, freq, prominence, controlDb: ctlDb, locked, pass, m: bm + dm };
    });

    // Mains-lock checks over the history, per reference harmonic.
    const checks = ref.map((h, r) => (h ? this.lockChecks(this.track[r], h) : null));
    const locked = checks.findIndex((c) => c && c.present);
    const refIdx = locked >= 0 ? locked : ref[0] && (!ref[1] || ref[0].prominence >= ref[1].prominence) ? 0 : 1;
    const main = ref[refIdx];
    // Measured fundamental (from the reference harmonic) when locked; harmonics are then
    // measured at its multiples. Otherwise at the nominal multiples of f0, so a bass note
    // near 50 Hz doesn't drag the 100 Hz measurement onto a nearby pad tone.
    if (locked >= 0) this.lastPresentT = t;
    const present = t - this.lastPresentT <= 2; // held 2 s so one doubtful window doesn't flicker
    const measuredHz = main.freq / main.k;
    const fundamentalHz = present ? measuredHz : o.mainsFrequencyHz;

    // Mains phase tracker: advance by the measured frequency offset, then pull onto the
    // reference harmonic's measured phase (unwrapped against the prediction, so the
    // 3rd harmonic works as a reference too).
    const pred = this.mainsPhase + 2 * Math.PI * (fundamentalHz - o.mainsFrequencyHz) * o.hopSec;
    if (main.pass) {
      const tr = this.track[refIdx];
      this.mainsPhase = pred + wrap(tr[tr.length - 1].phase - main.k * pred) / main.k;
    } else {
      this.mainsPhase = wrap(pred);
    }

    // The averages only mean something while locked to the hum: restart them at onset.
    if (!present) this.avgSince = null;
    else if (this.avgSince === null) {
      this.avgSince = t;
      for (const a of [this.avgRe, this.avgIm, this.ctlRe, this.ctlIm]) a.fill(0);
    }
    const settled = present && t - this.avgSince >= o.harmonicSettleSec;

    // Harmonic levels at k·f̂ (scallop-corrected), and the phase-locked average.
    const harmonics = [];
    const alpha = 1 - Math.exp(-o.hopSec / o.harmonicAverageSec);
    for (let k = 1; k <= this.K; k++) {
      const mp = (k * fundamentalHz - k * o.mainsFrequencyHz) / this.delta;
      const mn = Math.max(-this.M + 1, Math.min(this.M - 1, Math.round(mp)));
      const [re, im] = this.hann(k, mn, s0, S, 1);
      const g = hannGain(mp - mn);
      const a = Math.hypot(re, im) / (g > 0.1 ? g : 1);
      const ctl = Math.max(amp(k, -this.ctrl), amp(k, this.ctrl));
      // Derotate by k × the mains phase: mains harmonics then add up coherently while
      // programme (speech, music) averages away.
      const ph = this.refPhase(re, im, mn, s0) - k * this.mainsPhase;
      this.avgRe[k - 1] += alpha * (a * Math.cos(ph) - this.avgRe[k - 1]);
      this.avgIm[k - 1] += alpha * (a * Math.sin(ph) - this.avgIm[k - 1]);
      // Control bin averaged exactly like the harmonic bin (same phase correction, as if it
      // sat at the harmonic's grid offset): no hum there, so what survives is the noise
      // floor of the average.
      for (const [j, m] of [[2 * k - 2, -this.ctrl], [2 * k - 1, this.ctrl]]) {
        const [cre, cim] = this.hann(k, m, s0, S, 1);
        const cph = this.refPhase(cre, cim, mn, s0) - k * this.mainsPhase;
        const ca = Math.hypot(cre, cim);
        this.ctlRe[j] += alpha * (ca * Math.cos(cph) - this.ctlRe[j]);
        this.ctlIm[j] += alpha * (ca * Math.sin(cph) - this.ctlIm[j]);
      }
      harmonics.push({ k, freq: k * fundamentalHz, levelDb: db(a), controlDb: db(ctl), prominence: db(a) - db(ctl) });
    }
    const avgDb = Array.from(this.avgRe, (re, i) => db(Math.hypot(re, this.avgIm[i])));
    const floorDb = Array.from({ length: this.K }, (_, i) => {
      const p = (j) => this.ctlRe[j] ** 2 + this.ctlIm[j] ** 2;
      return pdb((p(2 * i) + p(2 * i + 1)) / 2);
    });
    for (const h of harmonics) {
      h.averageDb = avgDb[h.k - 1];
      h.floorDb = floorDb[h.k - 1];
      h.relativeDb = avgDb[h.k - 1] - avgDb[0];
      h.aboveFloorDb = avgDb[h.k - 1] - floorDb[h.k - 1];
      h.significant = settled && h.aboveFloorDb >= o.harmonicSignificanceDb;
      h.tentative = settled && !h.significant && h.aboveFloorDb >= o.harmonicTentativeDb;
    }

    // Display level: 1 s window at the hum frequency, of the reference harmonic.
    this.sumSegments(this.Sd);
    const sd0 = this.segIndex - this.Sd;
    const kd = main.k;
    const mpd = (kd * fundamentalHz - kd * o.mainsFrequencyHz) / this.delta;
    const mnd = Math.max(-this.M + this.dispStep, Math.min(this.M - this.dispStep, Math.round(mpd)));
    const [dre, dim] = this.hann(kd, mnd, sd0, this.Sd, this.dispStep);
    const displayDb = db(Math.hypot(dre, dim) / Math.max(0.1, hannGain((mpd - mnd) / this.dispStep)));

    // Quiet-passage measurement: the latest segment, if the programme was quiet in it.
    const lastSlot = (this.segIndex - 1) % S;
    const segRmsDb = pdb(this.segMs[lastSlot]);
    if (segRmsDb < o.quietRmsDbfs && this.segIndex >= 1) {
      this.sumSegments(1);
      const mq = Math.max(-this.M + this.segStep, Math.min(this.M - this.segStep, Math.round(mpd)));
      const [qre, qim] = this.hann(kd, mq, this.segIndex - 1, 1, this.segStep);
      this.quiet = { levelDb: db(Math.hypot(qre, qim)), t, k: kd };
    }

    // Programme in the mains band (f0 ± 5 Hz, e.g. 45–55 Hz) from the detect-window grid,
    // leaving out the hum's own bins: the background a hum at alertLevelDbfs would have
    // to stand out from. Reported per detect bin, as sine-equivalent dBFS.
    this.sumSegments(S);
    let bandPow = 0, bgPow = 0, nbg = 0;
    const hm = Math.round(ref[0] ? ref[0].m : 0);
    for (let m = -this.bandBins; m <= this.bandBins; m++) {
      const a2 = amp(1, m) ** 2;
      bandPow += a2;
      if (!(ref[0] && ref[0].pass && Math.abs(m - hm) <= 2)) {
        bgPow += a2;
        nbg++;
      }
    }
    const binBgDb = pdb(bgPow / Math.max(1, nbg));
    const nominalDb = db(amp(1, 0));
    const visible = o.alertLevelDbfs - binBgDb >= o.minProminenceDb;

    const status = present ? PRESENT : visible ? NOT_DETECTED : MASKED;

    // Level steps (from the 1 s readout) whenever the hum is locked and prominent; the
    // reference level is only forgotten after 5 s without hum.
    if (main.pass) {
      this.lastPassT = t;
      this.trackLevel(displayDb, t);
    } else if (t - this.lastPassT > 5) {
      this.level.est = null;
      this.devRun = 0;
    }
    if (status !== this.status) this.changeStatus(status, t, main, displayDb);

    // Harmonic signature (hint): odd (3, 5) vs even (2, 4) in the phase-locked average,
    // counting only harmonics that stand clear of their own averaged noise floor. It is
    // "tentative" when a deciding harmonic is only 6–10 dB above that floor.
    const counted = (k) => k <= this.K && (harmonics[k - 1].significant || harmonics[k - 1].tentative);
    const sumPow = (ks) => ks.reduce((p, k) => p + (counted(k) ? Math.pow(10, avgDb[k - 1] / 10) : 0), 0);
    const oddP = sumPow([3, 5]), evenP = sumPow([2, 4]);
    let signature = null;
    let signatureTentative = false;
    if (settled && this.K >= 5 && (oddP > 0 || evenP > 0)) {
      if (oddP >= evenP * 2) signature = 'odd'; // ≥ 3 dB
      else if (evenP >= oddP * 2) signature = 'even';
      else signature = 'mixed';
      signatureTentative = [2, 3, 4, 5].some((k) => k <= this.K && harmonics[k - 1].tentative);
    }

    this.last = {
      t,
      status,
      mainsHz: o.mainsFrequencyHz,
      present,
      refHarmonic: main.k,
      fundamentalHz: measuredHz,
      levelDb: displayDb, // live (1 s) level of the reference harmonic
      detectLevelDb: main.levelDb, // 4 s level
      nominalDb, // 4 s level at exactly f0
      prominenceDb: main.prominence,
      controlDb: main.controlDb,
      locked: main.locked,
      phaseResidual: checks[refIdx] ? checks[refIdx].residual : null,
      levelStdDb: checks[refIdx] ? checks[refIdx].std : null,
      persistenceSec: checks[refIdx] ? checks[refIdx].passSec : 0,
      bandDb: pdb(bandPow / 2 / 1.5), // band power in dBFS (Hann ENBW 1.5 bins)
      backgroundDb: binBgDb,
      programmeRmsDb: segRmsDb,
      quiet: this.quiet ? { levelDb: this.quiet.levelDb, ageSec: t - this.quiet.t } : null,
      harmonics,
      signature,
      signatureTentative,
      harmonicsSettled: settled,
    };
    if (this.onResult) this.onResult(this.last);
  }

  // Persistence, phase coherence and steadiness over the history of one reference harmonic.
  lockChecks(track, h) {
    const o = this.opt;
    const passing = track.filter((e) => e.pass);
    const passSec = passing.length * o.hopSec;
    // Phase coherence: consecutive passing windows, after removing the advance predicted
    // by the measured frequency offset.
    let sq = 0, n = 0;
    for (let i = 1; i < passing.length; i++) {
      const a = passing[i - 1], b = passing[i];
      const dt = b.t - a.t;
      const df = 0.5 * (a.freq + b.freq) - h.k * o.mainsFrequencyHz;
      const r = wrap(b.phase - a.phase - 2 * Math.PI * df * dt);
      sq += r * r;
      n++;
    }
    const residual = n ? Math.sqrt(sq / n) : Infinity;
    // Steadiness: level spread since the last step, ignoring windows that straddle it.
    const settled = passing.filter((e) => e.seg >= this.level.stepAt + this.S);
    let std = 0;
    if (settled.length >= 3) {
      const mean = settled.reduce((s, e) => s + e.levelDb, 0) / settled.length;
      std = Math.sqrt(settled.reduce((s, e) => s + (e.levelDb - mean) ** 2, 0) / settled.length);
    }
    const present = h.pass && passSec >= o.persistenceSec && residual <= o.maxPhaseResidualRad && std <= o.maxLevelStdDb;
    return { present, passSec, residual, std };
  }

  // Logs level steps of at least levelStepEventDb that last 1.5 s or more.
  trackLevel(levelDb, t) {
    const o = this.opt;
    const L = this.level;
    if (L.est === null) {
      L.est = levelDb;
      this.devRun = 0;
      return;
    }
    const d = levelDb - L.est;
    if (Math.abs(d) >= o.levelStepEventDb && (this.devRun === 0 || Math.sign(d) === Math.sign(this.devSum))) {
      if (this.devRun === 0) this.devStart = t - o.displayWindowSec / 2;
      this.devRun++;
      this.devSum += d;
      if (this.devRun >= 3) {
        const after = levelDb; // the latest 1 s reading has settled on the new level
        this.emit({ type: 'hum-step', t: this.devStart, beforeDb: L.est, afterDb: after, changeDb: after - L.est });
        L.est = after;
        L.stepAt = this.segIndex - this.devRun;
        this.devRun = 0;
        this.devSum = 0;
      }
    } else {
      this.devRun = 0;
      this.devSum = 0;
      L.est += 0.1 * (levelDb - L.est); // follow slow changes
    }
  }

  changeStatus(status, t, main, levelDb) {
    const prev = this.status;
    this.status = status;
    if (status === PRESENT) {
      this.statusSince = t;
      this.emit({ type: 'hum-onset', t, levelDb, frequencyHz: main.freq / main.k, harmonic: main.k });
    } else if (prev === PRESENT) {
      this.emit({ type: 'hum-offset', t, status, duration: t - this.statusSince });
    }
  }

  emit(e) {
    if (this.onEvent) this.onEvent({ ...e, mainsHz: this.opt.mainsFrequencyHz });
  }
}

// Stereo image per octave band: L/R correlation, balance and level, over sliding
// windows of 100 ms frames (1 s for display, longer for the status). Each band is a pair of cascaded RBJ band-pass biquads
// (one-octave bandwidth), identical for L and R so correlation and balance are exact for
// whatever the filter passes. StereoStatus turns the bands into one word (and the stereo
// alerts in alerts.js use it).

import { OCTAVE_CENTRES } from './bands.js';

const Q = Math.SQRT2; // one-octave bandwidth
const SILENT_DB = -90; // bands quieter than this report no correlation or balance

export const MONO = 'MONO';
export const STEREO_OK = 'STEREO OK';
export const WIDE = 'WIDE';
export const UNBALANCED = 'UNBALANCED';
export const PHASE_PROBLEM = 'PHASE PROBLEM';
export const CHANNEL_DEAD = 'CHANNEL DEAD';

// Rules for the one-word stereo status (rules of thumb; retune on a real stereo stream).
export const STEREO_RULES = {
  judgeDb: -70, // bands below this are mostly the source's own noise: not judged
  judgeRangeDb: 30, // and bands more than this below the loudest band
  phaseCorr: -0.3, // a judged band below this correlation...
  phaseRangeDb: 20, // ...within this of the loudest band is a phase problem
  // Bands below this aren't judged for phase. With spaced mics, bass notes swing in and out
  // of phase note by note; phone and laptop speakers (where mono matters) don't reproduce
  // them; and a wiring fault also shows in the bands above.
  phaseMinHz: 100,
  windowFrames: 30, // judged over 3 s, so a note or two below the line doesn't count
  unbalancedDb: 3, // whole-mix level difference between the sides
  wideMedianCorr: 0.25, // median correlation of the judged bands below this is very wide
  holdFrames: 30, // a worse status is held for 3 s so the word doesn't flicker
  // A channel is dead when the other carries sound (1 s RMS at least deadLiveDb) and it is
  // at least deadGapDb quieter: an unplugged cable, a muted output, digital silence.
  // No real mix is 30 dB louder on one side for seconds on end.
  deadLiveDb: -50,
  deadGapDb: 30,
};

// Which channel is dead ('left' / 'right'), or null. Levels are 1 s RMS in dBFS.
export function deadChannel(leftDb, rightDb, rules = STEREO_RULES) {
  if (Math.max(leftDb, rightDb) < rules.deadLiveDb) return null;
  if (leftDb - rightDb >= rules.deadGapDb) return 'right';
  if (rightDb - leftDb >= rules.deadGapDb) return 'left';
  return null;
}

export const deadDetail = (side) => `${side === 'left' ? 'Left' : 'Right'} channel silent`;

function bandpass(fc, sampleRate) {
  const w = (2 * Math.PI * fc) / sampleRate;
  const alpha = Math.sin(w) / (2 * Q);
  const a0 = 1 + alpha;
  return { b0: alpha / a0, a1: (-2 * Math.cos(w)) / a0, a2: (1 - alpha) / a0 };
}

export class StereoBands {
  // frames: window length in 100 ms frames (10 = 1 s, like the overall stereo meter) for
  // `current`; keep: frames held for longer windows (`over`).
  constructor(sampleRate, frames = 10, keep = frames, centres = OCTAVE_CENTRES) {
    this.centres = centres;
    // Bands too close to Nyquist are left out (null in the output).
    this.coef = centres.map((fc) => (fc < 0.45 * sampleRate ? bandpass(fc, sampleRate) : null));
    this.frames = frames;
    this.keep = Math.max(frames, keep);
    this.ring = new Float64Array(this.keep * centres.length * 4); // per frame and band: LL, RR, LR, n
    this.reset();
  }

  reset() {
    // Transposed direct form II state: per band, [L stage 1, L stage 2, R stage 1, R stage 2] x 2.
    this.state = this.centres.map(() => new Float64Array(8));
    this.acc = new Float64Array(this.centres.length * 4);
    this.ring.fill(0);
    this.pos = 0;
  }

  process(left, right, n) {
    const acc = this.acc;
    for (let bi = 0; bi < this.coef.length; bi++) {
      const c = this.coef[bi];
      if (!c) continue;
      const { b0, a1, a2 } = c;
      const s = this.state[bi];
      let l1 = s[0], l2 = s[1], l3 = s[2], l4 = s[3], r1 = s[4], r2 = s[5], r3 = s[6], r4 = s[7];
      let ll = 0, rr = 0, lr = 0;
      for (let j = 0; j < n; j++) {
        // y = b0 x - b0 x[-2] - a1 y[-1] - a2 y[-2], two stages per channel.
        const xl = left[j];
        const ul = b0 * xl + l1;
        l1 = -a1 * ul + l2;
        l2 = -b0 * xl - a2 * ul;
        const yl = b0 * ul + l3;
        l3 = -a1 * yl + l4;
        l4 = -b0 * ul - a2 * yl;
        const xr = right[j];
        const ur = b0 * xr + r1;
        r1 = -a1 * ur + r2;
        r2 = -b0 * xr - a2 * ur;
        const yr = b0 * ur + r3;
        r3 = -a1 * yr + r4;
        r4 = -b0 * ur - a2 * yr;
        ll += yl * yl;
        rr += yr * yr;
        lr += yl * yr;
      }
      // Flush denormals after silence (they are slow on some CPUs).
      const flush = (v) => (Math.abs(v) < 1e-25 ? 0 : v);
      s[0] = flush(l1); s[1] = flush(l2); s[2] = flush(l3); s[3] = flush(l4);
      s[4] = flush(r1); s[5] = flush(r2); s[6] = flush(r3); s[7] = flush(r4);
      const o = bi * 4;
      acc[o] += ll;
      acc[o + 1] += rr;
      acc[o + 2] += lr;
      acc[o + 3] += n;
    }
  }

  // Closes the current 100 ms frame into the window.
  endFrame() {
    this.ring.set(this.acc, this.pos * this.acc.length);
    this.pos = (this.pos + 1) % this.keep;
    this.acc.fill(0);
  }

  // Per band over the window: { fc, correlation, balanceDb (R over L), levelDb (RMS dBFS,
  // both channels) }, with nulls for silent or unavailable bands.
  get current() {
    return this.over(this.frames);
  }

  // The same over the last `frames` frames (at most `keep`).
  over(frames) {
    const nb = this.centres.length;
    const count = Math.min(frames, this.keep);
    return this.centres.map((fc, bi) => {
      if (!this.coef[bi]) return { fc, correlation: null, balanceDb: null, levelDb: null };
      let ll = 0, rr = 0, lr = 0, n = 0;
      for (let k = 1; k <= count; k++) {
        const o = (((this.pos - k + this.keep) % this.keep) * nb + bi) * 4;
        ll += this.ring[o];
        rr += this.ring[o + 1];
        lr += this.ring[o + 2];
        n += this.ring[o + 3];
      }
      const levelDb = n > 0 && ll + rr > 0 ? 10 * Math.log10((ll + rr) / (2 * n)) : -Infinity;
      if (!(levelDb > SILENT_DB) || ll <= 0 || rr <= 0) return { fc, correlation: null, balanceDb: null, levelDb };
      return { fc, correlation: Math.max(-1, Math.min(1, lr / Math.sqrt(ll * rr))), balanceDb: 10 * Math.log10(rr / ll), levelDb };
    });
  }
}

const SEVERITY = { [STEREO_OK]: 0, [WIDE]: 1, [UNBALANCED]: 2, [PHASE_PROBLEM]: 3 };
const labelHz = (f) => (f >= 1000 ? `${Math.round(f / 100) / 10}k` : String(Math.round(f)));

// Short enough for one line on the Stereo card: up to three bands by name, more as a range.
const phaseDetail = (flipped) =>
  flipped.length <= 3
    ? `Out of phase: ${flipped.map((b) => labelHz(b.fc)).join(', ')}`
    : `Out of phase: ${flipped.length} bands, ${labelHz(flipped[0].fc)}–${labelHz(flipped.at(-1).fc)}`;

// One word for volunteers, from the per-band readings (StereoBands.over(windowFrames)),
// whether the channels are identical, and the whole-mix balance. Call once per 100 ms frame.
export class StereoStatus {
  constructor(rules = STEREO_RULES) {
    this.rules = rules;
    this.reset();
  }

  reset() {
    this.held = null; // { status, detail, until }
    this.frame = 0;
  }

  // Returns { status, detail }; status is null when everything is too quiet to judge.
  // dead: deadChannel()'s answer, which outranks everything else.
  update(bands, mono, balanceDb, dead = null) {
    this.frame++;
    if (dead) {
      this.held = null;
      return { status: CHANNEL_DEAD, detail: deadDetail(dead) };
    }
    if (mono) {
      this.held = null;
      return { status: MONO, detail: 'Left and right identical' };
    }
    const now = this.judge(bands, balanceDb);
    if (!now.status) {
      this.held = null;
      return now;
    }
    const h = this.held;
    if (h && this.frame < h.until && SEVERITY[now.status] < SEVERITY[h.status]) return { status: h.status, detail: h.detail };
    this.held = { ...now, until: this.frame + this.rules.holdFrames };
    return now;
  }

  judge(bands, balanceDb) {
    const r = this.rules;
    const valid = bands.filter((b) => b.correlation !== null && b.levelDb >= r.judgeDb);
    if (!valid.length) return { status: null, detail: 'Too quiet to judge' };
    const top = Math.max(...valid.map((b) => b.levelDb));
    const judged = valid.filter((b) => b.levelDb >= top - r.judgeRangeDb);
    const flipped = judged.filter((b) => b.fc >= r.phaseMinHz && b.correlation < r.phaseCorr && b.levelDb >= top - r.phaseRangeDb);
    if (flipped.length) return { status: PHASE_PROBLEM, detail: phaseDetail(flipped) };
    if (balanceDb !== null && Math.abs(balanceDb) > r.unbalancedDb) {
      return { status: UNBALANCED, detail: `${Math.abs(balanceDb).toFixed(1)} dB louder on the ${balanceDb < 0 ? 'left' : 'right'}` };
    }
    const corr = judged.map((b) => b.correlation).sort((a, b) => a - b);
    const median = corr.length % 2 ? corr[(corr.length - 1) / 2] : (corr[corr.length / 2 - 1] + corr[corr.length / 2]) / 2;
    if (median < r.wideMedianCorr) return { status: WIDE, detail: `Median band correlation ${median.toFixed(2)}` };
    return { status: STEREO_OK, detail: 'Balanced, in phase' };
  }
}

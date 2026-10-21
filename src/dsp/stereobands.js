// Stereo image per octave band: L/R correlation, balance and level, over a sliding
// window of 100 ms frames. Each band is a pair of cascaded RBJ band-pass biquads
// (one-octave bandwidth), identical for L and R so correlation and balance are exact for
// whatever the filter passes. Display only: no alert or status depends on it.

import { OCTAVE_CENTRES } from './bands.js';

const Q = Math.SQRT2; // one-octave bandwidth
const SILENT_DB = -90; // bands quieter than this report no correlation or balance

function bandpass(fc, sampleRate) {
  const w = (2 * Math.PI * fc) / sampleRate;
  const alpha = Math.sin(w) / (2 * Q);
  const a0 = 1 + alpha;
  return { b0: alpha / a0, a1: (-2 * Math.cos(w)) / a0, a2: (1 - alpha) / a0 };
}

export class StereoBands {
  // frames: window length in 100 ms frames (10 = 1 s, like the overall stereo meter).
  constructor(sampleRate, frames = 10, centres = OCTAVE_CENTRES) {
    this.centres = centres;
    // Bands too close to Nyquist are left out (null in the output).
    this.coef = centres.map((fc) => (fc < 0.45 * sampleRate ? bandpass(fc, sampleRate) : null));
    this.frames = frames;
    this.ring = new Float64Array(frames * centres.length * 4); // per frame and band: LL, RR, LR, n
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
    this.pos = (this.pos + 1) % this.frames;
    this.acc.fill(0);
  }

  // Per band over the window: { fc, correlation, balanceDb (R over L), levelDb (RMS dBFS,
  // both channels) }, with nulls for silent or unavailable bands.
  get current() {
    const nb = this.centres.length;
    return this.centres.map((fc, bi) => {
      if (!this.coef[bi]) return { fc, correlation: null, balanceDb: null, levelDb: null };
      let ll = 0, rr = 0, lr = 0, n = 0;
      for (let f = 0; f < this.frames; f++) {
        const o = (f * nb + bi) * 4;
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

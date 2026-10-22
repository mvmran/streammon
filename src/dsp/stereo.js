// Stereo image: L/R correlation and side/mid energy ratio over a sliding window.

const MONO_CORRELATION = 0.999;

// Correlation and side/mid ratio (dB) from accumulated sums. Correlation is null when
// either channel is silent; side/mid is -Infinity for identical channels.
export function stereoFromSums(sLL, sRR, sLR) {
  const den = Math.sqrt(sLL * sRR);
  const correlation = den > 0 ? sLR / den : null;
  const mid = sLL + sRR + 2 * sLR; // 4 * sum(M^2), M = (L + R) / 2
  const side = sLL + sRR - 2 * sLR; // 4 * sum(S^2), S = (L - R) / 2
  const sideMidDb = mid > 0 ? (side > 0 ? 10 * Math.log10(side / mid) : -Infinity) : null;
  const mono = correlation !== null && correlation > MONO_CORRELATION;
  return { correlation, sideMidDb, mono };
}

// Keeps per-frame sums for the last `frames` frames.
export class StereoMeter {
  constructor(frames = 10) {
    this.ring = new Float64Array(frames * 3);
    this.frames = frames;
    this.reset();
  }

  reset() {
    this.ring.fill(0);
    this.pos = 0;
    this.total = [0, 0, 0]; // session sums: LL, RR, LR
  }

  // Adds one frame's sums.
  push(sLL, sRR, sLR) {
    const o = this.pos * 3;
    this.ring[o] = sLL;
    this.ring[o + 1] = sRR;
    this.ring[o + 2] = sLR;
    this.pos = (this.pos + 1) % this.frames;
    this.total[0] += sLL;
    this.total[1] += sRR;
    this.total[2] += sLR;
  }

  get current() {
    let a = 0, b = 0, c = 0;
    for (let i = 0; i < this.ring.length; i += 3) {
      a += this.ring[i];
      b += this.ring[i + 1];
      c += this.ring[i + 2];
    }
    return stereoFromSums(a, b, c);
  }

  // Level difference over the window, R over L in dB (null when either side is silent).
  get balanceDb() {
    let a = 0, b = 0;
    for (let i = 0; i < this.ring.length; i += 3) {
      a += this.ring[i];
      b += this.ring[i + 1];
    }
    return a > 0 && b > 0 ? 10 * Math.log10(b / a) : null;
  }

  // 1 s RMS of each channel in dBFS ([left, right], -Infinity for digital silence).
  channelDb(samplesPerFrame) {
    let a = 0, b = 0;
    for (let i = 0; i < this.ring.length; i += 3) {
      a += this.ring[i];
      b += this.ring[i + 1];
    }
    const n = this.frames * samplesPerFrame;
    return [a, b].map((s) => (s > 0 ? 10 * Math.log10(s / n) : -Infinity));
  }

  get session() {
    return stereoFromSums(...this.total);
  }
}

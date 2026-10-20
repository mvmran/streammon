// ITU-R BS.1770-4 / EBU R128 loudness: momentary, short-term, integrated and
// loudness range (EBU Tech 3342).
//
// Memory is bounded regardless of run length: gating blocks are accumulated into
// fixed-resolution histograms (0.01 LU bins, count + exact energy per bin) instead of
// an ever-growing list, so a 2-hour service costs the same as 30 seconds.

import { KWeightingFilter } from './kweighting.js';

export const ABS_GATE_LUFS = -70;
const HIST_MIN = -70;
const HIST_MAX = 10;
const HIST_RES = 100; // bins per LU
const HIST_BINS = (HIST_MAX - HIST_MIN) * HIST_RES;

export function energyToLufs(e) {
  return e > 0 ? -0.691 + 10 * Math.log10(e) : -Infinity;
}

export function lufsToEnergy(l) {
  return Math.pow(10, (l + 0.691) / 10);
}

// Histogram of gating-block energies above the absolute gate.
export class GatedHistogram {
  constructor() {
    this.count = new Uint32Array(HIST_BINS);
    this.energy = new Float64Array(HIST_BINS);
    this.n = 0;
    this.sum = 0;
  }

  reset() {
    this.count.fill(0);
    this.energy.fill(0);
    this.n = 0;
    this.sum = 0;
  }

  add(e) {
    const l = energyToLufs(e);
    if (!(l > ABS_GATE_LUFS)) return;
    let bin = Math.floor((l - HIST_MIN) * HIST_RES);
    if (bin >= HIST_BINS) bin = HIST_BINS - 1;
    this.count[bin]++;
    this.energy[bin] += e;
    this.n++;
    this.sum += e;
  }

  // First bin whose centre is at or above loudness `l`.
  binAt(l) {
    const b = Math.ceil((l - HIST_MIN) * HIST_RES - 0.5);
    return Math.max(0, Math.min(HIST_BINS, b));
  }

  // Power mean of blocks that pass the absolute gate and a gate `relLU` below that mean.
  gatedMean(relLU) {
    if (this.n === 0) return { lufs: -Infinity, first: HIST_BINS, n: 0 };
    const gate = energyToLufs(this.sum / this.n) + relLU;
    const first = this.binAt(gate);
    let n = 0;
    let e = 0;
    for (let b = first; b < HIST_BINS; b++) {
      n += this.count[b];
      e += this.energy[b];
    }
    return { lufs: n ? energyToLufs(e / n) : -Infinity, first, n };
  }

  // Loudness at fractional rank `q` (0..1) among blocks from bin `first` upwards.
  percentile(first, n, q) {
    const target = Math.round((n - 1) * q);
    let acc = 0;
    for (let b = first; b < HIST_BINS; b++) {
      acc += this.count[b];
      if (acc > target) return HIST_MIN + (b + 0.5) / HIST_RES;
    }
    return HIST_MAX;
  }
}

export class LoudnessMeter {
  // `onBlock(momentaryLufs, shortTermLufs)` is called every 100 ms of audio.
  constructor(sampleRate, onBlock = null) {
    this.sampleRate = sampleRate;
    this.subLen = Math.round(sampleRate * 0.1);
    this.filters = [new KWeightingFilter(sampleRate), new KWeightingFilter(sampleRate)];
    this.scratch = new Float32Array(0);
    this.onBlock = onBlock;
    this.integratedHist = new GatedHistogram();
    this.lraHist = new GatedHistogram();
    this.ring = new Float64Array(30); // last 30 sub-block energies (3 s)
    this.reset();
  }

  reset() {
    for (const f of this.filters) f.reset();
    this.integratedHist.reset();
    this.lraHist.reset();
    this.ring.fill(0);
    this.ringPos = 0;
    this.subCount = 0;
    this.acc = 0;
    this.accN = 0;
    this.momentary = -Infinity;
    this.shortTerm = -Infinity;
  }

  // Processes `n` frames of left/right audio. Pass the same array twice for mono.
  process(left, right, n = left.length) {
    if (this.scratch.length < n) this.scratch = new Float32Array(n);
    const k = this.scratch;
    let i = 0;
    while (i < n) {
      const take = Math.min(n - i, this.subLen - this.accN);
      let s = 0;
      this.filters[0].process(left.subarray(i, i + take), k, take);
      for (let j = 0; j < take; j++) s += k[j] * k[j];
      this.filters[1].process(right.subarray(i, i + take), k, take);
      for (let j = 0; j < take; j++) s += k[j] * k[j];
      this.acc += s;
      this.accN += take;
      i += take;
      if (this.accN === this.subLen) this.completeSubBlock();
    }
  }

  completeSubBlock() {
    this.ring[this.ringPos] = this.acc / this.subLen;
    this.ringPos = (this.ringPos + 1) % 30;
    this.subCount++;
    this.acc = 0;
    this.accN = 0;

    const sumLast = (m) => {
      let e = 0;
      for (let j = 1; j <= m; j++) e += this.ring[(this.ringPos - j + 30) % 30];
      return e / m;
    };
    if (this.subCount >= 4) {
      const e = sumLast(4);
      this.momentary = energyToLufs(e);
      this.integratedHist.add(e);
    }
    if (this.subCount >= 30) {
      const e = sumLast(30);
      this.shortTerm = energyToLufs(e);
      this.lraHist.add(e);
    }
    if (this.onBlock) this.onBlock(this.momentary, this.shortTerm);
  }

  get integrated() {
    return this.integratedHist.gatedMean(-10).lufs;
  }

  // EBU Tech 3342 loudness range in LU.
  get loudnessRange() {
    const h = this.lraHist;
    const { first, n } = h.gatedMean(-20);
    if (n < 2) return 0;
    return h.percentile(first, n, 0.95) - h.percentile(first, n, 0.1);
  }
}

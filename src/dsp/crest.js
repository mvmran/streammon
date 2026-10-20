// Crest factor (sample peak minus RMS, in dB) over a sliding window of frames, plus
// the whole-session figure.

export const toDb = (x) => (x > 0 ? 20 * Math.log10(x) : -Infinity);

export class CrestMeter {
  constructor(frames = 30) {
    this.peaks = new Float64Array(frames);
    this.energy = new Float64Array(frames); // sum of squares across channels
    this.count = new Float64Array(frames); // number of samples across channels
    this.frames = frames;
    this.reset();
  }

  reset() {
    this.peaks.fill(0);
    this.energy.fill(0);
    this.count.fill(0);
    this.pos = 0;
    this.sessionPeak = 0;
    this.sessionEnergy = 0;
    this.sessionCount = 0;
  }

  push(peak, energy, count) {
    this.peaks[this.pos] = peak;
    this.energy[this.pos] = energy;
    this.count[this.pos] = count;
    this.pos = (this.pos + 1) % this.frames;
    if (peak > this.sessionPeak) this.sessionPeak = peak;
    this.sessionEnergy += energy;
    this.sessionCount += count;
  }

  static crest(peak, energy, count) {
    if (!(count > 0) || !(energy > 0)) return null;
    return toDb(peak) - 10 * Math.log10(energy / count);
  }

  get current() {
    let p = 0, e = 0, n = 0;
    for (let i = 0; i < this.frames; i++) {
      if (this.peaks[i] > p) p = this.peaks[i];
      e += this.energy[i];
      n += this.count[i];
    }
    return CrestMeter.crest(p, e, n);
  }

  get rmsDb() {
    let e = 0, n = 0;
    for (let i = 0; i < this.frames; i++) {
      e += this.energy[i];
      n += this.count[i];
    }
    return n > 0 && e > 0 ? 10 * Math.log10(e / n) : -Infinity;
  }

  get session() {
    return CrestMeter.crest(this.sessionPeak, this.sessionEnergy, this.sessionCount);
  }
}

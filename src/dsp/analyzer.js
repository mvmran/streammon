// StreamAnalyzer: runs every measurement over a stereo stream fed in blocks of any size.
// Pure JS with no browser or Node APIs, so it runs unchanged in an AudioWorklet, a Web
// Worker (file analysis) and the Node test harness.
//
// Output:
//   onFrame(frame)   every 100 ms of audio: meters for the display
//   onSecond(row)    every 1 s of audio: one CSV row with every metric plus clip status
//   onEvent(event)   status changes: { type: 'start' | 'end', status, t, ... }

import { LoudnessMeter } from './loudness.js';
import { TruePeakChannel } from './truepeak.js';
import { ClipDetector, CLEAN, LIMITED, CLIPPING } from './clipdetect.js';
import { StereoMeter } from './stereo.js';
import { CrestMeter, toDb } from './crest.js';

export { CLEAN, LIMITED, CLIPPING };

const SEVERITY = { [CLEAN]: 0, [LIMITED]: 1, [CLIPPING]: 2 };

export class StreamAnalyzer {
  constructor(sampleRate, { onFrame = null, onSecond = null, onEvent = null, clipOptions = {} } = {}) {
    this.sampleRate = sampleRate;
    this.frameLen = Math.round(sampleRate * 0.1);
    this.onFrame = onFrame;
    this.onSecond = onSecond;
    this.onEvent = onEvent;
    this.loudness = new LoudnessMeter(sampleRate);
    this.tp = [new TruePeakChannel(), new TruePeakChannel()];
    this.clip = new ClipDetector(sampleRate, clipOptions);
    this.stereo = new StereoMeter(10); // 1 s
    this.crest = new CrestMeter(30); // 3 s
    this.reset();
  }

  reset() {
    this.loudness.reset();
    for (const t of this.tp) t.reset();
    this.clip.reset();
    this.stereo.reset();
    this.crest.reset();
    this.frames = 0; // completed 100 ms frames
    this.n = 0; // frames into the current 100 ms frame
    this.f = { peak: 0, tp: 0, ll: 0, rr: 0, lr: 0 };
    this.s = { peak: 0, tp: 0 }; // current second
    this.maxTruePeak = 0;
    this.maxMomentary = -Infinity;
    this.maxShortTerm = -Infinity;
    this.statusSeconds = { [CLEAN]: 0, [LIMITED]: 0, [CLIPPING]: 0 };
    this.dwellSum = 0;
    this.fullScaleSamples = 0;
    this.lastClip = null;
    this.status = CLEAN;
    this.episode = null;
    this.events = 0;
  }

  get elapsed() {
    return (this.frames * this.frameLen + this.n) / this.sampleRate;
  }

  // Feeds `n` frames. Pass the same array twice for a mono source.
  process(left, right, n = left.length) {
    let i = 0;
    while (i < n) {
      const k = Math.min(n - i, this.frameLen - this.n);
      const l = left.subarray(i, i + k);
      const r = right.subarray(i, i + k);
      this.loudness.process(l, r, k);
      const tp = Math.max(this.tp[0].process(l, k), this.tp[1].process(r, k));
      this.clip.processChannel(0, l, k);
      this.clip.processChannel(1, r, k);
      this.clip.endBlock(k);

      const f = this.f;
      let peak = f.peak, ll = 0, rr = 0, lr = 0;
      for (let j = 0; j < k; j++) {
        const a = l[j], b = r[j];
        ll += a * a;
        rr += b * b;
        lr += a * b;
        const m = a > 0 ? a : -a;
        const q = b > 0 ? b : -b;
        if (m > peak) peak = m;
        if (q > peak) peak = q;
      }
      f.peak = peak;
      f.ll += ll;
      f.rr += rr;
      f.lr += lr;
      if (tp > f.tp) f.tp = tp;

      this.n += k;
      i += k;
      if (this.n === this.frameLen) this.completeFrame();
    }
  }

  completeFrame() {
    const f = this.f;
    this.frames++;
    this.n = 0;
    this.stereo.push(f.ll, f.rr, f.lr);
    this.crest.push(f.peak, f.ll + f.rr, 2 * this.frameLen);
    if (f.peak > this.s.peak) this.s.peak = f.peak;
    if (f.tp > this.s.tp) this.s.tp = f.tp;
    if (f.tp > this.maxTruePeak) this.maxTruePeak = f.tp;

    const m = this.loudness.momentary;
    const st = this.loudness.shortTerm;
    if (m > this.maxMomentary) this.maxMomentary = m;
    if (st > this.maxShortTerm) this.maxShortTerm = st;

    if (this.onFrame) {
      const stereo = this.stereo.current;
      this.onFrame({
        t: this.elapsed,
        momentary: m,
        shortTerm: st,
        samplePeakDb: toDb(f.peak),
        truePeakDb: toDb(f.tp),
        maxTruePeakDb: toDb(this.maxTruePeak),
        crestDb: this.crest.current,
        correlation: stereo.correlation,
        sideMidDb: stereo.sideMidDb,
        mono: stereo.mono,
        status: this.status,
      });
    }
    this.f = { peak: 0, tp: 0, ll: 0, rr: 0, lr: 0 };
    if (this.frames % 10 === 0) this.completeSecond();
  }

  completeSecond() {
    const c = this.clip.takeSecond();
    const t = this.elapsed;
    this.lastClip = c;
    this.statusSeconds[c.status]++;
    this.dwellSum += c.dwell;
    this.fullScaleSamples += c.fullScaleSamples;
    this.trackEpisode(c, t);

    const stereo = this.stereo.current;
    const row = {
      t,
      momentary: this.loudness.momentary,
      shortTerm: this.loudness.shortTerm,
      integrated: this.loudness.integrated,
      lra: this.loudness.loudnessRange,
      samplePeakDb: toDb(this.s.peak),
      truePeakDb: toDb(this.s.tp),
      maxTruePeakDb: toDb(this.maxTruePeak),
      rmsDb: this.crest.rmsDb,
      crestDb: this.crest.current,
      correlation: stereo.correlation,
      sideMidDb: stereo.sideMidDb,
      mono: stereo.mono,
      status: c.status,
      detectors: c.detectors,
      dwellRate: c.dwellRate,
      dwell: c.dwell,
      pileRatio: c.pileRatio,
      pinned: c.pinned,
      ceilingDb: c.ceilingDb,
      fullScaleRuns: c.fullScaleRuns,
      fullScaleSamples: c.fullScaleSamples,
    };
    this.s = { peak: 0, tp: 0 };
    if (this.onSecond) this.onSecond(row);
  }

  // Reports status episodes: a 'start' when the status worsens or changes, and an
  // 'end' (with duration and the detectors seen) when it leaves that status.
  trackEpisode(c, t) {
    if (c.status === this.status) {
      if (this.episode) {
        for (const d of c.detectors) if (!this.episode.detectors.includes(d)) this.episode.detectors.push(d);
        this.episode.maxDwellRate = Math.max(this.episode.maxDwellRate, c.dwellRate);
        this.episode.fullScaleSamples += c.fullScaleSamples;
      }
      return;
    }
    if (this.episode) {
      const e = this.episode;
      this.emit({ ...e, type: 'end', t, duration: t - e.start, detectors: [...e.detectors] });
      this.episode = null;
    }
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

  emit(e) {
    this.events++;
    if (this.onEvent) this.onEvent(e);
  }

  // Closes any open episode (end of file / stop). Safe to call more than once.
  finish() {
    if (this.episode) {
      const e = this.episode;
      const t = this.elapsed;
      this.emit({ ...e, type: 'end', t, duration: t - e.start, detectors: [...e.detectors] });
      this.episode = null;
      this.status = CLEAN;
    }
  }

  summary() {
    const secs = this.statusSeconds;
    const total = secs[CLEAN] + secs[LIMITED] + secs[CLIPPING];
    let overall = CLEAN;
    if (secs[CLIPPING] > 0) overall = CLIPPING;
    else if (total && secs[LIMITED] / total >= 0.25) overall = LIMITED;
    const stereo = this.stereo.session;
    return {
      duration: this.elapsed,
      sampleRate: this.sampleRate,
      integrated: this.loudness.integrated,
      lra: this.loudness.loudnessRange,
      maxMomentary: this.maxMomentary,
      maxShortTerm: this.maxShortTerm,
      samplePeakDb: toDb(this.crest.sessionPeak),
      truePeakDb: toDb(this.maxTruePeak),
      crestDb: this.crest.session,
      correlation: stereo.correlation,
      sideMidDb: stereo.sideMidDb,
      mono: stereo.mono,
      statusSeconds: { ...secs },
      overallStatus: overall,
      meanDwellRate: total ? this.dwellSum / total : 0,
      fullScaleSamples: this.fullScaleSamples,
      ceilingDb: this.lastClip ? this.lastClip.ceilingDb : null,
      worstStatus: Object.keys(secs).reduce((w, s) => (secs[s] && SEVERITY[s] > SEVERITY[w] ? s : w), CLEAN),
    };
  }
}

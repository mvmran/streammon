// StreamAnalyzer: runs every measurement over a stereo stream fed in blocks of any size.
// Pure JS with no browser or Node APIs, so it runs unchanged in an AudioWorklet, a Web
// Worker (file analysis) and the Node test harness.
//
// Output:
//   onFrame(frame)   every 100 ms of audio: meters for the display (with per-octave
//                    stereo in frame.bands, computed only when onFrame is set)
//   onSecond(row)    every 1 s of audio: one CSV row with every metric plus clip status
//   onHum(result)    every 0.5 s: mains hum measurement (see hum.js), with audibility
//   onEvent(event)   clip status changes: { type: 'start' | 'end', status, t, ... };
//                    hum: { type: 'hum-onset' | 'hum-offset' | 'hum-step' | 'hum-config', t, ... }
//                    (onset/offset per HUM_LOG, not every PRESENT change: see HumLog in episodes.js)
//                    stereo status changes: { type: 'stereo', t, status, detail, previous, previousSeconds }
//                    (file analysis: MONO, UNBALANCED mono, CHANNEL DEAD or STEREO, i.e. none of these)

import { LoudnessMeter } from './loudness.js';
import { TruePeakChannel } from './truepeak.js';
import { ClipDetector, CLEAN, LIMITED, CLIPPING, sessionStatus } from './clipdetect.js';
import { StereoMeter } from './stereo.js';
import { StereoBands, StereoStatus, STEREO_RULES, STEREO, CHANNEL_DEAD, deadChannel, deadDetail, monoStatus } from './stereobands.js';
import { CrestMeter, toDb } from './crest.js';
import { HumDetector, PRESENT as HUM_PRESENT, NOT_DETECTED as HUM_NOT_DETECTED, MASKED as HUM_MASKED } from './hum.js';
import { ClipEpisodes, StereoLog, HumLog, HUM_LOG } from './episodes.js';

export { CLEAN, LIMITED, CLIPPING };


export { HUM_LOG };

export class StreamAnalyzer {
  constructor(sampleRate, { onFrame = null, onSecond = null, onEvent = null, onHum = null, clipOptions = {}, humOptions = {} } = {}) {
    this.sampleRate = sampleRate;
    this.frameLen = Math.round(sampleRate * 0.1);
    this.onFrame = onFrame;
    this.onSecond = onSecond;
    this.onEvent = onEvent;
    this.onHum = onHum;
    this.loudness = new LoudnessMeter(sampleRate);
    this.hum = new HumDetector(sampleRate, humOptions, {
      // The detector counts time from its own (re)start: shift it to session time.
      onResult: (r) => this.humResult(this.humFrom ? { ...r, t: r.t + this.humFrom } : r),
      onEvent: (e) => this.humEvent(this.humFrom ? { ...e, t: e.t + this.humFrom } : e),
    });
    this.tp = [new TruePeakChannel(), new TruePeakChannel()];
    this.clip = new ClipDetector(sampleRate, clipOptions);
    this.stereo = new StereoMeter(10); // 1 s
    // Per-band stereo and the one-word stereo status: only computed when frames are
    // displayed (live and playback), not in the faster-than-real-time file analysis.
    this.bandStereo = onFrame ? new StereoBands(sampleRate, 10, STEREO_RULES.windowFrames) : null;
    this.stereoStatus = onFrame ? new StereoStatus() : null;
    this.crest = new CrestMeter(30); // 3 s
    const emit = (e) => this.emit(e);
    this.clipLog = new ClipEpisodes(emit);
    this.stereoLog = new StereoLog(emit);
    this.humLog = new HumLog(emit);
    this.reset();
    this.emitHumConfig(); // invalid settings fall back with a logged warning
  }

  reset() {
    this.loudness.reset();
    for (const t of this.tp) t.reset();
    this.clip.reset();
    this.stereo.reset();
    if (this.bandStereo) this.bandStereo.reset();
    if (this.stereoStatus) this.stereoStatus.reset();
    this.lastStereo = null;
    this.lastBands = null; // Stereo by band of the latest frame
    this.crest.reset();
    this.hum.reset();
    this.humFrom = 0; // session time the hum detector last (re)started at
    this.secPause = null; // buzz measured in a pause during the current second (the loudest)
    this.secPauseCount = 0; // how many half-second readings found buzz in it
    this.lastHum = null;
    this.humSeconds = { [HUM_PRESENT]: 0, [HUM_NOT_DETECTED]: 0, [HUM_MASKED]: 0 };
    this.humMaxDb = -Infinity;
    this.humLog.reset();
    this.frames = 0; // completed 100 ms frames
    this.n = 0; // frames into the current 100 ms frame
    this.f = { peak: 0, tp: 0, ll: 0, rr: 0, lr: 0 };
    this.s = { peak: 0, tp: 0 }; // current second
    this.maxTruePeak = 0;
    this.maxMomentary = -Infinity;
    this.maxShortTerm = -Infinity;
    this.statusSeconds = { [CLEAN]: 0, [LIMITED]: 0, [CLIPPING]: 0 };
    this.integratedFrom = 0; // elapsed time integrated loudness was last reset at
    this.dwellSum = 0;
    this.fullScaleSamples = 0;
    this.lastClip = null;
    this.clipLog.reset();
    this.stereoLog.reset();
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
      this.hum.process(l, r, k);
      if (this.bandStereo) this.bandStereo.process(l, r, k);
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
    if (this.bandStereo) this.bandStereo.endFrame();
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
      const bands = this.bandStereo.current;
      this.lastBands = bands; // the second's row reuses the last frame's (the same 1 s window)
      const judged = this.bandStereo.over(STEREO_RULES.windowFrames);
      this.lastStereo = this.stereoStatus.update(judged, stereo.mono, this.stereo.balanceDb, this.deadSide());
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
        bands,
        stereoStatus: this.lastStereo.status,
        stereoDetail: this.lastStereo.detail,
        status: this.clipLog.status,
      });
    }
    this.f = { peak: 0, tp: 0, ll: 0, rr: 0, lr: 0 };
    if (this.frames % 10 === 0) this.completeSecond();
  }

  completeSecond() {
    const c = this.clip.takeSecond();
    const h = this.lastHum;
    if (h) {
      this.humSeconds[h.status]++;
      if (h.present && h.levelDb > this.humMaxDb) this.humMaxDb = h.levelDb;
    }
    const t = this.elapsed;
    this.lastClip = c;
    this.statusSeconds[c.status]++;
    this.dwellSum += c.dwell;
    this.fullScaleSamples += c.fullScaleSamples;
    this.clipLog.update(c, t);
    this.humLog.update(h, t, this.hum.opt);

    const stereo = this.stereo.current;
    const dead = this.deadSide();
    const fileMono = monoStatus(this.stereo.balanceDb); // used when there is no StereoStatus
    const row = {
      t,
      momentary: this.loudness.momentary,
      shortTerm: this.loudness.shortTerm,
      integrated: this.loudness.integrated,
      integratedSeconds: t - this.integratedFrom, // since the last integrated reset
      lra: this.loudness.loudnessRange,
      samplePeakDb: toDb(this.s.peak),
      truePeakDb: toDb(this.s.tp),
      maxTruePeakDb: toDb(this.maxTruePeak),
      rmsDb: this.crest.rmsDb,
      crestDb: this.crest.current,
      correlation: stereo.correlation,
      sideMidDb: stereo.sideMidDb,
      mono: stereo.mono,
      stereoBalanceDb: this.stereo.balanceDb,
      // The file worker has no StereoStatus (no band filters): dead channel or mono only.
      stereoStatus: this.lastStereo ? this.lastStereo.status : dead ? CHANNEL_DEAD : stereo.mono ? fileMono.status : null,
      stereoDetail: this.lastStereo ? this.lastStereo.detail : dead ? deadDetail(dead) : stereo.mono ? fileMono.detail : null,
      status: c.status,
      detectors: c.detectors,
      dwellRate: c.dwellRate,
      dwell: c.dwell,
      pileRatio: c.pileRatio,
      pinned: c.pinned,
      ceilingDb: c.ceilingDb,
      fullScaleRuns: c.fullScaleRuns,
      fullScaleSamples: c.fullScaleSamples,
      humMainsHz: this.hum.opt.mainsFrequencyHz,
      humStatus: h ? h.status : null,
      humLevelDb: h && h.present ? h.levelDb : null,
      humFrequencyHz: h && h.present ? h.fundamentalHz : null,
      humProminenceDb: h && h.present ? h.prominenceDb : null,
      humProjectedDb: h && h.present ? h.projectedDb : null,
      humSignature: h && h.present ? h.signature : null,
      // Buzz in a pause this second (any status): dBFS of the harmonics summed, which ones,
      // and how many half-second readings found it (a 2 s pause gives about three).
      humPauseDb: this.secPause ? this.secPause.levelDb : null,
      humPauseHz: this.secPause ? this.secPause.lines.map((k) => k * this.hum.opt.mainsFrequencyHz) : null,
      humPauseReadings: this.secPauseCount,
      // Stereo by band over this second (live only: the file worker has no band filters).
      bands: this.lastBands,
    };
    this.s = { peak: 0, tp: 0 };
    // The file worker has no StereoStatus: there no status means ordinary stereo.
    this.stereoLog.update(row.stereoStatus || (this.stereoStatus ? null : STEREO), row.stereoDetail, t);
    this.secPause = null;
    this.secPauseCount = 0;
    if (this.onSecond) this.onSecond(row);
  }

  // The detector reports every PRESENT change; the log gets episodes per HUM_LOG instead.
  // Level steps are only passed on during a logged episode.
  humEvent(e) {
    if (e.type === 'hum-onset' || e.type === 'hum-offset') return;
    if (e.type === 'hum-step' && !this.humLog.active) return;
    this.emit(e);
  }

  emit(e) {
    this.events++;
    if (this.onEvent) this.onEvent(e);
  }

  // Adds audibility to each hum measurement: how far below the programme it sits, and
  // where it would land if the speech were brought up to speechTargetLufs (quiet speech
  // that viewers turn up makes hum much more audible).
  humResult(r) {
    const st = this.loudness.shortTerm;
    const integ = this.loudness.integrated;
    const programme = Number.isFinite(integ) ? integ : st;
    r.shortTerm = st;
    r.programmeLufs = programme;
    r.belowProgrammeDb = r.present && Number.isFinite(st) ? st - r.levelDb : null;
    r.projectedDb = r.present && Number.isFinite(programme) ? r.levelDb + (this.hum.opt.speechTargetLufs - programme) : null;
    r.speechTargetLufs = this.hum.opt.speechTargetLufs;
    // Buzz measured in a pause during this second (the loudest, if two half-second hops did).
    if (r.pause && r.pause.ageSec === 0 && r.pause.buzz) {
      this.secPauseCount++;
      if (!(this.secPause && this.secPause.levelDb >= r.pause.levelDb)) this.secPause = r.pause;
    }
    this.lastHum = r;
    if (this.onHum) this.onHum(r);
  }

  // Changes the hum settings (e.g. mains frequency) mid-session; logged as an event.
  setHumOptions(options) {
    const prev = this.hum.opt.mainsFrequencyHz;
    this.hum.configure(options); // restarts the detector, and its clock, from now
    this.humFrom = this.elapsed;
    this.lastHum = null;
    this.emitHumConfig(prev);
  }

  emitHumConfig(prevMainsHz = null) {
    const o = this.hum.opt;
    if (prevMainsHz !== null && prevMainsHz !== o.mainsFrequencyHz) {
      this.emit({ type: 'hum-config', t: this.elapsed, mainsHz: o.mainsFrequencyHz, message: `Mains setting changed to ${o.mainsFrequencyHz} Hz` });
    }
    for (const w of this.hum.configWarnings) this.emit({ type: 'hum-config', t: this.elapsed, mainsHz: o.mainsFrequencyHz, message: w, warning: true });
  }

  // 'left' / 'right' when that channel is silent while the other carries sound.
  deadSide() {
    const [l, r] = this.stereo.channelDb(this.frameLen);
    return deadChannel(l, r);
  }

  // Meter resets from the UI, e.g. after changing a gain while tuning.
  resetPeaks() {
    this.maxTruePeak = 0;
    this.f.tp = 0; // drop the part of the current 100 ms frame measured before the reset
  }

  resetIntegrated() {
    this.loudness.resetIntegration();
    this.integratedFrom = this.elapsed;
  }

  // Closes any open episode (end of file / stop). Safe to call more than once.
  finish() {
    this.clipLog.finish(this.elapsed);
  }

  summary() {
    const secs = this.statusSeconds;
    const { overall, worst, total } = sessionStatus(secs);
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
      worstStatus: worst,
      hum: {
        mainsHz: this.hum.opt.mainsFrequencyHz,
        statusSeconds: { ...this.humSeconds },
        maxLevelDb: this.humMaxDb,
        last: this.lastHum,
      },
    };
  }
}

// The live audio graph: source -> analyzer worklet (+ AnalyserNode for the spectrum).
// Also plays files back through the same graph so meters run during playback.

import { SPECTRUM_FFT_SIZE, FINE_FFT_SIZE } from '../dsp/bands.js';

const WORKLET_URL = new URL('./analyzer-worklet.js', import.meta.url);
const FILE_WORKER_URL = new URL('./file-worker.js', import.meta.url);

export class AudioEngine {
  constructor({ onFrame, onSecond, onEvent, onEnded, onHum } = {}) {
    this.handlers = { onFrame, onSecond, onEvent, onEnded, onHum };
    this.humOptions = {}; // mains hum detector settings, applied at start and on change
    this.ctx = null;
    this.stream = null;
    this.source = null;
    this.buffer = null;
    this.playStart = 0; // ctx time when playback started
    this.playOffset = 0; // file offset at that time
    this.resets = 0; // resets sent to the worklet and not yet confirmed
    this.resetWaiters = [];
    this.requests = new Map(); // request id -> resolve (summary replies)
    this.nextId = 1;
  }

  get running() {
    return !!this.ctx;
  }

  async init(sampleRate) {
    await this.close();
    // latencyHint 'playback' gives larger buffers: less CPU wake-up on older laptops.
    this.ctx = new AudioContext({ sampleRate, latencyHint: 'playback' });
    await this.ctx.audioWorklet.addModule(WORKLET_URL);
    this.node = new AudioWorkletNode(this.ctx, 'stream-analyzer', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 2,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers', // a mono source is copied to both channels
      processorOptions: { humOptions: this.humOptions },
    });
    this.node.port.onmessage = (e) => this.onMessage(e.data);
    // The worklet must reach the destination to be pulled; keep it silent.
    this.mute = new GainNode(this.ctx, { gain: 0 });
    this.node.connect(this.mute).connect(this.ctx.destination);
    this.analyser = new AnalyserNode(this.ctx, { fftSize: SPECTRUM_FFT_SIZE, smoothingTimeConstant: 0.5, minDecibels: -110, maxDecibels: 0 });
    // A finer spectrum for the bottom of the display (below FINE_MAX_HZ in spectrum.js):
    // 1.5 Hz bins at 48 kHz, so a bass note or mains hum stays on its own frequency.
    this.analyserFine = new AnalyserNode(this.ctx, { fftSize: FINE_FFT_SIZE, smoothingTimeConstant: 0.5, minDecibels: -110, maxDecibels: 0 });
    this.input = new GainNode(this.ctx, { gain: 1, channelCount: 2, channelCountMode: 'explicit' });
    this.input.connect(this.node);
    this.input.connect(this.analyser);
    this.input.connect(this.analyserFine);
    // Left and right spectra for the pan map (display only).
    this.splitter = new ChannelSplitterNode(this.ctx, { numberOfOutputs: 2 });
    this.analyserL = new AnalyserNode(this.ctx, { fftSize: SPECTRUM_FFT_SIZE, smoothingTimeConstant: 0.5, minDecibels: -110, maxDecibels: 0 });
    this.analyserR = new AnalyserNode(this.ctx, { fftSize: SPECTRUM_FFT_SIZE, smoothingTimeConstant: 0.5, minDecibels: -110, maxDecibels: 0 });
    this.input.connect(this.splitter);
    this.splitter.connect(this.analyserL, 0);
    this.splitter.connect(this.analyserR, 1);
    if (this.ctx.state === 'suspended') await this.ctx.resume();
  }

  onMessage(msg) {
    const h = this.handlers;
    if (msg.type === 'reset-done') {
      if (this.resets > 0 && --this.resets === 0) this.endReset();
      return;
    }
    if (msg.type === 'summary') {
      const resolve = this.requests.get(msg.id);
      this.requests.delete(msg.id);
      if (resolve) resolve(msg.summary);
      return;
    }
    if (this.resets) return; // measured before a reset, still in flight
    if (msg.type === 'frame' && h.onFrame) h.onFrame(msg.frame);
    else if (msg.type === 'second' && h.onSecond) h.onSecond(msg.row);
    else if (msg.type === 'event' && h.onEvent) h.onEvent(msg.event);
    else if (msg.type === 'hum' && h.onHum) h.onHum(msg.hum);
  }

  // `monitor`: also play the stream to the speakers (needed for extension tab capture,
  // which otherwise mutes the tab).
  async startStream(stream, sampleRate, { monitor = false } = {}) {
    try {
      await this.init(sampleRate);
    } catch (e) {
      // Don't leave the microphone or tab capture running when the graph can't be built.
      for (const t of stream.getTracks()) t.stop();
      await this.close();
      throw e;
    }
    this.stream = stream;
    this.source = new MediaStreamAudioSourceNode(this.ctx, { mediaStream: stream });
    this.source.connect(this.input);
    if (monitor) this.source.connect(this.ctx.destination);
    for (const t of stream.getAudioTracks()) {
      t.addEventListener('ended', () => this.handlers.onEnded && this.handlers.onEnded('Capture ended'));
    }
  }

  // File playback through the analyzer and to the speakers.
  async startFile(buffer, offset = 0) {
    if (!this.ctx || this.buffer !== buffer || this.ctx.sampleRate !== buffer.sampleRate) {
      await this.init(buffer.sampleRate);
      this.buffer = buffer;
      this.out = new GainNode(this.ctx, { gain: 1 });
      this.input.connect(this.out).connect(this.ctx.destination);
    }
    this.seek(offset);
  }

  seek(offset) {
    if (!this.buffer) return;
    this.stopSource();
    this.reset(); // rows from the old position still in flight are dropped
    const src = new AudioBufferSourceNode(this.ctx, { buffer: this.buffer });
    src.connect(this.input);
    src.onended = () => {
      if (this.source === src) {
        this.source = null;
        if (this.handlers.onEnded) this.handlers.onEnded('Playback finished');
      }
    };
    this.playOffset = Math.max(0, Math.min(offset, this.buffer.duration));
    this.playStart = this.ctx.currentTime;
    src.start(0, this.playOffset);
    this.source = src;
  }

  get position() {
    if (!this.ctx || !this.buffer || !this.source) return null;
    return this.playOffset + (this.ctx.currentTime - this.playStart);
  }

  stopSource() {
    if (this.source) {
      const s = this.source;
      this.source = null;
      try {
        if (s.stop) s.stop();
      } catch {
        // Already stopped.
      }
      s.disconnect();
    }
  }

  // Mains hum settings (e.g. 50 / 60 Hz): used from the next start, and applied now if running.
  setHumOptions(options) {
    this.humOptions = { ...options };
    if (this.node) this.node.port.postMessage({ type: 'hum-config', options: this.humOptions });
  }

  // Restart the max true peak / integrated loudness from now (meter clicks).
  resetPeaks() {
    if (this.node) this.node.port.postMessage({ type: 'reset-peaks' });
  }

  resetIntegrated() {
    if (this.node) this.node.port.postMessage({ type: 'reset-integrated' });
  }

  // Starts every measurement afresh (time back to 0). Resolves once the worklet has reset;
  // frames, rows and events measured before it are dropped.
  // Several can overlap: output is dropped until the worklet has confirmed them all.
  reset() {
    if (!this.node) return Promise.resolve();
    return new Promise((resolve) => {
      this.resetWaiters.push(resolve);
      this.resets++;
      this.node.port.postMessage({ type: 'reset', ack: true });
      setTimeout(() => this.resetWaiters.includes(resolve) && this.endReset(), 1000);
    });
  }

  endReset() {
    this.resets = 0;
    const waiters = this.resetWaiters;
    this.resetWaiters = [];
    for (const resolve of waiters) resolve();
  }

  // Asks the worklet to close any open episode and report its session summary.
  finish() {
    return this.request('finish');
  }

  // The session summary so far, without ending anything.
  summary() {
    return this.request('summary');
  }

  // Each request carries an id, so overlapping ones (two exports, an export during Stop)
  // each get their own reply.
  request(type) {
    if (!this.node) return Promise.resolve(null);
    return new Promise((resolve) => {
      const id = this.nextId++;
      this.requests.set(id, resolve);
      this.node.port.postMessage({ type, id });
      setTimeout(() => {
        if (this.requests.delete(id)) resolve(null);
      }, 1000);
    });
  }

  async close() {
    this.stopSource();
    if (this.node) {
      // Nothing measured after this point reaches the page (e.g. frames in flight at Stop).
      this.node.port.onmessage = null;
      this.node = null;
    }
    this.analyser = this.analyserFine = this.analyserL = this.analyserR = null;
    for (const resolve of this.requests.values()) resolve(null);
    this.requests.clear();
    this.endReset();
    if (this.stream) {
      for (const t of this.stream.getTracks()) t.stop();
      this.stream = null;
    }
    this.buffer = null;
    if (this.ctx) {
      const ctx = this.ctx;
      this.ctx = null;
      await ctx.close();
    }
  }

  // Short alert tone, only when the user has turned sound on.
  beep() {
    const ctx = this.ctx || new AudioContext();
    const osc = new OscillatorNode(ctx, { frequency: 880 });
    const g = new GainNode(ctx, { gain: 0 });
    osc.connect(g).connect(ctx.destination);
    const t = ctx.currentTime;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.15, t + 0.01);
    g.gain.linearRampToValueAtTime(0, t + 0.25);
    osc.start(t);
    osc.stop(t + 0.3);
  }
}

// Analyses a decoded AudioBuffer in a worker, faster than real time. Aborting `signal`
// stops the worker and rejects with an AbortError.
export function analyseBuffer(buffer, { onProgress, clipOptions, humOptions, signal } = {}) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(FILE_WORKER_URL, { type: 'module' });
    if (signal) {
      signal.addEventListener('abort', () => {
        worker.terminate();
        reject(new DOMException('Analysis cancelled', 'AbortError'));
      }, { once: true });
    }
    const chunk = buffer.sampleRate * 10;
    const left = buffer.getChannelData(0);
    const right = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : left;
    let pos = 0;
    const send = () => {
      if (pos >= buffer.length) {
        worker.postMessage({ type: 'end' });
        return;
      }
      const end = Math.min(buffer.length, pos + chunk);
      const l = left.slice(pos, end);
      const r = right === left ? l : right.slice(pos, end);
      worker.postMessage({ type: 'chunk', channels: r === l ? [l] : [l, r] }, r === l ? [l.buffer] : [l.buffer, r.buffer]);
      pos = end;
    };
    worker.onmessage = (e) => {
      const msg = e.data;
      if (msg.type === 'ack') {
        if (onProgress) onProgress(pos / buffer.length);
        send();
      } else if (msg.type === 'done') {
        worker.terminate();
        resolve(msg);
      }
    };
    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(e.message || 'Analysis worker failed'));
    };
    worker.postMessage({ type: 'start', sampleRate: buffer.sampleRate, clipOptions, humOptions });
    send();
  });
}

// AudioWorklet wrapper around StreamAnalyzer. Runs on the audio thread and posts
// 100 ms frames, 1 s rows and status events to the main thread.

import { StreamAnalyzer } from '../dsp/analyzer.js';

class StreamAnalyzerProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const po = options.processorOptions || {};
    this.analyzer = new StreamAnalyzer(sampleRate, {
      clipOptions: po.clipOptions || {},
      humOptions: po.humOptions || {},
      onHum: (hum) => this.port.postMessage({ type: 'hum', hum }),
      onFrame: (frame) => this.port.postMessage({ type: 'frame', frame }),
      onSecond: (row) => this.port.postMessage({ type: 'second', row }),
      onEvent: (event) => this.port.postMessage({ type: 'event', event }),
      onCapture: po.captures ? (snap) => this.postSnap(snap) : null,
    });
    this.port.onmessage = (e) => {
      if (e.data.type === 'reset') {
        this.analyzer.reset();
        if (e.data.ack) this.port.postMessage({ type: 'reset-done' });
      }
      else if (e.data.type === 'reset-peaks') this.analyzer.resetPeaks();
      else if (e.data.type === 'reset-integrated') this.analyzer.resetIntegrated();
      else if (e.data.type === 'freeze') this.postSnap(this.analyzer.freeze(), e.data.id);
      else if (e.data.type === 'hum-config') this.analyzer.setHumOptions(e.data.options);
      else if (e.data.type === 'finish') {
        this.analyzer.finish();
        this.port.postMessage({ type: 'summary', id: e.data.id, summary: this.analyzer.summary() });
      } else if (e.data.type === 'summary') {
        this.port.postMessage({ type: 'summary', id: e.data.id, summary: this.analyzer.summary() });
      }
    };
  }

  // A waveform snapshot (waveform.js), its sample arrays handed over rather than copied.
  postSnap(snap, id) {
    const transfer = snap ? [snap.left.buffer, snap.right.buffer, snap.ceilings.buffer, snap.statuses.buffer] : [];
    this.port.postMessage({ type: 'wave', id, snap }, transfer);
  }

  process(inputs) {
    const input = inputs[0];
    // No input connected (e.g. paused playback): don't advance time.
    if (input && input.length) {
      const left = input[0];
      this.analyzer.process(left, input[1] || left, left.length);
    }
    return true;
  }
}

registerProcessor('stream-analyzer', StreamAnalyzerProcessor);

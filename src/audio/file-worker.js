// Web Worker that analyses a decoded file faster than real time. The main thread sends
// the audio in chunks and waits for each 'ack', so memory stays bounded.

import { StreamAnalyzer } from '../dsp/analyzer.js';

let analyzer = null;
let rows = [];
let events = [];

self.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === 'start') {
    rows = [];
    events = [];
    analyzer = new StreamAnalyzer(msg.sampleRate, {
      clipOptions: msg.clipOptions || {},
      onSecond: (row) => rows.push(row),
      onEvent: (event) => events.push(event),
    });
  } else if (msg.type === 'chunk') {
    const [left, right = left] = msg.channels;
    analyzer.process(left, right, left.length);
    self.postMessage({ type: 'ack', processed: analyzer.elapsed, rows: rows.length });
  } else if (msg.type === 'end') {
    analyzer.finish();
    self.postMessage({ type: 'done', rows, events, summary: analyzer.summary() });
    analyzer = null;
    rows = [];
    events = [];
  }
};

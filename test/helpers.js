import { StreamAnalyzer } from '../src/dsp/analyzer.js';

// Runs a whole signal through the analyzer in worklet-sized blocks and collects output.
export function analyse(left, right, sampleRate, { block = 128, clipOptions } = {}) {
  const rows = [];
  const events = [];
  const frames = [];
  const a = new StreamAnalyzer(sampleRate, {
    clipOptions,
    onFrame: (f) => frames.push(f),
    onSecond: (r) => rows.push(r),
    onEvent: (e) => events.push(e),
  });
  for (let i = 0; i < left.length; i += block) {
    const n = Math.min(block, left.length - i);
    a.process(left.subarray(i, i + n), right.subarray(i, i + n), n);
  }
  a.finish();
  return { summary: a.summary(), rows, events, frames };
}

export function sine(sampleRate, seconds, freq, amplitude, phase = 0) {
  const n = Math.round(sampleRate * seconds);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = amplitude * Math.sin((2 * Math.PI * freq * i) / sampleRate + phase);
  return x;
}

export const dbToLin = (db) => Math.pow(10, db / 20);

// Status letters per second, e.g. "XXXX...LLL" (X clipping, L limited, . clean).
export function statusString(rows) {
  return rows.map((r) => ({ CLEAN: '.', LIMITED: 'L', CLIPPING: 'X' })[r.status]).join('');
}

// Rows whose second ends in (from, to].
export function between(rows, from, to) {
  return rows.filter((r) => r.t > from + 1e-6 && r.t <= to + 1e-6);
}

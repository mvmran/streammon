// Per-octave stereo (src/dsp/stereobands.js): correlation, balance and level per band.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StereoBands } from '../src/dsp/stereobands.js';
import { StreamAnalyzer } from '../src/dsp/analyzer.js';

const SR = 48000;

// Mono 62.5 Hz, a 1 kHz tone 6 dB down on the right, an out-of-phase 4 kHz tone and a
// little decorrelated noise.
function scene(seconds = 2) {
  const n = SR * seconds;
  const L = new Float32Array(n), R = new Float32Array(n);
  let seed = 1;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32) * 2 - 1;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const bass = 0.3 * Math.sin(2 * Math.PI * 62.5 * t);
    const mid = 0.2 * Math.sin(2 * Math.PI * 1000 * t);
    const hi = 0.1 * Math.sin(2 * Math.PI * 4000 * t);
    L[i] = bass + mid + hi + 0.02 * rnd();
    R[i] = bass + 0.5 * mid - hi + 0.02 * rnd();
  }
  return [L, R];
}

function measure(L, R, block) {
  const sb = new StereoBands(SR, 10);
  const frame = SR / 10;
  for (let f = 0; f < L.length; f += frame) {
    for (let i = f; i < f + frame; i += block) {
      const k = Math.min(block, f + frame - i);
      sb.process(L.subarray(i, i + k), R.subarray(i, i + k), k);
    }
    sb.endFrame();
  }
  return Object.fromEntries(sb.current.map((b) => [b.fc, b]));
}

test('correlation, balance and level per octave', () => {
  const b = measure(...scene(), 4800);
  assert.ok(b[62.5].correlation > 0.999, `mono bass ${b[62.5].correlation}`);
  assert.ok(Math.abs(b[62.5].balanceDb) < 0.1);
  assert.ok(b[1000].correlation > 0.99, `panned tone is still correlated ${b[1000].correlation}`);
  assert.ok(Math.abs(b[1000].balanceDb + 6.02) < 0.2, `1 kHz is 6 dB left (${b[1000].balanceDb})`);
  assert.ok(b[4000].correlation < -0.98, `4 kHz out of phase ${b[4000].correlation}`);
  // A 0.3 amplitude sine is -13.5 dBFS RMS; the band filter passes it at about 0 dB.
  assert.ok(Math.abs(b[62.5].levelDb + 13.5) < 0.5, `bass level ${b[62.5].levelDb}`);
});

test('results do not depend on block size', () => {
  const [L, R] = scene(1);
  const a = measure(L, R, 4800), c = measure(L, R, 128);
  for (const fc of Object.keys(a)) {
    if (a[fc].correlation === null) continue;
    assert.ok(Math.abs(a[fc].correlation - c[fc].correlation) < 1e-9, fc);
    assert.ok(Math.abs(a[fc].balanceDb - c[fc].balanceDb) < 1e-9, fc);
  }
});

test('silence gives no correlation or balance; bands above Nyquist are left out', () => {
  const sb = new StereoBands(32000, 10);
  const z = new Float32Array(3200);
  sb.process(z, z, z.length);
  sb.endFrame();
  for (const b of sb.current) {
    assert.equal(b.correlation, null);
    assert.equal(b.balanceDb, null);
  }
  assert.equal(sb.current.at(-1).levelDb, null, '16 kHz band is not measured at 32 kHz');
});

test('the analyzer reports bands with each frame, and skips them without onFrame', () => {
  const frames = [];
  const an = new StreamAnalyzer(SR, { onFrame: (f) => frames.push(f) });
  const [L, R] = scene(1);
  an.process(L, R);
  assert.equal(frames.at(-1).bands.length, 10);
  assert.ok(frames.at(-1).bands[7].correlation < -0.9, '4 kHz out of phase');
  assert.equal(new StreamAnalyzer(SR, {}).bandStereo, null);
});

// Per-octave stereo (src/dsp/stereobands.js): correlation, balance and level per band.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StereoBands, StereoStatus, MONO, STEREO_OK, WIDE, UNBALANCED, PHASE_PROBLEM, CHANNEL_DEAD, deadChannel } from '../src/dsp/stereobands.js';
import { StreamAnalyzer } from '../src/dsp/analyzer.js';
import { AlertMonitor } from '../src/dsp/alerts.js';
import { csvHeader, csvRow } from '../src/dsp/report.js';

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

// Ten octave bands with the given correlations (one value, or one per band) at -30 dBFS.
const bands = (corr, { balanceDb = 0, levelDb = -30 } = {}) =>
  [31.25, 62.5, 125, 250, 500, 1000, 2000, 4000, 8000, 16000].map((fc, i) => ({
    fc,
    correlation: Array.isArray(corr) ? corr[i] : corr,
    balanceDb,
    levelDb: Array.isArray(levelDb) ? levelDb[i] : levelDb,
  }));

test('stereo status words', () => {
  const s = () => new StereoStatus();
  assert.equal(s().update(bands(1), true, 0).status, MONO);
  assert.equal(s().update(bands([1, 1, 0.9, 0.8, 0.7, 0.6, 0.5, 0.5, 0.4, 0.3]), false, 0.5).status, STEREO_OK);
  assert.equal(s().update(bands([1, 0.9, 0.2, 0.1, 0.1, 0.1, 0, 0.1, 0, 0]), false, 0).status, WIDE);
  const unb = s().update(bands(0.8), false, -4.2);
  assert.equal(unb.status, UNBALANCED);
  assert.match(unb.detail, /4\.2 dB louder on the left/);
  const ph = s().update(bands([1, 1, 0.9, 0.8, 0.7, 0.6, -0.6, -0.5, 0.4, 0.3]), false, 0);
  assert.equal(ph.status, PHASE_PROBLEM);
  assert.match(ph.detail, /^2k, 4k out of phase/);
  // Quiet bands (mic hiss) are not judged.
  assert.equal(s().update(bands(-0.5, { levelDb: -85 }), false, 0).status, null);
  // A negative band 25 dB below the loudest is not a phase problem.
  const lv = [-20, -20, -20, -20, -20, -20, -45, -20, -20, -20];
  assert.equal(s().update(bands([1, 1, 0.9, 0.8, 0.7, 0.6, -0.6, 0.5, 0.4, 0.3], { levelDb: lv }), false, 0).status, STEREO_OK);
  // Bass bands are not judged for phase (spaced mics swing them in and out note by note).
  assert.equal(s().update(bands([-0.9, -0.9, 0.9, 0.8, 0.7, 0.6, 0.5, 0.5, 0.4, 0.3]), false, 0).status, STEREO_OK);
});

// Noise at -20 dBFS, the same on both sides, with the right channel inverted from `from`
// to `to` seconds.
function flipped(seconds, from, to) {
  const n = SR * seconds;
  const L = new Float32Array(n), R = new Float32Array(n);
  let seed = 3;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32) * 2 - 1;
  for (let i = 0; i < n; i++) {
    L[i] = 0.17 * rnd();
    R[i] = i >= from * SR && i < to * SR ? -L[i] : L[i];
  }
  return [L, R];
}

test('phase is judged over 3 s: a 1 s flip is not a phase problem, a lasting one is', () => {
  const statuses = (L, R) => {
    const out = [];
    new StreamAnalyzer(SR, { onFrame: (f) => out.push(f.stereoStatus) }).process(L, R);
    return out;
  };
  const brief = statuses(...flipped(8, 4, 5));
  assert.ok(!brief.includes(PHASE_PROBLEM), 'a 1 s flip passes');
  const lasting = statuses(...flipped(10, 4, 10));
  assert.ok(!lasting.slice(0, 41).includes(PHASE_PROBLEM));
  assert.equal(lasting.at(-1), PHASE_PROBLEM);
  const first = lasting.indexOf(PHASE_PROBLEM) / 10 - 4;
  assert.ok(first > 1 && first < 3, `flagged ${first} s into the flip`);
});

test('dead channel: one side silent while the other carries sound', () => {
  assert.equal(deadChannel(-20, -Infinity), 'right');
  assert.equal(deadChannel(-95, -25), 'left', 'an analog noise floor counts as dead');
  assert.equal(deadChannel(-20, -45), null, '25 dB down is very unbalanced, not dead');
  assert.equal(deadChannel(-70, -Infinity), null, 'nothing playing: not judged');
  const st = new StereoStatus().update(bands(0.8), false, null, 'right');
  assert.equal(st.status, CHANNEL_DEAD);
  assert.match(st.detail, /^Right channel silent/);
});

test('the analyzer flags a dead channel in frames and rows (the file worker too)', () => {
  const [L] = flipped(3, 0, 0);
  const zeros = new Float32Array(L.length);
  const frames = [], rows = [];
  new StreamAnalyzer(SR, { onFrame: (f) => frames.push(f), onSecond: (r) => rows.push(r) }).process(L, zeros);
  assert.equal(frames.at(-1).stereoStatus, CHANNEL_DEAD);
  assert.equal(rows.at(-1).stereoStatus, CHANNEL_DEAD);
  const fileRows = [];
  new StreamAnalyzer(SR, { onSecond: (r) => fileRows.push(r) }).process(zeros, L);
  assert.equal(fileRows.at(-1).stereoStatus, CHANNEL_DEAD);
  assert.match(fileRows.at(-1).stereoDetail, /^Left channel silent/);
});

test('a worse stereo status is held for 3 s', () => {
  const st = new StereoStatus();
  const ok = bands(0.8), bad = bands([1, 1, 0.9, 0.8, 0.7, 0.6, -0.6, 0.5, 0.4, 0.3]);
  assert.equal(st.update(bad, false, 0).status, PHASE_PROBLEM);
  for (let i = 0; i < 29; i++) assert.equal(st.update(ok, false, 0).status, PHASE_PROBLEM); // 30 frames in all
  assert.equal(st.update(ok, false, 0).status, STEREO_OK);
  // MONO is shown at once.
  st.update(bad, false, 0);
  assert.equal(st.update(ok, true, 0).status, MONO);
});

test('stereo alerts: phase after 5 s, imbalance after 15 s, mono only when asked', () => {
  const row = (t, stereoStatus, stereoDetail = 'x') => ({ t, status: 'CLEAN', stereoStatus, stereoDetail, shortTerm: -20, truePeakDb: -6, integrated: -14 });
  const m = new AlertMonitor();
  let r;
  for (let t = 1; t <= 5; t++) r = m.update(row(t, PHASE_PROBLEM, '2k out of phase: cancels in mono'));
  assert.deepEqual(r.raised.map((a) => a.id), ['stereoPhase']);
  const u = new AlertMonitor();
  for (let t = 1; t <= 14; t++) assert.equal(u.update(row(t, UNBALANCED)).raised.length, 0);
  assert.deepEqual(u.update(row(15, UNBALANCED)).raised.map((a) => a.id), ['stereoBalance']);
  const mono = new AlertMonitor();
  for (let t = 1; t <= 30; t++) assert.equal(mono.update(row(t, MONO)).raised.length, 0);
  const dead = new AlertMonitor();
  for (let t = 1; t <= 4; t++) assert.equal(dead.update(row(t, CHANNEL_DEAD)).raised.length, 0);
  assert.deepEqual(dead.update(row(5, CHANNEL_DEAD)).raised.map((a) => a.id), ['stereoDead']);
  const asked = new AlertMonitor({ stereo: { mono: true } });
  for (let t = 1; t <= 9; t++) asked.update(row(t, MONO));
  assert.deepEqual(asked.update(row(10, MONO)).raised.map((a) => a.id), ['stereoMono']);
});

test('frames and rows carry the stereo status; the CSV has it', () => {
  const frames = [], rows = [];
  const an = new StreamAnalyzer(SR, { onFrame: (f) => frames.push(f), onSecond: (r) => rows.push(r) });
  const [L, R] = scene(2);
  an.process(L, R);
  assert.equal(frames.at(-1).stereoStatus, PHASE_PROBLEM, frames.at(-1).stereoDetail);
  assert.equal(rows.at(-1).stereoStatus, PHASE_PROBLEM);
  assert.ok(csvHeader().includes('stereo_status'));
  assert.ok(csvRow(rows.at(-1)).includes('PHASE PROBLEM'));
  // Identical channels read MONO even in the file worker, which skips the band filters.
  const fileRows = [];
  const fa = new StreamAnalyzer(SR, { onSecond: (r) => fileRows.push(r) });
  fa.process(L, L);
  assert.equal(fileRows.at(-1).stereoStatus, MONO);
});

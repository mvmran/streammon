// Waveform captures (src/dsp/waveform.js): kept by the analyzer when clipping starts and on
// Freeze, rebuilt from a decoded file, carried in the JSON log; and the clipped-peak marks
// calibrated on the recordings.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { StreamAnalyzer } from '../src/dsp/analyzer.js';
import { WAVE, CLIP, STATUS_CODE, NO_STATUS, WaveRing, bufferSnapshot, findClipped, eventCapture, rangeCapture, captureJson, captureFromJson, inClipping } from '../src/dsp/waveform.js';
import { syntheticSignals, programme, hardClip, lowpass, scale } from './synthetic.js';
import { analyse } from './helpers.js';
import { readWav } from './wav.js';

const SR = 48000;

// Runs the analyzer (captures on unless told otherwise); rows, events, snapshots, analyzer.
function capture(L, R, sr = SR, block = 128, captures = true) {
  const rows = [], events = [], snaps = [];
  const a = new StreamAnalyzer(sr, {
    onSecond: (r) => rows.push(r),
    onEvent: (e) => events.push(e),
    onCapture: captures ? (s) => snaps.push(s) : null,
  });
  for (let i = 0; i < L.length; i += block) {
    const n = Math.min(block, L.length - i);
    a.process(L.subarray(i, i + n), R.subarray(i, i + n), n);
  }
  return { rows, events, snaps, a };
}

// Clean, then hard-clipped at -3 dBFS from 12 s, low-passed like YouTube audio.
function cleanThenClipped(seconds = 20) {
  const hot = programme(SR, seconds, -9, 7);
  const cut = 12 * SR;
  const x = new Float32Array(hot.length);
  const clipped = hardClip(hot, -3);
  for (let i = 0; i < x.length; i++) x[i] = i < cut ? hot[i] * 0.25 : clipped[i];
  return lowpass(scale(x, -2), SR);
}

describe('captures', () => {
  const x = cleanThenClipped();
  const live = capture(x, x);
  const statuses = live.rows.map((r) => r.status);
  const clipSnap = () => live.snaps.find((s) => s.status === 'CLIPPING');

  test('turning captures on changes no reading', () => {
    const plain = capture(x, x, SR, 128, false);
    assert.equal(JSON.stringify(live.rows), JSON.stringify(plain.rows));
    assert.deepEqual(live.events.map(({ wave, ...e }) => e), plain.events);
    assert.equal(plain.a.freeze(), null);
  });

  test('only clipping starts are captured, each event naming its snapshot', () => {
    const starts = live.events.filter((e) => e.type === 'start');
    assert.ok(starts.some((e) => e.status === 'CLIPPING'), 'a clipping start');
    for (const e of starts) assert.equal(e.wave !== undefined, e.status === 'CLIPPING', `${e.status} at ${e.t}`);
    assert.deepEqual(starts.filter((e) => e.wave).map((e) => e.wave), live.snaps.map((s) => s.id));
    const s = clipSnap();
    // From beforeSec before the second that turned the status to afterSec after it.
    assert.equal(s.start, Math.round((s.eventT - WAVE.beforeSec) * SR));
    assert.equal(s.left.length, (WAVE.beforeSec + 1 + WAVE.afterSec) * SR);
    assert.equal(s.statuses[WAVE.beforeSec], STATUS_CODE.CLIPPING);
  });

  test('a clipping capture marks the flat tops, only in CLIPPING seconds', () => {
    const s = clipSnap();
    const c = eventCapture(s, { key: 'k', status: s.status });
    assert.equal(c.n, WAVE.eventSec * SR);
    assert.equal(c.right, null, 'mono: one channel kept');
    const flat = c.marks.filter((r) => r.kind === 'flat');
    assert.ok(flat.length >= 5, `${flat.length} clipped peaks in half a second`);
    const minTop = Math.round((CLIP.minTopMs / 1000) * SR);
    for (const r of flat) {
      assert.ok(r.e - r.s >= minTop);
      // The whole top is within topDb of the peak, which is near -5 dBFS (-3 dB, then -2 dB).
      for (let i = r.s; i < r.e; i++) {
        const db = 20 * Math.log10(Math.abs((c.left[i] / 32767) * c.scale));
        assert.ok(r.peakDb - db <= CLIP.topDb + 0.01, `sample ${i}: ${db.toFixed(2)} vs top ${r.peakDb.toFixed(2)}`);
      }
      assert.ok(Math.abs(r.peakDb - -5) < 1, `top at ${r.peakDb.toFixed(2)} dBFS`);
    }
    // Each in a second that reads CLIPPING or fed the verdict of one (2 s ahead at most).
    for (const r of findClipped(s)) assert.ok(inClipping(s, r.s, 2), `mark at ${r.s}`);
    assert.ok(findClipped({ ...s, statuses: s.statuses.map(() => STATUS_CODE.LIMITED) }).length === 0, 'none without CLIPPING');
    assert.ok(flat.some((r) => Math.abs((r.s + r.e) / 2 - c.focus) < 0.0125 * SR), 'shown first at a clipped peak');
  });

  test('the same capture is rebuilt exactly from the decoded file', () => {
    const s = clipSnap();
    const b = bufferSnapshot(x, x, SR, s.start, s.start + s.left.length, statuses);
    assert.equal(b.ceilStart, s.ceilStart);
    assert.equal(b.left.length, s.left.length);
    assert.deepEqual(Array.from(b.ceilings), Array.from(s.ceilings));
    assert.equal(b.secStart, s.secStart);
    assert.deepEqual(Array.from(b.statuses), Array.from(s.statuses));
    const a = eventCapture(s, { key: 'k' }), c = eventCapture(b, { key: 'k' });
    assert.equal(c.t0, a.t0);
    assert.deepEqual(c.marks, a.marks);
    assert.equal(c.focus, a.focus);
    assert.deepEqual(Array.from(c.left), Array.from(a.left));
  });

  test('captures do not depend on block size', () => {
    const other = capture(x, x, SR, 1000);
    assert.equal(other.snaps.length, live.snaps.length);
    other.snaps.forEach((s, i) => {
      const t = live.snaps[i];
      assert.equal(s.start, t.start);
      assert.deepEqual(Array.from(s.ceilings), Array.from(t.ceilings));
      assert.deepEqual(Array.from(s.statuses), Array.from(t.statuses));
      assert.deepEqual(eventCapture(s).marks, eventCapture(t).marks);
    });
  });

  test("freeze returns the last 5 s with every frame's ceiling and second's status", () => {
    const f = live.a.freeze();
    assert.equal(f.kind, 'freeze');
    assert.equal(f.left.length, WAVE.ringSec * SR);
    assert.equal(f.start + f.left.length, x.length);
    assert.equal(f.ceilings.length / 2, Math.ceil((f.left.length - f.ceilStart) / f.frameLen));
    const b = bufferSnapshot(x, x, SR, f.start, f.start + f.left.length, statuses);
    assert.deepEqual(Array.from(b.ceilings), Array.from(f.ceilings));
    assert.deepEqual(Array.from(b.statuses), Array.from(f.statuses));
    const c = rangeCapture(f, { key: 'z' });
    assert.ok(c.marks.length > 20, `${c.marks.length} clipped peaks`);
    assert.equal(c.focus, null);
    // Nothing is marked in the clean part (until the status turns, a second or two in).
    const cleanEnd = 12 * SR - f.start;
    assert.ok(!c.marks.some((r) => r.s < cleanEnd), 'no marks before the clipping');
  });

  test('a capture survives the JSON log', () => {
    const c = eventCapture(clipSnap(), { key: 'w1', label: 'x', status: 'CLIPPING' });
    const back = captureFromJson(JSON.parse(JSON.stringify(captureJson(c))));
    assert.deepEqual(Array.from(back.left), Array.from(c.left));
    assert.equal(back.right, null);
    assert.equal(back.t0, c.t0);
    assert.deepEqual(back.marks.map(({ peakDb, ...r }) => r), c.marks.map(({ peakDb, ...r }) => r));
    assert.equal(back.focus, c.focus);
  });
});

test('clipping from the very start of a session is still captured with its clipped peaks', () => {
  const { clipped } = syntheticSignals(SR, 8);
  const r = capture(clipped, clipped);
  const s = r.snaps[0];
  assert.ok(s && s.eventT <= 2, `captured (event at ${s && s.eventT} s)`);
  const c = eventCapture(s);
  assert.ok(c.marks.length >= 3, `${c.marks.length} clipped peaks`);
});

test('a capture with no clipped peak opens at its squarest moment, not the end', () => {
  const { limited } = syntheticSignals(SR, 6);
  // Quiet in the last second, so the end is the wrong place to look.
  const x = limited.map((v, i) => (i >= 5 * SR ? v * 0.1 : v));
  const r = capture(x, x);
  const f = r.a.freeze();
  const c = eventCapture({ ...f, statuses: f.statuses.map(() => STATUS_CODE.CLEAN) });
  assert.equal(c.marks.length, 0);
  const centre = c.focus + Math.round(c.t0 * SR) - f.start;
  assert.ok(centre < 4 * SR, `opened at ${(centre / SR).toFixed(2)} s of 5`);
  let peak = 0;
  for (let i = centre - 600; i < centre + 600; i++) peak = Math.max(peak, Math.abs(f.left[i]));
  assert.ok(20 * Math.log10(peak) > Math.max(f.ceilings[0], f.ceilings[1]) - 1, 'at peaks near the ceiling');
});

test('limited audio gets no clipped marks', () => {
  const { limited } = syntheticSignals(SR, 20);
  const r = capture(limited, limited);
  assert.equal(r.snaps.length, 0, 'no capture: it never clips');
  assert.equal(rangeCapture(r.a.freeze()).marks.length, 0);
});

test('full scale is marked whatever the status; stereo keeps both channels', () => {
  const { clipped, clean } = syntheticSignals(SR, 12);
  const L = clipped.map((v) => v * 2.5); // peaks well over full scale
  const r = capture(L, clean);
  const c = rangeCapture(r.a.freeze());
  assert.ok(c.right, 'right kept');
  assert.ok(c.scale > 1);
  let peak = 0;
  for (const v of L.subarray(L.length - c.n)) peak = Math.max(peak, Math.abs(v));
  assert.ok(Math.abs(c.scale - peak) < 1e-6);
  assert.ok(c.marks.some((m) => m.kind === 'full' && m.ch === 0));
  assert.ok(!c.marks.some((m) => m.ch === 1), 'the clean right channel is unmarked');
});

test('the ring wraps; short sessions give short snapshots; the running second takes the last status', () => {
  const ring = new WaveRing(1000, 1, 100); // 1 s ring, 100-sample frames, 1000-sample seconds
  const x = Float32Array.from({ length: 250 }, (_, i) => i);
  ring.push(x, x, 250);
  ring.endFrame([-3, -4]);
  ring.endFrame([-5, -6]);
  let s = ring.snapshot(10);
  assert.equal(s.left.length, 250);
  assert.deepEqual(Array.from(s.ceilings), [-Infinity, -Infinity, -3, -4, -5, -6]);
  assert.deepEqual(Array.from(s.statuses), [NO_STATUS]);
  const y = Float32Array.from({ length: 1000 }, (_, i) => 250 + i);
  ring.push(y, y, 1000);
  ring.endSecond('CLIPPING');
  s = ring.snapshot(10);
  assert.equal(s.left.length, 1000);
  assert.equal(s.start, 250);
  assert.equal(s.left[0], 250);
  assert.equal(s.left[999], 1249);
  assert.equal(s.secStart, -250);
  assert.deepEqual(Array.from(s.statuses), [STATUS_CODE.CLIPPING, STATUS_CODE.CLIPPING]);
});

// The calibration (2026-11-15): clipped peaks per second of each recording, judged as a
// file is (rows' statuses, ceilings rebuilt from the audio).
const dir = new URL('../test-audio/', import.meta.url).pathname;
const RECORDINGS = [
  ['18Oct2026-30_min_mark.wav', 'clipped', () => true, 5],
  ['18Oct2026-31_min_mark.wav', 'clipped until ~34 s', (t) => t < 33, 5],
  ['27Sep2026-30_min_mark.wav', 'clipping at 0 dBFS', (t) => t >= 17 && t < 34, 5],
  ['27Sep2026-30_min_mark.wav', 'clean start', (t) => t < 9, 0],
  ['18Oct2026-42_min_mark.wav', 'limited', () => true, 0],
  ['18Oct2026-36_min_mark.wav', 'clean', () => true, 0],
  ['27Sep2026-92_min_mark.wav', 'clean', () => true, 0],
  ['Reference_recording.wav', 'clean', () => true, 0],
  ['Reference_speech_recording.wav', 'speech', () => true, 0],
];
const marksCache = new Map();
for (const [name, what, keep, minPerSec] of RECORDINGS) {
  test(`${name} (${what}): ${minPerSec ? `at least ${minPerSec} clipped peaks a second` : 'no clipped peaks'}`, { skip: !existsSync(dir + name) && 'test audio missing' }, () => {
    if (!marksCache.has(name)) {
      const { sampleRate, channels } = readWav(dir + name);
      const [L, R = L] = channels;
      const { rows } = analyse(L, R, sampleRate);
      const snap = bufferSnapshot(L, R, sampleRate, 0, L.length, rows.map((r) => r.status));
      marksCache.set(name, { marks: findClipped(snap), sampleRate, rows });
    }
    const { marks, sampleRate, rows } = marksCache.get(name);
    const secs = rows.filter((r) => keep(r.t - 0.5)).length;
    const n = marks.filter((m) => m.kind === 'flat' && keep(m.s / sampleRate)).length;
    console.log(`# ${name} ${what}: ${(n / secs).toFixed(2)} clipped peaks/s`);
    if (minPerSec) assert.ok(n / secs >= minPerSec, `${(n / secs).toFixed(1)} a second`);
    else assert.equal(n, 0, `${n} marked`);
  });
}

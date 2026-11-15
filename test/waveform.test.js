// Waveform captures (src/dsp/waveform.js): kept by the analyzer at clip events and on
// Freeze, rebuilt from a decoded file, and carried in the JSON log.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { StreamAnalyzer } from '../src/dsp/analyzer.js';
import { DEFAULT_CLIP_OPTIONS } from '../src/dsp/clipdetect.js';
import { WAVE, WaveRing, bufferSnapshot, findRuns, eventCapture, wholeCapture, captureJson, captureFromJson, ceilingAt } from '../src/dsp/waveform.js';
import { syntheticSignals, programme, hardClip, lowpass, scale } from './synthetic.js';
import { readWav } from './wav.js';

const SR = 48000;

// Runs the analyzer with captures on; returns rows, events, snapshots and the analyzer.
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

// Clean, then clipped from 12 s, so there is a CLIPPING start with 10 s of history.
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

  test('turning captures on changes no reading', () => {
    const plain = capture(x, x, SR, 128, false);
    assert.equal(JSON.stringify(live.rows), JSON.stringify(plain.rows));
    assert.deepEqual(live.events.map(({ wave, ...e }) => e), plain.events);
    assert.equal(plain.a.freeze(), null);
  });

  test('each clip start carries the id of the snapshot sent after it', () => {
    const starts = live.events.filter((e) => e.type === 'start');
    assert.ok(starts.length >= 1, 'a clip start');
    assert.deepEqual(starts.map((e) => e.wave), live.snaps.map((s) => s.id));
    const s = live.snaps.find((s) => s.status === 'CLIPPING');
    assert.ok(s, 'a CLIPPING snapshot');
    assert.equal(s.left.length, WAVE.searchSec * SR);
    // It ends where the second that changed the status ends.
    assert.equal(s.start + s.left.length, Math.round((s.eventT + 1) * SR));
  });

  test('an event capture sits on the plateaus of the clipped audio', () => {
    const s = live.snaps.find((s) => s.status === 'CLIPPING');
    const c = eventCapture(s, { key: 'k', status: s.status });
    assert.equal(c.n, WAVE.eventSec * SR);
    assert.equal(c.right, null, 'mono: one channel kept');
    const dwell = c.runs.filter((r) => r.kind === 'dwell');
    assert.ok(dwell.length >= 5, `${dwell.length} plateaus in half a second of clipping`);
    assert.ok(c.focus !== null);
    const minRun = Math.round((DEFAULT_CLIP_OPTIONS.dwellMinMs / 1000) * SR);
    for (const r of dwell) {
      assert.ok(r.e - r.s >= minRun);
      // Every sample of a plateau is within 1 dB of its polarity's ceiling.
      for (let i = r.s; i < r.e; i++) {
        const v = Math.abs((c.left[i] / 32767) * c.scale);
        const db = 20 * Math.log10(v);
        const ceil = ceilingAt(c, i, r.pol > 0 ? 0 : 1);
        assert.ok(Math.abs(db - ceil) <= 1.01, `sample ${i}: ${db.toFixed(2)} vs ceiling ${ceil.toFixed(2)}`);
      }
    }
    // The flattest 25 ms holds a plateau.
    assert.ok(dwell.some((r) => Math.abs((r.s + r.e) / 2 - c.focus) < 0.0125 * SR));
  });

  test('the same capture is rebuilt exactly from the decoded file', () => {
    const s = live.snaps.find((s) => s.status === 'CLIPPING');
    const b = bufferSnapshot(x, x, SR, s.start, s.start + s.left.length);
    assert.equal(b.ceilStart, s.ceilStart);
    assert.deepEqual(Array.from(b.ceilings), Array.from(s.ceilings));
    const a = eventCapture(s, { key: 'k' }), c = eventCapture(b, { key: 'k' });
    assert.equal(c.t0, a.t0);
    assert.deepEqual(c.runs, a.runs);
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
      assert.deepEqual(eventCapture(s).runs, eventCapture(t).runs);
    });
  });

  test('freeze returns the last 10 s with every frame\'s ceiling', () => {
    const f = live.a.freeze();
    assert.equal(f.kind, 'freeze');
    assert.equal(f.left.length, WAVE.ringSec * SR);
    assert.equal(f.start + f.left.length, x.length);
    assert.equal(f.ceilings.length / 2, Math.ceil((f.left.length - f.ceilStart) / f.frameLen));
    const b = bufferSnapshot(x, x, SR, f.start, f.start + f.left.length);
    assert.deepEqual(Array.from(b.ceilings), Array.from(f.ceilings));
    const c = wholeCapture(f, { key: 'z' });
    assert.ok(c.runs.length > 50);
    assert.equal(c.focus, null);
  });

  test('a capture survives the JSON log', () => {
    const s = live.snaps.find((s) => s.status === 'CLIPPING');
    const c = eventCapture(s, { key: 'w1', label: 'x', status: 'CLIPPING' });
    const j = JSON.parse(JSON.stringify(captureJson(c)));
    const back = captureFromJson(j);
    assert.deepEqual(Array.from(back.left), Array.from(c.left));
    assert.equal(back.right, null);
    assert.equal(back.t0, c.t0);
    assert.deepEqual(back.runs, c.runs);
    assert.equal(back.focus, c.focus);
    // The stored samples find (nearly) the same plateaus.
    const again = findRuns({ ...back, ceilings: Float32Array.from(back.ceilings) });
    assert.ok(Math.abs(again.length - c.runs.length) <= Math.max(2, c.runs.length * 0.05), `${again.length} vs ${c.runs.length}`);
  });
});

test('stereo captures keep both channels; overs keep their level', () => {
  const { clipped, clean } = syntheticSignals(SR, 12);
  const L = clipped.map((v) => v * 2.5); // peaks well over full scale
  const r = capture(L, clean);
  const f = r.a.freeze();
  const c = wholeCapture(f);
  assert.ok(c.right, 'right kept');
  assert.ok(c.scale > 1);
  let peak = 0;
  for (const v of L.subarray(L.length - c.n)) peak = Math.max(peak, Math.abs(v));
  assert.ok(Math.abs(c.scale - peak) < 1e-6);
  assert.ok(c.runs.some((r) => r.kind === 'full' && r.ch === 0));
  assert.ok(!c.runs.some((r) => r.kind === 'full' && r.ch === 1));
});

test('the ring wraps and short sessions give short snapshots', () => {
  const ring = new WaveRing(1000, 1, 100);
  const x = Float32Array.from({ length: 250 }, (_, i) => i);
  ring.push(x, x, 250);
  ring.endFrame([-3, -4]);
  ring.endFrame([-5, -6]);
  const s = ring.snapshot(10);
  assert.equal(s.left.length, 250);
  assert.equal(s.ceilings.length, 6); // frames 0, 1 and the current one
  assert.deepEqual(Array.from(s.ceilings), [-Infinity, -Infinity, -3, -4, -5, -6]);
  const y = Float32Array.from({ length: 1000 }, (_, i) => 250 + i);
  ring.push(y, y, 1000);
  const t = ring.snapshot(10);
  assert.equal(t.left.length, 1000);
  assert.equal(t.start, 250);
  assert.equal(t.left[0], 250);
  assert.equal(t.left[999], 1249);
});

const dir = new URL('../test-audio/', import.meta.url).pathname;
const REC = '18Oct2026-31_min_mark.wav';
test(`${REC}: clipping captures show plateaus`, { skip: !existsSync(dir + REC) && 'test audio missing' }, () => {
  const { sampleRate, channels } = readWav(dir + REC);
  const [L, R = L] = channels;
  const r = capture(L, R, sampleRate, 512);
  const clip = r.snaps.filter((s) => s.status === 'CLIPPING');
  assert.ok(clip.length >= 1, 'a CLIPPING capture');
  for (const s of clip) {
    const c = eventCapture(s);
    const dwell = c.runs.filter((x) => x.kind === 'dwell').length;
    // Clipped audio dwells 12-17 times a second on each channel (CLAUDE.md).
    assert.ok(dwell >= 4, `${dwell} plateaus in ${s.eventT}s capture`);
  }
});

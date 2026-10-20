// Checks the analyzer against reference measurements of real stream recordings
// (pyloudnorm / FFmpeg ebur128 / scipy 4x resample) and the expected clip status.

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readWav } from './wav.js';
import { analyse, statusString, between } from './helpers.js';
import { AlertMonitor } from '../src/dsp/alerts.js';

const dir = new URL('../test-audio/', import.meta.url).pathname;

function near(actual, expected, tol, what) {
  assert.ok(Math.abs(actual - expected) <= tol, `${what}: ${actual.toFixed(3)} not within ±${tol} of ${expected}`);
}

const cache = new Map();
function load(name) {
  if (!cache.has(name)) {
    const { sampleRate, channels } = readWav(dir + name);
    const [L, R = L] = channels;
    cache.set(name, { ...analyse(L, R, sampleRate), L, R, sampleRate });
  }
  return cache.get(name);
}

// Alert ids raised over the whole file with default thresholds.
function alertsRaised(rows) {
  const m = new AlertMonitor();
  const ids = new Set();
  for (const row of rows) for (const a of m.update(row).raised) ids.add(a.id);
  return ids;
}

const fileTest = (name, fn) =>
  describe(name, { skip: !existsSync(dir + name) && 'test audio missing' }, () => {
    let r;
    before(() => (r = load(name)));
    fn(() => r);
  });

fileTest('18Oct2026-30_min_mark.wav', (r) => {
  test('integrated loudness -7.3 LUFS', () => near(r().summary.integrated, -7.3, 0.3, 'integrated'));
  test('true peak -2.5 dBTP', () => near(r().summary.truePeakDb, -2.5, 0.2, 'true peak'));
  test('sample peak -2.55 dBFS', () => near(r().summary.samplePeakDb, -2.55, 0.1, 'sample peak'));
  test('crest factor 7.1 dB', () => near(r().summary.crestDb, 7.1, 0.3, 'crest'));
  test('dwell ~17 runs/s', () => near(r().summary.meanDwellRate, 17, 3, 'dwell'));
  test('clip ceiling between -3.2 and -4.1 dBFS', () => {
    for (const row of between(r().rows, 3, 99)) {
      assert.ok(row.ceilingDb <= -3.2 && row.ceilingDb >= -4.1, `ceiling ${row.ceilingDb} at ${row.t}s`);
    }
  });
  test('CLIPPING throughout, below full scale', () => {
    const s = r();
    assert.equal(s.summary.overallStatus, 'CLIPPING');
    assert.ok(s.rows.every((x) => x.status === 'CLIPPING'), statusString(s.rows));
    assert.equal(s.summary.fullScaleSamples, 0);
    assert.ok(s.rows.some((x) => x.detectors.includes('dwell') && x.detectors.includes('pileup')));
  });
  test('logs one clipping event with ceiling and detectors', () => {
    const starts = r().events.filter((e) => e.type === 'start' && e.status === 'CLIPPING');
    assert.equal(starts.length, 1);
    assert.ok(starts[0].ceilingDb < -3 && starts[0].ceilingDb > -4.5);
    assert.deepEqual(starts[0].detectors, ['dwell', 'pileup']);
  });
  test('mono', () => assert.ok(r().summary.mono));
  test('raises clipping and too-loud alerts', () => {
    const ids = alertsRaised(r().rows);
    assert.ok(ids.has('clipping'));
    assert.ok(ids.has('shortTermHigh'));
  });
});

fileTest('18Oct2026-31_min_mark.wav', (r) => {
  test('integrated loudness -8.1 LUFS', () => near(r().summary.integrated, -8.1, 0.3, 'integrated'));
  test('true peak -2.6 dBTP', () => near(r().summary.truePeakDb, -2.6, 0.2, 'true peak'));
  test('dwell ~13 runs/s', () => near(r().summary.meanDwellRate, 13, 3, 'dwell'));
  test('CLIPPING until ~34 s, then CLEAN', () => {
    const rows = r().rows;
    const s = statusString(rows);
    assert.ok(between(rows, 0, 33).every((x) => x.status === 'CLIPPING'), s);
    assert.ok(between(rows, 37, 99).every((x) => x.status === 'CLEAN'), s);
    const end = r().events.find((e) => e.type === 'end' && e.status === 'CLIPPING');
    assert.ok(end && end.t >= 34 && end.t <= 37, `clipping ended at ${end && end.t}`);
  });
});

fileTest('18Oct2026-36_min_mark.wav', (r) => {
  test('integrated loudness -21.3 LUFS', () => near(r().summary.integrated, -21.3, 0.3, 'integrated'));
  test('true peak -8.2 dBTP', () => near(r().summary.truePeakDb, -8.2, 0.2, 'true peak'));
  test('loudness range 6.0 LU', () => near(r().summary.lra, 6.0, 0.5, 'LRA'));
  test('crest factor 15.7 dB', () => near(r().summary.crestDb, 15.7, 0.3, 'crest'));
  test('dwell ~0.4 runs/s', () => near(r().summary.meanDwellRate, 0.4, 0.5, 'dwell'));
  test('CLEAN', () => {
    assert.equal(r().summary.overallStatus, 'CLEAN');
    assert.ok(r().rows.every((x) => x.status === 'CLEAN'), statusString(r().rows));
  });
});

fileTest('18Oct2026-42_min_mark.wav', (r) => {
  test('integrated loudness -14.1 LUFS', () => near(r().summary.integrated, -14.1, 0.3, 'integrated'));
  test('true peak -5.5 dBTP', () => near(r().summary.truePeakDb, -5.5, 0.2, 'true peak'));
  test('loudness range 0.6 LU', () => near(r().summary.lra, 0.6, 0.5, 'LRA'));
  test('per-second peaks between -7.2 and -5.5 dBFS', () => {
    for (const row of r().rows) assert.ok(row.samplePeakDb >= -7.3 && row.samplePeakDb <= -5.4, `${row.samplePeakDb} at ${row.t}`);
  });
  test('dwell ~3.6 runs/s', () => near(r().summary.meanDwellRate, 3.6, 1, 'dwell'));
  test('LIMITED, never CLIPPING', () => {
    const s = r();
    assert.equal(s.summary.overallStatus, 'LIMITED');
    assert.ok(s.rows.every((x) => x.status !== 'CLIPPING'), statusString(s.rows));
    assert.ok(between(s.rows, 3, 99).every((x) => x.status === 'LIMITED'), statusString(s.rows));
  });
  test('no clipping alert', () => assert.ok(!alertsRaised(r().rows).has('clipping')));
});

fileTest('27Sep2026-92_min_mark.wav', (r) => {
  test('integrated loudness -11.3 LUFS', () => near(r().summary.integrated, -11.3, 0.3, 'integrated'));
  test('true peak +0.04 dBTP', () => near(r().summary.truePeakDb, 0.04, 0.2, 'true peak'));
  test('sample peak -0.002 dBFS', () => near(r().summary.samplePeakDb, -0.002, 0.05, 'sample peak'));
  test('loudness range 3.5 LU', () => near(r().summary.lra, 3.5, 0.5, 'LRA'));
  test('dwell ~0.5 runs/s', () => near(r().summary.meanDwellRate, 0.5, 0.5, 'dwell'));
  test('CLEAN (no full-scale runs)', () => {
    assert.equal(r().summary.overallStatus, 'CLEAN');
    assert.ok(r().rows.every((x) => x.status === 'CLEAN'), statusString(r().rows));
  });
  test('raises the true-peak alert but not the clipping alert', () => {
    const ids = alertsRaised(r().rows);
    assert.ok(ids.has('truePeak'));
    assert.ok(!ids.has('clipping'));
  });
});

fileTest('27Sep2026-30_min_mark.wav', (r) => {
  test('integrated loudness -7.2 LUFS', () => near(r().summary.integrated, -7.2, 0.3, 'integrated'));
  test('true peak +0.13 dBTP', () => near(r().summary.truePeakDb, 0.13, 0.2, 'true peak'));
  test('loudness range 7.6 LU', () => near(r().summary.lra, 7.6, 0.5, 'LRA'));
  test('5,741 samples at +full scale on the left channel, runs up to 18', () => {
    const { L } = r();
    let count = 0, run = 0, maxRun = 0;
    for (const v of L) {
      if (v >= 32767 / 32768) { count++; run++; maxRun = Math.max(maxRun, run); } else run = 0;
    }
    assert.equal(count, 5741);
    assert.equal(maxRun, 18);
    assert.ok(r().summary.fullScaleSamples >= 5741);
  });
  test('CLIPPING at 0 dBFS in bursts: clean 0-9 s, clipping through 17-34 s', () => {
    const s = r();
    const str = statusString(s.rows);
    assert.equal(s.summary.overallStatus, 'CLIPPING');
    assert.ok(between(s.rows, 0, 9).every((x) => x.status === 'CLEAN'), str);
    const burst = between(s.rows, 17, 34);
    assert.ok(burst.filter((x) => x.status === 'CLIPPING').length >= 0.8 * burst.length, str);
    assert.ok(s.rows.some((x) => x.detectors.includes('fullscale')));
    const fs = s.events.filter((e) => e.type === 'start' && e.detectors.includes('fullscale'));
    assert.ok(fs.length >= 1 && fs.every((e) => e.ceilingDb > -2), 'full-scale events near 0 dBFS');
  });
});

// Unit tests of the DSP building blocks against textbook / EBU test signals, and the
// clipping detector against synthetic clipped, limited and clean programme.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { kWeightingCoefficients } from '../src/dsp/kweighting.js';
import { LoudnessMeter } from '../src/dsp/loudness.js';
import { TruePeakChannel } from '../src/dsp/truepeak.js';
import { stereoFromSums } from '../src/dsp/stereo.js';
import { AlertMonitor } from '../src/dsp/alerts.js';
import { csvHeader, csvRow, summaryJson } from '../src/dsp/report.js';
import { octaveBalance, thirdOctaveLevels, THIRD_OCTAVE_CENTRES } from '../src/dsp/bands.js';
import { syntheticSignals, programme } from './synthetic.js';
import { analyse, sine, dbToLin, statusString } from './helpers.js';

const near = (a, b, tol, what = '') => assert.ok(Math.abs(a - b) <= tol, `${what} ${a} not within ±${tol} of ${b}`);

function loudnessOf(L, R, sr) {
  const m = new LoudnessMeter(sr);
  for (let i = 0; i < L.length; i += 128) {
    const n = Math.min(128, L.length - i);
    m.process(L.subarray(i, i + n), R.subarray(i, i + n), n);
  }
  return m;
}

describe('K-weighting', () => {
  test('matches the BS.1770-4 48 kHz coefficients', () => {
    const [s, h] = kWeightingCoefficients(48000);
    near(s.b0, 1.53512485958697, 1e-6);
    near(s.b1, -2.69169618940638, 1e-6);
    near(s.b2, 1.19839281085285, 1e-6);
    near(s.a1, -1.69065929318241, 1e-6);
    near(s.a2, 0.73248077421585, 1e-6);
    near(h.a1, -1.99004745483398, 1e-6);
    near(h.a2, 0.99007225036621, 1e-6);
  });

  for (const sr of [44100, 48000, 96000]) {
    test(`1 kHz stereo sine at -23 dBFS reads -23 LUFS at ${sr} Hz`, () => {
      const x = sine(sr, 10, 1000, dbToLin(-23));
      const m = loudnessOf(x, x, sr);
      near(m.integrated, -23, 0.1, 'integrated');
      near(m.momentary, -23, 0.1, 'momentary');
      near(m.shortTerm, -23, 0.1, 'short-term');
    });
  }
});

describe('loudness gating and range', () => {
  test('absolute gate ignores silence', () => {
    const sr = 48000;
    const tone = sine(sr, 10, 1000, dbToLin(-23));
    const x = new Float32Array(tone.length * 2);
    x.set(tone);
    near(loudnessOf(x, x, sr).integrated, -23, 0.1);
  });

  test('relative gate drops a passage 20 dB down (EBU Tech 3341 case 3 style)', () => {
    const sr = 48000;
    const a = sine(sr, 20, 1000, dbToLin(-36));
    const b = sine(sr, 20, 1000, dbToLin(-23));
    const x = new Float32Array(a.length + b.length);
    x.set(a);
    x.set(b, a.length);
    near(loudnessOf(x, x, sr).integrated, -23, 0.1);
  });

  test('EBU Tech 3342 case 1: 20 s at -20 then 20 s at -30 gives LRA 10 LU', () => {
    const sr = 48000;
    const a = sine(sr, 20, 1000, dbToLin(-20));
    const b = sine(sr, 20, 1000, dbToLin(-30));
    const x = new Float32Array(a.length + b.length);
    x.set(a);
    x.set(b, a.length);
    near(loudnessOf(x, x, sr).loudnessRange, 10, 1);
  });
});

describe('true peak', () => {
  test('fs/4 sine at 45 degrees: samples at -3 dB, true peak at 0 dB', () => {
    const sr = 48000;
    const x = sine(sr, 1, sr / 4, 1, Math.PI / 4);
    const tp = new TruePeakChannel();
    let peak = 0;
    for (let i = 0; i < x.length; i += 128) peak = Math.max(peak, tp.process(x.subarray(i, i + 128)));
    let sp = 0;
    for (const v of x) sp = Math.max(sp, Math.abs(v));
    near(20 * Math.log10(sp), -3.01, 0.05, 'sample peak');
    near(20 * Math.log10(peak), 0, 0.3, 'true peak');
  });

  test('block size does not change the result', () => {
    const x = syntheticSignals(48000, 2).clean;
    const run = (bs) => {
      const tp = new TruePeakChannel();
      let p = 0;
      for (let i = 0; i < x.length; i += bs) p = Math.max(p, tp.process(x.subarray(i, i + bs)));
      return p;
    };
    assert.equal(run(128), run(1000));
  });
});

describe('stereo', () => {
  test('identical channels are MONO', () => {
    const s = stereoFromSums(2, 2, 2);
    assert.equal(s.correlation, 1);
    assert.equal(s.mono, true);
    assert.equal(s.sideMidDb, -Infinity);
  });
  test('opposite polarity', () => {
    const s = stereoFromSums(1, 1, -1);
    assert.equal(s.correlation, -1);
    assert.equal(s.mono, false);
    assert.equal(s.sideMidDb, null);
  });
  test('uncorrelated noise is near 0 and not mono', () => {
    const r = analyse(programme(48000, 4, -20, 1), programme(48000, 4, -20, 2), 48000);
    assert.ok(Math.abs(r.summary.correlation) < 0.3, String(r.summary.correlation));
    assert.equal(r.summary.mono, false);
    near(r.summary.sideMidDb, 0, 2, 'side/mid');
  });
});

describe('clipping detector on synthetic programme', () => {
  const sr = 48000;
  const sig = syntheticSignals(sr, 20);

  test('hard-clipped at -3 dBFS then scaled down: CLIPPING', () => {
    const r = analyse(sig.clipped, sig.clipped, sr);
    assert.equal(r.summary.overallStatus, 'CLIPPING');
    assert.ok(r.rows.every((x) => x.status === 'CLIPPING'), statusString(r.rows));
    assert.equal(r.summary.fullScaleSamples, 0);
    // Ceiling is the clip level (-3 dBFS) minus the 2 dB scaling, give or take ripple.
    near(r.summary.ceilingDb, -5, 0.5, 'ceiling');
  });

  test('same programme through a fast limiter: LIMITED, not CLIPPING', () => {
    const r = analyse(sig.limited, sig.limited, sr);
    assert.equal(r.summary.overallStatus, 'LIMITED');
    assert.ok(r.rows.every((x) => x.status !== 'CLIPPING'), statusString(r.rows));
  });

  test('clean programme: CLEAN', () => {
    const r = analyse(sig.clean, sig.clean, sr);
    assert.equal(r.summary.overallStatus, 'CLEAN');
    assert.ok(r.rows.every((x) => x.status === 'CLEAN'), statusString(r.rows));
  });

  test('digital full scale is caught even when brief', () => {
    const x = sig.clean.slice();
    for (let i = 100000; i < 100004; i++) x[i] = 1;
    const r = analyse(x, x, sr);
    assert.equal(r.summary.overallStatus, 'CLIPPING');
    assert.ok(r.events.some((e) => e.type === 'start' && e.detectors.includes('fullscale')));
  });

  test('results are independent of block size', () => {
    const a = analyse(sig.clipped, sig.clipped, sr, { block: 128 });
    const b = analyse(sig.clipped, sig.clipped, sr, { block: 4096 });
    assert.equal(statusString(a.rows), statusString(b.rows));
    near(a.summary.integrated, b.summary.integrated, 1e-6);
  });

  test('works at 44.1 kHz', () => {
    const s = syntheticSignals(44100, 15);
    assert.equal(analyse(s.clipped, s.clipped, 44100).summary.overallStatus, 'CLIPPING');
    assert.equal(analyse(s.limited, s.limited, 44100).summary.overallStatus, 'LIMITED');
    assert.equal(analyse(s.clean, s.clean, 44100).summary.overallStatus, 'CLEAN');
  });
});

describe('alerts', () => {
  const row = (t, o = {}) => ({ t, status: 'CLEAN', detectors: [], truePeakDb: -6, shortTerm: -16, integrated: -15, ceilingDb: -3, ...o });

  test('short-term above -10 LUFS must be sustained 10 s', () => {
    const m = new AlertMonitor();
    for (let t = 1; t <= 9; t++) assert.equal(m.update(row(t, { shortTerm: -9 })).raised.length, 0);
    assert.deepEqual(m.update(row(10, { shortTerm: -9 })).raised.map((a) => a.id), ['shortTermHigh']);
  });

  test('integrated far off target only after the minimum time, then clears', () => {
    const m = new AlertMonitor({ integratedOff: { minSeconds: 30 } });
    assert.equal(m.update(row(29, { integrated: -22 })).raised.length, 0);
    assert.deepEqual(m.update(row(30, { integrated: -22 })).raised.map((a) => a.id), ['integratedOff']);
    assert.equal(m.update(row(31)).cleared.length, 0);
    assert.deepEqual(m.update(row(35)).cleared, ['integratedOff']);
  });

  test('disabled alerts never fire', () => {
    const m = new AlertMonitor({ truePeak: { enabled: false } });
    assert.equal(m.update(row(1, { truePeakDb: 0.5 })).raised.length, 0);
  });

  test('sound is off by default', () => assert.equal(new AlertMonitor().config.sound, false));
});

describe('report', () => {
  test('CSV header and row have the same number of columns', () => {
    const r = analyse(...(() => { const x = syntheticSignals(48000, 3).clean; return [x, x]; })(), 48000);
    const h = csvHeader().trim().split(',');
    const line = csvRow({ ...r.rows[1], wallClock: '2026-10-19T10:00:00' }).trim().split(',');
    assert.equal(line.length, h.length);
    assert.equal(h[0], 'wall_clock');
  });
  test('JSON summary replaces non-finite numbers', () => {
    const j = JSON.parse(summaryJson({ integrated: -Infinity, a: 1.23456 }, []));
    assert.equal(j.summary.integrated, null);
    assert.equal(j.summary.a, 1.235);
  });
});

describe('spectrum bands', () => {
  test('pink-ish flat-per-octave spectrum gives a flat octave balance', () => {
    const sr = 48000, bins = 4096;
    const binHz = sr / 2 / bins;
    // Power density falling 3 dB/octave gives equal power per octave.
    const spec = Float32Array.from({ length: bins }, (_, b) => (b === 0 ? -100 : -10 * Math.log10(b * binHz)));
    const bal = octaveBalance(spec, sr);
    for (let i = 2; i < bal.length - 1; i++) near(bal[i], 0, 0.6, `octave ${i}`);
    assert.equal(thirdOctaveLevels(spec, sr).length, THIRD_OCTAVE_CENTRES.length);
  });
});

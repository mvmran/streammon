// Mains hum detection: reference recordings, synthetic signals, analyzer integration.

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readWav } from './wav.js';
import { speechLike, addHum, tone } from './synthetic.js';
import { HumDetector, validateHumOptions, PRESENT, NOT_DETECTED, MASKED } from '../src/dsp/hum.js';
import { StreamAnalyzer } from '../src/dsp/analyzer.js';
import { AlertMonitor } from '../src/dsp/alerts.js';

const dir = new URL('../test-audio/', import.meta.url).pathname;
const WARMUP = 10; // s: 4 s window + 5 s persistence, plus a margin

function runHum(L, R, sampleRate, options = {}, block = 128) {
  const results = [];
  const events = [];
  const d = new HumDetector(sampleRate, options, { onResult: (r) => results.push(r), onEvent: (e) => events.push(e) });
  for (let i = 0; i < L.length; i += block) d.process(L.subarray(i, i + block), R.subarray(i, i + block));
  return { results, events, settled: results.filter((r) => r.t >= WARMUP), detector: d };
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[s.length >> 1];
};
const near = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a.toFixed(3)} not within ±${tol} of ${b}`);
const statuses = (rs) => rs.map((r) => ({ [PRESENT]: 'P', [NOT_DETECTED]: '.', [MASKED]: 'm' })[r.status]).join('');

const wavCache = new Map();
function wav(name) {
  if (!wavCache.has(name)) wavCache.set(name, readWav(dir + name));
  return wavCache.get(name);
}
const fileDescribe = (file, title, fn) => describe(`${file} ${title}`, { skip: !existsSync(dir + file) && 'test audio missing' }, fn);

// ---------------------------------------------------------------------------
// Reference recordings

fileDescribe('Reference_speech_recording.wav', '(mains 50 Hz)', () => {
  let r;
  before(() => {
    const { sampleRate, channels: [L, R] } = wav('Reference_speech_recording.wav');
    r = runHum(L, R, sampleRate, { mainsFrequencyHz: 50 });
  });
  test('PRESENT throughout once settled', () => assert.ok(r.settled.every((x) => x.status === PRESENT), statuses(r.settled)));
  test('fundamental 50.00 Hz (±0.1)', () => near(median(r.settled.map((x) => x.fundamentalHz)), 50.0, 0.1, 'frequency'));
  test('level -70.0 dBFS (±1)', () => near(median(r.settled.map((x) => x.levelDb)), -70.0, 1, 'level'));
  test('steady: 4 s level std < 0.5 dB', () => {
    const lv = r.settled.map((x) => x.detectLevelDb);
    const m = lv.reduce((a, b) => a + b) / lv.length;
    const sd = Math.sqrt(lv.reduce((a, b) => a + (b - m) ** 2, 0) / lv.length);
    assert.ok(sd < 0.5, `std ${sd.toFixed(2)}`);
  });
  test('same level in speech pauses as while talking (±1 dB)', () => {
    const last = r.results[r.results.length - 1];
    assert.ok(last.quiet, 'no quiet passage measured');
    near(last.quiet.levelDb, median(r.settled.map((x) => x.levelDb)), 1, 'quiet-passage level');
  });
  test('control background around -96 dBFS or lower; prominence > 25 dB', () => {
    // Reference figure about -96 dBFS; the 4 s Hann control here measures about -104.
    assert.ok(median(r.settled.map((x) => x.controlDb)) <= -94);
    assert.ok(median(r.settled.map((x) => x.prominenceDb)) >= 25);
  });
  test('harmonic signature: odd-dominant, 3rd the strongest harmonic', () => {
    // The 2nd-6th harmonics sit at the speech background in this recording (prominence
    // about 0 dB), so their exact levels are not measurable; only the odd/even hint is.
    const last = r.results[r.results.length - 1];
    assert.equal(last.signature, 'odd');
    const rel = last.harmonics.slice(1, 6).map((h) => h.relativeDb);
    assert.equal(rel.indexOf(Math.max(...rel)), 1, `relative levels k=2..6: ${rel.map((v) => v.toFixed(1)).join(', ')}`);
  });
  test('onset logged once; no level steps', () => {
    assert.equal(r.events.filter((e) => e.type === 'hum-onset').length, 1);
    assert.equal(r.events.filter((e) => e.type === 'hum-step').length, 0);
  });
});

fileDescribe('Reference_speech_recording.wav', 'audibility via the analyzer', () => {
  let rows, hum, summary;
  before(() => {
    const { sampleRate, channels: [L, R] } = wav('Reference_speech_recording.wav');
    rows = [];
    hum = [];
    const a = new StreamAnalyzer(sampleRate, { onSecond: (x) => rows.push(x), onHum: (h) => hum.push(h), humOptions: { mainsFrequencyHz: 50 } });
    for (let i = 0; i < L.length; i += 128) a.process(L.subarray(i, i + 128), R.subarray(i, i + 128));
    summary = a.summary();
  });
  test('programme integrated -37.8 LUFS (±0.3)', () => near(summary.integrated, -37.8, 0.3, 'integrated'));
  test('projected hum at -18 LUFS speech about -50 dBFS (±1.5)', () => near(hum[hum.length - 1].projectedDb, -50, 1.5, 'projected'));
  test('hum sits well below the programme', () => assert.ok(hum[hum.length - 1].belowProgrammeDb > 20));
  test('1 s rows carry the hum fields', () => {
    const last = rows[rows.length - 1];
    assert.equal(last.humStatus, PRESENT);
    near(last.humLevelDb, -70, 1, 'row level');
    assert.equal(last.humMainsHz, 50);
  });
  test('hum alert is raised (level above -75 dBFS for 5 s)', () => {
    const m = new AlertMonitor();
    const raised = rows.flatMap((x) => m.update(x).raised.map((a) => a.id));
    assert.ok(raised.includes('hum'));
  });
});

fileDescribe('Reference_speech_recording.wav', '(mains 60 Hz)', () => {
  test('NOT DETECTED', () => {
    const { sampleRate, channels: [L, R] } = wav('Reference_speech_recording.wav');
    const r = runHum(L, R, sampleRate, { mainsFrequencyHz: 60 });
    assert.ok(r.settled.every((x) => x.status === NOT_DETECTED), statuses(r.settled));
  });
});

fileDescribe('Reference_quieter_recording.wav', '(held A pad at 55 Hz)', () => {
  test('never PRESENT; 50 Hz at most -83 dBFS in the quietest windows', () => {
    const { sampleRate, channels: [L, R] } = wav('Reference_quieter_recording.wav');
    const r = runHum(L, R, sampleRate, { mainsFrequencyHz: 50 });
    assert.ok(r.results.every((x) => x.status !== PRESENT), statuses(r.results));
    assert.ok(Math.min(...r.results.map((x) => x.nominalDb)) <= -83);
  });
});

fileDescribe('Reference_recording.wav', '(bass notes 47-55 Hz)', () => {
  test('MASKED or NOT DETECTED, never PRESENT', () => {
    const { sampleRate, channels: [L, R] } = wav('Reference_recording.wav');
    const r = runHum(L, R, sampleRate, { mainsFrequencyHz: 50 });
    assert.ok(r.results.every((x) => x.status === MASKED || x.status === NOT_DETECTED), statuses(r.results));
  });
});

fileDescribe('18Oct2026-36_min_mark.wav', '(99.1 Hz pad near G2)', () => {
  test('never PRESENT; pad not taken for 100 Hz hum; 50 Hz well below the alert level', () => {
    const { sampleRate, channels: [L, R] } = wav('18Oct2026-36_min_mark.wav');
    const r = runHum(L, R, sampleRate, { mainsFrequencyHz: 50 });
    assert.ok(r.results.every((x) => x.status !== PRESENT), statuses(r.results));
    // 100 Hz is measured at exactly 2 x 50 Hz while no hum is present: the 0.9 Hz-off pad
    // must not show up there.
    assert.ok(r.results.every((x) => x.harmonics[1].prominence < 18), 'pad leaked into the 100 Hz measurement');
    // Reference figure about -89 dBFS (a 40 s analysis bin); 4 s windows include more music.
    assert.ok(median(r.results.map((x) => x.nominalDb)) <= -80);
  });
});

for (const name of ['18Oct2026-30_min_mark.wav', '18Oct2026-31_min_mark.wav', '18Oct2026-42_min_mark.wav', '27Sep2026-30_min_mark.wav', '27Sep2026-92_min_mark.wav']) {
  fileDescribe(name, '(LSC clip)', () => {
    test('never PRESENT', () => {
      const { sampleRate, channels: [L, R] } = wav(name);
      const r = runHum(L, R, sampleRate, { mainsFrequencyHz: 50 });
      assert.ok(r.results.every((x) => x.status !== PRESENT), statuses(r.results));
    });
  });
}

// ---------------------------------------------------------------------------
// Synthetic signals

describe('synthetic hum', () => {
  const sr = 48000;
  const speech = speechLike(sr, 40);
  const mono = (x, options) => runHum(x, x, sr, options);

  test('50 Hz hum with odd harmonics at -70 dBFS: PRESENT at 50, NOT DETECTED at 60', () => {
    const x = addHum(speech, sr, { freq: 50 });
    const at50 = mono(x, { mainsFrequencyHz: 50 });
    assert.ok(at50.settled.every((r) => r.status === PRESENT), statuses(at50.settled));
    near(median(at50.settled.map((r) => r.levelDb)), -70, 0.5, 'level');
    assert.equal(at50.results[at50.results.length - 1].signature, 'odd');
    const at60 = mono(x, { mainsFrequencyHz: 60 });
    assert.ok(at60.settled.every((r) => r.status === NOT_DETECTED), statuses(at60.settled));
  });

  test('60 Hz hum: PRESENT only when the setting is 60', () => {
    const x = addHum(speech, sr, { freq: 60 });
    assert.ok(mono(x, { mainsFrequencyHz: 60 }).settled.every((r) => r.status === PRESENT));
    assert.ok(mono(x, { mainsFrequencyHz: 50 }).results.every((r) => r.status !== PRESENT));
  });

  for (const [f, mains] of [[49.0, 50], [55.0, 50], [58.27, 60], [61.74, 60]]) {
    test(`pure tone at ${f} Hz is never PRESENT (mains ${mains})`, () => {
      const r = mono(tone(sr, 30, f, -40), { mainsFrequencyHz: mains });
      assert.ok(r.results.every((x) => x.status !== PRESENT), statuses(r.results));
    });
  }

  test('-82 dBFS stepping to -70 halfway: PRESENT after the step, one +12 dB step event at 20 s (±1)', () => {
    const r = mono(addHum(speech, sr, { freq: 50, levelDb: (t) => (t < 20 ? -82 : -70) }), { mainsFrequencyHz: 50 });
    assert.equal(r.results[r.results.length - 1].status, PRESENT);
    const steps = r.events.filter((e) => e.type === 'hum-step');
    assert.equal(steps.length, 1, JSON.stringify(steps));
    near(steps[0].changeDb, 12, 1.5, 'step size');
    near(steps[0].t, 20, 1, 'step time');
    near(steps[0].beforeDb, -82, 1, 'level before');
  });

  test('mains drifting 49.9 -> 50.1 Hz over 60 s stays PRESENT', () => {
    const x = addHum(speechLike(sr, 60, -30, 9), sr, { freq: (t) => 49.9 + (0.2 * t) / 60 });
    const r = mono(x, { mainsFrequencyHz: 50 });
    assert.ok(r.settled.every((s) => s.status === PRESENT), statuses(r.settled));
    near(r.results[r.results.length - 1].fundamentalHz, 50.1, 0.03, 'tracked frequency');
  });

  test('results do not depend on block size', () => {
    const x = addHum(speech, sr, { freq: 50 });
    const a = runHum(x, x, sr, {}, 128).results;
    const b = runHum(x, x, sr, {}, 4096).results;
    assert.equal(a.length, b.length);
    near(a[a.length - 1].levelDb, b[b.length - 1].levelDb, 1e-9, 'level');
  });
});

describe('hum configuration', () => {
  test('invalid mains frequency 55 falls back to 50 with a warning', () => {
    const { options, warnings } = validateHumOptions({ mainsFrequencyHz: 55 });
    assert.equal(options.mainsFrequencyHz, 50);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /55/);
  });

  test('the analyzer logs the fallback and later mains changes', () => {
    const events = [];
    const a = new StreamAnalyzer(48000, { onEvent: (e) => events.push(e), humOptions: { mainsFrequencyHz: 55 } });
    assert.ok(events.some((e) => e.type === 'hum-config' && e.warning && /55/.test(e.message)));
    a.setHumOptions({ mainsFrequencyHz: 60 });
    assert.ok(events.some((e) => e.type === 'hum-config' && /changed to 60 Hz/.test(e.message)));
    assert.equal(a.hum.opt.mainsFrequencyHz, 60);
  });

  test('after a mid-session settings change, hum times stay in session time', () => {
    const sr = 48000;
    const x = addHum(speechLike(sr, 45, -30), sr, { freq: 60, levelDb: -60 });
    const events = [], results = [];
    const a = new StreamAnalyzer(sr, { onEvent: (e) => events.push(e), onHum: (r) => results.push(r), humOptions: { mainsFrequencyHz: 50 } });
    a.process(x.subarray(0, 20 * sr), x.subarray(0, 20 * sr));
    a.setHumOptions({ mainsFrequencyHz: 60 });
    a.process(x.subarray(20 * sr), x.subarray(20 * sr));
    const onset = events.find((e) => e.type === 'hum-onset');
    assert.ok(onset && onset.t > 25 && onset.t < 40, `onset at ${onset && onset.t} s`);
    assert.ok(results.at(-1).t > 44, `last result at ${results.at(-1).t} s`);
  });
});

describe('hum performance', () => {
  test('well within the AudioWorklet budget (< 3% of one core)', () => {
    const sr = 48000;
    const x = addHum(speechLike(sr, 20), sr, { freq: 50 });
    const d = new HumDetector(sr, { harmonics: 10 });
    const t0 = performance.now();
    for (let i = 0; i < x.length; i += 128) d.process(x.subarray(i, i + 128), x.subarray(i, i + 128));
    const share = (performance.now() - t0) / 1000 / 20;
    assert.ok(share < 0.03, `${(share * 100).toFixed(2)}% of one core`);
  });
});

describe('isolated hum playback (file mode)', () => {
  // The mask is linear, so its behaviour on hum and on programme can be checked separately.
  const sr = 48000;
  const span = (x) => x.subarray(sr * 2, x.length - sr * 2); // away from the edges
  const energy = (x) => span(x).reduce((e, v) => e + v * v, 0);
  const dB = (a, b) => 10 * Math.log10(a / b);

  test('passes the hum unchanged, rejects programme, and the control rejects the hum', async () => {
    const { isolateHum } = await import('../src/dsp/hum-isolate.js');
    const hum = addHum(new Float32Array(sr * 12), sr, { freq: 50 });
    const speech = speechLike(sr, 12);
    const iso = isolateHum(hum, sr, { fundamentalHz: 50, gainDb: 0 });
    let err = 0;
    const a = span(iso.samples), b = span(hum);
    for (let i = 0; i < a.length; i++) err += (a[i] - b[i]) ** 2;
    assert.ok(dB(err, energy(hum)) < -30, `hum reconstruction error ${dB(err, energy(hum)).toFixed(1)} dB`);
    const sp = isolateHum(speech, sr, { fundamentalHz: 50, gainDb: 0 });
    // ~3 Hz effective slices at 50-500 Hz keep a few percent of this pink, speech-like
    // noise (about -15 to -20 dB); the speech heard alongside isolated hum is that part.
    assert.ok(dB(energy(sp.samples), energy(speech)) < -15, `speech kept ${dB(energy(sp.samples), energy(speech)).toFixed(1)} dB`);
    const ctl = isolateHum(hum, sr, { fundamentalHz: 50, offsetHz: 3.5, gainDb: 0 });
    assert.ok(dB(energy(ctl.samples), energy(hum)) < -30, `control kept ${dB(energy(ctl.samples), energy(hum)).toFixed(1)} dB of the hum`);
  });

  test('gain is limited so playback cannot blast', async () => {
    const { isolateHum } = await import('../src/dsp/hum-isolate.js');
    const x = addHum(new Float32Array(sr * 6), sr, { freq: 50, levelDb: -20 });
    const r = isolateHum(x, sr, { gainDb: 60, maxPeak: 0.5 });
    assert.equal(r.limited, true);
    let peak = 0;
    for (const v of r.samples) peak = Math.max(peak, Math.abs(v));
    assert.ok(peak <= 0.5 + 1e-6, `peak ${peak}`);
  });
});

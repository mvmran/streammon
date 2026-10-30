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
  test('measured in speech pauses too: 50 Hz and its harmonics, about the level while talking', () => {
    const p = r.results.map((x) => x.pause).find((x) => x && x.levelDb !== null);
    assert.ok(p, 'no pause measured');
    assert.ok(p.lines.includes(1), `lines ${p.lines}`);
    const talking = median(r.settled.map((x) => x.levelDb));
    assert.ok(p.levelDb >= talking - 1 && p.levelDb <= talking + 4, `pause ${p.levelDb.toFixed(1)} vs ${talking.toFixed(1)} dBFS (harmonics add a little)`);
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
  test('hum alert is raised (level above the alert level for 5 s)', () => {
    const m = new AlertMonitor();
    const raised = rows.flatMap((x) => m.update(x).raised.map((a) => a.id));
    assert.ok(raised.includes('hum'));
  });
});

fileDescribe('Reference_speech_recording.wav', '(mains 60 Hz)', () => {
  // The real 59.9 Hz tone at -86 dBFS must never read as 60 Hz hum. MASKED vs NOT DETECTED
  // is judged against maskReferenceDbfs (-75), not the alert level, so the -85 default
  // alert level leaves this NOT DETECTED.
  test('NOT DETECTED, whatever the alert level', () => {
    const { sampleRate, channels: [L, R] } = wav('Reference_speech_recording.wav');
    for (const alertLevelDbfs of [-75, -85]) {
      const r = runHum(L, R, sampleRate, { mainsFrequencyHz: 60, alertLevelDbfs });
      assert.ok(r.settled.every((x) => x.status === NOT_DETECTED), `alert level ${alertLevelDbfs}: ${statuses(r.settled)}`);
    }
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

describe('hum in the event log', () => {
  const sr = 48000;
  const logged = (x, humOptions = {}) => {
    const events = [], rows = [];
    const a = new StreamAnalyzer(sr, { onEvent: (e) => events.push(e), onSecond: (r) => rows.push(r), humOptions });
    for (let i = 0; i < x.length; i += 4800) a.process(x.subarray(i, i + 4800), x.subarray(i, i + 4800));
    const hum = events.filter((e) => e.type === 'hum-onset' || e.type === 'hum-offset' || e.type === 'hum-step');
    return { hum, rows, present: rows.filter((r) => r.humStatus === PRESENT).length };
  };

  test('a hum that comes and goes is one episode: logged after 10 s, ended 30 s after it goes', () => {
    // Present 0-30 s and 42-70 s (a 12 s gap), then gone until 120 s.
    const on = (t) => ((t < 30 || (t >= 42 && t < 70)) ? -60 : -Infinity);
    const { hum, present } = logged(addHum(speechLike(sr, 120, -30), sr, { levelDb: on }));
    assert.ok(present > 40, `${present} s PRESENT`);
    const episodes = hum.filter((e) => e.type !== 'hum-step'); // switching off reads as a step down first
    assert.deepEqual(episodes.map((e) => e.type), ['hum-onset', 'hum-offset'], hum.map((e) => `${e.type} ${e.t}`).join(', '));
    const [onset, offset] = episodes;
    assert.ok(onset.t >= 5 && onset.t < 20, `onset dated ${onset.t} s (from when it began)`);
    assert.ok(offset.t > 65 && offset.t < 76, `offset dated ${offset.t} s (when it went)`);
    assert.equal(offset.duration, offset.t - onset.t);
  });

  test('hum below the alert level shows in the rows but not in the log', () => {
    const { hum, present } = logged(addHum(speechLike(sr, 45, -30), sr, { levelDb: -60 }), { alertLevelDbfs: -50 });
    assert.ok(present > 20, `${present} s PRESENT`);
    assert.equal(hum.length, 0, hum.map((e) => e.type).join(', '));
  });

  test('while the status is held after a lock, the hum is reported as last locked', () => {
    // A 50.75 Hz bass note 30 dB louder replaces the hum: the 2 s hold must not report it.
    const sr2 = 48000;
    const x = addHum(speechLike(sr2, 40, -30), sr2, { levelDb: (t) => (t < 30 ? -70 : -Infinity) });
    const note = addHum(new Float32Array(x.length), sr2, { freq: 50.75, levelDb: (t) => (t >= 30 ? -40 : -Infinity), harmonics: { 1: 0 } });
    for (let i = 0; i < x.length; i++) x[i] += note[i];
    const results = [];
    const d = new HumDetector(sr2, {}, { onResult: (r) => results.push(r) });
    for (let i = 0; i < x.length; i += 128) d.process(x.subarray(i, i + 128), x.subarray(i, i + 128));
    const held = results.filter((r) => r.present && r.t > 30);
    assert.ok(held.every((r) => r.levelDb < -65 && Math.abs(r.fundamentalHz - 50) < 0.1), held.map((r) => `${r.t}: ${r.levelDb.toFixed(1)} dBFS ${r.fundamentalHz.toFixed(2)} Hz`).join('; '));
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

describe('hum in pauses', () => {
  // Speech with a 2 s pause every 8 s (room noise about -75 dBFS in it), plus mains buzz
  // or a stray tone.
  const sr = 48000;
  const alerts = (x, config = {}) => {
    const m = new AlertMonitor(config);
    const raised = [], rows = [];
    new StreamAnalyzer(sr, { onSecond: (r) => { rows.push(r); raised.push(...m.update(r).raised); }, humOptions: { mainsFrequencyHz: 50 } }).process(x, x);
    return { ids: raised.map((a) => a.id), raised, rows };
  };
  const speech = speechLike(sr, 40, -28).map((v, i) => ((i / sr) % 8 >= 6 ? v * 0.004 : v));

  test('odd-harmonic buzz is caught in the pauses, with its level and frequencies', () => {
    const x = addHum(speech, sr, { levelDb: -80, harmonics: { 1: 0, 3: 4, 5: 4, 7: 2 } });
    const r = alerts(x);
    assert.ok(r.ids.includes('humPause'), JSON.stringify(r.ids));
    const msg = r.raised.find((a) => a.id === 'humPause').message;
    assert.match(msg, /^buzz at -7\d\.\d dBFS when it goes quiet \(50, 150, 250, 350 Hz\)$/);
    assert.ok(r.rows.some((row) => Number.isFinite(row.humPauseDb)), 'rows carry the pause level (CSV hum_pause_dbfs)');
  });

  test('one pause of about 2 s is enough; the alert clears a minute after the last buzz', () => {
    const one = speechLike(sr, 40, -28).map((v, i) => (i / sr >= 20 && i / sr < 22 ? v * 0.004 : v));
    const r = alerts(addHum(one, sr, { levelDb: -80, harmonics: { 1: 0, 3: 4, 5: 4, 7: 2 } }));
    assert.ok(r.ids.includes('humPause'), JSON.stringify(r.ids));
    const m = new AlertMonitor();
    const row = (t, db) => ({ t, status: 'CLEAN', humPauseDb: db, humPauseHz: [50, 150, 250], humPauseReadings: db === null ? 0 : 1 });
    for (let t = 1; t <= 120; t++) m.update(row(t, t === 10 || t === 50 ? -70 : null));
    // Raised at 50 (second reading within a minute); held until 50 + 60 s, plus the
    // monitor's usual clear-after time.
    const m2 = new AlertMonitor();
    const seen = [];
    for (let t = 1; t <= 130; t++) if ('humPause' in m2.update(row(t, t === 10 || t === 50 ? -70 : null)).active) seen.push(t);
    assert.equal(seen[0], 50);
    assert.ok(seen.at(-1) >= 109 && seen.at(-1) <= 116, `last active at ${seen.at(-1)} s`);
  });

  test('a plain 50 Hz hum shows in the pause reading, but is not buzz', () => {
    const x = addHum(speech, sr, { levelDb: -70, harmonics: { 1: 0 } });
    const ps = [];
    new HumDetector(sr, { mainsFrequencyHz: 50 }, { onResult: (h) => h.pause && h.pause.ageSec === 0 && ps.push(h.pause), onEvent() {} }).process(x, x);
    // Noise can add a stray line now and then; never three.
    assert.ok(ps.length && ps.every((p) => p.lines.includes(1) && !p.buzz && Math.abs(p.levelDb + 70) < 1.5), JSON.stringify(ps.slice(0, 3)));
    assert.ok(ps.filter((p) => p.lines.join() === '1').length >= ps.length * 0.8, JSON.stringify(ps.map((p) => p.lines.join())));
    assert.ok(!alerts(x).ids.includes('humPause'));
  });

  test('buzz on mains running 0.15 Hz fast keeps its upper harmonics', () => {
    const x = addHum(speech, sr, { freq: 50.15, levelDb: -70, harmonics: { 1: 0, 3: 0, 5: 0, 7: 0, 9: 0 } });
    const ps = [];
    new HumDetector(sr, { mainsFrequencyHz: 50 }, { onResult: (h) => h.pause && h.pause.ageSec === 0 && ps.push(h.pause.lines.join()), onEvent() {} }).process(x, x);
    assert.ok(ps.length && ps.every((l) => ['1', '3', '5', '7', '9'].every((k) => l.split(',').includes(k))), ps.join(' | '));
  });

  test('no alert for clean speech, a single stray tone, or buzz below the level', () => {
    assert.deepEqual(alerts(speech).ids, []);
    assert.deepEqual(alerts(speech.map((v, i) => v + 3e-4 * Math.sin((2 * Math.PI * 150 * i) / sr))).ids, [], 'one line is a note, not buzz');
    // About -84 dBFS summed (readings scatter by about ±1.5 dB with the room noise).
    const quietBuzz = addHum(speech, sr, { levelDb: -93, harmonics: { 1: 0, 3: 4, 5: 4, 7: 2 } });
    assert.ok(!alerts(quietBuzz).ids.includes('humPause'));
    assert.ok(alerts(quietBuzz, { hum: { pauseAlertDbfs: -88 } }).ids.includes('humPause'), 'the level is adjustable');
  });
});

fileDescribe('Reference_hum.wav', '(audible buzz in the pauses of a talk)', () => {
  test('raises Hum in pauses, from 50 Hz and its odd harmonics; no PRESENT-hum alert', () => {
    const { sampleRate, channels: [L, R] } = wav('Reference_hum.wav');
    const m = new AlertMonitor();
    const raised = [];
    new StreamAnalyzer(sampleRate, { onSecond: (r) => raised.push(...m.update(r).raised) }).process(L, R);
    const p = raised.find((a) => a.id === 'humPause');
    assert.ok(p, JSON.stringify(raised));
    assert.match(p.message, /buzz at -7\d\.\d dBFS .*\(50, 150, /);
    assert.ok(!raised.some((a) => a.id === 'hum'));
  });
});

fileDescribe('18Oct2026-31_min_mark.wav', '(service music)', () => {
  test('no hum-in-pauses alert on the service and reference recordings without hum', () => {
    for (const f of ['18Oct2026-30_min_mark.wav', '18Oct2026-31_min_mark.wav', '27Sep2026-92_min_mark.wav', 'Reference_recording.wav', 'Reference_quieter_recording.wav']) {
      if (!existsSync(dir + f)) continue;
      const { sampleRate, channels: [L, R] } = wav(f);
      const m = new AlertMonitor();
      const ids = [];
      new StreamAnalyzer(sampleRate, { onSecond: (r) => ids.push(...m.update(r).raised.map((a) => a.id)) }).process(L, R);
      assert.ok(!ids.includes('humPause'), f);
    }
  });
});

// Reading a saved session CSV back: rows, the rebuilt event log and the totals.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { programme, hardClip, speechLike, addHum } from './synthetic.js';
import { StreamAnalyzer } from '../src/dsp/analyzer.js';
import { csvHeader, csvRow } from '../src/dsp/report.js';
import { parseCsv, readSessionCsv, sessionEvents, sessionSummary, rowAt, stepRows } from '../src/dsp/session-csv.js';
import { AlertMonitor, DEFAULT_ALERTS } from '../src/dsp/alerts.js';
import { statusDetail } from '../src/ui/meters.js';

const sr = 48000;

// 30 s clean, 20 s clipped at 0 dBFS, 30 s clean; speech with a -60 dBFS hum from 80 to 150 s.
function session() {
  const music = programme(sr, 80, -20);
  const a = Math.round(30 * sr), b = Math.round(50 * sr);
  music.set(hardClip(music.subarray(a, b).map((v) => v * 4), 0), a); // at full scale
  const speech = addHum(speechLike(sr, 90, -30), sr, { levelDb: (t) => (t < 70 ? -60 : -Infinity) });
  const x = new Float32Array(music.length + speech.length);
  x.set(music);
  x.set(speech, music.length);
  const rows = [], events = [];
  const an = new StreamAnalyzer(sr, { onSecond: (r) => rows.push(r), onEvent: (e) => events.push(e) });
  for (let i = 0; i < x.length; i += 4800) an.process(x.subarray(i, i + 4800), x.subarray(i, i + 4800));
  an.finish();
  const start = new Date(2026, 9, 30, 19, 17, 20).getTime();
  for (const r of rows) {
    const d = new Date(start + r.t * 1000);
    const p = (n) => String(n).padStart(2, '0');
    r.wallClock = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }
  return { rows, events, summary: an.summary(), start, text: csvHeader() + rows.map(csvRow).join('') };
}

const key = (e) => `${e.type} ${e.status || ''} ${e.t}`;

describe('session CSV', () => {
  const s = session();
  const { rows, startWall } = readSessionCsv(s.text);

  test('every row comes back, with its numbers and wall clock', () => {
    assert.equal(rows.length, s.rows.length);
    const i = 40;
    assert.equal(rows[i].t, s.rows[i].t);
    assert.equal(rows[i].status, s.rows[i].status);
    assert.ok(Math.abs(rows[i].shortTerm - s.rows[i].shortTerm) < 0.06);
    assert.deepEqual(rows[i].detectors, s.rows[i].detectors);
    assert.equal(rows[i].clock, s.rows[i].wallClock.slice(11));
    assert.equal(startWall, s.start);
    assert.equal(rows[0].shortTerm, -Infinity); // "-inf" in the first seconds
  });

  test('the rebuilt log matches the live one: clip episodes, hum and stereo', () => {
    const rebuilt = sessionEvents(rows, { alertLevelDbfs: -85 });
    const live = s.events.filter((e) => ['start', 'end', 'hum-onset', 'hum-offset', 'stereo'].includes(e.type));
    assert.ok(live.some((e) => e.status === 'CLIPPING'), 'the test session clips');
    assert.ok(live.some((e) => e.type === 'hum-onset'), 'the test session has hum');
    assert.deepEqual(rebuilt.map(key).sort(), live.map(key).sort());
  });

  test('hum below the alert level is left out of the rebuilt log', () => {
    const rebuilt = sessionEvents(rows, { alertLevelDbfs: -50 });
    assert.equal(rebuilt.filter((e) => e.type.startsWith('hum')).length, 0);
  });

  test('totals: duration, status seconds, peaks, final integrated', () => {
    const sum = sessionSummary(rows);
    assert.equal(sum.duration, s.summary.duration);
    assert.deepEqual(sum.statusSeconds, s.summary.statusSeconds);
    assert.equal(sum.overallStatus, s.summary.overallStatus);
    assert.ok(Math.abs(sum.truePeakDb - s.summary.truePeakDb) < 0.06, `${sum.truePeakDb} vs ${s.summary.truePeakDb}`);
    assert.ok(Math.abs(sum.integrated - s.summary.integrated) < 0.06);
    assert.deepEqual(sum.hum.statusSeconds, s.summary.hum.statusSeconds);
  });

  test('columns are found by name: an older file without the newer columns loads', () => {
    const [header, ...recs] = parseCsv(s.text);
    const keep = header.map((h, i) => (h === 'stereo_detail' || h === 'hum_pause_dbfs' ? -1 : i)).filter((i) => i >= 0);
    const old = [header, ...recs].map((r) => keep.map((i) => r[i]).join(',')).join('\r\n');
    const back = readSessionCsv(old).rows;
    assert.equal(back.length, rows.length);
    assert.equal(back[50].humPauseDb, undefined);
  });

  test('the newer columns come back: full-scale samples, integrated time, pause readings', () => {
    const clipped = rows.find((r) => r.status === 'CLIPPING' && r.fullScaleSamples > 0);
    assert.ok(clipped, 'a second with full-scale samples');
    const orig = s.rows.find((r) => r.t === clipped.t);
    assert.equal(clipped.fullScaleSamples, orig.fullScaleSamples);
    assert.equal(rows[60].integratedSeconds, s.rows[60].integratedSeconds);
    assert.equal(rows[60].humPauseReadings, s.rows[60].humPauseReadings);
    assert.match(statusDetail(clipped), /^Hitting 0 dBFS: \d+ samples\/s$/);
  });

  test('Stereo by band and the spectrum come back (live rows have them)', () => {
    const live = s.rows.map((r) => ({ ...r, spectrumDb: Array.from({ length: 29 }, (_, i) => -40 - i), bands: r.bands }));
    const back = readSessionCsv(csvHeader() + live.map(csvRow).join('')).rows;
    assert.deepEqual(back[20].spectrumDb.slice(0, 3), [-40, -41, -42]);
    assert.equal(back[20].bands, null, 'no band readings in rows from file analysis');
    const withBands = { ...s.rows[20], bands: [{ fc: 31.25, correlation: 0.987, balanceDb: -1.2, levelDb: -48.3 }, ...Array.from({ length: 9 }, (_, i) => ({ fc: 62.5 * 2 ** i, correlation: null, balanceDb: null, levelDb: -Infinity }))] };
    const one = readSessionCsv(csvHeader() + csvRow(withBands)).rows[0];
    assert.deepEqual(one.bands[0], { fc: 31.25, correlation: 0.987, balanceDb: -1.2, levelDb: -48.3 });
    assert.equal(one.bands[5].levelDb, -Infinity);
  });

  test('arrow-key steps: by time, but always on to the next row, past gaps', () => {
    const rs = [1, 2, 3, 100, 101, 102, 200].map((t) => ({ t }));
    assert.equal(stepRows(rs, 0, 1), 1);
    assert.equal(stepRows(rs, 2, 1), 3, 'over the gap from 3 to 100');
    assert.equal(stepRows(rs, 2, 10), 3);
    assert.equal(stepRows(rs, 3, -1), 2, 'back over it');
    assert.equal(stepRows(rs, 0, 60), 3);
    assert.equal(stepRows(rs, 6, 10), 6, 'stays on the last row');
    assert.equal(stepRows(rs, 0, -10), 0, 'and the first');
  });

  test('a log entry is shown at the second it happened in', () => {
    const start = sessionEvents(rows, { alertLevelDbfs: -85 }).find((e) => e.type === 'start' && e.status === 'CLIPPING');
    assert.equal(rowAt(rows, start.t).status, 'CLIPPING', `row at ${start.t}`);
    assert.equal(rowAt(rows, start.t).t, start.t + 1);
  });

  test('quoted fields keep their commas; other files are refused', () => {
    assert.deepEqual(parseCsv('a,b\n"x, y","say ""hi"""\n'), [['a', 'b'], ['x, y', 'say "hi"']]);
    assert.throws(() => readSessionCsv('name,score\nann,3\n'), /not a Stream Audio Monitor CSV/);
  });
});

// Older and re-saved files.
const dropColumns = (text, names) => {
  const [header, ...recs] = parseCsv(text);
  const keep = header.map((h, i) => (names.includes(h) ? -1 : i)).filter((i) => i >= 0);
  const q = (v) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return [header, ...recs].map((r) => keep.map((i) => q(r[i])).join(',')).join('\n') + '\n';
};

describe('session CSV from file analysis and older versions', () => {
  // A stereo recording whose right channel drops out twice (20-40 s and 70-90 s), analysed
  // as File mode does: no band filters, so ordinary stereo is left blank in the rows.
  const L = programme(sr, 110, -20, 1);
  const R = programme(sr, 110, -20, 2);
  for (const [a, b] of [[20, 40], [70, 90]]) R.fill(0, a * sr, b * sr);
  const rows0 = [], events0 = [];
  const an = new StreamAnalyzer(sr, { onSecond: (r) => rows0.push(r), onEvent: (e) => events0.push(e) });
  for (let i = 0; i < L.length; i += 4800) an.process(L.subarray(i, i + 4800), R.subarray(i, i + 4800));
  an.finish();
  const text = csvHeader() + rows0.map(csvRow).join('');

  test('file analysis: back to stereo and the second dropout are rebuilt too', () => {
    const { rows, fileAnalysis } = readSessionCsv(text);
    assert.ok(fileAnalysis);
    const live = events0.filter((e) => e.type === 'stereo').map(key);
    assert.ok(live.length >= 4, live.join(', '));
    assert.deepEqual(sessionEvents(rows, { alertLevelDbfs: -85 }, { fileAnalysis }).filter((e) => e.type === 'stereo').map(key), live);
  });

  test('before stereo_detail: alerts get a reason, and never name the wrong side', () => {
    const { rows } = readSessionCsv(dropColumns(text, ['stereo_detail', 'hum_pause_dbfs', 'fullscale_samples', 'integrated_s', 'hum_pause_readings']));
    const dead = rows.find((r) => r.stereoStatus === 'CHANNEL DEAD');
    assert.equal(dead.stereoDetail, 'One channel silent'); // the balance is blank while a side is silent
    const mon = new AlertMonitor(DEFAULT_ALERTS);
    const raised = rows.flatMap((r) => mon.update(r).raised);
    const msg = raised.find((a) => a.id === 'stereoDead');
    assert.ok(msg && /^One channel silent: only one side carries sound/.test(msg.message), msg && msg.message);
    assert.ok(raised.every((a) => !/undefined/.test(a.message)), raised.map((a) => a.message).join('; '));
  });

  test('before stereo_status: mono from the correlation', () => {
    const mono = programme(sr, 20, -20, 3);
    const rs = [];
    const a2 = new StreamAnalyzer(sr, { onSecond: (r) => rs.push(r) });
    a2.process(mono, mono);
    const { rows } = readSessionCsv(dropColumns(csvHeader() + rs.map(csvRow).join(''), ['stereo_status', 'stereo_detail', 'balance_db']));
    assert.ok(rows.slice(3).every((r) => r.mono), 'a mono feed reads mono');
    assert.ok(sessionSummary(rows).mono);
    assert.ok(!readSessionCsv(dropColumns(text, ['stereo_status', 'stereo_detail', 'balance_db'])).rows[5].mono, 'stereo stays stereo');
  });

  test('a blank cell does not hide the highest true peak', () => {
    const [header, ...recs] = parseCsv(text);
    const i = header.indexOf('true_peak_dbtp');
    recs[3][i] = '';
    const blanked = [header, ...recs].map((r) => r.join(',')).join('\n');
    const best = Math.max(...rows0.map((r) => r.truePeakDb));
    assert.ok(Math.abs(sessionSummary(readSessionCsv(blanked).rows).truePeakDb - best) < 0.06);
  });

  test('a clock re-saved by a spreadsheet is not shown in pieces', () => {
    const [header, ...recs] = parseCsv(text);
    const w = header.indexOf('wall_clock');
    for (const r of recs) r[w] = '10/30/2026 7:17:21 PM';
    const back = readSessionCsv([header, ...recs].map((r) => r.join(',')).join('\n'));
    assert.equal(back.startWall, null);
    assert.equal(back.rows[0].clock, null);
  });
});

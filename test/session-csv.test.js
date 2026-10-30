// Reading a saved session CSV back: rows, the rebuilt event log and the totals.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { programme, hardClip, speechLike, addHum } from './synthetic.js';
import { StreamAnalyzer } from '../src/dsp/analyzer.js';
import { csvHeader, csvRow } from '../src/dsp/report.js';
import { parseCsv, readSessionCsv, sessionEvents, sessionSummary } from '../src/dsp/session-csv.js';

const sr = 48000;

// 30 s clean, 20 s hard-clipped, 30 s clean; speech with a -60 dBFS hum from 80 to 150 s.
function session() {
  const music = programme(sr, 80, -20);
  const a = Math.round(30 * sr), b = Math.round(50 * sr);
  music.set(hardClip(music.subarray(a, b).map((v) => v * 4), -3), a);
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

  test('quoted fields keep their commas; other files are refused', () => {
    assert.deepEqual(parseCsv('a,b\n"x, y","say ""hi"""\n'), [['a', 'b'], ['x, y', 'say "hi"']]);
    assert.throws(() => readSessionCsv('name,score\nann,3\n'), /not a Stream Audio Monitor CSV/);
  });
});

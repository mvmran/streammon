// Reading a saved session CSV back: rows, the rebuilt event log and the totals.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { programme, hardClip, speechLike, addHum } from './synthetic.js';
import { StreamAnalyzer } from '../src/dsp/analyzer.js';
import { csvHeader, csvRow } from '../src/dsp/report.js';
import { parseCsv, readSessionCsv, sessionEvents, sessionSummary, rowAt, stepRows } from '../src/dsp/session-csv.js';
import { AlertMonitor, DEFAULT_ALERTS } from '../src/dsp/alerts.js';
import { PanGrid, PAN_COLS, PAN_ROWS } from '../src/dsp/pan.js';
import { encodeSpectrum, decodeSpectrum, encodeBands, decodeBands, encodePan, decodePan, SAFE_CODE, toBase64Url, fromBase64Url } from '../src/dsp/csv-codec.js';
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
    assert.equal(s.rows[0].shortTerm, -Infinity);
    assert.equal(rows[0].shortTerm, null, 'silence is written blank: spreadsheets turn "-inf" into #NAME?');
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

  test('clocks re-saved by Excel or Google Sheets: read in their formats, seconds recovered', () => {
    // As they save "2026-10-31 07:42:33" on an Australian computer: a date, no seconds.
    const [header, ...recs] = parseCsv(text);
    const w = header.indexOf('wall_clock'), e = header.indexOf('elapsed_s');
    const start = new Date(2026, 9, 31, 7, 42, 33).getTime();
    for (const fmt of [(d) => `${d.getDate()}/${d.getMonth() + 1}/${d.getFullYear()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`, (d) => `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()} ${d.getHours() % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')} ${d.getHours() < 12 ? 'AM' : 'PM'}`]) {
      for (const r of recs) r[w] = fmt(new Date(start + Number(r[e]) * 1000));
      const back = readSessionCsv([header, ...recs].map((r) => r.join(',')).join('\n'));
      assert.ok(back.startDated && Math.abs(back.startWall - start) <= 1000, `start ${new Date(back.startWall)} for ${recs[0][w]}`);
      assert.equal(back.rows[30].clock, '07:43:04', 'row clocks get their seconds back (t = 31 s)');
    }
  });

  test('a clock nothing can be made of is not shown in pieces', () => {
    const [header, ...recs] = parseCsv(text);
    const w = header.indexOf('wall_clock');
    for (const r of recs) r[w] = 'Friday afternoon';
    const back = readSessionCsv([header, ...recs].map((r) => r.join(',')).join('\n'));
    assert.equal(back.startWall, null);
    assert.equal(back.rows[0].clock, null);
  });
});

describe('encoded chart data (stereo_bands, spectrum, pan_map)', () => {
  // A spectrum (dB per FFT bin) with energy in a few bins only: -30 dB, else silent.
  const spectrumWith = (bins, n = 4096) => {
    const x = new Float32Array(n).fill(-200);
    for (const b of bins) x[b] = -30;
    return x;
  };
  const sr = 48000, binOf = (hz) => Math.round(hz / (sr / 2 / 4096));
  const someBands = () => [{ fc: 31.25, correlation: 0.9993, balanceDb: -1.23, levelDb: -48.3 }, { fc: 62.5, correlation: null, balanceDb: null, levelDb: -Infinity }, ...Array.from({ length: 8 }, (_, i) => ({ fc: 125 * 2 ** i, correlation: -0.5 + i / 10, balanceDb: 12.5 - i, levelDb: -20 - i }))];

  test('URL-safe base64 round trip, every length', () => {
    for (let n = 0; n < 40; n++) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 97 + n) & 255);
      assert.deepEqual(fromBase64Url(toBase64Url(bytes)), bytes);
    }
  });

  test('spectrum: 0.5 dB steps, silence kept', () => {
    const levels = Array.from({ length: 29 }, (_, i) => -20 - i * 2.3);
    levels[3] = -Infinity;
    const back = decodeSpectrum(encodeSpectrum(levels));
    levels.forEach((v, i) => assert.ok(v === -Infinity ? back[i] === -Infinity : Math.abs(back[i] - v) <= 0.25, `${i}: ${back[i]} vs ${v}`));
    assert.deepEqual(decodeSpectrum(encodeSpectrum(back)), back, 'decoding and encoding again is exact');
  });

  test('Stereo by band: correlation to 1/32767, balance to 0.01 dB, gaps kept', () => {
    const bands = someBands();
    const back = decodeBands(encodeBands(bands));
    assert.ok(Math.abs(back[0].correlation - 0.9993) < 4e-5 && Math.abs(back[0].balanceDb + 1.23) < 0.006);
    assert.ok(Math.abs(back[0].levelDb + 48.3) <= 0.25);
    assert.deepEqual([back[1].correlation, back[1].balanceDb, back[1].levelDb], [null, null, -Infinity]);
    assert.equal(back[9].fc, 16000);
  });

  test('pan map: the full grid in 3 dB steps over 45 dB below each band\'s loudest cell', async () => {
    const g = new PanGrid();
    g.update(spectrumWith([binOf(1000), binOf(250)]), spectrumWith([binOf(1050), binOf(250)]), sr, 0);
    const grid = g.takeSecond();
    const back = await decodePan(await encodePan(grid));
    for (let i = 0; i < grid.length; i++) {
      const a = grid[i], b = back[i];
      const top = Math.max(...grid.subarray(Math.floor(i / PAN_COLS) * PAN_COLS, (Math.floor(i / PAN_COLS) + 1) * PAN_COLS));
      if (!(a > top * 10 ** -4.5)) assert.equal(b, 0, `cell ${i} more than 45 dB down`);
      else assert.ok(Math.abs(10 * Math.log10(b / a)) <= 1.8, `cell ${i}: ${b} vs ${a}`);
    }
  });

  test('every encoded value is spreadsheet-safe text, and the pan map stays small', async () => {
    const g = new PanGrid();
    // A busy stereo second: energy everywhere at different balances.
    const l = Float32Array.from({ length: 4096 }, (_, b) => -40 - (b % 17)), r = Float32Array.from({ length: 4096 }, (_, b) => -40 - (b % 23));
    for (let f = 0; f < 10; f++) g.update(l, r, sr, f / 10);
    const codes = [encodeSpectrum(Array.from({ length: 29 }, () => -30)), encodeBands(someBands()), await encodePan(g.takeSecond())];
    for (const c of codes) {
      assert.match(c, SAFE_CODE);
      assert.ok(!/^[=+\-@]/.test(c) && !Number.isFinite(Number(c)) && !/[,"\n\r]/.test(c), c.slice(0, 40));
    }
    assert.ok(codes[2].length < 2000, `pan map ${codes[2].length} characters`);
  });

  test('a CSV row carries them and reads them back', async () => {
    const g = new PanGrid();
    g.update(spectrumWith([binOf(1000)]), spectrumWith([]), sr, 0);
    const row = { t: 1, status: 'CLEAN', detectors: [], bands: someBands(), spectrumDb: Array.from({ length: 29 }, (_, i) => -40 - i) };
    row.panCode = await encodePan(g.takeSecond());
    const back = readSessionCsv(csvHeader() + csvRow(row)).rows[0];
    assert.equal(back.spectrumDb[2], -42);
    assert.ok(Math.abs(back.bands[0].correlation - 0.9993) < 4e-5);
    const grid = await decodePan(back.panCode);
    const row1k = 16 * PAN_COLS;
    assert.ok(grid[row1k] > 0 && grid.subarray(row1k + 1, row1k + PAN_COLS).every((v) => v === 0), 'left-only 1 kHz in its leftmost cell');
    const none = readSessionCsv(csvHeader() + csvRow({ t: 1, status: 'CLEAN', detectors: [] })).rows[0];
    assert.deepEqual([none.bands, none.spectrumDb, none.panCode], [null, null, null]);
  });

  test('the recorder keeps rows in order while their pan maps are encoded, and drops them after a clear', async () => {
    const { SessionRecorder } = await import('../src/ui/session.js');
    const rec = new SessionRecorder();
    const slow = new Promise((r) => setTimeout(r, 30));
    rec.addLater({ t: 1, status: 'CLEAN', detectors: [] }, slow);
    rec.addLater({ t: 2, status: 'CLEAN', detectors: [] }, Promise.resolve());
    await rec.later;
    assert.deepEqual(rec.rows.map((l) => l.split(',')[1]), ['1.0', '2.0']);
    rec.addLater({ t: 3, status: 'CLEAN', detectors: [] }, new Promise((r) => setTimeout(r, 10)));
    rec.clear();
    await rec.later;
    assert.equal(rec.count, 0, 'a row finished after Reset belongs to the old session');
  });
});

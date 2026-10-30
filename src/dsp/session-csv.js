// Reads a saved session CSV (report.js CSV_COLUMNS) back into rows, and replays them
// through the event log's rules (episodes.js), for reviewing a past session in File mode.
// Columns are found by name, so older files with fewer columns load too; what a column
// added later would have held is filled in where it can be worked out. Only what the CSV
// holds can be shown: no spectrum, pan map or audio.

import { CLEAN, LIMITED, CLIPPING, sessionStatus } from './clipdetect.js';
import { PRESENT, NOT_DETECTED, MASKED } from './hum.js';
import { MONO, UNBALANCED, CHANNEL_DEAD, PHASE_PROBLEM, WIDE, STEREO_OK, STEREO, deadDetail, monoStatus } from './stereobands.js';
import { MONO_CORRELATION } from './stereo.js';
import { CSV_COLUMNS } from './report.js';
import { ClipEpisodes, StereoLog, HumLog } from './episodes.js';

const COLUMNS = new Map(CSV_COLUMNS.map((c) => [c.name, c]));

// RFC 4180 records: quoted fields may hold commas, quotes ("") and line breaks.
export function parseCsv(text) {
  const records = [];
  let rec = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') field += text[++i];
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      rec.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      rec.push(field);
      records.push(rec);
      rec = [];
      field = '';
    } else field += c;
  }
  if (field || rec.length) {
    rec.push(field);
    records.push(rec);
  }
  return records.filter((r) => r.length > 1 || r[0] !== '');
}

// Whether this computer writes dates day first (31/10/2026) or month first (10/31/2026).
function dayFirst() {
  try {
    const parts = new Intl.DateTimeFormat().formatToParts(new Date(2026, 9, 31));
    return parts.findIndex((p) => p.type === 'day') < parts.findIndex((p) => p.type === 'month');
  } catch {
    return true;
  }
}

// A wall-clock cell as exported ("2026-10-30 19:17:21", local time) or as a spreadsheet
// saved it back: Excel and Google Sheets turn it into a date in the computer's own format
// and drop the seconds ("30/10/2026 7:17", "10/30/2026 7:17:21 PM"). Returns { ms, seconds:
// whether it had them, dated: whether it had a date } or null.
export function parseWallClock(s) {
  const time = s && /(\d{1,2}):(\d\d)(?::(\d\d))?\s*([AaPp][Mm])?/.exec(s);
  if (!time) return null;
  let h = +time[1];
  if (time[4]) h = (h % 12) + (/p/i.test(time[4]) ? 12 : 0);
  let y = 2000, mo = 1, d = 1, dated = true, m;
  if ((m = /(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s))) [y, mo, d] = [+m[1], +m[2], +m[3]];
  else if ((m = /(\d{1,2})[/.](\d{1,2})[/.](\d{2,4})/.exec(s))) {
    const a = +m[1], b = +m[2];
    y = +m[3] < 100 ? 2000 + +m[3] : +m[3];
    // Unambiguous when one of them is over 12; otherwise this computer's order, which is
    // the one the spreadsheet on it wrote.
    [d, mo] = a > 12 ? [a, b] : b > 12 ? [b, a] : dayFirst() ? [a, b] : [b, a];
  } else dated = false;
  const ms = new Date(y, mo - 1, d, h, +time[2], time[3] === undefined ? 0 : +time[3]).getTime();
  return Number.isFinite(ms) ? { ms, seconds: time[3] !== undefined, dated } : null;
}

// The session's start on the wall clock (ms) from the rows' clocks: exact when they have
// seconds; otherwise from the row where the minute changes (that minute began during that
// row's second, so within a second), or the middle of the first row's minute.
function sessionStart(rows) {
  const walls = rows.map((r) => parseWallClock(r.wallClock));
  const exact = walls.findIndex((w) => w && w.seconds);
  if (exact >= 0) return { ms: walls[exact].ms - rows[exact].t * 1000, dated: walls[exact].dated };
  for (let k = 1; k < rows.length; k++) {
    if (walls[k] && walls[k - 1] && walls[k].ms !== walls[k - 1].ms) return { ms: walls[k].ms - rows[k].t * 1000 + 500, dated: walls[k].dated };
  }
  const first = walls.findIndex(Boolean);
  return first >= 0 ? { ms: walls[first].ms + 30000 - rows[first].t * 1000, dated: walls[first].dated } : null;
}

const pad2 = (n) => String(n).padStart(2, '0');

// The Stereo card's reason for files saved before stereo_detail existed (2026-10-22 to
// 10-25), worked out from the balance where it can be; the alerts quote it. A dead channel's
// side can't be: the balance is blank while one side is silent.
function stereoDetailFor(r) {
  const b = typeof r.stereoBalanceDb === 'number' ? r.stereoBalanceDb : null; // R over L, dB (-inf: right silent)
  switch (r.stereoStatus) {
    case CHANNEL_DEAD:
      return b === null || Number.isNaN(b) ? 'One channel silent' : deadDetail(b < 0 ? 'right' : 'left');
    case UNBALANCED:
      if (!Number.isFinite(b)) return 'One side louder';
      return r.correlation > MONO_CORRELATION ? monoStatus(b).detail : `${Math.abs(b).toFixed(1)} dB louder on the ${b < 0 ? 'left' : 'right'}`;
    case MONO:
      return 'Left and right identical';
    case PHASE_PROBLEM:
      return 'Out of phase';
    case WIDE:
      return 'Wide image';
    case STEREO_OK:
      return 'Balanced, in phase';
    default:
      return null;
  }
}

// Parses a session CSV into rows like the analyzer's onSecond rows. Throws if it isn't
// one. fileAnalysis: saved from an analysed audio file (no wall clock), whose rows judge
// only MONO / UNBALANCED / CHANNEL DEAD and leave ordinary stereo blank.
export function readSessionCsv(text) {
  const [header, ...records] = parseCsv(text.replace(/^﻿/, ''));
  if (!header || !header.includes('elapsed_s') || !header.includes('status')) {
    throw new Error('not a Stream Audio Monitor CSV (no elapsed_s and status columns)');
  }
  const cols = header.map((name) => COLUMNS.get(name) || null);
  const has = (name) => header.includes(name);
  const rows = [];
  let maxTp = -Infinity;
  for (const rec of records) {
    const row = {};
    cols.forEach((c, i) => {
      if (c) row[c.field] = c.parse(rec[i]);
    });
    // The pan map stays encoded (panCode) until a moment is shown: decodePan is async.
    if (!Number.isFinite(row.t) || !row.status) continue;
    row.detectors ??= [];
    for (const k of ['dwellRate', 'pileRatio', 'pinned']) row[k] ??= 0;
    // Before stereo_status (2026-10-22) only the correlation says whether it was mono.
    row.mono = has('stereo_status') ? row.stereoStatus === MONO : row.correlation > MONO_CORRELATION;
    if (row.stereoStatus && !has('stereo_detail')) row.stereoDetail = stereoDetailFor(row);
    if (Number.isFinite(row.truePeakDb) && row.truePeakDb > maxTp) maxTp = row.truePeakDb;
    row.maxTruePeakDb = maxTp; // the true-peak card: highest so far
    // Before hum_pause_readings: count a second with a pause level as one reading.
    if (!has('hum_pause_readings')) row.humPauseReadings = Number.isFinite(row.humPauseDb) ? 1 : 0;
    rows.push(row);
  }
  if (!rows.length) throw new Error('the CSV has no rows');
  // Each row's clock from the start and its elapsed time, so a spreadsheet's re-saved
  // clocks (minutes only) get their seconds back.
  const start = sessionStart(rows);
  const startWall = start ? start.ms : null;
  for (const r of rows) {
    const d = startWall === null ? null : new Date(startWall + r.t * 1000);
    r.clock = d ? `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}` : null;
  }
  const fileAnalysis = rows.every((r) => !r.wallClock);
  return { rows, startWall, startDated: !!(start && start.dated), fileAnalysis };
}

// Replays rows through the event log's rules. humOptions: { alertLevelDbfs } (the current
// settings, as file analysis uses); the mains frequency comes from the rows.
export function sessionEvents(rows, humOptions, { fileAnalysis = false } = {}) {
  const events = [];
  const emit = (e) => events.push(e);
  const clip = new ClipEpisodes(emit);
  const stereo = new StereoLog(emit);
  const hum = new HumLog(emit);
  // Integrated resets aren't in the CSV (integrated_s restarts, but older files don't
  // have it); the JSON export's log has them.
  for (const r of rows) {
    clip.update({ status: r.status, detectors: r.detectors, dwellRate: r.dwellRate, fullScaleSamples: r.fullScaleSamples || 0, ceilingDb: r.ceilingDb, pileRatio: r.pileRatio }, r.t);
    const present = r.humStatus === PRESENT && Number.isFinite(r.humLevelDb);
    const h = r.humStatus ? { status: r.humStatus, present, levelDb: r.humLevelDb, fundamentalHz: r.humFrequencyHz, refHarmonic: 1 } : null;
    hum.update(h, r.t, { alertLevelDbfs: humOptions.alertLevelDbfs, mainsFrequencyHz: r.humMainsHz });
    // As the analyzer does: file analysis leaves ordinary stereo blank.
    stereo.update(r.stereoStatus || (fileAnalysis ? STEREO : null), r.stereoDetail, r.t);
  }
  if (rows.length) clip.finish(rows[rows.length - 1].t);
  return events.sort((a, b) => a.t - b.t);
}

// The row covering session time t: each row is the second ending at its t.
export function rowAt(rows, t) {
  let lo = 0, hi = rows.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid].t <= t) lo = mid + 1;
    else hi = mid;
  }
  return rows[lo];
}

// The row about `seconds` (±) away from rows[i]: the first at or past that time going
// forward, the last at or before it going back, and always at least the next row, so a
// gap in the rows (some deleted in a spreadsheet) doesn't stop the stepping. Its index.
export function stepRows(rows, i, seconds) {
  const target = rows[i].t + seconds;
  let lo = 0, hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (seconds > 0 ? rows[mid].t < target : rows[mid].t <= target) lo = mid + 1;
    else hi = mid;
  }
  const j = seconds > 0 ? Math.max(lo, i + 1) : Math.min(lo - 1, i - 1);
  return Math.max(0, Math.min(rows.length - 1, j));
}

// Session totals from the rows, in the shape of StreamAnalyzer.summary() (what the file
// summary line shows). Integrated loudness and LRA are the last row's (since the last
// integrated reset, if there was one); peaks are the highest of any second.
export function sessionSummary(rows) {
  const last = rows[rows.length - 1];
  const secs = { [CLEAN]: 0, [LIMITED]: 0, [CLIPPING]: 0 };
  const hum = { [PRESENT]: 0, [NOT_DETECTED]: 0, [MASKED]: 0 };
  const max = { truePeakDb: -Infinity, samplePeakDb: -Infinity, momentary: -Infinity, shortTerm: -Infinity, hum: -Infinity };
  const higher = (k, v) => {
    if (Number.isFinite(v) && v > max[k]) max[k] = v;
  };
  let pow = 0, n = 0, mono = 0, judged = 0, cw = 0, cs = 0, dwell = 0, fullScale = 0;
  for (const r of rows) {
    if (r.status in secs) secs[r.status]++;
    if (r.humStatus in hum) hum[r.humStatus]++;
    if (r.humStatus === PRESENT) higher('hum', r.humLevelDb);
    for (const k of ['truePeakDb', 'samplePeakDb', 'momentary', 'shortTerm']) higher(k, r[k]);
    dwell += r.dwellRate || 0;
    fullScale += r.fullScaleSamples || 0;
    if (Number.isFinite(r.rmsDb)) {
      const p = 10 ** (r.rmsDb / 10);
      pow += p;
      n++;
      // Correlation weighted by power, so loud passages count most (as the live meter's).
      if (Number.isFinite(r.correlation)) {
        cs += r.correlation * p;
        cw += p;
      }
    }
    if (r.stereoStatus || Number.isFinite(r.correlation)) {
      judged++;
      if (r.mono) mono++;
    }
  }
  const { overall, worst, total } = sessionStatus(secs);
  const rmsDb = n ? 10 * Math.log10(pow / n) : -Infinity;
  return {
    duration: last.t,
    sampleRate: null,
    integrated: last.integrated,
    lra: last.lra,
    maxMomentary: max.momentary,
    maxShortTerm: max.shortTerm,
    samplePeakDb: max.samplePeakDb,
    truePeakDb: max.truePeakDb,
    crestDb: Number.isFinite(max.samplePeakDb) && Number.isFinite(rmsDb) ? max.samplePeakDb - rmsDb : null,
    correlation: cw ? cs / cw : null,
    sideMidDb: null,
    mono: judged > 0 && mono / judged >= 0.5,
    statusSeconds: secs,
    overallStatus: overall,
    meanDwellRate: total ? dwell / total : 0,
    fullScaleSamples: fullScale,
    ceilingDb: last.ceilingDb,
    worstStatus: worst,
    hum: { mainsHz: last.humMainsHz, statusSeconds: hum, maxLevelDb: max.hum, last: null },
  };
}

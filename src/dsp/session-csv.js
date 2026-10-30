// Reads a saved session CSV (report.js CSV_COLUMNS) back into rows, and replays them
// through the event log's rules (episodes.js) and the alert rules, for reviewing a past
// session in File mode. Columns are found by name, so older files with fewer columns
// load too. Only what the CSV holds can be shown: no spectrum, pan map or audio.

import { CLEAN, LIMITED, CLIPPING } from './clipdetect.js';
import { PRESENT, NOT_DETECTED, MASKED } from './hum.js';
import { ClipEpisodes, StereoLog, HumLog } from './episodes.js';

const num = (s) => {
  if (s === '' || s === undefined) return null;
  if (s === '-inf') return -Infinity;
  if (s === 'inf') return Infinity;
  const x = Number(s);
  return Number.isFinite(x) ? x : null;
};
const str = (s) => (s === undefined || s === '' ? null : s);

// CSV column -> [row field, parser]. The reverse of CSV_COLUMNS.
const FIELDS = {
  wall_clock: ['wallClock', str],
  elapsed_s: ['t', num],
  momentary_lufs: ['momentary', num],
  short_term_lufs: ['shortTerm', num],
  integrated_lufs: ['integrated', num],
  lra_lu: ['lra', num],
  sample_peak_dbfs: ['samplePeakDb', num],
  true_peak_dbtp: ['truePeakDb', num],
  rms_dbfs: ['rmsDb', num],
  crest_db: ['crestDb', num],
  correlation: ['correlation', num],
  side_mid_db: ['sideMidDb', num],
  balance_db: ['stereoBalanceDb', num],
  stereo_status: ['stereoStatus', str],
  status: ['status', str],
  detectors: ['detectors', (s) => (s ? s.split('+') : [])],
  dwell_runs_per_s: ['dwellRate', num],
  pileup_ratio: ['pileRatio', num],
  peaks_pinned: ['pinned', num],
  ceiling_dbfs: ['ceilingDb', num],
  fullscale_runs: ['fullScaleRuns', (s) => num(s) ?? 0],
  hum_mains_hz: ['humMainsHz', num],
  hum_status: ['humStatus', str],
  hum_level_dbfs: ['humLevelDb', num],
  hum_frequency_hz: ['humFrequencyHz', num],
  hum_prominence_db: ['humProminenceDb', num],
  hum_projected_dbfs: ['humProjectedDb', num],
  stereo_detail: ['stereoDetail', str],
  hum_pause_dbfs: ['humPauseDb', num],
};

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

// "2026-10-30 19:17:21" (local time) -> ms since the epoch, or null.
function parseStamp(s) {
  const m = s && /^(\d{4})-(\d\d)-(\d\d)[ T](\d\d):(\d\d):(\d\d)/.exec(s);
  return m ? new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime() : null;
}

// Parses a session CSV into rows like the analyzer's onSecond rows (the fields the CSV
// holds, plus a few derived ones). Throws if it isn't one.
export function readSessionCsv(text) {
  const [header, ...records] = parseCsv(text.replace(/^﻿/, ''));
  if (!header || !header.includes('elapsed_s') || !header.includes('status')) {
    throw new Error('not a Stream Audio Monitor CSV (no elapsed_s and status columns)');
  }
  const cols = header.map((name) => FIELDS[name] || null);
  const rows = [];
  let maxTp = -Infinity;
  for (const rec of records) {
    const row = {};
    cols.forEach((c, i) => {
      if (c) row[c[0]] = c[1](rec[i]);
    });
    if (!Number.isFinite(row.t) || !row.status) continue;
    row.detectors ??= [];
    for (const k of ['dwellRate', 'pileRatio', 'pinned']) row[k] ??= 0;
    row.mono = row.stereoStatus === 'MONO';
    if (Number.isFinite(row.truePeakDb) && row.truePeakDb > maxTp) maxTp = row.truePeakDb;
    row.maxTruePeakDb = maxTp; // the true-peak card: highest so far
    // A pause reading the CSV only has as a level: count it as one half-second reading.
    row.humPauseReadings = Number.isFinite(row.humPauseDb) ? 1 : 0;
    rows.push(row);
  }
  if (!rows.length) throw new Error('the CSV has no rows');
  // The session start on the wall clock, from the first row that has one.
  const first = rows.find((r) => parseStamp(r.wallClock) !== null);
  const startWall = first ? parseStamp(first.wallClock) - first.t * 1000 : null;
  for (const r of rows) r.clock = r.wallClock ? r.wallClock.slice(11, 19) : null;
  return { rows, startWall };
}

// Replays rows through the event log's rules. humOptions: { alertLevelDbfs } (the current
// settings, as file analysis uses); the mains frequency comes from the rows.
export function sessionEvents(rows, humOptions) {
  const events = [];
  const emit = (e) => events.push(e);
  const clip = new ClipEpisodes(emit);
  const stereo = new StereoLog(emit);
  const hum = new HumLog(emit);
  // Integrated resets aren't in the CSV (the reading restarts within the second, so it
  // can't be told from ordinary changes); the JSON export's log has them.
  for (const r of rows) {
    clip.update({ status: r.status, detectors: r.detectors, dwellRate: r.dwellRate, fullScaleSamples: 0, ceilingDb: r.ceilingDb, pileRatio: r.pileRatio }, r.t);
    const present = r.humStatus === PRESENT && Number.isFinite(r.humLevelDb);
    const h = r.humStatus ? { status: r.humStatus, present, levelDb: r.humLevelDb, fundamentalHz: r.humFrequencyHz, refHarmonic: 1 } : null;
    hum.update(h, r.t, { alertLevelDbfs: humOptions.alertLevelDbfs, mainsFrequencyHz: r.humMainsHz });
    stereo.update(r.stereoStatus, r.stereoDetail, r.t);
  }
  if (rows.length) clip.finish(rows[rows.length - 1].t);
  return events.sort((a, b) => a.t - b.t);
}

// Session totals from the rows, in the shape of StreamAnalyzer.summary() (what the file
// summary line shows). Integrated loudness and LRA are the last row's (since the last
// integrated reset, if there was one); peaks are the highest of any second.
export function sessionSummary(rows) {
  const last = rows[rows.length - 1];
  const secs = { [CLEAN]: 0, [LIMITED]: 0, [CLIPPING]: 0 };
  const hum = { [PRESENT]: 0, [NOT_DETECTED]: 0, [MASKED]: 0 };
  let tp = -Infinity, sp = -Infinity, pow = 0, n = 0, humMax = -Infinity, mono = 0, judged = 0, cw = 0, cs = 0;
  let maxM = -Infinity, maxS = -Infinity, dwell = 0;
  for (const r of rows) {
    if (r.status in secs) secs[r.status]++;
    if (r.humStatus in hum) hum[r.humStatus]++;
    if (r.humStatus === PRESENT && r.humLevelDb > humMax) humMax = r.humLevelDb;
    if (r.truePeakDb > tp) tp = r.truePeakDb;
    if (r.samplePeakDb > sp) sp = r.samplePeakDb;
    if (r.momentary > maxM) maxM = r.momentary;
    if (r.shortTerm > maxS) maxS = r.shortTerm;
    dwell += r.dwellRate || 0;
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
    if (r.stereoStatus) {
      judged++;
      if (r.stereoStatus === 'MONO') mono++;
    }
  }
  const total = secs[CLEAN] + secs[LIMITED] + secs[CLIPPING];
  let overall = CLEAN;
  if (secs[CLIPPING] > 0) overall = CLIPPING;
  else if (total && secs[LIMITED] / total >= 0.25) overall = LIMITED;
  const rmsDb = n ? 10 * Math.log10(pow / n) : -Infinity;
  return {
    duration: last.t,
    sampleRate: null,
    integrated: last.integrated,
    lra: last.lra,
    maxMomentary: maxM,
    maxShortTerm: maxS,
    samplePeakDb: sp,
    truePeakDb: tp,
    crestDb: Number.isFinite(sp) && Number.isFinite(rmsDb) ? sp - rmsDb : null,
    correlation: cw ? cs / cw : null,
    sideMidDb: null,
    mono: judged > 0 && mono / judged >= 0.5,
    statusSeconds: secs,
    overallStatus: overall,
    meanDwellRate: total ? dwell / total : 0,
    ceilingDb: last.ceilingDb,
    worstStatus: secs[CLIPPING] ? CLIPPING : secs[LIMITED] ? LIMITED : CLEAN,
    hum: { mainsHz: last.humMainsHz, statusSeconds: hum, maxLevelDb: humMax, last: null },
  };
}

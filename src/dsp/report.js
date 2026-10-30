// CSV rows and JSON summary for session export.

// Parses one exported cell back: the inverse of num(). A spreadsheet's error value
// (#NAME?, #VALUE!) reads as no reading.
export function parseNum(s) {
  if (s === '' || s === undefined) return null;
  if (s === '-inf') return -Infinity;
  if (s === 'inf') return Infinity;
  const x = Number(s);
  return Number.isFinite(x) ? x : null;
}
const parseStr = (s) => (s === undefined || s === '' ? null : s);

import { encodeBands, decodeBands, encodeSpectrum, decodeSpectrum } from './csv-codec.js';

// One list for export and import (session-csv.js): { name, field, get, parse }.
const number = (name, field, digits = 1) => ({ name, field, get: (r) => num(r[field], digits), parse: parseNum });
const text = (name, field) => ({ name, field, get: (r) => r[field] || '', parse: parseStr });
const count = (name, field) => ({ name, field, get: (r) => String(r[field] ?? 0), parse: (s) => parseNum(s) ?? 0 });

export const CSV_COLUMNS = [
  text('wall_clock', 'wallClock'),
  { name: 'elapsed_s', field: 't', get: (r) => r.t.toFixed(1), parse: parseNum },
  number('momentary_lufs', 'momentary'),
  number('short_term_lufs', 'shortTerm'),
  number('integrated_lufs', 'integrated'),
  number('lra_lu', 'lra'),
  number('sample_peak_dbfs', 'samplePeakDb'),
  number('true_peak_dbtp', 'truePeakDb'),
  number('rms_dbfs', 'rmsDb'),
  number('crest_db', 'crestDb'),
  number('correlation', 'correlation', 4),
  number('side_mid_db', 'sideMidDb'),
  number('balance_db', 'stereoBalanceDb'),
  text('stereo_status', 'stereoStatus'),
  { name: 'status', field: 'status', get: (r) => r.status, parse: parseStr },
  { name: 'detectors', field: 'detectors', get: (r) => (r.detectors || []).join('+'), parse: (s) => (s ? s.split('+') : []) },
  number('dwell_runs_per_s', 'dwellRate'),
  number('pileup_ratio', 'pileRatio', 2),
  number('peaks_pinned', 'pinned', 2),
  number('ceiling_dbfs', 'ceilingDb'),
  count('fullscale_runs', 'fullScaleRuns'),
  { name: 'hum_mains_hz', field: 'humMainsHz', get: (r) => (r.humMainsHz ? String(r.humMainsHz) : ''), parse: parseNum },
  text('hum_status', 'humStatus'),
  number('hum_level_dbfs', 'humLevelDb'),
  number('hum_frequency_hz', 'humFrequencyHz', 2),
  number('hum_prominence_db', 'humProminenceDb'),
  number('hum_projected_dbfs', 'humProjectedDb'),
  // Newer columns go at the end, so older spreadsheets reading by position still work.
  text('stereo_detail', 'stereoDetail'),
  number('hum_pause_dbfs', 'humPauseDb'),
  // So a saved session replays like the live one (session-csv.js): full-scale samples,
  // time since the last integrated reset, half-second pause readings with buzz.
  count('fullscale_samples', 'fullScaleSamples'),
  number('integrated_s', 'integratedSeconds', 0),
  count('hum_pause_readings', 'humPauseReadings'),
  // The charts' data each second, each in one spreadsheet-safe encoded cell (csv-codec.js;
  // live sessions only): Stereo by band's 1 s readings, the 1/3-octave spectrum averaged
  // over the second, and the second's full pan map (written by the caller: it is async).
  { name: 'stereo_bands', field: 'bands', get: (r) => encodeBands(r.bands), parse: decodeBands },
  { name: 'spectrum', field: 'spectrumDb', get: (r) => encodeSpectrum(r.spectrumDb), parse: decodeSpectrum },
  text('pan_map', 'panCode'),
];

// Silence (−∞ dB) is written as a blank, like a missing reading: Excel and Google Sheets
// read "-inf" as a formula and save it back as #NAME? (and a chart gets a gap, not a spike).
// Files written before 2026-10-31 have "-inf", which parseNum still reads.
function num(x, digits = 1) {
  if (x === null || x === undefined || !Number.isFinite(x)) return '';
  return x.toFixed(digits);
}

export function csvHeader() {
  return CSV_COLUMNS.map((c) => c.name).join(',') + '\n';
}

export function csvRow(row) {
  return CSV_COLUMNS.map((c) => csvEscape(c.get(row))).join(',') + '\n';
}

function csvEscape(s) {
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// JSON-friendly summary: replaces non-finite numbers, which JSON cannot represent.
export function summaryJson(summary, events = [], meta = {}) {
  const clean = (v) => {
    if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v * 1000) / 1000 : null;
    if (Array.isArray(v)) return v.map(clean);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clean(x)]));
    return v;
  };
  return JSON.stringify(clean({ ...meta, summary, events }), null, 2);
}

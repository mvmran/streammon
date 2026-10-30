// CSV rows and JSON summary for session export.

// Parses one exported cell back: the inverse of num().
export function parseNum(s) {
  if (s === '' || s === undefined) return null;
  if (s === '-inf') return -Infinity;
  if (s === 'inf') return Infinity;
  const x = Number(s);
  return Number.isFinite(x) ? x : null;
}
const parseStr = (s) => (s === undefined || s === '' ? null : s);

import { OCTAVE_CENTRES, OCTAVE_LABELS, THIRD_OCTAVE_LABELS } from './bands.js';

// One list for export and import (session-csv.js): { name, field, get, parse }, and set(row,
// value) for a column that is one entry of an array field.
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
  // Stereo by band (the Stereo by band chart's 1 s readings, live sessions only):
  // correlation, balance (R over L) and level per octave band.
  ...OCTAVE_LABELS.flatMap((name, i) => [
    band(`sb_${name}_corr`, i, 'correlation', 3),
    band(`sb_${name}_bal_db`, i, 'balanceDb', 1),
    band(`sb_${name}_dbfs`, i, 'levelDb', 1),
  ]),
  // The 1/3-octave spectrum averaged over the second (dB, as the spectrum bars).
  ...THIRD_OCTAVE_LABELS.map((name, i) => ({
    name: `spec_${name}_db`,
    field: 'spectrumDb',
    get: (r) => (r.spectrumDb ? num(r.spectrumDb[i]) : ''),
    parse: parseNum,
    set: (r, v) => ((r.spectrumDb ??= new Array(THIRD_OCTAVE_LABELS.length).fill(null))[i] = v),
  })),
];

function band(name, i, key, digits) {
  return {
    name,
    field: 'bands',
    get: (r) => (r.bands && r.bands[i] ? num(r.bands[i][key], digits) : ''),
    parse: parseNum,
    set: (r, v) => {
      r.bands ??= OCTAVE_CENTRES.map((fc) => ({ fc, correlation: null, balanceDb: null, levelDb: null }));
      r.bands[i][key] = v;
    },
  };
}

function num(x, digits = 1) {
  if (x === null || x === undefined || Number.isNaN(x)) return '';
  if (x === -Infinity) return '-inf';
  if (x === Infinity) return 'inf';
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

// CSV rows and JSON summary for session export.

export const CSV_COLUMNS = [
  ['wall_clock', (r) => r.wallClock ?? ''],
  ['elapsed_s', (r) => r.t.toFixed(1)],
  ['momentary_lufs', (r) => num(r.momentary)],
  ['short_term_lufs', (r) => num(r.shortTerm)],
  ['integrated_lufs', (r) => num(r.integrated)],
  ['lra_lu', (r) => num(r.lra)],
  ['sample_peak_dbfs', (r) => num(r.samplePeakDb)],
  ['true_peak_dbtp', (r) => num(r.truePeakDb)],
  ['rms_dbfs', (r) => num(r.rmsDb)],
  ['crest_db', (r) => num(r.crestDb)],
  ['correlation', (r) => num(r.correlation, 4)],
  ['side_mid_db', (r) => num(r.sideMidDb)],
  ['status', (r) => r.status],
  ['detectors', (r) => (r.detectors || []).join('+')],
  ['dwell_runs_per_s', (r) => num(r.dwellRate)],
  ['pileup_ratio', (r) => num(r.pileRatio, 2)],
  ['peaks_pinned', (r) => num(r.pinned, 2)],
  ['ceiling_dbfs', (r) => num(r.ceilingDb)],
  ['fullscale_runs', (r) => String(r.fullScaleRuns ?? 0)],
];

function num(x, digits = 1) {
  if (x === null || x === undefined || Number.isNaN(x)) return '';
  if (x === -Infinity) return '-inf';
  if (x === Infinity) return 'inf';
  return x.toFixed(digits);
}

export function csvHeader() {
  return CSV_COLUMNS.map(([name]) => name).join(',') + '\n';
}

export function csvRow(row) {
  return CSV_COLUMNS.map(([, get]) => csvEscape(get(row))).join(',') + '\n';
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

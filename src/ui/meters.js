// Live meter rendering shared by the web app, the extension side panel and the
// extension dashboard. Every element is looked up by id and optional, so a compact
// layout can include only some of the readouts.

import { ALERT_LABELS } from '../dsp/alerts.js';
import { TimeChart } from './charts.js';
import { StereoBandsView } from './stereo-view.js';
import { fmtDb, fmtDuration, fmtClock, escapeHtml } from './format.js';

const STATUS_ICON = { CLEAN: '✓', LIMITED: '▲', CLIPPING: '✖', IDLE: '' };
// Stereo status word (src/dsp/stereobands.js): icon and badge style.
const STEREO_ICON = { 'STEREO OK': '✓ ', WIDE: '◐ ', UNBALANCED: '▲ ', 'PHASE PROBLEM': '✖ ' };
const STEREO_STYLE = { MONO: 'mono', 'STEREO OK': 'ok', WIDE: 'warn', UNBALANCED: 'warn', 'PHASE PROBLEM': 'crit' };
const CRITICAL_ALERTS = new Set(['clipping', 'truePeak', 'stereoPhase']);

const IDS = {
  statusTile: 'status-tile', status: 'status', statusIcon: 'status-icon', statusDetail: 'status-detail',
  st: 'st', mom: 'mom', stChip: 'st-chip', int: 'int', lra: 'lra', tp: 'tp', tpNow: 'tp-now', tpChip: 'tp-chip',
  tpTile: 'tp-tile', crest: 'crest', peak: 'peak', mono: 'mono', corr: 'corr', sidemid: 'sidemid', stereoDetail: 'stereo-detail',
  dDwell: 'd-dwell', dPile: 'd-pile', dPin: 'd-pin', dCeil: 'd-ceil', dFs: 'd-fs',
};

function setText(node, text) {
  if (node && node.textContent !== text) node.textContent = text;
}

function setChip(node, cls, text) {
  if (!node) return;
  node.hidden = !text;
  if (text) {
    node.className = `chip ${cls}`;
    setText(node, text);
  }
}

export class MetersView {
  // getConfig() returns the current alert configuration (thresholds for the chips).
  constructor(getConfig, doc = document) {
    this.getConfig = getConfig;
    this.el = Object.fromEntries(Object.entries(IDS).map(([k, id]) => [k, doc.getElementById(id)]));
    const sb = doc.getElementById('stereo-bands');
    this.stereoBands = sb ? new StereoBandsView(sb, doc.getElementById('stereo-bands-note')) : null;
  }

  renderStatus(status) {
    const { statusTile, status: label, statusIcon } = this.el;
    if (statusTile && statusTile.dataset.status !== status) {
      statusTile.dataset.status = status;
      setText(label, status);
      setText(statusIcon, STATUS_ICON[status] || '');
    }
  }

  renderFrame(f) {
    const el = this.el;
    const cfg = this.getConfig();
    setText(el.st, fmtDb(f.shortTerm));
    setText(el.mom, fmtDb(f.momentary));
    if (f.shortTerm > cfg.shortTermHigh.lufs) setChip(el.stChip, 'critical', 'too loud');
    else if (f.shortTerm >= -16 && f.shortTerm <= -12) setChip(el.stChip, 'good', 'on target');
    else setChip(el.stChip, '', '');
    setText(el.tp, fmtDb(f.maxTruePeakDb));
    setText(el.tpNow, fmtDb(f.truePeakDb));
    const over = f.maxTruePeakDb > cfg.truePeak.dbtp;
    setChip(el.tpChip, 'warning', over ? '⚠ no headroom' : '');
    if (el.tpTile) el.tpTile.classList.toggle('alerting', over);
    setText(el.crest, fmtDb(f.crestDb));
    setText(el.peak, fmtDb(f.samplePeakDb));
    // Frames from an older offscreen document may lack stereoStatus: fall back to MONO/STEREO.
    const ss = f.stereoStatus !== undefined ? f.stereoStatus : f.correlation === null ? null : f.mono ? 'MONO' : 'STEREO';
    setText(el.mono, ss ? `${STEREO_ICON[ss] || ''}${ss}` : '--');
    if (el.mono) {
      el.mono.dataset.stereo = STEREO_STYLE[ss] || '';
      el.mono.classList.toggle('mono', ss === 'MONO');
      el.mono.classList.toggle('long', !!ss && ss.length > 6); // longer words get a smaller badge
      el.mono.title = f.stereoDetail || '';
    }
    setText(el.stereoDetail, f.stereoDetail || (ss ? '' : 'Too quiet to judge'));
    setText(el.corr, f.correlation === null ? '--' : f.correlation.toFixed(3));
    setText(el.sidemid, f.sideMidDb === null ? '--' : `${fmtDb(f.sideMidDb)} dB`);
    if (this.stereoBands) this.stereoBands.render(f.bands);
    this.renderStatus(f.status);
  }

  renderRow(row) {
    const el = this.el;
    setText(el.int, fmtDb(row.integrated));
    setText(el.lra, fmtDb(row.lra));
    setText(el.dDwell, row.dwellRate.toFixed(1));
    setText(el.dPile, row.pileRatio.toFixed(2));
    setText(el.dPin, `${Math.round(row.pinned * 100)}%`);
    setText(el.dCeil, fmtDb(row.ceilingDb));
    setText(el.dFs, String(row.fullScaleRuns));
    setText(el.statusDetail, statusDetail(row));
  }

  reset(detail) {
    for (const k of ['st', 'mom', 'int', 'lra', 'tp', 'tpNow', 'crest', 'peak', 'mono', 'corr', 'sidemid', 'stereoDetail', 'dDwell', 'dPile', 'dPin', 'dCeil', 'dFs']) setText(this.el[k], '--');
    setChip(this.el.stChip, '', '');
    setChip(this.el.tpChip, '', '');
    if (this.el.tpTile) this.el.tpTile.classList.remove('alerting');
    if (this.el.mono) {
      this.el.mono.classList.remove('mono', 'long');
      this.el.mono.dataset.stereo = '';
    }
    if (this.stereoBands) this.stereoBands.clear();
    this.renderStatus('IDLE');
    setText(this.el.statusDetail, detail);
  }
}

// Clicking (or Enter/Space on) the true-peak or integrated card restarts that
// measurement, e.g. after adjusting a gain. handlers: { isRunning, onResetPeaks,
// onResetIntegrated }. The reading shows "--" until the analyzer reports again.
export function bindMeterResets({ isRunning, onResetPeaks, onResetIntegrated }, doc = document) {
  const cards = [
    [doc.getElementById('tp-tile'), onResetPeaks, ['tp']],
    [doc.getElementById('int-tile'), onResetIntegrated, ['int', 'lra']],
  ];
  for (const [card, reset, ids] of cards) {
    if (!card || !reset) continue;
    card.classList.add('resettable');
    const fire = () => {
      if (!isRunning()) return;
      reset();
      for (const id of ids) setText(doc.getElementById(id), '--');
      card.classList.remove('was-reset');
      void card.offsetWidth; // restart the confirmation flash
      card.classList.add('was-reset');
    };
    card.addEventListener('click', fire);
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        fire();
      }
    });
  }
}

export function statusDetail(row) {
  if (row.status === 'CLIPPING') {
    return row.detectors.includes('fullscale')
      ? `Hitting digital full scale (${row.fullScaleSamples} samples this second)`
      : `Flat tops at ${fmtDb(row.ceilingDb)} dBFS · ${row.dwellRate.toFixed(0)} plateaus/s`;
  }
  if (row.status === 'LIMITED') return `Peaks held at ${fmtDb(row.ceilingDb)} dBFS by a limiter · not clipping`;
  return 'No flat-topping detected';
}

// Alert banners. `active` is AlertMonitor.active; dismissed ids are skipped.
export function renderAlertBanners(container, active, { dismissed, startWall, onDismiss }) {
  container.textContent = '';
  for (const [id, a] of Object.entries(active)) {
    if (dismissed.has(id)) continue;
    const div = document.createElement('div');
    div.className = `alert ${CRITICAL_ALERTS.has(id) ? '' : 'warning'}`;
    div.innerHTML = `<span class="icon" aria-hidden="true">${id === 'clipping' || id === 'stereoPhase' ? '✖' : '⚠'}</span><span>${escapeHtml(ALERT_LABELS[id])}: ${escapeHtml(a.message)}</span><span class="since">since ${fmtClock(new Date(startWall + a.since * 1000))}</span><button type="button" title="Dismiss until it happens again" aria-label="Dismiss">×</button>`;
    div.querySelector('button').addEventListener('click', () => onDismiss(id));
    container.append(div);
  }
}

const ceilingRef = (rows) => {
  const last = rows[rows.length - 1];
  if (!last || !Number.isFinite(last.ceilingDb) || last.ceilingDb < -40) return [];
  const clipping = last.status === 'CLIPPING';
  return [{ y: last.ceilingDb, label: `${clipping ? 'clip ceiling' : 'peak ceiling'} ${fmtDb(last.ceilingDb)} dBFS`, colour: clipping ? '--critical' : undefined, dash: [6, 3] }];
};

// Chart x labels: wall clock for live sessions, file position otherwise.
export function timeFormatter(getState) {
  return (t, row) => {
    const { mode, startWall } = getState();
    if (mode === 'file') return row ? `File ${fmtDuration(t)}` : fmtDuration(t);
    if (row) return row.clock ? `${row.clock} · ${fmtDuration(t)}` : fmtDuration(t);
    return new Date(startWall + t * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  };
}

// The full version also draws the stereo correlation, on its own scale on the right over
// the bottom half of the plot (−1…+1 between −40 and −20 LUFS), below where loudness
// normally runs; its labels (+1, 0, −1) land on the −20, −30 and −40 LUFS gridlines.
export function createHistoryChart(canvas, xFormat, { compact = false } = {}) {
  const series = [{ key: 'shortTerm', label: 'Short-term LUFS', colour: '--series-1' }];
  if (!compact) series.push({ key: 'correlation', label: 'Correlation (right scale)', colour: '--series-2', axis: 'right', format: (v) => v.toFixed(2) });
  return new TimeChart(canvas, {
    yMin: -40, yMax: 0, yStep: 10, unit: compact ? 'LUFS' : 'LUFS / dBFS',
    right: compact ? null : { min: -1, max: 1, step: 1, unit: 'correlation', span: [0, 0.5] },
    series,
    band: { from: -16, to: -12, label: compact ? 'target' : 'target −16 to −12 LUFS' },
    refs: (c) => [{ y: -10, label: '−10 LUFS', colour: '--serious' }, ...ceilingRef(c.rows)],
    statusStrip: true,
    xFormat,
  });
}

export function createPeakChart(canvas, xFormat, getConfig) {
  return new TimeChart(canvas, {
    yMin: -30, yMax: 3, yStep: 6, unit: 'dBFS',
    series: [
      { key: 'samplePeakDb', label: 'Sample peak', colour: '--series-1' },
      { key: 'truePeakDb', label: 'True peak', colour: '--series-2' },
    ],
    refs: (c) => {
      const lim = getConfig().truePeak.dbtp;
      return [{ y: lim, label: `${fmtDb(lim)} dBTP limit`, colour: '--serious' }, ...ceilingRef(c.rows)];
    },
    statusStrip: true,
    xFormat,
  });
}

// Shows the last `range` seconds of rows on each chart.
export function showRecent(charts, rows, range) {
  const end = rows.length ? rows[rows.length - 1].t : 0;
  const start = Math.max(rows.length ? rows[0].t - 1 : 0, end - range);
  const xEnd = Math.max(end, start + range);
  for (const c of charts) c.setData(rows, start, xEnd);
}

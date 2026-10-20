// Stream Audio Monitor: main page controller.

import { AudioEngine, analyseBuffer } from '../audio/engine.js';
import { listInputDevices, devicesHaveLabels, openInputDevice, openTabCapture, streamSampleRate, decodeFile } from '../audio/sources.js';
import { AlertMonitor, ALERT_LABELS } from '../dsp/alerts.js';
import { summaryJson } from '../dsp/report.js';
import { TimeChart } from './charts.js';
import { SpectrumView } from './spectrum.js';
import { EventLog } from './log.js';
import { SessionRecorder } from './session.js';
import { setupSettings } from './settings.js';
import { setupHelp } from './help.js';
import { MetersView, renderAlertBanners, createHistoryChart, createPeakChart, showRecent, timeFormatter, bindMeterResets } from './meters.js';
import { fmtDb, fmtDuration, fmtClock, fmtStamp, fileStamp, download } from './format.js';

const $ = (id) => document.getElementById(id);
const HISTORY_MAX = 3600; // seconds of rows kept for the charts
const UI_FPS = 10;

const el = {
  source: $('source'), device: $('device'), deviceField: $('device-field'), start: $('start'), stop: $('stop'),
  wallclock: $('wallclock'), elapsed: $('elapsed'), tabReminder: $('tab-reminder'), error: $('error'),
  alerts: $('alerts'), filePanel: $('file-panel'), dropzone: $('dropzone'), fileInput: $('file-input'),
  fileProgress: $('file-progress'), fileResult: $('file-result'), fileName: $('file-name'), fileSummary: $('file-summary'),
  play: $('play'), playPos: $('play-pos'), exportCsv: $('export-csv'), exportJson: $('export-json'),
  recordDisk: $('record-disk'), clearLog: $('clear-log'), dRate: $('d-rate'),
};

const state = {
  mode: 'device',
  running: false, // a live source is being monitored
  startWall: 0, // Date.now() at session start
  sessionLabel: '',
  history: [], // recent 1 s rows for the charts
  lastFrame: null,
  lastRow: null,
  historyRange: 300,
  alertCfg: null,
  alerts: null,
  dismissed: new Set(),
  summary: null,
  exported: true,
  // File mode
  file: null, // { name, buffer, rows, events, summary }
  playing: false,
  playOffset: 0, // file position the current playback (worklet) started from
  pausedAt: 0,
};

// ---------------------------------------------------------------------------
// Engine and views

const engine = new AudioEngine({
  onFrame: (f) => (state.lastFrame = f),
  onSecond: onRow,
  onEvent: onEvent,
  onEnded: (why) => {
    if (state.mode === 'file') {
      state.playing = false;
      state.pausedAt = 0;
      el.play.textContent = 'Play';
    } else if (state.running) {
      stopLive();
      showError(`${why}. Monitoring stopped.`);
    }
  },
});

state.alertCfg = setupSettings($('settings'), $('settings-btn'), (cfg) => {
  state.alertCfg = cfg;
  state.alerts = new AlertMonitor(cfg);
  renderAlerts();
});
state.alerts = new AlertMonitor(state.alertCfg);

const log = new EventLog($('log-body'), $('log-empty'), { onSeek: (t) => state.mode === 'file' && playFrom(t) });
const recorder = new SessionRecorder();
const spectrum = new SpectrumView({ bands: $('bands'), sgram: $('sgram'), balance: $('balance') });

const meters = new MetersView(() => state.alertCfg);
const xFormat = timeFormatter(() => state);
const historyChart = createHistoryChart($('history'), xFormat);
const peakChart = createPeakChart($('peaks'), xFormat, () => state.alertCfg);

let timeline = null; // created when the file panel is first shown (it needs a laid-out width)

// ---------------------------------------------------------------------------
// Data from the analyzer

function onRow(row) {
  if (state.mode === 'file') {
    row.t += state.playOffset;
  } else {
    const wall = new Date(state.startWall + row.t * 1000);
    row.wallClock = fmtStamp(wall);
    row.clock = fmtClock(wall);
    recorder.add(row);
    state.exported = false;
    el.exportCsv.disabled = el.exportJson.disabled = false;
    checkAlerts(row);
  }
  state.lastRow = row;
  state.history.push(row);
  if (state.history.length > HISTORY_MAX) state.history.shift();
  meters.renderRow(row);
  redrawCharts();
}

function onEvent(e) {
  if (state.mode === 'file') return; // file events come from the full analysis
  const clock = fmtClock(new Date(state.startWall + e.t * 1000));
  log.add(EventLog.fromEvent(e, clock));
}

function checkAlerts(row) {
  const { raised, cleared } = state.alerts.update(row);
  for (const a of raised) {
    state.dismissed.delete(a.id);
    log.add({ clock: row.clock, t: row.t, kind: 'alert', title: `Alert: ${ALERT_LABELS[a.id]}`, detail: a.message });
    if (state.alertCfg.sound) engine.beep();
  }
  for (const id of cleared) state.dismissed.delete(id);
  if (raised.length || cleared.length || Object.keys(state.alerts.active).length) renderAlerts();
}

function renderAlerts() {
  renderAlertBanners(el.alerts, state.alerts.active, {
    dismissed: state.dismissed,
    startWall: state.startWall,
    onDismiss: (id) => {
      state.dismissed.add(id);
      renderAlerts();
    },
  });
}

// ---------------------------------------------------------------------------
// Rendering

function setText(node, text) {
  if (node.textContent !== text) node.textContent = text;
}

function renderFrame(f) {
  meters.renderFrame(f);
  const t = state.mode === 'file' ? f.t + state.playOffset : f.t;
  setText(el.elapsed, `${state.mode === 'file' ? 'position' : 'elapsed'} ${fmtDuration(t)}`);
}

function resetReadouts() {
  meters.reset(state.mode === 'file' ? 'Play the file to see live meters' : 'Start a source to begin');
}

function redrawCharts() {
  showRecent([historyChart, peakChart], state.history, state.historyRange);
}

let lastTick = performance.now();
function tick(now) {
  requestAnimationFrame(tick);
  if (now - lastTick < 1000 / UI_FPS - 2) return;
  const dt = (now - lastTick) / 1000;
  lastTick = now;
  if (state.lastFrame) {
    renderFrame(state.lastFrame);
    state.lastFrame = null;
  }
  const active = state.running || state.playing;
  if (active && engine.analyser) spectrum.update(engine.analyser, engine.ctx.sampleRate, dt);
  if (state.playing && timeline) {
    const pos = engine.position;
    if (pos !== null) {
      timeline.setCursor(pos);
      setText(el.playPos, fmtDuration(pos));
    }
  }
}
requestAnimationFrame(tick);

setInterval(() => setText(el.wallclock, fmtClock(new Date())), 250);

// ---------------------------------------------------------------------------
// Source selection and live sessions

function showError(msg) {
  el.error.hidden = !msg;
  el.error.textContent = msg || '';
}

function describeError(e) {
  if (e && e.name === 'NotAllowedError') return 'Permission denied. Allow microphone / screen sharing for this page and try again.';
  if (e && e.name === 'NotFoundError') return 'No audio input device found.';
  if (e && e.name === 'NotReadableError') return 'The device could not be opened. Another application may be holding it exclusively (on Windows, untick "Allow applications to take exclusive control" in the device\'s Sound properties).';
  if (e && e.name === 'OverconstrainedError') return 'The selected device is no longer available. Pick another one.';
  return (e && e.message) || String(e);
}

async function refreshDevices(preferId) {
  let devices = [];
  try {
    devices = await listInputDevices();
  } catch {
    return;
  }
  const keep = preferId || el.device.value;
  el.device.textContent = '';
  const add = (value, label) => el.device.append(new Option(label, value));
  if (!devicesHaveLabels(devices)) {
    add('', 'Default input (press Start to list devices)');
  } else {
    devices.forEach((d, i) => add(d.deviceId, d.label || `Input ${i + 1}`));
  }
  const ids = [...el.device.options].map((o) => o.value);
  if (keep && ids.includes(keep)) el.device.value = keep;
  else {
    // Prefer the ATEM Mini's USB audio when it is present.
    const bmd = devices.find((d) => /blackmagic|atem/i.test(d.label));
    if (bmd) el.device.value = bmd.deviceId;
  }
}

function setMode(mode) {
  state.mode = mode;
  el.deviceField.hidden = mode !== 'device';
  el.tabReminder.hidden = mode !== 'tab';
  el.filePanel.hidden = mode !== 'file';
  el.start.hidden = mode === 'file';
  el.stop.hidden = mode === 'file';
  document.querySelectorAll('.seg button').forEach((b) => (b.disabled = false));
  if (mode === 'file' && !timeline) createTimeline();
  showError('');
}

async function startLive() {
  if (!state.exported && recorder.count > 60 && !confirm('Start a new session? The current session will be cleared, so export it first if you need it.')) return;
  showError('');
  el.start.disabled = true;
  try {
    let stream;
    if (state.mode === 'device') {
      stream = await openInputDevice(el.device.value);
      const track = stream.getAudioTracks()[0];
      await refreshDevices(track.getSettings().deviceId);
      state.sessionLabel = track.label || 'Audio input';
    } else {
      stream = await openTabCapture();
      state.sessionLabel = stream.getAudioTracks()[0].label || 'Browser tab';
    }
    beginSession();
    await engine.startStream(stream, streamSampleRate(stream));
    state.running = true;
    setText(el.dRate, `${engine.ctx.sampleRate} Hz`);
    el.stop.disabled = false;
    el.source.disabled = el.device.disabled = true;
  } catch (e) {
    await engine.close();
    showError(describeError(e));
    el.start.disabled = false;
  }
}

function beginSession() {
  state.startWall = Date.now();
  state.history = [];
  state.lastRow = null;
  state.summary = null;
  state.exported = true;
  state.dismissed.clear();
  state.alerts = new AlertMonitor(state.alertCfg);
  recorder.clear();
  log.clear();
  spectrum.clear();
  renderAlerts();
  resetReadouts();
  redrawCharts();
  el.exportCsv.disabled = el.exportJson.disabled = true;
}

async function stopLive() {
  if (!state.running) return;
  state.running = false;
  state.summary = await engine.finish();
  await engine.close();
  await recorder.stopDisk();
  updateRecordButton();
  el.start.disabled = false;
  el.stop.disabled = true;
  el.source.disabled = el.device.disabled = false;
  setText(el.elapsed, `stopped after ${fmtDuration(state.lastRow ? state.lastRow.t : 0)}`);
  meters.renderStatus('IDLE');
}

// ---------------------------------------------------------------------------
// File mode

function createTimeline() {
  el.fileResult.hidden = false; // must be laid out for the chart to measure itself
  timeline = new TimeChart($('timeline'), {
    yMin: -40, yMax: 3, yStep: 10, unit: 'dB',
    series: [
      { key: 'shortTerm', label: 'Short-term LUFS', colour: '--series-1' },
      { key: 'samplePeakDb', label: 'Peak dBFS (per second)', colour: '--series-2' },
    ],
    band: { from: -16, to: -12, label: 'target' },
    refs: () => [{ y: -10, label: '−10 LUFS', colour: '--serious' }],
    statusStrip: true,
    xFormat: (t, row) => (row ? `File ${fmtDuration(t)}` : fmtDuration(t)),
    onClick: (t) => playFrom(t),
  });
  el.fileResult.hidden = true;
}

async function handleFile(file) {
  if (!file) return;
  if (state.running) await stopLive();
  await engine.close();
  state.playing = false;
  state.file = null;
  showError('');
  el.fileResult.hidden = true;
  el.fileProgress.hidden = false;
  const bar = el.fileProgress.querySelector('.bar');
  const label = el.fileProgress.querySelector('.label');
  bar.style.width = '0';
  label.textContent = `Decoding ${file.name}…`;
  try {
    const buffer = await decodeFile(file);
    label.textContent = 'Analysing…';
    const t0 = performance.now();
    const result = await analyseBuffer(buffer, {
      onProgress: (p) => {
        bar.style.width = `${Math.round(p * 100)}%`;
        label.textContent = `Analysing… ${Math.round(p * 100)}%`;
      },
    });
    const secs = (performance.now() - t0) / 1000;
    state.file = { name: file.name, buffer, ...result };
    showFileResult(secs);
  } catch (e) {
    showError(`Could not read ${file.name}: ${describeError(e)}`);
  } finally {
    el.fileProgress.hidden = true;
  }
}

function showFileResult(analysisSecs) {
  const f = state.file;
  const s = f.summary;
  beginSession();
  state.summary = s;
  el.fileResult.hidden = false;
  setText(el.fileName, f.name);
  const speed = analysisSecs > 0 ? Math.round(s.duration / analysisSecs) : 0;
  const statusSecs = s.statusSeconds;
  el.fileSummary.innerHTML = [
    ['Status', `<span class="ev ev-${s.overallStatus}">${s.overallStatus}</span>`],
    ['Duration', fmtDuration(s.duration)],
    ['Integrated', `${fmtDb(s.integrated)} LUFS`],
    ['LRA', `${fmtDb(s.lra)} LU`],
    ['True peak', `${fmtDb(s.truePeakDb, 2)} dBTP`],
    ['Sample peak', `${fmtDb(s.samplePeakDb, 2)} dBFS`],
    ['Crest', `${fmtDb(s.crestDb)} dB`],
    ['Clipping', `${statusSecs.CLIPPING} s`],
    ['Limited', `${statusSecs.LIMITED} s`],
    ['Stereo', s.mono ? 'MONO' : `corr ${s.correlation === null ? '--' : s.correlation.toFixed(3)}`],
    ['Rate', `${s.sampleRate} Hz`],
    ['Analysed', speed ? `${speed}× real time` : ''],
  ].map(([k, v]) => `<span>${k} <b>${v}</b></span>`).join('');
  setText(el.dRate, `${s.sampleRate} Hz`);

  timeline.setData(f.rows, 0, s.duration);
  timeline.setCursor(null);
  // Log: status episodes and the alerts the rules would have raised.
  const monitor = new AlertMonitor(state.alertCfg);
  const entries = f.events.map((e) => EventLog.fromEvent(e, 'file', true));
  for (const row of f.rows) {
    recorder.add(row);
    for (const a of monitor.update(row).raised) {
      entries.push({ clock: 'file', t: row.t, kind: 'alert', title: `Alert: ${ALERT_LABELS[a.id]}`, detail: a.message, seekable: true });
    }
  }
  entries.sort((a, b) => a.t - b.t).forEach((e) => log.add(e));
  el.exportCsv.disabled = el.exportJson.disabled = false;
  state.pausedAt = 0;
  setText(el.playPos, '0:00');
}

async function playFrom(t) {
  const f = state.file;
  if (!f) return;
  t = Math.max(0, Math.min(t, f.buffer.duration - 0.05));
  state.playOffset = t;
  state.history = [];
  state.lastFrame = null;
  spectrum.clear();
  resetReadouts();
  redrawCharts();
  await engine.startFile(f.buffer, t);
  state.playing = true;
  el.play.textContent = 'Pause';
}

function togglePlay() {
  if (!state.file) return;
  if (state.playing) {
    state.pausedAt = engine.position || 0;
    engine.stopSource();
    state.playing = false;
    el.play.textContent = 'Play';
  } else {
    playFrom(state.pausedAt);
  }
}

// ---------------------------------------------------------------------------
// Export

function exportName(ext) {
  const base = state.mode === 'file' && state.file ? state.file.name.replace(/\.[^.]+$/, '') : `stream-${fileStamp(new Date(state.startWall))}`;
  return `${base}.${ext}`;
}

async function exportJson() {
  const summary = state.running ? await engine.summary() : state.summary;
  const meta = {
    tool: 'Stream Audio Monitor',
    exportedAt: new Date().toISOString(),
    source: state.mode === 'file' ? { type: 'file', name: state.file && state.file.name } : { type: state.mode, label: state.sessionLabel, startedAt: new Date(state.startWall).toISOString() },
    alertConfig: state.alertCfg,
  };
  download(exportName('json'), summaryJson(summary, log.entries, meta), 'application/json');
  state.exported = true;
}

async function toggleDiskRecording() {
  try {
    if (recorder.writer) await recorder.stopDisk();
    else await recorder.startDisk(exportName('csv'));
  } catch (e) {
    if (e.name !== 'AbortError') showError(`Could not write the CSV file: ${describeError(e)}`);
  }
  updateRecordButton();
}

function updateRecordButton() {
  const on = !!recorder.writer;
  el.recordDisk.classList.toggle('recording', on);
  el.recordDisk.textContent = on ? `Recording to ${recorder.fileName}` : 'Record CSV to disk…';
  if (on) state.exported = true;
}

// ---------------------------------------------------------------------------
// Wiring

el.source.addEventListener('change', async () => {
  if (state.playing || state.file) await engine.close();
  state.playing = false;
  setMode(el.source.value);
  resetReadouts();
});
el.start.addEventListener('click', startLive);
el.stop.addEventListener('click', stopLive);
el.play.addEventListener('click', togglePlay);
el.fileInput.addEventListener('change', () => handleFile(el.fileInput.files[0]));
el.dropzone.addEventListener('dragover', (e) => {
  e.preventDefault();
  el.dropzone.classList.add('over');
});
el.dropzone.addEventListener('dragleave', () => el.dropzone.classList.remove('over'));
el.dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  el.dropzone.classList.remove('over');
  handleFile(e.dataTransfer.files[0]);
});
// Dropping anywhere on the page in file mode loads the file rather than navigating away.
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  if (state.mode === 'file' && e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
});
document.querySelectorAll('.seg button').forEach((b) =>
  b.addEventListener('click', () => {
    document.querySelectorAll('.seg button').forEach((x) => x.classList.toggle('on', x === b));
    state.historyRange = Number(b.dataset.range);
    redrawCharts();
  }),
);
el.exportCsv.addEventListener('click', () => {
  download(exportName('csv'), recorder.csv(), 'text/csv');
  state.exported = true;
});
el.exportJson.addEventListener('click', exportJson);
el.clearLog.addEventListener('click', () => log.clear());
el.recordDisk.addEventListener('click', toggleDiskRecording);
if (!SessionRecorder.diskSupported) {
  el.recordDisk.disabled = true;
  el.recordDisk.title = 'Needs Chrome or Edge (File System Access API)';
}
window.addEventListener('beforeunload', (e) => {
  if (state.running && !state.exported) e.preventDefault();
});

if (!window.isSecureContext || !navigator.mediaDevices) {
  $('secure-warning').hidden = false;
} else {
  navigator.mediaDevices.addEventListener('devicechange', () => refreshDevices());
  refreshDevices();
}
function logReset(title) {
  const t = state.lastRow ? state.lastRow.t : 0;
  log.add({ clock: state.mode === 'file' ? 'file' : fmtClock(new Date()), t, kind: 'info', title, detail: 'measuring again from here' });
}
bindMeterResets({
  isRunning: () => state.running || state.playing,
  onResetPeaks: () => {
    engine.resetPeaks();
    logReset('True peak max reset');
  },
  onResetIntegrated: () => {
    engine.resetIntegrated();
    logReset('Integrated loudness reset');
  },
});

setMode(el.source.value);
resetReadouts();
setupHelp();

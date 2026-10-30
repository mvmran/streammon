// Stream Audio Monitor: main page controller.

import { AudioEngine, analyseBuffer } from '../audio/engine.js';
import { listInputDevices, devicesHaveLabels, openInputDevice, openTabCapture, streamSampleRate, decodeFile } from '../audio/sources.js';
import { AlertMonitor, ALERT_LABELS, humOptionsFrom } from '../dsp/alerts.js';
import { isolateHum } from '../dsp/hum-isolate.js';
import { summaryJson, csvHeader, csvRow } from '../dsp/report.js';
import { readSessionCsv, sessionEvents, sessionSummary, rowAt, stepRows } from '../dsp/session-csv.js';
import { SpectrumSecond } from '../dsp/bands.js';
import { PanGrid } from '../dsp/pan.js';
import { encodePan, decodePan } from '../dsp/csv-codec.js';
import { TimeChart } from './charts.js';
import { SpectrumView } from './spectrum.js';
import { PanMapView } from './pan-map.js';
import { EventLog } from './log.js';
import { SessionRecorder } from './session.js';
import { setupSettings } from './settings.js';
import { setupHelp } from './help.js';
import { MetersView, renderAlertBanners, createHistoryChart, createPeakChart, showRecent, timeFormatter, bindMeterResets } from './meters.js';
import { HumView } from './hum-view.js';
import { fmtDb, fmtDuration, fmtClock, fmtStamp, fileStamp, download } from './format.js';

const $ = (id) => document.getElementById(id);
const HISTORY_MAX = 3600; // seconds of rows kept for the charts
const UI_FPS = 10;

const el = {
  source: $('source'), device: $('device'), deviceField: $('device-field'), start: $('start'), stop: $('stop'), reset: $('reset'),
  wallclock: $('wallclock'), elapsed: $('elapsed'), tabReminder: $('tab-reminder'), error: $('error'),
  alerts: $('alerts'), filePanel: $('file-panel'), dropzone: $('dropzone'), fileInput: $('file-input'),
  fileProgress: $('file-progress'), fileResult: $('file-result'), fileName: $('file-name'), fileSummary: $('file-summary'), fileHint: $('file-hint'), scrubKeys: $('scrub-keys'),
  play: $('play'), playPos: $('play-pos'), exportCsv: $('export-csv'), exportJson: $('export-json'),
  recordDisk: $('record-disk'), clearLog: $('clear-log'), dRate: $('d-rate'),
  humListen: $('hum-listen'), humGain: $('hum-gain'), humListenHum: $('hum-listen-hum'), humListenCtl: $('hum-listen-ctl'),
  humListenNote: $('hum-listen-note'),
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
  onFrame: (f) => {
    if (!(state.running || state.playing)) return; // not after Stop
    state.lastFrame = f;
    ingestSpectrum(f);
  },
  onSecond: onRow,
  onEvent: onEvent,
  onHum: (h) => {
    if (state.mode === 'file') h.t += state.playOffset;
    humView.render(h);
  },
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
  const mainsChanged = cfg.hum.mainsFrequencyHz !== state.alertCfg.hum.mainsFrequencyHz;
  const humChanged = JSON.stringify(humOptionsFrom(cfg)) !== JSON.stringify(humOptionsFrom(state.alertCfg));
  state.alertCfg = cfg;
  // Keep the running alert state (active banners, counters); only the thresholds change.
  state.alerts.config = cfg;
  // Re-applying hum settings restarts the hum measurement, so only when they changed.
  if (humChanged) engine.setHumOptions(humOptionsFrom(cfg));
  humView.renderMains();
  spectrum.setSpectrogramFloor(cfg.display.spectrogramFloorDb);
  redrawCharts(); // the peak chart's true-peak limit line
  renderAlerts();
  // A loaded file was analysed with the old mains frequency: analyse it again. A CSV's log
  // is rebuilt with the new hum alert level, on the same moment.
  if (state.mode === 'file' && state.file && state.file.csv) {
    const at = state.lastRow;
    state.file.events = csvEvents(state.file);
    showFileResult(0, at);
  } else if (mainsChanged && state.mode === 'file' && state.file) handleFile(state.file.source);
});
state.alerts = new AlertMonitor(state.alertCfg);
engine.setHumOptions(humOptionsFrom(state.alertCfg));

const log = new EventLog($('log-body'), $('log-empty'), { onSeek: (t) => state.mode === 'file' && seekFile(t, true) });
const recorder = new SessionRecorder();
recorder.onDiskError = (e, name) => {
  updateRecordButton();
  showError(`Recording to ${name} stopped: ${describeError(e)}. The session is still kept here; export it with CSV.`);
};
const spectrum = new SpectrumView({ bands: $('bands'), sgram: $('sgram'), balance: $('balance') });
spectrum.setSpectrogramFloor(state.alertCfg.display.spectrogramFloorDb);
const panMap = new PanMapView($('pan-map'));
let panL = null, panR = null; // reused spectrum buffers
const panGrid = new PanGrid(); // the pan map's data: drawn live, and each second's for the CSV
const spectrumSecond = new SpectrumSecond(); // each second's 1/3-octave spectrum, for the CSV

const meters = new MetersView(() => state.alertCfg);
const xFormat = timeFormatter(() => state);
const historyChart = createHistoryChart($('history'), xFormat);
const peakChart = createPeakChart($('peaks'), xFormat, () => state.alertCfg);
const humView = new HumView(() => state.alertCfg);

let timeline = null; // created when the file panel is first shown (it needs a laid-out width)

// ---------------------------------------------------------------------------
// Data from the analyzer

function onRow(row) {
  const spectrumDb = spectrumSecond.take();
  const panSecond = panGrid.takeSecond();
  if (state.mode === 'file') {
    row.t += state.playOffset;
  } else {
    row.spectrumDb = spectrumDb;
    const wall = new Date(state.startWall + row.t * 1000);
    row.wallClock = fmtStamp(wall);
    row.clock = fmtClock(wall);
    // The pan map is compressed asynchronously; the row goes into the CSV once it is.
    const full = row; // `row` becomes the trimmed copy below
    recorder.addLater(full, encodePan(panSecond).then((code) => (full.panCode = code)));
    // The charts and meters never use the per-band and spectrum data: keep it out of
    // their 3600-row history.
    const { bands, spectrumDb: _, ...rest } = row;
    row = rest;
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

// An analyzer frame's time on the timeline: the file position in file mode (the worklet
// restarts at 0 on each seek), elapsed time otherwise.
const frameTime = (f) => (state.mode === 'file' ? f.t + state.playOffset : f.t);

function renderFrame(f) {
  meters.renderFrame(f);
  setText(el.elapsed, `${state.mode === 'file' ? 'position' : 'elapsed'} ${fmtDuration(frameTime(f))}`);
}

function resetReadouts() {
  meters.reset(state.mode === 'file' ? 'Press Play to see the meters' : 'Start a source to begin');
}

function redrawCharts() {
  showRecent([historyChart, peakChart], state.history, state.historyRange);
}

// Spectrum, spectrogram and pan map data: read once per 100 ms analyzer frame, so the
// spectrogram keeps filling (on the audio clock) while the page is hidden and animation
// frames stop; the drawing happens in tick().
function ingestSpectrum(f) {
  if (!engine.ctx || !engine.analyser) return;
  const sr = engine.ctx.sampleRate;
  const t = frameTime(f);
  spectrum.update(engine.analyser, sr, t, engine.analyserFine);
  spectrumSecond.add(spectrum.levels);
  const n = engine.analyserL.frequencyBinCount;
  if (!panL || panL.length !== n) [panL, panR] = [new Float32Array(n), new Float32Array(n)];
  engine.analyserL.getFloatFrequencyData(panL);
  engine.analyserR.getFloatFrequencyData(panR);
  panGrid.update(panL, panR, sr, t);
  panMap.setGrid(panGrid.grid);
}

let lastTick = performance.now();
function tick(now) {
  requestAnimationFrame(tick);
  if (now - lastTick < 1000 / UI_FPS - 2) return;
  lastTick = now;
  if (state.lastFrame) {
    renderFrame(state.lastFrame);
    state.lastFrame = null;
  }
  spectrum.render();
  panMap.render();
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
  if (mode !== 'file') cancelFileAnalysis();
  state.mode = mode;
  el.deviceField.hidden = mode !== 'device';
  el.tabReminder.hidden = mode !== 'tab';
  el.filePanel.hidden = mode !== 'file';
  el.humListen.hidden = !(mode === 'file' && state.file && !state.file.csv);
  el.start.hidden = mode === 'file';
  el.stop.hidden = el.reset.hidden = mode === 'file';
  document.querySelectorAll('.seg button').forEach((b) => (b.disabled = false));
  if (mode === 'file' && !timeline) createTimeline();
  showError('');
}

async function startLive() {
  if (!state.exported && recorder.count > 60 && !confirm('Start a new session? The current session will be cleared, so export it first if you need it.')) return;
  cancelFileAnalysis();
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
    el.stop.disabled = el.reset.disabled = false;
    el.source.disabled = el.device.disabled = true;
  } catch (e) {
    await engine.close();
    showError(describeError(e));
    el.start.disabled = false;
  }
}

// Unexported data older than this makes Reset ask first.
const RESET_CONFIRM_SECONDS = 600;

function beginSession() {
  spectrumSecond.reset();
  state.startWall = Date.now();
  state.history = [];
  state.lastRow = null;
  state.summary = null;
  state.exported = true;
  state.lastFrame = null;
  state.dismissed.clear();
  state.alerts = new AlertMonitor(state.alertCfg);
  recorder.clear();
  log.clear();
  spectrum.clear();
  panMap.clear();
  panGrid.reset();
  humView.reset();
  renderAlerts();
  resetReadouts();
  redrawCharts();
  el.exportCsv.disabled = el.exportJson.disabled = true;
}

// Clears the board (e.g. for a new song): a fresh session on the same source. A CSV being
// recorded to disk is closed, so the file holds what came before the reset.
async function resetLive() {
  if (!state.running) return;
  const secs = state.lastRow ? state.lastRow.t : 0;
  if (secs > RESET_CONFIRM_SECONDS && !confirm(`Reset and clear the last ${Math.round(secs / 60)} minutes of readings, event log and CSV data? Export first if you need them.`)) return;
  el.reset.disabled = true;
  try {
    const recording = recorder.recording ? recorder.fileName : null;
    if (recording) {
      await recorder.stopDisk();
      updateRecordButton();
    }
    await engine.reset();
    if (state.running) {
      beginSession();
      const detail = recording ? `everything cleared; recording to ${recording} stopped` : 'everything cleared; measuring afresh from here';
      log.add({ clock: fmtClock(new Date()), t: 0, kind: 'info', title: 'Reset', detail });
    }
  } catch (e) {
    showError(`Reset failed: ${describeError(e)}. Reload the page and try again.`);
  } finally {
    el.reset.disabled = !state.running;
  }
}

async function stopLive() {
  if (!state.running) return;
  state.running = false;
  try {
    state.summary = await engine.finish();
    await engine.close();
  } catch (e) {
    showError(`Stopping failed: ${describeError(e)}`);
  }
  try {
    await recorder.stopDisk();
  } catch (e) {
    showError(`Could not finish the CSV file on disk: ${describeError(e)}. Export the session with CSV instead.`);
  }
  updateRecordButton();
  state.lastFrame = null; // a frame that arrived while stopping must not repaint the status
  el.start.disabled = false;
  el.stop.disabled = el.reset.disabled = true;
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
    xFormat,
    onClick: (t) => seekFile(t),
    // A saved CSV: dragging along the timeline updates the readings as it goes.
    onScrub: (t) => showMoment(timeline.nearest(t)),
    canScrub: () => !!(state.mode === 'file' && state.file && state.file.csv),
  });
  el.fileResult.hidden = true;
}

// The file being decoded and analysed, if any: an AbortController. A newer file, a live
// start or leaving File mode cancels it, so its result can't replace a later session.
let fileJob = null;

function cancelFileAnalysis() {
  if (!fileJob) return;
  fileJob.abort();
  fileJob = null;
  el.fileProgress.hidden = true;
}

const isCsv = (file) => /\.csv$/i.test(file.name) || file.type === 'text/csv';

async function handleFile(file) {
  if (!file) return;
  if (isCsv(file)) return openCsv(file);
  cancelFileAnalysis();
  const job = (fileJob = new AbortController());
  if (state.running) await stopLive();
  state.playing = false;
  await engine.close();
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
    if (job.signal.aborted) return;
    label.textContent = 'Analysing…';
    const t0 = performance.now();
    const result = await analyseBuffer(buffer, {
      signal: job.signal,
      humOptions: humOptionsFrom(state.alertCfg),
      onProgress: (p) => {
        bar.style.width = `${Math.round(p * 100)}%`;
        label.textContent = `Analysing… ${Math.round(p * 100)}%`;
      },
    });
    const secs = (performance.now() - t0) / 1000;
    state.file = { name: file.name, source: file, buffer, ...result };
    showFileResult(secs);
  } catch (e) {
    if (!job.signal.aborted) showError(`Could not read ${file.name}: ${describeError(e)}`);
  } finally {
    if (fileJob === job) {
      fileJob = null;
      el.fileProgress.hidden = true;
    }
  }
}

// A CSV saved by this app: the session's rows, the log rebuilt from them with the
// current settings, and its totals. No audio, so clicks show a moment instead of playing.
async function openCsv(file) {
  cancelFileAnalysis();
  const job = (fileJob = new AbortController()); // a live start or another file cancels it
  if (state.running) await stopLive();
  state.playing = false;
  await engine.close();
  state.file = null;
  showError('');
  el.fileResult.hidden = true;
  try {
    const text = await file.text();
    if (job.signal.aborted) return;
    const { rows, startWall, fileAnalysis } = readSessionCsv(text);
    state.file = { name: file.name, source: file, csv: true, rows, startWall, fileAnalysis, summary: sessionSummary(rows) };
    state.file.events = csvEvents(state.file);
    showFileResult(0);
    if (document.activeElement === el.source) el.source.blur(); // so ← → step, not switch the source
  } catch (e) {
    if (!job.signal.aborted) showError(`Could not read ${file.name}: ${describeError(e)}`);
  } finally {
    if (fileJob === job) fileJob = null;
  }
}

// The log rebuilt from a CSV's rows, with the current hum alert level.
const csvEvents = (f) => sessionEvents(f.rows, humOptionsFrom(state.alertCfg), { fileAnalysis: f.fileAnalysis });

// File mode click on the timeline (`fromLog` false) or a log entry. Audio plays from there,
// with 2 s of lead-in before a log entry. A CSV shows that second: the one the timeline's
// tooltip shows, or the second an entry happened in.
function seekFile(t, fromLog = false) {
  const f = state.file;
  if (!f) return;
  if (!f.csv) playFrom(fromLog ? Math.max(0, t - 2) : t);
  else showMoment(fromLog ? rowAt(f.rows, t) : timeline.nearest(t));
}

// A CSV: the readings of one row, and the charts' last range up to it.
function showMoment(row) {
  const rows = state.file.rows;
  if (!row || row === state.lastRow) return; // e.g. the click that ends a scrub

  const i = rows.indexOf(row);
  state.history = rows.slice(Math.max(0, i + 1 - HISTORY_MAX), i + 1);
  state.lastRow = row;
  state.pausedAt = row.t;
  meters.renderFrame(row);
  meters.renderRow(row);
  humView.renderRow(row);
  spectrum.showSaved(rows, i); // CSVs from 2026-10-31 on: spectrum bars, octave balance, coarse spectrogram
  showSavedPan(row); // and the pan map
  redrawCharts();
  timeline.setCursor(row.t);
  setText(el.playPos, xFormat(row.t, row));
  setText(el.elapsed, `position ${fmtDuration(row.t)}`);
}

// A CSV second's pan map is decoded (async) when first shown, then kept on the row.
function showSavedPan(row) {
  if (!row.panCode) return panMap.showSaved(null);
  if (row.panGrid) return panMap.showSaved(row.panGrid);
  decodePan(row.panCode)
    .then((grid) => {
      row.panGrid = grid;
      if (state.lastRow === row) panMap.showSaved(grid); // unless the moment has moved on
    })
    .catch(() => panMap.showSaved(null));
}

function showFileResult(analysisSecs, moment = null) {
  const f = state.file;
  const s = f.summary;
  beginSession();
  state.summary = s;
  el.fileResult.hidden = false;
  setText(el.fileName, f.name);
  const speed = analysisSecs > 0 ? Math.round(s.duration / analysisSecs) : 0;
  const statusSecs = s.statusSeconds;
  const csvStart = f.csv && f.startWall !== null ? fmtStamp(new Date(f.startWall)) : '';
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
    ...(f.csv
      ? [['Started', csvStart || '--']]
      : [['Rate', `${s.sampleRate} Hz`], ['Analysed', speed ? `${speed}× real time` : '']]),
  ].map(([k, v]) => `<span>${k} <b>${v}</b></span>`).join('');
  setText(el.dRate, f.csv ? '--' : `${s.sampleRate} Hz`);
  el.play.hidden = !!f.csv;
  el.scrubKeys.hidden = !f.csv;
  setText(el.fileHint, f.csv ? 'Saved session: click the timeline or a log entry to see that moment.' : 'Click the timeline or a log entry to play from there.');

  timeline.setData(f.rows, 0, s.duration);
  timeline.setCursor(null);
  // Log: status episodes and the alerts the rules would have raised.
  const monitor = new AlertMonitor(state.alertCfg);
  // A CSV knows the wall clock; an audio file only its position.
  const clockAt = (t) => (f.csv && f.startWall !== null ? fmtClock(new Date(f.startWall + t * 1000)) : 'file');
  const entries = f.events.map((e) => EventLog.fromEvent(e, clockAt(e.t), true));
  log.seekTitle = f.csv ? 'Show this moment' : 'Play from here';
  for (const row of f.rows) {
    if (!f.csv) recorder.add(row); // a CSV's rows are exported from f.rows (no 12 h cap)
    for (const a of monitor.update(row).raised) {
      entries.push({ clock: clockAt(row.t), t: row.t, kind: 'alert', title: `Alert: ${ALERT_LABELS[a.id]}`, detail: a.message, seekable: true });
    }
  }
  entries.sort((a, b) => a.t - b.t).forEach((e) => log.add(e));
  el.exportCsv.disabled = el.exportJson.disabled = false;
  state.pausedAt = 0;
  setText(el.playPos, '0:00');
  // Hum: the whole file's strip, and the final measurement (harmonics, signature).
  if (s.hum && s.hum.last) humView.render(s.hum.last);
  el.humListen.hidden = !!f.csv;
  setText(el.humListenNote, '');
  if (f.csv) showMoment(moment || f.rows[f.rows.length - 1]); // by default, as the session ended
}

// "Listen to isolated hum" / "off-frequency control": 20 s from the current position,
// comb-filtered around the mains harmonics, raised by the chosen gain.
let humAudio = null;
async function listenToHum(control) {
  const f = state.file;
  if (!f) return;
  if (humAudio) {
    humAudio.close();
    humAudio = null;
  }
  if (state.playing) togglePlay();
  const sr = f.buffer.sampleRate;
  const from = Math.min(state.pausedAt || 0, Math.max(0, f.buffer.duration - 20));
  const a = Math.floor(from * sr), b = Math.min(f.buffer.length, a + 20 * sr);
  const L = f.buffer.getChannelData(0).subarray(a, b);
  const R = f.buffer.numberOfChannels > 1 ? f.buffer.getChannelData(1).subarray(a, b) : L;
  const mono = new Float32Array(L.length);
  for (let i = 0; i < mono.length; i++) mono[i] = 0.5 * (L[i] + R[i]);
  const last = f.summary.hum && f.summary.hum.last;
  const fundamentalHz = last && last.status === 'PRESENT' ? last.fundamentalHz : state.alertCfg.hum.mainsFrequencyHz;
  setText(el.humListenNote, 'Preparing…');
  await new Promise((r) => setTimeout(r, 30)); // let the note paint before the number crunching
  const r = isolateHum(mono, sr, { fundamentalHz, offsetHz: control ? 3.5 : 0, gainDb: Number(el.humGain.value) });
  const ctx = new AudioContext({ sampleRate: sr });
  const buf = ctx.createBuffer(1, r.samples.length, sr);
  buf.copyToChannel(r.samples, 0);
  const src = new AudioBufferSourceNode(ctx, { buffer: buf });
  src.connect(ctx.destination);
  src.start();
  src.onended = () => ctx.close();
  humAudio = ctx;
  setText(
    el.humListenNote,
    `${control ? 'Control' : 'Hum'} from ${fmtDuration(from)} at ${fundamentalHz.toFixed(2)} Hz` + (r.limited ? `, gain limited to +${r.gainDb.toFixed(0)} dB` : `, +${el.humGain.value} dB`),
  );
}

async function playFrom(t) {
  const f = state.file;
  if (!f) return;
  t = Math.max(0, Math.min(t, f.buffer.duration - 0.05));
  state.playOffset = t;
  state.history = [];
  state.lastFrame = null;
  spectrum.clear();
  panMap.clear();
  panGrid.reset();
  resetReadouts();
  redrawCharts();
  await engine.startFile(f.buffer, t);
  state.playing = true;
  el.play.textContent = 'Pause';
}

function togglePlay() {
  if (!state.file || state.file.csv) return;
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
    if (recorder.recording) await recorder.stopDisk();
    else await recorder.startDisk(exportName('csv'));
  } catch (e) {
    if (e.name !== 'AbortError') showError(`Could not write the CSV file: ${describeError(e)}`);
  }
  updateRecordButton();
}

function updateRecordButton() {
  const on = recorder.recording;
  el.recordDisk.classList.toggle('recording', on);
  el.recordDisk.textContent = on ? `Recording to ${recorder.fileName}` : 'Record CSV to disk…';
  if (on) state.exported = true;
}

// ---------------------------------------------------------------------------
// Wiring

el.source.addEventListener('change', async () => {
  const wasActive = state.playing || state.file;
  state.playing = false;
  if (wasActive) await engine.close();
  setMode(el.source.value);
  resetReadouts();
});
el.start.addEventListener('click', startLive);
el.stop.addEventListener('click', stopLive);
el.reset.addEventListener('click', resetLive);
el.play.addEventListener('click', togglePlay);
el.humListenHum.addEventListener('click', () => listenToHum(false));
el.humListenCtl.addEventListener('click', () => listenToHum(true));
el.fileInput.addEventListener('change', () => handleFile(el.fileInput.files[0]));
el.dropzone.addEventListener('dragover', (e) => {
  e.preventDefault();
  el.dropzone.classList.add('over');
});
el.dropzone.addEventListener('dragleave', () => el.dropzone.classList.remove('over'));
el.dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  e.stopPropagation(); // the window's drop handler below would load it a second time
  el.dropzone.classList.remove('over');
  handleFile(e.dataTransfer.files[0]);
});
// A saved CSV: ←/→ step a second, with Shift 10 s, with Ctrl a minute; holding the key
// keeps going. Not while typing in a field or with the settings open.
// Steps are added up and shown once per animation frame, so a held key can't queue more
// work than the screen can draw (and stops when it is let go).
const SCRUB_KEYS = { ArrowLeft: -1, ArrowRight: 1 };
let keyRow = null, keyFrame = 0; // index of the row the pressed keys have reached
window.addEventListener('keydown', (e) => {
  const dir = SCRUB_KEYS[e.key];
  const f = state.file;
  if (!dir || state.mode !== 'file' || !f || !f.csv || e.altKey || e.metaKey) return;
  // The file chooser keeps the focus after a file is picked, and the Source menu after
  // choosing File: those don't count (in the menu, ← would switch the source).
  if (e.target instanceof Element && e.target.closest('input:not([type=file]), select:not(#source), textarea, dialog, [contenteditable]')) return;
  e.preventDefault();
  const step = e.ctrlKey ? 60 : e.shiftKey ? 10 : 1;
  const from = keyRow ?? Math.max(0, f.rows.indexOf(state.lastRow));
  keyRow = stepRows(f.rows, from, dir * step);
  keyFrame ||= requestAnimationFrame(() => {
    keyFrame = 0;
    if (state.file === f && keyRow !== null) showMoment(f.rows[keyRow]);
    keyRow = null;
  });
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
el.exportCsv.addEventListener('click', async () => {
  await recorder.later; // the last rows, still being finished (their pan maps are compressed)
  const f = state.mode === 'file' && state.file;
  download(exportName('csv'), f && f.csv ? csvHeader() + f.rows.map(csvRow).join('') : recorder.csv(), 'text/csv');
  state.exported = true;
});
el.exportJson.addEventListener('click', exportJson);
el.clearLog.addEventListener('click', () => log.clear());
el.recordDisk.addEventListener('click', toggleDiskRecording);
if (!SessionRecorder.diskSupported) {
  el.recordDisk.disabled = true;
  el.recordDisk.title = 'Needs Chrome or Edge (File System Access API)';
}
// Best effort: rows recorded to disk since the last commit (a reload or a closed tab).
window.addEventListener('pagehide', () => recorder.recording && recorder.commit());
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

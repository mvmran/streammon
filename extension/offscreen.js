// Offscreen document: captures the YouTube tab, runs the analyzer and owns the session
// (history, event log, CSV rows, alerts). The side panel and dashboard are views that
// talk to it over a BroadcastChannel; the service worker gets status changes and alerts
// via runtime messages (for the badge and notifications).

import { AudioEngine } from './src/audio/engine.js';
import { streamSampleRate } from './src/audio/sources.js';
import { AlertMonitor, ALERT_LABELS, humOptionsFrom } from './src/dsp/alerts.js';
import { summaryJson } from './src/dsp/report.js';
import { EventLog } from './src/ui/log.js';
import { SessionRecorder } from './src/ui/session.js';
import { loadAlertConfig } from './src/ui/settings.js';
import { fmtClock, fmtStamp, fileStamp } from './src/ui/format.js';
import { CHANNEL } from './client.js';

const HISTORY_MAX = 3600;
const LOG_MAX = 1000;

const channel = new BroadcastChannel(CHANNEL);
const recorder = new SessionRecorder();
const s = {
  running: false,
  tab: null,
  startWall: 0,
  sampleRate: null,
  endedReason: '',
  history: [],
  log: [],
  lastFrame: null,
  lastRow: null,
  status: 'IDLE',
  summary: null,
  hum: null, // latest mains hum measurement
  alerts: new AlertMonitor(loadAlertConfig()),
};
let testAudio = null;
let spectrumUntil = 0;
let spectrumTimer = null;

const engine = new AudioEngine({
  onFrame,
  onSecond,
  onEvent,
  onHum: (h) => {
    if (!s.running) return;
    s.hum = h;
    broadcast({ type: 'hum', hum: h });
  },
  onEnded: () => stop('The tab stopped sharing audio (closed or reloaded)'),
});

const broadcast = (msg) => channel.postMessage(msg);
const toBackground = (msg) => chrome.runtime.sendMessage({ target: 'background', ...msg }).catch(() => {});

function session() {
  return { running: s.running, tab: s.tab, startWall: s.startWall, sampleRate: s.sampleRate, endedReason: s.endedReason };
}

// ---------------------------------------------------------------------------
// Analyzer output

function onFrame(f) {
  if (!s.running) return; // frames still in flight while stopping would undo the IDLE state
  s.lastFrame = f;
  broadcast({ type: 'frame', frame: f });
  if (f.status !== s.status) {
    s.status = f.status;
    toBackground({ type: 'status', status: f.status });
  }
}

function onSecond(row) {
  const wall = new Date(s.startWall + row.t * 1000);
  row.wallClock = fmtStamp(wall);
  row.clock = fmtClock(wall);
  recorder.add(row);
  s.lastRow = row;
  s.history.push(row);
  if (s.history.length > HISTORY_MAX) s.history.shift();
  broadcast({ type: 'row', row });

  const { raised, cleared } = s.alerts.update(row);
  for (const a of raised) {
    addLog({ clock: row.clock, t: row.t, kind: 'alert', title: `Alert: ${ALERT_LABELS[a.id]}`, detail: a.message });
    toBackground({ type: 'alert', title: `${ALERT_LABELS[a.id]} on the stream`, message: a.message });
    if (s.alerts.config.sound) engine.beep();
  }
  if (raised.length || cleared.length || Object.keys(s.alerts.active).length) broadcast({ type: 'alerts', active: s.alerts.active });
}

function onEvent(e) {
  addLog(EventLog.fromEvent(e, fmtClock(new Date(s.startWall + e.t * 1000))));
}

function addLog(entry) {
  s.log.push(entry);
  if (s.log.length > LOG_MAX) s.log.shift();
  broadcast({ type: 'log', entry });
}

// ---------------------------------------------------------------------------
// Capture

async function start({ streamId, testUrl, tab }) {
  if (s.running) await stop('Switched to another tab');
  let stream;
  if (streamId) {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
      video: false,
    });
  } else {
    testAudio = new Audio();
    testAudio.crossOrigin = 'anonymous';
    testAudio.src = testUrl;
    testAudio.loop = true;
    await testAudio.play();
    stream = testAudio.captureStream();
  }
  Object.assign(s, {
    running: true,
    tab,
    startWall: Date.now(),
    endedReason: '',
    history: [],
    log: [],
    lastFrame: null,
    lastRow: null,
    status: 'IDLE',
    summary: null,
    hum: null,
    alerts: new AlertMonitor(loadAlertConfig()),
  });
  recorder.clear();
  engine.setHumOptions(humOptionsFrom(s.alerts.config));
  // Tab capture mutes the tab, so play the captured audio back to the user.
  await engine.startStream(stream, streamSampleRate(stream), { monitor: !!streamId });
  s.sampleRate = engine.ctx.sampleRate;
  broadcast({ type: 'session', session: session() });
}

async function stop(reason = 'Stopped') {
  if (!s.running) return;
  s.running = false;
  s.endedReason = reason;
  s.summary = await engine.finish();
  await engine.close();
  if (testAudio) {
    testAudio.pause();
    testAudio = null;
  }
  s.status = 'IDLE';
  toBackground({ type: 'stopped' });
  broadcast({ type: 'session', session: session() });
}

// Spectrum data is only sent while a dashboard is open and asking for it.
function wantSpectrum() {
  spectrumUntil = Date.now() + 3000;
  if (spectrumTimer) return;
  spectrumTimer = setInterval(() => {
    if (Date.now() > spectrumUntil || !s.running || !engine.analyser) {
      clearInterval(spectrumTimer);
      spectrumTimer = null;
      return;
    }
    const n = engine.analyser.frequencyBinCount;
    const data = new Float32Array(n), left = new Float32Array(n), right = new Float32Array(n);
    engine.analyser.getFloatFrequencyData(data);
    engine.analyserL.getFloatFrequencyData(left);
    engine.analyserR.getFloatFrequencyData(right);
    broadcast({ type: 'spectrum', data, left, right, sampleRate: engine.ctx.sampleRate });
  }, 100);
}

function exportBase() {
  return `stream-${fileStamp(new Date(s.startWall || Date.now()))}`;
}

// ---------------------------------------------------------------------------
// Messages

channel.onmessage = async (e) => {
  const m = e.data;
  if (m.type === 'hello') {
    broadcast({ type: 'snapshot', session: session(), history: s.history, log: s.log, lastFrame: s.lastFrame, lastRow: s.lastRow, alerts: s.alerts.active, hum: s.hum });
  } else if (m.type === 'stop') {
    stop();
  } else if (m.type === 'reset' && s.running) {
    if (m.what === 'peaks') engine.resetPeaks();
    else engine.resetIntegrated();
    const title = m.what === 'peaks' ? 'True peak max reset' : 'Integrated loudness reset';
    addLog({ clock: fmtClock(new Date()), t: s.lastRow ? s.lastRow.t : 0, kind: 'info', title, detail: 'measuring again from here' });
  } else if (m.type === 'want-spectrum') {
    wantSpectrum();
  } else if (m.type === 'get-csv') {
    broadcast({ type: 'reply', id: m.id, name: `${exportBase()}.csv`, text: recorder.csv() });
  } else if (m.type === 'get-json') {
    const summary = s.running ? await engine.summary() : s.summary;
    const meta = {
      tool: 'Stream Audio Monitor (Chrome extension)',
      exportedAt: new Date().toISOString(),
      source: { type: 'youtube-tab', title: s.tab && s.tab.title, url: s.tab && s.tab.url, startedAt: new Date(s.startWall).toISOString() },
      alertConfig: s.alerts.config,
    };
    broadcast({ type: 'reply', id: m.id, name: `${exportBase()}.json`, text: summaryJson(summary, s.log, meta) });
  }
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.target !== 'offscreen') return false;
  if (msg.type === 'state') {
    sendResponse(session());
    return false;
  }
  if (msg.type === 'start') {
    start(msg).then(
      () => sendResponse({ ok: true }),
      (e) => {
        broadcast({ type: 'session', session: { ...session(), endedReason: `Could not capture the tab: ${e.message}` } });
        sendResponse({ ok: false, error: e.message });
      },
    );
    return true;
  }
  return false;
});

// Alert settings are edited in the dashboard; pick up changes without losing state.
window.addEventListener('storage', () => {
  const before = JSON.stringify(humOptionsFrom(s.alerts.config));
  s.alerts.config = loadAlertConfig();
  // Re-applying hum settings restarts the hum measurement, so only when they changed.
  const hum = humOptionsFrom(s.alerts.config);
  if (JSON.stringify(hum) !== before) engine.setHumOptions(hum);
});

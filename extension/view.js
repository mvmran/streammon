// Controller for the extension's views: the side panel (compact) and the dashboard
// (full). Both pages use the same element ids; anything a page doesn't include is
// skipped. The session itself lives in the offscreen document.

import { connectHub } from './client.js';
import { checkPlayer, describePlayer } from './player.js';
import { MetersView, renderAlertBanners, createHistoryChart, createPeakChart, showRecent, timeFormatter, bindMeterResets } from './src/ui/meters.js';
import { EventLog } from './src/ui/log.js';
import { SpectrumView } from './src/ui/spectrum.js';
import { PanMapView } from './src/ui/pan-map.js';
import { loadAlertConfig, setupSettings } from './src/ui/settings.js';
import { setupHelp } from './src/ui/help.js';
import { HumView } from './src/ui/hum-view.js';
import { fmtDuration, fmtClock, download, escapeHtml } from './src/ui/format.js';

const $ = (id) => document.getElementById(id);
const HISTORY_MAX = 3600;
const UI_FPS = 10;
const compact = document.body.classList.contains('panel-page');

const state = {
  session: null,
  history: [],
  active: {},
  dismissed: new Set(),
  cfg: loadAlertConfig(),
  range: 300,
  frame: null,
};

if ($('settings')) {
  state.cfg = setupSettings($('settings'), $('settings-btn'), (cfg) => {
    state.cfg = cfg;
    if (spectrum) spectrum.setSpectrogramFloor(cfg.display.spectrogramFloorDb);
    redraw();
  });
  if (location.hash === '#settings') $('settings-btn').click();
}
window.addEventListener('storage', () => {
  state.cfg = loadAlertConfig();
  humView.renderMains();
  if (spectrum) spectrum.setSpectrogramFloor(state.cfg.display.spectrogramFloorDb);
});

const meters = new MetersView(() => state.cfg);
const xFormat = timeFormatter(() => ({ mode: 'live', startWall: state.session ? state.session.startWall : 0 }));
const charts = [];
if ($('history')) charts.push(createHistoryChart($('history'), xFormat, { compact }));
if ($('peaks')) charts.push(createPeakChart($('peaks'), xFormat, () => state.cfg));
const spectrum = $('bands') ? new SpectrumView({ bands: $('bands'), sgram: $('sgram'), balance: $('balance') }) : null;
if (spectrum) spectrum.setSpectrogramFloor(state.cfg.display.spectrogramFloorDb);
const panMap = $('pan-map') ? new PanMapView($('pan-map')) : null;
const log = new EventLog($('log-body'), $('log-empty'));
const humView = new HumView(() => state.cfg);

function redraw() {
  showRecent(charts, state.history, state.range);
}

function renderAlerts() {
  renderAlertBanners($('alerts'), state.active, {
    dismissed: state.dismissed,
    startWall: state.session ? state.session.startWall : 0,
    onDismiss: (id) => {
      state.dismissed.add(id);
      renderAlerts();
    },
  });
}

function resetSession() {
  state.history = [];
  state.active = {};
  state.dismissed.clear();
  state.frame = null;
  log.clear();
  meters.reset('Waiting for audio…');
  humView.reset();
  if (spectrum) spectrum.clear();
  if (panMap) panMap.clear();
  renderAlerts();
  redraw();
}

function applySession(sess) {
  state.session = sess;
  const started = !!(sess && sess.startWall);
  $('idle').hidden = started || !!(sess && sess.endedReason);
  const ended = $('ended');
  ended.hidden = !(sess && !sess.running && sess.endedReason);
  if (!ended.hidden) {
    ended.textContent = sess.endedReason === 'Stopped'
      ? 'Monitoring stopped. Click the toolbar button on a YouTube tab to start again.'
      : `Monitoring stopped: ${sess.endedReason}. Click the toolbar button on a YouTube tab to start again.`;
  }
  $('tab-title').textContent = sess && sess.tab ? sess.tab.title : 'Not monitoring';
  $('stop').disabled = $('reset').disabled = !(sess && sess.running);
  for (const id of ['export-csv', 'export-json']) if ($(id)) $(id).disabled = !started;
  if (!(sess && sess.running)) {
    state.frame = null;
    meters.renderStatus('IDLE');
  }
  pollPlayer();
}

const hub = connectHub({
  snapshot(m) {
    resetSession();
    state.history = m.history.slice();
    for (const e of m.log) log.add(e);
    state.active = m.alerts || {};
    if (m.lastRow) meters.renderRow(m.lastRow);
    if (m.lastFrame && m.session.running) meters.renderFrame(m.lastFrame);
    if (m.hum) humView.render(m.hum);
    applySession(m.session);
    renderAlerts();
    redraw();
  },
  session(m) {
    const prev = state.session;
    if (m.session.running && (!prev || prev.startWall !== m.session.startWall)) resetSession();
    applySession(m.session);
  },
  frame(m) {
    state.frame = m.frame;
  },
  row(m) {
    state.history.push(m.row);
    if (state.history.length > HISTORY_MAX) state.history.shift();
    meters.renderRow(m.row);
    redraw();
  },
  log(m) {
    log.add(m.entry);
  },
  alerts(m) {
    for (const id of state.dismissed) if (!(id in m.active)) state.dismissed.delete(id);
    state.active = m.active;
    renderAlerts();
  },
  // Taken in as they arrive (one per 100 ms of audio), also while this page is hidden,
  // so the spectrogram has no gaps; drawn in tick().
  spectrum(m) {
    if (spectrum) spectrum.updateData(m.data, m.sampleRate, 0.1, m.t);
    if (panMap && m.left) panMap.update(m.left, m.right, m.sampleRate, 0.1);
  },
  hum(m) {
    humView.render(m.hum);
  },
});

// ---------------------------------------------------------------------------
// Rendering loop

let lastTick = performance.now();
function tick(now) {
  requestAnimationFrame(tick);
  if (now - lastTick < 1000 / UI_FPS - 2) return;
  lastTick = now;
  if (state.frame) {
    meters.renderFrame(state.frame);
    $('elapsed').textContent = `elapsed ${fmtDuration(state.frame.t)}`;
    state.frame = null;
  }
  if (spectrum) spectrum.render();
  if (panMap) panMap.render();
  if ($('wallclock')) $('wallclock').textContent = fmtClock(new Date());
}
requestAnimationFrame(tick);

// The offscreen document only sends spectrum data while someone asks for it: keep asking
// while hidden too, so the spectrogram keeps filling behind other windows.
if (spectrum) {
  setInterval(() => {
    if (state.session && state.session.running) hub.send({ type: 'want-spectrum' });
  }, 1000);
  window.addEventListener('pagehide', () => hub.send({ type: 'no-spectrum' }));
}

// ---------------------------------------------------------------------------
// YouTube player checks

let polling = null;
let polledTab = null;
async function pollPlayer() {
  const sess = state.session;
  const list = $('player');
  if (!sess || !sess.running || !(sess.tab && sess.tab.id >= 0)) {
    list.hidden = true;
    clearTimeout(polling);
    polling = polledTab = null;
    return;
  }
  if (polling && polledTab === sess.tab.id) return;
  clearTimeout(polling);
  const tabId = (polledTab = sess.tab.id);
  const run = async () => {
    const items = describePlayer(await checkPlayer(tabId));
    // The session may have stopped or moved to another tab while the check ran.
    const now = state.session;
    if (polledTab !== tabId || !(now && now.running && now.tab && now.tab.id === tabId)) return;
    list.hidden = !items.length;
    list.innerHTML = items.map((i) => `<li class="${i.level}">${escapeHtml(i.text)}</li>`).join('');
    polling = setTimeout(run, 3000);
  };
  polling = setTimeout(run, 0);
}

// ---------------------------------------------------------------------------
// Buttons

$('stop').addEventListener('click', () => hub.send({ type: 'stop' }));
// Unexported data older than this makes Reset ask first.
const RESET_CONFIRM_SECONDS = 600;
$('reset').addEventListener('click', () => {
  const secs = state.history.length ? state.history[state.history.length - 1].t : 0;
  if (secs > RESET_CONFIRM_SECONDS && !confirm(`Reset and clear the last ${Math.round(secs / 60)} minutes of readings, event log and CSV data? Export first if you need them.`)) return;
  hub.send({ type: 'reset', what: 'all' });
});
if ($('open-dashboard')) $('open-dashboard').addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') }));
if ($('open-settings')) $('open-settings').addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html#settings') }));

async function exportFile(type, mime) {
  try {
    const r = await hub.request(type);
    download(r.name, r.text, mime);
  } catch (e) {
    alert(e.message);
  }
}
if ($('export-csv')) $('export-csv').addEventListener('click', () => exportFile('get-csv', 'text/csv'));
if ($('export-json')) $('export-json').addEventListener('click', () => exportFile('get-json', 'application/json'));

bindMeterResets({
  isRunning: () => !!(state.session && state.session.running),
  onResetPeaks: () => hub.send({ type: 'reset', what: 'peaks' }),
  onResetIntegrated: () => hub.send({ type: 'reset', what: 'integrated' }),
});

document.querySelectorAll('.seg button').forEach((b) =>
  b.addEventListener('click', () => {
    document.querySelectorAll('.seg button').forEach((x) => x.classList.toggle('on', x === b));
    state.range = Number(b.dataset.range);
    redraw();
  }),
);

meters.reset('Waiting for audio…');

setupHelp(document, { iconOnly: compact });

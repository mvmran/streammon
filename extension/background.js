// Service worker: starts tab capture from the toolbar button, keeps the toolbar badge
// showing the clip status, and raises desktop notifications for alerts. The audio
// itself is analysed in the offscreen document (offscreen.js), which outlives this
// worker's idle shutdowns.

const OFFSCREEN_URL = 'offscreen.html';
const YOUTUBE_HOSTS = ['www.youtube.com', 'm.youtube.com'];
const BADGE = {
  CLEAN: { text: 'OK', color: '#0ca30c' },
  LIMITED: { text: 'LIM', color: '#fab219' },
  CLIPPING: { text: 'CLIP', color: '#d03b3b' },
};

chrome.runtime.onInstalled.addListener(() => {
  // The button is only enabled on YouTube pages.
  chrome.action.disable();
  chrome.declarativeContent.onPageChanged.removeRules(undefined, () => {
    chrome.declarativeContent.onPageChanged.addRules([
      {
        conditions: YOUTUBE_HOSTS.map((host) => new chrome.declarativeContent.PageStateMatcher({ pageUrl: { hostEquals: host, schemes: ['https'] } })),
        actions: [new chrome.declarativeContent.ShowAction()],
      },
    ]);
  });
});

chrome.action.onClicked.addListener((tab) => {
  // Both calls must be made inside the click's user gesture, before anything is awaited.
  chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
  const streamId = chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
  startCapture(tab, streamId).catch((e) => notify('Could not start monitoring', e.message || String(e)));
});

async function startCapture(tab, streamIdPromise) {
  const state = await offscreenState();
  if (state && state.running && state.tab && state.tab.id === tab.id) {
    streamIdPromise.catch(() => {}); // already monitoring this tab: just show the panel
    return;
  }
  const streamId = await streamIdPromise;
  await ensureOffscreen();
  const r = await toOffscreen({ type: 'start', streamId, tab: { id: tab.id, title: tab.title, url: tab.url } });
  if (r && r.ok === false) throw new Error(r.error);
}

// Test hook for test/e2e-extension.mjs: tab capture needs a real toolbar click, so the
// browser test feeds a WAV file through the same pipeline instead.
self.streammonTestStart = async (testUrl, title = 'Test stream') => {
  await ensureOffscreen();
  return toOffscreen({ type: 'start', testUrl, tab: { id: -1, title, url: testUrl } });
};

let creating = null;
async function ensureOffscreen() {
  const existing = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (existing.length) return;
  creating ??= chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ['USER_MEDIA'],
    justification: 'Analyses the captured YouTube tab audio and plays it back to the user.',
  });
  try {
    await creating;
  } finally {
    creating = null;
  }
}

async function offscreenState() {
  const existing = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (!existing.length) return null;
  return toOffscreen({ type: 'state' }).catch(() => null);
}

function toOffscreen(msg) {
  return chrome.runtime.sendMessage({ target: 'offscreen', ...msg });
}

function notify(title, message) {
  chrome.notifications.create({ type: 'basic', iconUrl: 'icons/icon128.png', title, message, priority: 2 });
}

// Messages from the offscreen document.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.target !== 'background') return;
  if (msg.type === 'status') {
    const b = BADGE[msg.status];
    chrome.action.setBadgeText({ text: b ? b.text : '' });
    if (b) chrome.action.setBadgeBackgroundColor({ color: b.color });
    chrome.action.setTitle({ title: b ? `Stream Audio Monitor: ${msg.status}` : "Monitor this YouTube tab's audio" });
  } else if (msg.type === 'alert') {
    notify(msg.title, msg.message);
  } else if (msg.type === 'stopped') {
    chrome.action.setBadgeText({ text: '' });
    chrome.action.setTitle({ title: "Monitor this YouTube tab's audio" });
  }
});

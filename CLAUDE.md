# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A live audio analyser for a church YouTube stream (Midas M32 → ATEM Mini Pro → YouTube). Its core job is detecting **clipping that happens below 0 dBFS**: a stage before the ATEM clips, then the level is turned down, so ordinary "over" meters miss it. It comes in two forms sharing one codebase:

- **Web app** (`index.html`, `src/`): static HTML + ES modules, no framework, no build step, for Chrome/Edge. Sources: audio input device (the ATEM's USB audio, alongside OBS), browser-tab capture, and file analysis.
- **Chrome extension** (`extension/`, Manifest V3): monitors a YouTube tab, i.e. what viewers hear after YouTube. YouTube-only by the user's choice.

**Direction:** the user has said they want to start again as a **native Windows binary** (Mac later). The tech stack is not decided yet; settle it with the user before writing code. Whatever replaces this code, the calibrated detector design and the expected results in `test/reference.test.js` are the specification to re-verify against.

## Commands

```sh
npm test                    # Node-only test suite (node:test), no browser
node --test test/dsp.test.js                                  # one file
node --test --test-name-pattern="LIMITED" test/*.test.js      # tests matching a name
npm run test:e2e            # headless Chromium smoke test of all three sources (not part of npm test)
npm run calibrate -- test-audio/18Oct2026-31_min_mark.wav    # per-second detector readings, events, summary
npm start                   # serve at http://localhost:8765 (8080 is taken by another service on this machine)
npm run build:extension     # copy extension/ + shared src/ modules into dist/streammon-extension/ and zip it
npm run test:extension      # build, then test the unpacked extension in Chromium
node tools/make-icons.mjs   # re-render extension/icons/*.png (only when the icon changes)
npm run store:assets        # re-render the Chrome Web Store screenshots/promo tile into store/ (needs test-audio/)
```

Releases: bump `version` in `extension/manifest.json` (and `package.json`), run `npm run build:extension`, then upload `dist/streammon-extension-<version>.zip`. Store listing text, permission justifications and images are in `store/`; the privacy policy is `PRIVACY.md`. **If you add or remove a permission, update `PRIVACY.md` and `store/listing.md` too**, because the Web Store rejects unused or unexplained permissions. The repo is public (github.com/mvmran/streammon, GPL-3.0-or-later). `test-audio/` is git-ignored (service recordings) and the recording-based tests skip without it.

Never edit `dist/`. It is rebuilt from `extension/` and the `SHARED` list in `tools/build-extension.mjs`. A new `src/` module the extension imports must be added to that list.

No lint, formatter or build is configured. The page must be served from localhost or HTTPS because capture APIs need a secure context.

E2E uses `playwright-core` with the Chromium cached in `~/.cache/ms-playwright` (one-time setup: `npx playwright-core install chromium`; this follows the user's lscroster project). The Playwright MCP browser tools do not work here: they expect Google Chrome at `/opt/google/chrome`. `test/e2e.mjs` runs its own static server and uses:
- `--use-file-for-fake-audio-capture` to play a test WAV as the input device;
- `--auto-select-tab-capture-source-by-title` with `test/fixtures/player.html` to test tab capture.

Screenshots go to `test/e2e-output/`.

## Architecture

**`src/dsp/` is pure JS that runs unchanged in three places**: the AudioWorklet (`src/audio/analyzer-worklet.js`), the file-analysis Web Worker (`src/audio/file-worker.js`) and Node tests. Keep browser and Node APIs out of it. `structuredClone` in `alerts.js` is fine; that module isn't loaded in the worklet.

`StreamAnalyzer` (`src/dsp/analyzer.js`) is the single entry point:
- It accepts stereo blocks of any size and cuts them into 100 ms frames (`round(sr*0.1)`); every 10 frames make a 1 s row.
- Callbacks: `onFrame` (meters, 10 Hz), `onSecond` (one CSV row with every metric and the clip status), `onEvent` (status episodes: a `start` and an `end`).
- Results must not depend on block size (a test checks this).
- `ClipDetector.takeSecond()` must be called exactly once per second of audio; the analyzer does this.

Memory is bounded for 2-hour services:
- Integrated loudness and LRA use 0.01 LU histograms (count + exact energy per bin), not lists of blocks.
- The clip ceiling uses a ring of 0.5 s level histograms covering 10 s.
- UI buffers are capped: 3600 chart rows, 12 h of CSV rows, 500 log rows.

### Clipping detector (`src/dsp/clipdetect.js`)

The thresholds were tuned against `test-audio/`: 48 kHz WAVs decoded from YouTube AAC, so plateaus carry ripple. Never require identical consecutive samples.

| Signal | Rule | Measured on the test files |
|---|---|---|
| Ceiling | 99.9th percentile of \|x\| per polarity, rolling 10 s | |
| Dwell | runs of ≥ 0.42 ms within **±1 dB** of the ceiling | clipped 12–17/s, limited ~3.2/s, clean ≤ 0.5/s |
| Pile-up | density in [ceiling − 1, ceiling] dB ÷ [ceiling − 4, ceiling − 3] dB, max over polarities | clipped 0.55–1.0 (18 Oct files: negative polarity only), others ≤ 0.35 |
| Peak pinning | share of 100 ms block peaks within 1 dB of the ceiling, over 10 s | limiter ≥ 0.55, clean ≤ 0.48 |
| Full scale | ≥ 3 consecutive samples at \|x\| ≥ 0.999 | |

Dwell detail: a 0.5 s segment's dwell runs are discarded if that segment's own ceiling rose more than 1 dB above the one in use. A rising level would otherwise look like plateaus.

How the status is decided:
- **CLIPPING:** any full-scale run, or dwell (3 s average) ≥ 3/s together with pile-up ≥ 0.45.
- **LIMITED:** dwell ≥ 3/s or pinning ≥ 0.55, without the pile-up wall.
- **CLEAN:** everything else.
- The worst status is held for 2 s. Pin history is zeroed for seconds spent CLIPPING, so clipped peaks don't read as limiting afterwards.

A steady pure sine looks exactly like limited audio, so the synthetic "programme" in `test/synthetic.js` uses chords plus pink noise. When retuning, run `npm run calibrate` on the recordings and keep every case in `test/reference.test.js` and `test/dsp.test.js` passing.

### Browser side

- **`src/audio/engine.js`** builds the graph: source → input gain → worklet (muted output to the destination, which keeps it pulled) plus an AnalyserNode. The AnalyserNode is for the spectrum display only; all measurements come from raw samples.
- **Sample rates:** the AudioContext is created at the source's rate. `sniffSampleRate` parses WAV/FLAC/MP4/MP3 headers before decoding so `decodeAudioData` doesn't resample, because resampling smears plateaus.
- **File mode:** `analyseBuffer` sends 10 s chunks to the Worker and waits for an `ack` before the next (flow control). Playback runs through the same worklet. The worklet is reset on every seek, so `app.js` adds `state.playOffset` to row times.
- **`src/ui/app.js`** is the web app's controller. Meter rendering, alert banners and the history/peak chart set-ups live in `src/ui/meters.js`, shared with the extension; its elements are looked up by id and are all optional. `bindMeterResets` makes the true-peak (`#tp-tile`) and integrated (`#int-tile`) cards click-to-reset (`StreamAnalyzer.resetPeaks()` / `resetIntegrated()`, via the worklet port, or a `reset` message to the extension's offscreen document). Alerts (`AlertMonitor`) run only for live sources. Wall-clock time is `startWall + t` from the audio clock, not when a message arrives.
- **Hover help:** every meter tile and panel heading carries `data-help="<key>"`. The volunteer-facing text for each key lives only in `HELP` in `src/ui/help.js`, shared by all three pages. `test/help.test.js` fails if a card has no key or a key has no text.
- **Styling:**
  - The UI is dark-only.
  - Status colours (good / warning / critical) are reserved for CLEAN / LIMITED / CLIPPING and always come with a text label.
  - The status tile is styled through `data-status`.
  - `css/app.css` has `[hidden] { display: none !important; }`, because component `display` rules would otherwise override the `hidden` attribute.

### Chrome extension (`extension/`)

- **`background.js`** (service worker):
  - A toolbar click calls `chrome.sidePanel.open` and `chrome.tabCapture.getMediaStreamId` synchronously, inside the user gesture, before any `await`.
  - It then creates the offscreen document and sends it `start`.
  - It maps status messages to the badge (OK / LIM / CLIP) and alerts to `chrome.notifications`.
  - `declarativeContent` enables the button only on www/m.youtube.com.
- **`offscreen.js`** owns the session and outlives the service worker's idle shutdowns.
  - It captures with `getUserMedia({ chromeMediaSource: 'tab' })` and reuses `AudioEngine`, passing `monitor: true` because tab capture mutes the tab.
  - It keeps history, log, CSV rows (`SessionRecorder`) and `AlertMonitor`.
  - It only sends spectrum data while a dashboard keeps sending `want-spectrum`.
- **Views:** `panel.html` (side panel) and `dashboard.html` both run `view.js`, keyed on the same element ids as the web app.
  - They talk to the offscreen document over the `BroadcastChannel` in `client.js`: `hello` → `snapshot`, then `frame` / `row` / `log` / `alerts` / `session` / `spectrum`.
  - Exports use `get-csv` / `get-json` request–reply messages.
- **Alert settings:** stored in `localStorage` via `src/ui/settings.js` (the extension origin is shared). The offscreen document reloads them on the `storage` event.
- **`player.js`:** reads the YouTube player through `chrome.scripting.executeScript` (MAIN world).
  - `getVolume()` and `isMuted()` are relied on.
  - `getStatsForNerds()` "content loudness" is undocumented and treated as best effort.
- **Testing:** real tab capture needs a physical toolbar click, so `test/e2e-extension.mjs` uses the service worker's `self.streammonTestStart(url)` hook. It feeds a WAV through the same offscreen pipeline (`<audio>.captureStream()`), and everything after capture is tested for real. The `getMediaStreamId` → tab-capture path itself is only exercised by hand.

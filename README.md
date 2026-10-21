# Stream Audio Monitor

A browser-based live audio analyser for the Life Sanctuary Church YouTube live stream. It
measures loudness (EBU R128 / BS.1770-4), true peak and stereo image. Its main job is
**detecting clipping that happens below 0 dBFS**: for example, a stage before the ATEM
clips and the level is then turned down, so normal "over" meters stay quiet.

It comes in two forms that share the same analysis code:

- a **web app** (HTML + ES modules, no build step) for Chrome or Edge on Mac and Windows.
  It monitors the ATEM's USB audio live, a browser tab, or a recording;
- a **Chrome extension** that monitors a YouTube tab, i.e. exactly what viewers hear.

Everything runs locally in the browser; no audio or data leaves the computer
([privacy policy](PRIVACY.md)).

- **Web app:** <https://mvmran.github.io/streammon/>. Open it in Chrome or Edge; nothing to install.
- **Chrome extension:** download `streammon-extension-<version>.zip` from the
  [latest release](https://github.com/mvmran/streammon/releases/latest) and install it as
  described under [Chrome extension](#chrome-extension-what-viewers-hear-on-youtube).

## Running it

The browser only allows audio capture on `localhost` or `https://`, so the page has to be
served, not opened as a file.

```sh
npm start            # serves this folder at http://localhost:8765 (needs python3)
```

Then open <http://localhost:8765> in Chrome or Edge. Any static server works
(`npx serve`, or any web server pointed at this folder). The folder can also be put on any
HTTPS static host (GitHub Pages, Netlify, the church website) and used from there.
Everything runs in the browser and no audio is uploaded.

## Sources

### Audio input device: the ATEM Mini Pro over USB-C (recommended)

This measures exactly what the ATEM sends to the stream, live, with no YouTube delay.

1. Connect the ATEM Mini Pro's **USB-C (webcam out)** port to the computer. It shows up as
   a "Blackmagic Design" webcam and microphone.
2. In the monitor choose **Source: Audio input device** and press **Start**. Allow microphone
   access when asked. Device names only appear after the first permission grant. The
   Blackmagic device is selected automatically when present.
3. It can run alongside OBS using the same device.
   - **Windows:** in *Sound settings → More sound settings → Recording → Blackmagic Design →
     Properties → Advanced*, untick **"Allow applications to take exclusive control"** so
     neither app can lock the other out. On the *Enhancements* / *Advanced* tab, turn off any
     audio enhancements.
   - **Mac:** nothing to set up; allow Chrome under *System Settings → Privacy & Security →
     Microphone*.

The browser's echo cancellation, noise suppression and automatic gain are all turned off,
so levels are measured unaltered.

### Browser tab: the YouTube live or VOD page

Choose **Browser tab**, press **Start**, pick the YouTube tab and tick **"Also share tab
audio"**. Before you start:

- set the YouTube player volume to **100%**, and
- turn **Stable Volume off** (player gear menu).

YouTube's loudness normalisation and the player volume change absolute levels. Clipping
detection still works, because it looks at waveform shape, but **LUFS readings will be
offset** from the real stream.

### File

Choose **File** and drop in a WAV, MP3, M4A, FLAC… recording. It is analysed faster than
real time (about 100×) and shown as a timeline. Click anywhere on the timeline, or on a log
entry, to listen from that point with the live meters running.

The whole file is decoded into memory (about 1.4 GB per hour of stereo audio). Recordings up
to roughly an hour are fine; cut longer services into parts.

## Chrome extension: what viewers hear on YouTube

The extension monitors a YouTube tab's audio, which is exactly what viewers hear after
YouTube has encoded the stream. It uses the same analysis as the web app. The stream runs
5–30 s behind the desk, so alerts arrive late; the ATEM input (above) stays the instant
warning.

**Install (unpacked, until the Chrome Web Store listing is live):**

1. Download `streammon-extension-<version>.zip` from the
   [latest release](https://github.com/mvmran/streammon/releases/latest), or build it with
   `npm run build:extension` (it lands in `dist/`). Unzip it into a folder you will keep:
   Chrome loads the extension from that folder every time.
2. In Chrome or Edge open `chrome://extensions`, turn on **Developer mode**, click **Load
   unpacked** and choose the unzipped folder.
3. Pin the **Stream Audio Monitor** button to the toolbar (puzzle-piece menu → pin).

To update, replace the folder and click the reload icon on the extension's card.

**Use:**

1. Open the YouTube live stream or video. In the player, set volume to **100%** and turn
   **Stable Volume off** (gear menu).
2. Click the **Stream Audio Monitor** toolbar button. The button is only active on YouTube.
   Monitoring starts and the side panel opens. You keep hearing the tab.
3. The toolbar button shows **OK** (green), **LIM** (amber) or **CLIP** (red) even when the
   panel is closed. Alerts also appear as Chrome notifications.
4. The side panel shows the main meters, the last 5 minutes and the event log.
   **Open dashboard** opens the full view (history, peaks, spectrum, detectors) in a tab.
   **Alert settings** sets the thresholds; they are shared with the panel.
5. **Stop** in the panel or dashboard ends monitoring. **CSV** / **JSON** export the
   session (also after stopping).

The panel checks the YouTube player while monitoring. It warns if the player is muted or not
at 100%, and it warns when YouTube's loudness normalisation is turning the stream down, if
the player exposes that. Those settings change the LUFS readings but not clipping detection.

Monitoring stops if the YouTube tab is closed or reloaded; click the button again to restart.

## What CLEAN / LIMITED / CLIPPING mean (for volunteers)

The big coloured box is the main thing to watch.

| Status | Colour | What it means | What to do |
|---|---|---|---|
| **CLEAN** ✓ | green | The sound's peaks are rounded and natural. Nothing is being squashed. | Nothing. |
| **LIMITED** ▲ | amber | A limiter (e.g. the M32's limiter) is holding the peaks at a fixed level. The sound is controlled but not damaged. | Usually fine. If it is on all the time, the mix is being driven hard into the limiter: consider bringing the level into it down a little. |
| **CLIPPING** ✖ | red | Somewhere before the stream, the waveform has been cut flat: it hit the maximum of a device and the tops were sliced off. This is the harsh, crackly distortion people hear. It can happen **even when the meters here are well below 0**, because the level may have been turned down *after* the damage was done. | Turning the stream volume down will **not** fix it. Find the stage that is overloading (M32 output, sound-card input gain, a stereo enhancer or other effect, the ATEM input) and reduce the level *going into* that stage. |

The text under the status says how it was detected:

- **Flat tops at −3.4 dBFS**: the waveform keeps sitting on the same ceiling (here 3.4 dB
  below full scale). This is the "hidden" clipping from 18 Oct.
- **Hitting digital full scale**: samples are stuck at the absolute maximum (0 dBFS).

### The other meters

- **Short-term loudness (LUFS)**: loudness over the last 3 s. YouTube's target is about
  −14 LUFS; aim for the shaded band **−16 to −12** on the history graph. Above −10 for a
  sustained period is too loud.
- **Integrated**: average loudness of the whole session (gated, as YouTube measures it).
  **Range (LRA)**: how much the loudness varies; very low numbers (under ~2 LU) mean the
  sound is heavily squashed.
- **True peak (dBTP)**: the real peak level including between samples. Keep it below
  **−1 dBTP** so YouTube's encoder has headroom.
- **Crest factor**: peak minus average level. Natural speech/music is typically 12–20 dB;
  heavily limited audio is around 10–11 dB and clipped audio often under 9 dB.
- **Stereo status** (the Stereo card): MONO (left and right identical), STEREO OK, WIDE,
  UNBALANCED (whole mix more than 3 dB louder on one side) or PHASE PROBLEM (a loud band
  out of phase, which cancels on phones and mono speakers). A phase problem for 5 s and
  imbalance for 15 s raise alerts; an alert for a mono feed can be switched on in
  *Alerts & settings*. Our feeds are currently mono because of a configuration problem;
  the aim is full stereo.
- **Correlation strip** under the loudness history: stereo correlation over time.
- **Stereo by band**: one dot per octave, placed by balance (left/right) and correlation
  (+1 mono at the top, below 0 out of phase). The dashed half-oval is roughly where a
  healthy stereo mix sits. A band below 0 cancels on mono speakers and phones.
- **Pan map**: where the sound sits left to right at each frequency, brighter for louder.
  It shows what is panned where, but not phase (Stereo by band does).
- **Spectrum, spectrogram and octave balance**: hover the spectrum bars or the spectrogram
  for readings. The darker bars are the octave-balance frequencies.
- **Peak per second**: a flat line of peaks at one level is the visual signature of
  clipping or limiting.

## Mains hum

The **Mains hum** panel watches for powerline hum: a steady tone at the mains frequency
and its multiples. Set **50 Hz or 60 Hz** under *Alerts & settings*; 50 Hz is the default.
Hum is most audible in speech and pauses, because music covers it.

- **PRESENT:** a mains-locked tone that stands out from its surroundings, stays on
  frequency, keeps a steady phase and level, and lasts at least 5 of the last 10 seconds.
  The panel shows its frequency, level, how far it stands out, and its level in quiet
  passages.
- **NOT DETECTED:** no hum, and the programme near the mains frequency is quiet enough
  that a hum at the alert level would have shown.
- **MASKED:** the programme near the mains frequency (bass notes, for example) is too loud
  to judge. It never claims "no hum" during loud music.

**What to watch:**
- **Projection:** where the hum would sit if the speech were brought up to −18 LUFS (the
  speech target is adjustable). Quiet speech that viewers turn up makes hum much easier to
  hear.
- **Harmonic signature hint:** strong 3rd and 5th harmonics suggest a ground loop or an
  unbalanced line; strong 2nd and 4th suggest a rectifier or power supply. Only harmonics
  that stand clear of the noise floor count, and it takes about 20 s to measure. Treat it
  as a hint, not a verdict.
- **Event log:** onset, offset, level steps of 6 dB or more, and changes to the mains
  setting.
- **Alert:** hum PRESENT and above −75 dBFS for 5 s raises an alert (adjustable).

In **File** mode, **Listen to isolated hum** plays 20 s from the current position with
everything except narrow slices around the hum harmonics removed, raised by the chosen gain.
**Listen to off-frequency control** plays the same slices 3.5 Hz away for comparison.

Musical notes near the mains frequency (G1 49.0 Hz, A1 55.0 Hz, G2 98 Hz) are not
reported: at the 4-second analysis window they are clearly off the mains frequency.

## Alerts and exports

**Alerts & settings** sets the thresholds. Defaults:

- clipping status CLIPPING for ≥ 1 s
- true peak above −1 dBTP
- short-term above −10 LUFS for 10 s
- integrated more than 4 LU away from −14 LUFS (after 60 s)

Alerts appear as a banner and in the event log. Sound is **off by default** because this
runs during services. Settings are remembered by the browser.

- **Export CSV**: one row per second with every metric, clip status and the detector readings.
- **Export JSON summary**: session totals, the event log and the alert settings.
- **Record CSV to disk…**: writes each row to a file as it happens (Chrome/Edge), so
  nothing is lost if the laptop crashes during a long service.

## How clipping is detected

All measurements come from raw samples in an AudioWorklet (`src/dsp/`). The spectrum
display is the only part that uses an AnalyserNode.

1. **Dwell (plateau) detector:** keeps a rolling ceiling per polarity (99.9th percentile of
   |x| over 10 s) and counts runs of ≥ 20 samples (0.42 ms at 48 kHz) staying within ±1 dB of
   it. AAC encoding puts ripple on the flat tops, so identical samples are never required.
   Measured on our recordings: clipped 12–17 runs/s; limited 3.2/s; clean 0.1–0.5/s.
2. **Digital full scale:** runs of ≥ 3 samples at |x| ≥ 0.999.
3. **Histogram pile-up:** sample density in the 1 dB below the ceiling vs 3–4 dB below.
   Clipping piles samples against a hard wall (0.55–1.0); limited and clean audio roll off
   smoothly (≤ 0.35). This separates CLIPPING from LIMITED.
4. **Peak pinning:** share of 100 ms blocks whose peak is within 1 dB of the ceiling.
   A limiter pins most of them (≥ 55%).

CLIPPING = full-scale runs, *or* dwell ≥ 3/s with a pile-up wall ≥ 0.45. LIMITED = dwell
≥ 3/s or pinning ≥ 55% without a wall. A status is held for 2 s so it doesn't flicker,
so it lags real events by about 1–3 s. The first few seconds after Start are a warm-up
while the ceiling is learned.

## Development

```sh
npm install            # once: installs playwright-core for the browser tests
npm test               # Node only, no browser: DSP + detector vs the recordings in test-audio/
npm run test:e2e       # headless Chromium smoke test of all three sources (Playwright)
npm run build:extension   # assemble dist/streammon-extension/ (+ zip)
npm run test:extension    # build, then test the extension in Chromium (Playwright)
npm run calibrate -- test-audio/18Oct2026-30_min_mark.wav   # per-second detector table
```

`npm test` checks integrated loudness, true peak, sample peak, LRA, crest factor, dwell rate,
ceiling and the expected status of each recording in `test-audio/`. The reference figures
came from pyloudnorm, FFmpeg ebur128 and scipy. It also checks synthetic clipped, limited
and clean signals, and EBU test-signal cases.

**The service recordings in `test-audio/` are not in the repository** (they may contain
copyrighted music). Without them, `npm test` still runs the synthetic and EBU test-signal
cases and skips the recording checks. The browser tests need them. The expected figures for
each recording are in `test/reference.test.js`.

The browser tests need a one-time `npx playwright-core install chromium` (no sudo). They feed
a test recording in as a fake microphone and as a fake YouTube tab.

Use `npm run calibrate` on a new recording to see why the detector decided what it did
before changing any thresholds (`DEFAULT_CLIP_OPTIONS` in `src/dsp/clipdetect.js`).

```
index.html, css/app.css
src/dsp/          pure ES modules shared by the AudioWorklet, the file Worker and Node:
                  analyzer, loudness, kweighting, truepeak, clipdetect, stereo, crest,
                  alerts, report (CSV/JSON), bands, hum, hum-isolate, stereobands
src/audio/        analyzer-worklet, file-worker, engine (audio graph), sources (capture/decoding)
src/ui/           app (controller), meters, charts, spectrum, stereo-view, hum-view, log,
                  session (CSV), settings, help
extension/        Chrome extension: background (service worker), offscreen (capture + session),
                  panel/dashboard pages (view.js), player check; built into dist/ with src/
test/             node:test suites, WAV decoder, synthetic signals, e2e.mjs, e2e-extension.mjs
tools/            calibrate, build-extension, make-icons
```

## Licence

Copyright © 2026 Manoj Mathew.

Stream Audio Monitor is free software: you can redistribute it and/or modify it under the
terms of the GNU General Public License as published by the Free Software Foundation, either
version 3 of the License, or (at your option) any later version. It is distributed in the hope
that it will be useful, but WITHOUT ANY WARRANTY. See [LICENSE](LICENSE) for details.

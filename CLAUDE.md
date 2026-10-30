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

**Version numbers (the user's rule):**
- By default, bump only the last number (1.1.0 → 1.1.1).
- Ask the user before bumping the middle number, even for a change that seems big enough.
- Never change the first number unless the user agrees, and then only for a major rewrite or similar.

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

### Mains hum detector (`src/dsp/hum.js`)

**Front end.** The mono mix is decimated to about 2 kHz in two IIR stages (about 8 kHz, then ÷4). Their gain is compensated analytically per harmonic.

**Lock-in grid.** For each harmonic k, rotating phasors sit on a grid k·f0 + m·Δ, with Δ = 1/detectWindow (0.25 Hz) and m = −21…21. They accumulate complex sums in 0.5 s segments referenced to absolute sample time. Hann-windowed DFTs over any whole number of segments are then exact (½X(m) − ¼e^{−jθ}X(m−1) − ¼e^{jθ}X(m+1)). That gives the 4 s detect window, the 1 s display window and single 0.5 s segments (used for the quiet-passage level).

**`refPhase`.** Converts a grid point's phase to the k·f0 reference using integer arithmetic.

**Checks, per reference harmonic (1st or 3rd):**
- prominence over the ±3.5 Hz controls ≥ 18 dB;
- a peak inside the search range, within ±0.25·k Hz of k·f0;
- persistence ≥ 5 s of the last 10 s;
- phase residual ≤ 0.5 rad;
- level std ≤ 2 dB, excluding windows that straddle a logged step.

A status is held for 2 s. While held (no window locked), the result reports the hum as last locked (`lastLock`: frequency, level, prominence) and measures at that frequency: the peak found then is often the bass note that ended the lock (live, 2026-10-30: 50.75 Hz at −37 dBFS reported as the hum).

**MASKED vs NOT DETECTED.** Decided by the mean grid power in f0 ± 5 Hz, excluding the hum's own bins.

**Harmonic levels.**
- Averaged in phase with a tracked mains phase (an EMA of derotated complex values).
- Each is judged against the same average taken over the control bins: ≥ 10 dB above it is clear, 6–10 dB tentative.
- The signature uses only clear or tentative harmonics, and only after 20 s of averaging while present.

**Calibration** (`test/hum.test.js`):
- Real hum prominence is 29–39 dB.
- Bass notes reach at most 12 dB.
- A real 59.9 Hz tone at −86 dBFS in `Reference_speech_recording.wav` reaches 10–20 dB. It must never read PRESENT at the 60 Hz setting, which is why minProminenceDb is 18.
- MASKED vs NOT DETECTED is judged against a fixed `maskReferenceDbfs` (−75): could a hum that loud have stood out? It used to be the alert level, which made lowering the alert level (default −85 dBFS since settings version 2) turn ordinary speech into MASKED.
- Settings are saved as differences from `DEFAULT_ALERTS` (`changedFromDefaults`, version 2), so default changes reach everyone who didn't change that value. `migrateSaved` moves version-1 saves (every value stored) that still hold an old default (−75, or a −100 spectrogram floor) to the new one.
- `Reference_hum.wav` (2026-10-30): a speaker session with audible buzz in the pauses. 50 Hz at about −90 dBFS (PRESENT only 31–36 s, about −86 dBFS), but 150/350 Hz at about −81 dBFS; the pause background (−73 dBFS) is mostly that buzz. Also a steady 30.000 Hz tone at −92 dBFS, not mains-locked (probably 30 fps video gear), which the hum detector doesn't look for.

**Event log** (`HumLog` and `HUM_LOG` in `episodes.js`). The detector emits `hum-onset` / `hum-offset` on every PRESENT change; the analyzer drops those and logs episodes instead: a second counts when the hum is PRESENT at or above `alertLevelDbfs`; an episode is logged after `onSeconds` (10) of those in a row, dated from the first, and ends `offSeconds` (30) after the last, dated then (`belowDb` set when it is still PRESENT but quieter: "Mains hum quieter"). Level steps are only passed on during a logged episode. On the 2026-10-30 live CSV (a −89 dBFS hum flipping at the edge of detection) that is 6 entries instead of 152. The panel's NOT DETECTED line mentions a pause reading from the last 60 s ("buzz in pauses at … dBFS") rather than saying "Nothing at 50 Hz".

**Integration.** `StreamAnalyzer` adds audibility (`belowProgrammeDb`, and `projectedDb` at speechTargetLufs from integrated loudness) and puts the hum fields in each 1 s row. The hum settings live in the alert config's `hum` section (`humOptionsFrom`).

**Hum in pauses** (`measurePause`). Whenever the whole last second was quiet (both 0.5 s segments below `quietRmsDbfs`, −50 dBFS), every harmonic is measured over that second (1 Hz Hann bins, the display window's sums) against the larger of its controls ±`pauseControlHz` (2.5 Hz) away. Where to look: from the measured frequency when PRESENT; otherwise from the clearest of the first five harmonics within ±k·`pauseDriftHz` (0.15 Hz) of nominal, then every harmonic at its own multiple ±1 grid step (0.25 Hz), so noise peaks elsewhere don't count. The grid half-width `M` includes `pauseReach` so the 10th harmonic of mains 0.15 Hz off stays measurable. Harmonics at least `pauseLineDb` (10 dB) above count as lines; the pause level is their power sum (result `pause`: `levelDb`, `lines`, `buzz` = at least `pauseMinLines`, 3). Rows carry buzz only: `humPauseDb` / `humPauseHz` / `humPauseReadings` (half-second readings that found it this second), CSV `hum_pause_dbfs`. The panel's "Buzz in pauses" row shows any lines, so a plain hum shows there too. It works whatever the status, because hum can be audible in pauses while too quiet to be PRESENT through speech: in `Reference_hum.wav` the pause level is −72 dBFS (50–450 Hz, odd harmonics) while 50 Hz alone is −86 to −91. Checked on six service recordings, three classical and three studio tracks, at 50 and 60 Hz: quiet music passages gave at most two lines (notes on a mains multiple), real buzz five to seven; readings scatter about ±1.5 dB with room noise. Alert `humPause` ("Hum in pauses"): `hum.pauseAlertDbfs` (−80) reached in `hum.pauseCount` (2) half-second readings within `hum.pauseWindowSec` (60 s), i.e. one pause of about 2 s or shorter ones adding up; each further reading holds it a full window, so it clears a minute after the last.

**Isolation.** `src/dsp/hum-isolate.js` is an STFT comb mask (bins under 0.4 Hz, ±0.75 Hz per harmonic) for the "Listen to isolated hum" button.

### Stereo by band (`src/dsp/stereobands.js`)

Each octave band (31 Hz – 16 kHz) is filtered by two cascaded RBJ band-pass biquads, identical for L and R. Over a 1 s window it gives correlation, balance (R over L, in dB) and level.
- `StreamAnalyzer` computes it only when `onFrame` is set, so the file-analysis worker skips it. The result goes out in `frame.bands`.
- It costs about 1% of one core.
- `src/ui/stereo-view.js` draws it (balance across, correlation up), created by `MetersView` when `#stereo-bands` exists.
- Frequency is shown by five validated shades of one blue, two octaves per shade, with each band named beside its dot. Ten shades of one hue fail the distinguishability check.
- Bands below −70 dBFS (`JUDGE_DB`) are drawn as outlines and left out of the summary line. Without this, a quiet room reads as wide or out of phase, because two mic capsules hiss independently.
- The dashed "healthy mix" zone (±3 dB balance, down to correlation +0.2: `ZONE_BAL_DB` / `ZONE_CORR`) is a rule of thumb. Retune it against the real stereo stream once that works; the feed is currently mono by mistake.

**Stereo status.** `StereoStatus` (same file) turns the bands into one word: MONO / STEREO OK / WIDE / UNBALANCED / PHASE PROBLEM / CHANNEL DEAD.
- CHANNEL DEAD (`deadChannel()`, from `StereoMeter.channelDb`) outranks the rest: one side's 1 s RMS is at least 30 dB below the other's while that one is above −50 dBFS. It needs no band filters, so file-analysis rows get it too. No false positives on the service recordings or the pro stereo test tracks. Alert `stereoDead` after `stereo.deadSeconds` (5).
- The thresholds are in `STEREO_RULES`, rules of thumb like the zone.
- It is judged on a 3 s window (`StereoBands.over(windowFrames)`), not the 1 s display window, and phase only on bands from 125 Hz up (`phaseMinHz`). Checked on public-domain orchestral and quartet recordings and a CC studio album: with the 1 s window and all bands, a spaced-mic orchestra recording read PHASE PROBLEM 42% of the time (bass notes swing in and out of phase note by note); with these rules it's 4%, never long enough to alert, and the same recordings with one channel inverted still read PHASE PROBLEM 95–100% of the time.
- A worse word is held for 3 s.
- It goes out as `frame.stereoStatus` / `stereoDetail` and in rows, plus the CSV columns `stereo_status`, `stereo_detail` and `balance_db`.
- A change of status is logged (analyzer event `stereo`, shown as "Stereo: WIDE" etc.) once the new status has been judged for `STEREO_RULES.logSeconds` (10 s) in a row (a second too quiet to judge breaks the run), dated from when it began; file analysis logs MONO / UNBALANCED / CHANNEL DEAD / STEREO (none of those). The log keeps entries in time order (`insertByTime` in `log.js`), as these arrive late. On the stereo test recordings that is 10–25 log lines an hour for studio mixes; a 5 s hold gave up to 120 an hour on an orchestral recording.
- It drives the Stereo card's badge and the alerts `stereoPhase` (5 s), `stereoBalance` (15 s) and `stereoMono` (opt-in), set in the alert config's `stereo` section.
- File-analysis rows have only MONO, UNBALANCED (a lopsided mono feed), CHANNEL DEAD or nothing, because the worker skips the band filters (they would slow analysis by about two-thirds).
- Identical-but-lopsided channels (correlation above 0.999, more than `unbalancedDb` apart) read UNBALANCED, not MONO (`monoStatus`).

**Pan map.** `PanGrid` (`src/dsp/pan.js`) places each FFT bin of separate L and R `AnalyserNode` spectra by (R² − L²)/(R² + L²) in ⅓-octave rows (29 × 41 cells), averaged over about 1 s for the display and per second (`takeSecond`) for the CSV. `src/ui/pan-map.js` (`PanMapView`) only draws a grid it is given: `setGrid` live, `showSaved` for a CSV second.
- `engine.analyserL` / `analyserR` sit behind a `ChannelSplitterNode`. The web app's `app.js` owns a `PanGrid`.
- In the extension the offscreen document owns it (fed every frame, for the CSV) and the `spectrum` message carries its finished grid as `pan` (1189 values), not the two channel spectra.
- Cells are drawn hard-edged (no image smoothing); brightness is relative to the loudest cell over 45 dB.
- Rows (⅓ octaves) below −75 dBFS (`ROW_FLOOR_DB`, from `STEREO_RULES.judgeDb`) stay dark, so mic hiss doesn't read as a wide image. Row levels are summed AnalyserNode bin powers plus 9 dB (`BIN_SUM_TO_DBFS`, measured with noise).
- The edge columns hold everything 19 dB or more louder on one side; they're labelled `L ≥19` / `R ≥19`, not "only".

### Browser side

- **`src/audio/engine.js`** builds the graph: source → input gain → worklet (muted output to the destination, which keeps it pulled) plus an AnalyserNode. The AnalyserNode is for the spectrum display only; all measurements come from raw samples. The one exception is the CSV's `spectrum` column: the spectrum bars as shown (smoothing 0.5, read when each frame's message arrives), display-grade, so repeated runs of the same audio differ slightly; nothing is judged from them. FFT sizes are `SPECTRUM_FFT_SIZE` / `FINE_FFT_SIZE` in `bands.js`.
- **Sample rates:** the AudioContext is created at the source's rate. `sniffSampleRate` parses WAV, FLAC, MP4, Ogg (Opus/Vorbis), WebM, ADTS AAC and MP3 headers (MP3 and ADTS only with two frames in a row) before decoding so `decodeAudioData` doesn't resample, because resampling smears plateaus.
- **File mode:** `analyseBuffer` sends 10 s chunks to the Worker and waits for an `ack` before the next (flow control). Playback runs through the same worklet. The worklet is reset on every seek, so `app.js` adds `state.playOffset` to row times.
- **Saved CSVs in File mode** (`openCsv` in `app.js`, `src/dsp/session-csv.js`). `CSV_COLUMNS` in `report.js` is the one list for export and import (`{ name, field, get, parse }`); add new columns only at the end. The last three (`fullscale_samples`, `integrated_s`, `hum_pause_readings`, since 2026-10-30) exist so a saved session replays like the live one. `readSessionCsv` finds columns by name and fills in what older files lack where it can: mono from the correlation before `stereo_status` (2026-10-22), a stereo reason before `stereo_detail` (10-25; a dead channel's side can't be known, so "One channel silent" and the alert says "only one side"), one pause reading per pause second before `hum_pause_readings`. `fileAnalysis` (no wall clock anywhere) means ordinary stereo was left blank, so the replay reads blank as STEREO, as the analyzer does. Clocks re-saved by a spreadsheet are read too (`parseWallClock`): Excel and Google Sheets turn `2026-10-31 07:42:33` into a local date without seconds (`31/10/2026 7:42`, or month first with AM/PM); day/month order is taken from a number over 12, else this computer's own order, and the start is recovered to within a second from the row where the minute changes (`sessionStart`). Row clocks are then rebuilt from the start and elapsed time. Silence (−∞) is written blank since 2026-10-31: spreadsheets read `-inf` as a formula and save `#NAME?` (older files' `-inf` still parses; error values read as blank). Tested by the user in both, including deleting a row. `sessionEvents` replays the log rules, `sessionSummary` the summary line (status rule shared with the analyzer: `sessionStatus` in `clipdetect.js`); alerts come from `AlertMonitor` over the rows as for audio files, and a settings change rebuilds the log on the same moment. `state.file.csv`: no Play button or hum listening, rows are not put in the 12 h `SessionRecorder` (Export CSV writes `f.rows`), and clicks call `showMoment(row)`: the timeline's row is `timeline.nearest(t)` (the same as its tooltip), a log entry's is `rowAt` (the second it happened in; `EventLog` passes the entry's own time, and the 2 s lead-in before playback is added in `seekFile` for audio). The opening is cancellable (`fileJob`) like audio analysis. The ←/→ keys step 1 s (Shift 10 s, Ctrl 60 s; `SCRUB_KEYS`, ignored in form fields and the settings dialog). Holding the mouse down and dragging along the timeline scrubs (`TimeChart` `onScrub`, at most once per animation frame, with pointer capture); `TimeChart` keeps the plot as a cached image (`stale` after `setData`/`resize`) and only redraws the playhead and hover marks on top, which took scrubbing a 2-hour CSV from about 90 to 25 ms a step headless. Since 2026-10-31 a live row also carries `bands` (`StereoBands.current` of the last frame, the 1 s readings; null from the file worker), `spectrumDb` (the second's 1/3-octave levels, power mean of the frames: `SpectrumSecond` in `bands.js`, fed from the page's analyser in `app.js` and, every frame whether a dashboard is open or not, in `offscreen.js`) and the second's full pan grid, written as three encoded columns at the end, `stereo_bands`, `spectrum`, `pan_map` (`src/dsp/csv-codec.js`). The encodings are spreadsheet-safe text: URL-safe base64 only (A–Z a–z 0–9 - _), always starting with a lowercase tag and version (`b1`, `s1`, `p1`, regex `SAFE_CODE`), so Excel and Sheets never read them as formulas, numbers or dates and re-save them unchanged. `s1`: one level byte per band (0.5 dB, 0 = −∞). `b1`: per octave, correlation int16 (1/32767), balance int16 (0.01 dB), level byte. `p1`: per band its loudest cell as a level byte and every cell in 3 dB steps over the 45 dB display range (4 bits), deflate-raw compressed. Packing (`packPan`/`unpackPan`) is pure and in `src/dsp/csv-codec.js`; compressing needs `CompressionStream` (a browser / Node 20.12+ API, so not in `src/dsp`) and is in `src/ui/pan-codec.js` (`encodePan`/`decodePan`, async). Live rows go into the recorder with `SessionRecorder.addLive(row, panGrid)`, used by both `app.js` and `offscreen.js`: in order, dropped if `clear()` came first, and a compression that fails or takes over 5 s leaves the cell empty rather than hold up the rows after it; `stopDisk`, Export CSV and the extension's `get-csv` wait for `recorder.later`. `attach()` (starting a disk recording) takes its snapshot and row count together, so a row finished while the file opens goes in the next commit. Damaged encoded cells read as null (that second's chart only). Level columns (momentary, short-term, integrated, peaks, RMS, ceiling) read a blank cell as silence (−∞); the alerts and chips also ignore non-finite values, so a reopened silent stretch can't raise "too loud" or "true peak". Measured: ~840 bytes a second for a stereo studio track (2 h ≈ 6 MB), about half that for mostly speech. A CSV's pan map stays encoded (`row.panCode`) until a moment is shown (`showSavedPan` decodes it; the last 30 decoded grids stay on their rows). In a CSV moment, `MetersView.renderFrame(row)` draws Stereo by band from `row.bands`, `SpectrumView.showSaved(rows, i)` the bars, the 5 s average line, the octave balance (octaves summed from their three bands) and a coarse spectrogram, painted in `render()` (at most once per UI tick): `SAVED_ROW_PX` (4) CSS pixel rows per second, each column its band's level spread back over its FFT bins (as if 8192/32768-point at 48 kHz) so the colours land near the live ones (the hover adds it back to show the band level), time labels every 30 s (live ones stay in seconds). Arrow keys step by rows (`stepRows`, so a gap in the rows can't stop them), coalesced per animation frame; a scrub only starts when `canScrub()` (a CSV), and ends on release, lost capture or a move without the button. The web app and the extension keep `bands`/`spectrumDb` out of their view history and messages (only the CSV uses them). The 146 plain columns this replaced (one morning's test files) are no longer read. Not in a CSV: hum harmonics and pause lines, integrated resets (the JSON log has them).
- **Event log rules** live in `src/dsp/episodes.js` (`ClipEpisodes`, `StereoLog`, `HumLog`, `HUM_LOG`), used by `StreamAnalyzer` and by the CSV replay, so both logs follow the same rules (a test checks a round trip gives the same events).
- **`src/ui/app.js`** is the web app's controller. Meter rendering, alert banners and the history/peak chart set-ups live in `src/ui/meters.js`, shared with the extension; its elements are looked up by id and are all optional. `bindMeterResets` makes the true-peak (`#tp-tile`) and integrated (`#int-tile`) cards click-to-reset (`StreamAnalyzer.resetPeaks()` / `resetIntegrated()`, via the worklet port, or a `reset` message to the extension's offscreen document). The **Reset** button (`resetLive` in `app.js`; a `reset` message with `what: 'all'` to the offscreen document) starts a fresh session on the running source: `AudioEngine.reset()` resets the worklet's analyzer (time back to 0) and drops frames still in flight until the worklet acknowledges, then the session state is cleared with a new `startWall`. In the web app it also closes a "Record CSV to disk" file first. With more than 10 minutes of data, Reset asks first (both apps). Overlapping resets are counted; `seek()` in file mode uses the same reset, so rows from the old position are dropped. `request()` (finish/summary) tags each request with an id, and `close()` detaches the worklet port so nothing measured after Stop reaches the page. Rows carry `integratedSeconds` (since the last integrated reset), which the `integratedOff` alert's minimum time uses. Alerts (`AlertMonitor`) run only for live sources. Wall-clock time is `startWall + t` from the audio clock, not when a message arrives.
- **Spectrum area (`src/ui/spectrum.js`):**
  - The ⅓-octave bars and the vertical spectrogram under them share one log frequency axis (the outer edges of the first and last band) and the same plot margins, so each bar sits over its own stretch of the spectrogram.
  - The spectrogram keeps one byte per pixel (the colour index) plus each row's audio-clock frame time, which is what its hover reads.
  - It scrolls one row per 100 ms analyzer frame, timed by the audio clock, so the history length is set by the canvas height. Data goes in with `update()`/`updateData()` as frames arrive (also while the page is hidden, when Chrome stops animation frames); drawing (and the Octave balance DOM) happens in `render()` on the UI tick. The pan map works the same way. The averages' time steps come from the frame times (`frameStep` in `format.js`), and data without a frame time is dropped. Rows added per UI tick left gaps behind other windows and made the time labels jitter (ticks land 100 or 117 ms apart).
  - **Below 200 Hz (`FINE_MAX_HZ`) the bars, the octave balance and the spectrogram use a second, 32768-point analyser** (`engine.analyserFine`, read with `readFine`; in the extension the `spectrum` message carries `fine: { db, binHz }`, a few hundred bins). The 8192-point one has 5.9 Hz bins at 48 kHz and spreads a tone over about ±18 Hz, so a 50 Hz hum was drawn as a 41–65 Hz band and a 60 Hz note lit the 50 Hz bar only 9 dB down (now about 75 dB). `bandLevels(…, fine)` takes bands ending below the fine data's last bin from it. Spectrogram columns from it are not level-corrected: a tone reads the same in both (the point: naming hum and other steady tones), while broadband sound reads about 6 dB lower per bin below 200 Hz. That part also looks smoother over time and lags about 0.25 s (0.7 s window); accepted, display only.
  - Its colour scale runs from a floor (default −85 dB, was −100, `display.spectrogramFloorDb` in the settings, `setSpectrogramFloor`) to −10 dB; changing the floor re-maps the stored history. The spectrum bars' axis stays at −100.
  - The 5 s average line carries the octave balance readings (dB vs 500 Hz) at each octave centre, the same values the Octave balance panel shows (`balanceDb`).
- **Column heights are balanced by hand.** In `index.html` and `extension/dashboard.html`:
  - the `#sgram` height attribute is chosen so the spectrum panel ends level with the right-hand column (Stereo by band + Pan map);
  - the `#peaks` height is chosen so the peak chart matches the loudness history (which also draws the stereo correlation, on a right-hand scale).
  - After changing either column, re-measure in a browser and adjust that height.
  - Also update the size limit in the "spectrum canvases keep their size" checks in `test/e2e.mjs` and `test/e2e-extension.mjs`.
- **Top row widths are measured too** (`.readouts` in `css/app.css`). From 101.25em (1620 px) up, each card's width fits its widest line with worst-case readings and chips, measured with DejaVu Sans, which is wider than Segoe UI. With those widths no line wraps, so the row never changes height.
  - The four number cards share one width so their numbers stay the same size.
  - Clipping status and Stereo share what's left.
  - Narrower windows use the old auto-fit grid, with room for two lines kept for the Stereo line.
  - After changing a card's text (status or stereo `detail` strings, chips, labels), re-measure the widest lines and adjust the `minmax` values.
- **Hover help:** every meter tile and panel heading carries `data-help="<key>"`. In the extension side panel, `setupHelp(doc, { iconOnly: true })` replaces the CSS-drawn (i) icons with real `.help-icon` elements, and help shows only while the pointer is on one; on the user's request it no longer pops up over the readings there. The volunteer-facing text for each key lives only in `HELP` in `src/ui/help.js`, shared by all three pages. `test/help.test.js` fails if a card has no key or a key has no text.
- **Styling:**
  - The UI is dark-only.
  - Status colours (good / warning / critical) are reserved for states: the clip status, the hum status and the stereo status. They always come with a text label and an icon, and are never used for data series.
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
  - It only sends spectrum data while a dashboard keeps sending `want-spectrum` (tracked per view id: each request lasts 75 s, since a hidden dashboard's timers may fire only once a minute, and a view's `no-spectrum` on pagehide ends only its own). It sends one `spectrum` message per analyzer frame, stamped with the frame's `t`.
- **Views:** `panel.html` (side panel) and `dashboard.html` both run `view.js`, keyed on the same element ids as the web app. The side panel is deliberately compact: no hum panel (hum alerts still show), no spectrum or stereo views.
  - They talk to the offscreen document over the `BroadcastChannel` in `client.js`: `hello` → `snapshot`, then `frame` / `row` / `log` / `alerts` / `session` / `spectrum`.
  - Exports use `get-csv` / `get-json` request–reply messages.
- **Alert settings:** stored in `localStorage` via `src/ui/settings.js` (the extension origin is shared). The offscreen document reloads them on the `storage` event.
- **`player.js`:** reads the YouTube player through `chrome.scripting.executeScript` (MAIN world).
  - `getVolume()` and `isMuted()` are relied on.
  - `getStatsForNerds()` "content loudness" is undocumented and treated as best effort.
- **Testing:** real tab capture needs a physical toolbar click, so `test/e2e-extension.mjs` uses the service worker's `self.streammonTestStart(url)` hook. It feeds a WAV through the same offscreen pipeline (`<audio>.captureStream()`), and everything after capture is tested for real. The `getMediaStreamId` → tab-capture path itself is only exercised by hand.

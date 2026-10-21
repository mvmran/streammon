# Chrome Web Store listing

Copy-paste material for the Chrome Web Store Developer Dashboard. Upload
`dist/streammon-extension-<version>.zip` (from `npm run build:extension`). The images in
this folder are regenerated with `npm run store:assets`.

## Store listing tab

**Name:** Stream Audio Monitor (from the manifest)

**Summary** (from the manifest, ≤ 132 characters):
Monitors a YouTube stream's audio as viewers hear it: loudness, true peak and clipping below 0 dBFS.

**Category:** Tools  **Language:** English

**Description:**

```
Stream Audio Monitor checks the audio of your YouTube live stream (or any YouTube video) exactly as your viewers hear it, and warns you when something is wrong.

It was built for church and community live streams, where a stage before the stream encoder can clip and the level is then turned down. That clipping sits below 0 dBFS, so ordinary "over" meters never light up, but viewers hear the harsh distortion. Stream Audio Monitor detects it from the shape of the waveform.

HOW TO USE
1. Open your YouTube stream. Set the player volume to 100% and turn Stable Volume off.
2. Click the Stream Audio Monitor toolbar button. Monitoring starts and the side panel opens; you keep hearing the stream.
3. Watch the big status: CLEAN (green), LIMITED (amber: a limiter is holding the peaks) or CLIPPING (red: the waveform has been cut flat). The toolbar badge shows OK / LIM / CLIP even with the panel closed.

WHAT IT MEASURES
• Clipping, including clipping below 0 dBFS (flat-topped plateaus) and at digital full scale
• Limiting: peaks pinned at one level
• Loudness to EBU R128 / ITU-R BS.1770-4: short-term, momentary, integrated (LUFS) and loudness range (LRA)
• True peak (dBTP) with 4x oversampling
• Crest factor, stereo correlation and a MONO indicator
• Stereo by band: correlation and left/right balance for each octave, to spot phase and balance problems (in the full dashboard)
• Mains hum detection (50 or 60 Hz): present / not detected / masked by music, level, harmonics, and how loud it would be if the speech were turned up
• Spectrum, spectrogram and octave balance, with hover readings (in the full dashboard)

ALERTS AND RECORDS
• Banner and Chrome notification alerts for clipping, true peak above -1 dBTP, sustained loudness above -10 LUFS and integrated loudness far from -14 LUFS (all adjustable; optional beep, off by default)
• Timestamped event log
• Export the session as CSV (one row per second) or a JSON summary
• Hover the ⓘ on any card for a plain-language explanation

PRIVATE BY DESIGN
All analysis happens inside your browser. No audio or data is uploaded, and the extension contains no analytics or tracking.

Note: YouTube audio reaches viewers 5–30 seconds after it leaves the mixing desk, so alerts reflect what viewers heard a few seconds ago.

Free and open source (GPL-3.0): https://github.com/mvmran/streammon
```

**Graphic assets:**

- Store icon: `extension/icons/icon128.png`
- Screenshots (1280×800): `store/screenshot-1-dashboard.png`, `store/screenshot-2-side-panel.png`
- Small promo tile (440×280): `store/promo-small-440x280.png`

**Homepage URL:** https://github.com/mvmran/streammon
**Support URL:** https://github.com/mvmran/streammon/issues

## Privacy practices tab

**Single purpose:**

```
Measures the audio of a YouTube tab the user chooses (loudness, true peak, clipping and limiting) and alerts the user to audio problems on their live stream.
```

**Permission justifications:**

| Permission | Justification |
|---|---|
| tabCapture | Captures the audio of the YouTube tab the user starts monitoring by clicking the toolbar button, so it can be measured. |
| offscreen | Runs the audio capture and analysis in an offscreen document so monitoring continues while the user works in other tabs during a live stream. |
| sidePanel | Shows the meters, status and event log in the side panel next to the video. |
| scripting | Reads the YouTube player's volume, mute state and loudness normalisation on the monitored tab, to warn the user when these change the measured levels. Nothing else on the page is read. |
| notifications | Alerts the user when clipping or other audio problems are detected while they are working in another window. |
| declarativeContent | Enables the toolbar button only on YouTube pages, the only pages the extension works on. |
| Host permission (www.youtube.com, m.youtube.com) | Needed by the scripting permission to read the YouTube player's volume and normalisation settings on the monitored tab. |

**Remote code:** No, I am not using remote code.

**Data usage:** tick none of the data types (the extension collects no user data). Tick all three certifications:

- I do not sell or transfer user data to third parties, outside of the approved use cases
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose
- I do not use or transfer user data to determine creditworthiness or for lending purposes

**Privacy policy URL:** https://github.com/mvmran/streammon/blob/main/PRIVACY.md

## Distribution tab

**Visibility:** choose when submitting. *Unlisted* (installable by link only) suits a church
team, and it can be changed to *Public* later.

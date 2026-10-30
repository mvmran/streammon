# Changelog

The Chrome extension's versions. The web app (https://mvmran.github.io/streammon/) is
always the latest code, so it gets each change as soon as it is made. Release notes for
every version, with the extension zip: https://github.com/mvmran/streammon/releases

## 1.1.6 (2026-10-31)

### New
- **Hum in pauses:** mains buzz is measured whenever it goes quiet, which is when people
  hear it on laptop and phone speakers (mostly 150–450 Hz). Shown as "Buzz in pauses" in
  the hum panel, alert "Hum in pauses" at −80 dBFS (adjustable), CSV column
  `hum_pause_dbfs`.
- **A richer CSV:** each second also records Stereo by band, the ⅓-octave spectrum and the
  full pan map, in three compact columns (`stereo_bands`, `spectrum`, `pan_map`) that are
  safe to open, edit and re-save in Excel or Google Sheets; and `fullscale_samples`,
  `integrated_s`, `hum_pause_readings`. New columns are at the end of each row.
- **Review a saved CSV in the web app** (File mode): summary, timeline, the event log
  rebuilt with clock times, and every reading, chart, Stereo by band, spectrum and pan map
  at any moment. Click, drag along the timeline, or step with the arrow keys.

### Changed
- **Finer spectrum below 200 Hz:** hum shows as a thin line instead of a 45–55 Hz band, and
  bass notes no longer light the neighbouring bars.
- **Defaults:** hum alert at −85 dBFS (was −75), spectrogram floor −85 dB (was −100). Saved
  settings that still hold the old defaults move to the new ones.
- **Hum in the event log:** only hum at or above the alert level, once it has lasted 10 s,
  ending after 30 s without it (a faint hum at the edge of detection had filled the log).
- **Hum panel:** NOT DETECTED mentions buzz found in recent pauses instead of saying
  "nothing", and ordinary speech reads NOT DETECTED again, not MASKED.
- **Dashboard:** the extension sends the dashboard the finished pan map instead of both
  channel spectra (about 7 times less data).

### Fixed
- The hum level and frequency in the 2 s after a hum fades no longer show the bass note
  that covered it (seen as a "−37 dBFS hum").
- Silent seconds are written to the CSV as blank cells (spreadsheets turned `-inf` into
  `#NAME?`).
- The peak chart's true-peak limit line follows a settings change.

## Earlier versions

See https://github.com/mvmran/streammon/releases (1.0.0 to 1.1.5, 2026-10-20 to 10-28).

# Privacy policy: Stream Audio Monitor

*Applies to the Stream Audio Monitor Chrome extension and web app. Last updated 20 October 2026.*

**Stream Audio Monitor does not collect, store on any server, sell or share any data.**

## What it does with audio

When you click the toolbar button on a YouTube tab, the extension captures that tab's audio
and analyses it **inside your browser** to measure loudness, peaks and clipping. The audio is
played back to you as normal. It is never recorded to disk, uploaded or sent anywhere.

The web app works the same way for an audio input device, a browser tab you choose to share,
or a file you open. Files are read and analysed locally and are never uploaded.

## What it keeps, and where

- **Measurements** for the current session (loudness history, event log, one row of numbers per
  second) are kept in the browser's memory. They are discarded when monitoring is restarted or
  the browser closes.
- **Exports** (CSV / JSON) are written only when you click an export button, to a file you choose
  on your own computer.
- **Alert settings** (thresholds, sound on/off) are saved in the browser's local storage on your
  computer.

## What it reads from YouTube

While monitoring a YouTube tab, the extension reads the YouTube player's volume, mute state and,
where available, its loudness normalisation figure. This is only to warn you when those settings
change the measured levels. Nothing else on the page is read, and none of it leaves your browser.

## Permissions

| Permission | Why |
|---|---|
| `tabCapture` | Capture the audio of the YouTube tab you start monitoring |
| `offscreen` | Keep analysing in the background while you use other tabs |
| `sidePanel` | Show the meters next to the video |
| `scripting` + access to youtube.com | Read the YouTube player's volume / normalisation settings |
| `notifications` | Alert you when clipping or other problems are detected |
| `declarativeContent` | Enable the toolbar button only on YouTube pages |

## No third parties

The extension makes no network requests of its own. It contains no analytics, advertising or
tracking code.

## Contact

Questions or problems: open an issue at <https://github.com/mvmran/streammon/issues>.

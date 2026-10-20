// Audio sources: input devices, browser-tab capture and files.

// Raw capture: every browser "voice" process off so levels and waveforms are untouched.
const RAW = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };

export async function listInputDevices() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((d) => d.kind === 'audioinput');
}

// Labels are empty until the user has granted microphone permission once.
export function devicesHaveLabels(devices) {
  return devices.some((d) => d.label);
}

export async function openInputDevice(deviceId) {
  return navigator.mediaDevices.getUserMedia({
    audio: { ...RAW, deviceId: deviceId ? { exact: deviceId } : undefined, channelCount: { ideal: 2 } },
    video: false,
  });
}

// Tab capture. Chrome requires video: true; the video track is stopped immediately.
export async function openTabCapture() {
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: true,
    audio: { ...RAW, suppressLocalAudioPlayback: false },
    preferCurrentTab: false,
    selfBrowserSurface: 'exclude',
    surfaceSwitching: 'include',
    systemAudio: 'include',
  });
  for (const t of stream.getVideoTracks()) {
    t.stop();
    stream.removeTrack(t);
  }
  if (stream.getAudioTracks().length === 0) {
    throw new Error('No audio was shared. Choose a Chrome tab and tick "Also share tab audio".');
  }
  return stream;
}

export function streamSampleRate(stream) {
  const track = stream.getAudioTracks()[0];
  const s = track && track.getSettings ? track.getSettings() : {};
  return s.sampleRate || undefined;
}

// Best-effort native sample rate of an encoded file, so decoding doesn't resample
// (resampling smears clipped plateaus). Falls back to 48 kHz, YouTube's audio rate.
export function sniffSampleRate(buf) {
  const u8 = new Uint8Array(buf);
  const dv = new DataView(buf);
  const tag = (o) => String.fromCharCode(u8[o], u8[o + 1], u8[o + 2], u8[o + 3]);
  try {
    if (tag(0) === 'RIFF' && tag(8) === 'WAVE') {
      for (let o = 12; o + 8 < u8.length; ) {
        const len = dv.getUint32(o + 4, true);
        if (tag(o) === 'fmt ') return dv.getUint32(o + 12, true);
        o += 8 + len + (len & 1);
      }
    }
    if (tag(0) === 'fLaC') return (dv.getUint32(18) >>> 12) & 0xfffff;
    if (tag(0) === 'OggS') return 48000;
    // MP4/M4A: the 'mp4a' sample entry holds the rate as 16.16 fixed point.
    for (let o = 4; o + 32 < u8.length; o++) {
      if (u8[o] === 0x6d && u8[o + 1] === 0x70 && u8[o + 2] === 0x34 && u8[o + 3] === 0x61) {
        const rate = dv.getUint16(o + 28);
        if (rate >= 8000 && rate <= 192000) return rate;
      }
      if (o > 4 && tag(4) !== 'ftyp') break; // not MP4: stop scanning
    }
    // MP3: skip ID3v2, then read the first frame header.
    let o = 0;
    if (u8[0] === 0x49 && u8[1] === 0x44 && u8[2] === 0x33) {
      o = 10 + ((u8[6] & 0x7f) << 21 | (u8[7] & 0x7f) << 14 | (u8[8] & 0x7f) << 7 | (u8[9] & 0x7f));
    }
    for (const end = Math.min(u8.length - 4, o + 65536); o < end; o++) {
      if (u8[o] === 0xff && (u8[o + 1] & 0xe0) === 0xe0) {
        const version = (u8[o + 1] >> 3) & 3;
        const idx = (u8[o + 2] >> 2) & 3;
        if (version === 1 || idx === 3) continue;
        const base = [44100, 48000, 32000][idx];
        return version === 3 ? base : version === 2 ? base / 2 : base / 4;
      }
    }
  } catch {
    // Fall through to the default.
  }
  return 48000;
}

export async function decodeFile(file) {
  const buf = await file.arrayBuffer();
  const sampleRate = sniffSampleRate(buf);
  const ctx = new OfflineAudioContext(2, 1, sampleRate);
  return ctx.decodeAudioData(buf);
}

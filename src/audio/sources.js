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
// (resampling smears clipped plateaus). Each format is recognised by its own header;
// anything else falls back to 48 kHz, YouTube's audio rate.
export function sniffSampleRate(buf) {
  const u8 = new Uint8Array(buf);
  const dv = new DataView(buf);
  const tag = (o) => String.fromCharCode(u8[o], u8[o + 1], u8[o + 2], u8[o + 3]);
  const plausible = (r) => (Number.isInteger(r) && r >= 8000 && r <= 384000 ? r : null);
  try {
    if (tag(0) === 'RIFF' && tag(8) === 'WAVE') {
      for (let o = 12; o + 8 < u8.length; ) {
        const len = dv.getUint32(o + 4, true);
        if (tag(o) === 'fmt ') return dv.getUint32(o + 12, true);
        o += 8 + len + (len & 1);
      }
    }
    // An ID3v2 tag can precede FLAC, ADTS AAC and MP3.
    let o = 0;
    if (u8[0] === 0x49 && u8[1] === 0x44 && u8[2] === 0x33) {
      o = 10 + ((u8[6] & 0x7f) << 21 | (u8[7] & 0x7f) << 14 | (u8[8] & 0x7f) << 7 | (u8[9] & 0x7f));
    }
    if (tag(o) === 'fLaC') return (dv.getUint32(o + 18) >>> 12) & 0xfffff;
    if (tag(0) === 'OggS') return oggRate();
    if (dv.getUint32(0) === 0x1a45dfa3) return webmRate() || 48000;
    if (tag(4) === 'ftyp') return mp4Rate() || 48000;
    return adtsRate(o) || mp3Rate(o) || 48000;
  } catch {
    // Fall through to the default.
  }
  return 48000;

  // Ogg: Opus always decodes at 48 kHz; Vorbis gives its rate in the identification header.
  function oggRate() {
    const body = 27 + u8[26]; // page header plus its segment table
    if (String.fromCharCode(...u8.subarray(body, body + 8)) === 'OpusHead') return 48000;
    if (u8[body] === 1 && String.fromCharCode(...u8.subarray(body + 1, body + 7)) === 'vorbis') {
      return plausible(dv.getUint32(body + 12, true)) || 48000;
    }
    return 48000;
  }

  // WebM/Matroska: the SamplingFrequency element (ID 0xB5) holds a 4- or 8-byte float.
  // Only the headers before the first Cluster (0x1F43B675) are searched.
  function webmRate() {
    for (let i = 4, end = Math.min(u8.length - 9, 1 << 16); i < end; i++) {
      if (u8[i] === 0x1f && u8[i + 1] === 0x43 && u8[i + 2] === 0xb6 && u8[i + 3] === 0x75) break;
      if (u8[i] !== 0xb5) continue;
      const r = u8[i + 1] === 0x88 ? dv.getFloat64(i + 2) : u8[i + 1] === 0x84 ? dv.getFloat32(i + 2) : NaN;
      if (plausible(r)) return r;
    }
    return null;
  }

  // MP4/M4A: the 'mp4a' sample entry inside the 'moov' box (found by walking the top-level
  // boxes, as it can sit at either end of the file) holds the rate as 16.16 fixed point.
  function mp4Rate() {
    let moov = null;
    for (let i = 0; i + 8 <= u8.length; ) {
      let size = dv.getUint32(i);
      if (size === 1) size = Number(dv.getBigUint64(i + 8));
      else if (size === 0) size = u8.length - i;
      if (tag(i + 4) === 'moov') {
        moov = [i, Math.min(u8.length, i + size)];
        break;
      }
      if (size < 8) return null;
      i += size;
    }
    if (!moov) return null;
    for (let i = moov[0] + 8; i + 30 <= moov[1]; i++) {
      if (u8[i] === 0x6d && u8[i + 1] === 0x70 && u8[i + 2] === 0x34 && u8[i + 3] === 0x61) {
        const r = plausible(dv.getUint16(i + 28));
        if (r) return r;
      }
    }
    return null;
  }

  // ADTS AAC (.aac): a 0xFFF sync with layer 0 and two frames in a row.
  function adtsRate(start) {
    const RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
    const at = (i) => u8[i] === 0xff && (u8[i + 1] & 0xf6) === 0xf0;
    if (!at(start)) return null;
    const idx = (u8[start + 2] >> 2) & 0xf;
    const len = ((u8[start + 3] & 3) << 11) | (u8[start + 4] << 3) | (u8[start + 5] >> 5);
    if (idx >= RATES.length || len < 7 || !at(start + len) || ((u8[start + len + 2] >> 2) & 0xf) !== idx) return null;
    return RATES[idx];
  }

  // MP3 (MPEG audio layer III): the first frame header that is followed by a second one
  // exactly one frame later, so compressed bytes that happen to look like a sync don't count.
  function mp3Rate(start) {
    const KBPS = { 1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320], 2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160] };
    const header = (i) => {
      if (u8[i] !== 0xff || (u8[i + 1] & 0xe0) !== 0xe0) return null;
      const version = (u8[i + 1] >> 3) & 3; // 3 = MPEG-1, 2 = MPEG-2, 0 = MPEG-2.5
      const layer = (u8[i + 1] >> 1) & 3; // 1 = layer III
      const br = u8[i + 2] >> 4, idx = (u8[i + 2] >> 2) & 3, pad = (u8[i + 2] >> 1) & 1;
      if (version === 1 || layer !== 1 || br === 0 || br === 15 || idx === 3) return null;
      const rate = [44100, 48000, 32000][idx] / (version === 3 ? 1 : version === 2 ? 2 : 4);
      const kbps = KBPS[version === 3 ? 1 : 2][br];
      const len = Math.floor(((version === 3 ? 144000 : 72000) * kbps) / rate) + pad;
      return { rate, len, version };
    };
    for (let i = start, end = Math.min(u8.length - 4, start + (1 << 16)); i < end; i++) {
      const h = header(i);
      if (!h || i + h.len + 4 > u8.length) continue;
      const next = header(i + h.len);
      if (next && next.rate === h.rate && next.version === h.version) return h.rate;
    }
    return null;
  }
}

export async function decodeFile(file) {
  const buf = await file.arrayBuffer();
  const sampleRate = sniffSampleRate(buf);
  const ctx = new OfflineAudioContext(2, 1, sampleRate);
  return ctx.decodeAudioData(buf);
}

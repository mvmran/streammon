// Minimal WAV decoder for the Node test harness.
// Supports PCM integer (8/16/24/32-bit) and IEEE float (32/64-bit), including WAVE_FORMAT_EXTENSIBLE.

import { readFileSync } from 'node:fs';

export function decodeWav(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const tag = (o) => String.fromCharCode(buf[o], buf[o + 1], buf[o + 2], buf[o + 3]);
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('Not a RIFF/WAVE file');

  let fmt = null;
  let dataOff = -1;
  let dataLen = 0;
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = tag(off);
    const len = dv.getUint32(off + 4, true);
    const body = off + 8;
    if (id === 'fmt ') {
      let format = dv.getUint16(body, true);
      const channels = dv.getUint16(body + 2, true);
      const sampleRate = dv.getUint32(body + 4, true);
      const bits = dv.getUint16(body + 14, true);
      if (format === 0xfffe && len >= 26) format = dv.getUint16(body + 24, true);
      fmt = { format, channels, sampleRate, bits };
    } else if (id === 'data') {
      dataOff = body;
      dataLen = Math.min(len, buf.length - body);
      break;
    }
    off = body + len + (len & 1);
  }
  if (!fmt || dataOff < 0) throw new Error('Missing fmt or data chunk');

  const { format, channels, sampleRate, bits } = fmt;
  const bytes = bits / 8;
  const frames = Math.floor(dataLen / (bytes * channels));
  const out = Array.from({ length: channels }, () => new Float32Array(frames));

  let read;
  if (format === 1) {
    if (bits === 8) read = (o) => (dv.getUint8(o) - 128) / 128;
    else if (bits === 16) read = (o) => dv.getInt16(o, true) / 32768;
    else if (bits === 24) read = (o) => ((dv.getUint8(o) | (dv.getUint8(o + 1) << 8) | (dv.getInt8(o + 2) << 16))) / 8388608;
    else if (bits === 32) read = (o) => dv.getInt32(o, true) / 2147483648;
  } else if (format === 3) {
    if (bits === 32) read = (o) => dv.getFloat32(o, true);
    else if (bits === 64) read = (o) => dv.getFloat64(o, true);
  }
  if (!read) throw new Error(`Unsupported WAV format ${format} / ${bits}-bit`);

  for (let i = 0, o = dataOff; i < frames; i++) {
    for (let c = 0; c < channels; c++, o += bytes) out[c][i] = read(o);
  }
  return { sampleRate, channels: out };
}

export function readWav(path) {
  return decodeWav(readFileSync(path));
}

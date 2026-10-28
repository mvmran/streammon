// sniffSampleRate (src/audio/sources.js): the rate each file format declares, so decoding
// doesn't resample. Built from minimal headers; random compressed bytes must not count.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sniffSampleRate } from '../src/audio/sources.js';

const bytes = (...parts) => {
  const out = [];
  for (const p of parts) typeof p === 'string' ? out.push(...[...p].map((c) => c.charCodeAt(0))) : out.push(...p);
  return new Uint8Array(out);
};
const u32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const u32le = (n) => u32(n).reverse();
const buf = (u8, pad = 0) => {
  const b = new Uint8Array(u8.length + pad);
  b.set(u8);
  return b.buffer;
};
let seed = 11;
const noise = (n) => Uint8Array.from({ length: n }, () => ((seed = (seed * 1103515245 + 12345) >>> 0) >>> 24));

test('WAV and FLAC (also after an ID3 tag)', () => {
  const wav = bytes('RIFF', u32le(36), 'WAVE', 'fmt ', u32le(16), [1, 0, 2, 0], u32le(44100), u32le(176400), [4, 0, 16, 0], 'data', u32le(0));
  assert.equal(sniffSampleRate(buf(wav)), 44100);
  // STREAMINFO: 20 bits of rate starting at byte 18 after 'fLaC'.
  const flac = (rate) => { const b = new Uint8Array(42); b.set(bytes('fLaC')); new DataView(b.buffer).setUint32(18, (rate << 12) >>> 0); return b; };
  assert.equal(sniffSampleRate(buf(flac(96000))), 96000);
  const id3 = bytes('ID3', [4, 0, 0, 0, 0, 0, 20], new Uint8Array(20));
  assert.equal(sniffSampleRate(buf(bytes(id3, flac(44100)))), 44100);
});

test('Ogg: Opus is 48 kHz, Vorbis gives its rate', () => {
  const page = (packet) => bytes('OggS', [0, 2], new Uint8Array(20), [1, packet.length], packet);
  assert.equal(sniffSampleRate(buf(page(bytes('OpusHead', [1, 2, 0, 0], u32le(44100))))), 48000);
  assert.equal(sniffSampleRate(buf(page(bytes([1], 'vorbis', u32le(0), [2], u32le(44100), new Uint8Array(13))))), 44100);
});

test('WebM reads SamplingFrequency; Opus-in-WebM noise does not pass for MP3', () => {
  const f64 = (x) => { const b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, x); return [...b]; };
  const head = bytes(u32(0x1a45dfa3), [0x9f], new Uint8Array(30), [0xb5, 0x88], f64(44100), u32(0x1f43b675));
  assert.equal(sniffSampleRate(buf(bytes(head, noise(65536)))), 44100);
  // No SamplingFrequency before the first cluster, then compressed data full of 0xFF bytes.
  for (let k = 0; k < 50; k++) assert.equal(sniffSampleRate(buf(bytes(u32(0x1a45dfa3), new Uint8Array(20), u32(0x1f43b675), noise(65536)))), 48000);
});

test('MP4 finds mp4a inside moov, at the start or the end of the file', () => {
  const entry = bytes(u32(36), 'mp4a', new Uint8Array(24), [0xac, 0x44, 0, 0]);
  const moov = bytes(u32(8 + entry.length), 'moov', entry);
  const ftyp = bytes(u32(16), 'ftyp', 'M4A ', u32(0));
  const mdat = bytes(u32(8 + 4096), 'mdat', noise(4096));
  assert.equal(sniffSampleRate(buf(bytes(ftyp, moov, mdat))), 44100);
  assert.equal(sniffSampleRate(buf(bytes(ftyp, mdat, moov))), 44100);
});

test('ADTS AAC and MP3 need two frames in a row; random bytes give the 48 kHz default', () => {
  const adts = (idx, len) => bytes([0xff, 0xf1, 0x40 | (idx << 2), 0x80 | ((len >> 11) & 3), (len >> 3) & 255, ((len & 7) << 5) | 0x1f, 0xfc], new Uint8Array(len - 7));
  assert.equal(sniffSampleRate(buf(bytes(adts(4, 200), adts(4, 180), adts(4, 190)))), 44100);
  assert.equal(sniffSampleRate(buf(bytes(adts(3, 200), adts(3, 200)))), 48000);
  // MPEG-1 layer III, 128 kbps, 44.1 kHz: 417-byte frames.
  const mp3 = () => bytes([0xff, 0xfb, 0x90, 0x64], new Uint8Array(413));
  assert.equal(sniffSampleRate(buf(bytes(mp3(), mp3(), mp3()))), 44100);
  // MPEG-2 layer III, 64 kbps, 22.05 kHz: 208-byte frames.
  const mp3lo = () => bytes([0xff, 0xf3, 0x80, 0x64], new Uint8Array(204));
  assert.equal(sniffSampleRate(buf(bytes(mp3lo(), mp3lo()))), 22050);
  for (let k = 0; k < 50; k++) assert.equal(sniffSampleRate(buf(noise(65536))), 48000, 'random bytes');
});

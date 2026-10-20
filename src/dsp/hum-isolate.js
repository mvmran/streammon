// "Listen to isolated hum": an STFT comb mask that keeps ±widthHz around each mains
// harmonic and discards everything else, so the hum can be heard on its own. The
// off-frequency control (offsetHz = 3.5) keeps the same-width slices 3.5 Hz away
// instead, for comparison: what that narrow band sounds like without the hum.

import { fft } from './fft.js';

// x: mono samples. Returns { samples: Float32Array, limited } where `limited` says the
// requested gain was reduced to keep the peak at maxPeak.
export function isolateHum(x, sampleRate, { fundamentalHz = 50, harmonics = 10, widthHz = 0.75, offsetHz = 0, gainDb = 40, maxPeak = 0.5 } = {}) {
  // Bins of at most 0.4 Hz, so ±0.75 Hz spans a few bins.
  const N = 1 << Math.ceil(Math.log2(sampleRate / 0.4));
  const hop = N / 4;
  const binHz = sampleRate / N;
  const win = Float64Array.from({ length: N }, (_, n) => 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / N));

  // Bins to keep (positive frequencies; mirrored below).
  const keep = new Uint8Array(N / 2 + 1);
  for (let k = 1; k <= harmonics; k++) {
    const f = k * fundamentalHz + offsetHz;
    const lo = Math.max(1, Math.ceil((f - widthHz) / binHz));
    const hi = Math.min(N / 2, Math.floor((f + widthHz) / binHz));
    for (let b = lo; b <= hi; b++) keep[b] = 1;
  }

  // Pad half a frame each side so the first and last samples are fully covered.
  const pad = N / 2;
  const len = x.length + 2 * pad;
  const out = new Float64Array(len);
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  for (let start = 0; start + N <= len + hop; start += hop) {
    for (let n = 0; n < N; n++) {
      const i = start + n - pad;
      re[n] = i >= 0 && i < x.length ? x[i] * win[n] : 0;
      im[n] = 0;
    }
    fft(re, im);
    for (let b = 0; b <= N / 2; b++) {
      if (keep[b]) continue;
      re[b] = im[b] = 0;
      if (b > 0 && b < N / 2) re[N - b] = im[N - b] = 0;
    }
    fft(re, im, true);
    for (let n = 0; n < N && start + n < len; n++) out[start + n] += re[n] / N;
  }

  // Hann analysis at 75 % overlap sums to 2.
  let g = Math.pow(10, gainDb / 20) / 2;
  let peak = 0;
  for (let i = pad; i < pad + x.length; i++) peak = Math.max(peak, Math.abs(out[i]));
  const limited = peak * g > maxPeak;
  if (limited) g = maxPeak / peak;
  const samples = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) samples[i] = out[i + pad] * g;
  return { samples, limited, gainDb: 20 * Math.log10(g * 2) };
}

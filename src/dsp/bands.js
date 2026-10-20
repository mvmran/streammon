// 1/3-octave and octave band levels from an FFT magnitude spectrum (e.g. an
// AnalyserNode's getFloatFrequencyData output, in dB). Display only.

const BASE = 1000;

// ISO 266 nominal 1/3-octave centres from 25 Hz to 16 kHz (base-2 exact centres).
export const THIRD_OCTAVE_CENTRES = Array.from({ length: 29 }, (_, i) => BASE * Math.pow(2, (i - 16) / 3));
export const OCTAVE_CENTRES = [31.25, 62.5, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

// Sums bin powers between f/2^(w/2) and f*2^(w/2) for each centre (w in octaves).
export function bandLevels(spectrumDb, sampleRate, centres, widthOct) {
  const binHz = sampleRate / 2 / spectrumDb.length;
  const half = Math.pow(2, widthOct / 2);
  return centres.map((fc) => {
    const lo = fc / half, hi = fc * half;
    let p = 0;
    let n = 0;
    const b0 = Math.max(1, Math.floor(lo / binHz));
    const b1 = Math.min(spectrumDb.length - 1, Math.ceil(hi / binHz));
    for (let b = b0; b <= b1; b++) {
      const f = b * binHz;
      if (f < lo || f >= hi) continue;
      p += Math.pow(10, spectrumDb[b] / 10);
      n++;
    }
    // Low bands may contain no bin centre: fall back to the nearest bin.
    if (n === 0) {
      const b = Math.min(spectrumDb.length - 1, Math.max(1, Math.round(fc / binHz)));
      p = Math.pow(10, spectrumDb[b] / 10);
    }
    return 10 * Math.log10(p);
  });
}

export function thirdOctaveLevels(spectrumDb, sampleRate) {
  return bandLevels(spectrumDb, sampleRate, THIRD_OCTAVE_CENTRES, 1 / 3);
}

// Octave levels relative to the 500 Hz band.
export function octaveBalance(spectrumDb, sampleRate) {
  const levels = bandLevels(spectrumDb, sampleRate, OCTAVE_CENTRES, 1);
  const ref = levels[OCTAVE_CENTRES.indexOf(500)];
  return levels.map((l) => l - ref);
}

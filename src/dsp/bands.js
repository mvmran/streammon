// 1/3-octave and octave band levels from an FFT magnitude spectrum (e.g. an
// AnalyserNode's getFloatFrequencyData output, in dB). Display only.

const BASE = 1000;

// ISO 266 nominal 1/3-octave centres from 25 Hz to 16 kHz (base-2 exact centres).
export const THIRD_OCTAVE_CENTRES = Array.from({ length: 29 }, (_, i) => BASE * Math.pow(2, (i - 16) / 3));
export const OCTAVE_CENTRES = [31.25, 62.5, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
// The analysers' FFT sizes (engine.js): the spectrum, and the finer one used below
// FINE_MAX_HZ (spectrum.js). The saved-CSV spectrogram needs their bin widths.
export const SPECTRUM_FFT_SIZE = 8192;
export const FINE_FFT_SIZE = 32768;

// Their nominal names, as in the CSV column names.
export const THIRD_OCTAVE_LABELS = ['25', '31.5', '40', '50', '63', '80', '100', '125', '160', '200', '250', '315', '400', '500', '630', '800', '1k', '1.25k', '1.6k', '2k', '2.5k', '3.15k', '4k', '5k', '6.3k', '8k', '10k', '12.5k', '16k'];
export const OCTAVE_LABELS = ['31', '63', '125', '250', '500', '1k', '2k', '4k', '8k', '16k'];

// The 1/3-octave spectrum of each second, for the CSV: the power mean of the frames' levels
// (one add() per 100 ms analyzer frame); take() returns it in dB and starts the next second
// (null if no frame came).
export class SpectrumSecond {
  constructor() {
    this.reset();
  }

  reset() {
    this.power = new Float64Array(THIRD_OCTAVE_CENTRES.length);
    this.n = 0;
  }

  add(levelsDb) {
    if (!levelsDb) return;
    for (let i = 0; i < this.power.length; i++) this.power[i] += Number.isFinite(levelsDb[i]) ? Math.pow(10, levelsDb[i] / 10) : 0;
    this.n++;
  }

  take() {
    const out = this.n ? Array.from(this.power, (p) => 10 * Math.log10(p / this.n)) : null;
    this.reset();
    return out;
  }
}

// Sums bin powers between f/2^(w/2) and f*2^(w/2) for each centre (w in octaves).
// fine: { db, binHz }, the first bins of a longer FFT of the same audio (an AnalyserNode
// scales |X| by 1/N, so levels agree between sizes). Bands that end below its last bin are
// taken from it: an 8192-point FFT at 48 kHz has 5.9 Hz bins and spreads a tone over about
// ±18 Hz, wider than the low bands, so a 60 Hz note or a 50 Hz hum lit up its neighbours.
export function bandLevels(spectrumDb, sampleRate, centres, widthOct, fine = null) {
  const binHz = sampleRate / 2 / spectrumDb.length;
  const half = Math.pow(2, widthOct / 2);
  const fineMaxHz = fine ? (fine.db.length - 1) * fine.binHz : 0;
  return centres.map((fc) => (fc * half <= fineMaxHz ? bandLevel(fine.db, fine.binHz, fc, half) : bandLevel(spectrumDb, binHz, fc, half)));
}

function bandLevel(spectrumDb, binHz, fc, half) {
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
}

export function thirdOctaveLevels(spectrumDb, sampleRate, fine = null) {
  return bandLevels(spectrumDb, sampleRate, THIRD_OCTAVE_CENTRES, 1 / 3, fine);
}

// Octave levels relative to the 500 Hz band.
export function octaveBalance(spectrumDb, sampleRate) {
  const levels = bandLevels(spectrumDb, sampleRate, OCTAVE_CENTRES, 1);
  const ref = levels[OCTAVE_CENTRES.indexOf(500)];
  return levels.map((l) => l - ref);
}

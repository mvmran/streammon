// Deterministic synthetic test signals for the clipping detector.
//
// A steady pure sine at constant level is, by any waveform statistic, the same thing as
// a limited sine, so the "programme" here is music-like: a few detuned sines (a chord
// that changes every half second) plus pink noise, under a syllabic envelope. That
// programme is then (a) hard-clipped at -3 dBFS and scaled down, (b) run through a
// fast look-ahead limiter to the same ceiling, or (c) left clean.

function mulberry32(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const db = (x) => Math.pow(10, x / 20);

// Music-like programme normalised to the given RMS (dBFS).
export function programme(sampleRate, seconds, rmsDb, seed = 1) {
  const rand = mulberry32(seed);
  const n = Math.round(sampleRate * seconds);
  const x = new Float32Array(n);
  const roots = [196, 220, 247, 262, 294, 330];
  const ratios = [1, 1.25, 1.5, 2, 3];
  let phases = ratios.map(() => rand() * 2 * Math.PI);
  let freqs = [];
  let amps = [];
  const chordLen = Math.round(sampleRate * 0.5);
  // Paul Kellet's economy pink noise filter.
  let b0 = 0, b1 = 0, b2 = 0;
  for (let i = 0; i < n; i++) {
    if (i % chordLen === 0) {
      const root = roots[Math.floor(rand() * roots.length)];
      freqs = ratios.map((r) => root * r * (1 + (rand() - 0.5) * 0.004));
      amps = ratios.map((_, k) => (0.6 + 0.4 * rand()) / (k + 1));
    }
    const t = i / sampleRate;
    let s = 0;
    for (let k = 0; k < freqs.length; k++) {
      phases[k] += (2 * Math.PI * freqs[k]) / sampleRate;
      s += amps[k] * Math.sin(phases[k]);
    }
    const w = rand() * 2 - 1;
    b0 = 0.99765 * b0 + w * 0.099046;
    b1 = 0.963 * b1 + w * 0.2965164;
    b2 = 0.57 * b2 + w * 1.0526913;
    const pink = (b0 + b1 + b2 + w * 0.1848) * 0.25;
    const env = 0.35 + 0.65 * Math.abs(Math.sin(2 * Math.PI * 2.3 * t)) * (0.7 + 0.3 * Math.sin(2 * Math.PI * 0.31 * t));
    x[i] = env * (s + 0.6 * pink);
  }
  let ss = 0;
  for (let i = 0; i < n; i++) ss += x[i] * x[i];
  const g = db(rmsDb) / Math.sqrt(ss / n);
  for (let i = 0; i < n; i++) x[i] *= g;
  return x;
}

// Second-order Butterworth low-pass, as a stand-in for the codec's band limit. It also
// puts ripple on clipped plateaus so consecutive samples are never identical.
export function lowpass(x, sampleRate, fc = 15000) {
  const K = Math.tan((Math.PI * fc) / sampleRate);
  const q = Math.SQRT1_2;
  const norm = 1 / (1 + K / q + K * K);
  const b0 = K * K * norm, b1 = 2 * b0, b2 = b0;
  const a1 = 2 * (K * K - 1) * norm, a2 = (1 - K / q + K * K) * norm;
  const y = new Float32Array(x.length);
  let s1 = 0, s2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = x[i];
    const o = b0 * v + s1;
    s1 = b1 * v - a1 * o + s2;
    s2 = b2 * v - a2 * o;
    y[i] = o;
  }
  return y;
}

export function hardClip(x, ceilingDb) {
  const c = db(ceilingDb);
  return x.map((v) => Math.max(-c, Math.min(c, v)));
}

// Fast look-ahead peak limiter: 1 ms look-ahead/attack, 50 ms release.
export function limit(x, sampleRate, ceilingDb, releaseMs = 50) {
  const c = db(ceilingDb);
  const la = Math.round(sampleRate * 0.001);
  const rel = Math.exp(-1 / ((sampleRate * releaseMs) / 1000));
  const n = x.length;
  // Required gain per sample, then a running minimum over the look-ahead window.
  const need = new Float32Array(n);
  for (let i = 0; i < n; i++) need[i] = Math.min(1, c / Math.max(1e-9, Math.abs(x[i])));
  const y = new Float32Array(n);
  let g = 1;
  for (let i = 0; i < n; i++) {
    let target = 1;
    for (let j = i; j < Math.min(n, i + la); j++) if (need[j] < target) target = need[j];
    // Instant attack towards the look-ahead minimum (it was already ramping), smooth release.
    g = target < g ? target : target + (g - target) * rel;
    y[i] = Math.max(-c, Math.min(c, x[i] * g));
  }
  return y;
}

export function scale(x, gainDb) {
  const g = db(gainDb);
  return x.map((v) => v * g);
}

export function syntheticSignals(sampleRate = 48000, seconds = 20) {
  const hot = programme(sampleRate, seconds, -9, 7); // peaks well above -3 dBFS
  return {
    clipped: lowpass(scale(hardClip(hot, -3), -2), sampleRate),
    limited: lowpass(scale(limit(hot, sampleRate, -3), -2), sampleRate),
    clean: lowpass(programme(sampleRate, seconds, -20, 11), sampleRate),
  };
}

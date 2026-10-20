// ITU-R BS.1770-4 K-weighting filter, with coefficients derived for any sample rate.
//
// The standard only tabulates coefficients for 48 kHz. We recover the analogue
// prototype (shelf frequency, gain, Q; high-pass frequency, Q) that reproduces those
// coefficients exactly at 48 kHz and re-apply the bilinear transform at the actual rate
// (the same approach as libebur128).

export function kWeightingCoefficients(sampleRate) {
  // Stage 1: high-shelf pre-filter (models the acoustic effect of the head).
  const f0 = 1681.974450955533;
  const G = 3.999843853973347;
  const Q = 0.7071752369554196;
  let K = Math.tan((Math.PI * f0) / sampleRate);
  const Vh = Math.pow(10, G / 20);
  const Vb = Math.pow(Vh, 0.4996667741545416);
  let a0 = 1 + K / Q + K * K;
  const shelf = {
    b0: (Vh + (Vb * K) / Q + K * K) / a0,
    b1: (2 * (K * K - Vh)) / a0,
    b2: (Vh - (Vb * K) / Q + K * K) / a0,
    a1: (2 * (K * K - 1)) / a0,
    a2: (1 - K / Q + K * K) / a0,
  };

  // Stage 2: RLB high-pass.
  const f1 = 38.13547087602444;
  const Q1 = 0.5003270373238773;
  K = Math.tan((Math.PI * f1) / sampleRate);
  a0 = 1 + K / Q1 + K * K;
  const highpass = {
    b0: 1,
    b1: -2,
    b2: 1,
    a1: (2 * (K * K - 1)) / a0,
    a2: (1 - K / Q1 + K * K) / a0,
  };

  return [shelf, highpass];
}

// Stateful two-stage biquad cascade (transposed direct form II) for one channel.
export class KWeightingFilter {
  constructor(sampleRate) {
    const [s, h] = kWeightingCoefficients(sampleRate);
    this.s = s;
    this.h = h;
    this.reset();
  }

  reset() {
    this.s1 = this.s2 = this.h1 = this.h2 = 0;
  }

  // Filters `input` into `output` (may be the same array). Float64 state avoids drift.
  process(input, output, n = input.length) {
    const { b0, b1, b2, a1, a2 } = this.s;
    const h = this.h;
    let s1 = this.s1, s2 = this.s2, h1 = this.h1, h2 = this.h2;
    for (let i = 0; i < n; i++) {
      const x = input[i];
      const y = b0 * x + s1;
      s1 = b1 * x - a1 * y + s2;
      s2 = b2 * x - a2 * y;
      const z = y + h1; // highpass b0 = 1
      h1 = -2 * y - h.a1 * z + h2;
      h2 = y - h.a2 * z;
      output[i] = z;
    }
    // Flush denormals during digital silence.
    this.s1 = Math.abs(s1) < 1e-25 ? 0 : s1;
    this.s2 = Math.abs(s2) < 1e-25 ? 0 : s2;
    this.h1 = Math.abs(h1) < 1e-25 ? 0 : h1;
    this.h2 = Math.abs(h2) < 1e-25 ? 0 : h2;
  }
}

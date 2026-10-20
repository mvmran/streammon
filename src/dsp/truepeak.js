// True-peak measurement per ITU-R BS.1770-4 Annex 2: 4x oversampling with the
// 48-tap polyphase FIR from the standard (12 taps per phase).

const H = [
  0.0017089843750, -0.0291748046875, -0.0189208984375, -0.0083007812500,
  0.0109863281250, 0.0292968750000, 0.0330810546875, 0.0148925781250,
  -0.0196533203125, -0.0517578125000, -0.0582275390625, -0.0266113281250,
  0.0332031250000, 0.0891113281250, 0.1015625000000, 0.0476074218750,
  -0.0594482421875, -0.1665039062500, -0.2003173828125, -0.1022949218750,
  0.1373291015625, 0.4650878906250, 0.7797851562500, 0.9721679687500,
  0.9721679687500, 0.7797851562500, 0.4650878906250, 0.1373291015625,
  -0.1022949218750, -0.2003173828125, -0.1665039062500, -0.0594482421875,
  0.0476074218750, 0.1015625000000, 0.0891113281250, 0.0332031250000,
  -0.0266113281250, -0.0582275390625, -0.0517578125000, -0.0196533203125,
  0.0148925781250, 0.0330810546875, 0.0292968750000, 0.0109863281250,
  -0.0083007812500, -0.0189208984375, -0.0291748046875, 0.0017089843750,
];

const TAPS = 12;
const PHASES = 4;
// PH[p][k] multiplies x[n - k] for output phase p.
const PH = Array.from({ length: PHASES }, (_, p) => Float64Array.from({ length: TAPS }, (_, k) => H[p + PHASES * k]));

// One channel. Returns the largest absolute oversampled value in each processed block,
// never less than the largest absolute input sample.
export class TruePeakChannel {
  constructor() {
    this.buf = new Float64Array(TAPS - 1 + 128);
    this.reset();
  }

  reset() {
    this.buf.fill(0);
  }

  process(x, n = x.length) {
    const hist = TAPS - 1;
    if (this.buf.length < hist + n) {
      const b = new Float64Array(hist + n);
      b.set(this.buf.subarray(0, hist));
      this.buf = b;
    }
    const buf = this.buf;
    for (let i = 0; i < n; i++) buf[hist + i] = x[i];

    const [p0, p1, p2, p3] = PH;
    let peak = 0;
    for (let i = 0; i < n; i++) {
      const base = hist + i; // index of x[n]
      let y0 = 0, y1 = 0, y2 = 0, y3 = 0;
      for (let k = 0; k < TAPS; k++) {
        const v = buf[base - k];
        y0 += p0[k] * v;
        y1 += p1[k] * v;
        y2 += p2[k] * v;
        y3 += p3[k] * v;
      }
      const a = Math.max(Math.abs(y0), Math.abs(y1), Math.abs(y2), Math.abs(y3), Math.abs(buf[base]));
      if (a > peak) peak = a;
    }
    buf.copyWithin(0, n, n + hist);
    return peak;
  }
}

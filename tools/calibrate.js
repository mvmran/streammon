// Prints the analyzer's per-second readings for a WAV file, for checking or re-tuning
// the clipping detector against new recordings:
//   node tools/calibrate.js recording.wav
import { readWav } from '../test/wav.js';
import { analyse } from '../test/helpers.js';

const file = process.argv[2];
if (!file) {
  console.error('usage: node tools/calibrate.js <file.wav>');
  process.exit(1);
}
const { sampleRate, channels } = readWav(file);
const [L, R = L] = channels;
const { rows, events, summary } = analyse(L, R, sampleRate);
const f = (x, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : '-inf').padStart(6);

console.log('   t  status     short  peak   TP  crest  dwell/s  pile  pinned  ceiling  fs');
for (const r of rows) {
  console.log(
    `${f(r.t, 0)}  ${r.status.padEnd(8)} ${f(r.shortTerm)} ${f(r.samplePeakDb)} ${f(r.truePeakDb)} ${f(r.crestDb)}  ${f(r.dwellRate)}  ${f(r.pileRatio, 2)}  ${f(r.pinned, 2)}   ${f(r.ceilingDb)}  ${r.fullScaleRuns}`,
  );
}
console.log('\nEvents:');
for (const e of events) {
  if (e.type === 'start' || e.type === 'end') {
    console.log(`  ${e.type.padEnd(5)} ${e.status.padEnd(8)} t=${e.t.toFixed(0)}s ceiling ${f(e.ceilingDb)} dBFS ${e.detectors.join('+')}`);
  } else {
    // Hum and stereo events: type, time and whatever they say.
    const what = e.message || [e.status, e.detail].filter(Boolean).join(' ') || (Number.isFinite(e.levelDb) ? `${f(e.levelDb)} dBFS` : '');
    console.log(`  ${e.type.padEnd(5)} t=${e.t.toFixed(0)}s ${what}`);
  }
}
console.log('\nSummary:');
console.log(`  integrated ${f(summary.integrated)} LUFS  LRA ${f(summary.lra)} LU  true peak ${f(summary.truePeakDb, 2)} dBTP  sample peak ${f(summary.samplePeakDb, 2)} dBFS`);
console.log(`  crest ${f(summary.crestDb)} dB  mean dwell ${f(summary.meanDwellRate, 2)}/s  correlation ${f(summary.correlation, 4)}  overall ${summary.overallStatus}`);

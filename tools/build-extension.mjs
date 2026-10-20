// Assembles the Chrome extension into dist/streammon-extension/ (load it with
// chrome://extensions → Developer mode → Load unpacked) and zips it for copying to
// other machines. The extension's own files are in extension/; the analysis and UI
// modules are copied from src/ so the web app and the extension share one codebase.
//
//   npm run build:extension

import { cpSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const OUT = join(ROOT, 'dist', 'streammon-extension');

const SHARED = [
  'src/dsp',
  'src/audio/engine.js',
  'src/audio/analyzer-worklet.js',
  'src/audio/sources.js',
  'src/ui/charts.js',
  'src/ui/format.js',
  'src/ui/help.js',
  'src/ui/log.js',
  'src/ui/meters.js',
  'src/ui/session.js',
  'src/ui/settings.js',
  'src/ui/spectrum.js',
  'css/app.css',
];

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
cpSync(join(ROOT, 'extension'), OUT, { recursive: true });
for (const p of SHARED) cpSync(join(ROOT, p), join(OUT, p), { recursive: true });

const { version } = JSON.parse(readFileSync(join(OUT, 'manifest.json'), 'utf8'));
const zip = join(ROOT, 'dist', `streammon-extension-${version}.zip`);
rmSync(zip, { force: true });
try {
  execFileSync('zip', ['-qr', zip, '.'], { cwd: OUT });
  console.log(`Built ${OUT}\nZipped ${zip}`);
} catch {
  console.log(`Built ${OUT} (zip not available, skipped the .zip)`);
}

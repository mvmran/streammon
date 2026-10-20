// Renders the extension icons (extension/icons/*.png) from an SVG with headless
// Chromium. Only needed when the icon design changes:  node tools/make-icons.mjs

import { chromium } from 'playwright-core';
import { join } from 'node:path';

const OUT = new URL('../extension/icons/', import.meta.url).pathname;

// A waveform with its top sliced flat, on the app's dark surface.
const svg = (size) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 32 32">
  <rect width="32" height="32" rx="7" fill="#1a1a19"/>
  <path d="M3 18 Q6 18 7.5 13 L9 9 H14 L15.5 13 Q17 18 19 22 Q21 26 23 20 Q25 13 29 16"
        fill="none" stroke="#3987e5" stroke-width="${size <= 16 ? 3.2 : 2.6}" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M8.5 9 H14.5" stroke="#d03b3b" stroke-width="${size <= 16 ? 3.2 : 2.6}" stroke-linecap="round"/>
</svg>`;

const browser = await chromium.launch();
const page = await browser.newPage();
for (const size of [16, 32, 48, 128]) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<style>html,body{margin:0;background:transparent}</style>${svg(size)}`);
  await page.locator('svg').screenshot({ path: join(OUT, `icon${size}.png`), omitBackground: true });
}
await browser.close();
console.log(`Icons written to ${OUT}`);

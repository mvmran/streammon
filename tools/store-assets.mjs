// Renders the Chrome Web Store images into store/ from the real extension running on a
// clipped test recording (needs test-audio/ and `npm run build:extension` first):
//
//   npm run store:assets
//
//   store/screenshot-1-dashboard.png   1280x800
//   store/screenshot-2-side-panel.png  1280x800
//   store/promo-small-440x280.png      440x280

import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { join, normalize } from 'node:path';
import { chromium } from 'playwright-core';

const ROOT = new URL('..', import.meta.url).pathname;
const EXT = join(ROOT, 'dist', 'streammon-extension');
const OUT = join(ROOT, 'store');
const WAV = 'test-audio/18Oct2026-31_min_mark.wav'; // clipping that stops partway, looped

const server = createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
  try {
    const body = await readFile(join(ROOT, path));
    res.writeHead(200, { 'content-type': 'audio/wav', 'access-control-allow-origin': '*' });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
await mkdir(OUT, { recursive: true });

const context = await chromium.launchPersistentContext('', {
  channel: 'chromium',
  headless: true,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--autoplay-policy=no-user-gesture-required'],
  viewport: { width: 1280, height: 800 },
});
const sw = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
const id = new URL(sw.url()).host;
await sw.evaluate((url) => self.streammonTestStart(url, 'Sunday Service – Live'), `http://127.0.0.1:${server.address().port}/${WAV}`);

// 1. Dashboard
const dash = await context.newPage();
await dash.goto(`chrome-extension://${id}/dashboard.html`);
await dash.waitForTimeout(150000); // let history, spectrogram and the log fill in
await dash.waitForFunction(() => document.getElementById('status').textContent === 'CLIPPING', null, { timeout: 60000 });
await dash.waitForTimeout(1500);
await dash.screenshot({ path: join(OUT, 'screenshot-1-dashboard.png') });

// 2. Side panel, captioned
const panel = await context.newPage();
await panel.setViewportSize({ width: 400, height: 760 });
await panel.goto(`chrome-extension://${id}/panel.html`);
await panel.waitForFunction(() => document.getElementById('status').textContent === 'CLIPPING', null, { timeout: 60000 });
await panel.waitForTimeout(3000);
const panelPng = (await panel.screenshot()).toString('base64');
const icon = (await readFile(join(ROOT, 'extension/icons/icon128.png'))).toString('base64');

const page = await context.newPage();
const base = `<style>
  * { box-sizing: border-box; margin: 0; }
  body { font-family: system-ui, 'Segoe UI', sans-serif; background: #0d0d0d; color: #f0efec; }
  .chip { display: inline-block; font: 700 15px system-ui; padding: 3px 9px; border-radius: 6px; color: #fff; margin-right: 8px; }
</style>`;
await page.setViewportSize({ width: 1280, height: 800 });
await page.setContent(`${base}
  <div style="display:flex;height:800px;align-items:center;gap:56px;padding:0 72px">
    <div style="flex:1">
      <img src="data:image/png;base64,${icon}" width="72" height="72" alt="">
      <h1 style="font-size:44px;line-height:1.15;margin:22px 0 18px">Hear what your viewers hear</h1>
      <p style="font-size:21px;line-height:1.5;color:#c3c2b7;max-width:560px">Click the toolbar button on your YouTube stream. The side panel shows loudness, true peak and
      whether the audio is <b style="color:#f0efec">clipping</b>, even when the damage happened below 0 dBFS, before the level was turned down.</p>
      <p style="font-size:19px;margin-top:30px;color:#c3c2b7">Toolbar badge, even with the panel closed:</p>
      <p style="margin-top:12px"><span class="chip" style="background:#0ca30c">OK</span><span class="chip" style="background:#b57f00">LIM</span><span class="chip" style="background:#d03b3b">CLIP</span></p>
    </div>
    <img src="data:image/png;base64,${panelPng}" width="400" height="760" style="border-radius:10px;box-shadow:0 10px 40px rgba(0,0,0,.6);border:1px solid #2c2c2a" alt="">
  </div>`);
await page.screenshot({ path: join(OUT, 'screenshot-2-side-panel.png') });

// 3. Small promo tile
await page.setViewportSize({ width: 440, height: 280 });
await page.setContent(`${base}
  <div style="height:280px;display:flex;flex-direction:column;justify-content:center;padding:0 34px;background:#1a1a19">
    <div style="display:flex;align-items:center;gap:16px">
      <img src="data:image/png;base64,${icon}" width="64" height="64" alt="">
      <div style="font-size:30px;font-weight:700;line-height:1.1">Stream Audio<br>Monitor</div>
    </div>
    <p style="font-size:17px;line-height:1.4;color:#c3c2b7;margin-top:22px">Catch clipping on your live stream, even below 0&nbsp;dBFS.</p>
  </div>`);
await page.screenshot({ path: join(OUT, 'promo-small-440x280.png') });

await context.close();
server.close();
console.log(`Store images written to ${OUT}`);

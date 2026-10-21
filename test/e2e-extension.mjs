// Browser test of the Chrome extension (Playwright + Chromium with the unpacked build).
//
//   npm run test:extension        # builds dist/streammon-extension, then runs this
//   HEADED=1 npm run test:extension
//
// Real tab capture needs a click on the toolbar button, which automation can't do, so
// the service worker's test hook feeds a WAV through the same offscreen pipeline.
// Everything after the capture (analysis, badge, side panel, dashboard, exports) is
// exercised as in normal use.

import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { join, normalize } from 'node:path';
import { chromium } from 'playwright-core';

const ROOT = new URL('..', import.meta.url).pathname;
const EXT = join(ROOT, 'dist', 'streammon-extension');
const OUT = join(ROOT, 'test', 'e2e-output');

function serve() {
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
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

let failures = 0;
function check(ok, what) {
  console.log(`${ok ? '  ok ' : '  FAIL'} ${what}`);
  if (!ok) failures++;
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const server = await serve();
  const wav = `http://127.0.0.1:${server.address().port}/test-audio/18Oct2026-30_min_mark.wav`;
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium', // full Chromium in headless mode: extensions need it
    headless: !process.env.HEADED,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--autoplay-policy=no-user-gesture-required'],
    viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: 1.5, // Windows display scaling; 1x hides canvas sizing bugs
    acceptDownloads: true,
  });
  const errors = [];
  const watch = (page) => {
    page.on('pageerror', (e) => errors.push(`${page.url()}: ${e.message}`));
    page.on('console', (m) => m.type() === 'error' && errors.push(`${page.url()}: ${m.text()}`));
  };

  try {
    const sw = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
    const id = new URL(sw.url()).host;
    console.log(`Extension ${id}`);

    const panel = await context.newPage();
    watch(panel);
    await panel.setViewportSize({ width: 400, height: 1100 });
    await panel.goto(`chrome-extension://${id}/panel.html`);
    check(await panel.isVisible('#idle'), 'side panel shows how to start before monitoring');

    console.log('Monitoring a clipped stream (18Oct2026-30):');
    const started = await sw.evaluate((url) => self.streammonTestStart(url, 'Sunday service (test)'), wav);
    check(started && started.ok, `capture started${started && started.error ? `: ${started.error}` : ''}`);
    await panel.waitForFunction(() => document.getElementById('status').textContent === 'CLIPPING', null, { timeout: 20000 });
    check(true, 'side panel status reaches CLIPPING');
    check((await panel.textContent('#tab-title')) === 'Sunday service (test)', 'side panel shows the monitored tab title');
    await panel.waitForTimeout(6000);
    const badge = await sw.evaluate(() => chrome.action.getBadgeText({}));
    check(badge === 'CLIP', `toolbar badge reads CLIP (${badge})`);
    check(/Clipping started/.test(await panel.textContent('#log-body')), 'clipping event in the side panel log');
    check(await panel.isVisible('.alert'), 'clipping alert banner in the side panel');
    await panel.hover('#status-tile');
    await panel.waitForSelector('#tooltip.help:not([hidden])', { timeout: 3000 });
    check(/CLIPPING \(red\)/.test(await panel.textContent('#tooltip')), 'hovering the status card shows its help in the side panel');
    await panel.screenshot({ path: join(OUT, 'extension-panel-help.png') });
    await panel.mouse.move(5, 5);
    await panel.screenshot({ path: join(OUT, 'extension-panel.png'), fullPage: true });

    console.log('Dashboard opened mid-session:');
    const dash = await context.newPage();
    watch(dash);
    await dash.goto(`chrome-extension://${id}/dashboard.html`);
    await dash.waitForFunction(() => document.getElementById('status').textContent === 'CLIPPING', null, { timeout: 10000 });
    check(/Clipping started/.test(await dash.textContent('#log-body')), 'dashboard receives the earlier log (snapshot)');
    const rows = await dash.evaluate(() => document.getElementById('int').textContent);
    check(rows !== '--', `dashboard shows integrated loudness (${rows})`);
    await dash.waitForTimeout(3000);
    const spectrumDrawn = await dash.evaluate(() => {
      const c = document.getElementById('bands');
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      for (let i = 2; i < d.length; i += 4) if (d[i] > 200 && d[i - 2] < 100) return true; // series-blue pixels
      return false;
    });
    check(spectrumDrawn, 'dashboard spectrum is drawn from the offscreen analyser');
    const stereoNote = await dash.textContent('#stereo-bands-note');
    check(stereoNote && stereoNote !== '--', `dashboard stereo-by-band panel reports (${stereoNote})`);
    const { dpr, sizes } = await dash.evaluate(() => ({
      dpr: devicePixelRatio,
      sizes: ['bands', 'sgram'].map((id) => {
        const c = document.getElementById(id);
        return [c.height, Math.round(c.getBoundingClientRect().height), Number(c.style.height.replace('px', ''))];
      }),
    }));
    check(sizes.every(([px, css, set]) => set <= 304 && css <= set + 1 && px <= Math.ceil(set * dpr) + 1), `spectrum canvases keep their size at ${dpr}x scaling (${JSON.stringify(sizes)})`);
    await dash.screenshot({ path: join(OUT, 'extension-dashboard.png'), fullPage: true });

    await panel.click('#tp-tile');
    await dash.waitForFunction(() => /True peak max reset/.test(document.getElementById('log-body').textContent), null, { timeout: 5000 });
    check(true, 'reset clicked in the side panel reaches the session (shown in the dashboard log)');

    console.log('Exports and stop:');
    await panel.bringToFront();
    const [dl] = await Promise.all([panel.waitForEvent('download'), panel.click('#export-csv')]);
    const csv = await readFile(await dl.path(), 'utf8');
    const lines = csv.trim().split('\n');
    check(lines[0].startsWith('wall_clock,elapsed_s') && lines.length > 5, `CSV export has ${lines.length - 1} rows`);
    const [dj] = await Promise.all([panel.waitForEvent('download'), panel.click('#export-json')]);
    const json = JSON.parse(await readFile(await dj.path(), 'utf8'));
    check(json.summary && json.summary.overallStatus === 'CLIPPING', `JSON summary overall status ${json.summary && json.summary.overallStatus}`);
    await panel.click('#stop');
    await panel.waitForSelector('#ended:not([hidden])', { timeout: 5000 });
    check(true, 'stop shows the ended notice');
    const badgeAfter = await sw.evaluate(() => chrome.action.getBadgeText({}));
    check(badgeAfter === '', 'badge cleared after stop');
    check(await dash.evaluate(() => document.getElementById('status').textContent) === 'IDLE', 'dashboard returns to IDLE');

    console.log('Mains hum (Reference_speech_recording, 50 Hz hum at -70 dBFS):');
    const speech = wav.replace('18Oct2026-30_min_mark', 'Reference_speech_recording');
    await sw.evaluate((url) => self.streammonTestStart(url, 'Sister church service (test)'), speech);
    await panel.waitForFunction(() => document.getElementById('hum-status-text').textContent === 'PRESENT', null, { timeout: 25000 });
    check(true, 'side panel shows mains hum PRESENT');
    check(/^50\.0\d Hz$/.test(await panel.textContent('#hum-freq')), `side panel hum frequency ${await panel.textContent('#hum-freq')}`);
    await dash.waitForFunction(() => /Mains hum detected/.test(document.getElementById('log-body').textContent), null, { timeout: 5000 });
    check((await dash.textContent('#hum-status-text')) === 'PRESENT', 'dashboard hum panel PRESENT, onset logged');
    await panel.waitForFunction(() => /Mains hum/.test(document.getElementById('alerts').textContent), null, { timeout: 15000 });
    check(true, 'mains hum alert banner in the side panel');
    await panel.screenshot({ path: join(OUT, 'extension-panel-hum.png'), fullPage: true });
    await dash.locator('section.hum').screenshot({ path: join(OUT, 'extension-dashboard-hum.png') });
    await panel.click('#stop');

    check(errors.length === 0, `no page errors${errors.length ? `:\n    ${errors.join('\n    ')}` : ''}`);
  } catch (e) {
    console.error(e.message);
    if (errors.length) console.log('Page errors:\n  ' + errors.join('\n  '));
    failures++;
  } finally {
    await context.close();
    server.close();
  }
  console.log(failures ? `\n${failures} check(s) failed` : '\nAll extension checks passed');
  console.log(`Screenshots in ${OUT}`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

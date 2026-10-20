// Browser smoke test (Playwright + headless Chromium). Not part of `npm test`.
//
//   npm run test:e2e              # file mode + fake audio input device
//   HEADED=1 npm run test:e2e     # watch it run
//
// Chromium's fake capture device plays a test WAV as if it were the ATEM's USB audio,
// so the "Audio input device" path is exercised end to end with a real recording.
// One-time setup (no sudo): `npx playwright-core install chromium`.

import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { chromium } from 'playwright-core';

const ROOT = new URL('..', import.meta.url).pathname;
const OUT = join(ROOT, 'test', 'e2e-output');
const CLIPPED = join(ROOT, 'test-audio', '18Oct2026-30_min_mark.wav');
const LIMITED = join(ROOT, 'test-audio', '18Oct2026-42_min_mark.wav');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.wav': 'audio/wav' };

function serve() {
  const server = createServer(async (req, res) => {
    let path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
    if (path.endsWith('/')) path += 'index.html';
    try {
      const body = await readFile(join(ROOT, path));
      res.writeHead(200, { 'content-type': TYPES[extname(path)] || 'application/octet-stream' });
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

const num = (s) => Number(String(s).replace('−', '-').replace('+', ''));

async function main() {
  await mkdir(OUT, { recursive: true });
  const server = await serve();
  const url = `http://127.0.0.1:${server.address().port}/`;
  const browser = await chromium.launch({
    headless: !process.env.HEADED,
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${CLIPPED}`,
      '--autoplay-policy=no-user-gesture-required',
      // Tab capture picks the test player tab without the share dialog.
      '--auto-select-tab-capture-source-by-title=StreamMon Test Player',
    ],
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1.5 });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

  try {
    await page.goto(url);

    console.log('File mode (18Oct2026-42, limited):');
    await page.selectOption('#source', 'file');
    await page.setInputFiles('#file-input', LIMITED);
    await page.waitForSelector('#file-result:not([hidden])', { timeout: 30000 });
    const summary = await page.textContent('#file-summary');
    check(/Status\s*LIMITED/.test(summary), `summary status LIMITED (${summary.match(/Status\s*\w+/)})`);
    check(/Integrated\s*−14\.\d LUFS/.test(summary), `integrated about −14.1 (${summary.match(/Integrated\s*\S+/)})`);
    check((await page.locator('#log-body tr').count()) >= 1, 'event log has entries');
    await page.click('#timeline', { position: { x: 400, y: 100 } });
    await page.waitForTimeout(4000);
    const st = await page.textContent('#status');
    check(['LIMITED', 'CLEAN'].includes(st), `playback status not clipping (${st})`);
    await page.screenshot({ path: join(OUT, 'file-mode.png'), fullPage: true });
    await page.click('#play'); // pause

    await page.hover('[data-help="integrated"]');
    await page.waitForSelector('#tooltip.help:not([hidden])', { timeout: 3000 });
    check(/YouTube/.test(await page.textContent('#tooltip')), 'hovering a card shows its help text');
    await page.mouse.move(5, 5);

    console.log('Mains hum, file mode (Reference_speech_recording, 50 Hz hum at -70 dBFS):');
    await page.setInputFiles('#file-input', join(ROOT, 'test-audio', 'Reference_speech_recording.wav'));
    await page.waitForFunction(() => /Reference_speech/.test(document.getElementById('file-name').textContent), null, { timeout: 30000 });
    await page.waitForSelector('#file-result:not([hidden])');
    check((await page.textContent('#hum-status-text')) === 'PRESENT', `hum panel says PRESENT (${await page.textContent('#hum-status-text')})`);
    check(/^50\.0\d Hz$/.test(await page.textContent('#hum-freq')), `hum frequency ${await page.textContent('#hum-freq')}`);
    const humLog = await page.textContent('#log-body');
    check(/Mains hum detected/.test(humLog) && /Alert: Mains hum/.test(humLog), 'hum onset and hum alert in the event log');
    await page.click('#hum-listen-hum');
    await page.waitForFunction(() => /^Hum from/.test(document.getElementById('hum-listen-note').textContent), null, { timeout: 30000 });
    check(true, `isolated hum plays (${await page.textContent('#hum-listen-note')})`);
    await page.locator('section.hum').screenshot({ path: join(OUT, 'hum-panel.png') });

    console.log('Audio input device (fake device playing 18Oct2026-30, clipped):');
    await page.selectOption('#source', 'device');
    await page.click('#start');
    await page.waitForFunction(() => document.getElementById('status').textContent === 'CLIPPING', null, { timeout: 20000 });
    check(true, 'status reaches CLIPPING');
    await page.waitForTimeout(8000);
    const integrated = num(await page.textContent('#int'));
    check(Math.abs(integrated - -7.3) < 1, `integrated about −7.3 LUFS (${integrated})`);
    check((await page.textContent('#mono')) === 'MONO', 'MONO badge');
    const logText = await page.textContent('#log-body');
    check(/Clipping started/.test(logText), 'clipping event logged');
    check(/Alert: Clipping/.test(logText), 'clipping alert raised');
    check(await page.isVisible('.alert'), 'alert banner shown');
    const ceil = num(await page.textContent('#d-ceil'));
    check(ceil < -2.5 && ceil > -4.5, `ceiling about −3.4 to −3.9 dBFS (${ceil})`);
    await page.click('#tp-tile');
    await page.click('#int-tile');
    const logAfterReset = await page.textContent('#log-body');
    check(/True peak max reset/.test(logAfterReset) && /Integrated loudness reset/.test(logAfterReset), 'clicking true peak / integrated cards resets them (logged)');
    await page.waitForFunction(() => document.getElementById('tp').textContent !== '--' && document.getElementById('int').textContent !== '--', null, { timeout: 5000 });
    check(true, `readings resume after reset (true peak ${await page.textContent('#tp')}, integrated ${await page.textContent('#int')})`);
    const { dpr, sizes } = await page.evaluate(() => ({
      dpr: devicePixelRatio,
      sizes: ['bands', 'sgram'].map((id) => {
        const c = document.getElementById(id);
        return [c.height, Math.round(c.getBoundingClientRect().height)];
      }),
    }));
    check(sizes.every(([px, css]) => css <= 201 && px <= Math.ceil(200 * dpr) + 1), `spectrum canvases keep their size at ${dpr}x scaling (${JSON.stringify(sizes)})`);
    await page.screenshot({ path: join(OUT, 'device-mode.png'), fullPage: true });
    await page.click('#stop');
    check(!(await page.isDisabled('#export-csv')), 'CSV export available after stop');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#export-csv')]);
    const csv = await readFile(await dl.path(), 'utf8');
    const lines = csv.trim().split('\n');
    check(lines[0].startsWith('wall_clock,elapsed_s') && lines.length > 10, `CSV has ${lines.length - 1} rows`);

    console.log('Browser tab mode (test player tab playing 18Oct2026-30):');
    const player = await context.newPage();
    await player.goto(`${url}test/fixtures/player.html`);
    await player.evaluate(() => document.getElementById('a').play());
    await page.bringToFront();
    await page.selectOption('#source', 'tab');
    check(await page.isVisible('#tab-reminder'), 'YouTube Stable Volume reminder shown');
    page.once('dialog', (d) => d.accept()); // "start a new session?" confirmation
    await page.click('#start');
    try {
      await page.waitForFunction(() => document.getElementById('status').textContent === 'CLIPPING', null, { timeout: 20000 });
      check(true, 'tab capture reaches CLIPPING');
    } catch {
      check(false, `tab capture reaches CLIPPING (status ${await page.textContent('#status')}, error: ${await page.textContent('#error')})`);
    }
    await page.screenshot({ path: join(OUT, 'tab-mode.png'), fullPage: true });
    await page.click('#stop');

    console.log('Settings:');
    await page.click('#settings-btn');
    await page.fill('input[name="truePeak.dbtp"]', '-2');
    await page.click('dialog button[value="save"]');
    await page.waitForFunction(() => localStorage.getItem('streammon.alerts.v1'), null, { timeout: 5000 });
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('streammon.alerts.v1')));
    check(saved.truePeak.dbtp === -2 && saved.sound === false, 'alert threshold saved, sound still off');

    check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join(' | ')}` : ''}`);
  } catch (e) {
    console.error(e.message);
    failures++;
  } finally {
    if (errors.length) console.log('Page errors:\n  ' + errors.join('\n  '));
    const err = await page.textContent('#error').catch(() => '');
    if (err) console.log('App error banner:', err);
    await browser.close();
    server.close();
  }
  console.log(failures ? `\n${failures} check(s) failed` : '\nAll browser checks passed');
  console.log(`Screenshots in ${OUT}`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

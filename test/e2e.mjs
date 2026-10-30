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
    // Rapid seeks: each clears the spectrum while a redraw may be pending (caught by the
    // "no page errors" check at the end).
    const tl = await page.locator('#timeline').boundingBox();
    for (let i = 0; i < 30; i++) {
      await page.mouse.click(tl.x + tl.width * (0.2 + 0.02 * i), tl.y + tl.height / 2);
      await page.waitForTimeout(170 + (i % 5) * 23);
    }
    check(true, 'rapid seeks during playback');
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
    // Banners update every second: the × must stay the same element (a replaced one under
    // the pointer between mouse down and up loses the click), and clicking it dismisses.
    const firstId = await page.locator('.alert').first().getAttribute('data-id');
    const button = await page.locator('.alert button').first().elementHandle();
    await page.waitForTimeout(1500);
    check(await button.evaluate((b) => b.isConnected), 'banners are updated in place, not rebuilt');
    await button.click();
    const ids = await page.$$eval('.alert', (d) => d.map((x) => x.dataset.id));
    check(firstId && !ids.includes(firstId), `× dismisses the banner (${firstId}; left: ${ids.join(', ') || 'none'})`);
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
        return [c.height, Math.round(c.getBoundingClientRect().height), Number(c.style.height.replace('px', ''))];
      }),
    }));
    check(sizes.every(([px, css, set]) => set <= 481 && css <= set + 1 && px <= Math.ceil(set * dpr) + 1), `spectrum canvases keep their size at ${dpr}x scaling (${JSON.stringify(sizes)})`);
    const hoverText = async (id, fx, fy) => {
      await page.locator(`#${id}`).scrollIntoViewIfNeeded();
      const box = await page.locator(`#${id}`).boundingBox();
      await page.mouse.move(box.x + box.width * fx, box.y + box.height * fy);
      await page.waitForSelector('#tooltip:not([hidden])', { timeout: 3000 });
      return page.textContent('#tooltip');
    };
    const bandTip = await hoverText('bands', 0.5, 0.5);
    check(/5 s average/.test(bandTip) && /octave/.test(bandTip), `hovering a spectrum bar shows its reading (${bandTip})`);
    const sgTip = await hoverText('sgram', 0.5, 0.05);
    check(/FFT bin/.test(sgTip) && /dB/.test(sgTip), `hovering the spectrogram shows a reading (${sgTip})`);
    await page.mouse.move(0, 0);
    const stereoNote = await page.textContent('#stereo-bands-note');
    check(stereoNote && stereoNote !== '--', `stereo-by-band panel reports (${stereoNote})`);
    await page.screenshot({ path: join(OUT, 'device-mode.png'), fullPage: true });
    // A stand-in save dialog, so "Record CSV to disk" can run headless.
    await page.evaluate(() => {
      // Like Chrome, what is written only reaches the "file" when the stream is closed.
      window.csvFile = '';
      window.showSaveFilePicker = async () => ({
        name: 'test.csv',
        getFile: async () => new Blob([window.csvFile]),
        createWritable: async ({ keepExistingData = false } = {}) => {
          let data = keepExistingData ? window.csvFile : '';
          return { seek: async () => {}, write: async (t) => (data += t), close: async () => (window.csvFile = data), abort: async () => {} };
        },
      });
    });
    await page.click('#record-disk');
    await page.waitForFunction(() => /Recording to test\.csv/.test(document.getElementById('record-disk').textContent), null, { timeout: 5000 });
    // Reset while the pointer rests on the loudness chart, whose rows are cleared under it.
    await page.locator('#history').scrollIntoViewIfNeeded();
    const hist = await page.locator('#history').boundingBox();
    await page.mouse.move(hist.x + hist.width * 0.97, hist.y + hist.height / 2);
    await page.waitForSelector('#tooltip:not([hidden])', { timeout: 3000 });
    await page.evaluate(() => document.getElementById('reset').click());
    await page.waitForFunction(() => /Reset/.test(document.getElementById('log-body').textContent), null, { timeout: 5000 });
    const logAfterClear = await page.textContent('#log-body');
    check(!/True peak max reset|Alert: Clipping/.test(logAfterClear) && !(await page.isVisible('.alert')), 'Reset clears the log and alerts');
    check(!(await page.isVisible('#error')), `Reset works with the pointer on a chart (${await page.textContent('#error')})`);
    await page.mouse.move(0, 0);
    const disk = await page.evaluate(() => ({ lines: window.csvFile.trim().split('\n').length, header: window.csvFile.startsWith('wall_clock,'), stopped: !/Recording/.test(document.getElementById('record-disk').textContent) }));
    check(disk.stopped && /recording to test\.csv stopped/.test(logAfterClear), 'Reset stops recording the CSV to disk (logged)');
    check(disk.header && disk.lines > 2, `the rows reached the file on disk (${disk.lines} lines)`);
    await page.waitForFunction(() => !document.getElementById('reset').disabled, null, { timeout: 3000 });
    await page.click('#reset');
    await page.waitForFunction(() => !document.getElementById('reset').disabled && /measuring afresh/.test(document.getElementById('log-body').textContent), null, { timeout: 5000 });
    check(true, 'Reset can be used again straight away');
    await page.waitForFunction(() => document.getElementById('status').textContent === 'CLIPPING', null, { timeout: 20000 });
    await page.waitForFunction(() => /elapsed 0:(0[5-9]|[1-5]\d)/.test(document.getElementById('elapsed').textContent), null, { timeout: 10000 });
    check(true, `measuring resumes after Reset (${await page.textContent('#elapsed')})`);
    await page.click('#stop');
    await page.waitForTimeout(600); // a few UI ticks: a frame in flight at Stop must not repaint the status
    check((await page.textContent('#status')) === 'IDLE', `status stays IDLE after Stop (${await page.textContent('#status')})`);
    check(!(await page.isDisabled('#export-csv')), 'CSV export available after stop');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#export-csv')]);
    const csv = await readFile(await dl.path(), 'utf8');
    const lines = csv.trim().split('\n');
    check(lines[0].startsWith('wall_clock,elapsed_s') && lines.length > 3, `CSV has ${lines.length - 1} rows`);
    check(Number(lines[1].split(',')[1]) <= 1, `CSV starts at the Reset (first row at ${lines[1].split(',')[1]} s)`);

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
    check(saved.truePeak.dbtp === -2 && saved.sound !== true && !('hum' in saved) && saved.version === 2, `alert threshold saved, sound still off, untouched defaults not stored (${JSON.stringify(saved)})`);
    await page.click('#settings-btn');
    await page.fill('input[name="truePeak.dbtp"]', '-5');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    const afterEsc = await page.evaluate(() => JSON.parse(localStorage.getItem('streammon.alerts.v1')));
    check(afterEsc.truePeak.dbtp === -2, `Esc closes the settings without saving (true peak ${afterEsc.truePeak.dbtp})`);
    await page.click('#settings-btn');
    await page.fill('input[name="display.spectrogramFloorDb"]', '-80');
    await page.click('dialog button[value="save"]');
    await page.waitForTimeout(200);
    const floor = await page.evaluate(() => JSON.parse(localStorage.getItem('streammon.alerts.v1')).display.spectrogramFloorDb);
    check(floor === -80, `spectrogram floor saved (${floor} dB)`);

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

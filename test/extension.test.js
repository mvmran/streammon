// Logic tests for the extension's YouTube player check and site rule (no browser needed).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describePlayer, isYouTubeUrl } from '../extension/player.js';

const levels = (p) => describePlayer(p).map((i) => i.level);

test('no player state: nothing to show', () => {
  assert.deepEqual(describePlayer(null), []);
});

test('player missing on the page', () => {
  assert.deepEqual(levels({ found: false }), ['warning']);
});

test('100% volume, normalisation unreadable: reminder to check Stable Volume', () => {
  assert.deepEqual(levels({ found: true, volume: 100, muted: false, loudness: null }), ['good', 'info']);
});

test('muted player is critical', () => {
  assert.equal(levels({ found: true, volume: 100, muted: true, loudness: null })[0], 'critical');
});

test('volume below 100% warns', () => {
  const items = describePlayer({ found: true, volume: 60, muted: false, loudness: null });
  assert.equal(items[0].level, 'warning');
  assert.match(items[0].text, /60%/);
});

test('YouTube normalisation turning the stream down warns, with content loudness', () => {
  const items = describePlayer({ found: true, volume: 100, muted: false, loudness: '100% / 56% (content loudness 5.1dB)' });
  assert.equal(items[1].level, 'warning');
  assert.match(items[1].text, /56%/);
  assert.match(items[1].text, /5\.1 dB/);
});

test('no normalisation applied is good', () => {
  assert.deepEqual(levels({ found: true, volume: 100, muted: false, loudness: '100% / 100% (content loudness -2.0dB)' }), ['good', 'good']);
});

test('only YouTube pages are monitored', () => {
  assert.ok(isYouTubeUrl('https://www.youtube.com/watch?v=abc'));
  assert.ok(isYouTubeUrl('https://m.youtube.com/live/abc'));
  assert.ok(!isYouTubeUrl('https://lscroster.xyz/'));
  assert.ok(!isYouTubeUrl('https://www.youtube.com.evil.example/'));
  assert.ok(!isYouTubeUrl('http://www.youtube.com/'), 'https only, like the button rule');
  assert.ok(!isYouTubeUrl(undefined), 'other sites: the URL is hidden from the extension');
});

test('the toolbar button is disabled each time the service worker starts, browser start included', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../extension/background.js', import.meta.url), 'utf8');
  assert.match(src, /^chrome\.action\.disable\(\);$/m, 'disabled at the top level, not only in onInstalled');
  assert.match(src, /^chrome\.runtime\.onStartup\.addListener\(/m, 'an onStartup listener, so the worker runs at browser start');
});

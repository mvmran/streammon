// Every card on every page has hover help, and every help key has text.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { HELP } from '../src/ui/help.js';

const ROOT = new URL('..', import.meta.url).pathname;
const PAGES = ['index.html', 'extension/panel.html', 'extension/dashboard.html'];

for (const page of PAGES) {
  const html = readFileSync(ROOT + page, 'utf8');

  test(`${page}: every data-help key has text`, () => {
    for (const [, key] of html.matchAll(/data-help="([^"]+)"/g)) assert.ok(HELP[key], `no help text for "${key}"`);
  });

  test(`${page}: every meter tile and panel heading has help`, () => {
    const tiles = [...html.matchAll(/<div[^>]*\bclass="tile[^"]*"[^>]*>/g)].map((m) => m[0]);
    assert.ok(tiles.length >= 5, `found ${tiles.length} tiles`);
    for (const t of tiles) assert.match(t, /data-help=/, t);
    for (const [h2] of html.matchAll(/<h2[^>]*>[^<]*/g)) {
      if (/id="file-name"|Alerts &amp; settings/.test(h2)) continue; // file name heading, settings dialog
      assert.match(h2, /data-help=/, h2);
    }
  });
}

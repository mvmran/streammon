// YouTube player checks. Player volume and YouTube's loudness normalisation (Stable
// Volume) both change the level the tab plays, so LUFS readings are only true to the
// stream at 100% volume with no normalisation. Clipping detection is unaffected.
//
// getVolume()/isMuted() are long-standing player methods. getStatsForNerds() and the
// "content loudness" text are undocumented and may change, so they are best effort:
// when they can't be read, the panel shows a reminder instead of a verdict.

// The extension is limited to YouTube for now: the store listing and its host permissions
// say so, although tab capture itself works on any tab (the toolbar click grants it).
export const YOUTUBE_HOSTS = ['www.youtube.com', 'm.youtube.com'];

// True for an https YouTube page. Other tabs' URLs are hidden from the extension (no host
// permission), so they come through as undefined: not YouTube.
export function isYouTubeUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && YOUTUBE_HOSTS.includes(u.host);
  } catch {
    return false;
  }
}

// Runs inside the YouTube page (MAIN world). Must be self-contained.
function readPlayerState() {
  const p = document.getElementById('movie_player');
  if (!p || typeof p.getVolume !== 'function') return { found: false };
  const out = { found: true, volume: p.getVolume(), muted: typeof p.isMuted === 'function' ? !!p.isMuted() : false, loudness: null };
  try {
    const stats = typeof p.getStatsForNerds === 'function' ? p.getStatsForNerds() : null;
    if (stats) {
      for (const v of Object.values(stats)) {
        if (typeof v === 'string' && /content loudness|\d+%\s*\/\s*\d+%/i.test(v)) out.loudness = v;
      }
    }
  } catch {
    // Not available on this player version.
  }
  return out;
}

export async function checkPlayer(tabId) {
  if (!(tabId >= 0)) return null;
  try {
    const [res] = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: readPlayerState });
    return res ? res.result : null;
  } catch {
    return null; // tab closed or navigated away from YouTube
  }
}

// Turns a player state into checklist items: [{ level: 'good'|'warning'|'critical', text }].
export function describePlayer(p) {
  if (!p) return [];
  if (!p.found) return [{ level: 'warning', text: 'YouTube player not found on the monitored tab' }];
  const items = [];
  if (p.muted) items.push({ level: 'critical', text: 'Player is muted: the monitor hears silence' });
  else if (p.volume < 100) items.push({ level: 'warning', text: `Player volume ${p.volume}%: set it to 100% (LUFS reads low)` });
  else items.push({ level: 'good', text: 'Player volume 100%' });

  const m = p.loudness && p.loudness.match(/(\d+)%\s*\/\s*(\d+)%/);
  const cl = p.loudness && p.loudness.match(/content loudness\s*(-?[\d.]+)\s*dB/i);
  if (m && Number(m[2]) < Number(m[1])) {
    items.push({ level: 'warning', text: `YouTube is turning this stream down to ${m[2]}%${cl ? ` (content loudness ${cl[1]} dB)` : ''}: turn Stable Volume off; LUFS reads low` });
  } else if (m) {
    items.push({ level: 'good', text: 'No YouTube loudness normalisation' });
  } else {
    items.push({ level: 'info', text: 'Check Stable Volume is off (player gear menu)' });
  }
  return items;
}

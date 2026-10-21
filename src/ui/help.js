// Hover / focus help for the cards. Elements carry data-help="<key>"; the text lives
// here so the web app, side panel and dashboard share one wording. Written for the
// volunteers at the desk, not for engineers.

export const HELP = {
  status:
    'Whether the audio is being damaged. CLEAN (green): peaks are natural. LIMITED (amber): a limiter is holding the peaks at one level. That is fine unless it is on all the time. CLIPPING (red): the waveform has been cut flat somewhere before this point, even if the meters are below 0. Turning the stream down will not fix it: lower the level going into the stage that is overloading.',
  'short-term':
    'How loud it sounds over the last 3 seconds, in LUFS (loudness, not peak level). Aim for −16 to −12. Above −10 for long is too loud for YouTube. Momentary is the last 0.4 s.',
  integrated:
    'Average loudness of the whole session so far, measured the way YouTube does (silent gaps are ignored). YouTube’s reference is about −14 LUFS; louder streams get turned down by YouTube. LRA (loudness range) is how much the loudness varies: under about 2 LU means the sound is heavily squashed. Click the card to restart both from now, e.g. after changing the mix.',
  'true-peak':
    'The highest peak since Start (or since you last clicked this card), including peaks that appear between samples when the audio is converted. Keep it below −1 dBTP so YouTube’s encoder has headroom. "Now" is the last tenth of a second. Click the card to reset it, e.g. after changing a gain.',
  crest:
    'How far the peaks stand above the average level, over the last 3 seconds. Natural speech and music: about 12–20 dB. Heavily limited audio: about 10–11 dB. Clipped audio: often under 9 dB.',
  stereo:
    'MONO means left and right are identical (correlation above 0.999); all our feeds are normally mono. Corr is the left/right correlation: 1 identical, 0 unrelated, negative means out of phase (it can cancel on mono speakers). S/M is how much side (stereo) content there is compared with the centre.',
  history:
    'Short-term loudness over time. The shaded band is the −16 to −12 LUFS target. Dashed lines: −10 LUFS (too loud) and the level the peaks keep reaching (the clip ceiling when clipping). The coloured strip underneath is the status each second: green clean, amber limited, red clipping. Hover the graph for values.',
  peaks:
    'The highest sample (blue) and true peak (orange) in each second. Natural audio makes a jagged line. A flat line of peaks sitting at one level means something is clipping or limiting. Dashed lines: the true-peak alert limit and the ceiling.',
  spectrum:
    'How much energy is in each third of an octave, from deep bass (left) to treble (right). The bars show this instant; the thin line is the average over about 5 seconds, the same averaging as the octave balance, so the two agree. The darker bars are the octave-balance frequencies; each octave there covers its darker bar and the bar either side. Hover a bar for its reading. Useful for spotting boomy lows, harshness or missing highs. Display only: it does not affect any measurement.',
  spectrogram:
    'The spectrum over the last 30 seconds or so, scrolling downwards: newest at the top, frequency left to right on the same scale as the spectrum bars above, brighter means louder. Hover for a reading; each pixel is the loudest single FFT bin in its range, so it reads lower than the bars. Content stopping around 16 kHz is normal for YouTube audio.',
  'stereo-bands':
    'How the stereo image differs across the frequency range: one dot per octave, darker for bass and lighter for treble, with its name beside it. Up and down is the L/R correlation, from +1 to −1: at the top the band is the same in both channels (mono); around 0 it is wide; below 0 it is out of phase and cancels on a mono speaker or phone. Left and right is balance: a dot off-centre means that band is louder on one side. Bigger dots are louder bands. The dashed half-oval is a rough guide to where a healthy stereo mix sits: positive correlation and within about 3 dB of centre (bass right at the top, wider instruments and reverb a little lower). A whole cloud outside it, or filled dots below 0, is worth checking. An outlined dot is below -70 dBFS: mostly the source’s own noise (two microphones’ hiss looks wide or out of phase), so it is not judged. Averaged over 1 second. Display only: it does not affect any measurement.',
  balance:
    'Average level of each octave compared with the 500 Hz band, over about 5 seconds. It is normal for the top octaves to be 10–20 dB below 500 Hz. Look for one band sticking out, or for changes during the service.',
  log:
    'Every time clipping or limiting starts or ends, and every alert, with the clock time, the ceiling level in dBFS and which detector fired. Export it with the CSV/JSON buttons. For a file, click an entry to listen from just before it.',
  detectors:
    'The numbers behind the status, for checking or tuning. Dwell: how often the audio lingers within 1 dB of its ceiling. Pile-up: whether samples crowd against a hard wall at that ceiling (the sign of clipping). Peaks pinned: share of peaks held at the ceiling (the sign of limiting). Full-scale runs: samples stuck at 0 dBFS.',
  hum:
    'Mains (powerline) hum: a steady tone at the mains frequency (50 or 60 Hz, set in Alerts & settings) and its multiples. PRESENT: a mains-locked tone that stands out, stays on frequency, keeps its phase and holds a steady level. NOT DETECTED: none, and one at the alert level would have shown. MASKED: the programme near that frequency is too loud to judge (music never counts as "none"). The projection shows how loud the hum becomes if quiet speech is turned up to the target.',
  'hum-harmonics':
    'Hum harmonics at 1×, 2×, 3×… the mains frequency, in dB relative to the fundamental, averaged in step with the mains so programme sound averages away. Solid: clearly above the noise floor; faded: tentative; outline: below the floor (not measurable here). Strong 3rd and 5th hint at a ground loop or unbalanced line; strong 2nd and 4th at a rectifier or power supply. A hint, not a verdict.',
  timeline:
    'The whole file: short-term loudness (blue) and the peak of each second (orange), with the status strip underneath. Click anywhere to listen from that point with the meters running.',
};

const SHOW_DELAY_MS = 350;

export function setupHelp(doc = document) {
  const tip = doc.getElementById('tooltip');
  if (!tip) return;
  let timer = null;
  let current = null;

  for (const el of doc.querySelectorAll('[data-help]')) {
    const text = HELP[el.dataset.help];
    if (!text) continue;
    el.setAttribute('aria-description', text);
    if (!el.hasAttribute('tabindex')) el.tabIndex = 0;
  }

  const show = (el) => {
    current = el;
    tip.className = 'tooltip help';
    tip.textContent = HELP[el.dataset.help];
    tip.hidden = false;
    // Below the card (so its reading stays visible), kept inside the window.
    const r = el.getBoundingClientRect();
    const w = tip.offsetWidth;
    const left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
    const below = r.bottom + 6;
    const top = below + tip.offsetHeight > window.innerHeight - 8 ? Math.max(8, r.top - tip.offsetHeight - 6) : below;
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
  };
  const hide = () => {
    clearTimeout(timer);
    if (current) {
      tip.hidden = true;
      tip.className = 'tooltip';
      current = null;
    }
  };
  const target = (e) => {
    const el = e.target.closest && e.target.closest('[data-help]');
    return el && HELP[el.dataset.help] ? el : null;
  };

  doc.addEventListener('pointerover', (e) => {
    const el = target(e);
    if (el === current) return;
    hide();
    if (el) timer = setTimeout(() => show(el), SHOW_DELAY_MS);
  });
  doc.addEventListener('pointerout', (e) => {
    const el = target(e);
    if (el && !el.contains(e.relatedTarget)) hide();
  });
  doc.addEventListener('focusin', (e) => {
    const el = target(e);
    if (el && el.matches(':focus-visible')) show(el);
  });
  doc.addEventListener('focusout', hide);
  doc.addEventListener('keydown', (e) => e.key === 'Escape' && hide());
  window.addEventListener('scroll', hide, { passive: true });
}

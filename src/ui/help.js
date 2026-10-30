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
    'One word for the stereo picture. MONO: left and right identical. STEREO OK: balanced, with positive correlation. WIDE: most of the sound has little in common between the sides. UNBALANCED: the whole mix is more than 3 dB louder on one side (also when both sides carry the same sound, one of them turned down). PHASE PROBLEM: a loud band from 125 Hz up stays out of phase over 3 seconds, so it cancels on mono speakers and phones (this raises an alert). CHANNEL DEAD: one side is silent (30 dB or more quieter) while the other carries sound, e.g. an unplugged cable or a muted output (this raises an alert). Corr is the overall left/right correlation; S/M is how much side (stereo) content there is compared with the centre.',
  history:
    'Short-term loudness over time. The shaded band is the −16 to −12 LUFS target. Dashed lines: −10 LUFS (too loud) and the level the peaks keep reaching (the clip ceiling when clipping). The coloured strip underneath is the status each second: green clean, amber limited, red clipping. The orange line is the stereo correlation, read on the right-hand scale in the lower half: +1 mono, 0 wide, below 0 out of phase. Hover the graph for values.',
  peaks:
    'The highest sample (blue) and true peak (orange) in each second. Natural audio makes a jagged line. A flat line of peaks sitting at one level means something is clipping or limiting. Dashed lines: the true-peak alert limit and the ceiling.',
  spectrum:
    'How much energy is in each third of an octave, from deep bass (left) to treble (right). The bars show this instant; the thin line is the average over about 5 seconds, the same averaging as the octave balance, so the two agree. The darker bars are the octave-balance frequencies; each octave there covers its darker bar and the bar either side. The numbers on the line are the octave balance readings (dB compared with 500 Hz), the same as in the Octave balance panel. Hover a bar for its reading. Useful for spotting boomy lows, harshness or missing highs. Display only: it does not affect any measurement.',
  spectrogram:
    'The spectrum over the last 50 seconds or so, scrolling downwards: newest at the top, frequency left to right on the same scale as the spectrum bars above, brighter means louder. Hover for a reading; each pixel is the loudest single FFT bin in its range, so it reads lower than the bars. Content stopping around 16 kHz is normal for YouTube audio. Anything below the floor (−85 dB unless changed under Alerts & settings → Display) shows as background.',
  'pan-map':
    'Where the sound sits left to right (across) at each frequency (up), averaged over about a second. Brighter means louder. A centred vocal and bass make a bright column in the middle; instruments panned to one side light up off-centre. On a mono feed everything is in the centre column. The edge columns hold anything 19 dB or more louder on that side. Bands below about −75 dBFS (mostly microphone hiss) are left dark.',
  'stereo-bands':
    'One dot per octave, darker for bass and lighter for treble. Up and down is L/R correlation: +1 is mono, 0 is wide, below 0 is out of phase (cancels on a mono speaker). Left and right is balance. Bigger dots are louder bands; outlined dots are too quiet to judge. The dashed half-oval is roughly where a healthy stereo mix sits. Averaged over 1 second, so a band can dip below 0 for a moment: normal in recordings made with spaced microphones, bass notes especially. Only a band that stays down there is a problem (the Stereo card then says PHASE PROBLEM).',
  balance:
    'Average level of each octave compared with the 500 Hz band, over about 5 seconds. It is normal for the top octaves to be 10–20 dB below 500 Hz. Look for one band sticking out, or for changes during the service.',
  log:
    'Every time clipping or limiting starts or ends, mains hum appears or goes, the Stereo word changes and stays changed for 10 s, and every alert, with the clock time (when it began), the ceiling level in dBFS and which detector fired. The JSON export includes the log; the CSV has the stereo word and its reason every second. For a file, click an entry to listen from just before it.',
  detectors:
    'The numbers behind the status, for checking or tuning. Dwell: how often the audio lingers within 1 dB of its ceiling. Pile-up: whether samples crowd against a hard wall at that ceiling (the sign of clipping). Peaks pinned: share of peaks held at the ceiling (the sign of limiting). Full-scale runs: samples stuck at 0 dBFS.',
  hum:
    'Mains (powerline) hum: a steady tone at the mains frequency (50 or 60 Hz, set in Alerts & settings) and its multiples. PRESENT: a mains-locked tone that stands out, stays on frequency, keeps its phase and holds a steady level. NOT DETECTED: none, and one at the alert level would have shown. MASKED: the programme near that frequency is too loud to judge (music never counts as "none"). The projection shows how loud the hum becomes if quiet speech is turned up to the target. Buzz in pauses: whenever it goes quiet for a second, the mains harmonics that stand out (three or more), added up. That is what people hear on laptop and phone speakers, often at 150–450 Hz, even when the 50 Hz tone itself is too quiet to show as PRESENT; "Hum in pauses" alerts when it is above its level (−80 dBFS unless changed) twice within a minute.',
  'hum-harmonics':
    'Hum harmonics at 1×, 2×, 3×… the mains frequency, in dB relative to the fundamental, averaged in step with the mains so programme sound averages away. Solid: clearly above the noise floor; faded: tentative; outline: below the floor (not measurable here). Strong 3rd and 5th hint at a ground loop or unbalanced line; strong 2nd and 4th at a rectifier or power supply. A hint, not a verdict.',
  timeline:
    'The whole file: short-term loudness (blue) and the peak of each second (orange), with the status strip underneath. Click anywhere to listen from that point with the meters running.',
};

const SHOW_DELAY_MS = 350;

// iconOnly: show the text only while the pointer is on the (i) icon, not anywhere on the
// card (the side panel is narrow, and help popping up over the readings is distracting).
// The CSS-drawn icons are then replaced by real elements that can be hovered.
export function setupHelp(doc = document, { iconOnly = false } = {}) {
  const tip = doc.getElementById('tooltip');
  if (!tip) return;
  let timer = null;
  let current = null;

  for (const el of doc.querySelectorAll('[data-help]')) {
    const text = HELP[el.dataset.help];
    if (!text) continue;
    el.setAttribute('aria-description', text);
    if (!el.hasAttribute('tabindex')) el.tabIndex = 0;
    if (iconOnly) {
      const icon = doc.createElement('span');
      icon.className = 'help-icon';
      icon.setAttribute('aria-hidden', 'true');
      icon.textContent = 'i';
      const label = el.querySelector(':scope > .label');
      if (label) label.append(icon);
      else if (el.classList.contains('badge')) el.after(icon);
      else el.append(icon);
      icon.helpFor = el;
    }
  }
  if (iconOnly) doc.documentElement.classList.add('help-icon-only');

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
  // The element whose help applies, and the element the pointer has to stay on.
  const target = (e) => {
    if (!e.target.closest) return null;
    if (iconOnly) {
      const icon = e.target.closest('.help-icon');
      return icon ? { el: icon.helpFor, area: icon } : null;
    }
    const el = e.target.closest('[data-help]');
    return el && HELP[el.dataset.help] ? { el, area: el } : null;
  };

  doc.addEventListener('pointerover', (e) => {
    const t = target(e);
    if (t && t.el === current) return;
    hide();
    if (t) timer = setTimeout(() => show(t.el), SHOW_DELAY_MS);
  });
  doc.addEventListener('pointerout', (e) => {
    const t = target(e);
    if (t && !t.area.contains(e.relatedTarget)) hide();
  });
  doc.addEventListener('focusin', (e) => {
    const el = e.target.closest && e.target.closest('[data-help]');
    if (el && HELP[el.dataset.help] && el.matches(':focus-visible')) show(el);
  });
  doc.addEventListener('focusout', hide);
  doc.addEventListener('keydown', (e) => e.key === 'Escape' && hide());
  window.addEventListener('scroll', hide, { passive: true });
}

// Alert settings dialog, persisted per browser in localStorage.

import { DEFAULT_ALERTS, mergeAlertConfig } from '../dsp/alerts.js';

const KEY = 'streammon.alerts.v1';

// Settings are saved as the differences from DEFAULT_ALERTS (version 2), so a changed
// default reaches everyone who didn't change that value. Before version 2 every value was
// saved: those still holding an old default get the new one; other values are kept.
const SETTINGS_VERSION = 2;
const OLD_DEFAULTS = [
  ['hum', 'alertLevelDbfs', -75], // -85 since version 2: quieter hum is audible in pauses
  ['display', 'spectrogramFloorDb', -100], // -85 since version 2
];

export function migrateSaved(saved) {
  if (!saved || typeof saved !== 'object' || saved.version >= SETTINGS_VERSION) return saved;
  const out = structuredClone(saved);
  for (const [section, key, old] of OLD_DEFAULTS) if (out[section] && out[section][key] === old) delete out[section][key];
  return out;
}

export function loadAlertConfig() {
  try {
    const raw = localStorage.getItem(KEY);
    return mergeAlertConfig(DEFAULT_ALERTS, raw ? migrateSaved(JSON.parse(raw)) : {});
  } catch {
    return mergeAlertConfig(DEFAULT_ALERTS);
  }
}

// The values that differ from the defaults, section by section.
export function changedFromDefaults(cfg, defaults = DEFAULT_ALERTS) {
  const out = {};
  for (const [k, v] of Object.entries(cfg)) {
    if (!(k in defaults)) continue;
    if (v && typeof v === 'object' && typeof defaults[k] === 'object') {
      const d = Object.fromEntries(Object.entries(v).filter(([kk, vv]) => defaults[k][kk] !== vv));
      if (Object.keys(d).length) out[k] = d;
    } else if (defaults[k] !== v) out[k] = v;
  }
  return out;
}

function saveAlertConfig(cfg) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...changedFromDefaults(cfg), version: SETTINGS_VERSION }));
  } catch {
    // Storage unavailable (private window): settings last for this page only.
  }
}

const get = (obj, path) => path.split('.').reduce((o, k) => o && o[k], obj);
const set = (obj, path, v) => {
  const keys = path.split('.');
  const last = keys.pop();
  keys.reduce((o, k) => o[k], obj)[last] = v;
};

export function setupSettings(dialog, button, onChange) {
  const form = dialog.querySelector('form');
  let cfg = loadAlertConfig();

  const fill = (c) => {
    for (const el of form.elements) {
      if (!el.name) continue;
      const v = get(c, el.name);
      if (el.type === 'checkbox') el.checked = !!v;
      else el.value = v;
    }
  };

  button.addEventListener('click', () => {
    fill(cfg);
    dialog.returnValue = ''; // Esc closes without setting it: a previous 'save' must not stick
    dialog.showModal();
  });
  dialog.querySelector('#settings-reset').addEventListener('click', () => fill(DEFAULT_ALERTS));
  dialog.addEventListener('close', () => {
    if (dialog.returnValue !== 'save') return;
    const next = structuredClone(cfg);
    for (const el of form.elements) {
      if (!el.name) continue;
      if (el.type === 'checkbox') set(next, el.name, el.checked);
      else if (el.value !== '' && Number.isFinite(Number(el.value))) set(next, el.name, Number(el.value));
    }
    cfg = next;
    saveAlertConfig(cfg);
    onChange(cfg);
  });
  return cfg;
}

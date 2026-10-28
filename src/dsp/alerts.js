// Alert rules evaluated on the analyzer's 1-second rows. Pure logic so the thresholds
// can be tested without a browser.

export const DEFAULT_ALERTS = {
  clipping: { enabled: true, seconds: 1 },
  truePeak: { enabled: true, dbtp: -1 },
  shortTermHigh: { enabled: true, lufs: -10, seconds: 10 },
  integratedOff: { enabled: true, target: -14, tolerance: 4, minSeconds: 60 },
  // Mains hum: these also configure the detector (mains frequency, alert level, speech target).
  hum: { enabled: true, mainsFrequencyHz: 50, alertLevelDbfs: -75, speechTargetLufs: -18, seconds: 5 },
  // Stereo status (live sources): phase problem and imbalance alerts; a mono-feed alert is opt-in.
  stereo: { enabled: true, phaseSeconds: 5, unbalancedSeconds: 15, deadSeconds: 5, mono: false, monoSeconds: 10 },
  // Display only (kept with the alert settings, which are the app's settings store).
  display: { spectrogramFloorDb: -100 },
  clearAfterSec: 5, // an alert stays up until its condition has been absent this long
  sound: false, // off by default: this runs during services
};

export const ALERT_LABELS = {
  clipping: 'Clipping',
  truePeak: 'True peak',
  shortTermHigh: 'Too loud',
  integratedOff: 'Integrated loudness off target',
  hum: 'Mains hum',
  stereoPhase: 'Phase problem',
  stereoBalance: 'Stereo unbalanced',
  stereoMono: 'Mono feed',
  stereoDead: 'Channel dead',
};

// The detector settings held in the alert configuration.
export function humOptionsFrom(config) {
  const h = (config && config.hum) || DEFAULT_ALERTS.hum;
  return { mainsFrequencyHz: h.mainsFrequencyHz, alertLevelDbfs: h.alertLevelDbfs, speechTargetLufs: h.speechTargetLufs };
}

export function mergeAlertConfig(base, override = {}) {
  const out = structuredClone(base);
  for (const [k, v] of Object.entries(override || {})) {
    if (v && typeof v === 'object' && out[k] && typeof out[k] === 'object') Object.assign(out[k], v);
    else if (k in out) out[k] = v;
  }
  return out;
}

export class AlertMonitor {
  constructor(config = DEFAULT_ALERTS) {
    this.config = mergeAlertConfig(DEFAULT_ALERTS, config);
    this.reset();
  }

  reset() {
    this.run = { clipping: 0, shortTermHigh: 0, hum: 0, stereoPhase: 0, stereoBalance: 0, stereoMono: 0, stereoDead: 0 };
    this.active = {}; // id -> { since, lastSeen, message }
  }

  // Checks which alert conditions hold for this row. Returns { id: message }.
  conditions(row) {
    const c = this.config;
    const out = {};
    this.run.clipping = row.status === 'CLIPPING' ? this.run.clipping + 1 : 0;
    if (c.clipping.enabled && this.run.clipping >= c.clipping.seconds) {
      const det = row.detectors && row.detectors.length ? ` (${row.detectors.join(' + ')})` : '';
      out.clipping = `Clipping for ${this.run.clipping} s at ${fmt(row.ceilingDb)} dBFS${det}`;
    }
    if (c.truePeak.enabled && row.truePeakDb > c.truePeak.dbtp) {
      out.truePeak = `True peak ${fmt(row.truePeakDb)} dBTP (limit ${c.truePeak.dbtp})`;
    }
    this.run.shortTermHigh = row.shortTerm > c.shortTermHigh.lufs ? this.run.shortTermHigh + 1 : 0;
    if (c.shortTermHigh.enabled && this.run.shortTermHigh >= c.shortTermHigh.seconds) {
      out.shortTermHigh = `Short-term ${fmt(row.shortTerm)} LUFS above ${c.shortTermHigh.lufs} for ${this.run.shortTermHigh} s`;
    }
    const hm = c.hum;
    const humLoud = row.humStatus === 'PRESENT' && row.humLevelDb > hm.alertLevelDbfs;
    this.run.hum = humLoud ? this.run.hum + 1 : 0;
    if (hm.enabled && this.run.hum >= hm.seconds) {
      const proj = Number.isFinite(row.humProjectedDb) ? `; at ${hm.speechTargetLufs} LUFS speech it would be ${fmt(row.humProjectedDb)} dBFS` : '';
      out.hum = `${fmt(row.humLevelDb)} dBFS at ${row.humFrequencyHz.toFixed(2)} Hz${proj}`;
    }
    const sc = c.stereo;
    this.run.stereoPhase = row.stereoStatus === 'PHASE PROBLEM' ? this.run.stereoPhase + 1 : 0;
    this.run.stereoBalance = row.stereoStatus === 'UNBALANCED' ? this.run.stereoBalance + 1 : 0;
    this.run.stereoMono = row.stereoStatus === 'MONO' ? this.run.stereoMono + 1 : 0;
    this.run.stereoDead = row.stereoStatus === 'CHANNEL DEAD' ? this.run.stereoDead + 1 : 0;
    // The Stereo card's short reason, with the consequence spelled out for the banner and
    // the desktop notification.
    if (sc.enabled && this.run.stereoDead >= sc.deadSeconds) {
      out.stereoDead = `${row.stereoDetail}: only the ${/^Left/.test(row.stereoDetail) ? 'right' : 'left'} side carries sound (${this.run.stereoDead} s)`;
    }
    if (sc.enabled && this.run.stereoPhase >= sc.phaseSeconds) out.stereoPhase = `${row.stereoDetail}: cancels on mono speakers and phones (${this.run.stereoPhase} s)`;
    if (sc.enabled && this.run.stereoBalance >= sc.unbalancedSeconds) out.stereoBalance = `${/^\d/.test(row.stereoDetail) ? 'Whole mix ' : ''}${row.stereoDetail} (${this.run.stereoBalance} s)`;
    if (sc.enabled && sc.mono && this.run.stereoMono >= sc.monoSeconds) out.stereoMono = `Left and right identical for ${this.run.stereoMono} s`;
    const io = c.integratedOff;
    // Time since integrated loudness was last reset (rows from before that field: since start).
    const integrating = Number.isFinite(row.integratedSeconds) ? row.integratedSeconds : row.t;
    if (io.enabled && integrating >= io.minSeconds && Number.isFinite(row.integrated) && Math.abs(row.integrated - io.target) > io.tolerance) {
      out.integratedOff = `Integrated ${fmt(row.integrated)} LUFS (target ${io.target} ±${io.tolerance})`;
    }
    return out;
  }

  // Updates state from a row. Returns { raised: [{id, message}], cleared: [id], active }.
  update(row) {
    const now = this.conditions(row);
    const raised = [];
    const cleared = [];
    for (const [id, message] of Object.entries(now)) {
      if (!this.active[id]) {
        this.active[id] = { since: row.t, lastSeen: row.t, message };
        raised.push({ id, message, t: row.t });
      } else {
        Object.assign(this.active[id], { lastSeen: row.t, message });
      }
    }
    for (const [id, a] of Object.entries(this.active)) {
      if (!(id in now) && row.t - a.lastSeen >= this.config.clearAfterSec) {
        delete this.active[id];
        cleared.push(id);
      }
    }
    return { raised, cleared, active: this.active };
  }
}

function fmt(x) {
  return Number.isFinite(x) ? x.toFixed(1) : '-inf';
}

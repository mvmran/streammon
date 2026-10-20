// Formatting helpers shared by the UI modules.

const cssCache = new Map();
export function css(name) {
  if (!cssCache.has(name)) cssCache.set(name, getComputedStyle(document.documentElement).getPropertyValue(name).trim());
  return cssCache.get(name);
}

const MINUS = '−';

export function fmtDb(x, digits = 1) {
  if (x === null || x === undefined || Number.isNaN(x)) return '--';
  if (x === -Infinity) return `${MINUS}∞`;
  if (x === Infinity) return '∞';
  const s = x.toFixed(digits);
  return s.startsWith('-') ? MINUS + s.slice(1) : x > 0 && Number(s) !== 0 ? `+${s}` : s;
}

export function fmtDuration(sec) {
  if (!Number.isFinite(sec)) return '--';
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const mm = h ? String(m).padStart(2, '0') : String(m);
  return (h ? `${h}:` : '') + `${mm}:${String(s).padStart(2, '0')}`;
}

export function fmtClock(date) {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

// Local time as "YYYY-MM-DD HH:MM:SS" for CSV files.
export function fmtStamp(date) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`;
}

export function fileStamp(date = new Date()) {
  return fmtStamp(date).replace(/[: ]/g, '-');
}

export function download(name, text, type = 'text/plain') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// The two frigates' names in the drill. The exercise (maneuvers.js) is written with ALG and RUS; whatever the
// player types replaces those words wherever the scene shows them. Read once at import (the scene reloads
// to apply a change), kept in localStorage.
const KEY = 'intercept.shipNames';
const DEFAULTS = { alg: 'ALG', rus: 'RUS' };
export const NAME_MAX = 8;

// Capitals, digits, space and hyphen only; never empty.
export function cleanName(s, fallback) {
  const v = String(s ?? '').toUpperCase().replace(/[^A-Z0-9 -]/g, '').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
  return v || fallback;
}

function load() {
  try {
    // A shared link carries its own names (?names=ALPHA,BRAVO); they apply to that visit only.
    const q = new URLSearchParams(globalThis.location?.search ?? '').get('names');
    if (q) { const [a, b] = q.split(','); return { alg: cleanName(a, DEFAULTS.alg), rus: cleanName(b, DEFAULTS.rus) }; }
  } catch { /* no address */ }
  try {
    const raw = JSON.parse(globalThis.localStorage?.getItem(KEY) ?? 'null');
    if (raw) return { alg: cleanName(raw.alg, DEFAULTS.alg), rus: cleanName(raw.rus, DEFAULTS.rus) };
  } catch { /* no storage, or not JSON */ }
  return { ...DEFAULTS };
}

export const shipNames = load();
export function saveNames(alg, rus) {
  const next = { alg: cleanName(alg, DEFAULTS.alg), rus: cleanName(rus, DEFAULTS.rus) };
  try { localStorage.setItem(KEY, JSON.stringify(next)); return true; } catch { return false; }
}
// The exercise's words with the ships' names swapped in (both at once, so ALG -> RUS and RUS -> ALG is safe).
export const rn = (s) => String(s).replace(/\b(ALG|RUS)\b/g, (m) => (m === 'ALG' ? shipNames.alg : shipNames.rus));

// The ships' names in the drill. The exercise (maneuvers.js) is written with SHIP1 and SHIP2; whatever the
// player types replaces those words wherever the scene shows them. Read once at import (the scene reloads
// to apply a change), kept in localStorage.
const KEY = 'intercept.shipNames.v2'; // v2: the default names became SHIP1 / SHIP2 (old saved names are dropped)
const DEFAULTS = { ship1: 'SHIP1', ship2: 'SHIP2', unit: 'UNIT' };
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
    if (q) { const [a, b, c] = q.split(','); return { ship1: cleanName(a, DEFAULTS.ship1), ship2: cleanName(b, DEFAULTS.ship2), unit: cleanName(c, DEFAULTS.unit) }; }
  } catch { /* no address */ }
  try {
    const raw = JSON.parse(globalThis.localStorage?.getItem(KEY) ?? 'null');
    if (raw) return { ship1: cleanName(raw.ship1, DEFAULTS.ship1), ship2: cleanName(raw.ship2, DEFAULTS.ship2), unit: cleanName(raw.unit, DEFAULTS.unit) };
  } catch { /* no storage, or not JSON */ }
  return { ...DEFAULTS };
}

export const shipNames = load();
export function saveNames(ship1, ship2, unit) {
  const next = { ship1: cleanName(ship1, DEFAULTS.ship1), ship2: cleanName(ship2, DEFAULTS.ship2), unit: cleanName(unit, DEFAULTS.unit) };
  try { localStorage.setItem(KEY, JSON.stringify(next)); return true; } catch { return false; }
}
// The exercise's words with the ships' names swapped in (both at once, so SHIP1 -> SHIP2 and SHIP2 -> SHIP1 is safe).
export const rn = (s) => String(s).replace(/\b(SHIP1|SHIP2|UNIT)\b/g, (m) => (m === 'SHIP1' ? shipNames.ship1 : m === 'SHIP2' ? shipNames.ship2 : shipNames.unit));

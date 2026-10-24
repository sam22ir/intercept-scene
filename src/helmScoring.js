// Solo Air Defense's grade: a pure scoring module (no DOM, no three.js), tested in Node by test/helmScoring.test.mjs.
//
// A score is 0 to 100 and maps to a letter. The saturation raid is scored per raid (missiles that got through, decoys that got
// through, cells spent on decoys, guns' rounds) and the run is the mean of its raids; the plain mission is scored from kills,
// damage taken and ammunition used. The best run of each mode is kept in localStorage so the player has a mark to beat.

export const KEY = 'intercept.helm.best.v1';

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

export function gradeOf(score) {
  return score >= 95 ? 'S' : score >= 85 ? 'A' : score >= 70 ? 'B' : score >= 55 ? 'C' : 'D';
}

// One raid's result (`raidLog` in helm.js) -> { score, grade, parts }.
export function raidScore(res) {
  const parts = {
    missilesThrough: res.realStruck * 35, // a real missile that hit the ship
    decoysThrough: res.decoysStruck * 8,
    cellsWasted: res.cellsOnDecoys * 7, // a missile cell spent on a decoy
    ammo: Math.min(15, res.rounds / 150), // gun rounds fired
  };
  const score = Math.round(clamp(100 - Object.values(parts).reduce((a, b) => a + b, 0), 0, 100));
  return { score, grade: gradeOf(score), parts };
}

// A whole raid run: the mean of its raids, 15 less if the ship was put out of action; `points` rank runs (more raids survived
// and cleaner raids both raise it).
export function raidRun(raidLog, out = false) {
  const scored = raidLog.map(raidScore);
  const sum = scored.reduce((a, r) => a + r.score, 0);
  const mean = scored.length ? sum / scored.length : 0;
  const score = Math.round(clamp(mean - (out ? 15 : 0), 0, 100));
  return { mode: 'raid', score, grade: gradeOf(score), points: sum, raids: scored.length, scored, out };
}

// The plain mission: { kills, strikes, cellsUsed, rounds, out }. 100 points a kill, less 50 a hit taken, 5 a missile fired and 1 a
// hundred gun rounds, as a share of what the kills were worth.
export function classicRun({ kills = 0, strikes = 0, cellsUsed = 0, rounds = 0, out = false }) {
  const worth = kills * 100;
  const points = Math.max(0, worth - strikes * 50 - cellsUsed * 5 - Math.floor(rounds / 100));
  const score = kills ? Math.round(clamp((100 * points) / worth, 0, 100)) : 0;
  return { mode: 'classic', score, grade: gradeOf(score), points, kills, strikes, cellsUsed, rounds, out };
}

// --- best scores ---------------------------------------------------------------------------------------------------
function readAll(store) {
  try { return JSON.parse(store?.getItem(KEY) ?? '{}') || {}; } catch { return {}; } // blocked or damaged storage: no records
}
export function loadBest(mode, store = globalThis.localStorage) {
  const b = readAll(store)[mode];
  return b && Number.isFinite(b.points) ? b : null;
}
// Keeps the run if it beats the best of its mode. -> { best, isNew }
export function saveBest(run, store = globalThis.localStorage) {
  const old = loadBest(run.mode, store);
  if (old && old.points >= run.points) return { best: old, isNew: false };
  const best = { points: run.points, score: run.score, grade: run.grade, raids: run.raids ?? 0, kills: run.kills ?? 0, at: Date.now() };
  try {
    const all = readAll(store);
    all[run.mode] = best;
    store?.setItem(KEY, JSON.stringify(all));
  } catch { /* blocked storage: the run still shows */ }
  return { best, isNew: !!run.points };
}

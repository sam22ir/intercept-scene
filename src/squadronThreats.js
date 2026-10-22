// Squadron orders, hook 2: what comes at the squadron. Pure.
//   planThreats(sim, rng) -> [{ t, kind, ... }]   sorted by t. kind: 'raider' | 'drone' | 'merchant' | 'wave'.
//   spawnThreat(sim, w)   -> void   called when sim.t reaches w.t: adds the ship(s) with sim.newShip and pushes 'arrive' events.
//     Arrive kinds: 'enemy' (raiders and waves), 'drone', 'merchant'.
// `rng` is a stream of its own (the gunnery draws are never shifted); spawnThreat uses sim.rngW only, and never sim.makeAi
// (that draws from the gunnery stream), so the AI profile is built here.
//
// A drone is a DuelSim ship (team 1, kind 'drone') that this module moves itself: `ensureClock` wraps sim.step once per sim, so
// after every physics step the drone sits on its straight line for its age (a pure function of the sim time). It is passive
// (never fires) with few hull points, so the aft 30 mm and the 76 mm can shoot it down (DuelSim's own damage sinks it); within
// DRONE_DET metres of a living squadron ship it detonates on the nearest one, damaging the compartment at the impact point.
import { LEVELS, zoneAt, HALF_LENGTH } from './duel.js';

const rad = (d) => (d * Math.PI) / 180;
const level = (sim) => (LEVELS[sim.level] ? sim.level : 'normal');

export const RAIDER_RANGE = 4800; // m from the squadron's centroid where a raider appears
export const DRONE_RANGE = 4200; // m where a drone is launched
export const DRONE_SPEED = 80; // m/s
export const DRONE_HP = 4; // hull points: a 30 mm hit takes 0.45 of them (GUN_DAMAGE times the hull share), a 76 mm shell about 1.8
export const DRONE_DAMAGE = 9; // compartment points a detonation takes
// m from a squadron ship at which a drone detonates: just outside where two hulls touch end on (2 x HALF_LENGTH), so the hull never
// collides with a drone first
export const DRONE_DET = 2 * HALF_LENGTH + 25;
export const DRONE_LIFE = 150; // s after which a drone that found no target is gone
const WAVE_SPREAD = rad(9); // bearing between the raiders of one wave
const MERCHANT_LAG = 1500; // m astern of the squadron for a convoy ship that follows

// How many of each the plan brings, per scenario and level. Every count rises with the level, whatever the rng does.
const PLAN = {
  escort: {
    merchant: { easy: 2, normal: 2, hard: 3 },
    raider: { easy: 1, normal: 2, hard: 3 },
    drone: { easy: 1, normal: 2, hard: 3 },
    wave: { easy: 0, normal: 2, hard: 3 }, // raiders in the one wave
  },
  defend: {
    raider: { easy: 2, normal: 3, hard: 4 },
    drone: { easy: 1, normal: 3, hard: 4 },
    waves: { easy: 0, normal: 1, hard: 2 },
    wave: { easy: 0, normal: 2, hard: 3 }, // raiders in each wave
  },
};

export function planThreats(sim, rng) {
  ensureClock(sim);
  const L = level(sim);
  const list = [];
  const rel = (lo, span) => rad(lo + rng() * span);
  if (sim.scenario === 'escort') {
    const P = PLAN.escort;
    for (let i = 0; i < P.merchant[L]; i++) {
      list.push({ t: 10 + i * 40 + Math.floor(rng() * 8), kind: 'merchant', mode: i % 2 ? 'cross' : 'follow', brg: rel(-30, 60) });
    }
    for (let i = 0; i < P.raider[L]; i++) list.push({ t: 25 + i * 60 + Math.floor(rng() * 10), kind: 'raider', brg: rel(-60, 120) });
    for (let i = 0; i < P.drone[L]; i++) list.push({ t: 40 + i * 70 + Math.floor(rng() * 10), kind: 'drone', brg: Math.PI + rel(-35, 70) });
    if (P.wave[L]) list.push({ t: 150 + Math.floor(rng() * 10), kind: 'wave', n: P.wave[L], brg: rel(-60, 120) });
  } else {
    const P = PLAN.defend;
    // one threat every 55 s or so, in a fixed order: raiders, then drones, then the waves
    const seq = [];
    for (let i = 0; i < P.raider[L]; i++) seq.push({ kind: 'raider' });
    for (let i = 0; i < P.drone[L]; i++) seq.push({ kind: 'drone' });
    for (let i = 0; i < P.waves[L]; i++) seq.push({ kind: 'wave', n: P.wave[L] });
    seq.forEach((w, k) => list.push({ ...w, t: 20 + k * 55 + Math.floor(rng() * 10), brg: w.kind === 'drone' ? Math.PI + rel(-35, 70) : rel(-60, 120) }));
  }
  return list
    .map((w, i) => ({ ...w, i }))
    .sort((a, b) => a.t - b.t || a.i - b.i)
    .map(({ i, ...w }) => w);
}

export function spawnThreat(sim, w) {
  ensureClock(sim);
  const r = sim.rngW;
  if (w.kind === 'merchant') spawnMerchant(sim, w, r);
  else if (w.kind === 'drone') spawnDrone(sim, w, r);
  else if (w.kind === 'wave') {
    const n = w.n ?? 2;
    for (let i = 0; i < n; i++) spawnRaider(sim, (w.brg ?? 0) + (i - (n - 1) / 2) * WAVE_SPREAD, r);
  } else spawnRaider(sim, w.brg ?? 0, r); // 'raider' (and the old 'enemy')
}

// --- the kinds ------------------------------------------------------------------------------------------------------------
function spawnRaider(sim, brg0, r) {
  const c = sim.centroid();
  const brg = brg0 + (r() - 0.5) * 0.1;
  const x = c.x + Math.cos(brg) * RAIDER_RANGE, z = c.z + Math.sin(brg) * RAIDER_RANGE;
  const back = Math.atan2(c.z - z, c.x - x);
  const s = sim.newShip(x, z, back + (r() - 0.5) * 0.2, 1, 'frigate');
  const L = level(sim);
  s.ai = { level: L, p: LEVELS[L], next: 0, side: r() < 0.5 ? -1 : 1, jink: 0, nextJink: 5 + r() * 5 };
  s.passive = L === 'easy'; // on Easy the ones that arrive only show themselves: they do not fire
  sim.events.push({ type: 'arrive', ship: s.idx, kind: 'enemy', range: RAIDER_RANGE });
}

function spawnMerchant(sim, w, r) {
  const c = sim.centroid();
  let x, z, psi;
  if (w.mode === 'follow') {
    // astern of the squadron, on her course, so the convoy steams along behind
    const lead = sim.squad[0];
    const course = lead ? lead.psi : 0;
    const off = (r() - 0.5) * 400;
    x = c.x - Math.cos(course) * MERCHANT_LAG - Math.sin(course) * off;
    z = c.z - Math.sin(course) * MERCHANT_LAG + Math.cos(course) * off;
    psi = course;
  } else {
    // crossing: from the bearing at range, heading for a point near the squadron
    const brg = (w.brg ?? 0) + (r() - 0.5) * 0.1;
    x = c.x + Math.cos(brg) * RAIDER_RANGE;
    z = c.z + Math.sin(brg) * RAIDER_RANGE;
    const ax = c.x + (r() - 0.5) * 600, az = c.z + (r() - 0.5) * 600;
    psi = Math.atan2(az - z, ax - x);
  }
  const s = sim.newShip(x, z, psi, 2, 'merchant');
  sim.events.push({ type: 'arrive', ship: s.idx, kind: 'merchant', range: Math.hypot(x - c.x, z - c.z) });
}

function spawnDrone(sim, w, r) {
  const c = sim.centroid();
  const brg = (w.brg ?? 0) + (r() - 0.5) * 0.08;
  const x = c.x + Math.cos(brg) * DRONE_RANGE, z = c.z + Math.sin(brg) * DRONE_RANGE; // bearing PI is astern of the squadron (course +X)
  const ax = c.x + (r() - 0.5) * 300, az = c.z + (r() - 0.5) * 300;
  const psi = Math.atan2(az - z, ax - x);
  const s = sim.newShip(x, z, psi, 1, 'drone');
  s.ai = null;
  s.auto = false;
  s.passive = true; // a drone never fires; the squadron's guns are what shoot it
  s.hp = DRONE_HP;
  s.drone = { speed: DRONE_SPEED, age: 0, reported: false, px: x, pz: z };
  sim.events.push({ type: 'arrive', ship: s.idx, kind: 'drone', range: DRONE_RANGE });
  sim.events.push({ type: 'drone', ship: s.idx, phase: 'inbound', range: DRONE_RANGE });
}

// --- the drone's flight (runs after every physics step) -------------------------------------------------------------------
// Installed once per sim from planThreats (which runs at every reset, before any step), so every run, and every replay, wraps
// step the same way.
function ensureClock(sim) {
  if (sim._threatClock || typeof sim.step !== 'function') return;
  sim._threatClock = true;
  const step = sim.step;
  sim.step = function (dt, input) {
    for (const s of this.ships) if (s.drone) { s.drone.px = s.x; s.drone.pz = s.z; } // where each drone was before the step
    const out = step.call(this, dt, input);
    driveDrones(this, dt);
    return out;
  };
}

// Each drone flies at its speed straight at the nearest living squadron ship (it homes a little, so a ship that turns or steams
// off its line does not get away from it), and detonates within DRONE_DET of one.
function driveDrones(sim, dt) {
  for (const s of sim.ships) {
    const d = s.drone;
    if (!d) continue;
    if (s.tSunk !== null) {
      if (!d.reported) { d.reported = true; sim.events.push({ type: 'drone', ship: s.idx, phase: 'down' }); }
      continue;
    }
    d.age += dt;
    let best = null, bd = Infinity;
    for (const o of sim.squad) {
      if (o.tSunk !== null) continue;
      const dd = Math.hypot(o.x - s.x, o.z - s.z);
      if (dd < bd) { bd = dd; best = o; }
    }
    if (best) {
      // the hull's own step moved it along its old heading: put it back where it was and fly it on from there
      s.psi = Math.atan2(best.z - d.pz, best.x - d.px);
      s.u = d.speed;
      s.x = d.px + Math.cos(s.psi) * d.speed * dt;
      s.z = d.pz + Math.sin(s.psi) * d.speed * dt;
      bd = Math.hypot(best.x - s.x, best.z - s.z);
    }
    if (best && bd <= DRONE_DET) detonate(sim, s, best);
    else if (d.age > DRONE_LIFE) { s.tSunk = sim.t; d.reported = true; sim.events.push({ type: 'drone', ship: s.idx, phase: 'lost' }); }
  }
}

function detonate(sim, drone, tgt) {
  const dx = drone.x - tgt.x, dz = drone.z - tgt.z;
  const c = Math.cos(tgt.psi), sn = Math.sin(tgt.psi);
  const lx = dx * c + dz * sn, lz = -dx * sn + dz * c; // the impact point in the target's frame (x forward)
  const comp = zoneAt(Math.max(-HALF_LENGTH, Math.min(HALF_LENGTH, lx)));
  sim.damage(tgt, comp, DRONE_DAMAGE, 0.15, lz);
  tgt.stats.taken += 1;
  drone.tSunk = sim.t;
  drone.drone.reported = true;
  sim.events.push({ type: 'drone', ship: drone.idx, phase: 'hit', target: tgt.idx, comp, dmg: DRONE_DAMAGE });
}

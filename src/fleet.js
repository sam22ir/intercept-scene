// Fleet command: the pure real-time simulation behind the strategy mission (fleetMain.js draws it). You command a
// squadron of frigates from above: orders are "move there" and "attack that ship" (a queue, if you hold Shift), and
// every ship keeps firing at the nearest enemy in range by itself. Like Fly and the surface battle this is a live
// simulation, not a pure function of time: it cannot be rewound, only paused and sped up from outside (the caller
// decides how many steps to run). It imports only hull.js (how a frigate handles) and duel.js's cheap pure parts, so
// Node tests can run whole matches. Seeded: the same seed and the same orders give the same fight.
//
// Coordinates and headings are the scene's (see hull.js): x, z in metres, psi from +X toward +Z. Gunnery here is
// deliberately simpler than the surface battle: a shell takes its time of flight to arrive, and whether it hits is
// one seeded roll that gets worse with range and with the firing ship's own turn rate; there are no compartments.

import { stepHull, KT } from './hull.js';
import { DUEL_LEVELS } from './duel.js';

export { DUEL_LEVELS as FLEET_LEVELS };
export const DT = 1 / 60;
export const TURN_RADIUS = 90; // m at full rudder (the duel's heavier frigates use 120)
export const GUN_RANGE = 2200; // m
export const SHELL_SPEED = 650; // m/s
export const SHOT_COOL = 3; // s between rounds
export const SHOT_DAMAGE = 9; // hull points a hit takes
export const HULL_HP = 100;
export const ARRIVE_RADIUS = 110; // a move order is done when she is this close
export const KEEP_APART = 100; // m: hulls that close are pushed apart (they cannot sail through each other)
export const FORMATION_GAP = 260; // m between ships given one move order
export const CRUISE_KN = 16;
export const SPRINT_KN = 22;
export const SINK_AFTER = 42; // s a sinking ship stays in the water (matches duel.js's SINK_TIME)
export const WRECK_TURN = 0.06; // rad/s: the turn a ship has to be making before her aim suffers fully

const wrapPi = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Each level changes only the enemy's decisions and how well she shoots, never the physics.
export const LEVELS = {
  easy: { name: 'Easy', ships: 3, think: 5, hitMul: 0.85, focus: false, standoff: 1800 },
  normal: { name: 'Normal', ships: 3, think: 2.5, hitMul: 1.12, focus: false, standoff: 1500 },
  hard: { name: 'Hard', ships: 3, think: 1, hitMul: 1.1, focus: true, standoff: 1400 },
};

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const bearing = (from, x, z) => Math.atan2(z - from.z, x - from.x);
const dist = (a, b) => Math.hypot(b.x - a.x, b.z - a.z);

function makeShip(id, team, x, z, psi) {
  return {
    id, team, x, z, psi, u: 0, r: 0, rudder: 0, heel: 0,
    hp: HULL_HP, cool: 1 + (id % 3) * 0.7, orders: [], target: -1, // target: whom her gun is on now
    tSunk: -1, side: 1, kills: 0, shots: 0, hits: 0, orbit: 1, ai: team === 1 ? { next: 0 } : null,
  };
}

// Where a squadron given one move order stands when it arrives: a line abreast across the line of advance, in the
// order they already lie across it (so nobody has to cross another's wake). Returns [{ship, x, z}].
export function formationDests(ships, x, z) {
  if (ships.length === 1) return [{ ship: ships[0], x, z }];
  let cx = 0, cz = 0;
  for (const s of ships) { cx += s.x; cz += s.z; }
  cx /= ships.length; cz /= ships.length;
  const dir = Math.atan2(z - cz, x - cx);
  const px = -Math.sin(dir), pz = Math.cos(dir); // across the advance (to starboard of it)
  const sorted = [...ships].sort((a, b) => ((a.x - cx) * px + (a.z - cz) * pz) - ((b.x - cx) * px + (b.z - cz) * pz));
  return sorted.map((ship, i) => {
    const off = (i - (ships.length - 1) / 2) * FORMATION_GAP;
    return { ship, x: x + px * off, z: z + pz * off };
  });
}

export class FleetSim {
  constructor({ seed = 7, level = 'normal' } = {}) {
    this.seed = seed;
    this.level = LEVELS[level] ? level : 'normal';
    this.reset();
  }

  reset() {
    this.rand = rng(this.seed);
    this.t = 0;
    this.acc = 0;
    this.over = false;
    this.winner = -1;
    this.events = [];
    this.shells = [];
    this.ships = [];
    const lv = LEVELS[this.level];
    // The fleets face each other across the sea, yours to the west (z -2300) and hers to the east: on the top-down screen
    // (north up, east right) they are side by side, which is the way a wide window is wide.
    const row = (n, i) => (i - (n - 1) / 2) * 420;
    const mine = 3;
    for (let i = 0; i < mine; i++) this.ships.push(makeShip(this.ships.length, 0, row(mine, i), -2300, Math.PI / 2));
    for (let i = 0; i < lv.ships; i++) this.ships.push(makeShip(this.ships.length, 1, row(lv.ships, i), 2300, -Math.PI / 2));
  }

  takeEvents() { const e = this.events; this.events = []; return e; }
  alive(s) { return s.hp > 0; }
  team(n) { return this.ships.filter((s) => s.team === n && s.hp > 0); }

  // Give an order to a list of ship ids. cmd is { type: 'move', x, z } or { type: 'attack', target }. `queue` adds it
  // after the orders already given instead of replacing them. A move given to several ships keeps them in line abreast.
  order(ids, cmd, queue = false) {
    const ships = ids.map((i) => this.ships[i]).filter((s) => s && s.team === 0 && s.hp > 0);
    if (!ships.length) return false;
    if (cmd.type === 'attack') {
      const tg = this.ships[cmd.target];
      if (!tg || tg.team === 0 || tg.hp <= 0) return false;
      for (const s of ships) { if (!queue) s.orders.length = 0; s.orders.push({ type: 'attack', target: cmd.target }); }
    } else if (cmd.type === 'move') {
      for (const d of formationDests(ships, cmd.x, cmd.z)) {
        if (!queue) d.ship.orders.length = 0;
        d.ship.orders.push({ type: 'move', x: d.x, z: d.z });
      }
    } else if (cmd.type === 'stop') {
      for (const s of ships) s.orders.length = 0;
    } else return false;
    return true;
  }

  advance(dt) {
    this.acc += dt;
    let n = 0;
    while (this.acc >= DT && n < 600) { this.acc -= DT; this.step(DT); n++; }
  }

  step(dt) {
    if (!this.over) this.t += dt;
    for (const s of this.ships) if (s.hp > 0) { if (s.ai && !this.over) this.think(s); this.steer(s, dt); }
    this.separate();
    if (!this.over) for (const s of this.ships) if (s.hp > 0) this.gun(s, dt);
    this.stepShells();
    this.judge();
  }

  // --- helmsman: turns the present order into wheel and telegraph ---
  steer(s, dt) {
    // Drop orders that are finished.
    while (s.orders.length) {
      const o = s.orders[0];
      if (o.type === 'attack' && this.ships[o.target].hp <= 0) s.orders.shift();
      else if (o.type === 'move' && Math.hypot(o.x - s.x, o.z - s.z) < ARRIVE_RADIUS) s.orders.shift();
      else break;
    }
    const o = s.orders[0];
    let want = 0, kn = 0;
    if (o && o.type === 'move') {
      const d = Math.hypot(o.x - s.x, o.z - s.z);
      const err = wrapPi(Math.atan2(o.z - s.z, o.x - s.x) - s.psi);
      want = clamp(err * 2.5, -1, 1);
      kn = d < 300 ? 6 : CRUISE_KN;
      if (Math.abs(err) > 1.2 && d < 2 * TURN_RADIUS + 100) kn = 5; // close and pointing away: slow down to come round
    } else if (o && o.type === 'attack') {
      const tg = this.ships[o.target];
      const d = dist(s, tg);
      const stand = this.standoff(s);
      const b = bearing(s, tg.x, tg.z);
      let head = b;
      if (d <= stand + 600) {
        // Inside the standoff: turn broadside to her and circle at about that range, in the direction already taken.
        const rel = wrapPi(s.psi - b);
        if (Math.abs(rel) > 0.2) s.orbit = rel > 0 ? 1 : -1;
        head = b + s.orbit * (Math.PI / 2 + clamp((stand - d) / stand, -0.5, 0.5) * 0.9);
        kn = d > stand + 150 ? 14 : 10; // slow a little while coming round broadside
      } else kn = SPRINT_KN;
      want = clamp(wrapPi(head - s.psi) * 2.5, -1, 1);
    }
    // A wounded ship is slower; a sinking one drifts to a stop.
    const cap = s.hp < 35 ? 0.6 : 1;
    stepHull(s, dt, { want, orderKn: kn, speedCap: cap, radius: TURN_RADIUS });
  }

  standoff(s) { return s.team === 1 ? LEVELS[this.level].standoff : 1500; }

  // Ships cannot sail through each other: overlapping hulls are pushed apart.
  separate() {
    const L = this.ships;
    for (let i = 0; i < L.length; i++) {
      for (let j = i + 1; j < L.length; j++) {
        const a = L[i], b = L[j];
        if (a.hp <= 0 || b.hp <= 0) continue;
        const dx = b.x - a.x, dz = b.z - a.z, d = Math.hypot(dx, dz);
        if (d < KEEP_APART) {
          const k = d > 0.01 ? (KEEP_APART - d) / 2 / d : 0.5;
          const px = d > 0.01 ? dx * k : KEEP_APART / 4, pz = d > 0.01 ? dz * k : 0;
          a.x -= px; a.z -= pz; b.x += px; b.z += pz;
        }
      }
    }
  }

  // --- gunnery ---
  pickTarget(s) {
    const o = s.orders[0];
    if (o && o.type === 'attack') {
      const tg = this.ships[o.target];
      if (tg.hp > 0 && dist(s, tg) <= GUN_RANGE) return tg;
    }
    let best = null, bd = GUN_RANGE;
    for (const e of this.ships) {
      if (e.team === s.team || e.hp <= 0) continue;
      const d = dist(s, e);
      if (d < bd) { bd = d; best = e; }
    }
    return best;
  }

  gun(s, dt) {
    s.cool = Math.max(0, s.cool - dt);
    const tg = this.pickTarget(s);
    s.target = tg ? tg.id : -1;
    if (!tg || s.cool > 0) return;
    s.cool = SHOT_COOL;
    s.shots++;
    const d = dist(s, tg);
    const mul = s.team === 1 ? LEVELS[this.level].hitMul : 1;
    const p = clamp((0.78 - 0.5 * (d / GUN_RANGE) - 0.2 * Math.min(1, Math.abs(s.r) / WRECK_TURN) - (s.hp < 35 ? 0.1 : 0)) * mul, 0.08, 0.85);
    const hit = this.rand() < p;
    // The shell flies to where she will be: her course and speed carry her for the time of flight.
    const tof = d / SHELL_SPEED;
    const tx = tg.x + Math.cos(tg.psi) * tg.u * tof, tz = tg.z + Math.sin(tg.psi) * tg.u * tof;
    const miss = hit ? 0 : 40 + this.rand() * 90, ang = this.rand() * Math.PI * 2;
    const shell = { from: s.id, target: tg.id, x0: s.x, z0: s.z, x1: tx + Math.cos(ang) * miss, z1: tz + Math.sin(ang) * miss, t0: this.t, tof, hit };
    this.shells.push(shell);
    this.events.push({ type: 'fire', ship: s.id, target: tg.id, x: s.x, z: s.z, tof, hit });
  }

  stepShells() {
    for (let i = this.shells.length - 1; i >= 0; i--) {
      const sh = this.shells[i];
      if (this.t - sh.t0 < sh.tof) continue;
      this.shells.splice(i, 1);
      const tg = this.ships[sh.target];
      const by = this.ships[sh.from];
      if (sh.hit && tg.hp > 0) {
        tg.hp = Math.max(0, tg.hp - SHOT_DAMAGE);
        by.hits++;
        this.events.push({ type: 'hit', ship: tg.id, from: by.id, x: tg.x, z: tg.z, hp: tg.hp });
        if (tg.hp <= 0) {
          tg.tSunk = this.t;
          tg.side = by.z > tg.z ? 1 : -1;
          tg.orders.length = 0;
          by.kills++;
          this.events.push({ type: 'sunk', ship: tg.id, from: by.id, team: tg.team, x: tg.x, z: tg.z });
        }
      } else {
        this.events.push({ type: 'splash', x: sh.x1, z: sh.z1 });
      }
    }
  }

  // --- the enemy commander: picks targets, never plays by other rules ---
  think(s) {
    if (this.t < s.ai.next) return;
    const lv = LEVELS[this.level];
    s.ai.next = this.t + lv.think * (0.8 + 0.4 * this.rand());
    const o = s.orders[0];
    if (o && o.type === 'attack' && this.ships[o.target].hp > 0 && !lv.focus) return;
    const foes = this.team(0);
    if (!foes.length) return;
    let pick;
    if (lv.focus) pick = foes.reduce((a, b) => (a.hp - dist(s, a) / 100 <= b.hp - dist(s, b) / 100 ? a : b)); // wounded and close
    else pick = foes.reduce((a, b) => (dist(s, a) <= dist(s, b) ? a : b));
    if (!(o && o.type === 'attack' && o.target === pick.id)) { s.orders.length = 0; s.orders.push({ type: 'attack', target: pick.id }); }
  }

  judge() {
    if (this.over) return;
    const mine = this.team(0).length, theirs = this.team(1).length;
    if (!mine || !theirs) {
      this.over = true;
      this.winner = mine ? 0 : 1;
      this.events.push({ type: 'over', winner: this.winner });
    }
  }
}

export const knToMs = (kn) => kn * KT;

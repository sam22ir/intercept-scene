// "Ship duel": you sail a frigate against an enemy frigate that sails herself; each has a 76 mm gun on the
// bow and two 30 mm rotary guns aft, and they fight until one sinks. Like Solo Air Defense (helm.js) it is not
// a pure function of a clock: keys drive a small real-time simulation, stepped at a fixed rate so it behaves the
// same at any frame rate, seeded, and tested in Node. It imports only hull.js (how the ships handle), so
// duel.test.mjs loads it without the scene.
//
// The core mechanic is manoeuvring. Both ships' guns track the enemy by themselves, and the fire control
// predicts the target going on in a straight line at its present speed for the shell's time of flight (the
// shell carries the firing ship's own speed too). A target that turns or changes speed is therefore missed, and
// the shells scatter more the longer the range and the harder the firing ship is turning: the winner is the one
// who shoots straight while keeping the other from doing the same. The difficulty changes only the enemy's
// decisions (how often it thinks, how well it keeps its bow on you, how it jinks) and its aim, never the physics.
//
// The weapons (the same for both ships)
//   76 mm   one on the bow. It trains on the enemy inside MAIN_ARC either side of the bow (the superstructure
//           hides the sector astern) and MAIN_RANGE, and fires, once it is on the solution and loaded, while the
//           trigger (F, or the enemy's own decision) is down. Shells fly as ballistic arcs and are tested against
//           the enemy's hull as a segment each step, in the target's own frame.
//   30 mm   the two rotary guns aft (the same dead zones as Solo Air Defense) train onto the enemy inside
//           GUN_RANGE and fire in bursts while G is held, or all the time in AUTO. Each burst that hits does a
//           little damage, with a chance that falls with range.
//
// The damage: a hit lands in the compartment under it (by the shell's position along the hull), and costs
// that compartment's points and some of the hull's. A hull at zero sinks; a compartment at zero is out for good
// and floods her a little more each second.
//   gun       the 76 mm: slower to load as it is hurt, out at zero.
//   bridge    the fire control: the scatter grows as she is hurt.
//   engine    the speed she can make falls to about a third, then to dead slow at zero.
//   steering  the rudder is limited to a quarter of its throw at zero.
//   guns      the aft guns: the second goes at half, both at zero.
//
// Coordinates are the scene's (see hull.js): metres, +Y up, the sea is y = 0. +X is north and +Z east.
import { TELEGRAPH, START_ORDER, RUDDER_MAX, KT, HALF_LENGTH, HALF_BEAM, GUN_MOUNT_LOCAL, GUN_DEAD, gunBlind, stepHull } from './hull.js';

export { TELEGRAPH, START_ORDER, KT, HALF_LENGTH, HALF_BEAM, GUN_MOUNT_LOCAL, gunBlind };

const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const wrapPi = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (t) => { const x = clamp(t, 0, 1); return x * x * (3 - 2 * x); };

export const DT = 1 / 120;
export const TURN_RADIUS = 120; // m at full rudder: heavier than the nimble helm of Solo Air Defense (70 m)
export const G = 9.80665;

// --- The 76 mm gun ------------------------------------------------------------------------------------------
export const MAIN_MOUNT = [32, 6.5, 0]; // the pivot, in the ship's frame
export const MAIN_ARC = rad(135); // either side of the bow; the sector astern is hidden by the superstructure
export const MAIN_RANGE = 8000; // m
export const MUZZLE_V = 650; // m/s (slow enough that a long shot takes seconds, and a turn spoils it)
export const MAIN_RELOAD = 2.5; // s between rounds
export const MAIN_ROUNDS = 150;
const MAIN_YAW_RATE = rad(45);
const MAIN_PITCH_RATE = rad(30);
const MAIN_PITCH = [rad(-5), rad(45)];
export const AIM_OK = rad(1.2); // the gun fires once it is this close to the solution
const BARREL = 8; // m from the pivot to the muzzle
const SHELL_LIFE = 30; // s

// Scatter (one standard deviation, in radians): a steady floor, more while the firing ship turns, more as the
// bridge (the fire control) is hurt, and the enemy's own aim factor on top.
const SCATTER_BASE = 0.002;
const SCATTER_TURN = 0.02; // per rad/s of the firing ship's turn

// --- The 30 mm guns (the aft pair, as in helm.js) ----------------------------------------------------------------
export const GUN_RANGE = 2600; // m
export const GUN_ROUNDS = 2500;
const GUN_RATE = 83; // rounds a second
const GUN_BURST = 30; // rounds per chance to hit
const GUN_YAW_RATE = rad(150);
const GUN_PITCH_RATE = rad(90);
const GUN_AIM_OK = rad(3);
const GUN_MUZZLE_V = 1050;
export const GUN_SPIN = 70;
export const GUN_STOW = { yaw: Math.PI, pitch: rad(8) };

// --- The ships and the damage ------------------------------------------------------------------------------------
export const HULL_HP = 100;
export const COMPARTMENTS = {
  gun: { name: '76 mm gun', hp: 30 },
  bridge: { name: 'Bridge', hp: 30 },
  engine: { name: 'Engine room', hp: 40 },
  guns: { name: 'Aft guns', hp: 30 },
  steering: { name: 'Steering', hp: 30 },
};
export const COMP_IDS = Object.keys(COMPARTMENTS);
// The compartment under a hit, by its place along the hull (ship frame, +X forward).
export function zoneAt(x) {
  if (x > 22) return 'gun';
  if (x > 6) return 'bridge';
  if (x > -24) return 'engine';
  if (x > -42) return 'guns';
  return 'steering';
}
const SHELL_DAMAGE = [10, 14]; // to the compartment
const SHELL_HULL = 0.5; // the part of that which costs the hull
const GUN_DAMAGE = 0.9; // a 30 mm burst that hits
const FLOOD_RATE = 0.12; // hull points a second for each compartment that is out
const BOX = { x: HALF_LENGTH, y0: 0, y1: 18, z: HALF_BEAM }; // the hull and superstructure as a box (the sea is y = 0)

export const DUEL_LEVELS = ['easy', 'normal', 'hard'];
// The fire control does not know the target's velocity, it tracks it: the estimate follows the true one with a lag (`track`, s;
// 3 s for the player's own, the enemy's by its level), so a change of course or speed spoils the solution for a few seconds.
const TRACK_PLAYER = 3;
// How the enemy decides. `think` is how often (s); `aim` multiplies its scatter; `base` is the angle off its bow it keeps you
// at (a broadside shows the bigger target but the aft guns need one); `jink` the size of its random alterations of course, every
// `every` seconds; `range` the distance it wants to fight at; `speed` its telegraph order; `retreat` the hull fraction below
// which it runs.
export const LEVELS = {
  easy: { name: 'Easy', think: 1.4, aim: 2.4, track: 6, base: 0, jink: 0, every: [99, 99], range: 5200, speed: 4, retreat: 0 },
  normal: { name: 'Normal', think: 0.6, aim: 1.5, track: 4, base: rad(22), jink: rad(18), every: [9, 16], range: 4600, speed: 5, retreat: 0.25 },
  hard: { name: 'Hard', think: 0.25, aim: 1.0, track: 2.5, base: rad(40), jink: rad(40), every: [5, 10], range: 4000, speed: 5, retreat: 0.3 },
};

function mulberry32(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A ship that sinks: a closed-form picture of the time since her hull points ran out, for the scene.
export const SINK_TIME = 42; // s until she is gone
export function sinkState(age, side = 1) {
  const a = Math.max(0, age);
  return {
    roll: side * rad(75) * smooth(a / 30), // rolls over to the side she was hit on
    trim: -rad(14) * smooth(a / 26), // bow down
    depth: -26 * Math.pow(smooth((a - 3) / 36), 1.4), // metres below her own waterline
    smoke: smooth(a / 6) * (1 - smooth((a - 30) / 12)), // 0..1
    gone: a >= SINK_TIME,
  };
}

function makeShip(idx, x, z, psi) {
  const comp = {};
  for (const id of COMP_IDS) comp[id] = COMPARTMENTS[id].hp;
  return {
    idx, x, z, psi, u: 0, r: 0, rudder: 0, heel: 0, order: START_ORDER,
    hp: HULL_HP, comp, flood: 0, tSunk: null, listSide: 1,
    // The 76 mm: yaw (+ toward port), pitch, the time until it is loaded, the rounds, and whether it is on the solution.
    gun: { yaw: 0, pitch: rad(2), cool: 1.5, ammo: MAIN_ROUNDS, onTarget: false, engaged: false },
    gats: [0, 1].map(() => ({ yaw: GUN_STOW.yaw, pitch: GUN_STOW.pitch, ammo: GUN_ROUNDS, firing: false, rounds: 0, spin: 0, spinRate: 0, burst: 0, cool: 0 })),
    auto: true, // the aft guns fire by themselves
    est: null, // the velocity this ship's fire control believes the other ship has, [x, z]
    cmd: { want: 0, fire: false, gat: false },
    ai: null,
    stats: { shells: 0, hits: 0, bursts: 0, burstHits: 0, taken: 0 },
  };
}

export class DuelSim {
  // `level` is the enemy's; `auto` ('easy' | 'normal' | 'hard') hands the player's ship to the same kind of helmsman (tests).
  constructor({ seed = 11, level = 'normal', auto = null } = {}) {
    this.seed = seed;
    this.level = LEVELS[level] ? level : 'normal';
    this.auto = auto && LEVELS[auto] ? auto : null;
    this.reset();
  }

  reset() {
    this.rng = mulberry32(this.seed);
    const side = this.rng() < 0.5 ? -1 : 1;
    this.t = 0;
    this.acc = 0;
    this.ships = [
      makeShip(0, 0, 0, 0),
      makeShip(1, 5500, side * (300 + this.rng() * 500), Math.PI + side * rad(-6)),
    ];
    for (const s of this.ships) { s.u = TELEGRAPH[START_ORDER].kn * KT; }
    for (const s of this.ships) { const v = this.velOf(this.ships[1 - s.idx]); s.est = [v[0], v[2]]; }
    this.ships[1].ai = this.makeAi(this.level);
    if (this.auto) this.ships[0].ai = this.makeAi(this.auto);
    this.shells = [];
    this.shellId = 0;
    this.events = [];
    this.winner = null; // 0 you, 1 the enemy
  }

  makeAi(level) {
    return { level, p: LEVELS[level], next: 0, side: this.rng() < 0.5 ? -1 : 1, jink: 0, nextJink: 5 + this.rng() * 5 };
  }

  // --- the outside world ---------------------------------------------------------------------------------------------
  advance(dt, input = {}) {
    this.acc += dt;
    let n = 0;
    while (this.acc >= DT && n < 600) { this.step(DT, input); this.acc -= DT; n++; }
    if (this.acc > DT) this.acc = 0;
  }
  takeEvents() { const e = this.events; this.events = []; return e; }
  telegraph(i, d) { const s = this.ships[i]; if (s.tSunk === null) s.order = clamp(s.order + d, 0, TELEGRAPH.length - 1); }
  toggleAuto(i = 0) { this.ships[i].auto = !this.ships[i].auto; }
  get player() { return this.ships[0]; }
  get enemy() { return this.ships[1]; }
  knots(s) { return s.u / KT; }
  headingDeg(s) { return ((deg(s.psi) % 360) + 360) % 360; }
  range() { return Math.hypot(this.ships[1].x - this.ships[0].x, this.ships[1].z - this.ships[0].z); }
  // Bearing of the other ship from this one's bow: + to starboard.
  relBearing(s) { const o = this.ships[1 - s.idx]; return wrapPi(Math.atan2(o.z - s.z, o.x - s.x) - s.psi); }

  // --- frames ------------------------------------------------------------------------------------------------------
  toWorld(s, p, out = [0, 0, 0]) {
    const c = Math.cos(s.psi), sn = Math.sin(s.psi);
    out[0] = s.x + p[0] * c - p[2] * sn;
    out[1] = p[1];
    out[2] = s.z + p[0] * sn + p[2] * c;
    return out;
  }
  // A world point in the ship's frame, with her heel taken out (the sea is y = 0 at her waterline).
  toLocal(s, w, out = [0, 0, 0]) {
    const dx = w[0] - s.x, dz = w[2] - s.z;
    const lx = dx * Math.cos(s.psi) + dz * Math.sin(s.psi);
    const lz = -dx * Math.sin(s.psi) + dz * Math.cos(s.psi);
    const ch = Math.cos(s.heel), sh = Math.sin(s.heel);
    out[0] = lx;
    out[1] = w[1] * ch - lz * sh;
    out[2] = lz * ch + w[1] * sh;
    return out;
  }
  // A direction in the ship's frame (yaw + toward port, pitch up) as a world vector.
  dirOf(s, yaw, pitch, out = [0, 0, 0]) {
    const cp = Math.cos(pitch);
    const lx = cp * Math.cos(yaw), lz = -cp * Math.sin(yaw);
    const c = Math.cos(s.psi), sn = Math.sin(s.psi);
    out[0] = lx * c - lz * sn;
    out[1] = Math.sin(pitch);
    out[2] = lx * sn + lz * c;
    return out;
  }
  velOf(s) { return [Math.cos(s.psi) * s.u, 0, Math.sin(s.psi) * s.u]; }

  // --- the step ------------------------------------------------------------------------------------------------------
  step(dt, input) {
    this.t += dt;
    const [me, foe] = this.ships;
    me.cmd = me.ai ? me.cmd : { want: (input.right ? 1 : 0) - (input.left ? 1 : 0), fire: !!input.fire, gat: !!input.gat };
    for (const s of this.ships) {
      if (s.ai && this.t >= s.ai.next) this.think(s);
      this.stepShip(s, dt);
    }
    for (const s of this.ships) {
      const v = this.velOf(this.ships[1 - s.idx]), k = Math.min(1, dt / (s.ai ? s.ai.p.track : TRACK_PLAYER));
      s.est[0] += (v[0] - s.est[0]) * k;
      s.est[1] += (v[2] - s.est[1]) * k;
    }
    for (const s of this.ships) { this.stepMain(s, dt); this.stepGats(s, dt); }
    for (const sh of [...this.shells]) this.stepShell(sh, dt);
    for (const s of this.ships) this.stepDamage(s, dt);
    if (this.winner === null && (me.tSunk !== null || foe.tSunk !== null)) {
      this.winner = me.tSunk !== null && foe.tSunk !== null ? (me.tSunk <= foe.tSunk ? 1 : 0) : me.tSunk !== null ? 1 : 0;
      this.events.push({ type: 'over', winner: this.winner });
    }
  }

  stepShip(s, dt) {
    const sunk = s.tSunk !== null;
    const engine = s.comp.engine / COMPARTMENTS.engine.hp;
    stepHull(s, dt, {
      want: sunk ? 0 : s.cmd.want,
      orderKn: sunk ? 0 : TELEGRAPH[s.order].kn,
      radius: TURN_RADIUS,
      rudderLimit: RUDDER_MAX * (0.25 + 0.75 * s.comp.steering / COMPARTMENTS.steering.hp),
      speedCap: s.comp.engine <= 0 ? 5 / TELEGRAPH[s.order].kn : 0.35 + 0.65 * engine,
    });
  }

  // The scatter of a ship's 76 mm (radians, one standard deviation).
  scatter(s) {
    const hurt = 1 - s.comp.bridge / COMPARTMENTS.bridge.hp;
    return (SCATTER_BASE + SCATTER_TURN * Math.abs(s.r)) * (1 + 1.5 * hurt) * (s.ai ? s.ai.p.aim : 1);
  }

  // The 76 mm's solution on the other ship: yaw, pitch and the time of flight, with the target assumed to go on
  // in a straight line at its present velocity, and the shell carrying the firing ship's own velocity.
  solve(s, mount, muzzleV, drop, out = {}) {
    const o = this.ships[1 - s.idx];
    const M = this.toWorld(s, mount);
    const tp = this.toWorld(o, [0, 6, 0]);
    const tv = [s.est[0], 0, s.est[1]], sv = this.velOf(s);
    let T = Math.hypot(tp[0] - M[0], tp[2] - M[2]) / muzzleV;
    let d = [0, 0, 0];
    for (let i = 0; i < 6; i++) {
      d = [tp[0] + tv[0] * T - M[0] - sv[0] * T, tp[1] - M[1] + (drop ? 0.5 * G * T * T : 0), tp[2] + tv[2] * T - M[2] - sv[2] * T];
      T = Math.hypot(d[0], d[1], d[2]) / muzzleV;
    }
    const c = Math.cos(s.psi), sn = Math.sin(s.psi);
    const lx = d[0] * c + d[2] * sn, lz = -d[0] * sn + d[2] * c;
    out.yaw = Math.atan2(-lz, lx);
    out.pitch = Math.atan2(d[1], Math.hypot(lx, lz));
    out.T = T;
    out.range = Math.hypot(tp[0] - M[0], tp[2] - M[2]);
    return out;
  }

  stepMain(s, dt) {
    const g = s.gun;
    const sunk = s.tSunk !== null;
    const slow = 1 + (1 - s.comp.gun / COMPARTMENTS.gun.hp); // a hurt gun loads slower
    g.cool = Math.max(0, g.cool - dt / slow);
    let wantYaw = 0, wantPitch = rad(2);
    g.engaged = false;
    g.onTarget = false;
    const alive = !sunk && s.comp.gun > 0 && g.ammo > 0 && this.ships[1 - s.idx].tSunk === null;
    if (alive) {
      const sol = this.solve(s, MAIN_MOUNT, MUZZLE_V, true);
      if (Math.abs(sol.yaw) <= MAIN_ARC && sol.range <= MAIN_RANGE) {
        wantYaw = sol.yaw;
        wantPitch = clamp(sol.pitch, MAIN_PITCH[0], MAIN_PITCH[1]);
        g.engaged = true;
      } else wantYaw = clamp(sol.yaw, -MAIN_ARC, MAIN_ARC);
    }
    g.yaw = wrapPi(g.yaw + clamp(wrapPi(wantYaw - g.yaw), -MAIN_YAW_RATE * dt, MAIN_YAW_RATE * dt));
    g.pitch += clamp(wantPitch - g.pitch, -MAIN_PITCH_RATE * dt, MAIN_PITCH_RATE * dt);
    if (!g.engaged) return;
    g.onTarget = Math.abs(wrapPi(wantYaw - g.yaw)) < AIM_OK && Math.abs(wantPitch - g.pitch) < AIM_OK;
    if (!g.onTarget || !s.cmd.fire || g.cool > 0) return;
    this.fireMain(s);
  }

  fireMain(s) {
    const g = s.gun;
    g.cool = MAIN_RELOAD;
    g.ammo -= 1;
    s.stats.shells += 1;
    const sigma = this.scatter(s);
    const gauss = () => Math.sqrt(-2 * Math.log(1 - this.rng())) * Math.cos(2 * Math.PI * this.rng());
    const yaw = g.yaw + gauss() * sigma, pitch = g.pitch + gauss() * sigma;
    const dir = this.dirOf(s, yaw, pitch);
    const M = this.toWorld(s, MAIN_MOUNT);
    const sv = this.velOf(s);
    const sh = {
      id: ++this.shellId, owner: s.idx, t0: this.t,
      p: [M[0] + dir[0] * BARREL, M[1] + dir[1] * BARREL, M[2] + dir[2] * BARREL],
      v: [dir[0] * MUZZLE_V + sv[0], dir[1] * MUZZLE_V, dir[2] * MUZZLE_V + sv[2]],
    };
    this.shells.push(sh);
    this.events.push({ type: 'shot', owner: s.idx, pos: sh.p.slice(), dir });
  }

  // A shell flies one step: tested as a segment against the target's hull in the target's frame (a point test would let
  // it through the 15 m beam at this speed), then against the sea.
  stepShell(sh, dt) {
    const p0 = sh.p.slice();
    sh.v[1] -= G * dt;
    for (let k = 0; k < 3; k++) sh.p[k] += sh.v[k] * dt;
    const tgt = this.ships[1 - sh.owner];
    if (tgt.tSunk === null || this.t - tgt.tSunk < 6) {
      const a = this.toLocal(tgt, p0), b = this.toLocal(tgt, sh.p);
      const hit = segmentBox(a, b);
      if (hit) { this.hit(sh, tgt, hit); return; }
    }
    if (sh.p[1] <= 0) {
      const f = p0[1] / (p0[1] - sh.p[1] || 1);
      const pos = [lerp(p0[0], sh.p[0], f), 0, lerp(p0[2], sh.p[2], f)];
      this.events.push({ type: 'splash', owner: sh.owner, pos, miss: Math.hypot(pos[0] - tgt.x, pos[2] - tgt.z) });
      this.shells.splice(this.shells.indexOf(sh), 1);
    } else if (this.t - sh.t0 > SHELL_LIFE) this.shells.splice(this.shells.indexOf(sh), 1);
  }

  hit(sh, tgt, local) {
    const from = this.ships[sh.owner];
    const comp = zoneAt(local[0]);
    const dmg = lerp(SHELL_DAMAGE[0], SHELL_DAMAGE[1], this.rng());
    from.stats.hits += 1;
    tgt.stats.taken += 1;
    const pos = this.toWorld(tgt, [local[0], clamp(local[1], 0, BOX.y1), local[2]]);
    this.damage(tgt, comp, dmg, SHELL_HULL, local[2]);
    this.events.push({ type: 'hit', owner: sh.owner, ship: tgt.idx, comp, dmg, pos, local: local.slice(), out: tgt.comp[comp] <= 0 });
    this.shells.splice(this.shells.indexOf(sh), 1);
  }

  damage(s, comp, dmg, hullShare, side = 0) {
    if (s.tSunk !== null) return;
    const before = s.comp[comp];
    s.comp[comp] = Math.max(0, before - dmg);
    if (side) s.listSide = Math.sign(side);
    s.hp = Math.max(0, s.hp - dmg * hullShare);
    if (before > 0 && s.comp[comp] <= 0) this.events.push({ type: 'out', ship: s.idx, comp });
  }

  stepDamage(s, dt) {
    if (s.tSunk !== null) return;
    s.flood = COMP_IDS.reduce((n, id) => n + (s.comp[id] <= 0 ? FLOOD_RATE : 0), 0);
    s.hp = Math.max(0, s.hp - s.flood * dt);
    if (s.hp <= 0) {
      s.tSunk = this.t;
      s.cmd = { want: 0, fire: false, gat: false };
      this.events.push({ type: 'sunk', ship: s.idx, pos: this.toWorld(s, [0, 4, 0]) });
    }
  }

  // --- the aft guns -----------------------------------------------------------------------------------------------------
  stepGats(s, dt) {
    const o = this.ships[1 - s.idx];
    const sunk = s.tSunk !== null || o.tSunk !== null;
    const trigger = !sunk && (s.auto || s.cmd.gat);
    const gunsHp = s.comp.guns / COMPARTMENTS.guns.hp;
    for (let i = 0; i < s.gats.length; i++) {
      const g = s.gats[i];
      const working = i === 0 ? gunsHp > 0 : gunsHp > 0.5;
      let wantYaw = GUN_STOW.yaw, wantPitch = GUN_STOW.pitch, engage = false;
      if (!sunk && working && g.ammo > 0) {
        const sol = this.solve(s, GUN_MOUNT_LOCAL[i], GUN_MUZZLE_V, false);
        if (sol.range <= GUN_RANGE && !gunBlind(i, sol.yaw)) {
          wantYaw = sol.yaw;
          wantPitch = clamp(sol.pitch, rad(-5), rad(85));
          engage = true;
        }
      }
      g.yaw = wrapPi(g.yaw + clamp(wrapPi(wantYaw - g.yaw), -GUN_YAW_RATE * dt, GUN_YAW_RATE * dt));
      g.pitch += clamp(wantPitch - g.pitch, -GUN_PITCH_RATE * dt, GUN_PITCH_RATE * dt);
      const on = engage && Math.abs(wrapPi(wantYaw - g.yaw)) < GUN_AIM_OK && Math.abs(wantPitch - g.pitch) < GUN_AIM_OK;
      g.spinRate += (((engage && trigger ? GUN_SPIN : 0) - g.spinRate) / 0.5) * dt;
      g.spin += g.spinRate * dt;
      g.cool = Math.max(0, g.cool - dt);
      if (!on || !trigger) g.burst = 0;
      else if (g.burst <= 0 && g.cool <= 0 && g.spinRate > 0.78 * GUN_SPIN) g.burst = 70 + this.rng() * 40;
      g.firing = on && trigger && g.burst > 0;
      if (!g.firing) continue;
      const n = Math.min(GUN_RATE * dt, g.burst);
      g.burst -= n;
      if (g.burst <= 0) { g.burst = 0; g.cool = 0.5 + this.rng() * 0.4; }
      g.ammo = Math.max(0, g.ammo - n);
      g.rounds += n;
      while (g.rounds >= GUN_BURST) {
        g.rounds -= GUN_BURST;
        s.stats.bursts += 1;
        const range = Math.hypot(o.x - s.x, o.z - s.z);
        if (this.rng() < clamp(1.1 - range / 2200, 0.05, 0.9)) {
          const x = (this.rng() * 2 - 1) * HALF_LENGTH;
          const comp = zoneAt(x);
          s.stats.burstHits += 1;
          o.stats.taken += 1;
          this.damage(o, comp, GUN_DAMAGE, 0.5, this.rng() - 0.5);
          this.events.push({ type: 'gunhit', owner: s.idx, ship: o.idx, comp, pos: this.toWorld(o, [x, 6, (this.rng() * 2 - 1) * HALF_BEAM]) });
        }
      }
    }
  }

  // --- the enemy's helmsman ----------------------------------------------------------------------------------------------
  // Every `think` seconds: where to point, how fast to go. The rudder follows by the same keys a player has.
  think(s) {
    const ai = s.ai, p = ai.p;
    ai.next = this.t + p.think;
    if (s.tSunk !== null) return;
    const o = this.ships[1 - s.idx];
    const range = Math.hypot(o.x - s.x, o.z - s.z);
    const rel = this.relBearing(s);
    if (this.t >= ai.nextJink) {
      ai.jink = (this.rng() * 2 - 1) * p.jink;
      ai.nextJink = this.t + lerp(p.every[0], p.every[1], this.rng());
    }
    let wantRel = ai.side * p.base + ai.jink;
    let order = p.speed;
    const hurt = s.hp / HULL_HP < p.retreat;
    if (hurt) { wantRel = ai.side * rad(150); order = TELEGRAPH.length - 1; } // turn away, flank
    else if (range < p.range * 0.7) wantRel = ai.side * rad(110) + ai.jink; // too close: open the range
    else if (range > p.range * 1.15) { wantRel = ai.side * p.base * 0.3 + ai.jink * 0.5; order = Math.min(order + 1, TELEGRAPH.length - 1); }
    const err = wrapPi(rel - wantRel);
    s.cmd.want = Math.abs(err) < rad(3) ? 0 : Math.sign(err);
    if (s.order < order) s.order += 1; else if (s.order > order) s.order -= 1;
    s.cmd.fire = true; // it fires whenever the gun is on (the gun decides)
    s.cmd.gat = true;
  }
}

// A segment (in a hull's frame) against the hull box: the first point inside, or null.
function segmentBox(a, b) {
  let t0 = 0, t1 = 1;
  const lo = [-BOX.x, BOX.y0, -BOX.z], hi = [BOX.x, BOX.y1, BOX.z];
  for (let k = 0; k < 3; k++) {
    const d = b[k] - a[k];
    if (Math.abs(d) < 1e-9) { if (a[k] < lo[k] || a[k] > hi[k]) return null; continue; }
    let ta = (lo[k] - a[k]) / d, tb = (hi[k] - a[k]) / d;
    if (ta > tb) [ta, tb] = [tb, ta];
    t0 = Math.max(t0, ta);
    t1 = Math.min(t1, tb);
    if (t0 > t1) return null;
  }
  return [lerp(a[0], b[0], t0), lerp(a[1], b[1], t0), lerp(a[2], b[2], t0)];
}
export { segmentBox };

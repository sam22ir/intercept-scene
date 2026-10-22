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
// More ships (opt in with `waves: true`, which the scene does and the tests do not): a ship has a team (0 yours, 1 the enemy's, 2
// neutral) and a target, the nearest living ship of the other side (Tab locks one). Enemy frigates arrive over the sea in waves, a friendly
// one comes to help, and merchant ships cross the fight: they cannot shoot, a shell from any side can hit them, and sinking one yourself
// loses the duel. Hulls that touch collide (damage by the closing speed where they meet).
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
// Two kinds of round, with limited stocks of each (the total stays MAIN_ROUNDS). HE hurts a compartment less but sets it on fire
// and opens the hull to the sea; AP hurts it more and does neither. Changing the loaded kind costs a reload.
export const AMMO_STOCK = { he: 90, ap: 60 };
export const AMMO_TYPES = {
  he: { name: 'HE', dmg: 0.6, fire: 0.45, flood: 0.04 },
  ap: { name: 'AP', dmg: 1.5, fire: 0, flood: 0 },
};
export const SWITCH_TIME = 3.5; // s of reload to change the loaded kind
const AMMO_DWELL = 12; // s the enemy keeps a kind loaded before it may change
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
// Manual aim (T): the player points the gun and the fire control no longer solves it. The gun's own base scatter is smaller than the auto
// tracker's (a lagging velocity estimate is the auto's real error, the player has to lead by eye and by the splashes), and turning still spoils it.
export const MANUAL_SCATTER = 0.6;
// A shell by hand (the radar view) is one of three kinds, by `aim`: LOCKED on a compartment (`aim.lock`: it lands there, with next to no
// scatter, and takes LOCK_FRACTION of that compartment's points), FOCUSED (`aim.focus`, the sight snapped to a compartment but not locked: it lands
// there, with more scatter, and takes FOCUS_FRACTION), or FREE (`aim.free`, neither: the shell falls in the sea). An aim without any of them is
// the plain manual shot (the tests'): it lands where it strikes.
export const LOCK_SCATTER = 0.1;
export const FOCUS_SCATTER = 1.5;
export const LOCK_FRACTION = 0.25;
export const FOCUS_FRACTION = 0.14;
export const EASY_HIT_FRACTION = 0.02; // on Easy a hit by an enemy costs your ship this part of the compartment's points

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
// A shell mostly wrecks the compartment it lands in; the hull pays a smaller share (the flooding and the fires do the
// long, slow work), which is what keeps a duel at two to five minutes instead of a couple of minutes of hit points.
const SHELL_HULL = 0.15; // the part of that which costs the hull
const GUN_DAMAGE = 0.9; // a 30 mm burst that hits
const FLOOD_RATE = 0.08; // hull points a second for each compartment that is out
const BOX = { x: HALF_LENGTH, y0: 0, y1: 18, z: HALF_BEAM }; // the hull and superstructure as a box (the sea is y = 0)

// --- Traffic and collisions ---------------------------------------------------------------------------------------------
export const MERCHANT_HP = 70;
const MERCHANT_KN = 12;
const COLLIDE_SEG = HALF_LENGTH - HALF_BEAM; // a hull is a capsule round its centre line: the segment ends ...
const COLLIDE_GAP = 2 * HALF_BEAM; // ... and the distance between two centre lines at which hulls touch
const COLLIDE_DAMAGE = 2.2; // compartment points for each m/s of closing speed
const COLLIDE_AGAIN = 4; // s before the same pair can collide again
const PICK_EVERY = 0.5; // s between a ship's looks for a nearer target
// When the others come (s, by the enemy's level) and from where: enemy frigates from her side of the horizon, the friendly one from behind you,
// merchants across the line of fire.
const ENEMY_WAVES = { easy: [110], normal: [80, 175], hard: [70, 140, 215] };
const ALLY_WAVE = 95;
const MERCHANT_WAVES = [30, 125, 210];
const ARRIVE_RANGE = 7500; // m from you where a warship appears

// --- Damage control -------------------------------------------------------------------------------------------------
// Fires (started by HE) burn the compartment they are in, grow, and spread to the next one along the hull; HE also
// opens a leak. A repair crew, sent to one compartment (one crew each, CREW_MOVE s to get there), puts its fire out, slows its flooding and
// slowly restores it, even from out, but never above REPAIR_CAP of its points.
export const CREWS = 3;
export const CREW_MOVE = 6; // s to reach a compartment
export const FIRE_GROW = 0.04; // intensity (0..1) a second
export const FIRE_BURN = 0.6; // compartment points a second at full intensity
export const FIRE_HULL = 0.03; // hull points a second at full intensity
export const FIRE_SPREAD = 1 / 14; // chance a second, at full intensity, of catching the next compartment
export const CREW_FIGHT = 0.12; // intensity put out a second
export const CREW_FLOOD = 0.4; // the flooding that is left with a crew in the compartment
export const CREW_REPAIR = 0.5; // compartment points a second
export const REPAIR_CAP = 0.6;
const NEXT_TO = { gun: ['bridge'], bridge: ['gun', 'engine'], engine: ['bridge', 'guns'], guns: ['engine', 'steering'], steering: ['guns'] };
export const neighbours = (id) => NEXT_TO[id];

export const DUEL_LEVELS = ['easy', 'normal', 'hard'];
// The fire control does not know the target's velocity, it tracks it: the estimate follows the true one with a lag (`track`, s;
// 3 s for the player's own, the enemy's by its level), so a change of course or speed spoils the solution for a few seconds.
const TRACK_PLAYER = 3;
// How the enemy decides. `think` is how often (s); `aim` multiplies its scatter; `base` is the angle off its bow it keeps you
// at (a broadside shows the bigger target but the aft guns need one); `jink` the size of its random alterations of course, every
// `every` seconds; `range` the distance it wants to fight at; `speed` its telegraph order; `retreat` the hull fraction below
// which it runs.
export const LEVELS = {
  easy: { name: 'Easy', think: 1.4, aim: 2.4, track: 6, base: 0, jink: 0, every: [99, 99], range: 5200, speed: 4, retreat: 0, crews: 1, ammo: 'he' },
  normal: { name: 'Normal', think: 0.6, aim: 1.2, track: 4, base: rad(22), jink: rad(18), every: [9, 16], range: 4600, speed: 5, retreat: 0.25, crews: 2, ammo: 'mixed' },
  hard: { name: 'Hard', think: 0.25, aim: 1.0, track: 2.5, base: rad(40), jink: rad(40), every: [5, 10], range: 4000, speed: 5, retreat: 0.3, crews: 3, ammo: 'smart' },
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

function makeShip(idx, x, z, psi, team = idx === 0 ? 0 : 1, kind = 'frigate') {
  const comp = {};
  for (const id of COMP_IDS) comp[id] = COMPARTMENTS[id].hp;
  return {
    idx, team, kind, merchant: kind === 'merchant', target: -1, lock: false, ests: {},
    x, z, psi, u: 0, r: 0, rudder: 0, heel: 0, order: START_ORDER,
    hp: kind === 'merchant' ? MERCHANT_HP : HULL_HP, comp, flood: 0, tSunk: null, listSide: 1,
    fire: Object.fromEntries(COMP_IDS.map((id) => [id, 0])), // intensity 0..1 in each compartment
    leak: Object.fromEntries(COMP_IDS.map((id) => [id, 0])), // hull points a second from holes in it
    crews: Array.from({ length: CREWS }, () => ({ to: null, eta: 0 })), // sent to `to`, working once eta has run out
    // The 76 mm: yaw (+ toward port), pitch, the time until it is loaded, the rounds, and whether it is on the solution.
    gun: { yaw: 0, pitch: rad(2), cool: 1.5, ammo: MAIN_ROUNDS, stock: { ...AMMO_STOCK }, type: 'he', onTarget: false, engaged: false },
    gats: [0, 1].map(() => ({ yaw: GUN_STOW.yaw, pitch: GUN_STOW.pitch, ammo: GUN_ROUNDS, firing: false, rounds: 0, spin: 0, spinRate: 0, burst: 0, cool: 0 })),
    auto: true, // the aft guns fire by themselves
    est: null, // the velocity this ship's fire control believes the other ship has, [x, z]
    cmd: { want: 0, fire: false, gat: false, aim: null },
    manual: false, // the 76 mm is aimed by hand (input.aim) instead of by the fire control
    ai: null,
    stats: { shells: 0, hits: 0, bursts: 0, burstHits: 0, taken: 0 },
  };
}

export class DuelSim {
  // `level` is the enemy's; `auto` ('easy' | 'normal' | 'hard') hands the player's ship to the same kind of helmsman (tests).
  constructor({ seed = 11, level = 'normal', auto = null, waves = false } = {}) {
    this.seed = seed;
    this.wavesOn = !!waves; // more ships arrive (the scene turns it on)
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
    this.pickTargets();
    for (const s of this.ships) { const v = this.velOf(this.ships[s.target]); s.est = [v[0], v[2]]; s.ests = { [s.target]: s.est }; }
    this.rngF = mulberry32((this.seed ^ 0xf17e) >>> 0); // fires: a stream of its own, so they never shift the gunnery draws
    this.ships[1].ai = this.makeAi(this.level);
    if (this.auto) this.ships[0].ai = this.makeAi(this.auto);
    this.shells = [];
    this.shellId = 0;
    this.events = [];
    this.winner = null; // 0 you, 1 the enemy
    this.over = null; // why: 'sunk' | 'merchant'
    this.nextPick = PICK_EVERY;
    this.collided = {};
    this.merchantsSunk = 0; // by your guns
    this.rngW = mulberry32((this.seed ^ 0x3a7e) >>> 0); // where the others come from: a stream of its own
    this.pending = this.wavesOn ? this.planWaves() : [];
  }

  planWaves() {
    const list = (ENEMY_WAVES[this.level] ?? ENEMY_WAVES.normal).map((t) => ({ t, kind: 'enemy' }));
    list.push({ t: ALLY_WAVE, kind: 'ally' });
    for (const t of MERCHANT_WAVES) list.push({ t, kind: 'merchant' });
    return list.sort((a, b) => a.t - b.t);
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
  // Take the 76 mm by hand or give it back to the fire control (one call per key press). The enemy never does.
  setManual(i, on) { const s = this.ships[i]; if (s.tSunk !== null || s.ai) return false; s.manual = !!on; return true; }
  // Where a perfect gunner would aim now (the target's true velocity, ballistic drop): for tests and scripted players. The scene's reticle
  // does not show this, only where the target is and how far it moves in a shell's time of flight at its last course.
  leadSolution(i) {
    const s = this.ships[i], o = this.foe(s), keep = s.est;
    const v = this.velOf(o);
    s.est = [v[0], v[2]];
    const sol = this.solve(s, MAIN_MOUNT, MUZZLE_V, true);
    s.est = keep;
    return sol;
  }
  // Change the loaded kind of 76 mm round (one call per key press, never from `input`): costs a reload. `type` omitted: the other kind.
  switchAmmo(i, type = null) {
    const s = this.ships[i], g = s.gun;
    const to = type ?? (g.type === 'he' ? 'ap' : 'he');
    if (s.tSunk !== null || to === g.type || !AMMO_TYPES[to] || g.stock[to] <= 0) return false;
    g.type = to;
    g.cool = Math.max(g.cool, SWITCH_TIME);
    this.events.push({ type: 'ammo', ship: i, kind: to });
    return true;
  }
  get player() { return this.ships[0]; }
  get enemy() { return this.foe(this.ships[0]); } // the ship your guns are on (a fight of two: the only enemy)
  knots(s) { return s.u / KT; }
  headingDeg(s) { return ((deg(s.psi) % 360) + 360) % 360; }
  range() { const a = this.ships[0], b = this.enemy; return Math.hypot(b.x - a.x, b.z - a.z); }
  // Bearing of the ship's target from its bow: + to starboard.
  relBearing(s) { const o = this.foe(s); return wrapPi(Math.atan2(o.z - s.z, o.x - s.x) - s.psi); }

  // --- who is who ----------------------------------------------------------------------------------------------------
  foe(s) { return this.ships[s.target] ?? this.ships[1 - (s.idx % 2)]; }
  hostile(s, o) { return o !== s && o.team !== 2 && s.team !== 2 && o.team !== s.team; }
  // On Easy your own ship is tough: each hit by an enemy costs EASY_HIT_FRACTION of the compartment.
  easyShield(from, tgt) { return this.level === 'easy' && tgt.idx === 0 && this.hostile(from, tgt); }
  hostiles(s, alive = true) { return this.ships.filter((o) => this.hostile(s, o) && (!alive || o.tSunk === null)); }
  distance(a, b) { return Math.hypot(a.x - b.x, a.z - b.z); }
  // The velocity [x, z] this ship's fire control believes `o` has (the estimate lags the truth; for a ship it has not tracked, the truth).
  estOf(s, o) {
    if (o.idx === s.target) return s.est;
    if (s.ests[o.idx]) return s.ests[o.idx];
    const v = this.velOf(o);
    return [v[0], v[2]];
  }
  // Each warship's target is the nearest living ship of the other side; it keeps it until another is clearly nearer (or it goes down), and a
  // locked one (the player's Tab) until it goes down.
  pickTargets() {
    for (const s of this.ships) {
      if (s.merchant) continue;
      const cur = this.ships[s.target];
      const curOk = !!cur && cur.tSunk === null && this.hostile(s, cur);
      if (curOk && s.lock) continue;
      let best = null, bd = Infinity;
      for (const o of this.hostiles(s)) { const d = this.distance(s, o); if (d < bd) { bd = d; best = o; } }
      if (curOk && (!best || bd >= 0.75 * this.distance(s, cur))) continue;
      this.retarget(s, best ?? (cur ?? this.ships.find((o) => this.hostile(s, o)))?.idx ?? -1);
    }
  }
  retarget(s, to) {
    const idx = typeof to === 'object' ? to?.idx : to;
    if (idx === undefined || idx < 0 || idx === s.target) return;
    if (s.target >= 0 && s.est) s.ests[s.target] = s.est;
    s.target = idx;
    s.lock = false;
    if (s.ests[idx]) s.est = s.ests[idx];
    else { const v = this.velOf(this.ships[idx]); s.est = s.ests[idx] = [v[0], v[2]]; }
  }
  // The player's Tab: the next living enemy by range, locked until it sinks. Returns the ship, or null.
  cycleTarget(i = 0) {
    const s = this.ships[i];
    const list = this.hostiles(s).sort((a, b) => this.distance(s, a) - this.distance(s, b));
    if (!list.length) return null;
    const at = list.findIndex((o) => o.idx === s.target);
    const next = list[(at + 1) % list.length];
    this.retarget(s, next.idx);
    s.lock = true;
    return next;
  }
  setTarget(i, idx) {
    const s = this.ships[i], o = this.ships[idx];
    if (!o || o.tSunk !== null || !this.hostile(s, o)) return false;
    this.retarget(s, idx);
    s.lock = true;
    return true;
  }

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
    const me = this.ships[0];
    me.cmd = me.ai ? me.cmd : { want: (input.right ? 1 : 0) - (input.left ? 1 : 0), fire: !!input.fire, gat: !!input.gat, aim: input.aim ?? null };
    while (this.pending.length && this.pending[0].t <= this.t) this.spawn(this.pending.shift());
    if (this.t >= this.nextPick) { this.nextPick = this.t + PICK_EVERY; this.pickTargets(); }
    for (const s of this.ships) {
      if (s.ai && this.t >= s.ai.next) this.think(s);
      this.stepShip(s, dt);
    }
    if (this.ships.length > 2) this.stepCollisions();
    for (const s of this.ships) {
      if (s.merchant) continue;
      const k = Math.min(1, dt / (s.ai ? s.ai.p.track : TRACK_PLAYER));
      for (const o of this.ships) {
        if (!this.hostile(s, o)) continue;
        const v = this.velOf(o);
        const e = o.idx === s.target ? s.est : (s.ests[o.idx] ??= [v[0], v[2]]);
        e[0] += (v[0] - e[0]) * k;
        e[1] += (v[2] - e[1]) * k;
      }
    }
    for (const s of this.ships) { if (s.merchant || s.passive) continue; this.stepMain(s, dt); this.stepGats(s, dt); }
    for (const sh of [...this.shells]) this.stepShell(sh, dt);
    for (const s of this.ships) this.stepDamage(s, dt);
    this.judge();
  }

  // Who has won: you lose when your ship sinks or your guns sink a merchant; you win when every enemy is down and no more are coming
  // (while some are, the next one is called in at once).
  judge() {
    if (this.winner !== null) return;
    const me = this.ships[0];
    const foes = this.ships.filter((o) => o.team === 1);
    const foesDown = foes.every((o) => o.tSunk !== null);
    const coming = this.pending.find((w) => w.kind === 'enemy');
    if (me.tSunk === null && this.merchantsSunk > 0) { this.finish(1, 'merchant'); return; }
    if (me.tSunk === null && foesDown && coming) { coming.t = Math.min(coming.t, this.t + 12); this.pending.sort((a, b) => a.t - b.t); return; }
    if (me.tSunk === null && !foesDown) return;
    if (me.tSunk !== null && !foesDown) { this.finish(1, 'sunk'); return; }
    const lastFoe = Math.max(...foes.map((o) => o.tSunk));
    this.finish(me.tSunk !== null && me.tSunk <= lastFoe ? 1 : 0, 'sunk');
  }
  finish(winner, why) {
    this.winner = winner;
    this.over = why;
    this.events.push({ type: 'over', winner, reason: why });
  }

  // --- the others arrive ---------------------------------------------------------------------------------------------------
  spawn(w) {
    const me = this.ships[0], r = this.rngW, idx = this.ships.length;
    const foe = this.enemy;
    const axis = Math.atan2(foe.z - me.z, foe.x - me.x);
    let s;
    if (w.kind === 'merchant') {
      // across the line of fire: starts far off to one side and aims at a point near the middle of the fight
      const mx = (me.x + foe.x) / 2 + Math.cos(axis) * (r() * 2 - 1) * 900, mz = (me.z + foe.z) / 2 + Math.sin(axis) * (r() * 2 - 1) * 900;
      const from = axis + (r() < 0.5 ? -1 : 1) * Math.PI / 2 + (r() * 2 - 1) * rad(12);
      const sx = mx + Math.cos(from) * 8200, sz = mz + Math.sin(from) * 8200;
      s = makeShip(idx, sx, sz, Math.atan2(mz - sz, mx - sx), 2, 'merchant');
      s.order = 3;
      s.u = MERCHANT_KN * KT;
    } else if (w.kind === 'enemy') {
      const brg = axis + (r() * 2 - 1) * rad(70);
      const sx = me.x + Math.cos(brg) * ARRIVE_RANGE, sz = me.z + Math.sin(brg) * ARRIVE_RANGE;
      s = makeShip(idx, sx, sz, brg + Math.PI + (r() * 2 - 1) * rad(15), 1);
      s.ai = this.makeAi(this.level);
      s.passive = this.level === 'easy'; // on Easy the ones that arrive only show themselves: they do not fire
    } else { // the friendly frigate: from astern of you, heading for the enemy
      const brg = me.psi + Math.PI + (r() * 2 - 1) * rad(40);
      const sx = me.x + Math.cos(brg) * 4500, sz = me.z + Math.sin(brg) * 4500;
      s = makeShip(idx, sx, sz, Math.atan2(foe.z - sz, foe.x - sx), 0);
      s.ai = this.makeAi('normal');
    }
    if (!s.merchant) s.u = TELEGRAPH[START_ORDER].kn * KT;
    this.ships.push(s);
    this.pickTargets();
    this.events.push({ type: 'arrive', ship: idx, kind: w.kind, rel: wrapPi(Math.atan2(s.z - me.z, s.x - me.x) - me.psi), range: this.distance(me, s) });
  }

  // --- hulls that touch ----------------------------------------------------------------------------------------------------
  stepCollisions() {
    const n = this.ships.length;
    for (let a = 0; a < n; a++) {
      for (let b = a + 1; b < n; b++) {
        const A = this.ships[a], B = this.ships[b];
        if (A.tSunk !== null || B.tSunk !== null || Math.abs(A.x - B.x) > 140 || Math.abs(A.z - B.z) > 140) continue;
        const ca = Math.cos(A.psi), sa = Math.sin(A.psi), cb = Math.cos(B.psi), sb = Math.sin(B.psi);
        const near = segSeg([A.x - ca * COLLIDE_SEG, A.z - sa * COLLIDE_SEG], [A.x + ca * COLLIDE_SEG, A.z + sa * COLLIDE_SEG],
          [B.x - cb * COLLIDE_SEG, B.z - sb * COLLIDE_SEG], [B.x + cb * COLLIDE_SEG, B.z + sb * COLLIDE_SEG]);
        if (near.d >= COLLIDE_GAP) continue;
        let nx = near.b[0] - near.a[0], nz = near.b[1] - near.a[1];
        const len = Math.hypot(nx, nz);
        if (len < 1e-6) { nx = -sa; nz = ca; } else { nx /= len; nz /= len; }
        const pen = (COLLIDE_GAP - near.d) / 2;
        A.x -= nx * pen; A.z -= nz * pen;
        B.x += nx * pen; B.z += nz * pen;
        const va = this.velOf(A), vb = this.velOf(B);
        const closing = (va[0] - vb[0]) * nx + (va[2] - vb[2]) * nz;
        if (closing <= 0.3) continue;
        const key = a * 64 + b;
        if (this.t - (this.collided[key] ?? -99) < COLLIDE_AGAIN) { A.u *= 0.995; B.u *= 0.995; continue; }
        this.collided[key] = this.t;
        const cx = (near.a[0] + near.b[0]) / 2, cz = (near.a[1] + near.b[1]) / 2;
        for (const S of [A, B]) {
          const lx = (cx - S.x) * Math.cos(S.psi) + (cz - S.z) * Math.sin(S.psi);
          const side = -(cx - S.x) * Math.sin(S.psi) + (cz - S.z) * Math.cos(S.psi);
          this.damage(S, zoneAt(clamp(lx, -HALF_LENGTH, HALF_LENGTH)), Math.min(COLLIDE_DAMAGE * closing, 45), SHELL_HULL * 2, side);
          S.u *= 0.55;
          S.r += clamp(side, -1, 1) * 0.04;
        }
        this.events.push({ type: 'collision', a: A.idx, b: B.idx, pos: [cx, 5, cz], impact: closing });
      }
    }
  }

  stepShip(s, dt) {
    const sunk = s.tSunk !== null;
    const engine = s.comp.engine / COMPARTMENTS.engine.hp;
    stepHull(s, dt, {
      want: sunk ? 0 : s.cmd.want,
      orderKn: sunk ? 0 : s.merchant ? MERCHANT_KN : TELEGRAPH[s.order].kn,
      radius: TURN_RADIUS,
      rudderLimit: RUDDER_MAX * (0.25 + 0.75 * s.comp.steering / COMPARTMENTS.steering.hp),
      speedCap: s.comp.engine <= 0 ? 5 / TELEGRAPH[s.order].kn : 0.35 + 0.65 * engine,
    });
  }

  // The scatter of a ship's 76 mm (radians, one standard deviation).
  scatter(s) {
    const hurt = 1 - s.comp.bridge / COMPARTMENTS.bridge.hp;
    return (SCATTER_BASE * (s.manual ? MANUAL_SCATTER : 1) + SCATTER_TURN * Math.abs(s.r)) * (1 + 1.5 * hurt) * (s.ai ? s.ai.p.aim : 1);
  }

  // The 76 mm's solution on the other ship: yaw, pitch and the time of flight, with the target assumed to go on
  // in a straight line at its present velocity, and the shell carrying the firing ship's own velocity.
  // `at` ({ p: the world point to hit, v: its velocity [x, 0, z] }) aims at that point on a ship instead of the middle of the target.
  solve(s, mount, muzzleV, drop, out = {}, at = null) {
    const o = this.foe(s);
    const M = this.toWorld(s, mount);
    const tp = at ? at.p : this.toWorld(o, [0, 6, 0]);
    const tv = at ? at.v : [s.est[0], 0, s.est[1]], sv = this.velOf(s);
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
    if (g.stock[g.type] <= 0 && g.ammo > 0) this.switchAmmo(s.idx); // the loaded kind ran out: the other is loaded
    const tgt = this.foe(s);
    const alive = !sunk && s.comp.gun > 0 && g.ammo > 0 && tgt.tSunk === null;
    const aim = s.manual && !s.ai ? s.cmd.aim : null;
    if (alive && aim) {
      // by hand: the gun goes where it is pointed, inside its arc and elevation, and fires when the trigger is down and it is there
      wantYaw = clamp(aim.yaw, -MAIN_ARC, MAIN_ARC);
      wantPitch = clamp(aim.pitch, MAIN_PITCH[0], MAIN_PITCH[1]);
      const at = this.ships[aim.ship] ?? tgt, M = this.toWorld(s, MAIN_MOUNT);
      g.engaged = at.tSunk === null && Math.hypot(at.x - M[0], at.z - M[2]) <= MAIN_RANGE;
    } else if (alive && s.manual && !s.ai) {
      // by hand but nothing pointed at yet: the gun holds where it is and cannot fire (never the fire control at the manual scatter)
      wantYaw = g.yaw; wantPitch = g.pitch;
    } else if (alive) {
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
    g.stock[g.type] -= 1;
    g.ammo = g.stock.he + g.stock.ap;
    s.stats.shells += 1;
    const aim = s.manual && !s.ai ? s.cmd.aim : null;
    const at = aim && this.ships[aim.ship] ? aim.ship : null;
    const lock = at !== null && aim.lock ? { ship: at, comp: aim.lock } : null;
    const focus = at !== null && !lock && aim.focus ? { ship: at, comp: aim.focus } : null;
    const sigma = this.scatter(s) * (lock ? LOCK_SCATTER : focus ? FOCUS_SCATTER : 1);
    const gauss = () => Math.sqrt(-2 * Math.log(1 - this.rng())) * Math.cos(2 * Math.PI * this.rng());
    const yaw = g.yaw + gauss() * sigma, pitch = g.pitch + gauss() * sigma;
    const dir = this.dirOf(s, yaw, pitch);
    const M = this.toWorld(s, MAIN_MOUNT);
    const sv = this.velOf(s);
    const sh = {
      id: ++this.shellId, owner: s.idx, t0: this.t, kind: g.type, lock, focus, sea: !!aim?.free,
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
    const owner = this.ships[sh.owner];
    const tgt = this.foe(owner);
    let struck = null, at = null, nearest = Infinity;
    for (const t of this.ships) {
      if (sh.sea || t.team === owner.team || (t.tSunk !== null && this.t - t.tSunk >= 6) || Math.hypot(sh.p[0] - t.x, sh.p[2] - t.z) > 90) continue;
      const a = this.toLocal(t, p0), b = this.toLocal(t, sh.p);
      const hit = segmentBox(a, b);
      const d2 = hit ? (a[0] - hit[0]) ** 2 + (a[1] - hit[1]) ** 2 + (a[2] - hit[2]) ** 2 : Infinity;
      if (hit && d2 < nearest) { nearest = d2; struck = t; at = hit; }
    }
    if (struck) { this.hit(sh, struck, at); return; }
    if (sh.p[1] <= 0) {
      const f = p0[1] / (p0[1] - sh.p[1] || 1);
      const pos = [lerp(p0[0], sh.p[0], f), 0, lerp(p0[2], sh.p[2], f)];
      this.events.push({ type: 'splash', owner: sh.owner, pos, miss: Math.hypot(pos[0] - tgt.x, pos[2] - tgt.z) });
      this.shells.splice(this.shells.indexOf(sh), 1);
    } else if (this.t - sh.t0 > SHELL_LIFE) this.shells.splice(this.shells.indexOf(sh), 1);
  }

  hit(sh, tgt, local) {
    const from = this.ships[sh.owner];
    const aimed = sh.lock?.ship === tgt.idx ? sh.lock : sh.focus?.ship === tgt.idx ? sh.focus : null;
    const comp = aimed ? aimed.comp : zoneAt(local[0]);
    const am = AMMO_TYPES[sh.kind] ?? AMMO_TYPES.he;
    let dmg = aimed ? COMPARTMENTS[comp].hp * (sh.lock ? LOCK_FRACTION : FOCUS_FRACTION) : lerp(SHELL_DAMAGE[0], SHELL_DAMAGE[1], this.rng()) * am.dmg;
    if (this.easyShield(from, tgt)) dmg = COMPARTMENTS[comp].hp * EASY_HIT_FRACTION;
    if (this.hostile(from, tgt)) from.stats.hits += 1;
    tgt.stats.taken += 1;
    tgt.lastHitBy = from.idx;
    const pos = this.toWorld(tgt, [local[0], clamp(local[1], 0, BOX.y1), local[2]]);
    this.damage(tgt, comp, dmg, SHELL_HULL, local[2]);
    if (am.fire > 0 && this.rngF() < am.fire) this.ignite(tgt, comp, 0.3);
    tgt.leak[comp] += am.flood;
    this.events.push({ type: 'hit', owner: sh.owner, ship: tgt.idx, comp, dmg, kind: sh.kind, pos, local: local.slice(), out: tgt.comp[comp] <= 0, neutral: tgt.team === 2 });
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

  ignite(s, comp, level = 0.3) {
    if (s.tSunk !== null || s.comp[comp] <= 0 || s.fire[comp] > 0) return;
    s.fire[comp] = level;
    this.events.push({ type: 'fire', ship: s.idx, comp });
  }

  // Send a crew to a compartment, or call back the one already there or on its way (one call per key press). Returns whether anything changed.
  assignCrew(i, comp) {
    const s = this.ships[i];
    if (s.tSunk !== null || !COMPARTMENTS[comp]) return false;
    const on = s.crews.find((c) => c.to === comp);
    if (on) { on.to = null; return true; }
    const free = s.crews.find((c) => c.to === null);
    if (!free) return false;
    free.to = comp; free.eta = CREW_MOVE;
    return true;
  }
  crewIn(s, comp) { return s.crews.some((c) => c.to === comp && c.eta <= 0); }

  stepDamage(s, dt) {
    if (s.tSunk !== null) return;
    for (const c of s.crews) if (c.to !== null && c.eta > 0) c.eta = Math.max(0, c.eta - dt);
    let flood = 0;
    for (const id of COMP_IDS) {
      const crew = this.crewIn(s, id);
      // fire: grows, burns the compartment and a little of the hull, spreads, and a crew puts it out
      let f = s.fire[id];
      if (f > 0) {
        if (s.comp[id] <= 0) f = 0; // nothing left to burn
        else {
          f = Math.min(1, f + FIRE_GROW * dt);
          s.comp[id] = Math.max(0, s.comp[id] - FIRE_BURN * f * dt);
          s.hp = Math.max(0, s.hp - FIRE_HULL * f * dt);
          if (s.comp[id] <= 0) this.events.push({ type: 'out', ship: s.idx, comp: id });
          for (const n of NEXT_TO[id]) if (s.fire[n] <= 0 && this.rngF() < FIRE_SPREAD * f * dt) this.ignite(s, n, 0.15);
          if (crew) f = Math.max(0, f - CREW_FIGHT * dt);
        }
        if (f <= 0 && s.fire[id] > 0) this.events.push({ type: 'fireout', ship: s.idx, comp: id });
        s.fire[id] = f;
      }
      if (crew && s.fire[id] <= 0) { // restore, up to the cap (a compartment that was out can come back)
        const cap = COMPARTMENTS[id].hp * REPAIR_CAP;
        if (s.comp[id] < cap) s.comp[id] = Math.min(cap, s.comp[id] + CREW_REPAIR * dt);
      }
      flood += ((s.comp[id] <= 0 ? FLOOD_RATE : 0) + s.leak[id]) * (crew ? CREW_FLOOD : 1);
    }
    s.flood = flood;
    s.hp = Math.max(0, s.hp - s.flood * dt);
    if (s.hp <= 0) {
      s.tSunk = this.t;
      s.cmd = { want: 0, fire: false, gat: false };
      if (s.merchant && s.lastHitBy === 0) this.merchantsSunk += 1;
      this.events.push({ type: 'sunk', ship: s.idx, kind: s.kind, pos: this.toWorld(s, [0, 4, 0]) });
    }
  }

  // --- the aft guns -----------------------------------------------------------------------------------------------------
  stepGats(s, dt) {
    const o = this.foe(s);
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
          o.lastHitBy = s.idx;
          this.damage(o, comp, this.easyShield(s, o) ? COMPARTMENTS[comp].hp * EASY_HIT_FRACTION : GUN_DAMAGE, 0.5, this.rng() - 0.5);
          this.events.push({ type: 'gunhit', owner: s.idx, ship: o.idx, comp, pos: this.toWorld(o, [x, 6, (this.rng() * 2 - 1) * HALF_BEAM]) });
        }
      }
    }
  }

  // --- the enemy's helmsman ----------------------------------------------------------------------------------------------
  // Which round to have loaded. Easy leaves the HE in; Normal finishes a hurt compartment with AP and uses HE otherwise; Hard also
  // lights fires with HE while the target has none. Never changes within AMMO_DWELL s of the last change (each change is a reload).
  chooseAmmo(s, o) {
    const mode = s.ai.p.ammo, g = s.gun;
    if (mode === 'he' || this.t < (s.ai.ammoAt ?? 0)) return;
    const hurt = COMP_IDS.some((id) => o.comp[id] > 0 && o.comp[id] <= (mode === 'smart' ? 16 : 11));
    const burning = COMP_IDS.some((id) => o.fire[id] > 0);
    let want = hurt || (o.hp / HULL_HP < 0.4) ? 'ap' : 'he';
    if (mode === 'smart' && !hurt && !burning && o.hp / HULL_HP > 0.6) want = 'he';
    if (want !== g.type && this.switchAmmo(s.idx, want)) s.ai.ammoAt = this.t + AMMO_DWELL;
  }

  // Send the crews where they are needed most: fire first, then a compartment that is out, then the most hurt. Level sets how many crews it uses.
  dispatchCrews(s) {
    const n = s.ai.p.crews;
    const need = (id) => (s.fire[id] > 0 ? 3 + s.fire[id] : 0) + (s.comp[id] <= 0 ? 2 : 0) + (1 - s.comp[id] / COMPARTMENTS[id].hp) + s.leak[id] * 8;
    const ranked = COMP_IDS.map((id) => [id, need(id)]).filter(([, v]) => v > 0.3).sort((a, b) => b[1] - a[1]).slice(0, n).map(([id]) => id);
    for (const c of s.crews) if (c.to !== null && !ranked.includes(c.to) && need(c.to) < 0.2) c.to = null; // call back a crew with nothing left to do
    for (const id of ranked) {
      if (s.crews.filter((c) => c.to !== null).length >= n) break;
      if (!s.crews.some((c) => c.to === id)) this.assignCrew(s.idx, id);
    }
  }

  // Every `think` seconds: where to point, how fast to go. The rudder follows by the same keys a player has.
  think(s) {
    const ai = s.ai, p = ai.p;
    ai.next = this.t + p.think;
    if (s.tSunk !== null) return;
    const o = this.foe(s);
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
    this.chooseAmmo(s, o);
    this.dispatchCrews(s);
    s.cmd.fire = true; // it fires whenever the gun is on (the gun decides)
    s.cmd.gat = true;
  }
}

// The closest approach of two segments in the plane ([x, z] ends): the distance and the two nearest points.
function segSeg(p1, q1, p2, q2) {
  const d1x = q1[0] - p1[0], d1z = q1[1] - p1[1], d2x = q2[0] - p2[0], d2z = q2[1] - p2[1];
  const rx = p1[0] - p2[0], rz = p1[1] - p2[1];
  const a = d1x * d1x + d1z * d1z, e = d2x * d2x + d2z * d2z, f = d2x * rx + d2z * rz;
  const c = d1x * rx + d1z * rz, b = d1x * d2x + d1z * d2z, den = a * e - b * b;
  let s = den > 1e-9 ? clamp((b * f - c * e) / den, 0, 1) : 0;
  let t = (b * s + f) / e;
  if (t < 0) { t = 0; s = clamp(-c / a, 0, 1); } else if (t > 1) { t = 1; s = clamp((b - c) / a, 0, 1); }
  const pa = [p1[0] + d1x * s, p1[1] + d1z * s], pb = [p2[0] + d2x * t, p2[1] + d2z * t];
  return { d: Math.hypot(pa[0] - pb[0], pa[1] - pb[1]), a: pa, b: pb };
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
export { segmentBox, segSeg };

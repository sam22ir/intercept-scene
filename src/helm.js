// "Helm": you sail the frigate yourself and defend her against drones. Like the manual flight (fly.js) this
// is not a pure function of a clock: the helmsman's keys drive a small real-time simulation, stepped at a
// fixed rate so it behaves the same at any frame rate, and tested in Node.
//
// The ship
//   ← →     the wheel: hold to put the rudder over (6 degrees a second, 35 at most); let go and the helmsman
//           eases it back amidships.
//   ↑ ↓     the engine-room telegraph, one step at a time: slow astern, stop, dead slow, slow, half, full, flank.
//   The hull answers like a ship, not a car: a first-order (Nomoto) turn that builds up over several seconds,
//   a tactical diameter of about four ship lengths at full rudder, speed that comes and goes over half a
//   minute, a little speed lost in a hard turn, and an outward heel while she turns.
//
// The threat
//   Drones come in one at a time, later two, from random bearings, 5.3 to 5.8 km out. The search radar sees them
//   at RADAR_RANGE: an alarm and a call ("drone detected, green 045, 5.6 km"). Left alone a drone does not
//   go away: it makes one low pass along the ship's side and, if it has not been shot down, comes round for its
//   second approach, which is the attack: it dives into her.
//   Three drones on board and the ship is out of action.
//
// The missile
//   F fires at the selected target (Tab picks another; the nearest by default). The box launcher on the
//   forward deckhouse turns onto the predicted position (SLEW_TIME), and the round leaves its cell and homes
//   by proportional navigation (the manual flight's numbers), fuzing within FUZE of the drone. The box only
//   engages ahead of and abeam the ship (ARC): a drone astern needs the ship turned. 8 cells, so 8 rounds.
//
// Coordinates are the scene's: metres, +Y up, the sea is y = 0. +X is north and +Z east: a heading `psi` is
// measured from +X toward +Z (clockwise from north, as a compass). In the ship's own frame her bow is +X and
// her starboard side +Z (the frame scenario.js and the ship model use), so a ship-frame point p is in the
// world at  (x + p.x cos psi - p.z sin psi,  p.y,  z + p.x sin psi + p.z cos psi).
import * as THREE from 'three';
import { G, LAUNCHER_PIVOT, TUBE_MOUTH, launcherQuat } from './scenario.js';
import { attitude } from './fly.js';

const rad = THREE.MathUtils.degToRad;
const deg = THREE.MathUtils.radToDeg;
const clamp = THREE.MathUtils.clamp;
const sm = THREE.MathUtils.smoothstep;
const lerp = THREE.MathUtils.lerp;
const wrapPi = (a) => Math.atan2(Math.sin(a), Math.cos(a));

export const DT = 1 / 120;
export const KT = 0.514444; // m/s per knot

// --- The ship ---------------------------------------------------------------------------------------------
export const TELEGRAPH = [
  { name: 'Slow astern', kn: -5 },
  { name: 'Stop', kn: 0 },
  { name: 'Dead slow', kn: 5 },
  { name: 'Slow', kn: 10 },
  { name: 'Half', kn: 16 },
  { name: 'Full', kn: 22 },
  { name: 'Flank', kn: 28 },
];
export const START_ORDER = 4; // half ahead
export const RUDDER_MAX = rad(35);
const RUDDER_RATE = rad(6); // per second, hold the key
const TURN_T = 8; // s: how long the swing takes to build up
const TURN_RADIUS = 230; // m at full rudder (a tactical diameter of about four lengths)
const SPEED_T = 30; // s: the speed comes and goes on this time constant
const ACCEL_MAX = 0.2; // m/s²
const TURN_LOSS = 0.3; // fraction of the ordered speed lost at full rudder
const HEEL = 0.16; // rad of heel per (rad/s of turn × m/s of speed)
export const HALF_LENGTH = 58; // m, for the drones striking her
export const HALF_BEAM = 7.5;
// Where the officer of the watch stands, and the fire-control director (both in the ship's frame).
export const BRIDGE_EYE = new THREE.Vector3(16.9, 11.4, 0);
export const DIRECTOR_EYE = new THREE.Vector3(14.4, 15.6, 0);

// --- The drones -------------------------------------------------------------------------------------------
export const RADAR_RANGE = 5000; // m
const SPAWN_RANGE = [5300, 5800]; // just beyond the radar: it picks them up a few seconds later
const DRONE_SPEED = 46; // m/s cruising
const ATTACK_SPEED = 56; // m/s on the final dive
const DRONE_TURN = rad(24); // per second at most
const DRONE_CLIMB = 6; // m/s
const CLOSE_CALL = 2000; // m: "drone closing"
const PASSES_BEFORE_ATTACK = 1; // the first approach is a pass; the second one is the attack
const STRIKES_TO_LOSE = 3;

// --- The missile ------------------------------------------------------------------------------------------
export const CELLS = 8;
export const SLEW_TIME = 1.6; // s for the launcher to turn onto the target
export const MISSILE_RANGE = 4500; // m
export const MIN_RANGE = 150; // m
export const ARC = rad(120); // the box engages within this of the bow, either side
const MISSILE_LIFE = 12; // s
const MISSILE_N = 5;
const MISSILE_MAX_ACC = 60 * G;
const FUZE = 4; // m
const MAX_IN_FLIGHT = 2;
// The eight cells (two rows of four) in the launcher's own frame.
const CELL_MOUTHS = [];
for (const y of [0.3, -0.3]) for (let c = 0; c < 4; c++) CELL_MOUTHS.push(new THREE.Vector3(TUBE_MOUTH.x, y, -0.93 + c * 0.62));

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _q = new THREE.Quaternion();

// Compass helpers: a bearing from north (deg 0..360), and a relative one as the navy says it: green to
// starboard, red to port ("green 045").
export const compass = (r) => ((deg(r) % 360) + 360) % 360;
export function relName(relRad) {
  const d = Math.round(deg(wrapPi(relRad)));
  if (Math.abs(d) <= 2) return 'right ahead';
  if (Math.abs(d) >= 178) return 'right astern';
  return `${d > 0 ? 'green' : 'red'} ${String(Math.abs(d)).padStart(3, '0')}`;
}
export const kmText = (m) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`);

// A seeded random source, so a run (and a test) can be repeated.
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

export class HelmSim {
  constructor({ seed = 7 } = {}) {
    this.seed = seed;
    this.reset();
  }

  reset() {
    this.rng = mulberry32(this.seed);
    this.t = 0;
    this.acc = 0;
    // The ship: position (x north, z east), heading, speed through the water, rate of turn, rudder (+ = to starboard).
    this.x = 0;
    this.z = 0;
    this.psi = 0;
    this.u = TELEGRAPH[START_ORDER].kn * KT;
    this.r = 0;
    this.rudder = 0;
    this.order = START_ORDER;
    this.heel = 0;
    this.strikes = 0;
    this.kills = 0;
    this.out = false; // out of action
    // Drones and missiles.
    this.drones = [];
    this.nextId = 1;
    this.wave = 0;
    this.nextSpawn = 18;
    this.targetId = null;
    this.missiles = [];
    this.cellsUsed = 0;
    this.shot = null; // the launcher turning onto a target: { cell, tPress, from, aim, droneId }
    this.launcher = { yaw: 0, pitch: 0 };
    this.lastFire = -Infinity;
    this.events = [];
  }

  say(text, tone = '') { this.events.push({ type: 'say', text, tone }); }
  takeEvents() { const e = this.events; this.events = []; return e; }

  // --- the ship's frame ------------------------------------------------------------------------------------
  toWorld(p, out) {
    const c = Math.cos(this.psi);
    const s = Math.sin(this.psi);
    return out.set(this.x + p.x * c - p.z * s, p.y, this.z + p.x * s + p.z * c);
  }
  toLocal(p, out) {
    const c = Math.cos(this.psi);
    const s = Math.sin(this.psi);
    const dx = p.x - this.x;
    const dz = p.z - this.z;
    return out.set(dx * c + dz * s, p.y, -dx * s + dz * c);
  }
  shipVel(out) { return out.set(Math.cos(this.psi) * this.u, 0, Math.sin(this.psi) * this.u); }
  get headingDeg() { return compass(this.psi); }
  get knots() { return this.u / KT; }
  get rateOfTurn() { return deg(this.r) * 60; } // deg per minute, + = to starboard
  get cellsLeft() { return CELLS - this.cellsUsed; }
  // Range and relative bearing (rad, + = starboard) of a world point from the ship.
  rangeTo(p) { return Math.hypot(p.x - this.x, p.z - this.z); }
  relBearing(p) { return wrapPi(Math.atan2(p.z - this.z, p.x - this.x) - this.psi); }
  trueBearing(p) { return compass(Math.atan2(p.z - this.z, p.x - this.x)); }

  // --- the helmsman's orders --------------------------------------------------------------------------------
  telegraph(step) {
    if (this.out) return;
    const next = clamp(this.order + step, 0, TELEGRAPH.length - 1);
    if (next === this.order) return;
    this.order = next;
    const o = TELEGRAPH[next];
    this.events.push({ type: 'telegraph' });
    this.say(o.kn === 0 ? 'Telegraph: stop engines' : `Telegraph: ${o.name.toLowerCase()}${o.kn > 0 ? ' ahead' : ''}, ${Math.abs(o.kn)} kn`, '');
  }

  // --- targets ----------------------------------------------------------------------------------------------
  get live() { return this.drones.filter((d) => d.alive); }
  get detected() { return this.drones.filter((d) => d.alive && d.detected); }
  get target() {
    const d = this.drones.find((x) => x.id === this.targetId && x.alive && x.detected);
    return d ?? null;
  }
  nearest() {
    let best = null;
    for (const d of this.detected) if (!best || this.rangeTo(d.pos) < this.rangeTo(best.pos)) best = d;
    return best;
  }
  cycleTarget() {
    const list = this.detected.sort((a, b) => this.rangeTo(a.pos) - this.rangeTo(b.pos));
    if (!list.length) { this.say('No target on the radar', 'warn'); return; }
    const i = list.findIndex((d) => d.id === this.targetId);
    const d = list[(i + 1) % list.length];
    this.targetId = d.id;
    this.say(`Target ${d.name}: ${relName(this.relBearing(d.pos))}, ${kmText(this.rangeTo(d.pos))}`, '');
  }
  // Can the box engage this drone now? null if it can, else the reason.
  engageable(d) {
    if (!d) return 'No target on the radar';
    const range = _a.copy(d.pos).sub(this.toWorld(LAUNCHER_PIVOT, _b)).length();
    if (range > MISSILE_RANGE) return `Out of range: ${kmText(MISSILE_RANGE)} at most`;
    if (range < MIN_RANGE) return 'Too close for the missile';
    if (Math.abs(this.relBearing(d.pos)) > ARC) return 'Target astern, outside the launcher\'s arc: turn the ship';
    return null;
  }

  fire() {
    if (this.out) return;
    if (this.cellsLeft <= 0) { this.say('No missiles left', 'warn'); return; }
    if (this.shot) { this.say('The launcher is still turning', 'warn'); return; }
    if (this.missiles.length >= MAX_IN_FLIGHT) { this.say(`${MAX_IN_FLIGHT} missiles already in the air`, 'warn'); return; }
    const d = this.target ?? this.nearest();
    if (!d) { this.say('No target on the radar', 'warn'); return; }
    this.targetId = d.id;
    const why = this.engageable(d);
    if (why) { this.say(why, 'warn'); return; }
    // Aim where the drone will be when the round is on its way (the slew, plus a moment), in the ship's frame
    // (the launcher turns with her).
    const lead = SLEW_TIME + 1.2;
    _a.copy(d.pos).addScaledVector(d.vel, lead).sub(this.shipVel(_b).multiplyScalar(lead));
    const rel = this.toLocal(_a, _c).sub(LAUNCHER_PIVOT);
    const yaw = Math.atan2(-rel.z, rel.x);
    const pitch = clamp(Math.atan2(rel.y, Math.hypot(rel.x, rel.z)), rad(20), rad(70));
    this.shot = { cell: this.cellsUsed, tPress: this.t, from: { ...this.launcher }, aim: { yaw, pitch }, droneId: d.id };
    this.cellsUsed += 1;
    this.events.push({ type: 'slew' });
    this.say(`Engaging ${d.name}: launcher turning`, 'warn');
  }

  // --- stepping -----------------------------------------------------------------------------------------------
  // Advance by dt seconds of real time with the helmsman's keys ({ left, right }: held or not).
  advance(dt, input = {}) {
    this.acc += Math.min(dt, 0.25);
    while (this.acc >= DT) {
      this.acc -= DT;
      this.step(DT, input);
    }
  }

  step(dt, input) {
    this.t += dt;
    this.stepShip(dt, input);
    this.stepSpawn();
    for (const d of this.drones) this.stepDrone(d, dt);
    this.stepLauncher();
    for (const m of [...this.missiles]) this.stepMissile(m, dt);
    // Wrecks sink and are forgotten after a while.
    this.drones = this.drones.filter((d) => d.alive || this.t - d.tDown < 40);
  }

  stepShip(dt, input) {
    // The wheel: held keys put the rudder over; let go and it comes back amidships.
    const want = this.out ? 0 : (input.right ? 1 : 0) - (input.left ? 1 : 0);
    const goal = want * RUDDER_MAX;
    const dr = goal - this.rudder;
    this.rudder += clamp(dr, -RUDDER_RATE * dt, RUDDER_RATE * dt);
    // Speed: toward the ordered speed (less in a hard turn), on a time constant, with a limit to the acceleration.
    const ordered = (this.out ? 0 : TELEGRAPH[this.order].kn) * KT * (1 - TURN_LOSS * Math.abs(this.rudder) / RUDDER_MAX);
    this.u += clamp((ordered - this.u) / SPEED_T, -ACCEL_MAX, ACCEL_MAX) * dt;
    // Turn (Nomoto, first order): the rate builds toward the steady turn for this rudder and speed.
    const rSteady = (this.u / TURN_RADIUS) * (this.rudder / RUDDER_MAX) * (this.u < 0 ? 0.5 : 1);
    this.r += ((rSteady - this.r) / TURN_T) * dt;
    this.psi = wrapPi(this.psi + this.r * dt);
    this.x += Math.cos(this.psi) * this.u * dt;
    this.z += Math.sin(this.psi) * this.u * dt;
    // Heel outward in the turn (port side down turning to starboard), on a short lag.
    this.heel += ((-HEEL * this.r * this.u - this.heel) / 3) * dt;
  }

  stepSpawn() {
    if (this.out || this.t < this.nextSpawn) return;
    const maxLive = this.wave >= 2 ? 2 : 1;
    if (this.live.length >= maxLive) { this.nextSpawn = this.t + 5; return; }
    this.spawn();
    this.wave += 1;
    this.nextSpawn = this.t + Math.max(45, 80 - this.wave * 6);
  }

  spawn(at = null) {
    const rng = this.rng;
    const b = at?.bearing ?? rng() * Math.PI * 2;
    const range = at?.range ?? lerp(SPAWN_RANGE[0], SPAWN_RANGE[1], rng());
    const alt = at?.alt ?? lerp(120, 220, rng());
    const pos = new THREE.Vector3(this.x + Math.cos(b) * range, alt, this.z + Math.sin(b) * range);
    const toShip = new THREE.Vector3(this.x - pos.x, 0, this.z - pos.z).normalize();
    const d = {
      id: this.nextId,
      name: `D${this.nextId}`,
      pos,
      vel: toShip.multiplyScalar(DRONE_SPEED),
      quat: new THREE.Quaternion(),
      bank: 0,
      alive: true,
      detected: false,
      called: false, // the "closing" call made
      phase: 'inbound', // inbound | pass | extend | attack | down | struck
      tPhase: this.t,
      passes: 0,
      side: rng() < 0.5 ? -1 : 1,
      orbit: rng() < 0.5 ? -1 : 1,
      weave: rng() * 6,
      tDown: Infinity,
      wreck: null,
    };
    this.nextId += 1;
    this.drones.push(d);
    return d;
  }

  setPhase(d, phase) { d.phase = phase; d.tPhase = this.t; }

  // Where the drone is steering for, by phase; also moves it on to the next phase.
  droneAim(d, out) {
    const range = this.rangeTo(d.pos);
    const age = this.t - d.tPhase;
    const sv = this.shipVel(_b);
    switch (d.phase) {
      case 'inbound': {
        if (range < 1100) { this.setPhase(d, 'pass'); return this.droneAim(d, out); } // its first approach: a low pass
        const w = Math.sin(this.t * 0.25 + d.weave) * 220; // a lazy weave on the way in
        const bx = (d.pos.z - this.z) / (range || 1);
        const bz = -(d.pos.x - this.x) / (range || 1);
        return out.set(this.x + bx * w, lerp(d.pos.y, 110, 0.02), this.z + bz * w);
      }
      case 'circle': {
        // Round the ship, the circle tightening and coming down, for about half a minute.
        if (age > 35) { this.setPhase(d, 'pass'); return this.droneAim(d, out); }
        const R = lerp(800, 400, sm(age, 0, 30));
        const a = Math.atan2(d.pos.z - this.z, d.pos.x - this.x) + d.orbit * 0.5;
        return out.set(this.x + Math.cos(a) * R, lerp(110, 60, sm(age, 0, 30)), this.z + Math.sin(a) * R);
      }
      case 'pass': {
        // A low pass along the ship's side, each one closer and lower.
        const off = [90, 45, 18][Math.min(d.passes, 2)];
        const alt = [45, 30, 20][Math.min(d.passes, 2)];
        const lead = range / DRONE_SPEED;
        const aim = this.toWorld(_a.set(0, alt, d.side * off), out).addScaledVector(sv, lead);
        // Past her (opening and close by): pull out and come round for another.
        const dot = (d.pos.x - this.x) * d.vel.x + (d.pos.z - this.z) * d.vel.z;
        if (range < 160 && dot > 0) {
          d.passes += 1;
          this.events.push({ type: 'pass', id: d.id, pos: d.pos.clone() });
          this.setPhase(d, 'extend');
        }
        return aim;
      }
      case 'extend': {
        if (age > 16 || range > 900) { this.setPhase(d, d.passes >= PASSES_BEFORE_ATTACK ? 'attack' : 'pass'); d.side = -d.side; return this.droneAim(d, out); }
        const k = 1 / (range || 1);
        return out.set(d.pos.x + (d.pos.x - this.x) * k * 300, lerp(d.pos.y, 80, 0.05), d.pos.z + (d.pos.z - this.z) * k * 300);
      }
      case 'attack': {
        // Straight at her, aiming for the superstructure, leading her motion.
        const lead = range / ATTACK_SPEED;
        return this.toWorld(_a.set(8, 10, 0), out).addScaledVector(sv, lead);
      }
      default:
        return out.copy(d.pos);
    }
  }

  stepDrone(d, dt) {
    if (!d.alive) return;
    const range = this.rangeTo(d.pos);
    // Radar contact, and the calls.
    if (!d.detected && range < RADAR_RANGE) {
      d.detected = true;
      if (this.targetId === null || !this.target) this.targetId = d.id;
      this.events.push({ type: 'alarm', level: 1, id: d.id });
      this.say(`Radar: drone ${d.name} detected, ${relName(this.relBearing(d.pos))}, ${kmText(range)}`, 'warn');
    }
    if (d.detected && !d.called && range < CLOSE_CALL) {
      d.called = true;
      this.events.push({ type: 'alarm', level: 2, id: d.id });
      this.say(`Drone ${d.name} closing: ${relName(this.relBearing(d.pos))}, ${kmText(range)}`, 'bad');
    }
    const before = d.phase;
    const aim = this.droneAim(d, _c);
    if (d.phase !== before && d.phase === 'attack') {
      this.events.push({ type: 'alarm', level: 3, id: d.id });
      this.say(`Drone ${d.name} attack run! Fire!`, 'bad');
    } else if (d.phase !== before && d.phase === 'pass' && before === 'inbound') {
      this.events.push({ type: 'alarm', level: 2, id: d.id });
      this.say(`Drone ${d.name} coming in low, ${relName(this.relBearing(d.pos))}`, 'bad');
    }
    // Steer: turn the velocity toward the aim at a limited rate, climb or sink at a limited rate.
    const speed = d.phase === 'attack' ? ATTACK_SPEED : DRONE_SPEED;
    const hv = _a.set(d.vel.x, 0, d.vel.z);
    const heading = Math.atan2(hv.z, hv.x);
    const want = Math.atan2(aim.z - d.pos.z, aim.x - d.pos.x);
    const dh = clamp(wrapPi(want - heading), -DRONE_TURN * dt, DRONE_TURN * dt);
    const h2 = heading + dh;
    const horiz = Math.hypot(aim.x - d.pos.x, aim.z - d.pos.z);
    const climbMax = d.phase === 'attack' ? 14 : DRONE_CLIMB;
    const vy = clamp(((aim.y - d.pos.y) / Math.max(horiz / speed, 0.5)), -climbMax, climbMax);
    const vh = Math.sqrt(Math.max(speed * speed - vy * vy, 1));
    d.vel.set(Math.cos(h2) * vh, vy, Math.sin(h2) * vh);
    d.pos.addScaledVector(d.vel, dt);
    // Attitude: nose along the velocity, banked into the turn.
    const omega = dh / dt;
    d.bank += ((Math.atan((speed * omega) / G) - d.bank) / 0.4) * dt;
    attitude(_b.copy(d.vel).normalize(), d.bank, d.quat);
    // Into the ship, or into the sea.
    const local = this.toLocal(d.pos, _a);
    if (Math.abs(local.x) < HALF_LENGTH && Math.abs(local.z) < HALF_BEAM + 1 && local.y < (Math.abs(local.x - 10) < 12 ? 24 : 9)) {
      this.strike(d);
    } else if (d.pos.y < 1) {
      this.down(d, 'sea', d.pos.clone().setY(0));
    }
  }

  strike(d) {
    d.alive = false;
    d.phase = 'struck';
    d.tDown = this.t;
    this.strikes += 1;
    this.events.push({ type: 'struck', id: d.id, pos: d.pos.clone() });
    if (this.strikes >= STRIKES_TO_LOSE) {
      this.out = true;
      this.events.push({ type: 'over' });
      this.say(`Drone ${d.name} hit the ship: she is out of action. R to sail again`, 'bad');
    } else {
      this.say(`Drone ${d.name} hit the ship! Damage ${this.strikes} of ${STRIKES_TO_LOSE}`, 'bad');
    }
  }

  down(d, kind, burstPos) {
    d.alive = false;
    d.phase = 'down';
    d.tDown = this.t;
    d.wreck = {
      t: this.t, kind, pos: d.pos.clone(), quat: d.quat.clone(), vel: d.vel.clone(),
      burstPos: burstPos.clone(), burstDist: burstPos.distanceTo(d.pos), prop: 0,
    };
    if (kind === 'missile') {
      this.kills += 1;
      this.events.push({ type: 'explosion', id: d.id, pos: burstPos.clone() });
      this.say(`Splash one: drone ${d.name} destroyed`, 'ok');
    } else {
      this.events.push({ type: 'splash', id: d.id, pos: burstPos.clone() });
    }
    if (this.targetId === d.id) this.targetId = this.nearest()?.id ?? null;
  }

  // --- the launcher and the missiles -------------------------------------------------------------------------------
  stepLauncher() {
    const s = this.shot;
    if (s) {
      const age = this.t - s.tPress;
      const w = sm(age, 0, SLEW_TIME);
      this.launcher.yaw = lerp(s.from.yaw, s.aim.yaw, w);
      this.launcher.pitch = lerp(s.from.pitch, s.aim.pitch, w);
      if (age >= SLEW_TIME) this.launch(s);
      return;
    }
    // Back to the stow a few seconds after the last round.
    const back = sm(this.t, this.lastFire + 3, this.lastFire + 6);
    if (this.lastAim) {
      this.launcher.yaw = lerp(this.lastAim.yaw, 0, back);
      this.launcher.pitch = lerp(this.lastAim.pitch, 0, back);
    }
  }

  launch(s) {
    this.shot = null;
    this.lastFire = this.t;
    this.lastAim = { ...s.aim };
    const q = launcherQuat(s.aim.yaw, s.aim.pitch, _q);
    const local = CELL_MOUTHS[s.cell % CELLS].clone().applyQuaternion(q).add(LAUNCHER_PIVOT);
    const pos = this.toWorld(local, new THREE.Vector3());
    const dl = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
    const dir = this.toWorld(dl, new THREE.Vector3()).sub(_a.set(this.x, 0, this.z)).normalize();
    const m = {
      id: s.cell + 1, pos, vel: dir.clone().multiplyScalar(40).add(this.shipVel(_b)), dir, tFire: this.t,
      targetId: s.droneId, start: pos.clone(),
    };
    this.missiles.push(m);
    this.events.push({ type: 'fire', pos: pos.clone(), dir: dir.clone(), id: m.id });
    this.say('Missile away', 'warn');
  }

  stepMissile(m, dt) {
    const age = this.t - m.tFire;
    let d = this.drones.find((x) => x.id === m.targetId && x.alive);
    if (!d) {
      // Its target is gone: take the nearest live drone ahead of it, or self-destruct.
      d = null;
      let best = Infinity;
      for (const x of this.live) {
        _a.subVectors(x.pos, m.pos);
        if (_a.angleTo(m.vel) < rad(35) && _a.length() < best) { best = _a.length(); d = x; }
      }
      if (!d) { this.loseMissile(m, 'Missile lost its target: self-destructed'); return; }
      m.targetId = d.id;
    }
    const r = _a.subVectors(d.pos, m.pos);
    if (r.length() < FUZE) { this.removeMissile(m); this.down(d, 'missile', m.pos.clone()); return; }
    if (age > MISSILE_LIFE) { this.loseMissile(m, 'The missile ran out of time'); return; }
    const speed = age < 0.5 ? 40 + age * 360 : Math.min(420, 220 + (age - 0.5) * 160);
    if (age > 0.3) {
      const off = m.vel.angleTo(r);
      if (off > 0.6) {
        const turn = Math.min((MISSILE_MAX_ACC / m.vel.length()) * dt, off);
        _b.crossVectors(m.vel, r).normalize();
        m.vel.applyAxisAngle(_b, turn);
      } else {
        const vr = _b.subVectors(d.vel, m.vel);
        const omega = _c.crossVectors(r, vr).divideScalar(r.lengthSq());
        const acc = omega.cross(m.vel).multiplyScalar(MISSILE_N); // N (ω × v)
        if (acc.length() > MISSILE_MAX_ACC) acc.setLength(MISSILE_MAX_ACC);
        m.vel.addScaledVector(acc, dt);
      }
    }
    m.vel.setLength(speed);
    // Do not step through the drone in one tick at closing speed: check the closest point along the step.
    const step = _b.copy(m.vel).multiplyScalar(dt);
    const tc = clamp(r.dot(step) / step.lengthSq(), 0, 1);
    if (_c.copy(m.pos).addScaledVector(step, tc).distanceTo(d.pos) < FUZE) {
      m.pos.addScaledVector(step, tc);
      this.removeMissile(m);
      this.down(d, 'missile', m.pos.clone());
      return;
    }
    m.pos.add(step);
    m.dir.copy(m.vel).normalize();
    if (m.pos.y < 0.5 && age > 1) this.loseMissile(m, 'The missile fell into the sea');
  }

  removeMissile(m) { this.missiles = this.missiles.filter((x) => x !== m); }

  loseMissile(m, text) {
    this.removeMissile(m);
    this.events.push({ type: 'missile-lost', pos: m.pos.clone(), id: m.id });
    this.say(text, 'warn');
  }

  // The worst threat now, for the alarm and the readouts: 0 none, 1 detected, 2 inside 2 km or passing, 3 attacking.
  get threat() {
    let lvl = 0;
    for (const d of this.live) {
      if (!d.detected) continue;
      const range = this.rangeTo(d.pos);
      lvl = Math.max(lvl, d.phase === 'attack' ? 3 : range < CLOSE_CALL || d.phase === 'pass' ? 2 : 1);
    }
    return lvl;
  }
}

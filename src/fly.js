// "Fly the drone": the manual-flight model. Unlike every other mission this one is not a pure function
// of the clock: the pilot's keys drive a small real-time simulation, stepped at a fixed 1/240 s so it
// behaves the same at any frame rate (and can be tested in Node, like scenario.js).
//
// The story it plays out, in order:
//  deck    the drone sits on the catapult cradle, engine off. E starts the engine (it runs up over the same
//          3 s as the scripted launch). L fires the catapult once the engine is at full power (pressed
//          earlier, it arms and fires as soon as the engine is ready). The engine can only be started here.
//  cat     the 9 m pneumatic stroke (the scenario's own numbers), about half a second.
//  flight  off the rail the booster burns for 1.2 s and the drone settles at its cruise speed (75 m/s by
//          default). Left / right bank and turn it (a coordinated turn: rate = g tan(bank) / v), up / down
//          pitch it. E cuts the engine for good: the parachute opens by itself.
//  chute   closed-form descent under canopy (the recovery mission's own), then it floats: "splashed".
//  F       fires the frigate's missile at the drone: the launcher slews, the round leaves the tube and
//          homes by proportional navigation (the intercept mission's numbers) until it fuzes on the drone
//          ("destroyed"), runs out of time, or hits the sea.
//  Flying into the sea or the ship ends the run ("crashed"); R starts again.
//
// Coordinates are the scene's: metres, the ship heads +X (the bow), starboard is +Z, +Y is up, and the
// ship moves along +X at SHIP_SPEED. The heading `alpha` is measured from +X toward +Z (0 = the bow's
// direction, 90 = starboard), so a right turn increases it. Nose is local +Z, the left wing local +X.
import * as THREE from 'three';
import {
  scenario, RAIL, SHIP_SPEED, G, LAUNCHER_PIVOT, TUBE_MOUTHS, launcherQuat, deckHeight, shipPos,
} from './scenario.js';

const rad = THREE.MathUtils.degToRad;
const sm = THREE.MathUtils.smoothstep;
const lerp = THREE.MathUtils.lerp;

export const T_SPOOL = scenario.tSpool; // engine run-up on the cradle (s)
export const T_RELEASE = scenario.tRelease; // the scripted stroke's end; the stroke starts at T_SPOOL
const CAT_TIME = T_RELEASE - T_SPOOL;
const CAT_ACCEL = (2 * RAIL.length) / (CAT_TIME * CAT_TIME); // m/s², about 6 g
export const BOOST_TIME = 1.2; // s the booster burns after release
export const PROP_OMEGA = 560; // rad/s at full power
const T_COAST = 1.4; // the prop winds down over this time constant after the engine is cut

export const DEFAULT_SPEED = 75; // m/s
export const SPEED_LIMITS = [45, 110];
const PITCH_UP = rad(30);
const PITCH_DOWN = rad(25);
// A hard turn: 75 degrees of bank is 3.9 g and 28 degrees a second at 75 m/s (a 150 m radius). The scripted
// flights stay under 50 degrees; a pilot who is dodging a missile needs more.
export const MAX_BANK = rad(75);
const TAU_ROLL = 0.22; // s, how fast the bank follows the key
const TAU_PITCH = 0.55;
const BOOST_ACCEL = 36; // m/s² while the booster burns
const SPEED_ACCEL = 12; // m/s² otherwise, toward the target speed
export const DT = 1 / 240;

// Under canopy (the recovery mission's numbers, see scenario.js).
const CHUTE = { sink: 5.4, tauH: 2.2, tauV: 1.0, wind: new THREE.Vector3(2.2, 0, 0.9), yFloat: 0.18 };

// The frigate's missile (the intercept mission's numbers).
export const SLEW_TIME = 1.6; // s for the launcher to turn onto the target
export const MISSILE_RANGE = 4500; // m: what a 12 s flight can cover
const MISSILE_LIFE = 12; // s
const MISSILE_N = 5;
const MISSILE_MAX_ACC = 60 * G;
const FUZE = 3.5; // m: the warhead fires this close to the drone
const SHOTS = 2; // cells ready on the launcher

const _up = new THREE.Vector3(0, 1, 0);
const _zAxis = new THREE.Vector3(0, 0, 1);
const _xAxis = new THREE.Vector3(1, 0, 0);
const _x = new THREE.Vector3();
const _y = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _qRoll = new THREE.Quaternion();
const _qA = new THREE.Quaternion();
const _qB = new THREE.Quaternion();
const _qC = new THREE.Quaternion();
const _qHang = new THREE.Quaternion();
const _tmp = new THREE.Vector3();
const _tmp2 = new THREE.Vector3();

// Attitude from a forward direction and a roll (positive = right wing down).
export function attitude(fwd, rollRight, out) {
  _x.crossVectors(_up, fwd).normalize();
  _y.crossVectors(fwd, _x);
  _m.makeBasis(_x, _y, fwd);
  out.setFromRotationMatrix(_m);
  return out.multiply(_qRoll.setFromAxisAngle(_zAxis, rollRight));
}

// Is a point (ship frame) inside the ship's solid parts? Rough boxes: the hull, the superstructure, the mast.
export function insideShip(x, y, z) {
  const az = Math.abs(z);
  if (az < 6.3 && x > -60 && x < 56 && y < deckHeight(x) + 0.2) return true; // hull below the deck line
  if (az < 5.2 && x > -28 && x < 42 && y < 19) return true; // deckhouse and hangar
  if (az < 2.2 && x > 6 && x < 24 && y < 36) return true; // mast
  return false;
}

export class FlySim {
  constructor({ speed = DEFAULT_SPEED } = {}) {
    this.speedTarget = speed;
    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.quat = new THREE.Quaternion();
    this.reset();
  }

  reset() {
    this.t = 0;
    this.acc = 0;
    this.phase = 'deck'; // deck | cat | flight | chute | splashed | crashed | destroyed
    this.engineOn = false;
    this.spin = 0; // 0 stopped .. 1 full power (also the prop blur)
    this.prop = 0; // prop angle, rad
    this.armed = false;
    this.catT = 0; // s into the stroke
    this.tLaunch = null; // sim time the stroke began
    this.tRelease = null; // sim time the drone left the rail
    this.alpha = 0;
    this.theta = 0;
    this.bank = 0;
    this.speed = 0;
    this.chute = null; // { t0, tau, W0, V0, Q0, psi0 }
    this.tSplash = Infinity;
    this.shots = [];
    this.shot = null; // the shot being slewed or flying: { cell, tPress, tFire, from, aim }
    this.missile = null; // { pos, vel, tFire, cell }
    this.launcher = { yaw: 0, pitch: 0 };
    this.wreck = null; // { t, kind, pos, quat, vel, burstPos, burstDist, prop }
    this.events = [];
    this.poseRail(0);
    this.vel.set(SHIP_SPEED, 0, 0);
  }

  // tone: 'ok' (green), 'warn' (amber), 'bad' (red), or none.
  say(text, tone = '') { this.events.push({ type: 'say', text, tone }); }

  takeEvents() {
    const e = this.events;
    this.events = [];
    return e;
  }

  // --- keys -----------------------------------------------------------------
  toggleEngine() {
    switch (this.phase) {
      case 'deck':
        this.engineOn = !this.engineOn;
        if (!this.engineOn) this.armed = false;
        this.say(this.engineOn ? 'Engine starting' : 'Engine stopped', 'ok');
        this.events.push({ type: this.engineOn ? 'engine-start' : 'engine-stop' });
        break;
      case 'cat':
        this.say('Too late: the catapult is firing', 'warn');
        break;
      case 'flight':
        this.cutEngine();
        break;
      default:
        this.say(this.engineOn ? 'Engine running' : 'The engine only starts on the ship', 'warn');
    }
  }

  catapult() {
    if (this.phase !== 'deck') { this.say('The catapult only works on the ship', 'warn'); return; }
    if (!this.engineOn) { this.say('Start the engine first (E)', 'warn'); return; }
    if (this.spin < 0.999) {
      this.armed = true;
      this.say('Catapult armed: it fires at full power', 'ok');
      return;
    }
    this.startCat();
  }

  fire() {
    if (this.phase !== 'flight' && this.phase !== 'chute' && this.phase !== 'splashed') {
      this.say(this.phase === 'deck' || this.phase === 'cat' ? 'The missile needs the drone in the air' : 'Nothing left to shoot at', 'warn');
      return;
    }
    if (this.missile || (this.shot && this.shot.tFire === null)) { this.say('A missile is already on its way', 'warn'); return; }
    if (this.shots.length >= SHOTS) { this.say('No missiles left', 'warn'); return; }
    const range = _tmp.copy(this.pos).sub(shipPos(this.t, _tmp2)).length();
    if (range > MISSILE_RANGE) { this.say(`Out of range: ${Math.round(MISSILE_RANGE / 100) / 10} km at most`, 'warn'); return; }
    // Aim where the drone will be when the round has left and is on its way.
    const lead = SLEW_TIME + 1.2;
    const predicted = _tmp.copy(this.pos).addScaledVector(this.vel, lead);
    const rel = predicted.sub(shipPos(this.t + SLEW_TIME, _tmp2)).sub(LAUNCHER_PIVOT);
    const yaw = Math.atan2(-rel.z, rel.x);
    const pitch = THREE.MathUtils.clamp(Math.atan2(rel.y, Math.hypot(rel.x, rel.z)), rad(25), rad(70));
    this.shot = {
      cell: this.shots.length, tPress: this.t, tFire: null, from: { ...this.launcher }, aim: { yaw, pitch },
    };
    this.shots.push(this.shot);
    this.events.push({ type: 'slew' });
    this.say('Missile: launcher turning onto the target', 'warn');
  }

  setSpeed(v) {
    this.speedTarget = THREE.MathUtils.clamp(Math.round(v), SPEED_LIMITS[0], SPEED_LIMITS[1]);
  }

  // --- stepping -----------------------------------------------------------------
  // Advance by dt seconds of real time with the pilot's inputs ({ left, right, up, down }, booleans or 0..1).
  advance(dt, input = {}) {
    this.acc += Math.min(dt, 0.1);
    let n = 0;
    while (this.acc >= DT && n < 60) {
      this.stepOnce(DT, input);
      this.acc -= DT;
      n++;
    }
    if (n === 60) this.acc = 0;
  }

  stepOnce(dt, input) {
    this.t += dt;
    // Engine run-up, or the prop winding down.
    if (this.engineOn) this.spin = Math.min(1, this.spin + dt / T_SPOOL);
    else this.spin *= Math.exp(-dt / T_COAST);
    this.prop += PROP_OMEGA * this.spin * dt;

    switch (this.phase) {
      case 'deck':
        if (this.armed && this.engineOn && this.spin >= 0.999) this.startCat();
        else this.poseRail(0);
        break;
      case 'cat': this.stepCat(dt); break;
      case 'flight': this.stepFlight(dt, input); break;
      case 'chute':
      case 'splashed': this.stepChute(dt); break;
      default: break; // crashed or destroyed: the wreck is the renderer's
    }
    this.stepLauncher();
    if (this.missile) this.stepMissile(dt);
  }

  startCat() {
    this.phase = 'cat';
    this.armed = false;
    this.catT = 0;
    this.tLaunch = this.t;
    this.events.push({ type: 'launch' });
    this.say('Catapult!', 'ok');
  }

  poseRail(s) {
    this.pos.copy(RAIL.start).addScaledVector(RAIL.dir, s).addScaledVector(RAIL.up, RAIL.ride).add(shipPos(this.t, _tmp));
    attitude(RAIL.dir, 0, this.quat);
  }

  stepCat(dt) {
    this.catT += dt;
    if (this.catT < CAT_TIME) {
      const s = 0.5 * CAT_ACCEL * this.catT * this.catT;
      this.poseRail(s);
      this.vel.copy(RAIL.dir).multiplyScalar(CAT_ACCEL * this.catT).add(_tmp.set(SHIP_SPEED, 0, 0));
      this.speed = this.vel.length();
      return;
    }
    // Off the end of the rail.
    this.poseRail(RAIL.length);
    this.vel.copy(RAIL.dir).multiplyScalar(CAT_ACCEL * CAT_TIME).add(_tmp.set(SHIP_SPEED, 0, 0));
    this.speed = this.vel.length();
    this.alpha = Math.atan2(this.vel.z, this.vel.x);
    this.theta = Math.asin(THREE.MathUtils.clamp(this.vel.y / this.speed, -1, 1));
    this.bank = 0;
    this.tRelease = this.t;
    this.phase = 'flight';
    this.events.push({ type: 'release' });
  }

  stepFlight(dt, input) {
    const roll = (Number(input.right) || 0) - (Number(input.left) || 0);
    const pitch = (Number(input.up) || 0) - (Number(input.down) || 0);
    this.bank += (THREE.MathUtils.clamp(roll, -1, 1) * MAX_BANK - this.bank) * (1 - Math.exp(-dt / TAU_ROLL));
    const target = pitch > 0 ? pitch * PITCH_UP : pitch * PITCH_DOWN;
    this.theta += (target - this.theta) * (1 - Math.exp(-dt / TAU_PITCH));
    // Speed toward the chosen cruise speed; the booster pushes harder for its first 1.2 s.
    const accel = this.t - this.tRelease < BOOST_TIME ? BOOST_ACCEL : SPEED_ACCEL;
    const dv = this.speedTarget - this.speed;
    this.speed += Math.sign(dv) * Math.min(Math.abs(dv), accel * dt);
    // Coordinated turn.
    this.alpha += (G * Math.tan(this.bank)) / Math.max(this.speed, 20) * dt;
    const c = Math.cos(this.theta);
    _tmp.set(c * Math.cos(this.alpha), Math.sin(this.theta), c * Math.sin(this.alpha));
    this.vel.copy(_tmp).multiplyScalar(this.speed);
    this.pos.addScaledVector(this.vel, dt);
    attitude(_tmp, this.bank, this.quat);

    // Into the sea or the ship.
    if (this.pos.y <= 0.4) { this.crash('sea'); return; }
    if (this.t - this.tRelease > 0.8) {
      const rel = _tmp2.copy(this.pos).sub(shipPos(this.t, _tmp));
      if (insideShip(rel.x, rel.y, rel.z)) this.crash('ship');
    }
  }

  cutEngine() {
    this.engineOn = false;
    this.phase = 'chute';
    const W0 = this.pos.clone();
    const V0 = this.vel.clone();
    this.chute = { t0: this.t, W0, V0, Q0: this.quat.clone(), psi0: Math.atan2(V0.x, V0.z), prev: W0.clone() };
    // When it reaches the sea (bisection, as the recovery mission does).
    let lo = 0;
    let hi = 600;
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2;
      if (this.descentRaw(mid, _tmp).y > CHUTE.yFloat) lo = mid; else hi = mid;
    }
    this.tSplash = this.t + hi;
    this.events.push({ type: 'chute', t: this.t });
    this.say('Engine off: parachute', 'warn');
  }

  descentRaw(tau, out) {
    const { W0, V0 } = this.chute;
    const kh = CHUTE.tauH * (1 - Math.exp(-tau / CHUTE.tauH));
    const kv = CHUTE.tauV * (1 - Math.exp(-tau / CHUTE.tauV));
    return out.set(
      W0.x + CHUTE.wind.x * tau + (V0.x - CHUTE.wind.x) * kh,
      W0.y - CHUTE.sink * tau + (V0.y + CHUTE.sink) * kv,
      W0.z + CHUTE.wind.z * tau + (V0.z - CHUTE.wind.z) * kh,
    );
  }

  descentWorld(tau, tAbs, out) {
    const tauSplash = this.tSplash - this.chute.t0;
    if (tau <= tauSplash) return this.descentRaw(tau, out);
    this.descentRaw(tauSplash, out);
    const ta = tau - tauSplash;
    out.x += CHUTE.wind.x * 0.25 * ta;
    out.z += CHUTE.wind.z * 0.25 * ta;
    out.y = CHUTE.yFloat + 0.035 * Math.sin(2.0 * tAbs) - 0.18 * Math.exp(-ta / 0.45) * Math.sin(6 * ta);
    return out;
  }

  stepChute(dt) {
    const c = this.chute;
    const tau = this.t - c.t0;
    this.descentWorld(tau, this.t, this.pos);
    // Hanging attitude: swinging below the canopy, then floating with a nose-down list.
    const ta = this.t - this.tSplash;
    const fade = Math.exp(-tau / 14);
    let pitchUp = -0.1 + 0.16 * Math.sin(1.25 * tau) * fade;
    let roll = 0.13 * Math.sin(0.95 * tau + 1) * fade;
    const psi = c.psi0 + 0.3 * (1 - Math.exp(-tau / 6)) * Math.sin(0.4 * tau);
    if (ta > 0) {
      const k = sm(ta, 0, 0.8);
      pitchUp = lerp(pitchUp, -0.07 + 0.045 * Math.sin(1.7 * this.t), k);
      roll = lerp(roll, 0.08 + 0.05 * Math.sin(1.3 * this.t + 1), k);
    }
    _qA.setFromAxisAngle(_up, psi);
    _qB.setFromAxisAngle(_xAxis, -pitchUp);
    _qC.setFromAxisAngle(_zAxis, roll);
    _qHang.copy(_qA).multiply(_qB).multiply(_qC);
    this.quat.copy(c.Q0).slerp(_qHang, sm(tau, 0, 0.9));
    this.vel.copy(this.pos).sub(c.prev).divideScalar(dt);
    c.prev.copy(this.pos);
    this.speed = this.vel.length();
    if (this.phase === 'chute' && this.t >= this.tSplash) {
      this.phase = 'splashed';
      this.events.push({ type: 'splashdown', pos: this.pos.clone() });
      this.say('Splashdown: the drone is down and afloat', 'ok');
    }
  }

  crash(kind) {
    this.phase = 'crashed';
    const burstPos = this.pos.clone();
    if (kind === 'sea') burstPos.y = 0;
    this.wreck = {
      t: this.t, kind, pos: this.pos.clone(), quat: this.quat.clone(), vel: this.vel.clone(), burstPos, burstDist: 0, prop: this.prop,
    };
    this.engineOn = false;
    this.events.push({ type: 'crash', kind, pos: burstPos.clone() });
    this.say(kind === 'ship' ? 'The drone hit the ship' : 'The drone hit the sea', 'bad');
  }

  destroy(burstPos) {
    this.phase = 'destroyed';
    this.wreck = {
      t: this.t, kind: 'missile', pos: this.pos.clone(), quat: this.quat.clone(), vel: this.vel.clone(),
      burstPos: burstPos.clone(), burstDist: burstPos.distanceTo(this.pos), prop: this.prop,
    };
    this.engineOn = false;
    this.missile = null;
    this.events.push({ type: 'explosion', pos: burstPos.clone() });
    this.say('Drone destroyed by the missile', 'bad');
  }

  // --- the launcher and the missile ---------------------------------------------
  stepLauncher() {
    const s = this.shot;
    if (!s) return;
    if (s.tFire === null) {
      const age = this.t - s.tPress;
      const w = sm(age, 0, SLEW_TIME);
      this.launcher.yaw = lerp(s.from.yaw, s.aim.yaw, w);
      this.launcher.pitch = lerp(s.from.pitch, s.aim.pitch, w);
      if (age >= SLEW_TIME) this.launchMissile(s);
    } else {
      const back = sm(this.t, s.tFire + 3, s.tFire + 6);
      this.launcher.yaw = lerp(s.aim.yaw, 0, back);
      this.launcher.pitch = lerp(s.aim.pitch, 0, back);
    }
  }

  launchMissile(s) {
    s.tFire = this.t;
    const q = launcherQuat(s.aim.yaw, s.aim.pitch, new THREE.Quaternion());
    const pos = TUBE_MOUTHS[s.cell].clone().applyQuaternion(q).add(LAUNCHER_PIVOT).add(shipPos(this.t, new THREE.Vector3()));
    const dir = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
    this.missile = { pos, vel: dir.clone().multiplyScalar(40), tFire: this.t, cell: s.cell, start: pos.clone(), dir };
    this.events.push({ type: 'fire', pos: pos.clone(), dir: dir.clone() });
    this.say('Missile away', 'warn');
  }

  stepMissile(dt) {
    const m = this.missile;
    const age = this.t - m.tFire;
    const target = this.pos;
    const r = _tmp.subVectors(target, m.pos);
    if (r.length() < FUZE) { this.destroy(m.pos); return; }
    if (age > MISSILE_LIFE) { this.loseMissile('The missile ran out of time'); return; }
    const speed = age < 0.5 ? 40 + age * 360 : Math.min(420, 220 + (age - 0.5) * 160);
    if (age > 0.3) {
      const off = m.vel.angleTo(r);
      if (off > 0.6) {
        // Far off line (the steep first moments): pitch over toward the target at the g limit.
        const turn = Math.min((MISSILE_MAX_ACC / m.vel.length()) * dt, off);
        _tmp2.crossVectors(m.vel, r).normalize();
        m.vel.applyAxisAngle(_tmp2, turn);
      } else {
        const vr = new THREE.Vector3().subVectors(this.vel, m.vel);
        const omega = new THREE.Vector3().crossVectors(r, vr).divideScalar(r.lengthSq());
        const acc = new THREE.Vector3().crossVectors(omega, m.vel).multiplyScalar(MISSILE_N);
        if (acc.length() > MISSILE_MAX_ACC) acc.setLength(MISSILE_MAX_ACC);
        m.vel.addScaledVector(acc, dt);
      }
    }
    m.vel.setLength(speed);
    m.pos.addScaledVector(m.vel, dt);
    m.dir.copy(m.vel).normalize();
    if (m.pos.y < 0.5 && age > 1) this.loseMissile('The missile fell into the sea');
  }

  loseMissile(text) {
    const m = this.missile;
    this.events.push({ type: 'missile-lost', pos: m.pos.clone() });
    this.say(text, 'warn');
    this.missile = null;
  }

  // --- readouts -------------------------------------------------------------------
  get altitude() { return Math.max(0, this.pos.y); }
  // Compass heading of the nose (0 = the bow's direction, 90 = starboard), from the attitude.
  get headingDeg() {
    _tmp.set(0, 0, 1).applyQuaternion(this.quat);
    return ((Math.atan2(_tmp.z, _tmp.x) * 180) / Math.PI + 360) % 360;
  }
  // Range to the ship's centre (m) and the bearing of the ship from the drone, relative to the drone's nose (deg, + to its right).
  shipRange() { return _tmp.copy(this.pos).sub(shipPos(this.t, _tmp2)).length(); }
  get done() { return this.phase === 'splashed' || this.phase === 'crashed' || this.phase === 'destroyed'; }
  // The catapult's own clock for the ship model (the cradle) and the booster flames.
  get cradleT() { return this.tLaunch === null ? 0 : T_SPOOL + (this.t - this.tLaunch); }
}

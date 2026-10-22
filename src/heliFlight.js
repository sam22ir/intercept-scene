// The deck helicopter of the Solo Air Defense mission: it only flies for the look of it, but it flies like a ship's helicopter, which
// does not take off or land while the ship is turning: she must hold a steady course (rudder amidships, no turn on) for a few
// seconds first. Parked, it waits (a random time, counted only on a steady course), spins its rotor up, lifts to a hover, leaves
// straight ahead along a lane to one side (clear of the mast and the bridge wings), turns round well ahead of the bow, comes back
// aft along the other side, turns astern and flies in over the stern to the pad; it lands only once the ship has been steady for LAND_STEADY seconds, and
// otherwise it waits low and close over the pad, drifting a little as a hovering helicopter does (a landing under way is waved off
// and climbs back to that hover if she starts to turn). The player can
// also ask for a take-off or a landing (`request`): the same rules hold, so a request waits for a steady course. Imports nothing,
// stepped by the sim at its own rate, so it is tested in Node (test/helicopter.test.mjs).
import { mulberry32 } from './rng.js';

export const PAD = { x: -45.8, y: 5.5, z: 0.5 }; // where the wheels rest, in the ship's frame (x ahead, z to starboard)
export const HOVER = 32; // m above the pad (the mast's top is 28 m): where it climbs to, joins the circuit from and comes back to
export const HOLD_ALT = 32; // m above the pad: where it waits to land, clear above the superstructure
export const T_SPINUP = 6;
export const T_LIFT = 7;
export const T_DESC = 6;
export const T_WAVEOFF = 4;
export const T_SPINDOWN = 8;
export const LIFT_STEADY = 5; // s of steady course before it lifts off
export const LAND_STEADY = 8; // s of steady course before it comes down
export const W_ROTOR = 30; // rad/s at full speed
const smooth = (u) => { const x = Math.min(1, Math.max(0, u)); return x * x * (3 - 2 * x); };

// The circuit, relative to the pad, x ahead and z to starboard, as a path of length c.len with s metres flown: out along the lane
// (eased out from the centre line over the first LEAD_IN m), a U-turn ahead of the bow, aft along the other lane, a U-turn astern,
// then forward along the first lane and eased back onto the centre line to arrive over the pad heading ahead.
const LEAD_IN = 50;
const LEAD_OUT = 60;
function circuitPoint(c, s) {
  const { D, A, B, side } = c;
  const arc = Math.PI * D;
  const s2 = A;
  const s3 = s2 + arc;
  const s4 = s3 + A + B;
  const s5 = s4 + arc;
  const s6 = s5 + B - LEAD_OUT;
  if (s < LEAD_IN) return [s, side * D * smooth(s / LEAD_IN)];
  if (s < s2) return [s, side * D];
  if (s < s3) { const f = (s - s2) / D; return [A + D * Math.sin(f), side * D * Math.cos(f)]; }
  if (s < s4) return [A - (s - s3), -side * D];
  if (s < s5) { const f = (s - s4) / D; return [-B - D * Math.sin(f), -side * D * Math.cos(f)]; }
  if (s < s6) return [-B + (s - s5), side * D];
  return [-LEAD_OUT + (s - s6), side * D * (1 - smooth((s - s6) / LEAD_OUT))];
}

export class HeliFlight {
  constructor(seed = 2718) {
    this.rng = mulberry32(seed);
    this.phase = 'parked'; // parked | spinup | ready | lift | circuit | hold | descend | waveoff | spindown
    this.wait = 20 + this.rng() * 20; // s of steady course it waits parked
    this.rpm = 0;
    this.spin = 0;
    this.prog = 0; // the lift-off, 0 on the deck to 1 at the hover
    this.alt = 0; // m above the pad
    this.clock = 0; // for the drift of a hover
    this.sway = 0; // how much of the hover's drift is on (it fades in once it is hovering)
    this.turb = 0; // how much of the flight's buffeting is on (in the circuit)
    this.yawLag = 0; // its heading off the ship's, rad: the ship turns under it and the pilot follows a moment later
    this.turn = 0; // the ship's rate of turn now, rad/s
    this.u = 0; // progress round the circuit
    this.steadyFor = 0;
    this.combat = false; // a drone is close: stand down
    this.landReq = false; // the player has asked it to land: the circuit is cut short and it comes in
    this.circuit = { D: 18, A: 180, B: 110, len: 700, fly: 28, side: 1, peak: 48 };
    this.state = { x: PAD.x, y: PAD.y, z: PAD.z, yaw: 0, pitch: 0, roll: 0, rpm: 0, spin: 0, flying: false, phase: 'parked' };
  }

  newCircuit() {
    const D = 15 + this.rng() * 7; // the lanes are 15 to 22 m off the centre line: clear of the bridge wings (7 m) and the mast
    const A = 150 + this.rng() * 80; // the turn is that far ahead of the pad, past the bow
    const B = 90 + this.rng() * 50; // and the other one that far astern of it
    const len = 2 * A + 2 * B + 2 * Math.PI * D;
    this.circuit = { D, A, B, len, fly: len / (22 + this.rng() * 8), side: this.rng() < 0.5 ? -1 : 1, peak: 44 + this.rng() * 16 };
    this.u = 0;
  }

  // What the player's button does now: 'takeoff' (parked or winding down), 'land' (airborne or the rotor turning) or null (a landing under way).
  get action() {
    if (this.phase === 'parked' || this.phase === 'spindown') return 'takeoff';
    if (this.phase === 'descend' || (this.landReq && this.phase !== 'spinup' && this.phase !== 'ready')) return null;
    return 'land';
  }

  // The player asks for the other thing than it is doing; returns what to tell them.
  request() {
    const act = this.action;
    if (act === 'takeoff') {
      if (this.phase === 'spindown') return 'The rotor is still winding down';
      this.wait = 0;
      return this.steadyFor >= LIFT_STEADY ? 'Helicopter: starting up' : 'Helicopter: starting up, it lifts off on a steady course';
    }
    if (act === 'land') {
      if (this.phase === 'spinup' || this.phase === 'ready') { this.phase = 'spindown'; return 'Helicopter: shutting down'; }
      this.landReq = true;
      return this.phase === 'hold' && this.steadyFor < LAND_STEADY ? 'Helicopter: landing, it comes down on a steady course' : 'Helicopter: coming in to land';
    }
    return 'The helicopter is already landing';
  }

  // Advance dt seconds; `steady`: the ship is on a fixed course now (no rudder, no turn).
  // `combat`: a drone is close enough that it stands down (the deck stays shut, an airborne one comes in).
  step(dt, steady, turn = 0, combat = false) {
    this.combat = combat;
    if (combat && this.alt > 0 && this.phase !== 'descend' && this.phase !== 'waveoff') this.landReq = true;
    this.steadyFor = steady ? this.steadyFor + dt : 0;
    this.turn = turn;
    this.yawLag += (-turn - this.yawLag / 2.2) * dt; // the ship turns, the helicopter's heading follows with a lag of about 2 s
    this.yawLag = Math.max(-0.6, Math.min(0.6, this.yawLag));
    switch (this.phase) {
      case 'parked':
        if (steady && !combat) this.wait -= dt;
        if (!combat && this.wait <= 0 && this.steadyFor >= LIFT_STEADY) this.phase = 'spinup';
        break;
      case 'spinup':
        if (combat) { this.phase = 'spindown'; break; }
        this.rpm = Math.min(1, this.rpm + dt / T_SPINUP);
        if (this.rpm >= 1) this.phase = 'ready';
        break;
      case 'ready': // the rotor turning, waiting for a steady course
        if (combat) { this.phase = 'spindown'; break; }
        if (this.steadyFor >= LIFT_STEADY) this.phase = 'lift';
        break;
      case 'lift':
        if (combat) { this.landReq = false; this.phase = 'descend'; break; } // not with a drone about: straight back down
        this.prog = Math.min(1, this.prog + dt / T_LIFT);
        this.alt = HOVER * smooth(this.prog);
        if (this.prog >= 1) { this.newCircuit(); this.phase = this.landReq ? 'hold' : 'circuit'; }
        break;
      case 'circuit':
        this.u = Math.min(1, this.u + (dt / this.circuit.fly) * (this.landReq ? 1.5 : 1)); // asked to land: it flies the rest of the circuit faster
        if (this.u >= 1) { this.phase = 'hold'; this.alt = HOVER; }
        break;
      case 'hold': // close over the pad, waiting for a steady course to land
        this.alt += Math.max(-2.5 * dt, Math.min(2.5 * dt, HOLD_ALT - this.alt)); // settling down to the waiting height
        if (this.steadyFor >= LAND_STEADY && this.alt <= HOLD_ALT + 0.5) this.phase = 'descend';
        break;
      case 'descend':
        if (!steady && this.alt > 1.7) { this.phase = 'waveoff'; break; } // she has begun to turn: not with the wheels this close
        this.alt = Math.max(0, this.alt - Math.min(3.5, Math.max(0.5, this.alt * 0.6)) * dt); // quicker high up, gently at the end
        if (this.alt <= 0) { this.phase = 'spindown'; this.landReq = false; this.prog = 0; }
        break;
      case 'waveoff':
        this.alt = Math.min(HOLD_ALT, this.alt + 3 * dt);
        if (this.alt >= HOLD_ALT) this.phase = 'hold';
        break;
      case 'spindown':
        this.rpm = Math.max(0, this.rpm - dt / T_SPINDOWN);
        if (this.rpm <= 0) { this.phase = 'parked'; this.wait = 35 + this.rng() * 75; }
        break;
      default: break;
    }
    this.spin += W_ROTOR * this.rpm * dt;
    this.clock += dt;
    const hovering = this.phase === 'hold' || this.phase === 'descend' || this.phase === 'waveoff' || this.phase === 'lift';
    this.sway += ((hovering ? 1 : 0) - this.sway) * Math.min(1, dt / 1.2);
    this.turb += ((this.phase === 'circuit' ? 1 : 0) - this.turb) * Math.min(1, dt / 1.2);
    this.pose();
  }

  pose() {
    const st = this.state;
    const c = this.circuit;
    st.phase = this.phase;
    st.rpm = this.rpm;
    st.spin = this.spin;
    st.x = PAD.x;
    st.z = PAD.z;
    st.yaw = 0;
    st.pitch = 0;
    st.roll = 0;
    let h = this.alt;
    if (this.phase === 'circuit') {
      // The circuit, flown slowly at both ends and fastest in the middle, the nose along the path, banking into the turns.
      const u = this.u;
      const s = c.len * smooth(u);
      const [x, z] = circuitPoint(c, s);
      const [x2, z2] = circuitPoint(c, s + 1);
      const [x0, z0] = circuitPoint(c, Math.max(0, s - 1));
      const [x3, z3] = circuitPoint(c, s + 6);
      const psi = Math.atan2(z2 - z0, x2 - x0);
      const turn = Math.atan2(z3 - z2, x3 - x2) - psi; // heading change over 5 m
      const kappa = Math.atan2(Math.sin(turn), Math.cos(turn)) / 5;
      const v = (c.len * 6 * u * (1 - u)) / c.fly; // m/s along the path
      h = HOVER + (c.peak - HOVER) * Math.sin(Math.PI * u) ** 0.7;
      st.x = PAD.x + x;
      st.z = PAD.z + z;
      st.yaw = -psi;
      st.pitch = -0.1 * Math.min(1.3, v / 30);
      st.roll = Math.max(-0.35, Math.min(0.35, Math.atan((v * v * kappa) / 9.81)));
    }
    const t = this.clock;
    if (this.turb > 0.001) { // in flight it is buffeted: the nose, the lean and the height never settle
      const b = this.turb;
      st.yaw += (0.06 * Math.sin(1.3 * t) + 0.035 * Math.sin(2.9 * t + 1)) * b;
      st.roll += (0.045 * Math.sin(1.7 * t) + 0.03 * Math.sin(3.1 * t)) * b;
      st.pitch += (0.03 * Math.sin(1.1 * t + 2) + 0.02 * Math.sin(2.3 * t)) * b;
      h += (1.2 * Math.sin(0.9 * t) + 0.5 * Math.sin(2.3 * t)) * b;
    }
    if (this.sway > 0.001) { // a hover is never still: it drifts several metres, bobs, hunts left and right with its nose and leans
      const a = Math.min(1, this.alt / 4) * this.sway; // less and less as the wheels come down, so it lands square
      st.x += (4.2 * Math.sin(0.31 * t) + 1.6 * Math.sin(0.83 * t + 1) + 0.7 * Math.sin(1.9 * t)) * a;
      st.z += (3.4 * Math.sin(0.27 * t + 1) + 1.4 * Math.sin(0.71 * t + 4) + 0.6 * Math.sin(1.7 * t + 2)) * a;
      h += (0.7 * Math.sin(0.8 * t) + 0.25 * Math.sin(2.1 * t)) * a;
      const wander = 0.2 * Math.sin(0.23 * t + 0.5) + 0.1 * Math.sin(0.71 * t + 2) + 0.04 * Math.sin(1.7 * t); // heading, up to about +-19 degrees
      st.yaw += -(wander + this.yawLag) * a;
      st.pitch += (0.05 * Math.sin(0.9 * t + 2) + 0.035 * Math.sin(0.43 * t) + 0.015 * Math.sin(2.3 * t)) * a;
      st.roll += (0.055 * Math.sin(0.7 * t) + 0.03 * Math.sin(0.37 * t + 1) + 0.012 * Math.sin(2.1 * t) + Math.max(-0.14, Math.min(0.14, this.turn * 1.5))) * a;
    }
    st.y = PAD.y + h;
    st.flying = this.alt > 0 || this.phase === 'circuit';
    return st;
  }
}

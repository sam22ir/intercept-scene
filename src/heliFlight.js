// The deck helicopter of the Solo Air Defense mission: it only flies for the look of it, but it flies like a ship's helicopter, which
// does not take off or land while the ship is turning: she must hold a steady course (rudder amidships, no turn on) for a few
// seconds first. Parked, it waits (a random time, counted only on a steady course), spins its rotor up, lifts to a hover, flies a
// circuit round the ship and comes back over the pad; it lands only once the ship has been steady for LAND_STEADY seconds, and
// otherwise holds its hover above the pad (a landing under way is waved off and climbs back if she starts to turn). Imports nothing,
// stepped by the sim at its own rate, so it is tested in Node (test/helicopter.test.mjs).
import { mulberry32 } from './rng.js';

export const PAD = { x: -45.8, y: 5.5, z: 0.5 }; // where the wheels rest, in the ship's frame (x ahead, z to starboard)
export const HOVER = 14; // m above the pad
export const T_SPINUP = 6;
export const T_LIFT = 5;
export const T_DESC = 6;
export const T_WAVEOFF = 4;
export const T_SPINDOWN = 8;
export const LIFT_STEADY = 5; // s of steady course before it lifts off
export const LAND_STEADY = 8; // s of steady course before it comes down
export const W_ROTOR = 30; // rad/s at full speed
const smooth = (u) => { const x = Math.min(1, Math.max(0, u)); return x * x * (3 - 2 * x); };

export class HeliFlight {
  constructor(seed = 2718) {
    this.rng = mulberry32(seed);
    this.phase = 'parked'; // parked | spinup | ready | lift | circuit | hold | descend | waveoff | spindown
    this.wait = 20 + this.rng() * 20; // s of steady course it waits parked
    this.rpm = 0;
    this.spin = 0;
    this.prog = 0; // 0 on the deck, 1 at the hover
    this.u = 0; // progress round the circuit
    this.steadyFor = 0;
    this.circuit = { R: 200, fly: 40, side: 1, peak: 40 };
    this.state = { x: PAD.x, y: PAD.y, z: PAD.z, yaw: 0, pitch: 0, roll: 0, rpm: 0, spin: 0, flying: false, phase: 'parked' };
  }

  newCircuit() {
    const R = 140 + this.rng() * 120;
    this.circuit = { R, fly: (2 * Math.PI * R) / (26 + this.rng() * 10), side: this.rng() < 0.5 ? -1 : 1, peak: 28 + this.rng() * 34 };
    this.u = 0;
  }

  // Advance dt seconds; `steady`: the ship is on a fixed course now (no rudder, no turn).
  step(dt, steady) {
    this.steadyFor = steady ? this.steadyFor + dt : 0;
    switch (this.phase) {
      case 'parked':
        if (steady) this.wait -= dt;
        if (this.wait <= 0 && this.steadyFor >= LIFT_STEADY) this.phase = 'spinup';
        break;
      case 'spinup':
        this.rpm = Math.min(1, this.rpm + dt / T_SPINUP);
        if (this.rpm >= 1) this.phase = 'ready';
        break;
      case 'ready': // the rotor turning, waiting for a steady course
        if (this.steadyFor >= LIFT_STEADY) this.phase = 'lift';
        break;
      case 'lift':
        this.prog = Math.min(1, this.prog + dt / T_LIFT);
        if (this.prog >= 1) { this.newCircuit(); this.phase = 'circuit'; }
        break;
      case 'circuit':
        this.u = Math.min(1, this.u + dt / this.circuit.fly);
        if (this.u >= 1) this.phase = 'hold';
        break;
      case 'hold': // over the pad, waiting for a steady course to land
        if (this.steadyFor >= LAND_STEADY) this.phase = 'descend';
        break;
      case 'descend':
        if (!steady && this.prog > 0.12) { this.phase = 'waveoff'; break; } // she has begun to turn: not with the wheels this close
        this.prog = Math.max(0, this.prog - dt / T_DESC);
        if (this.prog <= 0) this.phase = 'spindown';
        break;
      case 'waveoff':
        this.prog = Math.min(1, this.prog + dt / T_WAVEOFF);
        if (this.prog >= 1) this.phase = 'hold';
        break;
      case 'spindown':
        this.rpm = Math.max(0, this.rpm - dt / T_SPINDOWN);
        if (this.rpm <= 0) { this.phase = 'parked'; this.wait = 35 + this.rng() * 75; }
        break;
      default: break;
    }
    this.spin += W_ROTOR * this.rpm * dt;
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
    let h = HOVER * smooth(this.prog);
    if (this.phase === 'circuit') {
      // A circle through the pad, leaving toward the bow, flown slowly at both ends and fastest in the middle.
      const u = this.u;
      const th = 2 * Math.PI * smooth(u);
      const sf = Math.min(1.3, (2 * Math.PI * 6 * u * (1 - u) * c.R) / c.fly / 30); // its speed against 30 m/s
      h = HOVER + (c.peak - HOVER) * Math.sin(th / 2);
      st.x = PAD.x + c.R * Math.sin(th);
      st.z = PAD.z + c.side * c.R * (1 - Math.cos(th));
      st.yaw = -Math.atan2(c.side * Math.sin(th), Math.cos(th));
      st.pitch = -0.1 * sf;
      st.roll = c.side * 0.3 * Math.min(1, sf);
    }
    st.y = PAD.y + h;
    st.flying = this.prog > 0 || this.phase === 'circuit';
    return st;
  }
}

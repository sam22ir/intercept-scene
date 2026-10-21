import * as THREE from 'three';
import { Kit, mat } from './kit.js';
import { mulberry32 } from '../rng.js';

// A naval helicopter (Panther / Dauphin class): a rounded fuselage with a glazed nose, a tail boom with fin and tail rotor, a four-blade
// main rotor, wheeled gear. Nose along +X, the wheels at y = 0; procedural geometry only. It stands on the pad (PAD) and, every so
// often, spins up, lifts off, flies a circuit round the ship and lands again, only for the look of it: where it is at sim time t is a
// pure function of t (`userData.update(t)`), with a seeded random schedule (how long it stays parked, which side, how wide it flies).
export const PAD = { x: -45.8, y: 5.5, z: 0.5 }; // where the wheels rest, in the ship's frame
const T_SPINUP = 6;
const T_LIFT = 5;
const T_DESC = 6;
const T_SPINDOWN = 8;
const HOVER = 14; // m above the pad
const W_ROTOR = 30; // rad/s at full speed
const smooth = (u) => { const x = Math.min(1, Math.max(0, u)); return x * x * (3 - 2 * x); };

const rng = mulberry32(2718);
const cycles = []; // each flight: its times and its shape, made as they are needed
function cycleAt(i) {
  while (cycles.length <= i) {
    const prev = cycles[cycles.length - 1];
    const park = cycles.length === 0 ? 20 + rng() * 20 : 35 + rng() * 75;
    const R = 140 + rng() * 120;
    const fly = (2 * Math.PI * R) / (26 + rng() * 10);
    const c = { t0: prev ? prev.t1 : 0, park, R, fly, side: rng() < 0.5 ? -1 : 1, peak: 28 + rng() * 34, spin0: prev ? prev.spin1 : 0 };
    c.tLift = c.t0 + park + T_SPINUP;
    c.tFly = c.tLift + T_LIFT;
    c.tDesc = c.tFly + fly;
    c.tDown = c.tDesc + T_DESC;
    c.t1 = c.tDown + T_SPINDOWN;
    c.spin1 = c.spin0 + W_ROTOR * (0.5 * T_SPINUP + T_LIFT + fly + T_DESC + 0.5 * T_SPINDOWN);
    cycles.push(c);
  }
  return cycles[i];
}
// Where the helicopter is, how it stands and how fast its rotor turns at sim time t (in the ship's frame).
export function heliState(t) {
  let i = 0;
  let c = cycleAt(0);
  while (t >= c.t1) c = cycleAt(++i);
  const st = { x: PAD.x, y: PAD.y, z: PAD.z, yaw: 0, pitch: 0, roll: 0, rpm: 0, spin: c.spin0, flying: false };
  const park = c.t0 + c.park;
  if (t < park) return st;
  if (t < c.tLift) { // spinning up on the deck
    const u = (t - park) / T_SPINUP;
    st.rpm = u;
    st.spin = c.spin0 + W_ROTOR * 0.5 * (t - park) * u;
    return st;
  }
  if (t < c.tDown) {
    st.flying = true;
    st.rpm = 1;
    st.spin = c.spin0 + W_ROTOR * (0.5 * T_SPINUP + (t - c.tLift));
    let h = 0;
    if (t < c.tFly) h = HOVER * smooth((t - c.tLift) / T_LIFT);
    else if (t < c.tDesc) {
      // A circle through the pad, leaving toward the bow, flown slowly at both ends and fastest in the middle.
      const u = (t - c.tFly) / c.fly;
      const th = 2 * Math.PI * smooth(u);
      const sf = Math.min(1.3, (2 * Math.PI * 6 * u * (1 - u) * c.R) / c.fly / 30); // its speed against 30 m/s
      h = HOVER + (c.peak - HOVER) * Math.sin(th / 2);
      st.x = PAD.x + c.R * Math.sin(th);
      st.z = PAD.z + c.side * c.R * (1 - Math.cos(th));
      st.yaw = -Math.atan2(c.side * Math.sin(th), Math.cos(th));
      st.pitch = -0.1 * sf;
      st.roll = c.side * 0.3 * Math.min(1, sf);
    } else h = HOVER * (1 - smooth((t - c.tDesc) / T_DESC));
    st.y = PAD.y + h;
    return st;
  }
  const tau = t - c.tDown; // on the deck again, the rotor winding down
  st.rpm = 1 - tau / T_SPINDOWN;
  st.spin = c.spin0 + W_ROTOR * (0.5 * T_SPINUP + T_LIFT + c.fly + T_DESC + tau * (1 - (0.5 * tau) / T_SPINDOWN));
  return st;
}

export function createHelicopter() {
  const M = {
    body: mat(0x8d979e, { metalness: 0.3, roughness: 0.55 }),
    belly: mat(0x5f686e, { metalness: 0.35, roughness: 0.6 }),
    glass: mat(0x0d1a24, { metalness: 0.9, roughness: 0.08 }),
    black: mat(0x16191c, { metalness: 0.5, roughness: 0.5 }),
    rubber: mat(0x1d1f21, { metalness: 0, roughness: 0.9 }),
    steel: mat(0xaab2b7, { metalness: 0.7, roughness: 0.4 }),
    blade: mat(0x23272b, { metalness: 0.3, roughness: 0.6 }),
    tip: mat(0xf0b818, { metalness: 0.2, roughness: 0.6 }),
    red: mat(0xa3231c, { metalness: 0.2, roughness: 0.6 }),
  };
  const k = new Kit();
  const sph = (r) => new THREE.SphereGeometry(r, 20, 14);
  // Fuselage: a long ellipsoid, a darker belly under it, the glazed nose and the cabin windows.
  k.add(sph(1), M.body, { pos: [0.6, 1.75, 0], scale: [3.2, 1.2, 1.05] });
  k.add(sph(1), M.belly, { pos: [0.5, 1.2, 0], scale: [2.9, 0.55, 0.95] });
  k.add(sph(1), M.glass, { pos: [2.7, 2.05, 0], scale: [1.15, 0.78, 0.92] });
  for (const s of [-1, 1]) {
    k.add(new THREE.BoxGeometry(1.0, 0.5, 0.05), M.glass, { pos: [1.5, 2.05, s * 0.99], rot: [0, s * 0.1, 0] });
    k.add(new THREE.BoxGeometry(1.5, 0.5, 0.05), M.glass, { pos: [-0.6, 2.05, s * 1.02], rot: [0, -s * 0.05, 0] });
    k.add(new THREE.BoxGeometry(0.06, 1.1, 0.07), M.black, { pos: [0.55, 1.75, s * 1.02] }); // the door line
    k.add(new THREE.BoxGeometry(0.4, 0.3, 0.02), M.red, { pos: [-2.1, 1.85, s * 0.88] }); // a roundel patch
  }
  // Engine cowlings on the roof and the mast.
  k.add(sph(1), M.body, { pos: [-0.4, 2.95, 0], scale: [1.7, 0.55, 0.8] });
  k.add(new THREE.CylinderGeometry(0.14, 0.2, 0.55, 12), M.steel, { pos: [0.1, 3.35, 0] });
  // Main rotor (its own group, turning on the mast): the hub and four slightly drooping blades with yellow tips, and a faint disc
  // that shows as it spins fast.
  const rk = new Kit();
  rk.add(new THREE.CylinderGeometry(0.32, 0.32, 0.22, 16), M.black, { pos: [0, 0, 0] });
  for (let i = 0; i < 4; i++) {
    const a = 0.45 + (i * Math.PI) / 2;
    const c = Math.cos(a);
    const s = Math.sin(a);
    const droop = -0.06;
    rk.add(new THREE.BoxGeometry(5.0, 0.05, 0.3), M.blade, { pos: [2.8 * c, -0.17, -2.8 * s], rot: [s * droop, a, -c * droop] });
    rk.add(new THREE.BoxGeometry(0.45, 0.052, 0.31), M.tip, { pos: [5.1 * c, -0.3, -5.1 * s], rot: [s * droop, a, -c * droop] });
  }
  const rotor = new THREE.Group();
  rotor.position.set(0.1, 3.72, 0);
  const blades = rk.build({ name: 'main-rotor' });
  rotor.add(blades);
  const disc = new THREE.Mesh(
    new THREE.CircleGeometry(5.2, 40),
    new THREE.MeshBasicMaterial({ color: 0xcfd8de, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide }),
  );
  disc.rotation.x = -Math.PI / 2;
  disc.position.y = -0.3;
  rotor.add(disc);
  // Tail boom, fin and stabiliser, and the tail rotor (its own group).
  k.add(new THREE.CylinderGeometry(0.16, 0.5, 5.4, 14), M.body, { pos: [-4.9, 2.25, 0], rot: [0, 0, Math.PI / 2 - 0.045] });
  k.add(new THREE.BoxGeometry(1.5, 1.7, 0.1), M.body, { pos: [-7.3, 3.0, 0], rot: [0, 0, -0.35] });
  k.add(new THREE.BoxGeometry(0.8, 0.06, 2.1), M.body, { pos: [-6.2, 2.4, 0] });
  k.add(new THREE.CylinderGeometry(0.1, 0.1, 0.14, 10), M.black, { pos: [-7.55, 3.35, 0.14], rot: [Math.PI / 2, 0, 0] });
  const tk = new Kit();
  for (const a of [0.5, 0.5 + Math.PI / 2]) tk.add(new THREE.BoxGeometry(0.07, 1.7, 0.04), M.blade, { rot: [0, 0, a] });
  const tail = new THREE.Group();
  tail.position.set(-7.55, 3.35, 0.2);
  tail.add(tk.build({ name: 'tail-rotor' }));
  // Wheeled landing gear: two main wheels on sponsons, one nose wheel, struts, and a beacon under the tail.
  for (const s of [-1, 1]) {
    k.rod([-0.2, 1.1, s * 0.75], [-0.3, 0.4, s * 1.2], 0.06, M.steel, 6);
    k.add(new THREE.CylinderGeometry(0.34, 0.34, 0.22, 16), M.rubber, { pos: [-0.3, 0.34, s * 1.25], rot: [Math.PI / 2, 0, 0] });
    k.add(new THREE.CylinderGeometry(0.16, 0.16, 0.24, 10), M.steel, { pos: [-0.3, 0.34, s * 1.25], rot: [Math.PI / 2, 0, 0] });
  }
  k.rod([2.2, 1.2, 0], [2.3, 0.4, 0], 0.05, M.steel, 6);
  k.add(new THREE.CylinderGeometry(0.28, 0.28, 0.2, 16), M.rubber, { pos: [2.3, 0.28, 0], rot: [Math.PI / 2, 0, 0] });
  k.add(new THREE.SphereGeometry(0.1, 8, 6), M.red, { pos: [-1.2, 1.1, 0] });

  const group = new THREE.Group();
  group.name = 'helicopter';
  group.add(k.build({ name: 'fuselage' }), rotor, tail);
  const e = new THREE.Euler();
  group.userData.update = (t) => {
    const st = heliState(t);
    group.position.set(st.x, st.y, st.z);
    group.rotation.copy(e.set(st.roll, st.yaw, st.pitch, 'YZX'));
    rotor.rotation.y = -st.spin;
    tail.rotation.z = st.spin * 4.5;
    disc.material.opacity = 0.16 * Math.min(1, st.rpm * 1.4) ** 2;
    blades.visible = st.rpm < 0.6; // a fast rotor is the disc, not 4 strobing blades
  };
  group.userData.update(0);
  return group;
}

import * as THREE from 'three';
import { mulberry32, randomUnit, range } from '../rng.js';
import { ParticleField, MODE } from './particles.js';
import { G, SHIP_SPEED, shipPos } from '../scenario.js';

// What a frigate puts into the air and the water as she steams: grey exhaust haze from the funnel and spray thrown up at the
// bow. Two builds of the same effect: `createShipFx` bakes every particle for the scripted missions (their births are a pure
// function of the time, so it scrubs both ways), and `ShipPlume` emits live for the missions that cannot be rewound (it drives
// `liveFx.funnelSmoke` / `bowSpray`). Anchors are in the ship's frame: bow +X, +Y up (`ship.js`'s funnel top and stem).

export const FUNNEL_TOP = new THREE.Vector3(-13.5, 12.6, 0);
export const BOW = new THREE.Vector3(52, 0.4, 2.2); // the waterline just aft of the stem, to starboard (mirror z for port)
const WIND = [2.5, 0, 1.2];
const FUNNEL_RATE = 11; // puffs a second
const SPRAY_RATE = 15; // droplets a second per side at 14 knots

// One funnel puff: it leaves at the ship's velocity, rises (the exhaust is hot) and thins as it spreads.
export function funnelPuff(rng, shipVel, out) {
  randomUnit(rng, out).multiplyScalar(range(rng, 0.3, 1.1));
  out.y = Math.abs(out.y) + range(rng, 1.4, 3);
  out.x += shipVel.x;
  out.z += shipVel.z;
  return out;
}
// One droplet of bow spray: thrown outward and up from the stem, carried only partly by the ship (the water is left behind).
// Built in the ship's frame (bow +X), then turned to the world by the unit vector `fwd` the bow points along (x, z); the
// scripted ship always heads +X, so it passes (1, 0).
export function sprayDrop(rng, shipVel, side, k, out, fwd = FWD_X) {
  const kk = Math.min(k, 2.2);
  const lx = range(rng, 0.1, 0.6) * Math.hypot(shipVel.x, shipVel.z); // carried forward a little
  const lz = side * range(rng, 1.2, 4.2) * kk; // thrown out to the side
  out.set(fwd.x * lx - fwd.z * lz, range(rng, 2.2, 5.5) * kk, fwd.z * lx + fwd.x * lz);
  return out;
}
const FWD_X = { x: 1, z: 0 };
// Spray scales with the speed through the water and with how rough the sea is (`sea`, 1 = the original).
export const sprayK = (speed, sea = 1) => Math.min(2.6, Math.max(0.25, speed / SHIP_SPEED) * (0.65 + 0.35 * sea));

// --- scripted missions: everything baked at load ------------------------------------------------------------------------
export function createShipFx(scene, { tEnd, sea = 1 } = {}) {
  const rng = mulberry32(606);
  const group = new THREE.Group();
  scene.add(group);
  const n = (rate) => Math.ceil(rate * tEnd) + 8;
  const funnel = new ParticleField(n(FUNNEL_RATE), { mode: MODE.FUNNEL, drag: 0.6, rise: 1.3, size: [0.8, 9], wind: WIND });
  const k = sprayK(SHIP_SPEED, sea);
  const spray = new ParticleField(n(SPRAY_RATE * k * 2), { mode: MODE.SPLASH, drag: 0.4, gravity: G, size: [0.5, 1.8] });
  const vel = new THREE.Vector3(SHIP_SPEED, 0, 0);
  const p = new THREE.Vector3();
  const o = new THREE.Vector3();
  const v = new THREE.Vector3();
  const sp = new THREE.Vector3();
  for (let t = 0; t < tEnd; t += 1 / FUNNEL_RATE) {
    shipPos(t, sp);
    funnel.add(o.copy(FUNNEL_TOP).add(sp).add(p.set(range(rng, -0.6, 0.6), 0, range(rng, -0.6, 0.6))), funnelPuff(rng, vel, v), t, range(rng, 7, 11), rng());
  }
  for (let t = 0; t < tEnd; t += 1 / (SPRAY_RATE * k)) {
    shipPos(t, sp);
    for (const side of [-1, 1]) {
      spray.add(o.set(BOW.x + range(rng, -2, 1), BOW.y, side * BOW.z).add(sp), sprayDrop(rng, vel, side, k, v), t + range(rng, 0, 0.05), range(rng, 0.6, 1.5), rng());
    }
  }
  group.add(funnel.finalize(), spray.finalize());
  return { group, update(t) { funnel.setTime(t); spray.setTime(t); } };
}

// --- live missions: emitted as the ship moves -----------------------------------------------------------------------------
// `fx` is a liveFx; `ship` is a model group (its matrixWorld is current); `vel` its world velocity (m/s); `sea` the sea state.
export class ShipPlume {
  constructor(fx) {
    this.fx = fx;
    this.last = null;
    this.fAcc = 0;
    this.sAcc = 0;
    this.v = new THREE.Vector3();
    this.p = new THREE.Vector3();
    this.fwd = { x: 1, z: 0 };
  }

  update(t, ship, vel, sea = 1) {
    const dt = this.last === null ? 0 : t - this.last;
    this.last = t;
    if (!(dt > 0) || dt > 0.5) return; // the first frame, a restart or a long stall: nothing to catch up on
    const speed = Math.hypot(vel.x, vel.z);
    this.v.set(1, 0, 0).transformDirection(ship.matrixWorld); // where her bow points
    this.fwd.x = this.v.x;
    this.fwd.z = this.v.z;
    const k = sprayK(speed, sea);
    this.fAcc += dt * FUNNEL_RATE;
    this.sAcc += dt * SPRAY_RATE * k;
    while (this.fAcc >= 1) {
      this.fAcc -= 1;
      this.fx.funnelSmoke(ship.localToWorld(this.p.copy(FUNNEL_TOP)), vel, t - this.fAcc / FUNNEL_RATE);
    }
    while (this.sAcc >= 1) {
      this.sAcc -= 1;
      for (const side of [-1, 1]) {
        this.p.set(BOW.x, BOW.y, side * BOW.z);
        ship.localToWorld(this.p);
        this.p.y = Math.max(this.p.y, 0.3);
        this.fx.bowSpray(this.p, vel, side, k, t, this.fwd);
      }
    }
  }
}

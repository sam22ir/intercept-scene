import * as THREE from 'three';
import { mulberry32, randomUnit, range } from '../rng.js';
import { ParticleField, MODE } from './particles.js';
import { G, deckHeight } from '../scenario.js';

// Particle effects for the manual-flight mission, where nothing is known in advance. effects.js bakes
// every particle's birth at load; here the births are written as things happen, into ring buffers
// (the oldest particle is overwritten when a field is full), against the mission clock. The particles
// themselves are still closed-form in (uTime - birth) on the GPU, so they cost nothing per frame.

const NEVER = 1e9; // an unborn particle: its age is negative, so it is not drawn

class LiveField extends ParticleField {
  constructor(capacity, opts) {
    super(capacity, opts);
    this.next = 0;
    this.dirty = false;
    this.geometry.setDrawRange(0, capacity);
    this.clear();
  }

  clear() {
    this.geometry.attributes.aBirth.array.fill(NEVER);
    this.geometry.attributes.aLife.array.fill(1);
    this.next = 0;
    this.dirty = true;
  }

  push(origin, vel, birth, life, seed) {
    const i = this.next;
    this.next = (i + 1) % this.capacity;
    const a = this.geometry.attributes;
    a.position.setXYZ(i, origin.x, origin.y, origin.z);
    a.aVel.setXYZ(i, vel.x, vel.y, vel.z);
    a.aBirth.setX(i, birth);
    a.aLife.setX(i, life);
    a.aSeed.setX(i, seed);
    this.dirty = true;
  }

  flush() {
    if (!this.dirty) return;
    for (const attr of Object.values(this.geometry.attributes)) attr.needsUpdate = true;
    this.dirty = false;
  }
}

const WIND = [2.5, 0, 1.2];
const _v = new THREE.Vector3();
const _o = new THREE.Vector3();
const _p = new THREE.Vector3();
const deckY = deckHeight(-50); // helideck height: where the booster blast hits the plate

export function createLiveFx(scene) {
  const rng = mulberry32(2024);
  const group = new THREE.Group();
  scene.add(group);

  const trail = new LiveField(2800, { mode: MODE.SMOKE, drag: 0.8, rise: 0.5, size: [1.0, 9], wind: WIND });
  const launch = new LiveField(300, { mode: MODE.SMOKE, drag: 1.6, rise: 1.4, size: [1.2, 11], wind: WIND });
  const puff = new LiveField(1100, { mode: MODE.SMOKE, drag: 1.1, rise: 0.7, size: [0.5, 9], wind: WIND });
  const blast = new LiveField(320, { mode: MODE.SMOKE, drag: 1.4, rise: 1.0, size: [1.2, 7.5], wind: WIND });
  const exhaust = new LiveField(1600, { mode: MODE.SMOKE, drag: 1.0, rise: 0.2, size: [0.08, 0.7], wind: WIND });
  // The flying missile's own smoke: a dense white column (a puff every metre or so, spreading slowly and thinning over
  // about a quarter of a minute) with a short hot flame right behind the motor.
  const rocket = new LiveField(9000, { mode: MODE.SMOKE, drag: 0.5, rise: 0.35, size: [1.6, 15], wind: WIND });
  const flame = new LiveField(900, { mode: MODE.FIRE, drag: 3, rise: 0, size: [0.9, 2.0], wind: [0, 0, 0] });
  const fire = new LiveField(700, { mode: MODE.FIRE, drag: 2.4, rise: 2.5, size: [1.6, 9], wind: [1.5, 0, 0.8] });
  const burning = new LiveField(2600, { mode: MODE.BURNING, drag: 1.5, rise: 1.5, size: [0.8, 6], wind: WIND });
  const splash = new LiveField(1400, { mode: MODE.SPLASH, drag: 0.3, gravity: G, size: [1.2, 4] });
  const fields = [trail, rocket, flame, launch, puff, blast, exhaust, fire, burning, splash];
  for (const f of fields) group.add(f);

  // Foam rings on the water, a few at a time.
  const RINGS = 6;
  const rings = Array.from({ length: RINGS }, () => {
    const m = new THREE.Mesh(
      new THREE.RingGeometry(0.85, 1.0, 64),
      new THREE.MeshBasicMaterial({ color: 0xe8f4ff, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide }),
    );
    m.rotation.x = -Math.PI / 2;
    m.visible = false;
    group.add(m);
    return { mesh: m, t0: Infinity, big: 1 };
  });
  let nextRing = 0;

  // Blast flash and light.
  const glow = document.createElement('canvas');
  glow.width = glow.height = 128;
  const ctx = glow.getContext('2d');
  const grad = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,245,220,1)');
  grad.addColorStop(0.25, 'rgba(255,190,90,0.8)');
  grad.addColorStop(1, 'rgba(255,110,20,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 128, 128);
  const flash = new THREE.Sprite(new THREE.SpriteMaterial({
    map: new THREE.CanvasTexture(glow), blending: THREE.AdditiveBlending, depthWrite: false,
  }));
  flash.visible = false;
  const light = new THREE.PointLight(0xffa04a, 0, 900, 1.2);
  group.add(flash, light);
  let boomT = Infinity;

  // The falling wreck: burning smoke along each piece's fall, and a splash where it lands.
  let wreck = null;

  const api = {
    group,
    clear() {
      for (const f of fields) f.clear();
      for (const r of rings) { r.t0 = Infinity; r.mesh.visible = false; }
      boomT = Infinity;
      flash.visible = false;
      light.intensity = 0;
      wreck = null;
    },

    // The booster's plume, called every frame while it burns (`ramp` 0..1 is its thrust).
    boosterPlume(nozzle, fwd, vel, t, dt, ramp) {
      let n = dt / 0.012 * 3 * ramp;
      while (n > 0) {
        if (n < 1 && rng() > n) break;
        n--;
        randomUnit(rng, _v).multiplyScalar(range(rng, 1, 4)).addScaledVector(fwd, -range(rng, 12, 30)).addScaledVector(vel, 0.25);
        puff.push(nozzle, _v, t + range(rng, 0, dt), range(rng, 2.4, 5), rng());
      }
    },
    // Rail-level blast: smoke and steam swept back and out sideways along the deck plate.
    deckBlast(nozzle, fwd, t, dt) {
      let n = dt / 0.012 * 2;
      while (n > 0) {
        if (n < 1 && rng() > n) break;
        n--;
        _o.set(nozzle.x, deckY + 0.5, nozzle.z);
        randomUnit(rng, _v);
        _v.y = Math.abs(_v.y) * 0.4;
        _v.multiplyScalar(range(rng, 4, 14)).addScaledVector(fwd, -range(rng, 3, 9));
        _v.y = Math.abs(_v.y);
        blast.push(_o, _v, t + range(rng, 0, dt), range(rng, 2, 4.5), rng());
      }
    },
    // Faint two-stroke haze behind the drone, one wisp every `every` seconds.
    exhaust(pos, t) {
      exhaust.push(pos, randomUnit(rng, _v).multiplyScalar(0.4), t, range(rng, 0.4, 0.8), rng());
    },
    // The missile's smoke trail: one puff per call.
    missileTrail(pos, t) {
      trail.push(pos, randomUnit(rng, _v).multiplyScalar(1.2), t, range(rng, 8, 12), rng());
    },
    // The flying missile: one section of smoke column and a flame puff at the motor, per call. `dir` is the flight direction.
    missileSmoke(pos, dir, t) {
      randomUnit(rng, _v).multiplyScalar(range(rng, 0.3, 1.6)).addScaledVector(dir, -range(rng, 2, 6));
      rocket.push(pos, _v, t, range(rng, 13, 19), rng());
      _o.copy(pos).addScaledVector(dir, -0.8);
      randomUnit(rng, _v).multiplyScalar(0.8).addScaledVector(dir, -range(rng, 10, 24));
      flame.push(_o, _v, t, range(rng, 0.08, 0.18), rng());
    },
    // Backblast and boil-up round the tube mouth on the moving deck.
    launchBillow(pos, dir, t) {
      for (let i = 0; i < 240; i++) {
        randomUnit(rng, _v);
        _v.addScaledVector(_p.copy(dir).negate(), 1.6).normalize().multiplyScalar(range(rng, 4, 24));
        _v.y = Math.abs(_v.y) * 0.6;
        _v.x += 7; // carried along with the ship
        launch.push(pos, _v, t + range(rng, -0.05, 0.5), range(rng, 4, 9), rng());
      }
    },
    // The parachute pops out: a puff of smoke.
    chutePop(pos, t) {
      for (let i = 0; i < 44; i++) {
        randomUnit(rng, _v).multiplyScalar(range(rng, 1, 5));
        _v.y = Math.abs(_v.y) + 1;
        puff.push(_o.copy(pos).setY(pos.y + 0.5), _v, t + range(rng, 0, 0.25), range(rng, 1.2, 2.6), rng());
      }
    },
    // The warhead: a fireball, a flash and a flash of light.
    explosion(pos, t) {
      for (let i = 0; i < 520; i++) {
        randomUnit(rng, _v).multiplyScalar(range(rng, 8, 42));
        _o.copy(pos).addScaledVector(randomUnit(rng, _p), range(rng, 0, 1.2));
        fire.push(_o, _v, t + range(rng, 0, 0.25) ** 2, range(rng, 2.5, 7), rng());
      }
      flash.position.copy(pos);
      light.position.copy(pos);
      boomT = t;
    },
    // Spray, a foam ring and a shower of droplets on the water. `size` scales them (1 = a drone under canopy).
    splashAt(pos, t, size = 1) {
      _o.set(pos.x, 0.2, pos.z);
      const n = Math.round(170 * size);
      for (let i = 0; i < n; i++) {
        const a = rng() * Math.PI * 2;
        const r = range(rng, 0.8, 4.2) * size;
        _v.set(Math.cos(a) * r, range(rng, 4, 11) * (0.6 + 0.4 * size), Math.sin(a) * r);
        splash.push(_o, _v, t + range(rng, 0, 0.18), range(rng, 1.2, 2.6), rng());
      }
      const ring = rings[nextRing];
      nextRing = (nextRing + 1) % RINGS;
      ring.t0 = t;
      ring.big = size;
      ring.mesh.position.set(pos.x, 0.22, pos.z);
    },
    // The wreck falling after a hit or a crash: `debris` is a createDebris() result for this drone.
    startWreck(debris, t0) {
      wreck = {
        debris, t0, landed: debris.pieces.map(() => false),
        lastTau: debris.pieces.map(() => 0), burn: debris.pieces.map((pc) => (pc.part.name === 'fuselage' ? 0.03 : 0.08)),
      };
    },

    update(t) {
      for (const f of fields) f.setTime(t);
      // Burning smoke along the falling pieces, and a splash as each lands.
      if (wreck) {
        const { debris } = wreck;
        const tau = t - wreck.t0;
        debris.pieces.forEach((pc, i) => {
          const heavy = pc.part.name === 'fuselage';
          const upto = Math.min(tau, pc.tauWater);
          for (let s = wreck.lastTau[i]; s < upto; s += wreck.burn[i]) {
            debris.piecePos(pc, s, _o);
            burning.push(_o, randomUnit(rng, _v).multiplyScalar(1.5), wreck.t0 + s, range(rng, heavy ? 4 : 2, heavy ? 7 : 4), rng());
            wreck.lastTau[i] = s + wreck.burn[i];
          }
          if (!wreck.landed[i] && tau >= pc.tauWater) {
            wreck.landed[i] = true;
            debris.piecePos(pc, pc.tauWater, _o);
            _o.y = 0.2;
            const n = heavy ? 180 : 70;
            for (let k = 0; k < n; k++) {
              const a = rng() * Math.PI * 2;
              const r = range(rng, 1, heavy ? 7 : 4);
              _v.set(Math.cos(a) * r, range(rng, heavy ? 10 : 6, heavy ? 26 : 15), Math.sin(a) * r);
              splash.push(_o, _v, wreck.t0 + pc.tauWater + range(rng, 0, 0.15), range(rng, 1.6, 3.2), rng());
            }
            if (heavy) {
              const ring = rings[nextRing];
              nextRing = (nextRing + 1) % RINGS;
              ring.t0 = wreck.t0 + pc.tauWater;
              ring.big = 1.4;
              ring.mesh.position.set(_o.x, 0.22, _o.z);
            }
          }
        });
      }
      for (const f of fields) f.flush();
      // Flash and light of the warhead.
      const tau = t - boomT;
      const on = tau >= 0 && tau < 0.35;
      flash.visible = on;
      if (on) {
        flash.scale.setScalar(6 + 34 * Math.min(tau / 0.08, 1));
        flash.material.opacity = 0.85 * (1 - THREE.MathUtils.smoothstep(tau, 0.03, 0.35));
      }
      light.intensity = tau >= 0 ? 1.5e5 * Math.exp(-tau * 3) : 0;
      for (const r of rings) {
        const ta = t - r.t0;
        r.mesh.visible = ta >= 0 && ta < 6;
        if (r.mesh.visible) {
          r.mesh.scale.setScalar((1 + 6.5 * ta) * r.big);
          r.mesh.material.opacity = 0.6 * (1 - ta / 6) ** 2;
        }
      }
    },
  };
  return api;
}

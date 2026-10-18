import * as THREE from 'three';
import { mulberry32, randomUnit, range } from '../rng.js';
import { ParticleField, MODE } from './particles.js';
import {
  scenario, planePose, planePos, planeVel, propAngle, missileTrailPoints, shipPos, deckHeight, G,
} from '../scenario.js';

const _v = new THREE.Vector3();
const _o = new THREE.Vector3();
const deckY = deckHeight(-50); // helideck height: where the booster blast hits the plate

// ---------------------------------------------------------------------------
// Debris: on impact the plane's parts fly apart under gravity with linear air
// drag, which has a closed form, then sink. Each piece is a pure function of
// tau = t - tHit.
// ---------------------------------------------------------------------------
// `hit` (the manual-flight mission, where nothing is scripted): { pos, quat, vel, burstPos, burstDist, prop }
// gives the drone's state at the moment of impact in place of the scenario's own engagement.
export function createDebris(plane, k = 0, hit = null) {
  const rng = mulberry32(1337 + k);
  const { tHit, hitPos: burstPos, burstDist } = hit
    ? { tHit: 0, hitPos: hit.burstPos, burstDist: hit.burstDist }
    : scenario.engagements[k]; // k > 0 is the second drone (pair mode)
  const hitPos = new THREE.Vector3();
  const hitQuat = new THREE.Quaternion();
  let vPlane;
  if (hit) {
    hitPos.copy(hit.pos);
    hitQuat.copy(hit.quat);
    vPlane = hit.vel.clone();
  } else {
    planePose(tHit, hitPos, hitQuat, k);
    vPlane = planeVel(tHit, new THREE.Vector3(), k);
  }
  const planeM = new THREE.Matrix4().compose(hitPos, hitQuat, new THREE.Vector3(1, 1, 1));

  plane.restoreParts();
  plane.setProp(hit ? hit.prop : propAngle(tHit, k), 1);
  const pieces = plane.parts.map((part) => {
    part.updateMatrix();
    const world = planeM.clone().multiply(part.matrix);
    const p0 = new THREE.Vector3();
    const q0 = new THREE.Quaternion();
    world.decompose(p0, q0, new THREE.Vector3());
    const heavy = part.name === 'fuselage';
    const v0 = vPlane.clone().multiplyScalar(heavy ? 0.3 : range(rng, 0.15, 0.35))
      .addScaledVector(randomUnit(rng, _v), heavy ? range(rng, 3, 6) : range(rng, 8, 18));
    v0.y += range(rng, 3, 10);
    if (burstDist > 0.5) {
      // The warhead went off beside the drone, not in it: the shock throws each part
      // away from the burst point, harder the closer that part was to it.
      const away = p0.clone().sub(burstPos);
      const d = away.length();
      if (d > 0.01) v0.addScaledVector(away.divideScalar(d), (heavy ? 14 : 30) * (8 / (8 + d)));
    }
    const piece = {
      part,
      p0,
      q0,
      v0,
      k: part.userData.drag ?? 0.3,
      axis: randomUnit(rng, new THREE.Vector3()),
      spin: heavy ? range(rng, 0.8, 1.6) : range(rng, 2.5, 7),
      tauWater: 0,
    };
    // Time to reach the sea surface (y is monotonic once falling; bisection is enough).
    let lo = 0;
    let hi = 120;
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2;
      if (pieceY(piece, mid) > 0) lo = mid; else hi = mid;
    }
    piece.tauWater = hi;
    return piece;
  });
  plane.restoreParts();

  function pieceY(pc, tau) {
    const e = (1 - Math.exp(-pc.k * tau)) / pc.k;
    return pc.p0.y + (pc.v0.y + G / pc.k) * e - (G / pc.k) * tau;
  }

  function piecePos(pc, tau, out) {
    const tt = Math.min(tau, pc.tauWater);
    const e = (1 - Math.exp(-pc.k * tt)) / pc.k;
    out.set(pc.p0.x + pc.v0.x * e, pieceY(pc, tt), pc.p0.z + pc.v0.z * e);
    if (tau > pc.tauWater) out.y = -1.2 * (tau - pc.tauWater); // sinking
    return out;
  }

  const _q = new THREE.Quaternion();
  const fuselage = pieces.find((p) => p.part.name === 'fuselage');

  return {
    pieces,
    fallTime: Math.max(...pieces.map((p) => p.tauWater)),
    // Leaves the plane group at the origin and poses each part in world space.
    apply(tau) {
      plane.group.position.set(0, 0, 0);
      plane.group.quaternion.identity();
      for (const pc of pieces) {
        piecePos(pc, tau, pc.part.position);
        _q.setFromAxisAngle(pc.axis, pc.spin * Math.min(tau, pc.tauWater));
        pc.part.quaternion.copy(pc.q0).premultiply(_q);
        pc.part.visible = tau < pc.tauWater + 5;
      }
    },
    fuselagePos(tau, out) {
      return piecePos(fuselage, tau, out);
    },
    piecePos,
  };
}

// ---------------------------------------------------------------------------
// Particle effects: missile trail, launch billow, fireball, burning debris
// smoke and splashes. All births are baked at load.
// ---------------------------------------------------------------------------
export function createEffects(scene, debris, k = 0) {
  const rng = mulberry32(42 + k * 1000);
  const { hasMissile } = scenario;
  // The engagement (missile + hit) and the drone this field of effects belongs to.
  // k = 1 is the second drone in pair mode; k = 0 reads the scenario's own first-engagement fields.
  const eng = k ? scenario.engagements[k] : scenario;
  const { tLaunch, tHit, hitPos, missileStart, launchDir } = eng;
  const drone = scenario.drones[k];
  // Recovery has no missile and no hit: the drone's flight ends under canopy.
  const tFlightEnd = hasMissile ? tHit : scenario.tChute;
  const group = new THREE.Group();
  scene.add(group);

  const trail = new ParticleField(1400, {
    mode: MODE.SMOKE, drag: 0.8, rise: 0.5, size: [1.0, 9], wind: [2.5, 0, 1.2],
  });
  for (const { t, pos } of hasMissile ? missileTrailPoints(2, k) : []) {
    trail.add(pos, randomUnit(rng, _v).multiplyScalar(1.2), t, range(rng, 8, 12), rng());
  }
  group.add(trail.finalize());

  // Launch: backblast and boil-up around the tube mouth on the moving deck.
  const launch = new ParticleField(240, {
    mode: MODE.SMOKE, drag: 1.6, rise: 1.4, size: [1.2, 11], wind: [2.5, 0, 1.2],
  });
  const back = launchDir.clone().negate();
  for (let i = 0; i < (hasMissile ? 240 : 0); i++) {
    randomUnit(rng, _v);
    _v.addScaledVector(back, 1.6).normalize().multiplyScalar(range(rng, 4, 24));
    _v.y = Math.abs(_v.y) * 0.6;
    _v.x += 7; // carried along with the ship
    launch.add(missileStart, _v, tLaunch + range(rng, -0.05, 0.5), range(rng, 4, 9), rng());
  }
  group.add(launch.finalize());

  // Booster rocket: a thick white plume streaming from under the drone's tail
  // for the whole burn, and a blast of smoke and steam swept across the deck
  // plate while the drone is still on the rail.
  const { tRelease, tBoost0, tBoost1 } = drone;
  const puff = new ParticleField(700, {
    mode: MODE.SMOKE, drag: 1.1, rise: 0.7, size: [0.5, 9], wind: [2.5, 0, 1.2],
  });
  const blast = new ParticleField(260, {
    mode: MODE.SMOKE, drag: 1.4, rise: 1.0, size: [1.2, 7.5], wind: [2.5, 0, 1.2],
  });
  {
    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    const fwd = new THREE.Vector3();
    const vel = new THREE.Vector3();
    const nozzle = new THREE.Vector3();
    for (let t = tBoost0; t < tBoost1; t += 0.012) {
      planePose(t, pos, quat, k);
      planeVel(t, vel, k);
      fwd.set(0, 0, 1).applyQuaternion(quat);
      nozzle.set(0, -0.3, -1.7).applyQuaternion(quat).add(pos);
      const ramp = Math.min(1, (t - tBoost0) / 0.15) * Math.min(1, (tBoost1 - t) / 0.5);
      for (let k = 0; k < 3; k++) {
        if (rng() > ramp) continue;
        randomUnit(rng, _v).multiplyScalar(range(rng, 1, 4)).addScaledVector(fwd, -range(rng, 12, 30)).addScaledVector(vel, 0.25);
        puff.add(nozzle, _v, t, range(rng, 2.4, 5), rng());
      }
      if (t < tRelease + 0.3) {
        // Rail-level blast: sweeps backwards and out sideways along the plate.
        _o.set(nozzle.x, deckY + 0.5, nozzle.z);
        for (let k = 0; k < 2; k++) {
          randomUnit(rng, _v);
          _v.y = Math.abs(_v.y) * 0.4;
          _v.multiplyScalar(range(rng, 4, 14)).addScaledVector(fwd, -range(rng, 3, 9));
          _v.y = Math.abs(_v.y);
          blast.add(_o, _v, t, range(rng, 2, 4.5), rng());
        }
      }
    }
  }
  group.add(puff.finalize(), blast.finalize());

  // Faint two-stroke exhaust haze behind the drone.
  const exhaust = new ParticleField(1400, {
    mode: MODE.SMOKE, drag: 1.0, rise: 0.2, size: [0.08, 0.7], wind: [2.5, 0, 1.2],
  });
  for (let t = tRelease; t < tFlightEnd; t += 0.06) {
    planePos(t, _o, k);
    exhaust.add(_o, randomUnit(rng, _v).multiplyScalar(0.4), t, range(rng, 0.4, 0.8), rng());
  }
  group.add(exhaust.finalize());

  const fire = new ParticleField(520, {
    mode: MODE.FIRE, drag: 2.4, rise: 2.5, size: [1.6, 9], wind: [1.5, 0, 0.8],
  });
  for (let i = 0; i < (hasMissile ? 520 : 0); i++) {
    randomUnit(rng, _v).multiplyScalar(range(rng, 8, 42));
    _o.copy(hitPos).addScaledVector(randomUnit(rng, new THREE.Vector3()), range(rng, 0, 1.2));
    fire.add(_o, _v, tHit + range(rng, 0, 0.25) ** 2, range(rng, 2.5, 7), rng());
  }
  group.add(fire.finalize());

  const burning = new ParticleField(2400, {
    mode: MODE.BURNING, drag: 1.5, rise: 1.5, size: [0.8, 6], wind: [2.5, 0, 1.2],
  });
  const splash = new ParticleField(600, {
    mode: MODE.SPLASH, drag: 0.3, gravity: G, size: [1.2, 4],
  });
  for (const pc of debris?.pieces ?? []) {
    const heavy = pc.part.name === 'fuselage';
    const step = heavy ? 0.03 : 0.08;
    for (let tau = 0; tau < pc.tauWater; tau += step) {
      debris.piecePos(pc, tau, _o);
      burning.add(_o, randomUnit(rng, _v).multiplyScalar(1.5), tHit + tau, range(rng, heavy ? 4 : 2, heavy ? 7 : 4), rng());
    }
    debris.piecePos(pc, pc.tauWater, _o);
    _o.y = 0.2;
    const n = heavy ? 180 : 70;
    for (let i = 0; i < n; i++) {
      const a = rng() * Math.PI * 2;
      const r = range(rng, 1, heavy ? 7 : 4);
      _v.set(Math.cos(a) * r, range(rng, heavy ? 10 : 6, heavy ? 26 : 15), Math.sin(a) * r);
      splash.add(_o, _v, tHit + pc.tauWater + range(rng, 0, 0.15), range(rng, 1.6, 3.2), rng());
    }
  }
  group.add(burning.finalize(), splash.finalize());

  // Blast flash and light.
  // Recovery: a puff as the parachute pops out, then at splashdown a ring of
  // spray, a rippling foam ring and a shower of droplets.
  let ring = null;
  const ringT = hasMissile ? Infinity : scenario.tSplash;
  const ringPos = new THREE.Vector3();
  if (!hasMissile) {
    const { tChute, tSplash } = scenario;
    const pop = new THREE.Vector3();
    planePos(tChute, pop);
    for (let i = 0; i < 44; i++) {
      randomUnit(rng, _v).multiplyScalar(range(rng, 1, 5));
      _v.y = Math.abs(_v.y) + 1;
      puff.add(_o.copy(pop).add(_v.set(0, 0.5, 0)), _v, tChute + range(rng, 0, 0.25), range(rng, 1.2, 2.6), rng());
    }
    planePos(tSplash, ringPos);
    ringPos.y = 0.22;
    for (let i = 0; i < 170; i++) {
      const a = rng() * Math.PI * 2;
      const r = range(rng, 0.8, 4.2);
      _v.set(Math.cos(a) * r, range(rng, 4, 11), Math.sin(a) * r);
      splash.add(_o.copy(ringPos), _v, tSplash + range(rng, 0, 0.18), range(rng, 1.2, 2.6), rng());
    }
    ring = new THREE.Mesh(
      new THREE.RingGeometry(0.85, 1.0, 64),
      new THREE.MeshBasicMaterial({ color: 0xe8f4ff, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.copy(ringPos);
    ring.visible = false;
    group.add(ring);
    puff.finalize(); // refresh draw ranges after the late additions
    splash.finalize();
  }

  const glowCanvas = document.createElement('canvas');
  glowCanvas.width = glowCanvas.height = 128;
  const ctx = glowCanvas.getContext('2d');
  const grad = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,245,220,1)');
  grad.addColorStop(0.25, 'rgba(255,190,90,0.8)');
  grad.addColorStop(1, 'rgba(255,110,20,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 128, 128);
  const flash = new THREE.Sprite(new THREE.SpriteMaterial({
    map: new THREE.CanvasTexture(glowCanvas), blending: THREE.AdditiveBlending, depthWrite: false,
  }));
  flash.position.copy(hitPos);
  const light = new THREE.PointLight(0xffa04a, 0, 900, 1.2);
  light.position.copy(hitPos);
  group.add(flash, light);

  const fields = [trail, launch, puff, blast, exhaust, fire, burning, splash];
  return {
    update(t) {
      for (const f of fields) f.setTime(t);
      const tau = t - tHit;
      const on = tau >= 0 && tau < 0.35;
      flash.visible = on;
      if (on) {
        flash.scale.setScalar(6 + 34 * Math.min(tau / 0.08, 1));
        flash.material.opacity = 0.85 * (1 - THREE.MathUtils.smoothstep(tau, 0.03, 0.35));
      }
      light.intensity = tau >= 0 ? 1.5e5 * Math.exp(-tau * 3) : 0;
      if (ring) {
        const ta = t - ringT;
        ring.visible = ta >= 0 && ta < 6;
        if (ring.visible) {
          ring.scale.setScalar(1 + 6.5 * ta);
          ring.material.opacity = 0.6 * (1 - ta / 6) ** 2;
        }
      }
    },
  };
}

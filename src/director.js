import * as THREE from 'three';
import {
  scenario, planeRelPos, shipPos, missilePos, tubeMouth, RAIL, LAUNCHER_PIVOT,
} from './scenario.js';

// Cinematic camera. Every shot places the camera and its look-at point as a pure
// function of the sim time `t` (no state), so cuts land on the same frames when
// scrubbing or playing backwards. The shot list comes from the scenario's own
// event times, so custom paths and the recovery mission get a sensible cut too.
//
// `dronePos(t, out)` must resolve to a world position at any t: the drone in
// flight, then its falling wreck (supplied by main.js). `tWater` is when the
// wreck reaches the sea.

const UP = new THREE.Vector3(0, 1, 0);
const MIN_SHOT = 0.6; // a shot shorter than this gives way to the next one
const { smoothstep, lerp, clamp } = THREE.MathUtils;

export function createDirector({ dronePos, tWater }) {
  const A = new THREE.Vector3();
  const B = new THREE.Vector3();
  const H = new THREE.Vector3();
  const S = new THREE.Vector3();
  const mix = new THREE.Vector3();

  // Horizontal unit heading of the drone around time t.
  function heading(t, out) {
    dronePos(Math.max(0, t - 0.1), A);
    dronePos(t + 0.1, B);
    out.subVectors(B, A).setY(0);
    return out.lengthSq() < 1e-6 ? out.set(1, 0, 0) : out.normalize();
  }

  // --- Shot factories: each returns { id, label, shadowR, shake, fn(t, cam, look) } ---

  const tR = scenario.tRelease;

  // Beside the catapult rail, inboard of it so the blast plume goes past, pushing in.
  const railH = new THREE.Vector3(RAIL.dir.x, 0, RAIL.dir.z).normalize();
  const railSide = new THREE.Vector3(-railH.z, 0, railH.x); // toward the centre line
  const catapultCam = RAIL.start.clone().addScaledVector(RAIL.dir, 4)
    .addScaledVector(railSide, 9).addScaledVector(railH, -1.5).add(new THREE.Vector3(0, 2.4, 0));
  const catapult = {
    id: 'catapult', label: 'Catapult', shadowR: 20, shake: 0.05,
    fn(t, cam, look) {
      shipPos(t, cam).add(catapultCam).addScaledVector(railSide, -1.2 * smoothstep(t, 0, tR));
      dronePos(t, look);
    },
  };

  // Trails the drone's own path a moment behind, off to one side: smooth by construction.
  const chase = (id, label, { lag, height, side }) => ({
    id, label, shadowR: 25, shake: 0.08,
    fn(t, cam, look) {
      const tc = Math.max(0, t - lag);
      heading(tc, H);
      S.crossVectors(UP, H).multiplyScalar(side);
      dronePos(tc, cam).add(S).addScaledVector(UP, height);
      dronePos(t, look);
    },
  });

  // Fixed beside the water, in the ship's frame, as the drone sweeps past.
  function lowPass(tc) {
    const rel = planeRelPos(tc, new THREE.Vector3());
    const out = rel.z < 0 ? -1 : 1;
    const camRel = new THREE.Vector3(rel.x - 12, 2.2, rel.z + out * 15);
    return {
      id: 'lowpass', label: 'Close pass', shadowR: 40, shake: 0.04,
      fn(t, cam, look) {
        shipPos(t, cam).add(camRel);
        dronePos(t, look);
      },
    };
  }

  // Beside the launcher, from the starboard side, then swinging after the missile.
  const launchSide = LAUNCHER_PIVOT.z >= 0 ? 1 : -1;
  const launcherCam = LAUNCHER_PIVOT.clone().add(new THREE.Vector3(3, 2.5, 13 * launchSide));
  const launcher = {
    id: 'launcher', label: 'Launch', shadowR: 25, shake: 0.06,
    fn(t, cam, look) {
      shipPos(t, cam).add(launcherCam);
      tubeMouth(t, look);
      missilePos(t + 0.05, mix);
      look.lerp(mix, smoothstep(t, scenario.tLaunch, scenario.tLaunch + 0.4));
    },
  };

  // A few metres behind and beside the missile, looking past it at the drone.
  const missileRide = {
    id: 'missile', label: 'Missile cam', shadowR: 25, shake: 0.25,
    fn(t, cam, look) {
      missilePos(t - 0.12, cam);
      missilePos(t + 0.02, A);
      missilePos(t - 0.02, B);
      H.subVectors(A, B).normalize();
      S.crossVectors(H, UP).normalize();
      cam.addScaledVector(S, 3).addScaledVector(UP, 1.8);
      dronePos(t, look);
    },
  };

  // Wide and low-ish on the side of the impact, easing in; follows the wreck down.
  function wide() {
    const hit = scenario.hitPos;
    const app = new THREE.Vector3().subVectors(hit, scenario.missileStart).setY(0).normalize();
    const perp = new THREE.Vector3(-app.z, 0, app.x);
    const hitLook = hit.clone().add(new THREE.Vector3(0, 6, 0));
    return {
      id: 'wide', label: 'Impact', shadowR: 75, shake: 0.12,
      fn(t, cam, look) {
        const k = clamp((t - scenario.tHit) / 8, 0, 1);
        cam.copy(hit).addScaledVector(perp, lerp(125, 90, k)).addScaledVector(app, -25)
          .addScaledVector(UP, lerp(28, 16, k));
        dronePos(t, mix);
        mix.y = Math.max(mix.y, 1);
        look.lerpVectors(hitLook, mix, smoothstep(t - scenario.tHit, 0.8, 4));
      },
    };
  }

  // Low beside the point where the drone reaches the water, fixed in the world.
  function splash(tw) {
    const base = dronePos(tw, new THREE.Vector3()).setY(0);
    const camPos = base.clone().add(new THREE.Vector3(-28, 2.6, 26));
    return {
      id: 'splash', label: 'Splash', shadowR: 40, shake: 0.03,
      fn(t, cam, look) {
        cam.copy(camPos);
        dronePos(t, look);
        look.y = Math.max(look.y, 0.6);
      },
    };
  }

  // Slow orbit around the drone under its canopy.
  const canopy = {
    id: 'canopy', label: 'Parachute', shadowR: 40, shake: 0.05,
    fn(t, cam, look) {
      const a = t * 0.18;
      dronePos(t, look).y += 3;
      cam.copy(look).add(mix.set(Math.cos(a) * 55, 8, Math.sin(a) * 55));
    },
  };

  // --- Shot list from the scenario's own times ---------------------------------

  const cuts = [{ t: 0, shot: catapult }, { t: tR + 0.7, shot: chase('chase', 'Chase cam', { lag: 0.3, height: 2.2, side: 4.5 }) }];
  // The pass only gets its shots if they end before the story cuts that follow.
  const nextStory = scenario.hasMissile ? scenario.tLaunch - 3 : scenario.tChute - 0.3;
  const pass = scenario.events.find((e) => e.label === 'Close pass' && e.t > tR + 4 && e.t + 3.5 < nextStory - MIN_SHOT);
  if (pass) {
    cuts.push({ t: pass.t - 2.5, shot: lowPass(pass.t) });
    cuts.push({ t: pass.t + 3.5, shot: chase('chase2', 'Chase cam', { lag: 0.4, height: 3.5, side: -6 }) });
  }
  if (scenario.hasMissile) {
    cuts.push({ t: scenario.tLaunch - 3, shot: launcher });
    cuts.push({ t: scenario.tLaunch + 0.4, shot: missileRide });
    cuts.push({ t: scenario.tHit - 0.3, shot: wide() });
    if (tWater > scenario.tHit + 4) cuts.push({ t: tWater - 2.5, shot: splash(tWater) });
  } else {
    cuts.push({ t: scenario.tChute - 0.3, shot: canopy });
    cuts.push({ t: scenario.tSplash - 3, shot: splash(scenario.tSplash) });
  }

  const shots = [];
  for (const cut of cuts.sort((a, b) => a.t - b.t)) {
    if (cut.t >= scenario.tEnd - MIN_SHOT) continue;
    while (shots.length && cut.t - shots[shots.length - 1].t < MIN_SHOT) shots.pop();
    shots.push(cut);
  }
  shots[0].t = 0;

  function shotAt(t) {
    let shot = shots[0];
    for (const s of shots) if (t >= s.t) shot = s; else break;
    return shot.shot;
  }

  return {
    shots,
    shotAt,
    // Place the camera for time t; returns the shot in use.
    pose(t, cam, look) {
      const shot = shotAt(t);
      shot.fn(t, cam, look);
      if (shot.shake) {
        const s = shot.shake;
        cam.x += s * Math.sin(t * 7.3);
        cam.y += s * Math.sin(t * 5.1 + 1.3);
        cam.z += s * Math.sin(t * 6.2 + 2.1);
      }
      return shot;
    },
  };
}

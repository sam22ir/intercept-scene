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
// wreck reaches the sea. In the pair mission `second` gives the same for drone 2
// ({ dronePos, tWater }), and the shot list adds its launch and engagement.

const UP = new THREE.Vector3(0, 1, 0);
const MIN_SHOT = 0.6; // a shot shorter than this gives way to the next one
const { smoothstep, lerp, clamp } = THREE.MathUtils;

export function createDirector({ dronePos, tWater, second = null }) {
  const dronePosOf = [dronePos, second?.dronePos];
  const A = new THREE.Vector3();
  const B = new THREE.Vector3();
  const H = new THREE.Vector3();
  const S = new THREE.Vector3();
  const mix = new THREE.Vector3();

  // Horizontal unit heading of the drone around time t.
  function heading(t, out, k = 0) {
    dronePosOf[k](Math.max(0, t - 0.1), A);
    dronePosOf[k](t + 0.1, B);
    out.subVectors(B, A).setY(0);
    return out.lengthSq() < 1e-6 ? out.set(1, 0, 0) : out.normalize();
  }

  // --- Shot factories: each returns { id, label, shadowR, shake, fn(t, cam, look) } ---

  const tR = scenario.tRelease;

  // Beside the catapult rail, inboard of it so the blast plume goes past, pushing in.
  const railH = new THREE.Vector3(RAIL.dir.x, 0, RAIL.dir.z).normalize();
  const railSide = new THREE.Vector3(-railH.z, 0, railH.x); // toward the centre line
  const catapultCam = RAIL.start.clone().addScaledVector(RAIL.dir, RAIL.length * 0.5)
    .addScaledVector(railSide, 7.5).addScaledVector(railH, -1.2).add(new THREE.Vector3(0, 2.2, 0)); // mid-rail, the whole launcher in frame
  const catapult = (k = 0) => {
    const d = scenario.drones?.[k] ?? { tSpool: 0, tRelease: tR };
    const t0 = k ? d.tSpool - 1 : 0;
    return {
      id: k ? 'catapult2' : 'catapult', label: k ? 'Catapult · drone 2' : 'Catapult', shadowR: 20, shake: 0.05,
      fn(t, cam, look) {
        shipPos(t, cam).add(catapultCam).addScaledVector(railSide, -1.2 * smoothstep(t, t0, d.tRelease));
        dronePosOf[k](t, look);
      },
    };
  };

  // Trails the drone's own path a moment behind, off to one side: smooth by construction.
  const chase = (id, label, { lag, height, side }, k = 0) => ({
    id, label, shadowR: 25, shake: 0.08,
    fn(t, cam, look) {
      const tc = Math.max(0, t - lag);
      heading(tc, H, k);
      S.crossVectors(UP, H).multiplyScalar(side);
      dronePosOf[k](tc, cam).add(S).addScaledVector(UP, height);
      dronePosOf[k](t, look);
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
  const engagement = (k) => scenario.engagements?.[k] ?? scenario;
  const launcher = (k = 0) => {
    const e = engagement(k);
    return {
      id: k ? 'launcher2' : 'launcher', label: k ? 'Launch · missile 2' : 'Launch', shadowR: 25, shake: 0.06,
      fn(t, cam, look) {
        shipPos(t, cam).add(launcherCam);
        tubeMouth(t, look, k);
        missilePos(t + 0.05, mix, k);
        look.lerp(mix, smoothstep(t, e.tLaunch, e.tLaunch + 0.4));
      },
    };
  };

  // A few metres behind and beside the missile, looking past it at the drone.
  const missileRide = (k = 0) => ({
    id: k ? 'missile2' : 'missile', label: k ? 'Missile cam · 2' : 'Missile cam', shadowR: 25, shake: 0.25,
    fn(t, cam, look) {
      missilePos(t - 0.12, cam, k);
      missilePos(t + 0.02, A, k);
      missilePos(t - 0.02, B, k);
      H.subVectors(A, B).normalize();
      S.crossVectors(H, UP).normalize();
      cam.addScaledVector(S, 3).addScaledVector(UP, 1.8);
      dronePosOf[k](t, look);
    },
  });

  // Wide and low-ish on the side of the impact, easing in; follows the wreck down.
  function wide(k = 0) {
    const e = engagement(k);
    const hit = e.hitPos;
    const app = new THREE.Vector3().subVectors(hit, e.missileStart).setY(0).normalize();
    const perp = new THREE.Vector3(-app.z, 0, app.x);
    const hitLook = hit.clone().add(new THREE.Vector3(0, 6, 0));
    return {
      id: k ? 'wide2' : 'wide', label: k ? 'Impact · 2' : 'Impact', shadowR: 75, shake: 0.12,
      fn(t, cam, look) {
        const w = clamp((t - e.tHit) / 8, 0, 1);
        cam.copy(hit).addScaledVector(perp, lerp(125, 90, w)).addScaledVector(app, -25)
          .addScaledVector(UP, lerp(28, 16, w));
        dronePosOf[k](t, mix);
        mix.y = Math.max(mix.y, 1);
        look.lerpVectors(hitLook, mix, smoothstep(t - e.tHit, 0.8, 4));
      },
    };
  }

  // Low beside the point where the drone reaches the water, fixed in the world.
  function splash(tw, k = 0) {
    const base = dronePosOf[k](tw, new THREE.Vector3()).setY(0);
    const camPos = base.clone().add(new THREE.Vector3(-28, 2.6, 26));
    return {
      id: k ? 'splash2' : 'splash', label: k ? 'Splash · 2' : 'Splash', shadowR: 40, shake: 0.03,
      fn(t, cam, look) {
        cam.copy(camPos);
        dronePosOf[k](t, look);
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

  const cuts = [{ t: 0, shot: catapult() }, { t: tR + 0.7, shot: chase('chase', 'Chase cam', { lag: 0.3, height: 2.2, side: 4.5 }) }];
  // The pass only gets its shots if they end before the story cuts that follow.
  const nextStory = scenario.hasMissile ? scenario.tLaunch - 3 : scenario.tChute - 0.3;
  const pass = scenario.events.find((e) => e.label === 'Close pass' && e.t > tR + 4 && e.t + 3.5 < nextStory - MIN_SHOT);
  if (pass) {
    cuts.push({ t: pass.t - 2.5, shot: lowPass(pass.t) });
    cuts.push({ t: pass.t + 3.5, shot: chase('chase2', 'Chase cam', { lag: 0.4, height: 3.5, side: -6 }) });
  }
  if (second) {
    // Drone 2 off the rail, a short chase, then back to drone 1's story.
    const d2 = scenario.drones[1];
    cuts.push({ t: d2.tSpool - 1, shot: catapult(1) });
    cuts.push({ t: d2.tRelease + 0.7, shot: chase('chase-d2', 'Chase cam · drone 2', { lag: 0.3, height: 2.2, side: -4.5 }, 1) });
    if (!pass || pass.t - 2.5 > d2.tRelease + 6) {
      cuts.push({ t: d2.tRelease + 6, shot: chase('chase-back', 'Chase cam', { lag: 0.4, height: 3.5, side: -6 }) });
    }
  }
  if (scenario.hasMissile) {
    const engs = second ? scenario.engagements : [scenario];
    const waters = [tWater, second?.tWater];
    engs.forEach((e, k) => {
      cuts.push({ t: e.tLaunch - 3, shot: launcher(k) });
      cuts.push({ t: e.tLaunch + 0.4, shot: missileRide(k) });
      cuts.push({ t: e.tHit - 0.3, shot: wide(k) });
      const tw = waters[k];
      if (tw > e.tHit + 4) cuts.push({ t: tw - 2.5, shot: splash(tw, k) });
      // Between the first splash and the second launch, ride along with drone 2.
      if (k === 0 && engs[1]) {
        const tFree = Math.max(e.tHit + 6, tw > e.tHit + 4 ? tw + 2 : 0);
        if (tFree < engs[1].tLaunch - 3 - 2) {
          cuts.push({ t: tFree, shot: chase('chase-d2b', 'Chase cam · drone 2', { lag: 0.4, height: 3.5, side: 6 }, 1) });
        }
      }
    });
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

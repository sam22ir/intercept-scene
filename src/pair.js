import * as THREE from 'three';
import {
  scenario, planePose, planePos, planeVel, propAngle, propSpin01, missilePose, shipPos,
} from './scenario.js';
import { createPlane } from './models/plane.js';
import { createMissile } from './models/missile.js';
import { createDebris, createEffects } from './fx/effects.js';

// Pair mission ("Two drones"): everything that belongs to the second drone and its
// missile. Like the first, each part is a pure function of the sim time t.
//
// main.js creates this only when scenario.engagements has two entries.

const K = 1; // index of the second drone / engagement

export function createPair(scene) {
  const e = scenario.engagements[K];
  const d = scenario.drones[K];
  const plane = createPlane();
  scene.add(plane.group);
  const missile = createMissile();
  scene.add(missile.group);
  const debris = createDebris(plane, K);
  const effects = createEffects(scene, debris, K);

  const ship = new THREE.Vector3();
  const tmp = new THREE.Vector3();
  const tmp2 = new THREE.Vector3();
  // Numbers main.js hands to the labels (and reads for the HUD).
  const data = {
    dronePos: new THREE.Vector3(), droneSpeed: 0, droneAlt: 0, droneRange: 0,
    missilePos: missile.group.position, missileSpeed: 0, missileRange: 0,
  };

  // The drone in flight, then its falling fuselage (focus targets, audio).
  function dronePosAt(t, out) {
    if (t < e.tHit) return planePos(t, out, K);
    debris.fuselagePos(t - e.tHit, out);
    out.y = Math.max(out.y, 0); // keep watching the splash once it sinks
    return out;
  }

  function apply(t) {
    // It is lifted onto the cradle once the cradle has come home.
    plane.group.visible = t >= d.tLoad;
    if (t < e.tHit) {
      plane.restoreParts();
      planePose(t, plane.group.position, plane.group.quaternion, K);
      plane.setProp(propAngle(t, K), propSpin01(t, K));
      data.dronePos.copy(plane.group.position);
      data.droneAlt = plane.group.position.y;
      data.droneSpeed = planeVel(t, tmp, K).length();
    } else {
      debris.apply(t - e.tHit);
      debris.fuselagePos(t - e.tHit, data.dronePos);
      data.droneAlt = data.dronePos.y;
      data.droneSpeed = 0;
    }
    plane.setLights(t, t < e.tHit);
    plane.setBooster(t, d.tBoost0, d.tBoost1);

    const flying = t > e.tLaunch && t < e.tHit;
    missile.group.visible = flying;
    if (flying) {
      data.missileSpeed = missilePose(t, missile.group.position, missile.group.quaternion, K);
      missile.setExhaust(t);
      data.missileRange = missile.group.position.distanceTo(plane.group.position);
    } else {
      data.missileSpeed = 0;
      data.missileRange = 0;
    }
    shipPos(t, ship);
    data.droneRange = data.dronePos.distanceTo(tmp2.copy(ship).setY(10));
    effects.update(t);
    return data;
  }

  return {
    plane, missile, debris, effects, e, d, data, apply, dronePosAt,
    splashTimes: debris.pieces.map((p) => e.tHit + p.tauWater),
    // Seconds after which this engagement is fully over.
    tDone: e.tHit + debris.fallTime + 5,
  };
}

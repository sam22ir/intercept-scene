import * as THREE from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { scenario, planePos, shipPos, missileTrailPoints } from './scenario.js';

// Trajectory trails: the ship's track, each drone's flight path and each missile's
// path, as thick lines in their own colours. The stretch still ahead of the object
// is only a faint dashed preview; the stretch it has already consumed turns to a
// muted, slate-tinted version of its colour (solid). Everything is a pure function
// of the sim time t, so scrubbing works both ways. The Trails button and the T key
// switch them off.

export const TRAIL_COLORS = {
  ship: 0x3ddc84, // green
  drone: 0xff7a1a, // orange, like the drone
  missile: 0x35c8ff, // cyan
  drone2: 0xb892ff, // violet
  missile2: 0xff7ac6, // pink
};

const SPENT = new THREE.Color(0x7d8791); // what a consumed stretch fades toward
const SPENT_MIX = 0.72;
const DRONE_DT = 0.1; // s between drone path samples
const MISSILE_STEP = 5; // every 5th missile sample (500 Hz table): 100 points per second
const SHIP_Y = 1.6; // m: just above the sea, so the track is not buried in the waves

export function createTrails(scene) {
  const group = new THREE.Group();
  group.name = 'trails';
  scene.add(group);

  const resolution = new THREE.Vector2(window.innerWidth, window.innerHeight);
  const materials = [];
  const mat = (color, width, extra) => {
    const m = new LineMaterial({
      color, linewidth: width, transparent: true, depthWrite: false, resolution, worldUnits: false, ...extra,
    });
    materials.push(m);
    return m;
  };

  // One trail: a vivid dashed line over the whole planned path, and over the part already
  // travelled a solid line in the muted colour (its instance count grows with t).
  function trail(points, color, { width = 2, dash = [9, 7], order = 5 } = {}) {
    const flat = new Float32Array(points.length * 3);
    points.forEach((p, i) => p.toArray(flat, i * 3));
    const planGeo = new LineGeometry().setPositions(flat);
    const doneGeo = new LineGeometry().setPositions(flat);
    const spent = new THREE.Color(color).lerp(SPENT, SPENT_MIX);
    const plan = new Line2(planGeo, mat(color, width * 0.55, { opacity: 0.3, dashed: true, dashSize: dash[0], gapSize: dash[1] }));
    const done = new Line2(doneGeo, mat(spent, width, { opacity: 0.9 }));
    plan.computeLineDistances();
    for (const l of [plan, done]) { l.frustumCulled = false; l.renderOrder = order; }
    done.renderOrder = order + 1;
    group.add(plan, done);
    const segments = points.length - 1;
    return {
      plan, done,
      // `progress` is the fraction of the path travelled, 0..1.
      set(progress, visible = true) {
        plan.visible = done.visible = visible && segments > 0;
        doneGeo.instanceCount = Math.max(0, Math.min(segments, Math.ceil(progress * segments)));
      },
    };
  }

  const sample = (fn, t0, t1, dt) => {
    const out = [];
    for (let t = t0; t < t1; t += dt) out.push(fn(t, new THREE.Vector3()));
    out.push(fn(t1, new THREE.Vector3()));
    return out;
  };

  const tShipEnd = scenario.tEnd;
  const shipTrail = trail(sample((t, o) => shipPos(t, o).setY(SHIP_Y), 0, tShipEnd, 1), TRAIL_COLORS.ship, { width: 2, dash: [8, 6] });

  // Per engagement: the drone from the moment it appears until it is hit (or splashes down),
  // and the missile from launch to burst.
  const engagements = scenario.hasMissile ? scenario.engagements : [null];
  const sets = engagements.map((e, k) => {
    const dr = scenario.drones[k];
    const t0 = dr.tLoad;
    const t1 = e ? e.tHit : scenario.tSplash;
    const drone = trail(sample((t, o) => planePos(t, o, k), t0, t1, DRONE_DT), k ? TRAIL_COLORS.drone2 : TRAIL_COLORS.drone, { width: 2, dash: [10, 8] });
    let missile = null;
    let pts = null;
    if (e) {
      pts = missileTrailPoints(MISSILE_STEP, k);
      missile = trail(pts.map((p) => p.pos), k ? TRAIL_COLORS.missile2 : TRAIL_COLORS.missile, { width: 2.4, dash: [6, 5], order: 7 });
    }
    return { e, k, t0, t1, drone, missile, pts };
  });

  let enabled = true;
  const api = {
    get enabled() { return enabled; },
    setEnabled(on) { enabled = on; group.visible = on; },
    resize(w, h) { resolution.set(w, h); materials.forEach((m) => { m.resolution.copy(resolution); }); },
    update(t) {
      if (!enabled) return;
      shipTrail.set(t / tShipEnd);
      for (const s of sets) {
        s.drone.set((t - s.t0) / (s.t1 - s.t0), t >= s.t0);
        if (s.missile) {
          // Hidden until the launcher trains on the shot (a second before launch), then flown solid.
          const flown = (t - s.e.tLaunch) / (s.e.tHit - s.e.tLaunch);
          s.missile.set(flown, t > s.e.tLaunch - 1);
        }
      }
    },
  };
  return api;
}

// Regression tests for src/scenario.js. The module imports only `three`, so it
// runs in Node: no browser, no WebGL. Run with `pnpm test`.
//
// scenario.js reads its ship variant and mission from globalThis once, at
// import time. Each combo therefore sets the globals and imports the module
// under its own query string, which gives it a fresh module instance.

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import * as THREE from 'three';

// Every ship variant x mission combo to cover. Add new modes here.
const COMBOS = [
  { ship: 'fwd', mode: 'intercept' },
  { ship: 'aft', mode: 'intercept' },
  { ship: 'fwd', mode: 'chute' },
  { ship: 'aft', mode: 'chute' },
  { ship: 'fwd', mode: 'pair' },
  { ship: 'aft', mode: 'pair' },
];

// Thresholds (metres unless noted), with the value measured at the time of writing.
const INTERCEPT_MISS_MAX = 2.5; // measured 2.20 (fwd) / 1.96 (aft). The sim stops inside 2.5 m by design, so this also catches a timeout exit.
const HIT_GAP_MAX = 1e-3; // measured 0 (the last sample is snapped onto the drone)
const RELEASE_STEP_MAX = 0.1; // max distance per 1 ms step across release. Measured 0.034 (about 32 m/s). Allows about 3x margin.
const ALT_TOLERANCE = 0.5; // allowed dip below MIN_ALT. Measured minimum is 11.41 m, at release.

const LAUNCH_GAP_MIN = 2; // s between the two launches (the launcher must slew and reload). Measured about 17 s.
const PAIR_SEPARATION_MIN = 15; // m between the two drones while both are flying. Measured about 125 m.

const SCENARIO_URL = new URL('../src/scenario.js', import.meta.url);

async function loadScenario({ ship, mode }) {
  globalThis.__SHIP_VARIANT = ship;
  globalThis.__SCENARIO = mode;
  // A distinct query string makes Node evaluate the module again.
  const S = await import(`${SCENARIO_URL.href}?combo=${ship}-${mode}`);
  assert.equal(S.SHIP_VARIANT, ship, 'ship variant did not take effect');
  assert.equal(S.MODE, mode, 'mission did not take effect');
  return S;
}

const vec = () => new THREE.Vector3();
const dist = (a, b) => a.distanceTo(b);

for (const combo of COMBOS) {
  describe(`scenario ${combo.ship}-${combo.mode}`, () => {
    let S;
    before(async () => {
      S = await loadScenario(combo);
    });

    it('uses the default path (no localStorage custom path in Node)', () => {
      assert.equal(S.scenario.customPath, false);
    });

    it('has finite release time', () => {
      assert.ok(Number.isFinite(S.scenario.tRelease));
    });

    if (combo.mode !== 'chute') {
      it('has a finite launch that precedes the hit', () => {
        const { tLaunch, tHit } = S.scenario;
        assert.ok(Number.isFinite(tLaunch), 'tLaunch must be finite');
        assert.ok(Number.isFinite(tHit), 'tHit must be finite');
        assert.ok(tHit > tLaunch, `tHit (${tHit}) must be after tLaunch (${tLaunch})`);
      });

      it('has the missile and no recovery phase', () => {
        assert.equal(S.scenario.hasMissile, true);
        assert.equal(S.scenario.tChute, Infinity);
      });

      it(`misses by less than ${INTERCEPT_MISS_MAX} m before the snap`, () => {
        assert.ok(S.scenario.interceptMiss < INTERCEPT_MISS_MAX,
          `interceptMiss ${S.scenario.interceptMiss} >= ${INTERCEPT_MISS_MAX}`);
      });

      it('fires only into its own half: the missile never crosses the ship', () => {
        // 920 (forward box, pivot x 24) fires ahead of its pivot, 921 (aft box, pivot x -33.8) astern.
        const aft = combo.ship === 'aft';
        const pivotX = S.LAUNCHER_PIVOT.x;
        S.scenario.engagements.forEach((e, k) => {
          const dr = S.planePos(e.tLaunch, vec(), k).sub(S.shipPos(e.tLaunch, vec()));
          assert.ok(aft ? dr.x <= pivotX : dr.x >= pivotX, `drone ${k} is on the wrong side of the launcher at launch (x ${dr.x})`);
          for (let t = e.tLaunch; t <= e.tHit; t += 0.02) {
            const m = S.missilePos(t, vec(), k).sub(S.shipPos(t, vec()));
            if (m.distanceTo(S.LAUNCHER_PIVOT) < 10) continue; // still leaving the tube
            assert.ok(aft ? m.x <= pivotX + 1 : m.x >= pivotX - 1, `missile ${k} crosses the ship at t=${t.toFixed(2)} (x ${m.x.toFixed(1)})`);
          }
        });
      });

      it('keeps the box on its own half of the ship the whole time (no spin through the bow/stern)', () => {
        // Yaw 0 = bow, π = stern. A forward box must never face aft, nor an aft box forward.
        const aft = combo.ship === 'aft';
        for (let t = 0; t < S.scenario.tEnd; t += 0.05) {
          const c = Math.cos(S.launcherAim(t).yaw);
          assert.ok(aft ? c <= 0.05 : c >= -0.05, `launcher yaw faces the wrong way at t=${t.toFixed(2)} (cos ${c.toFixed(2)})`);
        }
      });

      it('has the drone and the missile at the same place at tHit', () => {
        const { tHit } = S.scenario;
        const gap = dist(S.planePos(tHit, vec()), S.missilePos(tHit, vec()));
        assert.ok(gap < HIT_GAP_MAX, `drone-missile gap at tHit is ${gap} m`);
      });
    }

    if (combo.mode === 'pair') {
      it('has two engagements, the first matching tLaunch/tHit', () => {
        const { engagements, tLaunch, tHit } = S.scenario;
        assert.equal(engagements.length, 2);
        assert.equal(engagements[0].tLaunch, tLaunch);
        assert.equal(engagements[0].tHit, tHit);
        assert.equal(S.scenario.drones.length, 2);
      });

      it('hits both drones exactly and ends after the last hit', () => {
        S.scenario.engagements.forEach((e, k) => {
          assert.ok(e.tHit > e.tLaunch, `engagement ${k}: tHit must follow tLaunch`);
          assert.ok(e.interceptMiss < INTERCEPT_MISS_MAX, `engagement ${k}: miss ${e.interceptMiss}`);
          const gap = dist(S.planePos(e.tHit, vec(), k), S.missilePos(e.tHit, vec(), k));
          assert.ok(gap < HIT_GAP_MAX, `engagement ${k}: drone-missile gap at tHit is ${gap} m`);
        });
        assert.ok(S.scenario.tEnd > S.scenario.engagements[1].tHit);
      });

      it(`launches the missiles at least ${LAUNCH_GAP_MIN} s apart, in order`, () => {
        const [a, b] = S.scenario.engagements;
        assert.ok(b.tLaunch - a.tLaunch >= LAUNCH_GAP_MIN, `launch gap ${b.tLaunch - a.tLaunch} s`);
      });

      it('launches drone 2 after the cradle is home, and drone 1 is long gone from the rail', () => {
        const [, d2] = S.scenario.drones;
        assert.ok(d2.tLoad >= S.scenario.tRelease + 6, `drone 2 appears at ${d2.tLoad} s, before the cradle is home`);
        assert.ok(d2.tRelease > d2.tLoad);
        assert.equal(S.shuttleStroke(d2.tLoad), 0);
      });

      it(`keeps the drones at least ${PAIR_SEPARATION_MIN} m apart while both fly`, () => {
        const [e0, e1] = S.scenario.engagements;
        const t1 = Math.min(e0.tHit, e1.tHit);
        let min = Infinity;
        let tAt = NaN;
        for (let t = S.scenario.drones[1].tLoad; t <= t1; t += 0.02) {
          const d = dist(S.planePos(t, vec(), 0), S.planePos(t, vec(), 1));
          if (d < min) { min = d; tAt = t; }
        }
        assert.ok(min > PAIR_SEPARATION_MIN, `drones are ${min} m apart at t=${tAt}`);
      });

      it('keeps drone 2 above MIN_ALT on its path', () => {
        const floor = S.MIN_ALT - ALT_TOLERANCE;
        for (let t = S.scenario.drones[1].tRelease; t <= S.scenario.engagements[1].tHit; t += 0.01) {
          const y = S.planeRelPos(t, vec(), 1).y;
          assert.ok(y >= floor, `drone 2 altitude ${y} m at t=${t} is below ${floor} m`);
        }
      });

      it('has continuous release for drone 2', () => {
        const t0 = S.scenario.drones[1].tRelease;
        let maxStep = 0;
        for (let t = t0 - 0.2; t < t0 + 0.2; t += 0.001) {
          maxStep = Math.max(maxStep, dist(S.planeRelPos(t, vec(), 1), S.planeRelPos(t + 0.001, vec(), 1)));
        }
        assert.ok(maxStep < RELEASE_STEP_MAX, `largest 1 ms step is ${maxStep} m`);
      });

      it('slews the launcher onto each shot (aim is steady while each missile leaves)', () => {
        for (const e of S.scenario.engagements) {
          const a = S.launcherAim(e.tLaunch - 0.5);
          const b = S.launcherAim(e.tLaunch + 0.2);
          assert.ok(Math.abs(a.yaw - b.yaw) < 1e-6 && Math.abs(a.pitch - b.pitch) < 1e-6, 'launcher moves while firing');
          assert.ok(b.pitch > 0.1, 'launcher is not elevated at launch');
        }
        const end = S.launcherAim(S.scenario.engagements[1].tLaunch + 9);
        assert.ok(Math.abs(end.pitch) < 1e-9, 'launcher is not stowed after the last shot');
      });
    } else {
      it('has a single engagement (none in recovery)', () => {
        assert.equal(S.scenario.engagements.length, combo.mode === 'chute' ? 0 : 1);
      });
    }

    if (combo.mode === 'chute') {
      it('never fires: launch and hit are Infinity, no missile', () => {
        assert.equal(S.scenario.tLaunch, Infinity);
        assert.equal(S.scenario.tHit, Infinity);
        assert.equal(S.scenario.hasMissile, false);
      });

      it('opens the chute at a finite time and splashes down after it', () => {
        const { tChute, tSplash } = S.scenario;
        assert.ok(Number.isFinite(tChute), 'tChute must be finite');
        assert.ok(Number.isFinite(tSplash), 'tSplash must be finite');
        assert.ok(tSplash > tChute, `tSplash (${tSplash}) must be after tChute (${tChute})`);
      });
    }

    it('keeps the drone above MIN_ALT on the planned path after release', () => {
      // Recovery descends into the sea on purpose after tChute, so the
      // altitude floor covers only the planned path, up to tChute.
      const end = combo.mode === 'chute' ? S.scenario.tChute : S.scenario.tHit;
      const floor = S.MIN_ALT - ALT_TOLERANCE;
      let minY = Infinity;
      let tAtMin = NaN;
      for (let t = S.scenario.tRelease; t <= end; t += 0.01) {
        const y = S.planeRelPos(t, vec()).y;
        if (y < minY) { minY = y; tAtMin = t; }
      }
      assert.ok(minY >= floor, `altitude ${minY} m at t=${tAtMin} is below ${floor} m`);
    });

    it(`has continuous release: at most ${RELEASE_STEP_MAX} m per 1 ms across the catapult release`, () => {
      const t0 = S.scenario.tRelease;
      let maxStep = 0;
      for (let t = t0 - 0.2; t < t0 + 0.2; t += 0.001) {
        const step = dist(S.planeRelPos(t, vec()), S.planeRelPos(t + 0.001, vec()));
        if (step > maxStep) maxStep = step;
      }
      assert.ok(maxStep < RELEASE_STEP_MAX, `largest 1 ms step is ${maxStep} m`);
    });

    it('is deterministic: forward then reverse sampling gives identical results', () => {
      // Sample to tEnd so the chute descent and the post-hit missile clamp are covered.
      const end = S.scenario.tEnd;
      const times = [];
      for (let t = 0; t <= end; t += 0.37) times.push(t);
      times.push(S.scenario.tRelease, S.scenario.tRelease + 0.001);
      const sample = (t) => {
        const rel = S.planeRelPos(t, vec());
        const miss = S.missilePos(t, vec());
        const out = [rel.x, rel.y, rel.z, miss.x, miss.y, miss.z];
        if (combo.mode === 'pair') {
          const rel2 = S.planeRelPos(t, vec(), 1);
          const miss2 = S.missilePos(t, vec(), 1);
          out.push(rel2.x, rel2.y, rel2.z, miss2.x, miss2.y, miss2.z);
        }
        return out;
      };
      const forward = times.map(sample);
      const reverse = [...times].reverse().map(sample).reverse();
      assert.deepEqual(reverse, forward);
    });

    // Superstructure clearance is not tested. scenario.js exports no
    // superstructure geometry (that lives in src/models/ship.js), so there is
    // nothing here to check against without inventing numbers.
  });
}

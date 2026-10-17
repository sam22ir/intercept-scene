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
];

// Thresholds (metres unless noted), with the value measured at the time of writing.
const INTERCEPT_MISS_MAX = 2.5; // measured 2.20 (fwd) / 2.18 (aft). The sim stops inside 2.5 m by design, so this also catches a timeout exit.
const HIT_GAP_MAX = 1e-3; // measured 0 (the last sample is snapped onto the drone)
const RELEASE_STEP_MAX = 0.1; // max distance per 1 ms step across release. Measured 0.034 (about 32 m/s). Allows about 3x margin.
const ALT_TOLERANCE = 0.5; // allowed dip below MIN_ALT. Measured minimum is 11.41 m, at release.

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

    if (combo.mode === 'intercept') {
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

      it('has the drone and the missile at the same place at tHit', () => {
        const { tHit } = S.scenario;
        const gap = dist(S.planePos(tHit, vec()), S.missilePos(tHit, vec()));
        assert.ok(gap < HIT_GAP_MAX, `drone-missile gap at tHit is ${gap} m`);
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
        return [rel.x, rel.y, rel.z, miss.x, miss.y, miss.z];
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

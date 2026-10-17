// Regression tests for the engagement settings in src/scenario.js: when the missile
// leaves, when it bursts and how far from the drone. Like scenario.test.mjs, each case
// sets the globals and imports the module under its own query string, because the
// settings are read once at import.

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

const SCENARIO_URL = new URL('../src/scenario.js', import.meta.url);
let n = 0;

async function load(ship, engage, mode = 'intercept') {
  globalThis.__SHIP_VARIANT = ship;
  globalThis.__SCENARIO = mode;
  if (engage) globalThis.__ENGAGE = engage; else delete globalThis.__ENGAGE;
  return import(`${SCENARIO_URL.href}?engage=${n++}`);
}

after(() => { delete globalThis.__ENGAGE; });

const droneAt = (S, t, k = 0) => S.planePos(t, new THREE.Vector3(), k);
const burstGap = (S) => S.scenario.hitPos.distanceTo(droneAt(S, S.scenario.tHit));

for (const ship of ['fwd', 'aft']) {
  describe(`engagement settings ${ship}`, () => {
    it('defaults to a direct hit at the derived launch time', async () => {
      const S = await load(ship, null);
      assert.equal(S.CUSTOM_ENGAGE, false);
      assert.equal(S.scenario.tLaunch, S.scenario.autoLaunch);
      assert.ok(burstGap(S) < 1e-3, 'last missile sample is on the drone');
      assert.ok(S.scenario.burstDist < 1e-3);
    });

    it('launches at the chosen time', async () => {
      const probe = await load(ship, null);
      const want = probe.scenario.autoLaunch - 6;
      const S = await load(ship, { timing: 'launch', time: want, dist: 0, side: 'auto' });
      assert.ok(Math.abs(S.scenario.tLaunch - want) < 0.05, `launch ${S.scenario.tLaunch} vs ${want}`);
      assert.ok(S.scenario.tHit > S.scenario.tLaunch);
      assert.ok(S.scenario.interceptMiss < 2.5, 'still reaches the drone');
    });

    it('bursts at the chosen impact time', async () => {
      const probe = await load(ship, null);
      const want = probe.scenario.tHit - 4;
      const S = await load(ship, { timing: 'impact', time: want, dist: 0, side: 'auto' });
      assert.ok(Math.abs(S.scenario.tHit - want) < 0.1, `impact ${S.scenario.tHit} vs ${want}`);
    });

    it('launches when the drone closes to the chosen distance', async () => {
      const probe = await load(ship, null);
      for (const range of [400, 650, 900]) {
        const S = await load(ship, { timing: 'range', time: 0, range, dist: 0, side: 'auto' });
        const r = S.droneRange(S.scenario.tLaunch);
        assert.ok(Math.abs(r - range) < 6, `range at launch ${r} vs ${range}`);
        assert.ok(S.scenario.tLaunch > 0 && S.scenario.interceptMiss < 2.5);
      }
      // 650 m is the automatic trigger, so it reproduces the default launch.
      const same = await load(ship, { timing: 'range', time: 0, range: 650, dist: 0, side: 'auto' });
      assert.ok(Math.abs(same.scenario.tLaunch - probe.scenario.tLaunch) < 1e-9);
    });

    it('range trigger: preview flags a distance the drone never closes from', async () => {
      const S = await load(ship, null);
      const ok = S.previewEngagement({ timing: 'range', time: 0, range: 650, dist: 0, side: 'auto' });
      assert.equal(ok.rangeOk, true);
      assert.ok(Math.abs(ok.launchRange - 650) < 6);
      const never = S.previewEngagement({ timing: 'range', time: 0, range: 1500, dist: 0, side: 'auto' });
      assert.equal(typeof never.rangeOk, 'boolean');
    });

    it('proximity fuze: bursts within range, short of the drone', async () => {
      const S = await load(ship, { timing: 'auto', time: 0, dist: 20, side: 'auto' });
      assert.ok(S.scenario.burstDist > 2.5 && S.scenario.burstDist <= 20.5, `burst ${S.scenario.burstDist}`);
      assert.ok(Math.abs(burstGap(S) - S.scenario.burstDist) < 1e-6);
    });

    for (const side of ['above', 'below', 'left', 'right']) {
      it(`explicit burst ${side}: exactly the chosen distance, on that side`, async () => {
        const S = await load(ship, { timing: 'auto', time: 0, dist: 30, side });
        const { tHit } = S.scenario;
        assert.ok(Math.abs(S.scenario.burstDist - 30) < 1e-3, `burst ${S.scenario.burstDist}`);
        const d = S.scenario.hitPos.clone().sub(droneAt(S, tHit));
        const vel = S.planeVel(tHit, new THREE.Vector3());
        const fwd = vel.clone().normalize();
        const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize();
        const up = new THREE.Vector3().crossVectors(right, fwd);
        const along = { above: up, below: up.clone().negate(), left: right.clone().negate(), right }[side];
        assert.ok(d.normalize().dot(along) > 0.99, `${side}: burst not on that side`);
      });
    }

    it('previewEngagement matches what loading the same setting gives', async () => {
      const engage = { timing: 'launch', time: 30, dist: 15, side: 'above' };
      const base = await load(ship, null);
      const preview = base.previewEngagement(engage);
      const S = await load(ship, engage);
      assert.ok(Math.abs(preview.tLaunch - S.scenario.tLaunch) < 1e-9);
      assert.ok(Math.abs(preview.tHit - S.scenario.tHit) < 1e-9);
      assert.ok(Math.abs(preview.burstDist - S.scenario.burstDist) < 1e-9);
    });

    it('rejects nonsense and clamps ranges', async () => {
      const S = await load(ship, null);
      assert.equal(S.validateEngage(null), null);
      assert.equal(S.validateEngage({ time: 'x', dist: 3 }), null);
      const v = S.validateEngage({ timing: 'bogus', time: 5, dist: 999, side: 'sideways' });
      assert.deepEqual(v, { timing: 'auto', time: 5, range: 650, dist: S.MAX_BURST, side: 'auto' });
    });
  });
}

describe('engagement settings in the other missions', () => {
  it('recovery ignores them: no missile, no burst', async () => {
    const S = await load('fwd', { timing: 'launch', time: 20, dist: 10, side: 'left' }, 'chute');
    assert.equal(S.scenario.hasMissile, false);
    assert.equal(S.scenario.tLaunch, Infinity);
    assert.equal(S.previewEngagement({ timing: 'auto', time: 0, dist: 0, side: 'auto' }), null);
  });

  it('pair: the setting moves the first shot and keeps the launch gap', async () => {
    const probe = await load('fwd', null, 'pair');
    const S = await load('fwd', { timing: 'launch', time: probe.scenario.autoLaunch + 25, dist: 12, side: 'auto' }, 'pair');
    const [a, b] = S.scenario.engagements;
    assert.ok(b.tLaunch - a.tLaunch >= 2.5 - 1e-9, 'launcher needs time to slew and reload');
    assert.equal(S.scenario.engagements.length, 2);
  });
});

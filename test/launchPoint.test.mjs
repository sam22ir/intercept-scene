// The Intercept and Recovery default paths (out and back at 250 m), the rule that the missile
// only ever leaves on the inbound run (the drone flying toward the ship), the editor's red
// launch point, and Recovery's lock-on and recovery point.

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

const SCENARIO_URL = new URL('../src/scenario.js', import.meta.url);
let n = 0;

async function load(ship, mode, { engage, launch, points } = {}) {
  globalThis.__SHIP_VARIANT = ship;
  globalThis.__SCENARIO = mode;
  if (engage) globalThis.__ENGAGE = engage; else delete globalThis.__ENGAGE;
  delete globalThis.location;
  if (launch !== undefined || points) {
    globalThis.__SCENARIO = mode;
    const probe = points ?? (await import(`${SCENARIO_URL.href}?lp-probe=${n++}`)).DEFAULT_PATH;
    const body = Buffer.from(JSON.stringify({ points: probe, launch })).toString('base64url');
    globalThis.location = { hash: `#path=${body}`, search: '' };
  }
  const S = await import(`${SCENARIO_URL.href}?lp=${n++}`);
  delete globalThis.location;
  return S;
}

after(() => { delete globalThis.__ENGAGE; delete globalThis.location; });

const rel = (S, t) => S.planeRelPos(t, new THREE.Vector3());
const closing = (S, t) => S.droneRange(t) < S.droneRange(t - 0.1);

for (const ship of ['fwd', 'aft']) {
  describe(`Intercept ${ship}: out and back`, () => {
    it('flies far out along its side of the ship, turns and is shot down near 250 m', async () => {
      const S = await load(ship, 'intercept');
      const { tLaunch, tHit, hitPos } = S.scenario;
      let far = 0;
      for (let t = S.scenario.tRelease; t < tLaunch; t += 0.5) {
        const x = rel(S, t).x;
        far = ship === 'aft' ? Math.min(far, x) : Math.max(far, x);
      }
      assert.ok(Math.abs(far) > 1500, `turn-around ${far.toFixed(0)} m`);
      assert.ok(Math.abs(hitPos.y - S.INTERCEPT_ALT) < 15, `impact altitude ${hitPos.y.toFixed(0)}`);
      assert.ok(closing(S, tLaunch), 'the drone is flying toward the ship at launch');
      assert.ok(tHit > tLaunch);
    });

    it('a launch time on the outbound leg is moved onto the inbound run', async () => {
      const S = await load(ship, 'intercept', { engage: { timing: 'launch', time: 30, dist: 0, side: 'auto' } });
      const [t0, t1] = S.scenario.inbound;
      assert.ok(S.scenario.tLaunch >= t0 - 1e-9 && S.scenario.tLaunch <= t1 + 1e-9);
      assert.ok(closing(S, S.scenario.tLaunch));
      assert.ok(S.scenario.interceptMiss < 2.5);
    });

    it('the red launch point sets the launch, held on the inbound run', async () => {
      const base = await load(ship, 'intercept');
      const [u0, u1] = base.inboundU(base.DEFAULT_PATH);
      const want = u0 + (u1 - u0) * 0.3;
      const S = await load(ship, 'intercept', { launch: want });
      assert.ok(Math.abs(S.scenario.launchU - want) < 1e-4);
      assert.ok(S.scenario.tLaunch < base.scenario.tLaunch - 3, 'earlier than the 650 m trigger');
      assert.ok(closing(S, S.scenario.tLaunch));
      assert.ok(S.droneRange(S.scenario.tLaunch) > 700);
      // A point on the outbound leg is pulled onto the start of the inbound run.
      const early = await load(ship, 'intercept', { launch: 0.1 });
      assert.ok(Math.abs(early.scenario.tLaunch - early.scenario.inbound[0]) < 0.06);
      assert.ok(closing(early, early.scenario.tLaunch));
    });

    it('the editor finds the 650 m trigger where the scene does', async () => {
      const S = await load(ship, 'intercept');
      const u = S.autoLaunchU(S.DEFAULT_PATH);
      const p = S.buildPathCurve(S.DEFAULT_PATH).getPointAt(u);
      assert.ok(Math.abs(p.distanceTo(new THREE.Vector3(0, 10, 0)) - 650) < 5);
    });
  });

  describe(`Recovery ${ship}: the same flight, a lock-on, no shot`, () => {
    it('shares the Intercept path to the inbound run, locks on, and opens the chute 300 m off the port quarter at 90 m', async () => {
      const I = await load(ship, 'intercept');
      const S = await load(ship, 'chute');
      assert.deepEqual(S.DEFAULT_PATH.slice(0, 30), I.DEFAULT_PATH.slice(0, 30));
      assert.equal(S.scenario.hasMissile, false);
      const { tLock, tChute } = S.scenario;
      assert.ok(tLock < tChute && closing(S, tLock), 'locks on the inbound drone');
      const end = rel(S, tChute - 1e-3);
      assert.ok(end.x < -100 && end.z < -100, 'port quarter');
      assert.ok(Math.abs(Math.hypot(end.x, end.z) - 300) < 3, `range ${Math.hypot(end.x, end.z).toFixed(0)}`);
      assert.ok(Math.abs(end.y - 90) < 2, `altitude ${end.y.toFixed(0)}`);
      assert.ok(S.scenario.events.some((e) => e.label === 'Launcher lock-on'));
    });

    it('the launcher slews onto the drone, follows it, and stows after the chute', async () => {
      const S = await load(ship, 'chute');
      const { tLock, tChute } = S.scenario;
      const stow = ship === 'aft' ? Math.PI : 0;
      assert.deepEqual(S.launcherAim(tLock - 5), { yaw: stow, pitch: 0 });
      const a = S.launcherAim(tLock + 2);
      assert.ok(a.pitch > 0.3, 'elevated on the drone');
      assert.deepEqual(S.launcherAim(tChute + 8), { yaw: stow, pitch: 0 });
    });
  });
}

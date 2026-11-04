// The mission plan: the settings of the Watch missions' start window and the path generated from them (src/missionPlan.js),
// and the scenario flown from them: the drone goes ahead of the forward launcher and astern of the aft one, turns back
// where it is told, the missile leaves at the engagement distance on the run in, and the speed is the cruise speed in level
// flight, less going up and more coming down.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  PLAN_DEFAULTS, RAIL_END, RECOVERY_AT, generatePath, planEngage, planSky, planStats, relSpeed, speedAtSlope, turnRadius, validatePlan,
} from '../src/missionPlan.js';

const plan = (o = {}) => validatePlan({ ...PLAN_DEFAULTS, ...o });
const VARIANTS = ['fwd', 'aft'];
const SHAPES = [
  {},
  { alt: 120, runAlt: 120, turnBack: 900, engage: 300 },
  { alt: 800, runAlt: 800, turnBack: 5000, engage: 1500 },
  { alt: 600, runAlt: 100, turnBack: 3000, engage: 800 },
  { droneSpeed: 100, shipKn: 30, turnBack: 1000, engage: 1500, alt: 1000 },
  { droneSpeed: 45, shipKn: 5, turnBack: 800, engage: 200, alt: 60, runAlt: 40 },
];

describe('the settings', () => {
  it('keeps every value in its range and the run in no higher than the top', () => {
    const p = validatePlan({ alt: 5000, runAlt: 9000, turnBack: 1, engage: 'x', droneSpeed: -3, weather: 'snow', tod: 'never' });
    assert.equal(p.alt, 1000);
    assert.equal(p.runAlt, 1000);
    assert.equal(p.turnBack, 800);
    assert.equal(p.engage, PLAN_DEFAULTS.engage);
    assert.equal(p.droneSpeed, 45);
    assert.equal(p.weather, 'auto');
    assert.equal(p.tod, 'auto');
    assert.equal(validatePlan(null), null);
  });

  it('the sun turns with the heading and the time of day', () => {
    assert.deepEqual(planSky(plan()), { azAdd: 0 });
    assert.deepEqual(planSky(plan({ heading: 90 })), { azAdd: 90 });
    assert.equal(planSky(plan({ tod: 'dawn' })).az, 0, 'a sun in the east, dead ahead of a ship heading east... and abeam of one heading north');
    assert.equal(planSky(plan({ tod: 'dawn', heading: 90 })).az, 90, 'heading east, the dawn sun is dead ahead (the scene\'s +X)');
    assert.equal(planSky(null), null);
  });

  it('the engagement setting says what the plan says', () => {
    assert.deepEqual(planEngage(plan({ engage: 900, burst: 20 })), { timing: 'range', time: 0, range: 900, dist: 20, side: 'auto' });
  });

  it('slower going up, faster coming down, and 75 in level flight', () => {
    assert.equal(speedAtSlope(75, 0), 75);
    assert.ok(speedAtSlope(75, 0.2) < 75);
    assert.ok(speedAtSlope(75, -0.2) > 75);
    assert.ok(speedAtSlope(75, 0.9) >= 52, 'never less than 70 percent');
    assert.ok(speedAtSlope(75, -0.9) <= 98, 'never more than 130 percent');
  });

  it('the speed along the path gives the speed over the sea', () => {
    for (const dx of [1, 0, -1, 0.6]) {
      const v = relSpeed(75, 7, dx);
      const dz = Math.sqrt(1 - dx * dx);
      assert.ok(Math.abs(Math.hypot(v * dx + 7, v * dz) - 75) < 1e-6, `dx ${dx}`);
    }
  });
});

describe('the generated path', () => {
  for (const variant of VARIANTS) {
    for (const mode of ['intercept', 'chute']) {
      for (const shape of SHAPES) {
        it(`${variant} ${mode} ${JSON.stringify(shape)}`, () => {
          const p = plan(shape);
          const path = generatePath(p, { variant, mode });
          const ahead = variant === 'aft' ? -1 : 1;
          assert.ok(path.points.length >= 8 && path.points.length <= 80, `${path.points.length} points fit the editor`);
          for (const q of path.points) {
            assert.ok(q.every(Number.isFinite));
            assert.ok(Math.abs(q[0]) <= 6000 && Math.abs(q[2]) <= 6000 && q[1] >= 8 && q[1] <= p.alt, `in bounds: ${q}`);
          }
          // After the launch it goes the launcher's way: its far point is on that side, past the turn-back distance.
          const out = path.points.reduce((m, q) => Math.max(m, q[0] * ahead), -Infinity);
          const back = path.points.reduce((m, q) => Math.max(m, -q[0] * ahead), -Infinity);
          assert.ok(out > path.turnBack * 0.5 && out > back + 300, `out ${out}, the wrong way ${back}`);
          // No leg is too steep.
          const all = [RAIL_END, ...path.points];
          for (let i = 1; i < all.length; i++) {
            const d = Math.hypot(all[i][0] - all[i - 1][0], all[i][2] - all[i - 1][2]);
            if (d > 60) assert.ok(Math.abs(all[i][1] - all[i - 1][1]) / d < Math.tan(30 * Math.PI / 180), `leg ${i} is steep: ${all[i - 1]} to ${all[i]}`);
          }
          if (mode === 'chute') assert.deepEqual(path.points.at(-1), [RECOVERY_AT[0], Math.min(RECOVERY_AT[1], p.alt), RECOVERY_AT[2]], 'ends at the recovery point');
          else assert.ok(Math.abs(path.points.at(-1)[2]) < 3, 'ends on the centre line');
          // A setting that had to give way is reported, with what it came to.
          assert.ok(path.engage <= p.engage);
          assert.equal(path.notes.some((n) => n.key === 'engage'), path.engage < p.engage);
          assert.ok(path.engage < path.exitRange, 'the engagement is on the run in');
        });
      }
    }
  }

  it('turns back at the distance asked, when the speed allows it', () => {
    for (const variant of VARIANTS) {
      for (const turnBack of [1600, 2500, 4000]) {
        const path = generatePath(plan({ turnBack }), { variant });
        assert.ok(Math.abs(path.turnBack - turnBack) <= 60, `${variant} ${turnBack}: ${path.turnBack}`);
        assert.equal(path.notes.some((n) => n.key === 'turnBack'), false);
      }
    }
  });

  it('turns at 45 degrees of bank: the radius follows from the speed', () => {
    assert.equal(Math.round(turnRadius(plan())), 573, '573 m at 75 m/s, the owner\'s figure');
    assert.equal(Math.round(turnRadius(plan({ droneSpeed: 54 }))), 297);
    assert.equal(Math.round(turnRadius(plan({ droneSpeed: 100 }))), 1019);
    // The path really flies that radius: the turn's port-most point is two radii from the centre line.
    const path = generatePath(plan({ turnBack: 3000 }));
    assert.ok(Math.abs(Math.max(...path.points.map((q) => -q[2])) - 2 * 573) < 20, 'port-most point');
    assert.equal(path.radius, turnRadius(plan()));
  });

  it('a fast drone needs room, and says so when the distance asked is too short', () => {
    const path = generatePath(plan({ droneSpeed: 100, shipKn: 30, turnBack: 800 }));
    assert.ok(path.turnBack > 800);
    assert.equal(path.notes.find((n) => n.key === 'turnBack').value, Math.round(path.turnBack));
  });

  it('climbs and descends at a steady slope, in the ship\'s frame the one that makes 20 degrees over the sea', () => {
    for (const variant of VARIANTS) {
      const path = generatePath(plan({ alt: 600, runAlt: 100, turnBack: 4000, engage: 500 }), { variant });
      const all = [RAIL_END, ...path.points];
      const slopes = all.slice(1).map((q, i) => (q[1] - all[i][1]) / Math.hypot(q[0] - all[i][0], q[2] - all[i][2]));
      const deg = (m) => (Math.atan(m) * 180) / Math.PI;
      const near = (d, lo, hi, what) => assert.ok(d > lo && d < hi, `${variant} ${what} ${d}`);
      if (variant === 'fwd') { near(deg(Math.max(...slopes)), 21, 25, 'climb'); near(-deg(Math.min(...slopes)), 17, 20, 'descent'); }
      else { near(deg(Math.max(...slopes)), 16, 23, 'climb'); // steeper in the ship's frame while it swings round toward the bow
        near(-deg(Math.min(...slopes)), 20, 23, 'descent'); }
    }
  });

  it('holds the top height until the run in comes down to its own', () => {
    const path = generatePath(plan({ alt: 400, runAlt: 150, turnBack: 3000 }));
    assert.equal(Math.max(...path.points.map((q) => q[1])), 400);
    assert.ok(path.points.at(-1)[1] <= 151, `ends at ${path.points.at(-1)[1]}`);
  });

  it('the stats show a slower climb and a faster descent', () => {
    const p = plan({ alt: 400, runAlt: 150, turnBack: 3000 });
    const s = planStats(p, generatePath(p));
    assert.ok(s.vMin < 75 && s.vMax > 75, `${s.vMin} to ${s.vMax}`);
    assert.ok(s.tEngage > 10 && s.tEngage < s.tFlight, `${s.tEngage} of ${s.tFlight}`);
  });
});

// The scenario flown from a plan: each import reads globalThis.__PLAN once.
let seq = 0;
async function fly(variant, mode, o = {}) {
  const p = plan(o);
  globalThis.__SHIP_VARIANT = variant;
  globalThis.__SCENARIO = mode;
  globalThis.__PLAN = p;
  globalThis.__ENGAGE = mode === 'intercept' ? planEngage(p) : undefined;
  const S = await import(`../src/scenario.js?plan=${++seq}`);
  delete globalThis.__PLAN;
  delete globalThis.__ENGAGE;
  return { S, p };
}

describe('the scenario flown from a plan', () => {
  it('the release point is the catapult\'s', async () => {
    const { S } = await fly('fwd', 'intercept');
    S.PATH_FIXED[1].forEach((v, i) => assert.ok(Math.abs(v - RAIL_END[i]) < 0.01, `${S.PATH_FIXED[1]}`));
    assert.equal(S.RECOVERY_POINT.join(), RECOVERY_AT.join());
  });

  for (const variant of VARIANTS) {
    it(`${variant}: the launcher's way, the missile at the engagement distance on the run in`, async () => {
      const { S, p } = await fly(variant, 'intercept', { engage: 800, turnBack: 2200, alt: 300, runAlt: 300, shipKn: 20 });
      const sc = S.scenario;
      const ahead = variant === 'aft' ? -1 : 1;
      assert.equal(S.SHIP_SPEED.toFixed(2), (p.shipKn * 0.514444).toFixed(2));
      assert.equal(sc.customEngage, false, 'the plan\'s own engagement is not a custom one');
      assert.equal(sc.customPath, false, 'nor is its path a drawn one');
      const pos = new THREE.Vector3();
      // The rail faces forward, so the aft launcher's drone first swings round through its turn.
      S.planeRelPos(sc.tRelease + 30, pos);
      assert.ok(pos.x * ahead > 400, `30 s after the launch it is on the launcher's side: ${pos.x}`);
      // The launch: at the distance asked, closing, inside the box's arc.
      const r0 = S.droneRange(sc.tLaunch);
      assert.ok(Math.abs(r0 - 800) < 15, `launched at ${r0}`);
      assert.ok(S.droneRange(sc.tLaunch + 0.5) < r0, 'closing');
      S.planeRelPos(sc.tLaunch, pos);
      assert.ok(S.inArcX(pos.x), 'in the arc');
      assert.ok(Number.isFinite(sc.tHit) && sc.interceptMiss === 0, 'and it hits');
      assert.ok(Math.abs(sc.hitPos.y - 300) < 20, `at about the run's height: ${sc.hitPos.y}`);
    });

    it(`${variant}: the speed over the sea follows the slope, and the attitude stays in its limits`, async () => {
      const { S, p } = await fly(variant, 'intercept', { alt: 500, runAlt: 150, turnBack: 3500, engage: 500 });
      const sc = S.scenario;
      const pos = new THREE.Vector3();
      const vel = new THREE.Vector3();
      const q = new THREE.Quaternion();
      const nose = new THREE.Vector3();
      const wing = new THREE.Vector3();
      const D = 180 / Math.PI;
      let level = 0, up = 0, down = 0, steady = 0, topUp = 0, topDown = 0;
      let bank = 0, pitch = 0;
      for (let t = sc.tRelease + 2; t < sc.tLaunch; t += 0.25) {
        S.planeVel(t, vel);
        const speed = vel.length();
        const sin = vel.y / speed;
        // Level for four seconds: the speed has settled from the slope before.
        steady = Math.abs(sin) < 0.003 ? steady + 1 : 0;
        if (steady > 16) level = Math.max(level, Math.abs(speed - p.droneSpeed));
        const angle = (Math.asin(sin) * 180) / Math.PI;
        topUp = Math.max(topUp, angle);
        topDown = Math.min(topDown, angle);
        if (sin > 0.1) { up += 1; assert.ok(speed < p.droneSpeed, `climbing at ${speed}`); }
        if (sin < -0.08) { down += 1; assert.ok(speed > p.droneSpeed, `descending at ${speed}`); }
        S.planePose(t, pos, q);
        nose.set(0, 0, 1).applyQuaternion(q);
        wing.set(1, 0, 0).applyQuaternion(q);
        bank = Math.max(bank, Math.abs(Math.asin(wing.y) * D));
        pitch = Math.max(pitch, Math.abs(Math.asin(nose.y) * D));
      }
      assert.ok(up > 10 && down > 10, `climbed ${up}, descended ${down}`);
      assert.ok(level < 1.5, `level flight is the cruise speed: off by ${level}`);
      assert.ok(Math.abs(topUp - 20) < 2, `climbs at 20 degrees over the sea: ${topUp}`);
      assert.ok(Math.abs(topDown + 20) < 2, `descends at 20 degrees over the sea: ${topDown}`);
      // 45 degrees in the turn; the ship's own speed moves it a few degrees either way.
      assert.ok(bank > 40 && bank <= 50 + 1e-6, `bank ${bank}`);
      assert.ok(pitch > 18 && pitch <= 21.5, `pitch ${pitch}`);
    });

    it(`${variant}: recovery flies the plan and ends under the parachute`, async () => {
      const { S } = await fly(variant, 'chute', { engage: 900, turnBack: 2000 });
      const sc = S.scenario;
      assert.equal(sc.hasMissile, false);
      assert.ok(Number.isFinite(sc.tChute) && sc.tSplash > sc.tChute);
      assert.ok(sc.tLock < sc.tChute);
      assert.ok(Math.abs(S.droneRange(sc.tLock) - 900) < 20, `lock-on at ${S.droneRange(sc.tLock)}`);
      assert.ok(S.droneRange(sc.tLock + 1) < S.droneRange(sc.tLock), 'on the way in');
    });
  }

  it('a drawn path is only flown when the plan says so', async () => {
    const stored = { points: [[100, 100, -100], [500, 200, -300], [1500, 250, -300], [1800, 250, 0], [1000, 250, 0], [300, 250, 0]] };
    const store = new Map();
    globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) };
    store.set('intercept.path.v2', JSON.stringify(stored));
    try {
      const a = (await fly('fwd', 'intercept')).S;
      assert.equal(a.CUSTOM_PATH, false);
      const b = (await fly('fwd', 'intercept', { drawn: true })).S;
      assert.equal(b.CUSTOM_PATH, true);
      assert.deepEqual(b.ACTIVE_PATH, stored.points);
    } finally {
      delete globalThis.localStorage;
    }
  });

  it('without a plan nothing changes', async () => {
    delete globalThis.__PLAN;
    globalThis.__SHIP_VARIANT = 'fwd';
    globalThis.__SCENARIO = 'intercept';
    const S = await import(`../src/scenario.js?plan=${++seq}`);
    assert.equal(S.SHIP_SPEED, 7);
    assert.equal(S.scenario.launchRange, 650);
    assert.equal(S.scenario.plan, null);
    assert.equal(S.DEFAULT_PATH[0].join(), '1,32,-64');
  });
});

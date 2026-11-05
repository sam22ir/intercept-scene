// The mission plan: the settings of the Watch missions' start window and the path generated from them (src/missionPlan.js),
// and the scenario flown from them: the drone goes ahead of the forward launcher and astern of the aft one, turns back
// where it is told, the missile leaves at the engagement distance on the run in, and the speed is the cruise speed in level
// flight, less going up and more coming down.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  MAX_KEYS, PATH_LIMIT, PLAN_DEFAULTS, PLAN_RANGES, RAIL_END, RECOVERY_AT, clampKey, detectKeys, flyRoute, generatePath, keyManoeuvre, linkRanges, planEngage, planSky, planStats, relSpeed, speedAtSlope, turnRadius, validateKeys, validatePlan,
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
  { alt: 1000, runAlt: 1000, turnBack: 15000, engage: 1500 },
  { alt: 1000, runAlt: 100, turnBack: 15000, engage: 400, shipKn: 30 },
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
    assert.equal(validatePlan({ tod: 'night' }).tod, 'night');
    assert.deepEqual(planSky(plan({ tod: 'night' })), { elev: 40, az: -110, night: true }, 'night is the moon, and only night says so');
    assert.equal(planSky(plan({ tod: 'dusk' })).night, undefined);
    assert.equal(planSky(plan({ tod: 'noon' })).day, true, 'noon wears the calm daylight');
    assert.equal(planSky(plan({ tod: 'dawn' })).day, undefined);
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
            assert.ok(Math.abs(q[0]) <= PATH_LIMIT && Math.abs(q[2]) <= PATH_LIMIT && q[1] >= 8 && q[1] <= p.alt, `in bounds: ${q}`);
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

  it('stays on the launcher\'s side whatever the window asks: a turn back too short for the ship\'s speed gives way, and says so', () => {
    for (const variant of VARIANTS) {
      const ahead = variant === 'aft' ? -1 : 1;
      for (const mode of ['intercept', 'chute']) {
        for (const turnBack of [800, 1000, 1200]) {
          for (const shipKn of [5, 14, 30]) {
            for (const [alt, runAlt] of [[250, 40], [250, 250], [1000, 250]]) {
              const p = plan({ turnBack, shipKn, alt, runAlt, engage: 200 });
              const path = generatePath(p, { variant, mode });
              const what = `${variant} ${mode} ${JSON.stringify({ turnBack, shipKn, alt, runAlt })}`;
              const out = Math.max(...path.points.map((q) => q[0] * ahead));
              const back = Math.max(...path.points.map((q) => -q[0] * ahead));
              assert.ok(back <= 300 && out > back + 300, `${what}: out ${out}, the wrong way ${back}`);
              assert.equal(path.notes.some((n) => n.key === 'turnBack'), Math.abs(path.turnBack - turnBack) > 50, what);
            }
          }
        }
      }
    }
  });

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

describe('the turn-back and engagement sliders move each other', () => {
  for (const variant of VARIANTS) {
    for (const mode of ['intercept', 'chute']) {
      const opts = { variant, mode };
      it(`${variant} ${mode}: more engagement takes the turn back out, and the engagement then holds`, () => {
        for (const shipKn of [5, 14, 30]) {
          for (const engage of [650, 1000, 1500]) {
            const out = linkRanges(plan({ turnBack: 800, engage, shipKn }), 'engage', opts);
            assert.equal(out.engage, engage, 'the slider being moved keeps its value');
            assert.equal(generatePath(out, opts).engage, engage, `${JSON.stringify(out)} holds`);
          }
        }
      });

      it(`${variant} ${mode}: a shorter turn back brings the engagement in, on the slider's steps`, () => {
        for (const shipKn of [5, 14, 30]) {
          const out = linkRanges(plan({ turnBack: 800, engage: 1500, shipKn }), 'turnBack', opts);
          assert.equal(out.turnBack, 800, 'the slider being moved keeps its value');
          assert.ok(out.engage < 1500 && out.engage % PLAN_RANGES.engage[2] === 0, `engage ${out.engage}`);
          // At the slider's minimum a very fast ship can still leave less room than that: the window's note says so.
          const path = generatePath(out, opts);
          if (out.engage > PLAN_RANGES.engage[0]) assert.equal(path.engage, out.engage, `${JSON.stringify(out)} holds`);
          else assert.equal(path.notes.some((n) => n.key === 'engage'), path.engage < out.engage);
        }
      });
    }
  }

  it('leaves them alone when the engagement already fits, and other settings alone always', () => {
    const p = plan();
    assert.deepEqual(linkRanges(p, 'engage'), p);
    assert.deepEqual(linkRanges(p, 'turnBack'), p);
    const far = plan({ turnBack: 800, engage: 1500 });
    assert.deepEqual(linkRanges(far, 'alt'), far);
  });
});

describe('the settings\' ranges reach what the owner asked', () => {
  it('1000 m of altitude and 15 km to the turn back', () => {
    assert.equal(PLAN_RANGES.alt[1], 1000);
    assert.equal(PLAN_RANGES.turnBack[1], 15000);
    assert.equal(validatePlan({ turnBack: 15000 }).turnBack, 15000);
  });

  it('with the room to climb, 1000 m really is flown, and nothing says otherwise', () => {
    const p = plan({ alt: 1000, runAlt: 1000, turnBack: 5000, engage: 650 });
    for (const variant of VARIANTS) {
      const path = generatePath(p, { variant });
      assert.equal(path.alt, 1000);
      assert.equal(Math.max(...path.points.map((q) => q[1])), 1000);
      assert.deepEqual(path.notes, []);
    }
  });

  it('without the room, the note says how high it gets', () => {
    const path = generatePath(plan({ alt: 1000, runAlt: 1000, turnBack: 800, engage: 650 }));
    const note = path.notes.find((n) => n.key === 'alt');
    assert.ok(note && note.value < 1000, JSON.stringify(path.notes));
    assert.ok(Math.abs(Math.max(...path.points.map((q) => q[1])) - note.value) <= 1);
  });

  it('15 km out: the distance is met, the points fit the editor and the limits, and the far end is on the launcher\'s side', () => {
    for (const variant of VARIANTS) {
      const path = generatePath(plan({ turnBack: 15000 }), { variant });
      assert.ok(Math.abs(path.turnBack - 15000) <= 50, `${variant}: ${path.turnBack}`);
      assert.equal(path.notes.some((n) => n.key === 'turnBack'), false);
      assert.ok(path.points.length <= 80);
      assert.ok(path.points.every((q) => Math.abs(q[0]) < PATH_LIMIT && Math.abs(q[2]) < PATH_LIMIT));
      const ahead = variant === 'aft' ? -1 : 1;
      assert.ok(path.keys[0][0] * ahead > 14000);
    }
  });
});

describe('the manoeuvre points', () => {
  const speeds = { droneSpeed: 75, ship: 7 };
  // Plan-view heading change per metre, and slope over the sea, sampled along a flown route.
  const seaBank = (route) => {
    const banks = [];
    const p = route.marks;
    for (let i = 2; i < p.length; i++) {
      const v = (a, b) => { const dt = Math.hypot(b.x - a.x, b.z - a.z) / 75; return [(b.x - a.x) / dt + 7, (b.z - a.z) / dt]; };
      const u = v(p[i - 2], p[i - 1]);
      const w = v(p[i - 1], p[i]);
      const turn = Math.atan2(u[1] * w[0] - u[0] * w[1], u[0] * w[0] + u[1] * w[1]);
      banks.push({ turn, s: p[i].s - p[i - 2].s });
    }
    return banks;
  };

  it('a generated path has only a few, and each is where a manoeuvre starts', () => {
    for (const variant of VARIANTS) {
      for (const mode of ['intercept', 'chute']) {
        const path = generatePath(plan({ alt: 400, runAlt: 150, turnBack: 3000 }), { variant, mode });
        assert.ok(path.keys.length <= 5, `${variant} ${mode}: ${path.keys.length} points`);
        const route = flyRoute(path.keys, { droneSpeed: 75, ship: plan().shipKn * 0.514444 });
        const first = keyManoeuvre(path.keys, route, 0);
        assert.equal(first.turn, true, 'the first point starts the turn back');
        assert.equal(keyManoeuvre(path.keys, route, path.keys.length - 1).last, true);
        assert.ok(path.keys.some((_, i) => keyManoeuvre(path.keys, route, i).alt === 'down'), 'one starts the descent');
      }
    }
  });

  it('the path is what the points fly, so opening the editor changes nothing', () => {
    const p = plan({ turnBack: 2500 });
    const path = generatePath(p);
    assert.deepEqual(flyRoute(path.keys, { droneSpeed: p.droneSpeed, ship: p.shipKn * 0.514444 }).points.at(-1), path.points.at(-1));
    assert.deepEqual(flyRoute(path.keys, { droneSpeed: p.droneSpeed, ship: p.shipKn * 0.514444 }).points, path.points);
  });

  it('flies a moved point at the same rules: a level turn holds one radius, a climb 20 degrees', () => {
    const keys = [[1500, 300, -800], [2500, 300, 300], [600, 100, 200], [100, 100, 0]];
    const route = flyRoute(keys, speeds);
    assert.deepEqual(route.notes, []);
    assert.ok(route.points.length <= 80);
    keys.forEach((k, i) => assert.ok(route.points.some((q) => q[0] === k[0] && q[2] === k[2]), `passes through point ${i + 1}`));
    // The climb: height gained per metre flown over the sea.
    const m = route.marks;
    const up = m.findIndex((q) => q.h > 100);
    const a = m[up];
    const b = m[up + 1];
    const seaRun = Math.hypot(b.x - a.x, b.z - a.z);
    assert.ok(Math.atan2(b.h - a.h, seaRun) * 57.3 < 26 && Math.atan2(b.h - a.h, seaRun) * 57.3 > 14);
    assert.ok(seaBank(route).some((x) => Math.abs(x.turn) > 0.1), 'it does turn');
  });

  it('a point too close for the turn is flown at straight, and said', () => {
    const route = flyRoute([[2000, 100, -800], [2005, 100, -790], [100, 100, 0]], speeds);
    assert.ok(route.points.length > 3);
    assert.ok(route.notes.every((n) => n.key === 'tight' || n.key === 'steep'));
  });

  it('says when an altitude cannot be reached by the next point at 20 degrees', () => {
    const route = flyRoute([[300, 900, -100], [500, 100, -100], [100, 100, 0]], speeds);
    const note = route.notes.find((n) => n.key === 'steep' && n.index === 0);
    assert.ok(note && note.value < 900, JSON.stringify(route.notes));
  });

  it('keeps the launcher\'s side, except the recovery\'s last point', () => {
    assert.equal(clampKey([-500, 100, 0], 0, 3, { variant: 'fwd' })[0], 100);
    assert.equal(clampKey([500, 100, 0], 0, 3, { variant: 'aft' })[0], -100);
    assert.equal(clampKey([-212, 90, -212], 2, 3, { variant: 'fwd', mode: 'chute' })[0], -212);
    assert.equal(clampKey([-212, 90, -212], 1, 3, { variant: 'fwd', mode: 'chute' })[0], 100);
    assert.equal(clampKey([500, 5000, 0], 0, 3, {})[1], 1000);
    assert.equal(clampKey([500, 1, 0], 0, 3, {})[1], 8);
    assert.equal(clampKey([1e7, 100, -1e7], 0, 3, {})[0], PATH_LIMIT);
  });

  it('checks a stored list', () => {
    assert.deepEqual(validateKeys([[1.2, 100.4, -3]]), [[1, 100, -3]]);
    assert.equal(validateKeys([]), null);
    assert.equal(validateKeys('x'), null);
    assert.equal(validateKeys([[1, 2]]), null);
    assert.equal(validateKeys(Array(MAX_KEYS + 1).fill([1, 100, 1])), null);
    assert.equal(validateKeys([[PATH_LIMIT + 1, 100, 0]]), null);
  });

  it('finds the points of a path that has none stored, however many it was drawn with', () => {
    const path = generatePath(plan({ alt: 400, runAlt: 150, turnBack: 3000 }));
    const keys = detectKeys(path.points);
    assert.ok(keys.length >= 2 && keys.length <= MAX_KEYS, `${keys.length}`);
    assert.deepEqual(keys.at(-1), path.points.at(-1));
    assert.deepEqual(detectKeys([[100, 50, 0]]), [[100, 50, 0]]);
  });

  it('the track never crosses itself on the sea (the crowded picture was the view, not the path)', () => {
    const cross = (a, b, c, d) => {
      const o = (p, q, r) => (q[0] - p[0]) * (r[2] - p[2]) - (q[2] - p[2]) * (r[0] - p[0]);
      return o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0;
    };
    for (const variant of VARIANTS) {
      for (const turnBack of [1600, 3000, 15000]) {
        const all = [RAIL_END, ...generatePath(plan({ turnBack }), { variant }).points];
        for (let i = 1; i < all.length; i++) {
          for (let j = i + 2; j < all.length; j++) assert.equal(cross(all[i - 1], all[i], all[j - 1], all[j]), false, `${variant} ${turnBack}: legs ${i} and ${j}`);
        }
      }
    }
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
        // Level for six seconds: the speed has settled from the slope before (it follows with a 2 s lag).
        steady = Math.abs(sin) < 0.003 ? steady + 1 : 0;
        if (steady > 24) level = Math.max(level, Math.abs(speed - p.droneSpeed));
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
      assert.ok(bank > 40 && bank <= 50 + 1e-6, `bank ${bank}`);
      // A little over 20 for the seconds it enters a descent, before the speed has built up.
      assert.ok(pitch > 18 && pitch <= 22, `pitch ${pitch}`);
    });

    for (const shipKn of [14, 30]) {
      it(`${variant} at ${shipKn} kn: the bank holds at 45 degrees through the turn back`, async () => {
        const { S } = await fly(variant, 'intercept', { shipKn, turnBack: 2500 });
        const sc = S.scenario;
        const pos = new THREE.Vector3();
        const q = new THREE.Quaternion();
        const wing = new THREE.Vector3();
        const banks = [];
        const bankAt = (t) => {
          S.planePose(t, pos, q);
          wing.set(1, 0, 0).applyQuaternion(q);
          return Math.abs(Math.asin(wing.y) * 180 / Math.PI);
        };
        // The aft launcher's first swing round off the rail is a real turn too: about 45 degrees, at the climb's speed.
        if (variant === 'aft') {
          const swing = [];
          for (let t = sc.tRelease + 4; t < sc.tRelease + 9; t += 0.25) swing.push(bankAt(t));
          assert.ok(Math.min(...swing) > 40 && Math.max(...swing) < 50, `first swing ${Math.min(...swing).toFixed(1)} to ${Math.max(...swing).toFixed(1)}`);
        }
        // From after that swing.
        for (let t = sc.tRelease + 25; t < sc.tLaunch; t += 0.1) banks.push(bankAt(t));
        // The turn itself, leaving out the seconds it rolls in and out.
        const inTurn = banks.filter((b) => b > 20).sort((a, b) => a - b);
        const mid = inTurn.slice(Math.floor(inTurn.length * 0.25));
        assert.ok(inTurn.length > 200, `a real turn: ${inTurn.length} samples`);
        const typical = mid[Math.floor(mid.length / 2)];
        assert.ok(Math.abs(typical - 45) < 1, `typically ${typical.toFixed(1)} degrees`);
        assert.ok(mid[0] > 41 && mid.at(-1) < 47, `${mid[0].toFixed(1)} to ${mid.at(-1).toFixed(1)} degrees`);
        // And it rolls: no sudden jumps, and level on the straights.
        for (let i = 1; i < banks.length; i++) assert.ok(Math.abs(banks[i] - banks[i - 1]) < 3, `a jump of ${Math.abs(banks[i] - banks[i - 1]).toFixed(1)} degrees in 0.1 s`);
        assert.ok(banks.slice(0, 40).every((b) => b < 5), 'level on the way out');
      });
    }

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

  it('the editor\'s flight time is the real one, for the path flown and for a path it has not flown', async () => {
    for (const variant of VARIANTS) {
      for (const turnBack of [1600, 6000]) {
        const { S } = await fly(variant, 'intercept', { turnBack });
        const real = S.scenario.tPathEnd - S.scenario.tRelease;
        const shown = S.pathTiming(S.ACTIVE_PATH);
        assert.ok(Math.abs(shown.flight - real) < 1, `${variant} ${turnBack}: shown ${shown.flight}, flown ${real}`);
        assert.ok(Math.abs(shown.at(0) - S.scenario.tRelease) < 0.2);
      }
    }
  });

  it('15 km out: flown, and the missile still leaves on the run in, and hits', async () => {
    for (const variant of VARIANTS) {
      const { S } = await fly(variant, 'intercept', { turnBack: 15000, alt: 1000, runAlt: 300, engage: 1200 });
      const sc = S.scenario;
      assert.ok(Math.max(...Array.from({ length: 200 }, (_, i) => S.droneRange(sc.tRelease + ((sc.tLaunch - sc.tRelease) * i) / 200))) > 15000);
      assert.ok(Math.abs(S.droneRange(sc.tLaunch) - 1200) < 20, `launched at ${S.droneRange(sc.tLaunch)}`);
      assert.ok(S.droneRange(sc.tLaunch + 0.5) < S.droneRange(sc.tLaunch), 'closing');
      assert.ok(Number.isFinite(sc.tHit) && sc.interceptMiss === 0, 'it hits');
      assert.ok(Math.abs(sc.hitPos.y - 300) < 25, `at the run's height: ${sc.hitPos.y}`);
    }
  });

  it('a stored path keeps its manoeuvre points, and one from before them still flies', async () => {
    const keys = [[1500, 300, -800], [800, 300, 0], [100, 300, 0]];
    const points = flyRoute(keys, { droneSpeed: 75, ship: 14 * 0.514444 }).points;
    const store = new Map();
    globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) };
    try {
      store.set('intercept.path.v2', JSON.stringify({ points, keys }));
      const a = (await fly('fwd', 'intercept', { drawn: true })).S;
      assert.deepEqual(a.ACTIVE_KEYS, keys);
      assert.ok(a.scenario.customPath);
      assert.ok(a.scenario.interceptMiss === 0 && Number.isFinite(a.scenario.tHit));
      store.set('intercept.path.v2', JSON.stringify({ points }));
      const b = (await fly('fwd', 'intercept', { drawn: true })).S;
      assert.equal(b.ACTIVE_KEYS, null);
      assert.deepEqual(b.ACTIVE_PATH, points);
    } finally {
      delete globalThis.localStorage;
    }
  });

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

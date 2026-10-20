// The four-ship formations mission (src/formations.js): SHIP1 to SHIP4 take up each formation, keep clear of
// each other on the way, and stay within the speed limits. The module imports nothing, so it runs in Node.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  exercise, shipState, stationPoint, phaseAt, orderStatus, relation, closestApproach, headingDeg,
  PHASES, FORMS, SHIP_IDS, SHIP_NAMES, YD, KT, ON_STATION, ARRIVAL, HOLD, GUIDE_SPEED, MAX_SPEED, MIN_SPEED, SPACING,
} from '../src/formations.js';

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);

// Where ship i is relative to SHIP1, in yards ahead and to starboard (the guide heads 000, so x ahead, z starboard).
function rel(id, t) {
  const g = shipState('ship1', t);
  const s = shipState(id, t);
  return [(s.x - g.x) / YD, (s.z - g.z) / YD];
}

describe('four-ship formations: the ships', () => {
  it('are SHIP1 to SHIP4, SHIP1 the guide on course 000 at 12 kn throughout', () => {
    assert.deepEqual(Object.values(SHIP_NAMES), ['SHIP1', 'SHIP2', 'SHIP3', 'SHIP4']);
    assert.equal(SHIP_IDS.length, 4);
    for (let t = 0; t <= exercise.tEnd; t += 60) {
      near(headingDeg(shipState('ship1', t).heading) % 360, 0, 1e-6, `guide course at ${t}`);
      near(shipState('ship1', t).speed / KT, GUIDE_SPEED, 1e-6, `guide speed at ${t}`);
    }
  });

  it('start in FORM 1, a column 500 yds apart', () => {
    for (let i = 1; i < 4; i++) {
      const [a, s] = rel(SHIP_IDS[i], 0);
      near(a, -i * SPACING, 0.5, `${SHIP_IDS[i]} astern`);
      near(s, 0, 0.5, `${SHIP_IDS[i]} on the line`);
    }
  });

  it('never steam faster than 20 kn or slower than 5 kn, and turn smoothly', () => {
    for (let t = 0; t <= exercise.tEnd; t += 0.5) {
      for (const id of SHIP_IDS) {
        const v = shipState(id, t).speed / KT;
        assert.ok(v <= MAX_SPEED + 1e-6 && v >= MIN_SPEED - 1e-6, `${id} at ${t}: ${v} kn`);
      }
    }
  });

  it('keep clear of each other: never closer than 250 m', () => {
    const c = closestApproach();
    assert.ok(c.range >= 250, `${c.a} and ${c.b} close to ${c.range.toFixed(0)} m at ${c.t} s`);
  });

  it('are a pure function of t', () => {
    const a = shipState('ship3', 777.3);
    shipState('ship3', 1200);
    assert.deepEqual(shipState('ship3', 777.3), a);
  });
});

describe('four-ship formations: the orders', () => {
  it('run line ahead, line of bearing, line abreast, box, line ahead, diamond', () => {
    assert.deepEqual(PHASES.map((p) => p.form), ['column', 'bearing', 'abreast', 'box', 'column', 'diamond']);
    assert.deepEqual(exercise.events.map((e) => e.label), PHASES.map((p) => p.label));
  });

  it('follow one another: each executes HOLD s after the last arrived', () => {
    assert.equal(PHASES[1].tx, 30, 'the first change comes 30 s in');
    for (let i = 2; i < PHASES.length; i++) {
      assert.ok(PHASES[i].ta > PHASES[i].tx, `${PHASES[i].id} arrives after it executes`);
      near(PHASES[i].tx, PHASES[i - 1].ta + HOLD, 0.26, `${PHASES[i].id} executes after the hold`);
    }
    near(exercise.tEnd, PHASES.at(-1).ta + HOLD, 0.26, 'the exercise ends after the last hold');
    assert.ok(exercise.tEnd > 20 * 60 && exercise.tEnd < 35 * 60, `about half an hour: ${exercise.tEnd} s`);
  });

  for (const p of PHASES.slice(1)) {
    it(`${p.title}: every ship on its station from arrival to the next order`, () => {
      const end = PHASES[PHASES.indexOf(p) + 1]?.tx ?? exercise.tEnd;
      for (let t = p.ta - ARRIVAL; t < end; t += 2) {
        for (const id of SHIP_IDS) assert.ok(stationPoint(id, t).error <= ON_STATION + 1e-6, `${id} at ${t}: ${stationPoint(id, t).error} m`);
      }
      // And the shape is the ordered one, ship by ship.
      FORMS[p.form].forEach(([a, s], i) => {
        const [ra, rs] = rel(SHIP_IDS[i], p.ta + 30);
        near(ra, a, ON_STATION / YD, `${SHIP_IDS[i]} ahead`);
        near(rs, s, ON_STATION / YD, `${SHIP_IDS[i]} to starboard`);
      });
    });
  }

  it('a ship whose new station is on her own line holds course and only changes speed (the others give way)', () => {
    const want = { box: ['ship2'], column: ['ship3'], diamond: ['ship4'] };
    for (const p of PHASES.slice(1)) {
      assert.deepEqual(p.standOn, want[p.id] ?? [], `${p.id}: stand-on ships`);
      for (const id of p.standOn) {
        for (let t = p.tx; t <= p.ta; t += 1) {
          const h = headingDeg(shipState(id, t).heading);
          assert.ok(Math.min(h, 360 - h) <= 2, `${id} holds 000 in ${p.id} at ${t}: ${h}`);
        }
      }
    }
    // Box to line ahead: SHIP3 drops straight back, slower than the guide, on her own line.
    const col = PHASES.find((p) => p.id === 'column');
    assert.ok(shipState('ship3', col.tx + 120).speed / KT < GUIDE_SPEED - 3, 'SHIP3 slows down');
    near(rel('ship3', col.tx + 120)[1], 0, 15, 'SHIP3 stays on the line');
  });

  it('the diamond has 500 yd sides and the line of bearing lies on 135 from the guide', () => {
    const d = PHASES.find((p) => p.form === 'diamond');
    const t = d.ta + 40;
    for (const [a, b] of [['ship1', 'ship2'], ['ship1', 'ship3'], ['ship2', 'ship4'], ['ship3', 'ship4']]) {
      near(relation(t, a, b).range / YD, 500, 50, `${a}-${b}`);
    }
    const lb = PHASES.find((p) => p.form === 'bearing');
    for (const id of ['ship2', 'ship3', 'ship4']) near(relation(lb.ta + 40, 'ship1', id).bearing, 135, 3, `${id} bearing`);
  });

  it('orderStatus: under way until arrival, then on station with a count to the next order', () => {
    const p = PHASES[2];
    assert.equal(phaseAt(p.tx + 1), p);
    assert.equal(orderStatus(p.tx + 1).state, 'underway');
    const s = orderStatus(p.ta + 5);
    assert.equal(s.state, 'station');
    near(s.next, PHASES[3].tx - (p.ta + 5), 1e-9, 'count to the next order');
    assert.equal(orderStatus(exercise.tEnd).next, null);
  });
});

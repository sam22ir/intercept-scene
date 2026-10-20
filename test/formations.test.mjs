// The four-ship formations mission (src/formations.js): SHIP1 to SHIP4 take up each formation, wheel (CORPEN) and
// turn together (TURN) between them, keep clear of each other, and stay within the speed limits. The module
// imports nothing, so it runs in Node.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  exercise, shipState, stationPoint, phaseAt, orderStatus, relation, closestApproach, headingDeg,
  PHASES, FORMS, SHIP_IDS, SHIP_NAMES, KT, ON_STATION, ON_COURSE, ARRIVAL, HOLD, GUIDE_SPEED, MAX_SPEED, MIN_SPEED, SPACING, SCALE, orderedYd,
} from '../src/formations.js';

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);
const angGap = (a, b) => Math.abs(((a - b + 540) % 360) - 180);
const P = Object.fromEntries(PHASES.map((p) => [p.id, p]));
const FOLLOWERS = ['ship2', 'ship3', 'ship4'];

// Where a ship is relative to SHIP1 in ordered yards [ahead, starboard] on a given axis (deg).
function rel(id, t, axis) {
  const g = shipState('ship1', t);
  const s = shipState(id, t);
  const c = Math.cos(axis * Math.PI / 180);
  const sn = Math.sin(axis * Math.PI / 180);
  const dx = orderedYd(s.x - g.x);
  const dz = orderedYd(s.z - g.z);
  return [dx * c + dz * sn, -dx * sn + dz * c];
}

describe('four-ship formations: the ships', () => {
  it('are SHIP1 to SHIP4, SHIP1 the guide at 12 kn throughout', () => {
    assert.deepEqual(Object.values(SHIP_NAMES), ['SHIP1', 'SHIP2', 'SHIP3', 'SHIP4']);
    for (let t = 0; t <= exercise.tEnd; t += 30) near(shipState('ship1', t).speed / KT, GUIDE_SPEED, 1e-6, `guide speed at ${t}`);
  });

  it('start in FORM 1, a column 500 yds apart heading 000', () => {
    for (let i = 1; i < 4; i++) {
      const [a, s] = rel(SHIP_IDS[i], 0, 0);
      near(a, -i * SPACING, 0.5, `${SHIP_IDS[i]} astern`);
      near(s, 0, 0.5, `${SHIP_IDS[i]} on the line`);
    }
  });

  it('never steam faster than 20 kn or slower than 5 kn', () => {
    for (let t = 0; t <= exercise.tEnd; t += 0.5) {
      for (const id of SHIP_IDS) {
        const v = shipState(id, t).speed / KT;
        assert.ok(v <= MAX_SPEED + 1e-6 && v >= MIN_SPEED - 1e-6, `${id} at ${t}: ${v} kn`);
      }
    }
  });

  it('keep clear of each other: never closer than 250 ordered yards (half the station spacing)', () => {
    const c = closestApproach();
    assert.ok(orderedYd(c.range) >= 250, `${c.a} and ${c.b} close to ${orderedYd(c.range).toFixed(0)} yd at ${c.t} s`);
  });

  it('sail closer on the sea than the ordered distances: one ordered yard is SCALE yards, and every readout is in ordered yards', () => {
    assert.ok(SCALE > 0 && SCALE < 1);
    near(relation(30, 'ship1', 'ship2').range, SPACING * 0.9144 * SCALE, 0.5, 'the column on the sea');
    near(orderedYd(relation(30, 'ship1', 'ship2').range), SPACING, 0.5, 'and 500 yds as shown');
  });

  it('are a pure function of t', () => {
    const a = shipState('ship3', 777.3);
    shipState('ship3', 1200);
    assert.deepEqual(shipState('ship3', 777.3), a);
  });
});

describe('four-ship formations: the orders', () => {
  it('formations with wheels and turns together between them', () => {
    assert.deepEqual(PHASES.map((p) => p.label), [
      'FORM 1', 'CORPEN STBD 9', 'FORM 225', 'FORM 3', 'TURN PORT 9', 'TURN STBD 9', 'BOX', 'CORPEN PORT 9', 'FORM 1', 'FORM D', 'CORPEN STBD 9',
    ]);
    assert.deepEqual([...new Set(PHASES.filter((p) => p.kind === 'form').map((p) => p.form))].sort(), ['abreast', 'bearing', 'box', 'column', 'diamond']);
    assert.deepEqual(exercise.events.map((e) => e.label), PHASES.map((p) => p.label));
  });

  it('follow one another: each executes HOLD s after the last arrived', () => {
    assert.equal(PHASES[1].tx, 30, 'the first order comes 30 s in');
    for (let i = 2; i < PHASES.length; i++) {
      assert.ok(PHASES[i].ta > PHASES[i].tx, `${PHASES[i].id} arrives after it executes`);
      near(PHASES[i].tx, PHASES[i - 1].ta + HOLD, 0.26, `${PHASES[i].id} executes after the hold`);
    }
    near(exercise.tEnd, PHASES.at(-1).ta + HOLD, 0.26, 'the exercise ends after the last hold');
  });

  for (const p of PHASES.slice(1)) {
    it(`${p.title}: every ship on station and on course ${String(p.course).padStart(3, '0')} from arrival to the next order`, () => {
      const end = PHASES[PHASES.indexOf(p) + 1]?.tx ?? exercise.tEnd;
      for (let t = p.ta - ARRIVAL; t < end; t += 2) {
        for (const id of SHIP_IDS) {
          assert.ok(stationPoint(id, t).error <= ON_STATION + 1e-6, `${id} at ${t}: ${stationPoint(id, t).error} m`);
          assert.ok(angGap(headingDeg(shipState(id, t).heading), p.course) <= ON_COURSE + 1e-6, `${id} on course at ${t}`);
        }
      }
    });
  }

  for (const p of PHASES.filter((x) => x.kind === 'form' && x.id !== 'start')) {
    it(`${p.title}: the shape is the ordered one on course ${String(p.course).padStart(3, '0')}`, () => {
      FORMS[p.form].forEach(([a, s], i) => {
        const [ra, rs] = rel(SHIP_IDS[i], p.ta + 30, p.course);
        near(ra, a, orderedYd(ON_STATION), `${SHIP_IDS[i]} ahead`);
        near(rs, s, orderedYd(ON_STATION), `${SHIP_IDS[i]} to starboard`);
      });
    });
  }

  it('FORM 225: the line of bearing lies on 225 from the guide (her starboard quarter on 090); the diamond has 500 yd sides', () => {
    assert.equal(P.bearing.course, 90);
    for (const id of FOLLOWERS) near(relation(P.bearing.ta + 40, 'ship1', id).bearing, 225, 3, `${id} bearing`);
    for (const [a, b] of [['ship1', 'ship2'], ['ship1', 'ship3'], ['ship2', 'ship4'], ['ship3', 'ship4']]) {
      near(orderedYd(relation(P.diamond.ta + 40, a, b).range), 500, 50, `diamond ${a}-${b}`);
    }
  });

  it('a ship whose new station is on her own line holds course and only changes speed (the others give way)', () => {
    const want = { box: ['ship2'], column: ['ship3'], diamond: ['ship4'] };
    for (const p of PHASES.slice(1)) {
      assert.deepEqual(p.standOn, want[p.id] ?? [], `${p.id}: stand-on ships`);
      for (const id of p.standOn) {
        for (let t = p.tx; t <= p.ta; t += 1) assert.ok(angGap(headingDeg(shipState(id, t).heading), p.course) <= 2, `${id} holds ${p.course} in ${p.id} at ${t}`);
      }
    }
    let slowest = Infinity;
    for (let t = P.column.tx; t <= P.column.ta; t += 1) slowest = Math.min(slowest, shipState('ship3', t).speed / KT);
    assert.ok(slowest < GUIDE_SPEED - 3, `SHIP3 slows down from box to column (to ${slowest.toFixed(1)} kn)`);
  });

  it("a ship whose station is across a stand-on ship's track holds her course until that ship has passed, then turns in", () => {
    assert.deepEqual(P.column.waits, [{ ship: 'ship4', for: 'ship3' }], 'box to column: SHIP4 waits for SHIP3');
    assert.deepEqual(P.box.waits, [{ ship: 'ship3', for: 'ship2' }, { ship: 'ship4', for: 'ship2' }], 'into the box: SHIP3 and SHIP4 wait for SHIP2');
    for (const p of PHASES) {
      for (const w of p.waits) {
        // Until she is 250 yds past the stand-on ship along the course, she keeps the course.
        let t = p.tx;
        for (; t <= p.ta; t += 1) {
          const astern = orderedYd(shipState(w.for, t).x - shipState(w.ship, t).x) * Math.cos(p.course * Math.PI / 180)
            + orderedYd(shipState(w.for, t).z - shipState(w.ship, t).z) * Math.sin(p.course * Math.PI / 180);
          if (astern >= 249) break;
          assert.ok(angGap(headingDeg(shipState(w.ship, t).heading), p.course) <= 2, `${p.id}: ${w.ship} holds ${p.course} at ${t}`);
        }
        assert.ok(t < p.ta, `${p.id}: ${w.ship} gets past ${w.for} before the formation arrives`);
        // ...and then she turns in.
        let turned = false;
        for (; t <= p.ta; t += 1) if (angGap(headingDeg(shipState(w.ship, t).heading), p.course) > 10) turned = true;
        assert.ok(turned, `${p.id}: ${w.ship} turns in once ${w.for} has passed`);
      }
    }
  });

  it('TURN: all four turn at the same moment and the true bearings between them do not change', () => {
    for (const p of [P.turnport, P.turnstbd]) {
      for (const id of FOLLOWERS) {
        const b0 = relation(p.tx, 'ship1', id);
        for (let t = p.tx; t <= p.ta; t += 1) {
          const b = relation(t, 'ship1', id);
          assert.ok(angGap(b.bearing, b0.bearing) <= 0.5 && Math.abs(b.range - b0.range) <= 5, `${p.id}: ${id} at ${t}`);
          assert.ok(angGap(headingDeg(shipState(id, t).heading), headingDeg(shipState('ship1', t).heading)) <= 0.5, `${p.id}: ${id} turns with the guide`);
        }
      }
    }
    // The line abreast on 090 turned together to port 9 is a column on 000, SHIP1 leading.
    for (const [i, id] of FOLLOWERS.entries()) {
      const [a, s] = rel(id, P.turnport.ta, 0);
      near(a, -(i + 1) * SPACING, orderedYd(ON_STATION), `${id} astern after TURN PORT 9`);
      near(s, 0, orderedYd(ON_STATION), `${id} in the column`);
    }
  });

  it('CORPEN in column: each ship holds on and turns in the guide\'s wake, at the point where she turned', () => {
    const p = P.corpen1;
    const lag = (k) => (k * SPACING * 0.9144 * SCALE) / (GUIDE_SPEED * KT);
    for (const [i, id] of FOLLOWERS.entries()) {
      for (let t = p.tx + lag(i + 1); t <= p.ta; t += 2) {
        const g = shipState('ship1', t - lag(i + 1));
        const s = shipState(id, t);
        assert.ok(Math.hypot(s.x - g.x, s.z - g.z) <= 30, `${id} in the wake at ${t}`);
      }
    }
  });

  it('CORPEN in the box and the diamond: the formation wheels as one block, slowly enough for the outer ship', () => {
    for (const p of [P.corpen2, P.corpen3]) {
      assert.ok(p.rate < 1.5, `${p.id} wheels at ${p.rate} deg/s`);
      for (let t = p.tx; t <= p.ta; t += 2) for (const id of FOLLOWERS) assert.ok(stationPoint(id, t).error <= 60, `${p.id}: ${id} keeps her place at ${t}`);
    }
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

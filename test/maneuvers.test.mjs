// The naval maneuvers mission (src/maneuvers.js): the formation geometry of the briefing deck, the
// speeds it names (6, 10, 12 and 15 knots), and the order / sound timing. The module imports
// nothing, so everything runs in Node.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  exercise, shipState, SHIP_IDS, PASS_UNIT, SECTORS, inSector, relation, headingDeg, PASS, PHASES, YD, KT, FORMATION_RANGE, EXECUTE_FLASH, STATION_FLASH,
  orderStatus, lampOn, CUES, LIGHT, guideAt, stationAt, orderedAt, DEBRIEF,
} from '../src/maneuvers.js';

const P = Object.fromEntries(PHASES.map((p) => [p.id, p]));
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);
const angleNear = (a, b, tol, msg) => { const d = Math.abs(((a - b + 540) % 360) - 180); assert.ok(d <= tol, `${msg}: ${a} vs ${b}`); };
const speedKn = (id, t) => shipState(id, t).speed / KT;

describe('naval maneuvers: formation geometry', () => {
  it('starts in FORM 1: a column heading 315, SHIP1 ahead of SHIP2 by 500 yds, 12 knots', () => {
    angleNear(headingDeg(shipState('ship1', 5).heading), 315, 0.5, 'SHIP1 heading');
    angleNear(headingDeg(shipState('ship2', 5).heading), 315, 0.5, 'SHIP2 heading');
    near(speedKn('ship1', 5), 12, 0.2, 'SHIP1 speed');
    const rel = relation(5);
    near(rel.range / YD, 500, 1, 'range (yd)');
    angleNear(rel.bearing, 315, 0.5, 'bearing SHIP2 to SHIP1');
  });

  it('CORPEN STBD 4 ANS right after FORM 1 is a wheel in column: SHIP1 wheels to 000 and SHIP2 follows round in her wake', () => {
    const delay = FORMATION_RANGE / (12 * KT);
    // SHIP2 holds 315 until she reaches the point where SHIP1 turned, then turns there.
    angleNear(headingDeg(shipState('ship2', P.corpen.tx + delay - 2).heading), 315, 0.1, 'SHIP2 holds on');
    for (let t = P.corpen.tx; t <= P.corpen.ta; t += 2) {
      const a = shipState('ship1', t - delay);
      const r = shipState('ship2', t);
      near(Math.hypot(a.x - r.x, a.z - r.z), 0, 1, `SHIP2 in SHIP1's wake at +${(t - P.corpen.tx).toFixed(0)} s`);
    }
    const end = relation(P.corpen.ta + 5);
    angleNear(headingDeg(shipState('ship1', P.corpen.ta + 5).heading), 0, 0.5, 'SHIP1 on 000');
    angleNear(headingDeg(shipState('ship2', P.corpen.ta + 5).heading), 0, 0.5, 'SHIP2 on 000');
    near(end.range / YD, 500, 1, 'still 500 yds');
    angleNear(end.bearing, 0, 0.5, 'column again, SHIP2 astern');
    assert.ok(P.corpen.tx > P.station.tx && P.corpen.ta < P.stbd.t, 'between FORM 1 and TURN STBD 9');
  });

  it('turns stbd 90 together (line abreast), back to port 90 (column)', () => {
    const abreast = P.stbd.tx + 90;
    angleNear(headingDeg(shipState('ship1', abreast).heading), 90, 1, 'SHIP1 heading after TURN STBD 9');
    near(relation(abreast).range / YD, 500, 1, 'range after the turn');
    const column = P.port.tx + 90;
    angleNear(headingDeg(shipState('ship1', column).heading), 0, 1, 'SHIP1 heading after TURN PORT 9');
    angleNear(relation(column).bearing, 0, 1, 'column again');
  });

  it('G FORM SHIP2: SHIP1 slows to 6 kn, SHIP2 runs at sierra 15 kn past SHIP1 to port and takes station 500 yds ahead', () => {
    // SHIP2 passes abeam of SHIP1 on SHIP1's port side (the west), about 210 m out.
    let abeam = null;
    for (let t = P.gform.tx; t < P.gform.tx + 420; t += 1) {
      const a = shipState('ship1', t);
      const r = shipState('ship2', t);
      if (!abeam || Math.abs(r.x - a.x) < Math.abs(abeam.dx)) abeam = { t, dx: r.x - a.x, dz: r.z - a.z };
    }
    near(abeam.dz, -212, 40, 'SHIP2 passes about 210 m to port');
    near(speedKn('ship1', P.gform.tx + 150), 6, 0.3, 'SHIP1 at G speed 6');
    near(speedKn('ship2', P.gform.tx + 150), 15, 0.3, 'SHIP2 at sierra');
    const end = relation(P.gform.ta + 5);
    near(end.range / YD, 500, 2, 'range');
    angleNear(end.bearing, 180, 0.5, 'SHIP1 is astern of SHIP2');
    near(speedKn('ship1', P.gform.ta + 30), 12, 0.2, 'B speed 12 again');
  });

  it('TURN 045 keeps the station; FORM 120 puts SHIP1 on bearing 120 from SHIP2 at 10 knots', () => {
    angleNear(headingDeg(shipState('ship1', P.form120.tx - 5).heading), 45, 1, 'course 045');
    near(relation(P.form120.tx - 5).range / YD, 500, 2, 'range kept through the turn');
    const f = relation(P.form120.ta + 5);
    near(f.range / YD, 500, 4, 'range');
    angleNear(f.bearing, 120, 0.7, 'bearing 120');
    near(speedKn('ship1', P.form120.tx + 150), 10, 0.2, 'B speed 10');
    near(speedKn('ship2', P.form120.tx + 150), 6, 0.3, 'SHIP2 drops back at 6 kn');
  });

  it('the serials run at 6 knots', () => {
    near(speedKn('ship1', P.light.tx + 60), 6, 0.3, 'flashing light at G SPEED 6');
    near(speedKn('ship2', P.flags.tx + 60), 6, 0.3, 'flag hoist at G SPEED 6');
  });

  it('SHIP1 and SHIP2 never cross tracks in the formations, the screens and FORM 345 (each comes in from her own side)', () => {
    const seg = (p, q, r, s) => {
      const d = (q[0] - p[0]) * (s[1] - r[1]) - (q[1] - p[1]) * (s[0] - r[0]);
      if (!d) return false;
      const u = ((r[0] - p[0]) * (s[1] - r[1]) - (r[1] - p[1]) * (s[0] - r[0])) / d;
      const v = ((r[0] - p[0]) * (q[1] - p[1]) - (r[1] - p[1]) * (q[0] - p[0])) / d;
      return u >= 0 && u <= 1 && v >= 0 && v <= 1;
    };
    for (const id of ['fcol', 'fdia', 'fline3', 'fcol2', 'screenk', 'screenm', 'form345']) {
      const A = [];
      const R = [];
      for (let t = P[id].tx; t <= P[id].ta; t += 4) {
        const a = shipState('ship1', t);
        const r = shipState('ship2', t);
        A.push([a.x, a.z]);
        R.push([r.x, r.z]);
      }
      for (let i = 1; i < A.length; i++) for (let j = 1; j < R.length; j++) assert.ok(!seg(A[i - 1], A[i], R[j - 1], R[j]), `${id}: tracks cross`);
    }
  });

  it('the third ship, the unit, follows from behind: 1,000 yds astern of SHIP1, round the CORPEN wheel in the wake, and SHIP2 never fouls it', () => {
    assert.deepEqual(SHIP_IDS, ['ship1', 'ship2', 'unit']);
    const delay = (2 * FORMATION_RANGE) / (12 * KT);
    for (let t = Math.max(P.corpen.tx, delay + 1); t <= P.corpen.ta; t += 2) { // in SHIP1's wake through the wheel
      const a = shipState('ship1', t - delay);
      const u = shipState('unit', t);
      near(Math.hypot(a.x - u.x, a.z - u.z), 0, 1, `unit in SHIP1's wake at +${(t - P.corpen.tx).toFixed(0)} s`);
    }
    let minShip2 = Infinity;
    for (let t = 0; t < P.fcol.tx; t += 1) { // until the formations on the unit, where SHIP1 leaves her
      const a = shipState('ship1', t);
      const u = shipState('unit', t);
      if (t < P.corpen.tx || t > P.corpen.ta) {
        near(Math.hypot(u.x - a.x, u.z - a.z) / YD, 1000, 6, 'two stations from SHIP1');
        near(headingDeg(u.heading), headingDeg(a.heading), 1e-6, 'same heading');
      }
      if ((t < P.corpen.tx || t > P.corpen.ta) && t < P.stbd.tx) angleNear(headingDeg(Math.atan2(u.z - a.z, u.x - a.x)), headingDeg(a.heading) + 180, 0.5, 'astern of SHIP1 in the column');
      const r = shipState('ship2', t);
      minShip2 = Math.min(minShip2, Math.hypot(r.x - u.x, r.z - u.z));
    }
    assert.ok(minShip2 > 400, `SHIP2 passes the unit at ${minShip2.toFixed(0)} m`);
  });

  it('FORM 1, FORM D, FORM 3 and FORM 2 on the unit: each ship reaches her station, in the manual geometry', () => {
    // Station offsets are ahead and to starboard of the unit, in 500 yd lengths, on her course (090: ahead is east, starboard south).
    const rel = (id, t) => {
      const a = shipState(id, t);
      const u = shipState('unit', t);
      const fwd = (a.z - u.z) / FORMATION_RANGE; // heading 090: ahead is +z
      const stb = -(a.x - u.x) / FORMATION_RANGE; // starboard is -x
      return { fwd, stb };
    };
    const expect = {
      fcol: { ship1: [-1, 0], ship2: [-2, 0] }, // column in order: unit, SHIP1, SHIP2
      fdia: { ship1: [-Math.SQRT1_2, -Math.SQRT1_2], ship2: [-Math.SQRT1_2, Math.SQRT1_2] }, // diamond: SHIP1 port quarter, SHIP2 starboard quarter
      fline3: { ship1: [0, 1], ship2: [0, 2] }, // line abreast to starboard
      fcol2: { ship1: [1, 0], ship2: [2, 0] }, // column in reverse order: SHIP2, SHIP1, unit
    };
    for (const key of Object.keys(expect)) {
      const p = P[key];
      assert.ok(p.ta - p.tx > 40, `${key} takes time to form`);
      for (const id of ['ship1', 'ship2']) {
        const r = rel(id, p.ta + 15);
        near(r.fwd, expect[key][id][0], 0.2, `${key}: ${id} ahead`);
        near(r.stb, expect[key][id][1], 0.2, `${key}: ${id} to starboard`);
      }
    }
    // The formations are formed in this order: column, diamond (only from a column), line abreast, reversed column, then the screens.
    assert.deepEqual(PHASES.slice(8, 15).map((p) => p.id), ['fcol', 'fdia', 'fline3', 'fcol2', 'screenk', 'screenm', 'form345']); // after CORPEN: the formations, the screens, the regroup
    // The ships keep clear of each other while changing formation.
    let min = Infinity;
    for (let t = P.fcol.tx; t < P.screenk.t; t += 1) {
      const a = shipState('ship1', t);
      const r = shipState('ship2', t);
      const u = shipState('unit', t);
      min = Math.min(min, Math.hypot(a.x - r.x, a.z - r.z), Math.hypot(a.x - u.x, a.z - u.z), Math.hypot(r.x - u.x, r.z - u.z));
    }
    assert.ok(min > 150, `the closest two ships get is ${min.toFixed(0)} m`);
  });

  it('SCREEN K and SCREEN M: SHIP1 and SHIP2 reach their sectors round the unit and patrol them, the unit sailing straight on', () => {
    for (const key of ['screenk', 'screenm']) {
      const p = P[key];
      assert.ok(p.ta - p.tx > 30, `${key} takes time to reach the sectors`);
      const end = key === 'screenk' ? P.screenm.t : P.form345.tx;
      for (let t = p.ta; t < end; t += 2) {
        for (const id of ['ship1', 'ship2']) assert.ok(inSector(id, t, key), `${id} inside her ${key} sector at ${t}`);
      }
    }
    // The unit holds course 090 at 6 kn through the screens.
    for (let t = P.fcol.tx + 100; t < exercise.tEnd; t += 30) { // it slows from 12 to 6 kn as the formations begin
      const u = shipState('unit', t);
      near(headingDeg(u.heading), 90, 0.5, 'unit course');
      near(u.speed / KT, 6, 0.2, 'unit speed');
    }
    // Sectors: the manual's four-numeral groups, in tens of degrees (left, right) and thousands of yards (inner, outer).
    near(SECTORS.screenk.ship1.d1 / YD, 1500, 1e-6, 'inner depth');
    near(SECTORS.screenk.ship2.d2 / YD, 3500, 1e-6, 'outer depth');
    assert.deepEqual([SECTORS.screenk.ship2.b1, SECTORS.screenk.ship2.b2, SECTORS.screenk.ship1.b1, SECTORS.screenk.ship1.b2], [330, 30, 150, 210]); // SHIP2 to the north, SHIP1 to the south
    assert.deepEqual([SECTORS.screenm.ship2.b1, SECTORS.screenm.ship2.b2, SECTORS.screenm.ship1.b1, SECTORS.screenm.ship1.b2], [330, 0, 180, 210]);
    // The screen ships keep apart from each other and from the unit.
    let min = Infinity;
    for (let t = P.screenk.ta; t < P.form345.tx; t += 2) {
      const a = shipState('ship1', t);
      const r = shipState('ship2', t);
      const u = shipState('unit', t);
      min = Math.min(min, Math.hypot(a.x - r.x, a.z - r.z), Math.hypot(a.x - u.x, a.z - u.z), Math.hypot(r.x - u.x, r.z - u.z));
    }
    assert.ok(min > 1000, `the closest two ships get is ${min.toFixed(0)} m`);
    assert.ok(exercise.tEnd > P.screenm.ta + 60, 'the exercise runs on after the last arrival');
  });

  it('the flashing light, the flag hoist, the skim and the close pass come last, after the final FORM 1 (SHIP1 leading the unit by 500 yds, SHIP2 on 345 from SHIP1)', () => {
    assert.deepEqual(PHASES.slice(-4).map((p) => p.id), ['form345', 'light', 'flags', 'skim']);
    const f = relation(P.form345.ta + 10); // SHIP1 from SHIP2: SHIP2 is 500 yds on bearing 345 from SHIP1
    near(f.range / YD, 500, 25, 'range');
    angleNear(f.bearing, 165, 10, 'bearing');
    assert.ok(Math.abs(headingDeg(shipState('ship1', P.skim.tx).heading) - 90) < 1, 'SHIP1 on 090 as the skim begins');
    const u = shipState('unit', P.form345.ta + 10);
    const a = shipState('ship1', P.form345.ta + 10);
    near(Math.hypot(a.x - u.x, a.z - u.z) / YD, 500, 25, 'SHIP1 500 yds ahead of the unit');
    angleNear(headingDeg(Math.atan2(a.z - u.z, a.x - u.x)), 90, 5, 'in column on 090');
    assert.deepEqual(exercise.events.slice(-3).map((e) => e.label), ['Skimming past', 'Closest pass', 'Pass the unit']);
  });

  it('SKIMMING PAST: SHIP2 goes on past the unit, 500 yds astern of SHIP1, about 100 m away too', () => {
    near(PASS_UNIT.range, 100, 15, 'closest approach to the unit');
    assert.ok(PASS_UNIT.t > PASS.t + 20, 'after SHIP1');
    assert.ok(exercise.tEnd > PASS_UNIT.t, 'the exercise runs on past it');
    assert.ok(CUES.some((c) => c.ship === 'unit' && Math.abs(c.t - PASS_UNIT.t) < 3), 'the unit answers with her horn');
  });

  it('SKIMMING PAST: SHIP2 passes SHIP1 on a reciprocal course about 100 m away', () => {
    near(PASS.range, 100, 15, 'closest approach');
    const a = shipState('ship1', PASS.t);
    const r = shipState('ship2', PASS.t);
    angleNear(headingDeg(r.heading), 270, 3, 'SHIP2 heads west');
    angleNear(headingDeg(a.heading), 90, 3, 'SHIP1 heads east');
    assert.ok(r.x < a.x, 'SHIP2 passes south of SHIP1');
  });

  it('only ever uses the deck\'s speeds (at most sierra 15 kn) and a standard turn rate', () => {
    let maxKn = 0;
    let maxRate = 0;
    for (const id of ['ship1', 'ship2']) {
      for (let t = 1; t < exercise.tEnd; t += 1) {
        maxKn = Math.max(maxKn, speedKn(id, t));
        let d = shipState(id, t).heading - shipState(id, t - 1).heading;
        while (d > Math.PI) d -= 2 * Math.PI;
        while (d < -Math.PI) d += 2 * Math.PI;
        maxRate = Math.max(maxRate, Math.abs(d) * 180 / Math.PI);
      }
    }
    assert.ok(maxKn <= 15.05, `${maxKn.toFixed(2)} kn`);
    assert.ok(maxRate <= 1.65, `${maxRate.toFixed(2)} deg/s`);
  });

  it('never closes inside 150 m before the skim (no near collision during the station changes)', () => {
    let min = Infinity;
    for (let t = 0; t < PASS.t - 60; t += 1) min = Math.min(min, relation(t).range);
    assert.ok(min > 150, `${min.toFixed(0)} m`);
  });
});

describe('naval maneuvers: orders, signals and timeline', () => {
  it('each order stands by (ships still), executes as the ships start, then calls A STATION on arrival', () => {
    for (const p of PHASES) {
      const before = orderStatus(p.t + 1);
      assert.equal(before.state, 'standby');
      near(before.count, p.tx - (p.t + 1), 1e-9, `${p.id} standby counts down to EXECUTE`);
      assert.equal(orderStatus(p.tx + 0.5).state, 'execute', `${p.id} executes when the ships start`);
      if (p.hasStation) {
        const tm = (p.tx + EXECUTE_FLASH + p.ta) / 2;
        const mid = orderStatus(tm);
        assert.equal(mid.state, 'underway', `${p.id} under way while maneuvering`);
        near(mid.count, p.ta - tm, 1e-9, `${p.id} counts to station`);
        assert.equal(orderStatus(p.ta + 0.5).state, 'station', `${p.id} A STATION on arrival`);
        assert.equal(orderStatus(p.ta + STATION_FLASH + 0.5).state, 'onstation');
      } else {
        assert.equal(orderStatus(p.tx + EXECUTE_FLASH + 0.5).state, 'onstation', `${p.id} only signals`);
      }
    }
    assert.deepEqual(PHASES.filter((p) => !p.hasStation).map((p) => p.id), ['form1', 'station']);
  });

  it('the countdown ends exactly as the ships are in position (the deck\'s time of arrival)', () => {
    const at = (id, back = 0) => P[id].ta - back;
    // Turns: both ships on the new course at arrival, and not yet 20 s before.
    for (const [id, course] of [['stbd', 90], ['port', 0], ['turn045', 45]]) {
      angleNear(headingDeg(shipState('ship1', at(id)).heading), course, 0.7, `${id} SHIP1 on course at TA`);
      angleNear(headingDeg(shipState('ship2', at(id)).heading), course, 0.7, `${id} SHIP2 on course at TA`);
      assert.ok(Math.abs(((headingDeg(shipState('ship1', at(id, 25)).heading) - course + 540) % 360) - 180) > 2, `${id} still turning 25 s before TA`);
    }
    // Station changes: on station at arrival.
    const g = relation(at('gform'));
    near(g.range / YD, 500, 5, 'G FORM range at TA');
    angleNear(g.bearing, 180, 1, 'G FORM bearing at TA');
    assert.ok(Math.abs(relation(at('gform', 60)).range / YD - 500) > 20 || Math.abs(((relation(at('gform', 60)).bearing - 180 + 540) % 360) - 180) > 3, 'not yet on station a minute before');
    const f = relation(at('form120'));
    near(f.range / YD, 500, 6, 'FORM 120 range at TA');
    angleNear(f.bearing, 120, 1.5, 'FORM 120 bearing at TA');
    const c = relation(at('corpen'));
    near(c.range / YD, 500, 3, 'CORPEN range at TA');
    angleNear(c.bearing, 0, 1, 'CORPEN bearing at TA');
    // The serials end at arrival and the skim arrives at the closest pass.
    near(P.light.ta, LIGHT.t1, 1e-9, 'light serial');
    near(P.skim.ta, PASS.t, 1e-9, 'skim at the pass');
  });

  it('every order arrives before the next one is announced', () => {
    for (let i = 1; i < PHASES.length; i++) assert.ok(PHASES[i].t > PHASES[i - 1].ta, `${PHASES[i].id} announced after ${PHASES[i - 1].id} arrived`);
  });

  it('is deterministic and covers the whole timeline with its events', () => {
    assert.deepEqual(shipState('ship2', 1234.5), shipState('ship2', 1234.5));
    assert.equal(exercise.events[0].t, 0);
    assert.ok(exercise.events.at(-1).t < exercise.tEnd);
    assert.equal(exercise.events.length, PHASES.length + 2);
    assert.ok(FORMATION_RANGE > 450 && FORMATION_RANGE < 465);
    for (let i = 1; i < PHASES.length; i++) assert.ok(PHASES[i].t > PHASES[i - 1].t + 20);
  });

  it('flashes the lamp only during the flashing-light serial, SHIP2 first then SHIP1', () => {
    const mid = (LIGHT.t0 + LIGHT.t1) / 2;
    let ship2 = 0;
    let ship1 = 0;
    for (let t = 0; t < exercise.tEnd; t += 0.05) {
      if (lampOn(t, 'ship2')) { ship2++; assert.ok(t >= LIGHT.t0 && t < mid, `SHIP2 lamp at ${t}`); }
      if (lampOn(t, 'ship1')) { ship1++; assert.ok(t >= mid && t < LIGHT.t1, `SHIP1 lamp at ${t}`); }
    }
    assert.ok(ship2 > 20 && ship1 > 20, 'both lamps flash');
  });

  it('sounds both horns at the close pass: SHIP2 as she comes up, SHIP1 answering after', () => {
    const ship2 = CUES.find((c) => c.kind === 'horn' && c.ship === 'ship2');
    const ship1 = CUES.find((c) => c.kind === 'horn' && c.ship === 'ship1' && c.t > PASS.t);
    assert.ok(ship2 && ship2.t < PASS.t && ship2.t > PASS.t - 5, 'SHIP2 blasts just before the pass');
    assert.ok(ship1 && ship1.t > PASS.t && ship1.t < PASS.t + 5, 'SHIP1 answers just after');
  });

  it('has sound cues in time order: a horn at each EXECUTE, and a click per flash', () => {
    for (let i = 1; i < CUES.length; i++) assert.ok(CUES[i].t >= CUES[i - 1].t);
    for (const p of PHASES) assert.ok(CUES.some((c) => c.kind === 'horn' && c.ship === 'ship1' && Math.abs(c.t - p.tx) < 1e-9), `${p.id} horn at EXECUTE`);
    assert.ok(CUES.filter((c) => c.kind === 'click').length > 20);
    assert.ok(CUES.every((c) => c.t >= 0 && c.t <= exercise.tEnd));
  });
});

describe('naval maneuvers: guide, ordered course and debrief (the readouts)', () => {
  it('changes guide with the signals: SHIP1, SHIP2 from G FORM SHIP2, SHIP1 again from FORM 345', () => {
    assert.equal(guideAt(P.corpen.tx + 1), 'ship1');
    assert.equal(guideAt(P.gform.tx - 1), 'ship1');
    assert.equal(guideAt(P.gform.tx + 1), 'ship2');
    assert.equal(guideAt(P.form345.tx - 1), 'ship2');
    assert.equal(guideAt(P.form345.tx + 1), 'ship1');
  });

  it('measures the station from the guide: SHIP2 180 from SHIP1 in FORM 1, SHIP1 180 from SHIP2 after G FORM', () => {
    const a = stationAt(10);
    assert.equal(a.other, 'ship2');
    angleNear(a.bearing, 135, 0.5, 'FORM 1 (column on 315)');
    near(a.range / YD, 500, 2, 'FORM 1 range');
    const b = stationAt(P.gform.ta + 5);
    assert.equal(b.other, 'ship1');
    angleNear(b.bearing, 180, 1, 'after G FORM');
  });

  it('knows the ordered course and speed while a ship is still turning', () => {
    const o = orderedAt('ship1', P.stbd.tx + 20);
    assert.equal(o.course, 90);
    assert.equal(o.speed, 12);
    assert.ok(headingDeg(shipState('ship1', P.stbd.tx + 20).heading) < 89, 'still turning');
    assert.equal(orderedAt('ship2', P.gform.tx + 1).speed, 15);
  });

  it('debriefs every order: station changes end within 10 yds and 2 degrees, the skim passes near 100 m', () => {
    assert.equal(DEBRIEF.length, PHASES.length - 2);
    for (const r of DEBRIEF) {
      assert.ok(r.settle > 0, `${r.id} settles after executing`);
      if (r.error) { assert.ok(Math.abs(r.error.yd) < 10, `${r.id} yds`); assert.ok(Math.abs(r.error.deg) < 2, `${r.id} deg`); }
    }
    near(DEBRIEF.find((r) => r.id === 'skim').pass, PASS.range, 1e-9, 'pass');
  });
});

// The naval maneuvers mission (src/maneuvers.js): the formation geometry of the briefing deck, the
// speeds it names (6, 10, 12 and 15 knots), and the order / sound timing. The module imports
// nothing, so everything runs in Node.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  exercise, shipState, SHIP_IDS, SECTORS, inSector, relation, headingDeg, PASS, PHASES, YD, KT, FORMATION_RANGE, EXECUTE_FLASH, STATION_FLASH,
  orderStatus, lampOn, CUES, LIGHT, guideAt, stationAt, orderedAt, DEBRIEF,
} from '../src/maneuvers.js';

const P = Object.fromEntries(PHASES.map((p) => [p.id, p]));
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);
const angleNear = (a, b, tol, msg) => { const d = Math.abs(((a - b + 540) % 360) - 180); assert.ok(d <= tol, `${msg}: ${a} vs ${b}`); };
const speedKn = (id, t) => shipState(id, t).speed / KT;

describe('naval maneuvers: formation geometry', () => {
  it('starts in FORM 1: a column heading 000, ALG ahead of RUS by 500 yds, 12 knots', () => {
    angleNear(headingDeg(shipState('alg', 5).heading), 0, 0.5, 'ALG heading');
    angleNear(headingDeg(shipState('rus', 5).heading), 0, 0.5, 'RUS heading');
    near(speedKn('alg', 5), 12, 0.2, 'ALG speed');
    const rel = relation(5);
    near(rel.range / YD, 500, 1, 'range (yd)');
    angleNear(rel.bearing, 0, 0.5, 'bearing RUS to ALG');
  });

  it('turns stbd 90 together (line abreast), back to port 90 (column)', () => {
    const abreast = P.stbd.tx + 120;
    angleNear(headingDeg(shipState('alg', abreast).heading), 90, 1, 'ALG heading after TURN STBD 9');
    near(relation(abreast).range / YD, 500, 1, 'range after the turn');
    const column = P.port.tx + 110;
    angleNear(headingDeg(shipState('alg', column).heading), 0, 1, 'ALG heading after TURN PORT 9');
    angleNear(relation(column).bearing, 0, 1, 'column again');
  });

  it('G FORM RUS: ALG slows to 6 kn, RUS runs at sierra 15 kn past ALG to port and takes station 500 yds ahead', () => {
    // RUS passes abeam of ALG on ALG's port side (the west), about 210 m out.
    let abeam = null;
    for (let t = P.gform.tx; t < P.gform.tx + 420; t += 1) {
      const a = shipState('alg', t);
      const r = shipState('rus', t);
      if (!abeam || Math.abs(r.x - a.x) < Math.abs(abeam.dx)) abeam = { t, dx: r.x - a.x, dz: r.z - a.z };
    }
    near(abeam.dz, -212, 40, 'RUS passes about 210 m to port');
    near(speedKn('alg', P.gform.tx + 150), 6, 0.3, 'ALG at G speed 6');
    near(speedKn('rus', P.gform.tx + 150), 15, 0.3, 'RUS at sierra');
    const end = relation(P.gform.tx + 520);
    near(end.range / YD, 500, 2, 'range');
    angleNear(end.bearing, 180, 0.5, 'ALG is astern of RUS');
    near(speedKn('alg', P.gform.tx + 520), 12, 0.2, 'B speed 12 again');
  });

  it('TURN 045 keeps the station; FORM 120 puts ALG on bearing 120 from RUS at 10 knots', () => {
    angleNear(headingDeg(shipState('alg', P.form120.tx - 5).heading), 45, 1, 'course 045');
    near(relation(P.form120.tx - 5).range / YD, 500, 2, 'range kept through the turn');
    const f = relation(P.form120.tx + 620);
    near(f.range / YD, 500, 4, 'range');
    angleNear(f.bearing, 120, 0.7, 'bearing 120');
    near(speedKn('alg', P.form120.tx + 300), 10, 0.2, 'B speed 10');
    near(speedKn('rus', P.form120.tx + 150), 6, 0.3, 'RUS drops back at 6 kn');
  });

  it('CORPEN STBD 045 ends on course 090 with ALG on bearing 180; the serials run at 6 knots', () => {
    const c = P.corpen.tx + 700;
    angleNear(headingDeg(shipState('alg', c).heading), 90, 1, 'course 090');
    angleNear(headingDeg(shipState('rus', c).heading), 90, 1, 'RUS course 090');
    const rel = relation(c);
    angleNear(rel.bearing, 180, 1, 'bearing 180');
    near(rel.range / YD, 500, 5, 'range');
    near(speedKn('alg', P.light.tx + 60), 6, 0.3, 'flashing light at G SPEED 6');
    near(speedKn('rus', P.flags.tx + 60), 6, 0.3, 'flag hoist at G SPEED 6');
  });

  it('the third ship, the unit, keeps the course and speed one station (500 yds) to her east, and RUS never fouls it', () => {
    assert.deepEqual(SHIP_IDS, ['alg', 'rus', 'unit']);
    let minRus = Infinity;
    for (let t = 0; t < P.screenk.tx; t += 1) { // until the screen, where ALG leaves her
      const a = shipState('alg', t);
      const u = shipState('unit', t);
      near(u.x - a.x, 0, 1e-6, 'abeam in the world frame');
      near(u.z - a.z, FORMATION_RANGE, 1e-6, 'one station east of ALG');
      near(headingDeg(u.heading), headingDeg(a.heading), 1e-6, 'same heading');
      const r = shipState('rus', t);
      minRus = Math.min(minRus, Math.hypot(r.x - u.x, r.z - u.z));
    }
    assert.ok(minRus > 80, `RUS passes the unit at ${minRus.toFixed(0)} m`);
  });

  it('SCREEN K and SCREEN M: ALG and RUS reach their sectors round the unit and patrol them, the unit sailing straight on', () => {
    for (const key of ['screenk', 'screenm']) {
      const p = P[key];
      assert.ok(p.ta - p.tx > 60, `${key} takes time to reach the sectors`);
      const end = key === 'screenk' ? P.screenm.t : exercise.tEnd;
      for (let t = p.ta; t < end; t += 2) {
        for (const id of ['alg', 'rus']) assert.ok(inSector(id, t, key), `${id} inside her ${key} sector at ${t}`);
      }
    }
    // The unit holds course 090 at 6 kn through the screens.
    for (let t = P.screenk.tx; t < exercise.tEnd; t += 30) {
      const u = shipState('unit', t);
      near(headingDeg(u.heading), 90, 0.5, 'unit course');
      near(u.speed / KT, 6, 0.2, 'unit speed');
    }
    // Sectors: the manual's four-numeral groups, in tens of degrees (left, right) and thousands of yards (inner, outer).
    near(SECTORS.screenk.alg.d1 / YD, 1500, 1e-6, 'inner depth');
    near(SECTORS.screenk.rus.d2 / YD, 3500, 1e-6, 'outer depth');
    assert.deepEqual([SECTORS.screenk.alg.b1, SECTORS.screenk.alg.b2, SECTORS.screenk.rus.b1, SECTORS.screenk.rus.b2], [330, 30, 150, 210]);
    assert.deepEqual([SECTORS.screenm.alg.b1, SECTORS.screenm.alg.b2, SECTORS.screenm.rus.b1, SECTORS.screenm.rus.b2], [0, 30, 150, 180]);
    // The screen ships keep apart from each other and from the unit.
    let min = Infinity;
    for (let t = P.screenk.ta; t < exercise.tEnd; t += 2) {
      const a = shipState('alg', t);
      const r = shipState('rus', t);
      const u = shipState('unit', t);
      min = Math.min(min, Math.hypot(a.x - r.x, a.z - r.z), Math.hypot(a.x - u.x, a.z - u.z), Math.hypot(r.x - u.x, r.z - u.z));
    }
    assert.ok(min > 1000, `the closest two ships get is ${min.toFixed(0)} m`);
    assert.ok(exercise.tEnd > P.screenm.ta + 60, 'the exercise runs on after the last arrival');
  });

  it('SKIMMING PAST: RUS passes ALG on a reciprocal course about 100 m away', () => {
    near(PASS.range, 100, 15, 'closest approach');
    const a = shipState('alg', PASS.t);
    const r = shipState('rus', PASS.t);
    angleNear(headingDeg(r.heading), 270, 3, 'RUS heads west');
    angleNear(headingDeg(a.heading), 90, 3, 'ALG heads east');
    assert.ok(r.x < a.x, 'RUS passes south of ALG');
  });

  it('only ever uses the deck\'s speeds (at most sierra 15 kn) and a standard turn rate', () => {
    let maxKn = 0;
    let maxRate = 0;
    for (const id of ['alg', 'rus']) {
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
      angleNear(headingDeg(shipState('alg', at(id)).heading), course, 0.7, `${id} ALG on course at TA`);
      angleNear(headingDeg(shipState('rus', at(id)).heading), course, 0.7, `${id} RUS on course at TA`);
      assert.ok(Math.abs(((headingDeg(shipState('alg', at(id, 25)).heading) - course + 540) % 360) - 180) > 2, `${id} still turning 25 s before TA`);
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
    near(c.range / YD, 500, 9, 'CORPEN range at TA');
    angleNear(c.bearing, 180, 2, 'CORPEN bearing at TA');
    // The serials end at arrival and the skim arrives at the closest pass.
    near(P.light.ta, LIGHT.t1, 1e-9, 'light serial');
    near(P.skim.ta, PASS.t, 1e-9, 'skim at the pass');
  });

  it('every order arrives before the next one is announced', () => {
    for (let i = 1; i < PHASES.length; i++) assert.ok(PHASES[i].t > PHASES[i - 1].ta, `${PHASES[i].id} announced after ${PHASES[i - 1].id} arrived`);
  });

  it('is deterministic and covers the whole timeline with its events', () => {
    assert.deepEqual(shipState('rus', 1234.5), shipState('rus', 1234.5));
    assert.equal(exercise.events[0].t, 0);
    assert.ok(exercise.events.at(-1).t < exercise.tEnd);
    assert.equal(exercise.events.length, PHASES.length + 1);
    assert.ok(FORMATION_RANGE > 450 && FORMATION_RANGE < 465);
    for (let i = 1; i < PHASES.length; i++) assert.ok(PHASES[i].t > PHASES[i - 1].t + 20);
  });

  it('flashes the lamp only during the flashing-light serial, RUS first then ALG', () => {
    const mid = (LIGHT.t0 + LIGHT.t1) / 2;
    let rus = 0;
    let alg = 0;
    for (let t = 0; t < exercise.tEnd; t += 0.05) {
      if (lampOn(t, 'rus')) { rus++; assert.ok(t >= LIGHT.t0 && t < mid, `RUS lamp at ${t}`); }
      if (lampOn(t, 'alg')) { alg++; assert.ok(t >= mid && t < LIGHT.t1, `ALG lamp at ${t}`); }
    }
    assert.ok(rus > 20 && alg > 20, 'both lamps flash');
  });

  it('sounds both horns at the close pass: RUS as she comes up, ALG answering after', () => {
    const rus = CUES.find((c) => c.kind === 'horn' && c.ship === 'rus');
    const alg = CUES.find((c) => c.kind === 'horn' && c.ship === 'alg' && c.t > PASS.t);
    assert.ok(rus && rus.t < PASS.t && rus.t > PASS.t - 5, 'RUS blasts just before the pass');
    assert.ok(alg && alg.t > PASS.t && alg.t < PASS.t + 5, 'ALG answers just after');
  });

  it('has sound cues in time order: a horn at each EXECUTE, and a click per flash', () => {
    for (let i = 1; i < CUES.length; i++) assert.ok(CUES[i].t >= CUES[i - 1].t);
    for (const p of PHASES) assert.ok(CUES.some((c) => c.kind === 'horn' && c.ship === 'alg' && Math.abs(c.t - p.tx) < 1e-9), `${p.id} horn at EXECUTE`);
    assert.ok(CUES.filter((c) => c.kind === 'click').length > 20);
    assert.ok(CUES.every((c) => c.t >= 0 && c.t <= exercise.tEnd));
  });
});

describe('naval maneuvers: guide, ordered course and debrief (the readouts)', () => {
  it('changes guide with the signals: ALG, RUS from G FORM RUS, ALG again from CORPEN', () => {
    assert.equal(guideAt(P.gform.tx - 1), 'alg');
    assert.equal(guideAt(P.gform.tx + 1), 'rus');
    assert.equal(guideAt(P.corpen.tx - 1), 'rus');
    assert.equal(guideAt(P.corpen.tx + 1), 'alg');
  });

  it('measures the station from the guide: RUS 180 from ALG in FORM 1, ALG 180 from RUS after G FORM', () => {
    const a = stationAt(10);
    assert.equal(a.other, 'rus');
    angleNear(a.bearing, 180, 0.5, 'FORM 1');
    near(a.range / YD, 500, 2, 'FORM 1 range');
    const b = stationAt(P.gform.ta + 5);
    assert.equal(b.other, 'alg');
    angleNear(b.bearing, 180, 1, 'after G FORM');
  });

  it('knows the ordered course and speed while a ship is still turning', () => {
    const o = orderedAt('alg', P.stbd.tx + 20);
    assert.equal(o.course, 90);
    assert.equal(o.speed, 12);
    assert.ok(headingDeg(shipState('alg', P.stbd.tx + 20).heading) < 89, 'still turning');
    assert.equal(orderedAt('rus', P.gform.tx + 1).speed, 15);
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

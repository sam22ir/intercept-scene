// The naval maneuvers mission (src/maneuvers.js): the formation geometry of the briefing deck, the
// speeds it names (6, 10, 12 and 15 knots), and the order / sound timing. The module imports
// nothing, so everything runs in Node.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  exercise, shipState, relation, headingDeg, PASS, PHASES, YD, KT, FORMATION_RANGE, EXECUTE_FLASH,
  orderStatus, lampOn, CUES, LIGHT,
} from '../src/maneuvers.js';

const P = Object.fromEntries(PHASES.map((p) => [p.id, p]));
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);
const angleNear = (a, b, tol, msg) => { const d = Math.abs(((a - b + 540) % 360) - 180); assert.ok(d <= tol, `${msg}: ${a} vs ${b}`); };
const speedKn = (id, t) => shipState(id, t).speed / KT;

describe('naval maneuvers: formation geometry', () => {
  it('starts in FORM 1: a column heading 000, ALG ahead of RUS by 1000 yds, 12 knots', () => {
    angleNear(headingDeg(shipState('alg', 5).heading), 0, 0.5, 'ALG heading');
    angleNear(headingDeg(shipState('rus', 5).heading), 0, 0.5, 'RUS heading');
    near(speedKn('alg', 5), 12, 0.2, 'ALG speed');
    const rel = relation(5);
    near(rel.range / YD, 1000, 1, 'range (yd)');
    angleNear(rel.bearing, 0, 0.5, 'bearing RUS to ALG');
  });

  it('turns stbd 90 together (line abreast), back to port 90 (column)', () => {
    const abreast = P.stbd.tx + 120;
    angleNear(headingDeg(shipState('alg', abreast).heading), 90, 1, 'ALG heading after TURN STBD 9');
    near(relation(abreast).range / YD, 1000, 1, 'range after the turn');
    const column = P.port.tx + 110;
    angleNear(headingDeg(shipState('alg', column).heading), 0, 1, 'ALG heading after TURN PORT 9');
    angleNear(relation(column).bearing, 0, 1, 'column again');
  });

  it('G FORM RUS: ALG slows to 6 kn, RUS runs at sierra 15 kn past ALG to port and takes station 1000 yds ahead', () => {
    // RUS passes abeam of ALG on ALG's port side (the west), about 520 m out.
    let abeam = null;
    for (let t = P.gform.tx; t < P.gform.tx + 420; t += 1) {
      const a = shipState('alg', t);
      const r = shipState('rus', t);
      if (!abeam || Math.abs(r.x - a.x) < Math.abs(abeam.dx)) abeam = { t, dx: r.x - a.x, dz: r.z - a.z };
    }
    near(abeam.dz, -520, 40, 'RUS passes about 520 m to port');
    near(speedKn('alg', P.gform.tx + 150), 6, 0.3, 'ALG at G speed 6');
    near(speedKn('rus', P.gform.tx + 150), 15, 0.3, 'RUS at sierra');
    const end = relation(P.gform.tx + 520);
    near(end.range / YD, 1000, 2, 'range');
    angleNear(end.bearing, 180, 0.5, 'ALG is astern of RUS');
    near(speedKn('alg', P.gform.tx + 520), 12, 0.2, 'B speed 12 again');
  });

  it('TURN 045 keeps the station; FORM 120 puts ALG on bearing 120 from RUS at 10 knots', () => {
    angleNear(headingDeg(shipState('alg', P.form120.tx - 5).heading), 45, 1, 'course 045');
    near(relation(P.form120.tx - 5).range / YD, 1000, 2, 'range kept through the turn');
    const f = relation(P.form120.tx + 620);
    near(f.range / YD, 1000, 4, 'range');
    angleNear(f.bearing, 120, 0.7, 'bearing 120');
    near(speedKn('alg', P.form120.tx + 300), 10, 0.2, 'B speed 10');
    near(speedKn('rus', P.form120.tx + 300), 6, 0.3, 'RUS drops back at 6 kn');
  });

  it('CORPEN STBD 045 ends on course 090 with ALG on bearing 180; the serials run at 6 knots', () => {
    const c = P.corpen.tx + 700;
    angleNear(headingDeg(shipState('alg', c).heading), 90, 1, 'course 090');
    angleNear(headingDeg(shipState('rus', c).heading), 90, 1, 'RUS course 090');
    const rel = relation(c);
    angleNear(rel.bearing, 180, 1, 'bearing 180');
    near(rel.range / YD, 1000, 5, 'range');
    near(speedKn('alg', P.light.tx + 60), 6, 0.3, 'flashing light at G SPEED 6');
    near(speedKn('rus', P.flags.tx + 60), 6, 0.3, 'flag hoist at G SPEED 6');
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
    assert.ok(maxRate <= 1.25, `${maxRate.toFixed(2)} deg/s`);
  });

  it('never closes inside 300 m before the skim (no near collision during the station changes)', () => {
    let min = Infinity;
    for (let t = 0; t < PASS.t - 60; t += 1) min = Math.min(min, relation(t).range);
    assert.ok(min > 300, `${min.toFixed(0)} m`);
  });
});

describe('naval maneuvers: orders, signals and timeline', () => {
  it('each order is announced, counts down to the ships\' arrival without a pause, executes there, then runs', () => {
    for (const p of PHASES) {
      const before = orderStatus(p.t + 1);
      assert.equal(before.state, 'standby');
      assert.equal(before.moving, false, `${p.id}: the ships have not started yet`);
      near(before.count, p.ta - (p.t + 1), 1e-9, `${p.id} countdown runs to arrival`);
      if (p.ta > p.tx + 5) {
        const mid = orderStatus((p.tx + p.ta) / 2);
        assert.equal(mid.state, 'standby', `${p.id} still counting while the ships are under way`);
        assert.equal(mid.moving, true);
      }
      assert.equal(orderStatus(p.ta + 0.5).state, 'execute');
      assert.equal(orderStatus(p.ta + EXECUTE_FLASH + 0.5).state, 'underway');
    }
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
    near(g.range / YD, 1000, 5, 'G FORM range at TA');
    angleNear(g.bearing, 180, 1, 'G FORM bearing at TA');
    assert.ok(Math.abs(relation(at('gform', 60)).range / YD - 1000) > 20 || Math.abs(((relation(at('gform', 60)).bearing - 180 + 540) % 360) - 180) > 3, 'not yet on station a minute before');
    const f = relation(at('form120'));
    near(f.range / YD, 1000, 6, 'FORM 120 range at TA');
    angleNear(f.bearing, 120, 1.5, 'FORM 120 bearing at TA');
    const c = relation(at('corpen'));
    near(c.range / YD, 1000, 9, 'CORPEN range at TA');
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
    assert.ok(FORMATION_RANGE > 900 && FORMATION_RANGE < 930);
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

  it('has sound cues in time order: a horn as each countdown ends, and a click per flash', () => {
    for (let i = 1; i < CUES.length; i++) assert.ok(CUES[i].t >= CUES[i - 1].t);
    for (const p of PHASES) assert.ok(CUES.some((c) => c.kind === 'horn' && c.ship === 'alg' && Math.abs(c.t - p.ta) < 1e-9), `${p.id} horn at arrival`);
    assert.ok(CUES.filter((c) => c.kind === 'click').length > 20);
    assert.ok(CUES.every((c) => c.t >= 0 && c.t <= exercise.tEnd));
  });
});

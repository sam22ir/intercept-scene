// The naval maneuvers mission (src/maneuvers.js): the formation geometry of the briefing deck.
// The module imports nothing, so everything runs in Node.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { exercise, shipState, relation, headingDeg, PASS, PHASES, YD, KT, FORMATION_RANGE } from '../src/maneuvers.js';

const T = Object.fromEntries(PHASES.map((p) => [p.id, p.t]));
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);
const angleNear = (a, b, tol, msg) => { const d = Math.abs(((a - b + 540) % 360) - 180); assert.ok(d <= tol, `${msg}: ${a} vs ${b}`); };

describe('naval maneuvers', () => {
  it('starts in FORM 1: a column heading 000, ALG ahead of RUS by 1000 yds, 12 knots', () => {
    const a = shipState('alg', 5);
    const r = shipState('rus', 5);
    angleNear(headingDeg(a.heading), 0, 0.5, 'ALG heading');
    angleNear(headingDeg(r.heading), 0, 0.5, 'RUS heading');
    near(a.speed / KT, 12, 0.2, 'ALG speed');
    const rel = relation(5);
    near(rel.range / YD, 1000, 1, 'range (yd)');
    angleNear(rel.bearing, 0, 0.5, 'bearing RUS to ALG');
  });

  it('turns stbd 90 together (line abreast), back to port 90 (column)', () => {
    angleNear(headingDeg(shipState('alg', T.port - 5).heading), 90, 1, 'ALG heading after TURN STBD 9');
    near(relation(T.port - 5).range / YD, 1000, 1, 'range after the turn');
    angleNear(headingDeg(shipState('alg', T.gform - 5).heading), 0, 1, 'ALG heading after TURN PORT 9');
    angleNear(relation(T.gform - 5).bearing, 0, 1, 'column again');
  });

  it('G FORM RUS: RUS passes ALG to port and takes station 1000 yds ahead', () => {
    const mid = T.gform + 270;
    const abeam = relation(mid);
    assert.ok(abeam.range < 800 * YD, 'abeam and close at the middle');
    angleNear(abeam.bearing, 90, 25, 'ALG lies to the east of RUS: RUS passes to port');
    const end = relation(T.gform + 560);
    near(end.range / YD, 1000, 1, 'range');
    angleNear(end.bearing, 180, 1, 'ALG is astern of RUS');
  });

  it('TURN 045 keeps the station; FORM 120 puts ALG on bearing 120 from RUS at 10 knots', () => {
    angleNear(headingDeg(shipState('alg', T.form120 - 5).heading), 45, 1, 'course 045');
    const f = relation(T.form120 + 245);
    near(f.range / YD, 1000, 1, 'range');
    angleNear(f.bearing, 120, 1, 'bearing 120');
    near(shipState('alg', T.form120 + 245).speed / KT, 10, 0.3, 'B speed 10');
  });

  it('CORPEN STBD 045 ends on course 090 with ALG on bearing 180; the serials run at 6 knots', () => {
    const c = T.corpen + 250;
    angleNear(headingDeg(shipState('alg', c).heading), 90, 1, 'course 090');
    angleNear(relation(c).bearing, 180, 1, 'bearing 180');
    near(shipState('alg', T.light + 40).speed / KT, 6, 0.3, 'flashing light at G SPEED 6');
    near(shipState('alg', T.flags + 40).speed / KT, 6, 0.3, 'flag hoist at G SPEED 6');
  });

  it('SKIMMING PAST: RUS passes ALG on a reciprocal course about 100 m away', () => {
    near(PASS.range, 100, 15, 'closest approach');
    const a = shipState('alg', PASS.t);
    const r = shipState('rus', PASS.t);
    angleNear(headingDeg(r.heading), 270, 3, 'RUS heads west');
    angleNear(headingDeg(a.heading), 90, 3, 'ALG heads east');
    assert.ok(r.x < a.x, 'RUS passes south of ALG');
  });

  it('keeps both ships within what a frigate does: at most 24 knots and 2 deg/s', () => {
    let maxKn = 0;
    let maxRate = 0;
    for (const id of ['alg', 'rus']) {
      for (let t = 1; t < exercise.tEnd; t += 1) {
        maxKn = Math.max(maxKn, shipState(id, t).speed / KT);
        let d = shipState(id, t).heading - shipState(id, t - 1).heading;
        while (d > Math.PI) d -= 2 * Math.PI;
        while (d < -Math.PI) d += 2 * Math.PI;
        maxRate = Math.max(maxRate, Math.abs(d) * 180 / Math.PI);
      }
    }
    assert.ok(maxKn <= 24, `${maxKn.toFixed(1)} kn`);
    assert.ok(maxRate <= 2, `${maxRate.toFixed(2)} deg/s`);
  });

  it('is deterministic and covers the whole timeline with its events', () => {
    assert.deepEqual(shipState('rus', 1234.5), shipState('rus', 1234.5));
    assert.equal(exercise.events[0].t, 0);
    assert.ok(exercise.events.at(-1).t < exercise.tEnd);
    assert.equal(exercise.events.length, PHASES.length + 1);
    assert.ok(FORMATION_RANGE > 900 && FORMATION_RANGE < 930);
  });
});

// The two-ship drill (src/maneuvers.js with globalThis.__DRILL_SHIPS = 2, the start screen's "2 ships" tile): ALG and
// RUS run the briefing deck alone, with no unit; FORM 120 is followed by FORM 345, which puts RUS on true bearing 345
// from ALG (both 090 at 6 kn), where the serials and the skim start from. The model reads the size once at import, so
// it is loaded here as its own module instance.

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL, fileURLToPath } from 'node:url';

const url = `${pathToFileURL(fileURLToPath(new URL('../src/maneuvers.js', import.meta.url))).href}?two`;
let M;
let P;
before(async () => {
  globalThis.__DRILL_SHIPS = 2;
  M = await import(url);
  delete globalThis.__DRILL_SHIPS;
  P = Object.fromEntries(M.PHASES.map((p) => [p.id, p]));
});
const angleNear = (a, b, tol, msg) => { const d = Math.abs(((a - b + 540) % 360) - 180); assert.ok(d <= tol, `${msg}: ${a} vs ${b}`); };

describe('the two-ship drill', () => {
  it('has two ships and no unit, its formations or its screens', () => {
    assert.equal(M.DRILL_SHIPS, 2);
    assert.deepEqual(M.SHIP_IDS, ['alg', 'rus']);
    assert.equal(M.PASS_UNIT, null);
    assert.deepEqual(M.PHASES.map((p) => p.id), ['form1', 'station', 'corpen', 'stbd', 'port', 'gform', 'turn045', 'form120', 'form345', 'light', 'flags', 'skim']);
    assert.ok(!M.CUES.some((c) => c.ship === 'unit'), 'no horn for the unit');
    assert.ok(!M.exercise.events.some((e) => /unit/i.test(e.label)));
    assert.ok(!M.PHASES.some((p) => p.serial.some((s) => s.lines.some((l) => /UNIT/.test(l)))), 'no signal names the unit');
    assert.ok(!/unit/i.test(P.station.note));
  });

  it('runs the deck\'s orders as the three-ship drill does up to FORM 120', async () => {
    const T = await import(url.replace('?two', '?three'));
    for (const id of ['corpen', 'stbd', 'port', 'gform', 'turn045', 'form120']) {
      assert.equal(P[id].tx, T.PHASES.find((p) => p.id === id).tx, `${id} executes at the same time`);
      for (const ship of ['alg', 'rus']) {
        const a = M.shipState(ship, P[id].ta);
        const b = T.shipState(ship, P[id].ta);
        assert.ok(Math.hypot(a.x - b.x, a.z - b.z) < 1e-6, `${ship} at ${id}`);
      }
    }
  });

  it('FORM 345: ALG comes to 090 at 6 kn and RUS takes station on true bearing 345 from her, 500 yds', () => {
    const t = P.form345.ta;
    assert.ok(P.form345.hasStation && t > P.form345.tx);
    angleNear(M.headingDeg(M.shipState('alg', t).heading), 90, 0.5, 'ALG course');
    assert.ok(Math.abs(M.shipState('alg', t).speed / M.KT - 6) < 0.1, 'ALG speed');
    const st = M.stationAt(t);
    assert.equal(st.guide, 'alg');
    const P345 = M.stationPoint('rus', 'form345', t);
    const r = M.shipState('rus', t);
    assert.ok(Math.hypot(r.x - P345.x, r.z - P345.z) < 25, 'within 25 m of the station at arrival');
    angleNear(M.headingDeg(r.heading), 90, 3, 'RUS on the guide\'s course');
    // She keeps closing it until the skim starts from there.
    const s = M.stationAt(P.skim.tx);
    assert.ok(Math.abs(s.range / M.YD - 500) < 5, `range ${s.range / M.YD} yd at the skim`);
    angleNear(s.bearing, 345, 1, 'bearing from ALG at the skim');
  });

  it('each order after FORM 120 executes 40 s after the last arrival', () => {
    const ids = ['form120', 'form345', 'light', 'flags', 'skim'];
    for (let i = 1; i < ids.length; i++) assert.ok(Math.abs(P[ids[i]].tx - P[ids[i - 1]].ta - 40) <= 1, `${ids[i]}: ${P[ids[i]].tx - P[ids[i - 1]].ta} s`);
  });

  it('keeps the ships at least 170 m apart until the skim, which passes ALG at about 100 m', () => {
    let min = Infinity;
    for (let t = 0; t < M.PASS.t - 120; t += 0.5) min = Math.min(min, M.relation(t).range);
    assert.ok(min > 170, `closest ${min} m`);
    assert.ok(Math.abs(M.PASS.range - 100) < 5, `pass ${M.PASS.range} m`);
    assert.ok(M.PASS.t > P.skim.tx && M.exercise.tEnd > M.PASS.t);
  });

  it('is a pure function of t: every order\'s station check passes in the debrief', () => {
    for (const r of M.DEBRIEF) {
      assert.ok(r.settle > 0, `${r.id} settles`);
      if (r.error) { assert.ok(Math.abs(r.error.yd) < 10, `${r.id} yds`); assert.ok(Math.abs(r.error.deg) < 2, `${r.id} deg`); }
    }
    const a = M.shipState('rus', 1500);
    const b = M.shipState('rus', 1500);
    assert.deepEqual(a, b);
  });
});

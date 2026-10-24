// The man overboard drill (MobSim in src/harbour.js): the alarm comes, the casualty and the lifebuoy drift, the first rudder order
// and the Williamson turn are followed and scored, she recovers him by stopping with him abeam, and running him down or drawing
// him into the screws loses him. A scripted watchkeeper does the drill as it is taught.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MobSim, MOB_START, MOB_DRIFT, MOB_ZONE, TELEGRAPH, KT, RUDDER_MAX, clearance } from '../src/harbour.js';

const wrapPi = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const deg = (r) => (r * 180) / Math.PI;
const orderFor = (kn) => TELEGRAPH.reduce((best, o, i) => (Math.abs(o.kn - kn) < Math.abs(TELEGRAPH[best].kn - kn) ? i : best), 0);
const steerTo = (sim, want, gain = 2.2) => Math.max(-1, Math.min(1, wrapPi(want - sim.psi) * gain - sim.r * 14));

// The drill as taught: hard over toward him, the Williamson turn, back down the wake, slow early, stop with him abeam to starboard.
function drill(sim, { reverseAt = 60, wrongWay = false, log = null } = {}) {
  let phase = 'wait', finalHdg = null;
  for (let i = 0; i < 900 * 120 && !sim.over; i++) {
    const input = { wheel: 0, turn: 0, slide: 0 };
    if (phase === 'wait' && sim.casualty) phase = 'over';
    if (phase === 'over') {
      input.wheel = wrongWay ? -sim.side : sim.side;
      if (sim.deviation >= reverseAt) phase = 'back';
    } else if (phase === 'back') {
      input.wheel = -sim.side;
      if (Math.abs(deg(wrapPi(sim.psi - sim.h0 - Math.PI))) < 12) phase = 'home';
    } else if (phase === 'home') {
      // steer for a point 15 m to port of him, so he comes down her starboard side; ease the speed with the distance
      const p = sim.casualtyPos();
      const r = sim.rel();
      const ang = Math.atan2(p.z - sim.z, p.x - sim.x);
      const off = Math.atan2(-15, Math.max(r.d, 30)); // 15 m to port of the line to him
      input.wheel = steerTo(sim, ang + off);
      const wantU = Math.max(-1.2, Math.min(5, r.ax * 0.03));
      const kn = (wantU - sim.u) > 0.25 ? Math.max(0, wantU) / KT + 2 : (wantU - sim.u) < -0.25 ? -6 : 0;
      sim.order = orderFor(kn);
      if (r.ax < 40) { finalHdg ??= sim.psi; input.wheel = steerTo(sim, finalHdg); input.slide = r.az > 15 ? 1 : r.az < 12 ? -1 : 0; }
    }
    sim.step(1 / 120, input);
    if (log && i % 1200 === 0) log.push({ t: +sim.t.toFixed(0), stage: sim.stage, dev: +sim.deviation.toFixed(0), kn: +(sim.u / KT).toFixed(1), rel: sim.rel() && Object.fromEntries(Object.entries(sim.rel()).map(([k, v]) => [k, +v.toFixed(0)])) });
  }
  return sim;
}

describe('the man overboard drill', () => {
  it('starts on passage in open water, and the alarm comes', () => {
    const sim = new MobSim({ alarmAt: 6, side: 1 });
    assert.equal(sim.stage, 'underway');
    assert.ok(clearance(MOB_START.x, MOB_START.z) > 600, 'well clear of the land');
    assert.ok(Math.abs(sim.u - 10 * KT) < 1e-9);
    for (let i = 0; i < 7 * 120; i++) sim.step(1 / 120, {});
    assert.equal(sim.stage, 'mob');
    const ev = sim.takeEvents();
    assert.ok(ev.some((e) => e.type === 'alarm'));
    assert.ok(ev.some((e) => e.type === 'say' && /starboard side/.test(e.text)));
    const r = sim.rel();
    assert.ok(r.az > 0, 'he went over the starboard side');
  });
  it('drifts him with the wind and sea, the lifebuoy faster', () => {
    const sim = new MobSim({ alarmAt: 1, side: -1 });
    for (let i = 0; i < 2 * 120; i++) sim.step(1 / 120, {});
    const a = sim.casualtyPos(), t = sim.t;
    const b = sim.casualtyPos(t + 100);
    assert.ok(Math.abs(b.x - a.x - MOB_DRIFT.x * 100) < 1e-6 && Math.abs(b.z - a.z - MOB_DRIFT.z * 100) < 1e-6);
    assert.equal(sim.buoyPos(sim.casualty.t0 + 1), null, 'the lifebuoy is not in the water at once');
    const b1 = sim.buoyPos(t + 10), b2 = sim.buoyPos(t + 110);
    assert.ok(Math.hypot(b2.x - b1.x, b2.z - b1.z) > Math.hypot(MOB_DRIFT.x, MOB_DRIFT.z) * 100);
  });
  it('a Williamson turn done right brings her back and recovers him, with full marks for the turn', () => {
    const log = [];
    const sim = drill(new MobSim({ alarmAt: 5, side: 1 }), { log });
    assert.equal(sim.stage, 'done', JSON.stringify(log.slice(-8)));
    const r = sim.result;
    assert.equal(r.immediate, true);
    assert.equal(r.firstRudder, 'right');
    assert.ok(r.reversedAt >= 55 && r.reversedAt <= 70, `reversed at ${r.reversedAt}`);
    assert.equal(r.williamson, true);
    assert.ok(r.time > 60 && r.time < 600, `${r.time.toFixed(0)} s`);
    assert.ok(r.stars >= 2);
    assert.equal(sim.contacts.hard + sim.contacts.crash, 0);
  });
  it('a late reversal still gets him back but does not count as a Williamson turn', () => {
    const sim = drill(new MobSim({ alarmAt: 5, side: -1 }), { reverseAt: 100 });
    assert.equal(sim.stage, 'done', JSON.stringify(sim.result));
    assert.equal(sim.result.williamson, false);
  });
  it('easing the rudder is not a reversal; reversing counts from when the wheel came off hard over', () => {
    const sim = new MobSim({ alarmAt: 1, side: 1 });
    let i = 0;
    for (; i < 30 * 120 && sim.deviation < 30; i++) sim.step(1 / 120, { wheel: sim.casualty ? 1 : 0 });
    for (let k = 0; k < 10 * 120; k++) sim.step(1 / 120, { wheel: 0 }); // eased to midships, not reversed
    assert.equal(sim.wt.phase, 0);
    const off = sim.deviation;
    for (let k = 0; k < 15 * 120 && sim.wt.phase === 0; k++) sim.step(1 / 120, { wheel: -1 }); // now hard over the other way
    assert.equal(sim.wt.phase, 1);
    assert.ok(Math.abs(sim.wt.reversedAt - off) < 8, `logged at ${sim.wt.reversedAt.toFixed(0)}°, the wheel moved at about ${off.toFixed(0)}°`);
  });
  it('the wrong rudder is called out', () => {
    const sim = new MobSim({ alarmAt: 2, side: 1 });
    for (let i = 0; i < 8 * 120; i++) sim.step(1 / 120, { wheel: sim.casualty ? -1 : 0 });
    assert.equal(sim.wt.firstRudder, 'wrong');
    assert.ok(sim.takeEvents().some((e) => e.type === 'say' && /Wrong way/.test(e.text)));
  });
  it('running him down or drawing him into the screws loses him', () => {
    const a = new MobSim({ alarmAt: 1, side: 1 });
    for (let i = 0; i < 2 * 120; i++) a.step(1 / 120, {});
    const p = a.casualtyPos();
    Object.assign(a, { x: p.x - 80, z: p.z, psi: 0, u: 4 }); // steaming straight at him
    for (let i = 0; i < 40 * 120 && !a.over; i++) a.step(1 / 120, {});
    assert.equal(a.stage, 'lost');
    assert.equal(a.result.lost, 'struck');
    const b = new MobSim({ alarmAt: 1, side: 1 });
    for (let i = 0; i < 2 * 120; i++) b.step(1 / 120, {});
    const q = b.casualtyPos();
    Object.assign(b, { x: q.x + 58, z: q.z, psi: 0, u: 0, v: 0 }); // stopped with him just under her stern ...
    b.order = orderFor(-3); // ... and going astern
    for (let i = 0; i < 2 * 120 && !b.over; i++) b.step(1 / 120, {});
    assert.equal(b.stage, 'lost');
    assert.equal(b.result.lost, 'screws');
  });
  it('recovery needs her stopped with him abeam, and holding there', () => {
    const sim = new MobSim({ alarmAt: 1, side: 1 });
    for (let i = 0; i < 2 * 120; i++) sim.step(1 / 120, {});
    const p = sim.casualtyPos();
    Object.assign(sim, { x: p.x, z: p.z - 14, psi: 0, u: 0, v: 0, r: 0 }); // him 14 m off her starboard side, abreast the bridge
    sim.order = orderFor(0);
    for (let i = 0; i < (MOB_ZONE.hold - 1) * 120; i++) sim.step(1 / 120, {});
    assert.equal(sim.stage, 'recover');
    for (let i = 0; i < 2 * 120; i++) sim.step(1 / 120, {});
    assert.equal(sim.stage, 'done', JSON.stringify(sim.result));
    void RUDDER_MAX;
  });
});

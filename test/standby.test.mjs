// The customisable standby time of the naval maneuvers mission: it moves when each order is announced
// (and so the countdown), but never when it executes, so no trajectory changes.

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';

let n = 0;
async function load(standby) {
  if (standby === undefined) delete globalThis.__STANDBY; else globalThis.__STANDBY = standby;
  return import(`../src/maneuvers.js?standby=${n++}`);
}
after(() => { delete globalThis.__STANDBY; });

describe('standby time', () => {
  it('defaults to 10 s and clamps to 3 to 25 s', async () => {
    assert.equal((await load()).STANDBY, 10);
    assert.equal((await load(20)).STANDBY, 20);
    assert.equal((await load(99)).STANDBY, 25);
    assert.equal((await load(1)).STANDBY, 3);
    assert.equal((await load('abc')).STANDBY, 10);
    assert.equal((await load(7.6)).STANDBY, 8);
  });

  it('moves the announcements only: execution times and trajectories are identical', async () => {
    const a = await load(5);
    const b = await load(25);
    assert.equal(a.PHASES.length, b.PHASES.length);
    a.PHASES.forEach((p, i) => {
      assert.equal(p.tx, b.PHASES[i].tx, `${p.id} starts at the same time`);
      assert.equal(p.ta, b.PHASES[i].ta, `${p.id} arrives at the same time`);
      near(p.tx - p.t, 5, `${p.id} announced 5 s ahead`);
      near(b.PHASES[i].tx - b.PHASES[i].t, 25, `${p.id} announced 25 s ahead`);
    });
    for (const t of [0, 400, 900, 1700, 2600, 3000]) {
      for (const id of ['ship1', 'ship2']) assert.deepEqual(a.shipState(id, t), b.shipState(id, t), `${id} at ${t}`);
    }
    assert.equal(a.PASS.t, b.PASS.t);
    assert.equal(a.tEnd, b.tEnd);
  });

  it('is the time to get ready: it counts down to EXECUTE, when the ships start', async () => {
    const M = await load(18);
    for (const p of M.PHASES) {
      const s = M.orderStatus(p.t + 3);
      assert.equal(s.state, 'standby');
      near(s.count, p.tx - (p.t + 3), 'countdown to EXECUTE');
      near(p.tx - p.t, 18, 'the whole standby');
      assert.equal(M.orderStatus(p.tx + 1).state, 'execute');
      if (p.hasStation) assert.equal(M.orderStatus(p.ta + 1).state, 'station');
    }
  });

  it('announces the first order at the very start with the longest standby, and a little later otherwise', async () => {
    const longest = await load(25);
    assert.equal(longest.PHASES[0].t, 0);
    assert.equal(longest.orderStatus(0).state, 'standby');
    assert.equal(longest.exercise.events[0].t, 0);
    const usual = await load(10);
    assert.ok(usual.PHASES[0].t > 0, 'a few seconds of steaming first');
    assert.equal(usual.orderStatus(0).state, 'idle');
    assert.equal(usual.orderStatus(usual.PHASES[0].t + 1).state, 'standby');
    assert.equal(usual.exercise.events[0].t, 0);
  });

  it('never announces an order before the previous one has arrived, even with the longest standby', async () => {
    const M = await load(25);
    for (let i = 1; i < M.PHASES.length; i++) assert.ok(M.PHASES[i].t > M.PHASES[i - 1].ta, M.PHASES[i].id);
  });
});

function near(a, b, msg) { assert.ok(Math.abs(a - b) < 1e-9, `${msg}: ${a} vs ${b}`); }

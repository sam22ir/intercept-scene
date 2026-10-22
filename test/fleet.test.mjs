// Fleet command spine (src/fleet.js): squadron setup, orders, the log and rewind, judging, determinism. Runs in Node.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FleetSim, DT, ORDER_TYPES } from '../src/fleet.js';

const run = (sim, seconds) => { for (let i = 0; i < Math.round(seconds / 0.1); i++) sim.advance(0.1); };
const toEnd = (sim, limit = 900) => { while (sim.t < limit && sim.winner === null) sim.advance(0.1); return sim; };

describe('the squadron', () => {
  it('is 3 or 4 team-0 ships in a column on the helmsman, each with a role and the frozen extras', () => {
    assert.equal(new FleetSim({ seed: 1 }).squad.length, 4);
    assert.equal(new FleetSim({ seed: 1, n: 3 }).squad.length, 3);
    assert.equal(new FleetSim({ seed: 1, n: 9 }).squad.length, 4);
    assert.equal(new FleetSim({ seed: 1, n: 1 }).squad.length, 3);
    const sim = new FleetSim({ seed: 1 });
    sim.squad.forEach((s, i) => {
      assert.equal(s.idx, i);
      assert.equal(s.team, 0);
      assert.ok(s.ai, 'the player never steers a hull');
      assert.ok(['picket', 'gun', 'escort'].includes(s.role));
      assert.equal(s.stance, 'engage');
      assert.equal(typeof s.goal.course, 'number');
      assert.equal(s.fuel, 1);
      assert.ok('form' in s && 'sector' in s);
    });
    assert.ok(sim.squad[0].x > sim.squad[3].x, 'a column, the first ship leading');
  });

  it('holds its course and speed with no orders', () => {
    const sim = new FleetSim({ seed: 2 });
    sim.pending = [];
    run(sim, 60);
    for (const s of sim.squad) { assert.ok(Math.abs(s.psi) < 0.02); assert.ok(Math.abs(sim.knots(s) - 16) < 1); }
  });
});

describe('safe without a player ship at index 0', () => {
  it('keeps stepping, aiming and judging after ship 0 is sunk', () => {
    const sim = new FleetSim({ seed: 3 });
    sim.squad[0].hp = 0;
    run(sim, 120);
    assert.ok(sim.squad[0].tSunk !== null);
    assert.ok(Number.isFinite(sim.range()));
    assert.ok(sim.enemy && sim.lead.idx !== 0);
    assert.ok(sim.ships.every((s) => Number.isFinite(s.x) && Number.isFinite(s.psi)));
  });
});

describe('orders', () => {
  it('rejects unknown types and stamps and logs the rest', () => {
    const sim = new FleetSim({ seed: 4 });
    assert.equal(sim.order({ type: 'dance' }), false);
    run(sim, 3);
    const e = sim.order({ t: 999, to: [1, 2], type: 'speed', kn: 10 });
    assert.equal(e.t, sim.t);
    assert.equal(sim.log.length, 1);
    assert.deepEqual(e.to, [1, 2]);
    assert.equal(sim.squad[1].goal.kn, 10);
    assert.equal(sim.squad[0].goal.kn, 16);
    assert.ok(ORDER_TYPES.includes('goto'));
  });

  it('a course order turns the whole squadron', () => {
    const sim = new FleetSim({ seed: 4 });
    sim.pending = [];
    sim.order({ to: 'all', type: 'course', course: 90 });
    run(sim, 60);
    for (const s of sim.squad) assert.ok(Math.abs(s.psi - Math.PI / 2) < 0.1, `psi ${s.psi}`);
  });

  it('a goto order steers one ship toward the point', () => {
    const sim = new FleetSim({ seed: 4 });
    sim.pending = [];
    sim.order({ to: 2, type: 'goto', x: 0, z: 2500 });
    run(sim, 90);
    assert.ok(sim.squad[2].z > 400, `z ${sim.squad[2].z}`);
    assert.ok(Math.abs(sim.squad[1].z) < 50);
  });

  it('hold fire keeps the guns quiet', () => {
    const sim = new FleetSim({ seed: 5 });
    sim.order({ to: 'all', type: 'stance', stance: 'hold' });
    let shots = 0;
    for (let i = 0; i < 120 * 150; i++) {
      sim.step(DT);
      for (const e of sim.takeEvents()) if (e.type === 'shot' && e.owner < 4) shots++;
    }
    assert.equal(shots, 0);
    assert.equal(sim.squad.reduce((n, s) => n + s.stats.shells + s.stats.bursts, 0), 0);
  });
});

describe('determinism and rewind', () => {
  const script = (sim) => {
    run(sim, 20);
    sim.order({ to: 'all', type: 'course', course: 40 });
    run(sim, 30);
    sim.order({ to: [0, 1], type: 'speed', kn: 22 });
    sim.order({ to: 3, type: 'stance', stance: 'hold' });
  };

  it('two sims with the same seed and log end identical', () => {
    const a = new FleetSim({ seed: 7 }), b = new FleetSim({ seed: 7 });
    script(a);
    run(a, 100);
    for (const e of a.log) { while (b.steps < e.n) b.step(DT); b.order(e); }
    while (b.steps < a.steps) b.step(DT);
    assert.equal(a.digest(), b.digest());
    const c = new FleetSim({ seed: 8 }); run(c, 150);
    const d = new FleetSim({ seed: 7 }); run(d, 150);
    assert.notEqual(c.digest(), d.digest(), 'the seed matters');
  });

  it('rewindTo reproduces an earlier state and cuts the log there', () => {
    const sim = new FleetSim({ seed: 7 });
    script(sim);
    run(sim, 20);
    const at = sim.t, snap = sim.digest(), logLen = sim.log.length;
    run(sim, 120);
    sim.order({ to: 'all', type: 'course', course: 200 });
    assert.notEqual(sim.digest(), snap);
    sim.rewindTo(at);
    assert.equal(sim.digest(), snap);
    assert.equal(sim.log.length, logLen);
    const twin = new FleetSim({ seed: 7 });
    script(twin);
    run(twin, 20);
    assert.equal(twin.digest(), sim.digest());
  });

  it('a seeded 4-ship run completes, the same way twice', () => {
    const a = toEnd(new FleetSim({ seed: 9, level: 'normal' })), b = toEnd(new FleetSim({ seed: 9, level: 'normal' }));
    assert.notEqual(a.winner, null, `finished at ${a.t}`);
    assert.equal(a.digest(), b.digest());
    assert.ok(['won', 'lost'].includes(a.debrief().status));
  });
});

describe('judging', () => {
  it('loses when one of ours sinks a merchant', () => {
    const sim = new FleetSim({ seed: 6, scenario: 'escort' });
    const m = sim.newShip(500, 800, 0, 2, 'merchant');
    m.lastHitBy = 2; m.hp = 0;
    run(sim, 1);
    assert.equal(sim.winner, 1);
    assert.equal(sim.over, 'merchant');
  });

  it('a merchant sunk by the enemy is no fault of ours in defend, but loses the escort', () => {
    const d = new FleetSim({ seed: 6, scenario: 'defend' });
    const m = d.newShip(500, 800, 0, 2, 'merchant');
    m.lastHitBy = 5; m.hp = 0;
    run(d, 1);
    assert.equal(d.merchantsLost, 1);
    assert.equal(d.merchantsKilledByUs, 0);
    assert.equal(d.winner, null);
    const e = new FleetSim({ seed: 6, scenario: 'escort' });
    const m2 = e.newShip(500, 800, 0, 2, 'merchant');
    m2.lastHitBy = 5; m2.hp = 0;
    run(e, 1);
    assert.equal(e.winner, 1);
  });

  it('loses when every squadron ship is sunk', () => {
    const sim = new FleetSim({ seed: 6 });
    for (const s of sim.squad) s.hp = 0;
    run(sim, 1);
    assert.equal(sim.winner, 1);
    assert.equal(sim.over, 'sunk');
  });
});

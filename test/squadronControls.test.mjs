// Squadron orders's controls (src/squadronControls.js): what the keys and clicks mean as orders, the rewind target, the logged crew move
// that survives a rewind, and the alert feed that never repeats itself.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SquadronSim, DT, hooks } from '../src/squadron.js';
import { applyOrder } from '../src/squadronOrders.js';
import { transferCrew, stocksOf } from '../src/squadronResources.js';
import {
  FORM_CYCLE, SPEEDS, courseOrder, speedOrder, formOrder, sectorOrders, stanceOrder, gotoOrders, courseToOrder, crewTarget,
  rewindTarget, describeOrder, contactLabel, issue, logCrew, withCrewHook, AlertFeed, hullFrac, hullMax, targets, scopeFor,
} from '../src/squadronControls.js';

const quiet = (seed = 1, over = {}) => new SquadronSim({ seed, hooks: { planThreats: () => [], ...over } });
const run = (sim, s) => { for (let i = 0; i < Math.round(s / DT); i++) sim.step(DT); };

describe('course and speed keys', () => {
  it('an arrow turns the ordered course by ten degrees, wrapping round north', () => {
    const sim = quiet();
    assert.equal(courseOrder(sim, 'all', 10).course, 10);
    assert.equal(courseOrder(sim, 'all', -10).course, 350);
    issue(sim, courseOrder(sim, 1, 10));
    assert.equal(sim.squad[1].goal.course, 10);
    assert.equal(courseOrder(sim, 1, 10).course, 20, 'it starts from the ordered course');
    assert.equal(sim.squad[2].goal.course, 0, 'the others are untouched');
  });

  it('speed steps along the telegraph speeds and stops at the ends', () => {
    const sim = quiet();
    assert.equal(sim.squad[0].goal.kn, 16);
    assert.equal(speedOrder(sim, 'all', +1).kn, 22);
    assert.equal(speedOrder(sim, 'all', -1).kn, 10);
    const o = speedOrder(sim, 0, +1);
    issue(sim, o);
    for (let i = 0; i < 10; i++) issue(sim, speedOrder(sim, 0, +1));
    assert.equal(sim.squad[0].goal.kn, SPEEDS[SPEEDS.length - 1]);
    for (let i = 0; i < 10; i++) issue(sim, speedOrder(sim, 0, -1));
    assert.equal(sim.squad[0].goal.kn, 0);
  });

  it('with all selected and a formation ordered, course, speed and goto go to the lead alone', () => {
    const sim = quiet();
    assert.equal(scopeFor(sim, 'all'), 'all', 'no formation: every ship');
    issue(sim, formOrder(sim, 'all'));
    assert.equal(scopeFor(sim, 'all'), 0);
    assert.equal(courseOrder(sim, 'all', 10).to, 0);
    assert.equal(speedOrder(sim, 'all', 1).to, 0);
    assert.deepEqual(gotoOrders(sim, 'all', 100, 200).map((o) => o.to), [0]);
    assert.equal(scopeFor(sim, 2), 2, 'a ship picked by herself is ordered by herself');
    issue(sim, courseOrder(sim, 'all', 10));
    assert.ok(sim.squad.slice(1).every((s) => s.form === 'FORM 1'), 'the others keep their stations');
  });

  it('a ship in a formation turns from the way she is heading, not from a stale ordered course', () => {
    const sim = quiet();
    issue(sim, formOrder(sim, 'all'));
    sim.squad[1].psi = (90 * Math.PI) / 180;
    assert.equal(courseOrder(sim, 1, 10).course, 100);
  });
});

describe('formations, sector patrol and hold fire', () => {
  it('F cycles through the four formations and back to the first', () => {
    const sim = quiet();
    const seen = [];
    for (let i = 0; i < 5; i++) { const o = formOrder(sim, 'all'); seen.push(o.form); issue(sim, o); }
    assert.deepEqual(seen, [...FORM_CYCLE, FORM_CYCLE[0]]);
    assert.ok(sim.squad.slice(1).every((s) => s.form === FORM_CYCLE[0]));
    assert.equal(sim.squad[0].form, null, 'the lead has no station');
  });

  it('a formation for one follower orders that ship only', () => {
    const sim = quiet();
    const o = formOrder(sim, 2);
    assert.deepEqual(o.to, [2]);
    issue(sim, o);
    assert.equal(sim.squad[2].form, 'FORM 1');
    assert.equal(sim.squad[1].form, null);
  });

  it('P gives each follower her own slice round the lead, then a second press ends the patrol', () => {
    const sim = quiet();
    const orders = sectorOrders(sim, 'all');
    assert.equal(orders.length, 3, 'one order per follower: the lead ignores sectors');
    assert.ok(orders.every((o) => o.type === 'sector' && o.to !== 0));
    issue(sim, orders);
    assert.ok(sim.squad.slice(1).every((s) => s.sector));
    const slices = sim.squad.slice(1).map((s) => [s.sector.from, s.sector.to]);
    assert.equal(new Set(slices.map(([a]) => a)).size, 3, 'the slices differ');
    assert.deepEqual(slices[0], [300, 60], 'the first is centred on the bow');
    const off = sectorOrders(sim, 'all');
    assert.ok(off.every((o) => o.type === 'course'));
    issue(sim, off);
    assert.ok(sim.squad.slice(1).every((s) => !s.sector));
  });

  it('E toggles hold fire and engage', () => {
    const sim = quiet();
    const hold = stanceOrder(sim, 'all');
    assert.equal(hold.stance, 'hold');
    issue(sim, hold);
    assert.ok(sim.squad.every((s) => s.stance === 'hold' && !s.auto));
    assert.equal(stanceOrder(sim, 'all').stance, 'engage');
    issue(sim, stanceOrder(sim, 1));
    assert.equal(sim.squad[1].stance, 'engage', 'one engaged ship makes the next press hold again for all, but alone she toggles');
  });

  it('a click with all picked sends each ship to the point plus her own offset, so none share a spot', () => {
    const sim = quiet();
    const orders = gotoOrders(sim, 'all', 1000, 500);
    assert.equal(orders.length, 4);
    const c = sim.centroid();
    for (const o of orders) {
      const s = sim.squad[o.to];
      assert.equal(o.x, Math.round(1000 + s.x - c.x));
      assert.equal(o.z, Math.round(500 + s.z - c.z));
    }
    assert.equal(new Set(orders.map((o) => `${o.x},${o.z}`)).size, 4);
    issue(sim, formOrder(sim, 'all'));
    assert.equal(gotoOrders(sim, 'all', 1000, 500).length, 1, 'bound to the lead: she alone goes');
  });

  it('a click is a goto, a shift click a bearing', () => {
    const sim = quiet();
    const [g] = gotoOrders(sim, 1, 1000.4, -250.6);
    assert.deepEqual([g.type, g.x, g.z, g.to], ['goto', 1000, -251, 1]);
    issue(sim, g);
    assert.deepEqual(sim.squad[1].goal.to, [1000, -251]);
    const c = courseToOrder(sim, 0, 0, 1000); // due east of the lead
    assert.equal(c.course, 90);
    assert.equal(courseToOrder(sim, 0, -1000, 0).course, 180);
  });
});

describe('crews and the rewind', () => {
  const withCrews = () => {
    const results = { last: null };
    const sim = quiet(1, { applyOrder: withCrewHook(applyOrder, transferCrew, results) });
    return { sim, results };
  };

  it('the next ship for a crew is the next living one in order, preferring one in range', () => {
    const sim = quiet();
    assert.equal(crewTarget(sim, 0).idx, 1);
    assert.equal(crewTarget(sim, 3).idx, 0);
    sim.squad[1].tSunk = 1;
    assert.equal(crewTarget(sim, 0).idx, 2);
    assert.equal(crewTarget(sim, 0, 100).idx, 2, 'out of range everywhere: still the next one');
  });

  it('a crew move is logged and a rewind carries it out again', () => {
    const { sim, results } = withCrews();
    sim.squad[3].crews.push({ to: null, eta: 0 }); // so she has one to spare
    run(sim, 2);
    const before = stocksOf(sim.squad[2]).crews;
    const e = logCrew(sim, 3, 2);
    assert.equal(results.last, true);
    assert.equal(e.type, 'crew');
    assert.equal(sim.log.at(-1), e);
    run(sim, 30);
    const done = stocksOf(sim.squad[2]).crews;
    assert.equal(done, before + 1, 'the crew came aboard');
    const digest = sim.digest();
    sim.rewindTo(sim.t);
    assert.equal(sim.digest(), digest, 'the rewind replays the move: the same state, bit for bit');
  });

  it('the base order hook still handles the ordinary orders', () => {
    const { sim } = withCrews();
    issue(sim, courseOrder(sim, 1, 10));
    assert.equal(sim.squad[1].goal.course, 10);
  });

  it('Z goes to the last order, takes back one just given, then goes to the one before', () => {
    const sim = quiet();
    assert.equal(rewindTarget(sim), null, 'nothing yet, nothing to go back to');
    run(sim, 5);
    issue(sim, courseOrder(sim, 'all', 10));
    run(sim, 5);
    issue(sim, speedOrder(sim, 'all', 1));
    run(sim, 5);
    const [a, b] = sim.log;
    assert.equal(rewindTarget(sim), b.t);
    sim.rewindTo(rewindTarget(sim));
    assert.ok(Math.abs(sim.t - b.t) < 2 * DT);
    assert.equal(sim.log.length, 2, 'the order itself is kept');
    assert.equal(sim.squad[0].goal.kn, 22, 'and in force');
    assert.ok(rewindTarget(sim) < b.t, 'already there: the next press takes it back');
    sim.rewindTo(rewindTarget(sim));
    assert.equal(sim.log.length, 1, 'taken back');
    assert.equal(sim.squad[0].goal.kn, 16);
    assert.ok(Math.abs(sim.t - b.t) < 3 * DT, 'at the same moment, without the order');
    assert.equal(rewindTarget(sim), a.t, 'then the order before');
    sim.rewindTo(rewindTarget(sim));
    assert.equal(sim.log.length, 1);
    assert.equal(rewindTarget(sim), a.t - DT);
    sim.rewindTo(rewindTarget(sim));
    assert.equal(sim.log.length, 0);
    assert.equal(rewindTarget(sim), null);
  });

  it('orders given together while paused are taken back together', () => {
    const sim = quiet();
    run(sim, 3);
    issue(sim, [formOrder(sim, 'all'), stanceOrder(sim, 'all')]);
    assert.equal(sim.log.length, 2);
    sim.rewindTo(rewindTarget(sim));
    assert.equal(sim.log.length, 0);
    assert.ok(sim.squad.every((s) => !s.form && s.stance === 'engage'));
  });

  it('plan mode: an order issued while paused is stamped with the paused time', () => {
    const sim = quiet();
    run(sim, 7);
    const t = sim.t;
    const [e] = issue(sim, formOrder(sim, 'all'));
    assert.equal(e.t, t);
    assert.equal(sim.t, t);
    assert.ok(sim.squad[1].form);
  });
});

describe('the information the scene shows', () => {
  it('a hull is a share of her own full hull, so the escort starts at 100 per cent', () => {
    const sim = quiet();
    for (const s of sim.squad) assert.equal(hullFrac(s), 1, s.role);
    assert.equal(hullMax(sim.squad[3]), hullMax(sim.squad[0]), 'no role has a bigger hull');
    sim.squad[0].hp = hullMax(sim.squad[0]) / 2;
    assert.equal(hullFrac(sim.squad[0]), 0.5);
  });

  it('contacts are named by kind and by the order they came', () => {
    const sim = quiet();
    const mk = (team, kind) => sim.newShip(5000, 0, 0, team, kind);
    const a = mk(1, 'frigate'), d = mk(1, 'drone'), m = mk(2, 'merchant'), b = mk(1, 'frigate');
    const lab = (s, kind) => contactLabel(sim, { idx: s.idx, team: s.team, kind });
    assert.equal(lab(a, 'frigate').code, 'R1');
    assert.equal(lab(b, 'frigate').code, 'R2');
    assert.equal(lab(d, 'drone').name, 'Drone 1');
    assert.equal(lab(m, 'merchant').code, 'M1');
    assert.equal(lab(a, null).code, '?');
    assert.equal(lab(a, 'frigate').hostile, true);
  });

  it('every order has a readable line', () => {
    const sim = quiet();
    const lines = issue(sim, [courseOrder(sim, 'all', 10), speedOrder(sim, 1, 1), formOrder(sim, 'all'), stanceOrder(sim, 2), ...gotoOrders(sim, 1, 5, 6)]).map(describeOrder);
    assert.deepEqual(lines, ['All ships: course 010', 'Ship 2: speed 22 kn', 'Ships 2, 3, 4: Column', 'Ship 3: hold fire', 'Ship 2: go to 5, 6']);
    assert.equal(describeOrder({ type: 'sector', to: 1, sector: { from: 300, to: 60 } }), 'Ship 2: patrol 300-060');
  });

  it('the alert feed gives each alert once, and nothing old after a rewind', () => {
    const sim = quiet(5, { planThreats: hooks.planThreats });
    const feed = new AlertFeed();
    let n = 0;
    const texts = [];
    for (let i = 0; i < 100 * 120; i++) {
      sim.step(DT);
      if (i % 30 === 0) for (const a of feed.take(sim)) { n += 1; texts.push(a.text); }
    }
    assert.equal(feed.take(sim).length, 0, 'asked again, nothing new');
    assert.equal(n, sim.alerts().length, 'every alert was delivered exactly once');
    sim.rewindTo(40);
    feed.sync(sim);
    assert.equal(feed.take(sim).length, 0, 'a rewind is not news');
    assert.equal(targets(sim, 'all').length, 4);
  });
});

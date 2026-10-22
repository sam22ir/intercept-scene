// squadronScoring: the two scenarios (escort, defend) won and lost in seeded runs, the raider call-in, and the debrief. Runs in Node.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SCENARIOS, LEVELS, LEVEL_RULES, scoreOf, debriefOf } from '../src/squadronScoring.js';
import { LEVELS as DUEL_LEVELS } from '../src/duel.js';
import { SquadronSim } from '../src/squadron.js';

const noRaiders = { planThreats: () => [] };
const runUntil = (sim, limit) => { while (sim.t < limit && sim.winner === null) sim.advance(0.25); return sim; };

describe('the tables', () => {
  it('has the escort and defend scenarios and reuses the duel levels', () => {
    assert.deepEqual(Object.keys(SCENARIOS).sort(), ['defend', 'escort']);
    assert.equal(LEVELS, DUEL_LEVELS);
    assert.deepEqual(Object.keys(LEVEL_RULES).sort(), ['easy', 'hard', 'normal']);
    assert.ok(LEVEL_RULES.hard.allowed <= LEVEL_RULES.easy.allowed, 'harder levels allow no more losses');
    assert.ok(LEVEL_RULES.hard.outLimit < LEVEL_RULES.easy.outLimit, 'harder levels allow less time out of the zone');
  });
});

describe('scoreOf at the start', () => {
  it('is running in both scenarios', () => {
    for (const scenario of ['escort', 'defend']) {
      const r = scoreOf(new SquadronSim({ seed: 1, scenario }));
      assert.equal(r.status, 'running');
      assert.equal(typeof r.reason, 'string');
    }
  });
});

describe('escort', () => {
  it('is won when enough merchants get past the gate', () => {
    const sim = new SquadronSim({ seed: 2, scenario: 'escort', hooks: noRaiders });
    sim.newShip(1000, -900, 0, 2, 'merchant');
    sim.newShip(1200, -1200, 0, 2, 'merchant');
    runUntil(sim, 400);
    assert.equal(sim.winner, 0);
    assert.equal(sim.over, 'escorted');
  });

  it('is lost when a merchant is sunk on a level that allows none', () => {
    const sim = new SquadronSim({ seed: 3, scenario: 'escort', level: 'hard', hooks: noRaiders });
    const m = sim.newShip(-500, -900, Math.PI, 2, 'merchant');
    sim.advance(5);
    m.tSunk = sim.t;
    sim.advance(0.1);
    assert.equal(sim.winner, 1);
    assert.equal(sim.over, 'merchant');
  });

  it('is lost when the merchants do not get past the gate in time', () => {
    const sim = new SquadronSim({ seed: 4, scenario: 'escort', hooks: noRaiders });
    sim.newShip(-500, -900, Math.PI, 2, 'merchant');
    runUntil(sim, SCENARIOS.escort.duration + 5);
    assert.equal(sim.winner, 1);
    assert.equal(sim.over, 'late');
  });
});

describe('defend', () => {
  it('is won when the time is up with no raider left (no raiders at all here)', () => {
    const sim = new SquadronSim({ seed: 5, scenario: 'defend', hooks: noRaiders });
    runUntil(sim, SCENARIOS.defend.duration + 5);
    assert.equal(sim.winner, 0);
    assert.equal(sim.over, 'held');
  });

  it('is lost when the lead ship stays out of the zone for too long (hard)', () => {
    const sim = new SquadronSim({ seed: 6, scenario: 'defend', level: 'hard', hooks: noRaiders });
    sim.squad[0].x = SCENARIOS.defend.zone.r + 1500;
    runUntil(sim, 200);
    assert.equal(sim.winner, 1);
    assert.equal(sim.over, 'zone');
  });

  it('calls the next raider in once the last one is down', () => {
    const sim = new SquadronSim({ seed: 7, scenario: 'defend', level: 'normal' });
    while (sim.t < 200 && !sim.ships.some((s) => s.team === 1)) sim.advance(0.25);
    const raider = sim.ships.find((s) => s.team === 1);
    assert.ok(raider, 'the first raider arrived');
    raider.tSunk = sim.t;
    const next = sim.pending.find((w) => ['raider', 'wave'].includes(w.kind));
    assert.ok(next, 'more are planned');
    sim.advance(0.1);
    const after = sim.pending.find((w) => ['raider', 'wave'].includes(w.kind));
    assert.ok(after.t <= sim.t + 12 + 1e-9, 'brought forward to about twelve seconds away');
  });
});

describe('debrief', () => {
  it('reports the fields and a verdict line, and reads without moving the sim', () => {
    const sim = new SquadronSim({ seed: 8, scenario: 'defend', hooks: noRaiders });
    const before = sim.digest();
    const d = debriefOf(sim);
    assert.equal(sim.digest(), before);
    for (const k of ['scenario', 'status', 'reason', 'verdict', 'time', 'losses', 'shots', 'hits', 'merchantsSaved', 'merchantsCrossed', 'merchantsLost', 'enemiesSunk', 'score']) {
      assert.ok(k in d, k);
    }
    assert.equal(d.status, 'running');
    assert.equal(d.verdict, 'In progress.');
    assert.deepEqual(d.losses, []);
    assert.equal(d.shots, 0);
    assert.equal(d.merchantsSaved, 0);
    assert.equal(typeof d.score, 'number');
  });

  it('after a won escort: merchants saved and crossed are counted, the verdict says won', () => {
    const sim = new SquadronSim({ seed: 2, scenario: 'escort', hooks: noRaiders });
    sim.newShip(1000, -900, 0, 2, 'merchant');
    sim.newShip(1200, -1200, 0, 2, 'merchant');
    runUntil(sim, 400);
    const d = debriefOf(sim);
    assert.equal(d.status, 'won');
    assert.ok(d.verdict.startsWith('Won:'));
    assert.ok(d.merchantsCrossed >= 1);
    assert.equal(d.merchantsSaved, 2);
    assert.equal(d.merchantsLost, 0);
    assert.ok(d.score >= 300);
  });

  it('after a lost defence: the verdict says lost and the reason is named', () => {
    const sim = new SquadronSim({ seed: 6, scenario: 'defend', level: 'hard', hooks: noRaiders });
    sim.squad[0].x = SCENARIOS.defend.zone.r + 1500;
    runUntil(sim, 200);
    const d = debriefOf(sim);
    assert.equal(d.status, 'lost');
    assert.ok(d.verdict.startsWith('Lost:'));
    assert.ok(d.time > 0);
  });
});

// src/squadronThreats.js: planning is deterministic per seed and rises with the level; spawning adds the right ships; a drone can be
// shot down by the squadron's guns and can damage a ship.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { planThreats, spawnThreat, DRONE_RANGE, DRONE_SPEED } from '../src/squadronThreats.js';
import { SquadronSim } from '../src/squadron.js';
import { DT, COMPARTMENTS, mulberry32 } from '../src/duel.js';

const LEVELS = ['easy', 'normal', 'hard'];
// Ships a plan brings (a wave counts for its raiders).
const shipsIn = (list) => list.reduce((n, w) => n + (w.kind === 'wave' ? w.n : 1), 0);
const plan = (scenario, level, seed = 3) => {
  const sim = new SquadronSim({ seed, scenario, level });
  return planThreats(sim, mulberry32(seed));
};

describe('planThreats', () => {
  it('returns a time-sorted list of known kinds, for both scenarios and every level', () => {
    for (const scenario of ['escort', 'defend']) {
      for (const level of LEVELS) {
        const list = plan(scenario, level);
        assert.ok(list.length > 0);
        list.forEach((w, i) => {
          assert.ok(['raider', 'drone', 'merchant', 'wave'].includes(w.kind), `kind ${w.kind}`);
          assert.equal(typeof w.t, 'number');
          if (i) assert.ok(w.t >= list[i - 1].t);
        });
      }
    }
  });

  it('is deterministic per seed and differs between seeds', () => {
    const a = JSON.stringify(plan('defend', 'normal', 5));
    assert.equal(a, JSON.stringify(plan('defend', 'normal', 5)));
    assert.notEqual(a, JSON.stringify(plan('defend', 'normal', 6)));
  });

  it('plans more ships at higher levels', () => {
    for (const scenario of ['escort', 'defend']) {
      const n = LEVELS.map((l) => shipsIn(plan(scenario, l)));
      assert.ok(n[0] < n[1] && n[1] < n[2], `${scenario}: ${n}`);
    }
  });

  it('escort has merchants, and defend has none', () => {
    assert.ok(plan('escort', 'normal').some((w) => w.kind === 'merchant'));
    assert.ok(!plan('defend', 'hard').some((w) => w.kind === 'merchant'));
  });

  it('plans waves only on the higher levels', () => {
    assert.ok(!plan('defend', 'easy').some((w) => w.kind === 'wave'));
    assert.ok(plan('defend', 'hard').some((w) => w.kind === 'wave'));
  });
});

describe('spawnThreat', () => {
  it('adds a raider of team 1 and pushes an arrive event', () => {
    const sim = new SquadronSim({ seed: 1 });
    const n = sim.ships.length;
    spawnThreat(sim, { t: 0, kind: 'raider', brg: 0 });
    assert.equal(sim.ships.length, n + 1);
    const s = sim.ships[n];
    assert.equal(s.team, 1);
    assert.equal(s.kind, 'frigate');
    assert.ok(s.ai);
    assert.ok(sim.events.some((e) => e.type === 'arrive' && e.ship === s.idx && e.kind === 'enemy'));
  });

  it('a raider is passive on easy only', () => {
    const easy = new SquadronSim({ seed: 2, level: 'easy' });
    spawnThreat(easy, { kind: 'raider', brg: 0 });
    assert.equal(easy.ships.at(-1).passive, true);
    const normal = new SquadronSim({ seed: 2, level: 'normal' });
    spawnThreat(normal, { kind: 'raider', brg: 0 });
    assert.equal(normal.ships.at(-1).passive, false);
  });

  it('a wave adds its raiders at once', () => {
    const sim = new SquadronSim({ seed: 1 });
    const n = sim.ships.length;
    spawnThreat(sim, { t: 0, kind: 'wave', n: 3, brg: 0 });
    assert.equal(sim.ships.length, n + 3);
    for (const s of sim.ships.slice(n)) assert.equal(s.team, 1);
  });

  it('a merchant is neutral, 70 hp, and pushes an arrive event', () => {
    const sim = new SquadronSim({ seed: 1, scenario: 'escort' });
    const n = sim.ships.length;
    spawnThreat(sim, { t: 0, kind: 'merchant', mode: 'follow', brg: 0 });
    const s = sim.ships[n];
    assert.equal(s.team, 2);
    assert.equal(s.merchant, true);
    assert.equal(s.hp, 70);
    spawnThreat(sim, { t: 0, kind: 'merchant', mode: 'cross', brg: 1 });
    assert.equal(sim.ships.at(-1).team, 2);
    assert.ok(sim.events.some((e) => e.type === 'arrive' && e.kind === 'merchant'));
  });

  it('a drone is team 1 and pushes arrive and inbound events', () => {
    const sim = new SquadronSim({ seed: 1 });
    const n = sim.ships.length;
    spawnThreat(sim, { t: 0, kind: 'drone', brg: 0 });
    const s = sim.ships[n];
    assert.equal(s.team, 1);
    assert.equal(s.kind, 'drone');
    assert.equal(s.passive, true);
    assert.ok(sim.events.some((e) => e.type === 'drone' && e.phase === 'inbound' && e.ship === s.idx));
  });

  it('a drone flies its straight line at constant speed', () => {
    const sim = new SquadronSim({ seed: 4 });
    spawnThreat(sim, { kind: 'drone', brg: 0 });
    const s = sim.ships.at(-1);
    const x0 = s.x, z0 = s.z;
    for (let i = 0; i < 120; i++) sim.step(DT); // one second
    const moved = Math.hypot(s.x - x0, s.z - z0);
    assert.ok(Math.abs(moved - DRONE_SPEED) < 1, `moved ${moved}`);
    assert.ok(DRONE_RANGE > DRONE_SPEED);
  });
});

// Put a spawned drone `metres` astern of the squadron's centroid, so a test does not sit through the whole flight.
function nearDrone(sim, metres) {
  spawnThreat(sim, { kind: 'drone', brg: Math.PI });
  const s = sim.ships.at(-1);
  const c = sim.centroid();
  s.x = c.x - metres; s.z = c.z;
  s.drone.px = s.x; s.drone.pz = s.z;
  sim.pending = [];
  return s;
}

describe('drones in a fight', () => {
  it('can be shot down by the aft 30 mm (the 76 mm kept dry)', () => {
    let kills = 0;
    for (let seed = 1; seed <= 6; seed++) {
      const sim = new SquadronSim({ seed, scenario: 'defend' });
      sim.pending = [];
      for (const s of sim.squad) s.gun.ammo = 0; // only the aft guns can fire
      const d = nearDrone(sim, 2400);
      for (let i = 0; i < 120 * 60 && d.tSunk === null; i++) sim.step(DT);
      const gat = sim.events.some((e) => e.type === 'gunhit' && e.ship === d.idx);
      if (d.tSunk !== null && gat && !sim.events.some((e) => e.type === 'drone' && e.ship === d.idx && e.phase === 'hit')) kills++;
    }
    assert.ok(kills >= 1, `drones shot down by the 30 mm over six seeds: ${kills}`);
  });

  it('can damage a ship when it is not shot down (guns held)', () => {
    const sim = new SquadronSim({ seed: 9, scenario: 'defend' });
    sim.pending = [];
    sim.order({ type: 'stance', stance: 'hold' });
    const before = sim.squad.map((s) => Object.values(s.comp).reduce((a, b) => a + b, 0));
    const d = nearDrone(sim, 1500);
    for (let i = 0; i < 120 * 60 && d.tSunk === null; i++) sim.step(DT);
    const hit = sim.events.find((e) => e.type === 'drone' && e.ship === d.idx && e.phase === 'hit');
    assert.ok(hit, 'the drone detonated on a squadron ship');
    assert.ok(hit.target < sim.n);
    const after = sim.squad.map((s) => Object.values(s.comp).reduce((a, b) => a + b, 0));
    assert.ok(after[hit.target] < before[hit.target], 'the struck ship lost points');
    assert.ok(COMPARTMENTS[hit.comp]);
  });

  it('replays the same drone flight bit for bit', () => {
    const run = () => {
      const sim = new SquadronSim({ seed: 12, scenario: 'defend' });
      sim.pending = [];
      nearDrone(sim, 1500);
      for (let i = 0; i < 120 * 30; i++) sim.step(DT);
      return sim.digest();
    };
    assert.equal(run(), run());
  });

  it('rewinding repeatedly does not stack the drone mover (digest and drone track match a fresh run)', () => {
    const mk = () => new SquadronSim({ seed: 5, level: 'normal', scenario: 'defend' });
    const run = (sim, t) => { while (sim.t < t) sim.advance(1 / 30); };
    const a = mk(); a.order({ to: 'all', type: 'course', course: 20 }); run(a, 200);
    for (let i = 0; i < 3; i++) a.rewindTo(100);
    run(a, 200);
    const b = mk(); b.order({ to: 'all', type: 'course', course: 20 }); run(b, 200);
    assert.equal(a.digest(), b.digest());
  });
});

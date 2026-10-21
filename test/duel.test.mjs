// The ship duel's simulation (src/duel.js): handling shared with Solo Air Defense, the weapons' arcs and ranges, the
// damage and what each compartment does, the sinking, and the enemy's three levels. Everything is seeded and runs in Node.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DuelSim, DT, MAIN_ARC, MAIN_RANGE, GUN_RANGE, HULL_HP, COMPARTMENTS, COMP_IDS, LEVELS, DUEL_LEVELS, SINK_TIME,
  zoneAt, segmentBox, sinkState, gunBlind, TELEGRAPH, AMMO_STOCK, AMMO_TYPES, SWITCH_TIME, MAIN_ROUNDS,
} from '../src/duel.js';

const run = (sim, seconds, input = {}) => { for (let i = 0; i < seconds * 10; i++) sim.advance(0.1, input); };
// A duel between the player's ship (handed to a helmsman of level `auto`, or steady) and the enemy, until one sinks.
function duel({ seed, level = 'normal', auto = null, limit = 900, input = () => ({}) }) {
  const sim = new DuelSim({ seed, level, auto });
  while (sim.t < limit && sim.winner === null) sim.advance(0.1, input(sim.t));
  return sim;
}

describe('the ships', () => {
  it('start apart, bow to bow, at half ahead on a steady course', () => {
    const sim = new DuelSim({ seed: 3 });
    assert.ok(sim.range() > 4000 && sim.range() < 7000, `range ${sim.range()}`);
    assert.ok(Math.abs(sim.relBearing(sim.player)) < 0.4, 'the enemy is ahead of you');
    assert.ok(Math.abs(sim.relBearing(sim.enemy)) < 0.4, 'and you are ahead of her');
    assert.equal(TELEGRAPH[sim.player.order].name, 'Half');
    assert.deepEqual(sim.player.comp, Object.fromEntries(COMP_IDS.map((id) => [id, COMPARTMENTS[id].hp])));
    assert.equal(sim.player.hp, HULL_HP);
  });

  it('answers the wheel and the telegraph like the Solo Air Defense frigate, with a wider turn', () => {
    const sim = new DuelSim({ seed: 3, level: 'easy' });
    sim.enemy.ai = null; sim.enemy.cmd = { want: 0, fire: false, gat: false };
    sim.telegraph(0, +2);
    run(sim, 10, { right: 1 });
    assert.ok(sim.player.rudder > 0 && sim.player.psi > 0.3, 'she turns to starboard');
    run(sim, 30);
    assert.ok(sim.knots(sim.player) > 18, `she works up to ${sim.knots(sim.player)} kn`);
  });

  it('keeps the enemy a helmsman and hands none to the player', () => {
    const sim = new DuelSim({ seed: 3 });
    assert.ok(sim.enemy.ai && !sim.player.ai);
    assert.ok(new DuelSim({ seed: 3, auto: 'hard' }).player.ai, 'a test can give the player a helmsman');
  });
});

describe('the guns obey their arcs and ranges, for both ships', () => {
  for (const seed of [1, 2, 3]) {
    it(`seed ${seed}: no 76 mm round leaves outside the arc or range, and no 30 mm gun fires into its dead zone`, () => {
      const sim = new DuelSim({ seed, level: 'hard', auto: 'normal' });
      let shots = 0, bursts = 0;
      for (let i = 0; i < 120 * 200 && sim.winner === null; i++) {
        sim.step(DT, {});
        for (const e of sim.takeEvents()) {
          if (e.type !== 'shot') continue;
          shots++;
          const s = sim.ships[e.owner];
          assert.ok(Math.abs(s.gun.yaw) <= MAIN_ARC + 0.02, `ship ${e.owner} fired at yaw ${(s.gun.yaw * 57.3).toFixed(0)}`);
          assert.ok(sim.range() <= MAIN_RANGE + 60, 'inside range');
        }
        for (const s of sim.ships) s.gats.forEach((g, k) => {
          if (!g.firing) return;
          bursts++;
          assert.ok(!(gunBlind(k, g.yaw + 0.06) && gunBlind(k, g.yaw - 0.06)), `gun ${k} fired deep in its dead zone`);
          assert.ok(sim.range() <= GUN_RANGE + 80, `the 30 mm fired at ${sim.range().toFixed(0)} m`);
        });
      }
      assert.ok(shots > 10, `the duel had ${shots} rounds`);
    });
  }

  it('the 30 mm guns have the dead zones of Solo Air Defense', () => {
    assert.ok(gunBlind(0, 0) && gunBlind(1, 0), 'both blind dead ahead');
    assert.ok(!gunBlind(0, Math.PI) && !gunBlind(1, Math.PI), 'both free astern');
    assert.ok(!gunBlind(0, 1.2) && gunBlind(1, 1.2) , 'abeam only the near gun (yaw + is to port)');
  });

  it('the 76 mm does not fire at a ship astern of it', () => {
    const sim = new DuelSim({ seed: 4, level: 'easy' });
    sim.enemy.x = sim.player.x - 3000; // dead astern
    sim.enemy.z = sim.player.z;
    sim.enemy.ai = null; sim.enemy.cmd = { want: 0, fire: false, gat: false };
    run(sim, 30, { fire: true });
    assert.equal(sim.player.stats.shells, 0, 'nothing leaves');
    assert.equal(sim.player.gun.engaged, false);
  });
});

describe('the fire control', () => {
  it('hits a target going straight at an even speed, even at long range', () => {
    let shells = 0, hits = 0;
    for (const seed of [1, 2, 3, 4]) {
      const sim = new DuelSim({ seed, level: 'easy' });
      sim.enemy.ai = null; sim.enemy.cmd = { want: 0, fire: false, gat: false };
      sim.enemy.x = 4500; sim.enemy.z = 300; sim.enemy.psi = Math.PI / 2;
      run(sim, 90, { fire: true });
      shells += sim.player.stats.shells; hits += sim.player.stats.hits;
    }
    assert.ok(hits / shells > 0.4, `${hits} of ${shells} on a steady target`);
  });

  it('scatters more while the firing ship turns, and more as her bridge is hurt', () => {
    const sim = new DuelSim({ seed: 1 });
    const s = sim.player;
    const steady = sim.scatter(s);
    s.r = 0.15;
    assert.ok(sim.scatter(s) > steady * 1.8, 'a turning ship shoots wide');
    s.r = 0;
    sim.damage(s, 'bridge', 20, 0);
    assert.ok(sim.scatter(s) > steady * 1.5, 'a hurt bridge shoots wide');
  });

  it('a target that has just changed course is not where the fire control thinks (the estimate lags)', () => {
    const sim = new DuelSim({ seed: 1, level: 'easy' });
    sim.enemy.ai = null; sim.enemy.cmd = { want: 0, fire: false, gat: false };
    run(sim, 5);
    const before = sim.player.est.slice();
    sim.enemy.psi += Math.PI / 2; // a sharp change of course
    run(sim, 1);
    const v = sim.velOf(sim.enemy);
    assert.ok(Math.hypot(sim.player.est[0] - v[0], sim.player.est[1] - v[2]) > 4, 'it still believes the old velocity');
    run(sim, 20);
    const v2 = sim.velOf(sim.enemy);
    assert.ok(Math.hypot(sim.player.est[0] - v2[0], sim.player.est[1] - v2[2]) < 1, 'and catches up');
    assert.ok(before);
  });

  it('presenting the bow takes fewer hits than presenting the beam', () => {
    const rate = (psi) => {
      let shells = 0, hits = 0;
      for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
        const sim = new DuelSim({ seed, level: 'hard' });
        sim.player.psi = psi; // a steady course, bow toward the enemy or beam on
        const v = sim.velOf(sim.player); sim.enemy.est = [v[0], v[2]];
        run(sim, 150);
        shells += sim.enemy.stats.shells; hits += sim.enemy.stats.hits;
      }
      return hits / shells;
    };
    assert.ok(rate(0) < rate(Math.PI / 2) * 0.97, 'bow on is the narrower target');
  });
});

describe('hits and damage', () => {
  it('finds a shell that crosses the hull in one step, which a point test would miss', () => {
    assert.ok(segmentBox([0, 5, -40], [0, 5, 40]), 'across the beam in one 80 m step');
    assert.ok(segmentBox([-300, 8, 0], [300, 8, 0]), 'the length of the hull');
    assert.equal(segmentBox([0, 5, 30], [0, 5, 60]), null, 'alongside');
    assert.equal(segmentBox([0, 25, -40], [0, 25, 40]), null, 'over the mast');
    assert.equal(segmentBox([0, -5, -40], [0, -1, 40]), null, 'under the sea');
  });

  it('puts a hit in the compartment under it', () => {
    assert.equal(zoneAt(32), 'gun');
    assert.equal(zoneAt(17), 'bridge');
    assert.equal(zoneAt(0), 'engine');
    assert.equal(zoneAt(-33.6), 'guns');
    assert.equal(zoneAt(-50), 'steering');
  });

  it('a shell lands in the compartment it hits and costs it and the hull', () => {
    const sim = new DuelSim({ seed: 5, level: 'easy' });
    const e = sim.enemy;
    e.psi = Math.PI; e.heel = 0; // bow south, so her forward end is at the lower x
    sim.shells.push({ id: 1, owner: 0, t0: 0, p: [e.x - 30, 8, e.z], v: [0, -100, 0] });
    sim.advance(0.05);
    const ev = sim.takeEvents().find((x) => x.type === 'hit');
    assert.ok(ev, 'a hit');
    assert.equal(ev.comp, 'gun', 'forward of the bridge is the 76 mm');
    assert.ok(e.comp.gun < COMPARTMENTS.gun.hp && e.hp < HULL_HP);
    assert.equal(sim.player.stats.hits, 1);
  });

  it('an engine hit slows her, a steering hit limits the rudder, a gun hit slows the loading', () => {
    const top = (sim, s) => { sim.telegraph(s.idx, +2); sim.enemy.ai = null; sim.enemy.cmd = { want: 0, fire: false, gat: false }; };
    const speed = (hurt) => { const sim = new DuelSim({ seed: 2 }); top(sim, sim.player); if (hurt) sim.damage(sim.player, 'engine', hurt, 0); run(sim, 120); return sim.knots(sim.player); };
    assert.ok(Math.abs(speed(0) - 28) < 0.5, 'flank is 28 kn');
    assert.ok(speed(20) < speed(0) - 3, 'half the engine room: slower');
    assert.ok(speed(40) < 6.5, 'no engine room: dead slow');
    const rudder = (hurt) => { const sim = new DuelSim({ seed: 2 }); sim.enemy.ai = null; sim.enemy.cmd = { want: 0, fire: false, gat: false }; if (hurt) sim.damage(sim.player, 'steering', 30, 0); run(sim, 10, { right: 1 }); return sim.player.rudder; };
    assert.ok(rudder(true) < rudder(false) * 0.3, 'steering out: a quarter of the throw');
    const sim = new DuelSim({ seed: 2 });
    sim.damage(sim.player, 'gun', 15, 0);
    sim.player.gun.cool = 1;
    run(sim, 0.5);
    assert.ok(sim.player.gun.cool > 0.6, 'a hurt gun loads slower (a sound one would be at 0.5)');
  });

  it('a compartment that is out stays out and floods the ship', () => {
    const sim = new DuelSim({ seed: 2 });
    sim.damage(sim.player, 'engine', 100, 0);
    const hp = sim.player.hp;
    run(sim, 30);
    assert.equal(sim.player.comp.engine, 0);
    assert.ok(sim.player.hp < hp - 2, 'flooding costs the hull');
    assert.ok(sim.takeEvents().some((e) => e.type === 'out' && e.comp === 'engine'));
  });

  it('the second aft gun fails at half, both at zero', () => {
    const sim = new DuelSim({ seed: 2 });
    sim.enemy.ai = null; sim.enemy.cmd = { want: 0, fire: false, gat: false };
    sim.enemy.x = sim.player.x - 1200; sim.enemy.z = sim.player.z; // astern, in the dead zone's clear side
    sim.damage(sim.player, 'guns', 20, 0); // 10 of 30 left: the second is out
    run(sim, 5);
    assert.ok(sim.player.gats[1].spinRate < 1, 'the second gun is dead');
    assert.ok(sim.player.gats[0].spinRate > 10, 'the first still turns onto the target');
  });
});

describe('the sinking', () => {
  it('sinks a ship whose hull runs out, ends the duel and names the winner', () => {
    const sim = new DuelSim({ seed: 6, level: 'easy' });
    for (const id of COMP_IDS) sim.damage(sim.enemy, id, 1000, 0);
    run(sim, 1000 / 10 * 0.2); // flooding does the rest
    let n = 0;
    while (sim.enemy.tSunk === null && n++ < 4000) run(sim, 1);
    assert.ok(sim.enemy.tSunk !== null, 'she sank');
    assert.equal(sim.winner, 0, 'you won');
    const ev = sim.takeEvents();
    assert.ok(ev.some((e) => e.type === 'sunk' && e.ship === 1) && ev.some((e) => e.type === 'over' && e.winner === 0));
    const t = sim.enemy.tSunk;
    run(sim, 30);
    assert.ok(sim.enemy.u < 1.5, 'she loses way');
    assert.equal(sim.enemy.tSunk, t, 'it is only once');
  });

  it('sinks in a smooth, closed-form way: rolls over, goes bow down, goes under, and is gone', () => {
    let prev = sinkState(0);
    assert.equal(prev.roll, 0);
    for (let a = 1; a <= SINK_TIME; a++) {
      const s = sinkState(a);
      assert.ok(s.depth <= prev.depth + 1e-9 && Math.abs(s.roll) >= Math.abs(prev.roll) - 1e-9, `monotonic at ${a} s`);
      prev = s;
    }
    assert.ok(sinkState(SINK_TIME - 1).gone === false && sinkState(SINK_TIME).gone === true);
    assert.ok(sinkState(30, -1).roll < 0 && sinkState(30, 1).roll > 0, 'to the side she was hit on');
    assert.ok(sinkState(10).smoke > 0.5, 'smoking');
  });

  for (const [seed, level] of [[1, 'easy'], [2, 'normal'], [3, 'hard']]) {
    it(`a seeded ${level} duel runs to a sinking in under ten minutes`, () => {
      const sim = duel({ seed, level, auto: 'normal', limit: 600 });
      assert.notEqual(sim.winner, null, `still afloat at ${sim.t.toFixed(0)} s`);
      assert.ok(sim.ships[1 - sim.winner].tSunk !== null);
      assert.ok(sim.t > 45, `over in ${sim.t.toFixed(0)} s: not too quick`);
    });
  }
});

describe('the enemy', () => {
  it('has three levels that change her decisions and aim, not the physics', () => {
    assert.deepEqual(DUEL_LEVELS, ['easy', 'normal', 'hard']);
    const k = ['think', 'aim', 'track', 'jink', 'range'];
    for (const key of k) {
      const [e, n, h] = DUEL_LEVELS.map((l) => LEVELS[l][key]);
      assert.ok(key === 'jink' ? e <= n && n <= h : key === 'range' ? e >= n && n >= h : e >= n && n >= h, `${key}: ${e} ${n} ${h}`);
    }
    assert.equal(new DuelSim({ level: 'nonsense' }).level, 'normal');
  });

  it('hits a steady target more often at each level up', () => {
    const rate = (level) => {
      let shells = 0, hits = 0;
      for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
        const sim = duel({ seed, level, limit: 150 });
        shells += sim.enemy.stats.shells; hits += sim.enemy.stats.hits;
      }
      return hits / shells;
    };
    const [e, n, h] = DUEL_LEVELS.map(rate);
    assert.ok(e < n && n < h, `hit rates ${e.toFixed(2)} < ${n.toFixed(2)} < ${h.toFixed(2)}`);
  });

  it('a Hard helmsman beats an Easy one far more often than not, whichever side she is on', () => {
    let hardWins = 0, games = 0;
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const a = duel({ seed, level: 'easy', auto: 'hard', limit: 900 });
      const b = duel({ seed, level: 'hard', auto: 'easy', limit: 900 });
      if (a.winner === 0) hardWins++;
      if (b.winner === 1) hardWins++;
      games += 2;
    }
    assert.ok(hardWins >= 9, `Hard won ${hardWins} of ${games}`);
  });

  it('runs away when she is badly hurt, and fires only while the gun is on', () => {
    const sim = new DuelSim({ seed: 2, level: 'hard' });
    sim.enemy.hp = 10;
    run(sim, 60);
    assert.ok(sim.knots(sim.enemy) > 12, 'flat out');
    assert.ok(Math.abs(sim.relBearing(sim.enemy)) > 1.5, 'her stern turned to you');
  });
});

describe('a run is repeatable', () => {
  it('the same seed gives the same duel, a different seed another', () => {
    const log = (seed) => { const sim = new DuelSim({ seed, level: 'normal', auto: 'normal' }); const out = []; for (let i = 0; i < 20 * 60; i++) { sim.advance(0.1, {}); for (const e of sim.takeEvents()) out.push([e.type, Math.round(sim.t * 10), e.comp ?? '']); } return JSON.stringify(out); };
    assert.equal(log(5), log(5));
    assert.notEqual(log(5), log(6));
  });

  it('does not depend on the frame rate it is advanced at', () => {
    const end = (dt) => { const sim = new DuelSim({ seed: 9, level: 'normal' }); for (let t = 0; t < 60; t += dt) sim.advance(dt, { right: 1 }); return [sim.player.x, sim.player.z, sim.enemy.x].map((v) => Math.round(v)); };
    const a = end(1 / 60), b = end(1 / 30);
    assert.ok(Math.abs(a[0] - b[0]) < 6 && Math.abs(a[1] - b[1]) < 6, `${a} vs ${b}`);
  });
});


describe('ammunition: HE and AP', () => {
  const still = (sim) => { sim.enemy.ai = null; sim.enemy.cmd = { want: 0, fire: false, gat: false }; };
  it('stocks add up to the old magazine and start on HE', () => {
    assert.equal(AMMO_STOCK.he + AMMO_STOCK.ap, MAIN_ROUNDS);
    const g = new DuelSim({ seed: 1 }).player.gun;
    assert.equal(g.type, 'he');
    assert.equal(g.ammo, MAIN_ROUNDS);
  });

  it('changing the kind costs a reload, and only to a kind that is in stock', () => {
    const sim = new DuelSim({ seed: 1 });
    const g = sim.player.gun;
    g.cool = 0;
    assert.ok(sim.switchAmmo(0));
    assert.equal(g.type, 'ap');
    assert.ok(g.cool >= SWITCH_TIME - 1e-9, 'a reload');
    assert.equal(sim.switchAmmo(0, 'ap'), false, 'already loaded');
    g.stock.he = 0;
    assert.equal(sim.switchAmmo(0), false, 'none left to load');
  });

  it('each shell is drawn from its own stock, and the total follows', () => {
    const sim = new DuelSim({ seed: 2, level: 'easy' });
    still(sim);
    sim.enemy.x = 3500; sim.enemy.z = 0; sim.enemy.psi = Math.PI / 2;
    sim.switchAmmo(0);
    run(sim, 40, { fire: true });
    const g = sim.player.gun;
    assert.equal(g.stock.he, AMMO_STOCK.he, 'HE untouched');
    assert.equal(g.stock.ap, AMMO_STOCK.ap - sim.player.stats.shells);
    assert.equal(g.ammo, g.stock.he + g.stock.ap);
    assert.ok(sim.player.stats.shells > 3);
  });

  it('AP hurts a compartment more than HE', () => {
    const dmg = (kind) => {
      const sim = new DuelSim({ seed: 5, level: 'easy' });
      const e = sim.enemy; e.psi = Math.PI; e.heel = 0;
      sim.shells.push({ id: 1, owner: 0, t0: 0, kind, p: [e.x - 30, 8, e.z], v: [0, -100, 0] });
      sim.advance(0.05);
      return sim.takeEvents().find((x) => x.type === 'hit').dmg;
    };
    assert.ok(dmg('ap') > dmg('he') * 2, 'AP is 2.5 times HE with the same draw');
    assert.ok(AMMO_TYPES.he.fire > 0 && AMMO_TYPES.ap.fire === 0);
  });

  it('when the loaded kind runs out the other is loaded, with the reload', () => {
    const sim = new DuelSim({ seed: 2, level: 'easy' });
    still(sim);
    const g = sim.player.gun;
    g.stock.he = 0; g.ammo = g.stock.ap; g.cool = 0;
    run(sim, 0.1);
    assert.equal(g.type, 'ap');
    assert.ok(g.cool > 3);
  });
});

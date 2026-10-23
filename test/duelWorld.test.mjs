// The ship duel with the others in it (src/duel.js): aiming at a part of a ship, targets, ships that arrive, hulls that touch and the merchants.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DuelSim, DT, COMPARTMENTS, COMP_IDS, MAIN_MOUNT, MUZZLE_V, MERCHANT_HP, segSeg } from '../src/duel.js';

const run = (sim, seconds, input = {}) => { for (let i = 0; i < seconds * 10; i++) sim.advance(0.1, input); };
const quiet = (s) => { s.ai = null; s.cmd = { want: 0, fire: false, gat: false }; s.u = 0; s.order = 1; };

describe('the aim point: the shell goes where the sight is', () => {
  // The enemy lies broadside to you 2.5 km north, bow to the east (her local +x is +z), both stopped.
  function broadside(seed = 7) {
    const sim = new DuelSim({ seed, level: 'easy' });
    for (const s of sim.ships) { s.u = 0; s.order = 1; }
    quiet(sim.enemy);
    sim.enemy.x = 2500; sim.enemy.z = 0; sim.enemy.psi = Math.PI / 2;
    sim.player.est = [0, 0]; sim.enemy.est = [0, 0];
    sim.setManual(0, true);
    return sim;
  }
  const pointOn = (sim, localX) => [sim.enemy.x, 6, sim.enemy.z + localX];
  const solveAt = (sim, localX) => sim.solve(sim.player, MAIN_MOUNT, MUZZLE_V, true, {}, { p: pointOn(sim, localX), v: [0, 0, 0] });

  it('solves for the point it is given, not the middle of the ship', () => {
    const sim = broadside();
    const mid = sim.solve(sim.player, MAIN_MOUNT, MUZZLE_V, true);
    const bow = solveAt(sim, 40), stern = solveAt(sim, -45);
    assert.ok(Math.abs(mid.yaw - (bow.yaw + stern.yaw) / 2) < 0.02, 'the middle is between them');
    assert.ok(bow.yaw < stern.yaw - 0.02, 'the bow end and the stern end are on different bearings');
    assert.ok(Math.abs(bow.range - mid.range) < 60);
  });

  for (const [name, localX, comp] of [['the 76 mm gun', 40, 'gun'], ['the engine room', -10, 'engine'], ['the steering', -50, 'steering']]) {
    it(`a stopped target: aiming at ${name} puts the hits there`, () => {
      const first = {};
      for (const seed of [7, 8, 9]) {
        const sim = broadside(seed);
        for (let i = 0; i < 20 * 120 && !first[seed]; i++) {
          const aim = solveAt(sim, localX);
          sim.advance(0.05, { fire: true, aim: { yaw: aim.yaw, pitch: aim.pitch, ship: 1 } });
          for (const e of sim.takeEvents()) if (e.type === 'hit' && e.owner === 0 && !first[seed]) first[seed] = e.comp;
        }
      }
      const right = Object.values(first).filter((c) => c === comp).length;
      assert.ok(right >= 2, `aimed at ${comp}, the first hits were ${JSON.stringify(first)}`);
    });
  }
});

describe('locked and unlocked shots', () => {
  // The enemy 2.5 km ahead, bow on to you (so a shell meets her bow first), both stopped.
  function bowOn(seed) {
    const sim = new DuelSim({ seed, level: 'easy' });
    for (const s of sim.ships) { s.u = 0; s.order = 1; }
    quiet(sim.enemy);
    sim.enemy.x = 2500; sim.enemy.z = 0; sim.enemy.psi = Math.PI;
    sim.player.est = [0, 0]; sim.enemy.est = [0, 0];
    sim.setManual(0, true);
    return sim;
  }
  const fireAt = (sim, local, lock) => {
    const hits = [];
    for (let i = 0; i < 20 * 60 && hits.length < 6; i++) {
      const p = sim.toWorld(sim.enemy, local);
      const aim = sim.solve(sim.player, MAIN_MOUNT, MUZZLE_V, true, {}, { p, v: [0, 0, 0] });
      sim.advance(0.05, { fire: true, aim: { yaw: aim.yaw, pitch: aim.pitch, ship: 1, ...(lock ? { lock } : {}) } });
      for (const e of sim.takeEvents()) if (e.type === 'hit' && e.owner === 0) hits.push(e);
    }
    return hits;
  };
  it('a locked shell lands in the compartment locked, whatever side she shows, and is not spread by scatter', () => {
    for (const [comp, local] of [['engine', [-13.5, 10, 0]], ['steering', [-52, 4, 0]], ['guns', [-33.6, 13, 0]]]) {
      const hits = fireAt(bowOn(5), local, comp);
      assert.ok(hits.length >= 4, `${comp}: ${hits.length} hits`);
      assert.ok(hits.every((h) => h.comp === comp), `${comp}: ${hits.map((h) => h.comp)}`);
    }
  });
  it('a locked hit takes 25 % of the compartment, a focused one 14 %, and a free shell falls in the sea', () => {
    const run = (extra) => {
      const sim = bowOn(6), hits = [], splashes = [];
      for (let i = 0; i < 20 * 60 && hits.length < 3; i++) {
        const p = sim.toWorld(sim.enemy, [-13.5, 10, 0]);
        const aim = sim.solve(sim.player, MAIN_MOUNT, MUZZLE_V, true, {}, { p, v: [0, 0, 0] });
        sim.advance(0.05, { fire: true, aim: { yaw: aim.yaw, pitch: aim.pitch, ship: 1, ...extra } });
        for (const e of sim.takeEvents()) { if (e.type === 'hit' && e.owner === 0) hits.push(e); if (e.type === 'splash' && e.owner === 0) splashes.push(e); }
      }
      return { hits, splashes };
    };
    const hp = COMPARTMENTS.engine.hp;
    const lock = run({ lock: 'engine' });
    assert.ok(lock.hits.length >= 3 && lock.hits.every((h) => h.comp === 'engine' && Math.abs(h.dmg - 0.25 * hp) < 1e-9));
    const focus = run({ focus: 'engine' });
    assert.ok(focus.hits.length >= 1 && focus.hits.every((h) => h.comp === 'engine' && Math.abs(h.dmg - 0.14 * hp) < 1e-9), JSON.stringify(focus.hits.map((h) => [h.comp, h.dmg])));
    const free = run({ free: true });
    assert.equal(free.hits.length, 0, 'no shell reaches her');
    assert.ok(free.splashes.length >= 3, 'they fall in the sea');
  });
});

describe('Easy: the ones that arrive do not fire', () => {
  it('a reinforcement is passive on Easy, armed on Normal, and a friend always fights', () => {
    const easy = new DuelSim({ seed: 3, level: 'easy' });
    easy.spawn({ kind: 'enemy', t: 0 }); easy.spawn({ kind: 'ally', t: 0 });
    assert.equal(easy.ships[2].passive, true);
    assert.ok(!easy.ships[3].passive);
    const normal = new DuelSim({ seed: 3, level: 'normal' });
    normal.spawn({ kind: 'enemy', t: 0 });
    assert.ok(!normal.ships[2].passive);
    easy.ships[2].x = easy.player.x + 1500; easy.ships[2].z = easy.player.z; easy.ships[2].psi = Math.PI;
    easy.enemy.x = 9e4; easy.enemy.z = 9e4; easy.ships[3].x = 9e4;
    run(easy, 20);
    assert.equal(easy.ships[2].stats.shells, 0, 'she never fires');
  });
});

describe('more ships', () => {
  it('a two-ship duel is unchanged: no one arrives unless waves are on', () => {
    const sim = new DuelSim({ seed: 3 });
    run(sim, 60);
    assert.equal(sim.ships.length, 2);
    assert.equal(sim.pending.length, 0);
  });

  it('with waves on, a merchant, a friendly frigate and enemy frigates come, on time and from afar', () => {
    const sim = new DuelSim({ seed: 5, level: 'normal', auto: 'normal', waves: true });
    const seen = [];
    while (sim.t < 240 && sim.winner === null) {
      sim.advance(0.1, {});
      for (const e of sim.takeEvents()) if (e.type === 'arrive') seen.push({ kind: e.kind, t: sim.t, range: e.range });
    }
    const kinds = (k) => seen.filter((x) => x.kind === k);
    assert.ok(kinds('merchant').length >= 1 && kinds('merchant')[0].t < 40, JSON.stringify(seen));
    assert.equal(kinds('ally').length, 1);
    for (const x of seen) assert.ok(x.range > 4000, `${x.kind} appeared ${x.range.toFixed(0)} m away`);
    const m = sim.ships.find((s) => s.merchant);
    assert.ok(m && m.team === 2 && !m.ai && m.target === -1, 'a merchant is neutral, unarmed and has no target');
    assert.equal(m.stats.shells, 0);
  });

  it('every warship targets the nearest living ship of the other side, and the player can lock one with Tab', () => {
    const sim = new DuelSim({ seed: 2, level: 'easy' });
    sim.spawn({ kind: 'enemy', t: 0 });
    const far = sim.ships[2];
    far.x = sim.player.x + 6000; far.z = sim.player.z + 3000;
    sim.enemy.x = sim.player.x + 2500; sim.enemy.z = sim.player.z;
    sim.pickTargets();
    assert.equal(sim.player.target, 1, 'the near one');
    const next = sim.cycleTarget(0);
    assert.equal(next.idx, 2, 'Tab takes the other');
    sim.player.x += 10; sim.pickTargets();
    assert.equal(sim.player.target, 2, 'and the lock holds although she is farther');
    far.tSunk = sim.t;
    sim.pickTargets();
    assert.equal(sim.player.target, 1, 'until she goes down');
    assert.equal(sim.setTarget(0, 2), false, 'a sunk ship cannot be locked');
  });

  it('there is no friendly fire, and a neutral is hit by anyone', () => {
    const sim = new DuelSim({ seed: 4, level: 'easy' });
    sim.spawn({ kind: 'ally', t: 0 }); sim.spawn({ kind: 'merchant', t: 0 });
    const ally = sim.ships[2], merch = sim.ships[3];
    for (const s of sim.ships) quiet(s);
    sim.player.x = 0; sim.player.z = 0; sim.player.psi = 0;
    ally.x = 800; ally.z = 0; ally.psi = Math.PI / 2;
    merch.x = 1500; merch.z = 0; merch.psi = Math.PI / 2;
    sim.enemy.x = 6000; sim.enemy.z = 3000;
    const shell = (x) => ({ id: 99, owner: 0, t0: sim.t, kind: 'he', p: [x - 5, 6, 0], v: [650, 0, 0] });
    sim.shells.push(shell(ally.x)); sim.stepShell(sim.shells[0], 0.02);
    assert.equal(sim.shells.length, 1, 'her own side is let through');
    sim.shells.length = 0;
    const sh2 = shell(merch.x); sim.shells.push(sh2); sim.stepShell(sh2, 0.02);
    assert.ok(sim.takeEvents().some((e) => e.type === 'hit' && e.ship === merch.idx && e.neutral), 'the merchant is hit');
    assert.ok(COMP_IDS.some((id) => merch.comp[id] < COMPARTMENTS[id].hp), 'and damaged');
  });

  it('sinking a merchant yourself loses the duel; the enemy sinking one does not', () => {
    const sim = new DuelSim({ seed: 6, level: 'easy' });
    sim.spawn({ kind: 'merchant', t: 0 });
    const m = sim.ships[2];
    m.lastHitBy = 1; m.hp = 0.001; m.leak.engine = 5;
    run(sim, 1);
    assert.notEqual(m.tSunk, null);
    assert.equal(sim.winner, null, 'the enemy sank it: no penalty');
    const sim2 = new DuelSim({ seed: 6, level: 'easy' });
    sim2.spawn({ kind: 'merchant', t: 0 });
    const m2 = sim2.ships[2];
    m2.lastHitBy = 0; m2.hp = 0.001; m2.leak.engine = 5;
    run(sim2, 1);
    assert.equal(sim2.winner, 1);
    assert.equal(sim2.over, 'merchant');
    assert.equal(sim2.merchantsSunk, 1);
    assert.equal(MERCHANT_HP, 70);
  });

  it('the next enemy is called in when the last is down, and you win only when none are left or coming', () => {
    const sim = new DuelSim({ seed: 8, level: 'normal', waves: true });
    quiet(sim.player); quiet(sim.enemy);
    sim.enemy.tSunk = 0.1;
    run(sim, 1);
    assert.equal(sim.winner, null, 'more are coming');
    const coming = sim.pending.find((w) => w.kind === 'enemy');
    assert.ok(coming && coming.t <= sim.t + 12.01, 'the next one is called in');
    run(sim, 14);
    const fresh = sim.ships.filter((s) => s.team === 1 && s.tSunk === null);
    assert.equal(fresh.length, 1);
    assert.equal(sim.winner, null);
    sim.pending = [];
    fresh[0].tSunk = sim.t;
    run(sim, 1);
    assert.equal(sim.winner, 0);
  });
});

describe('hulls that touch', () => {
  it('finds the closest approach of two centre lines', () => {
    const r = segSeg([0, 0], [10, 0], [5, 3], [5, 9]);
    assert.ok(Math.abs(r.d - 3) < 1e-9);
    const parallel = segSeg([0, 0], [10, 0], [2, 4], [8, 4]);
    assert.ok(Math.abs(parallel.d - 4) < 1e-9);
    assert.ok(segSeg([0, 0], [1, 0], [3, 0], [4, 0]).d > 1.99);
  });

  it('a ship rammed from the side is damaged where she is struck, both slow, and they part', () => {
    const sim = new DuelSim({ seed: 3, level: 'easy' });
    sim.spawn({ kind: 'enemy', t: 0 });
    const b = sim.ships[2];
    b.ai = null; b.cmd = { want: 0, fire: false, gat: false };
    sim.enemy.ai = null; sim.enemy.x = 9000; sim.enemy.z = 9000;
    const a = sim.player;
    a.x = 0; a.z = 0; a.psi = 0; a.u = 10; a.order = 3;
    b.x = 20; b.z = 95; b.psi = -Math.PI / 2; b.u = 10; b.order = 3; // bearing down on her starboard side, square on
    const hp0 = a.hp + b.hp;
    let hit = null;
    for (let i = 0; i < 120 * 12; i++) {
      sim.step(DT, {});
      for (const e of sim.takeEvents()) if (e.type === 'collision') hit ??= e;
    }
    assert.ok(hit, 'they collided');
    assert.ok(hit.impact > 3, `closing at ${hit.impact.toFixed(1)} m/s`);
    assert.ok(a.hp + b.hp < hp0, 'the hulls paid');
    assert.ok(COMP_IDS.some((id) => a.comp[id] < COMPARTMENTS[id].hp), 'a compartment was damaged');
  });

  it('ships sailing apart never collide', () => {
    const sim = new DuelSim({ seed: 3, level: 'easy' });
    sim.spawn({ kind: 'ally', t: 0 });
    const b = sim.ships[2]; b.ai = null; b.cmd = { want: 0, fire: false, gat: false };
    b.x = sim.player.x + 200; b.z = sim.player.z; b.psi = 0; b.u = 12;
    sim.player.u = 12;
    let n = 0;
    for (let i = 0; i < 600; i++) { sim.step(DT, {}); n += sim.takeEvents().filter((e) => e.type === 'collision').length; }
    assert.equal(n, 0);
  });
});

describe('an enemy that fires gives herself away', () => {
  it('she is a radar contact for a while after her 76 mm fires, wherever she is', () => {
    const sim = new DuelSim({ seed: 3, level: 'normal', waves: true, scouting: true, firingReveals: true });
    sim.startRadar();
    const e = sim.enemy;
    e.x = sim.player.x + 20000; e.z = sim.player.z; // far out of the radar's reach
    for (let i = 0; i < 10; i++) sim.advance(0.5, {});
    assert.equal(e.det, false);
    e.firedAt = sim.t;
    sim.advance(0.5, {});
    assert.equal(e.det, true);
    for (let i = 0; i < 50; i++) sim.advance(0.5, {});
    assert.equal(e.det, false, 'and lost again once she has been quiet a while');
  });
});


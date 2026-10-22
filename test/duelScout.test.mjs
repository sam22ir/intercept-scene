// Scouting in the ship duel (DuelSim({ scouting: true })): the radar finds the enemy, islands hide ships and stop shells, and the deck
// helicopter sees farther and over them. The plain duel is untouched.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DuelSim, HELI_RADAR } from '../src/duel.js';
import { PAD } from '../src/heliFlight.js';

const run = (sim, seconds, input = {}) => { for (let i = 0; i < seconds * 10; i++) sim.advance(0.1, input); };
const types = (sim) => sim.takeEvents().map((e) => e.type);

describe('the plain duel is untouched', () => {
  it('has no islands, no helicopter and no contacts to find', () => {
    const sim = new DuelSim({ seed: 3, level: 'easy' });
    assert.deepEqual(sim.islands, []);
    assert.equal(sim.heli, null);
    run(sim, 3);
    assert.equal(sim.enemy.det, undefined);
  });
});

describe('radar contacts', () => {
  it('the enemy comes in as a contact, with her range and bearing, and is lost again after a moment in a high sea', () => {
    const sim = new DuelSim({ seed: 3, level: 'easy', scouting: true });
    assert.equal(sim.enemy.det, true, 'she starts inside the radar');
    sim.takeEvents();
    sim.setSea(8.5, 0); // the clutter shrinks the radar to about 1.6 km
    run(sim, 2);
    assert.equal(sim.enemy.det, true, 'not lost at once');
    run(sim, 3);
    assert.equal(sim.enemy.det, false);
    assert.ok(types(sim).includes('lost'));
    sim.setSea(0, 0);
    run(sim, 1);
    const ev = sim.takeEvents().find((e) => e.type === 'contact');
    assert.ok(ev && ev.range > 2000 && Number.isFinite(ev.rel), 'the contact call has a range and a bearing');
  });
  it('an island between the ships hides her, and the helicopter sees over it', () => {
    const sim = new DuelSim({ seed: 3, level: 'easy', scouting: true });
    sim.enemy.x = 3200; sim.enemy.z = 0; sim.enemy.u = 0;
    sim.islands = [{ x: 1600, z: 0, r: 300, h: 80 }];
    run(sim, 5);
    assert.equal(sim.enemy.det, false, 'hidden behind the island');
    sim.heli.alt = 32; sim.heli.phase = 'hold';
    run(sim, 1);
    assert.ok(sim.heliUp);
    assert.equal(sim.enemy.det, true, 'the helicopter has her');
    assert.ok(HELI_RADAR > 5200);
  });
  it('the guns hold fire on a ship the radar does not have', () => {
    const blind = new DuelSim({ seed: 3, level: 'easy', scouting: true });
    blind.enemy.x = 3200; blind.enemy.z = 0; blind.enemy.ai = null; blind.enemy.u = 0; blind.enemy.order = 1; // she lies still behind the island
    blind.islands = [{ x: 1600, z: 0, r: 300, h: 80 }];
    run(blind, 5); // she is lost after 3 s unseen
    assert.equal(blind.enemy.det, false);
    const before = blind.player.stats.shells;
    run(blind, 40, { fire: 1 });
    assert.equal(blind.player.stats.shells, before, 'no round left the gun');
    const open = new DuelSim({ seed: 3, level: 'easy', scouting: true });
    run(open, 40, { fire: 1 });
    assert.ok(open.player.stats.shells > 0);
  });
});

describe('islands', () => {
  it('are the same for the same seed and keep clear of the starting positions', () => {
    const a = new DuelSim({ seed: 9, scouting: true }), b = new DuelSim({ seed: 9, scouting: true });
    assert.deepEqual(a.islands, b.islands);
    for (const isl of a.islands) for (const s of a.ships.slice(0, 2)) assert.ok(Math.hypot(s.x - isl.x, s.z - isl.z) > isl.r + 300);
  });
  it('stop a shell that flies into them', () => {
    const sim = new DuelSim({ seed: 3, level: 'easy', scouting: true });
    sim.islands = [{ x: 1000, z: 0, r: 300, h: 80 }];
    sim.shells.push({ id: 99, owner: 0, t0: 0, kind: 'he', lock: null, focus: null, sea: false, p: [500, 10, 0], v: [650, 0, 0] });
    run(sim, 2);
    assert.ok(!sim.shells.some((s) => s.id === 99));
    assert.ok(types(sim).includes('impact'));
  });
  it('hole a ship that runs on them and push her back out', () => {
    const sim = new DuelSim({ seed: 3, level: 'easy', scouting: true });
    sim.islands = [{ x: 300, z: 0, r: 150, h: 60 }];
    sim.player.x = 300 - 160; sim.player.z = 0; // inside the shore margin
    sim.takeEvents();
    const e0 = sim.player.comp.engine;
    run(sim, 1);
    assert.ok(types(sim).includes('ground'));
    assert.ok(sim.player.comp.engine < e0);
    assert.ok(Math.hypot(sim.player.x - 300, sim.player.z) >= 180 - 1);
  });
  it('are kept off by the computer helmsmen: a whole duel rarely grounds a ship', () => {
    let grounds = 0;
    for (let seed = 1; seed <= 6; seed++) {
      const sim = new DuelSim({ seed, level: 'normal', auto: 'normal', scouting: true });
      while (sim.t < 600 && sim.winner === null) { sim.advance(0.1, {}); grounds += sim.takeEvents().filter((e) => e.type === 'ground').length; }
    }
    assert.ok(grounds <= 6, `${grounds} groundings in six duels`);
  });
});

describe('the deck helicopter', () => {
  it('stays on deck with the enemy close or in a very rough sea, and flies off on a steady course otherwise', () => {
    const sim = new DuelSim({ seed: 3, level: 'easy', scouting: true });
    sim.enemy.x = sim.player.x + 1200; sim.enemy.z = sim.player.z;
    assert.match(sim.heliRequest(), /stays on deck: the enemy is close/);
    sim.enemy.x = sim.player.x + 3000;
    sim.setSea(8.5, 0);
    assert.match(sim.heliRequest(), /too rough/);
    sim.setSea(0, 0);
    assert.doesNotMatch(sim.heliRequest(), /stays on deck/);
    run(sim, 40);
    assert.ok(sim.heliUp || sim.heli.phase !== 'parked', `the helicopter is ${sim.heli.phase}`);
  });
});

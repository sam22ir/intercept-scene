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
    assert.equal(sim.hop, null);
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
    Object.assign(sim.hop, { phase: 'orbit', x: sim.player.x + 1500, z: sim.player.z, y: 90 }); // the helicopter is up, out ahead
    sim.hop.target = -1;
    run(sim, 0.2);
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

describe('the strike helicopter', () => {
  const up = (sim) => { for (let i = 0; i < 600 && sim.hop.phase !== 'orbit'; i++) sim.advance(0.1, {}); };
  it('stays on deck in a very rough sea, and otherwise goes out over the enemy when told', () => {
    const sim = new DuelSim({ seed: 3, level: 'easy', scouting: true });
    sim.setSea(8.5, 0);
    assert.match(sim.heliRequest(), /too rough/);
    sim.setSea(0, 0);
    assert.match(sim.heliRequest(), /starting up/);
    up(sim);
    assert.equal(sim.hop.phase, 'orbit');
    assert.ok(Math.hypot(sim.hop.x - sim.enemy.x, sim.hop.z - sim.enemy.z) < 500, 'circling the enemy');
    assert.ok(sim.heliUp);
  });
  it('launches by itself at the first shot, and its gun hurts the enemy', () => {
    const sim = new DuelSim({ seed: 3, level: 'easy', scouting: true, intro: true });
    sim.startRadar();
    assert.equal(sim.hop.phase, 'deck');
    run(sim, 20, { fire: 1 });
    assert.notEqual(sim.hop.phase, 'deck', 'it went out');
    const before = COMP_TOTAL(sim.enemy);
    run(sim, 40);
    assert.ok(COMP_TOTAL(sim.enemy) < before, 'the helicopter chipped at her');
  });
  it('reports by radio: a compartment out, a hull mark, another ship joining', () => {
    const sim = new DuelSim({ seed: 3, level: 'easy', scouting: true });
    sim.heliRequest();
    up(sim);
    sim.takeEvents();
    sim.enemy.comp.gun = 0;
    sim.enemy.comp.engine = 0;
    sim.enemy.hp = 40;
    sim.spawn({ t: sim.t, kind: 'enemy' });
    sim.ships[sim.ships.length - 1].det = true;
    run(sim, 20);
    const said = sim.takeEvents().filter((e) => e.type === 'radio').map((e) => e.text).join(' | ');
    assert.match(said, /76 mm gun out/);
    assert.match(said, /Engine room out/);
    assert.match(said, /hull at 50 per cent/);
    assert.match(said, /Another enemy ship has joined/);
  });
  it('its missile takes half of the part it is sent to, once at a time, two to a sortie', () => {
    const sim = new DuelSim({ seed: 3, level: 'easy', scouting: true });
    sim.heliRequest();
    up(sim);
    const t = sim.enemy;
    const g0 = t.comp.gun;
    const r = sim.heliMissile('gun');
    assert.ok(r.ok);
    assert.ok(!sim.heliMissile('gun').ok, 'reloading');
    run(sim, 6);
    assert.ok(t.comp.gun <= g0 - 15 + 1e-6 || t.comp.gun === 0, `gun ${g0} -> ${t.comp.gun}`);
    run(sim, 9);
    assert.ok(sim.heliMissile('engine').ok);
    run(sim, 9);
    assert.ok(!sim.heliMissile('bridge').ok, 'out of missiles');
  });
  it('when the player ship is lost it avenges her, then lands on a friendly frigate', () => {
    const sim = new DuelSim({ seed: 3, level: 'easy', scouting: true });
    sim.callFriend();
    const friend = sim.ships.find((s) => s.team === 0 && s.idx > 0);
    friend.ai = null; friend.u = 0; friend.order = 1; // she lies still: a deck to land on
    const killer = sim.enemy;
    killer.passive = true; // so the friend and the wreck are left alone in this test
    sim.player.lastHitBy = killer.idx;
    sim.player.hp = 0;
    sim.player.comp.gun = 0;
    let landed = false;
    for (let i = 0; i < 4200 && !landed; i++) { sim.advance(0.1, {}); landed = sim.hop.phase === 'landed'; }
    assert.ok(killer.tSunk !== null, 'the ship that sank her is down');
    assert.ok(landed, `the helicopter ended ${sim.hop.phase}`);
    assert.equal(sim.hop.landOn, friend.idx);
  });
  it('ditches when there is no friendly deck left', () => {
    const sim = new DuelSim({ seed: 3, level: 'easy', scouting: true });
    sim.player.lastHitBy = sim.enemy.idx;
    sim.enemy.passive = true;
    sim.player.hp = 0;
    for (let i = 0; i < 4200 && sim.hop.phase !== 'gone'; i++) sim.advance(0.1, {});
    assert.equal(sim.hop.phase, 'gone');
    assert.ok(sim.enemy.tSunk !== null);
  });
});

const COMP_TOTAL = (s) => Object.values(s.comp).reduce((a, b) => a + b, 0) + s.hp;

describe('the opening (intro)', () => {
  it('knows no enemy until the radar comes on, and says so with a contact call', () => {
    const sim = new DuelSim({ seed: 3, level: 'easy', scouting: true, intro: true });
    assert.equal(sim.enemy.det, false);
    run(sim, 5);
    assert.equal(sim.enemy.det, false, 'the radar is off: no contact on its own');
    sim.takeEvents();
    sim.startRadar();
    assert.equal(sim.enemy.det, true);
    assert.ok(types(sim).includes('contact'));
  });
  it('lets nobody but the player fire first: the enemy holds even at point blank, until the first shot', () => {
    const sim = new DuelSim({ seed: 3, level: 'hard', scouting: true, intro: true });
    sim.startRadar();
    sim.enemy.x = sim.player.x + 900; sim.enemy.z = sim.player.z + 100;
    run(sim, 40);
    assert.equal(sim.enemy.stats.shells, 0, 'her 76 mm held');
    assert.equal(sim.enemy.stats.bursts, 0, 'her 30 mm held');
    assert.equal(sim.shotFired, false);
    sim.takeEvents();
    run(sim, 30, { fire: 1 });
    assert.equal(sim.shotFired, true);
    assert.ok(sim.player.stats.shells > 0);
    run(sim, 30, { fire: 1 });
    assert.ok(sim.enemy.stats.shells > 0 || sim.enemy.tSunk !== null, 'once the first shot is gone she fights back');
  });
  it('announces the first shot once', () => {
    const sim = new DuelSim({ seed: 3, level: 'easy', scouting: true, intro: true });
    sim.startRadar();
    run(sim, 30, { fire: 1 });
    assert.equal(sim.takeEvents().filter((e) => e.type === 'firstshot').length, 1);
  });
  it('the plain duel has no hold at all', () => {
    const sim = new DuelSim({ seed: 3, level: 'hard' });
    sim.enemy.x = sim.player.x + 1500; sim.enemy.z = sim.player.z;
    run(sim, 30);
    assert.ok(sim.enemy.stats.shells > 0);
  });
});

describe('calling friends', () => {
  it('each call brings one friendly frigate in at full speed, up to three, with a short wait between', () => {
    const sim = new DuelSim({ seed: 3, level: 'easy', scouting: true });
    assert.equal(sim.ships.filter((s) => s.team === 0 && s.idx > 0).length, 0, 'no friend of her own accord');
    sim.takeEvents();
    assert.ok(sim.callFriend().ok);
    const f = sim.ships.find((s) => s.team === 0 && s.idx > 0);
    assert.ok(f && f.ai, 'a friendly frigate with a helmsman');
    assert.ok(sim.distance(sim.player, f) > 2500 && sim.distance(sim.player, f) < 3500);
    assert.ok(f.u > 20 * 0.514 * 0.9, 'at full speed');
    assert.ok(types(sim).includes('arrive'));
    const again = sim.callFriend();
    assert.ok(!again.ok && /can be called in/.test(again.why), 'a wait between calls');
    for (let k = 0; k < 2; k++) { run(sim, 7); assert.ok(sim.callFriend().ok); }
    run(sim, 7);
    const last = sim.callFriend();
    assert.ok(!last.ok && /No more/.test(last.why));
    assert.equal(sim.ships.filter((s) => s.team === 0 && s.idx > 0).length, 3);
  });
  it('the called friend closes on the enemy and fights', () => {
    const sim = new DuelSim({ seed: 5, level: 'normal', scouting: true });
    sim.callFriend();
    run(sim, 120);
    const f = sim.ships.find((s) => s.team === 0 && s.idx > 0);
    assert.ok(f.stats.shells > 0 || f.tSunk !== null, 'she fired');
  });
  it('the plain duel keeps its automatic friend and offers no call', () => {
    const sim = new DuelSim({ seed: 3, level: 'easy', waves: true });
    assert.equal(sim.callFriend().ok, false);
    assert.ok(sim.planWaves().some((w) => w.kind === 'ally'));
  });
});

describe('the player reloads the 76 mm in half the time (playerReload)', () => {
  it('halves the player\'s reload and leaves everyone else\'s, and the default, alone', () => {
    const quick = new DuelSim({ seed: 3, level: 'easy', playerReload: 0.5 });
    const plain = new DuelSim({ seed: 3, level: 'easy' });
    assert.equal(quick.reloadTime(quick.player), plain.reloadTime(plain.player) / 2);
    assert.equal(quick.reloadTime(quick.enemy), plain.reloadTime(plain.enemy));
    quick.player.gun.cool = 0; plain.player.gun.cool = 0;
    quick.fireMain(quick.player); plain.fireMain(plain.player);
    assert.ok(Math.abs(quick.player.gun.cool - plain.player.gun.cool / 2) < 1e-9);
  });
  it('the 76 mm holds fire when land stands on the line to a ship the helicopter shows, and fires once the line is clear', () => {
    const sim = new DuelSim({ seed: 3, level: 'easy', scouting: true });
    sim.enemy.x = 3200; sim.enemy.z = 0; sim.enemy.ai = null; sim.enemy.u = 0; sim.enemy.order = 1;
    sim.islands = [{ x: 1600, z: 0, r: 300, h: 80 }];
    run(sim, 5);
    Object.assign(sim.hop, { phase: 'orbit', x: sim.player.x + 1500, z: sim.player.z, y: 90 }); sim.hop.target = -1;
    run(sim, 0.2);
    assert.equal(sim.enemy.det, true);
    const before = sim.player.stats.shells;
    run(sim, 30, { fire: 1 });
    assert.equal(sim.player.stats.shells, before, 'no round left the gun');
    assert.equal(sim.player.gun.landBlocked, true);
    sim.islands = [{ x: 1600, z: 900, r: 300, h: 80 }]; // the island is off the line
    run(sim, 30, { fire: 1 });
    assert.ok(sim.player.stats.shells > before);
  });
  it('the helicopter flies into the view of the camera before it fires the missile', () => {
    const sim = new DuelSim({ seed: 3, level: 'easy', scouting: true });
    sim.enemy.x = 3200; sim.enemy.z = 0; sim.enemy.ai = null; sim.enemy.u = 0; sim.enemy.order = 1;
    run(sim, 3);
    sim.hop.phase = 'orbit'; sim.hop.x = 3200; sim.hop.z = 300; sim.hop.y = 95; sim.hop.ammo = 2; sim.hop.mCool = 0;
    sim.camHint = { p: [sim.player.x - 110, 34, sim.player.z], f: [1, 0, 0], half: 0.4 }; // behind your ship, looking at the enemy
    assert.equal(sim.heliInView(), false, 'it is over the enemy, far out of view');
    const r = sim.heliMissile();
    assert.ok(r.ok && r.queued);
    assert.equal(sim.hmiss.length, 0, 'no missile yet');
    let fired = false;
    for (let i = 0; i < 400 && !fired; i++) { sim.advance(0.1, {}); if (sim.hmiss.length) { fired = true; assert.ok(sim.heliInView(), 'it was in view when it fired'); } }
    assert.ok(fired, 'the missile left once it was in view');
    assert.equal(sim.hop.ammo, 1);
  });
});

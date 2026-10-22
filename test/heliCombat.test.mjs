// The deck helicopter in a fight: it stands down when a drone is close, spots for the ship while it is up, and fires two light missiles.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { HelmSim, STAND_DOWN_RANGE, HELI_ROUNDS, HELI_DAMAGE, DRONE_HP } from '../src/helm.js';

const run = (sim, s, input = {}) => { for (let i = 0; i < s * 10; i++) sim.advance(0.1, input); };
const quiet = () => { const s = new HelmSim({ seed: 11 }); s.nextSpawn = Infinity; return s; };
// A drone placed by hand: `r` m from the ship on the bearing `b` (rad from the bow), already detected, flying inbound.
const place = (sim, r, b = 0, extra = {}) => {
  const d = sim.spawn({ alt: 150 });
  const a = sim.psi + b;
  d.pos.set(sim.x + Math.cos(a) * r, 150, sim.z + Math.sin(a) * r);
  d.vel.set(0, 0, 0);
  d.detected = true;
  Object.assign(d, extra);
  return d;
};
const flyUp = (sim) => { sim.heli.wait = 0; for (let i = 0; i < 600 && !(sim.heliUp && sim.heli.phase === 'circuit'); i++) sim.advance(0.1, {}); assert.ok(sim.heliUp, 'airborne'); };

describe('the helicopter stands down', () => {
  it('stays on deck with a drone inside the range, and the E key says why', () => {
    const sim = quiet();
    place(sim, STAND_DOWN_RANGE - 300);
    sim.heli.wait = 0;
    run(sim, 40);
    assert.equal(sim.heli.phase, 'parked');
    const msg = sim.heliRequest();
    assert.match(msg, /stays on deck: drone D\d+/);
    assert.equal(sim.heli.phase, 'parked');
  });

  it('breaks off and lands when one closes in', () => {
    const sim = quiet();
    flyUp(sim);
    const d = place(sim, STAND_DOWN_RANGE + 1500);
    run(sim, 5);
    assert.ok(sim.heliUp || sim.heli.state.flying, 'still flying while it is far');
    d.pos.set(sim.x + 1200, 150, sim.z);
    d.vel.set(0, 0, 0);
    run(sim, 120);
    assert.ok(!sim.heli.state.flying, 'it has landed');
    assert.ok(['spindown', 'parked'].includes(sim.heli.phase));
  });

  it('does not lift off between a drone\'s pass and its attack', () => {
    const sim = quiet();
    place(sim, 4000, 0, { phase: 'extend' }); // out beyond the range, but it has passed and comes back
    sim.heli.wait = 0;
    run(sim, 40);
    assert.equal(sim.heli.phase, 'parked');
  });

  it('can fly again a while after the last drone is gone', () => {
    const sim = quiet();
    const d = place(sim, 1000);
    run(sim, 2);
    d.alive = false;
    sim.heli.wait = 0;
    run(sim, 30);
    assert.ok(sim.heli.phase !== 'parked', 'it starts up again');
  });
});

describe('the helicopter spots', () => {
  it('sees a drone just behind a ridge from its height, and not from the deck', () => {
    const mk = () => { const s = quiet(); s.skyline = () => THREE.MathUtils.degToRad(1.2); return s; }; // a ridge line 1.2 degrees up all round
    const a = mk();
    const da = place(a, 4200, 0);
    da.pos.y = 90; da.detected = false;
    run(a, 1);
    assert.ok(da.hidden, 'masked from the deck');
    const b = mk();
    flyUp(b);
    const db = place(b, 4200, 0);
    db.pos.y = 90; db.detected = false;
    run(b, 1);
    assert.ok(!db.hidden && db.detected, 'seen from the helicopter');
  });

  it('never hides a drone the deck can see', () => {
    for (const ridge of [0.3, 1.2, 3]) {
      const b = quiet();
      b.skyline = () => THREE.MathUtils.degToRad(ridge);
      flyUp(b);
      for (const y of [30, 90, 200, 400]) {
        const d = place(b, 4200, 0);
        d.pos.y = y;
        b.advance(0.1, {});
        const deckSees = Math.atan2(y - 15, 4200) >= THREE.MathUtils.degToRad(ridge);
        if (deckSees) assert.ok(!d.hidden, `ridge ${ridge}, height ${y}`);
        d.alive = false;
      }
    }
  });
});

describe('the helicopter\'s missile', () => {
  it('fires ahead at a far drone, takes only some hit points, and leaves the ship\'s launcher free', () => {
    const sim = quiet();
    flyUp(sim);
    // wait until it is in the circuit, then put a drone ahead of its nose
    for (let i = 0; i < 600 && sim.heli.phase !== 'circuit'; i++) sim.advance(0.1, {});
    assert.equal(sim.heli.phase, 'circuit');
    const events = [];
    const hp = sim.heliWorld(new THREE.Vector3());
    const st = sim.heli.state;
    const a = sim.psi - st.yaw;
    const d = place(sim, 100);
    d.pos.set(hp.x + Math.cos(a) * 3300, 150, hp.z + Math.sin(a) * 3300);
    for (let i = 0; i < 40; i++) { sim.advance(0.1, {}); events.push(...sim.takeEvents()); }
    const fired = events.filter((e) => e.type === 'heli-fire');
    assert.equal(fired.length, 1, 'one round');
    assert.ok(!events.some((e) => e.type === 'fire'), 'no ship launch event');
    assert.equal(sim.heliAmmo, HELI_ROUNDS - 1);
    assert.equal(sim.shipMissiles.length, 0, 'the ship has none in the air');
    let hit = null;
    for (let i = 0; i < 400 && !hit; i++) {
      d.pos.set(d.pos.x, 150, d.pos.z); // the drone is held where it is: a still target
      sim.advance(0.1, {});
      hit = sim.takeEvents().find((e) => e.type === 'heli-hit') ?? null;
    }
    assert.ok(hit, 'it hit');
    assert.ok(d.alive, 'and the drone is still flying');
    assert.equal(d.hp, DRONE_HP - HELI_DAMAGE, 'a light hit');
  });

  it('is reloaded on the deck', () => {
    const sim = quiet();
    sim.heliAmmo = 0;
    run(sim, 1);
    assert.equal(sim.heliAmmo, HELI_ROUNDS);
  });
});

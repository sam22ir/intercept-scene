import test from 'node:test';
import assert from 'node:assert/strict';
import { FleetSim, formationDests, ARRIVE_RADIUS, GUN_RANGE, HULL_HP, LEVELS } from '../src/fleet.js';

const run = (sim, secs) => { for (let i = 0; i < secs * 60; i++) sim.step(1 / 60); };
const snap = (sim) => JSON.stringify(sim.ships.map((s) => [s.x.toFixed(3), s.z.toFixed(3), s.hp]));

test('the same seed and the same orders give the same fight', () => {
  const a = new FleetSim({ seed: 5 }), b = new FleetSim({ seed: 5 }), c = new FleetSim({ seed: 6 });
  for (const s of [a, b, c]) { s.order([0, 1, 2], { type: 'move', x: 0, z: 0 }); run(s, 300); }
  assert.equal(snap(a), snap(b));
  assert.notEqual(snap(a), snap(c));
});

test('a move order arrives, stops and is dropped', () => {
  const sim = new FleetSim({ seed: 1 });
  sim.ships = sim.ships.filter((s) => s.team === 0); // no enemy: nothing shoots
  sim.judge = () => {};
  const s = sim.ships[0];
  const gx = s.x + 800, gz = s.z + 900;
  sim.order([0], { type: 'move', x: gx, z: gz });
  run(sim, 400);
  assert.ok(Math.hypot(s.x - gx, s.z - gz) < ARRIVE_RADIUS, 'arrived');
  assert.equal(s.orders.length, 0);
  assert.ok(s.u < 1, `stopped (${s.u.toFixed(2)} m/s)`);
});

test('ships reach points behind them and abeam without circling forever', () => {
  for (const [dx, dz] of [[-400, 0], [0, 150], [0, -180], [130, 130], [-250, 300]]) {
    const sim = new FleetSim({ seed: 2 });
    sim.ships = sim.ships.filter((s) => s.team === 0);
    sim.judge = () => {};
    const s = sim.ships[0];
    sim.order([0], { type: 'move', x: s.x + dx, z: s.z + dz });
    run(sim, 200);
    assert.equal(s.orders.length, 0, `reached (${dx}, ${dz})`);
  }
});

test('a squadron given one move order ends in a line abreast, in the order they lie', () => {
  const sim = new FleetSim({ seed: 3 });
  const mine = sim.team(0);
  const d = formationDests(mine, 0, 0);
  assert.equal(d.length, 3);
  // They advance along +z, so "abreast" is spread along x, at least 200 m apart.
  const xs = d.map((e) => e.x).sort((a, b) => a - b);
  assert.ok(xs[1] - xs[0] > 200 && xs[2] - xs[1] > 200);
  // Nobody is sent across another: the ships keep their order across the line of advance.
  const byX = [...mine].sort((a, b) => a.x - b.x);
  const destX = byX.map((s) => d.find((e) => e.ship === s).x);
  assert.ok(destX.every((v, i) => i === 0 || Math.abs(v - destX[i - 1]) > 200));
  assert.ok(destX[0] < destX[1] === (byX[0].x < byX[1].x) || destX[0] > destX[1] === (byX[0].x > byX[1].x));
});

test('an attack order sinks the target', () => {
  const sim = new FleetSim({ seed: 4, level: 'easy' });
  const foes = sim.team(1);
  sim.order([0, 1, 2], { type: 'attack', target: foes[0].id });
  run(sim, 400);
  assert.ok(sim.ships[foes[0].id].hp <= 0, 'the target sank');
  assert.ok(sim.ships[foes[0].id].tSunk > 0);
});

test('no friendly fire, and a sunk ship stays out of the fight', () => {
  const sim = new FleetSim({ seed: 8 });
  for (let i = 0; i < 60 * 300 && !sim.over; i++) {
    sim.step(1 / 60);
    for (const e of sim.takeEvents()) {
      if (e.type === 'fire') assert.notEqual(sim.ships[e.ship].team, sim.ships[e.target].team, 'no shot at a friend');
    }
  }
  for (const s of sim.ships) assert.ok(s.hp >= 0 && s.hp <= HULL_HP);
});

test('a match ends with a winner, at each level', () => {
  for (const level of Object.keys(LEVELS)) {
    const sim = new FleetSim({ seed: 9, level });
    sim.order([0, 1, 2], { type: 'move', x: 0, z: 0 });
    let guard = 0;
    while (!sim.over && guard++ < 60 * 1500) {
      if (guard % 300 === 0) { // the player keeps attacking the nearest enemy
        const foe = sim.team(1)[0];
        if (foe) sim.order(sim.team(0).map((s) => s.id), { type: 'attack', target: foe.id });
      }
      sim.step(1 / 60);
    }
    assert.ok(sim.over, `${level} ended`);
    assert.ok(sim.winner === 0 || sim.winner === 1);
    const alive = sim.team(sim.winner).length;
    assert.ok(alive > 0 && sim.team(1 - sim.winner).length === 0);
  }
});

test('guns reach only so far, and hulls are kept apart', () => {
  const sim = new FleetSim({ seed: 10 });
  run(sim, 5); // 4600 m apart at the start: nothing is in range
  assert.equal(sim.shells.length, 0);
  assert.ok(GUN_RANGE < 4600);
  const a = sim.ships[0], b = sim.ships[1];
  b.x = a.x + 20; b.z = a.z;
  sim.separate();
  assert.ok(Math.hypot(b.x - a.x, b.z - a.z) >= 99);
});

test('orders to ships that are not yours or are gone are refused', () => {
  const sim = new FleetSim({ seed: 11 });
  const foe = sim.team(1)[0];
  assert.equal(sim.order([foe.id], { type: 'move', x: 0, z: 0 }), false);
  assert.equal(sim.order([0], { type: 'attack', target: 1 }), false); // 1 is her own side
  foe.hp = 0;
  assert.equal(sim.order([0], { type: 'attack', target: foe.id }), false);
});

test('shift queues orders after the present one', () => {
  const sim = new FleetSim({ seed: 12 });
  sim.order([0], { type: 'move', x: -2000, z: 0 });
  sim.order([0], { type: 'move', x: -1500, z: 400 }, true);
  assert.equal(sim.ships[0].orders.length, 2);
  sim.order([0], { type: 'move', x: -1000, z: 0 });
  assert.equal(sim.ships[0].orders.length, 1);
});

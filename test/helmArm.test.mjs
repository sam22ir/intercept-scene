import test from 'node:test';
import assert from 'node:assert/strict';
import { HelmSim } from '../src/helm.js';

function simWithTarget() {
  const sim = new HelmSim({ seed: 7 });
  for (let i = 0; i < 4000 && !(sim.target && !sim.engageable(sim.target)); i++) sim.advance(0.05, {});
  return sim;
}

test('M readies a missile and holds it; F launches it', () => {
  const sim = simWithTarget();
  assert.ok(sim.target && !sim.engageable(sim.target), 'a target in reach');
  const n = sim.missiles.length;
  sim.arm();
  for (let i = 0; i < 100; i++) sim.advance(0.05, {}); // 5 s: well past slew, acquire and lock
  assert.equal(sim.missiles.length, n, 'nothing leaves while ready');
  assert.ok(sim.shot?.hold && sim.shot.locked, 'ready and locked');
  sim.launchReady();
  for (let i = 0; i < 4; i++) sim.advance(0.05, {});
  assert.equal(sim.missiles.length, n + 1, 'F launches it');
});

test('M again stands the ready missile down', () => {
  const sim = simWithTarget();
  const left = sim.cellsLeft;
  sim.arm();
  sim.advance(0.5, {});
  sim.arm();
  assert.equal(sim.shot, null);
  assert.equal(sim.cellsLeft, left);
});

test('a far drone below the ridge line is lost to the radar until it climbs above it, a near one never is', async () => {
  const { ridgeAngle } = await import('../src/environment.js');
  const sim = new HelmSim({ seed: 7 });
  sim.skyline = ridgeAngle;
  // a direction where the ridge is up (the middle of the arc, a = 1.55 rad, east)
  const dir = [Math.cos(1.55), Math.sin(1.55)];
  const place = (range, y) => {
    sim.drones = [];
    sim.spawn();
    const d = sim.drones[0];
    d.pos.set(sim.x + dir[0] * range, y, sim.z + dir[1] * range);
    d.vel.set(0, 0, 0);
    sim.stepDrone(d, 0.01);
    return d;
  };
  assert.equal(place(5000, 2).hidden, true, 'low and far: behind the ridge');
  assert.equal(place(5000, 900).hidden, false, 'high: above it');
  assert.equal(place(1500, 2).hidden, false, 'near: in front of the ridges');
});

test('summon sends in one more drone each time, up to a limit', () => {
  const sim = new HelmSim({ seed: 7 });
  const n = sim.drones.length;
  sim.summon();
  sim.summon();
  assert.equal(sim.drones.length, n + 2);
  for (let i = 0; i < 20; i++) sim.summon();
  assert.ok(sim.live.length <= 8);
});

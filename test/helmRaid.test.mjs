// The saturation raid (HelmSim({ raid: true })): a salvo of decoys with real missiles hidden among them.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { HelmSim, ID_RANGE, DASH_RANGE, DASH_SPEED, CELLS, raidSize } from '../src/helm.js';

const run = (sim, seconds, input = {}) => { for (let i = 0; i < seconds * 10; i++) sim.advance(0.1, input); };

describe('the raid', () => {
  it('is off by default: one drone at a time, no raid', () => {
    const sim = new HelmSim();
    run(sim, 30);
    assert.equal(sim.raid, null);
    assert.equal(sim.raidNo, 0);
    assert.equal(sim.drones.length, 1);
  });

  it('brings a whole salvo from one sector, real missiles among the decoys', () => {
    const sim = new HelmSim({ raid: true, seed: 3 });
    run(sim, 16);
    const size = raidSize(1);
    assert.equal(sim.drones.length, size.decoys + size.real);
    assert.equal(sim.drones.filter((d) => d.kind === 'real').length, size.real);
    const bearings = sim.drones.map((d) => sim.trueBearing(d.pos));
    const spread = Math.max(...bearings.map((b) => Math.abs(((b - bearings[0] + 540) % 360) - 180)));
    assert.ok(spread < 40, `one sector: ${spread}`);
    assert.ok(sim.drones.every((d) => d.class === null), 'nothing is classified yet');
  });

  it('classifies a contact only inside ID_RANGE, and dashes a real missile from DASH_RANGE', () => {
    const sim = new HelmSim({ raid: true, seed: 3 });
    sim.nextSpawn = 0;
    let sawClass = false;
    let dashed = null;
    for (let i = 0; i < 1500 && !dashed; i++) {
      sim.advance(0.1, {});
      for (const d of sim.drones) {
        const r = sim.rangeTo(d.pos);
        if (d.class) { sawClass = true; assert.ok(r < ID_RANGE + 60, `classified at ${r}`); assert.equal(d.class, d.kind); }
        if (d.kind === 'real' && d.dash && !dashed) dashed = { d, r };
      }
    }
    assert.ok(sawClass, 'contacts are classified on the way in');
    assert.ok(dashed, 'a real missile dashes');
    assert.ok(dashed.r < DASH_RANGE + 60 && dashed.r > DASH_RANGE - 200, `dash at ${dashed.r}`);
    run(sim, 1);
    assert.ok(Math.abs(dashed.d.vel.length() - DASH_SPEED) < 5, 'at dash speed');
  });

  it('a real missile does 1.5 damage and a decoy 0.5, and two missiles put her out of action', () => {
    const sim = new HelmSim({ raid: true, seed: 3 });
    sim.nextSpawn = 0;
    run(sim, 1);
    const real = sim.drones.filter((d) => d.kind === 'real');
    const decoy = sim.drones.find((d) => d.kind === 'decoy');
    sim.strike(decoy);
    assert.equal(sim.strikes, 0.5);
    sim.strike(real[0]);
    assert.equal(sim.strikes, 2);
    assert.equal(sim.out, false);
    sim.strike(real[1]);
    assert.equal(sim.out, true);
  });

  it('ends a raid when every contact is resolved, tallies it, reloads the launcher and calls the next', () => {
    const sim = new HelmSim({ raid: true, seed: 3 });
    sim.nextSpawn = 0;
    run(sim, 1);
    sim.cellsUsed = 5;
    const roundsBefore = sim.gunRounds;
    for (const d of [...sim.drones]) if (d.alive) sim.down(d, 'missile', d.pos.clone());
    run(sim, 1);
    assert.equal(sim.raid, null);
    assert.equal(sim.raidLog.length, 1);
    const res = sim.raidLog[0];
    assert.equal(res.realKilled, raidSize(1).real);
    assert.equal(res.decoysKilled, raidSize(1).decoys);
    assert.equal(res.realStruck, 0);
    assert.equal(sim.cellsUsed, 0, `reloaded to ${CELLS}`);
    assert.ok(sim.gunRounds >= roundsBefore);
    run(sim, 32);
    assert.equal(sim.raidNo, 2, 'the next raid is called');
    assert.ok(raidSize(2).decoys > raidSize(1).decoys, 'and it is bigger');
  });

  it('counts a missile cell spent on a decoy', () => {
    const sim = new HelmSim({ raid: true, seed: 3 });
    sim.nextSpawn = 0;
    run(sim, 1);
    const decoy = sim.drones.find((d) => d.kind === 'decoy');
    sim.missileHit({}, decoy, decoy.pos.clone());
    assert.equal(sim.raid.cellsOnDecoys, 1);
  });

  it('targets a classified missile before a nearer decoy', () => {
    const sim = new HelmSim({ raid: true, seed: 3 });
    sim.nextSpawn = 0;
    run(sim, 1);
    const [real] = sim.drones.filter((d) => d.kind === 'real');
    const decoy = sim.drones.find((d) => d.kind === 'decoy');
    for (const d of sim.drones) d.detected = true;
    real.class = 'real';
    real.pos.set(sim.x + 4000, 100, sim.z); // farther than the decoy
    decoy.pos.set(sim.x + 2000, 100, sim.z);
    assert.equal(sim.nearest(), real);
  });

  it('is deterministic for a seed', () => {
    const a = new HelmSim({ raid: true, seed: 11 });
    const b = new HelmSim({ raid: true, seed: 11 });
    run(a, 40); run(b, 40);
    assert.deepEqual(a.drones.map((d) => [d.kind, d.pos.x, d.pos.z]), b.drones.map((d) => [d.kind, d.pos.x, d.pos.z]));
  });
});

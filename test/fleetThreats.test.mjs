// Stub contract of src/fleetThreats.js: planThreats(sim, rng) -> sorted pending list; spawnThreat(sim, w) adds a ship.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { planThreats, spawnThreat } from '../src/fleetThreats.js';
import { FleetSim } from '../src/fleet.js';

describe('fleetThreats (stub)', () => {
  it('planThreats returns a time-sorted list of { t, kind }', () => {
    const sim = new FleetSim({ seed: 1, scenario: 'escort' });
    const list = planThreats(sim, () => 0.5);
    assert.ok(list.length > 0);
    for (let i = 0; i < list.length; i++) {
      assert.equal(typeof list[i].t, 'number');
      assert.equal(typeof list[i].kind, 'string');
      if (i) assert.ok(list[i].t >= list[i - 1].t);
    }
  });
  it('spawnThreat adds a ship of the right team', () => {
    const sim = new FleetSim({ seed: 1 });
    const n = sim.ships.length;
    spawnThreat(sim, { t: 0, kind: 'enemy', brg: 0 });
    assert.equal(sim.ships.length, n + 1);
    assert.equal(sim.ships[n].team, 1);
  });
});

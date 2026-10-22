// Stub contract of src/fleetResources.js: stepResources(sim, dt) runs without error and leaves the stocks as built.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { stepResources } from '../src/fleetResources.js';
import { FleetSim } from '../src/fleet.js';

describe('fleetResources (stub)', () => {
  it('stepResources is callable and keeps fuel at 1 (the stub burns none)', () => {
    const sim = new FleetSim({ seed: 1 });
    stepResources(sim, 1 / 120);
    for (const s of sim.squad) assert.equal(s.fuel, 1);
  });
});

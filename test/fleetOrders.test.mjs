// Stub contract of src/fleetOrders.js: applyOrder(sim, order) and steerGoal(sim, ship) -> { course, kn }.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { applyOrder, steerGoal } from '../src/fleetOrders.js';
import { FleetSim } from '../src/fleet.js';

describe('fleetOrders (stub)', () => {
  it('applyOrder changes only the ships the order names', () => {
    const sim = new FleetSim({ seed: 1 });
    applyOrder(sim, { to: [1], type: 'course', course: 450 });
    assert.equal(sim.squad[1].goal.course, 90);
    assert.equal(sim.squad[0].goal.course, 0);
  });
  it('steerGoal returns numeric { course, kn }', () => {
    const sim = new FleetSim({ seed: 1 });
    const g = steerGoal(sim, sim.squad[0]);
    assert.equal(typeof g.course, 'number');
    assert.equal(typeof g.kn, 'number');
  });
});

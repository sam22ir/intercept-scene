// Stub contract of src/fleetInfo.js: contactsFor(sim, t) and alertsOf(sim) return arrays and never change the sim.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { contactsFor, alertsOf } from '../src/fleetInfo.js';
import { FleetSim } from '../src/fleet.js';

describe('fleetInfo (stub)', () => {
  it('contactsFor lists non-squadron living ships with a 0..1 confidence', () => {
    const sim = new FleetSim({ seed: 1 });
    sim.newShip(3000, 0, 0, 1);
    const before = sim.digest();
    const c = contactsFor(sim, sim.t);
    assert.ok(Array.isArray(c) && c.length === 1);
    assert.ok(c[0].conf >= 0 && c[0].conf <= 1);
    assert.equal(sim.digest(), before);
  });
  it('alertsOf returns an array', () => {
    assert.ok(Array.isArray(alertsOf(new FleetSim({ seed: 1 }))));
  });
});

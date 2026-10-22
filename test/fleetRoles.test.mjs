// Stub contract of src/fleetRoles.js: ROLES has picket, gun and escort; applyRole sets ship.role and stat tweaks.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ROLES, applyRole } from '../src/fleetRoles.js';
import { FleetSim } from '../src/fleet.js';

describe('fleetRoles (stub)', () => {
  it('ROLES names the three roles', () => {
    assert.deepEqual(Object.keys(ROLES).sort(), ['escort', 'gun', 'picket']);
  });
  it('applyRole sets the role and falls back to escort for an unknown one', () => {
    const sim = new FleetSim({ seed: 1 });
    const s = sim.squad[0];
    applyRole(s, 'gun');
    assert.equal(s.role, 'gun');
    applyRole(s, 'nonsense');
    assert.equal(s.role, 'escort');
  });
});

// Stub contract of src/fleetScoring.js: SCENARIOS, LEVELS, scoreOf -> { status, reason }, debriefOf.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SCENARIOS, LEVELS, scoreOf, debriefOf } from '../src/fleetScoring.js';
import { LEVELS as DUEL_LEVELS } from '../src/duel.js';
import { FleetSim } from '../src/fleet.js';

describe('fleetScoring (stub)', () => {
  it('has the escort and defend scenarios and reuses the duel levels', () => {
    assert.deepEqual(Object.keys(SCENARIOS).sort(), ['defend', 'escort']);
    assert.equal(LEVELS, DUEL_LEVELS);
  });
  it('scoreOf says running at the start', () => {
    const r = scoreOf(new FleetSim({ seed: 1 }));
    assert.equal(r.status, 'running');
    assert.equal(typeof r.reason, 'string');
  });
  it('debriefOf reports losses, shots and merchants saved', () => {
    const d = debriefOf(new FleetSim({ seed: 1 }));
    assert.deepEqual(d.losses, []);
    assert.equal(d.shots, 0);
    assert.equal(d.merchantsSaved, 0);
  });
});

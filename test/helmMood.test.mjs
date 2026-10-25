// Night and storm (HelmSim({ mood })): opt-in, the plain mission unchanged; a storm shortens the radar and buries low drones in clutter.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { HelmSim, RADAR_RANGE, ID_RANGE } from '../src/helm.js';

const still = (sim, d) => { d.vel.set(0, 0, 0); d.phase = 'inbound'; sim.advance(0.1, {}); };
const dropAt = (sim, range, alt) => {
  sim.nextSpawn = Infinity;
  const d = sim.spawn({ bearing: 1, range, alt });
  still(sim, d);
  return d;
};

describe('night and storm', () => {
  it('are off by default: the radar reaches RADAR_RANGE and nothing is buried', () => {
    const sim = new HelmSim();
    assert.equal(sim.mood, null);
    assert.equal(sim.radarRange, RADAR_RANGE);
    assert.equal(sim.idRange, ID_RANGE);
    assert.equal(sim.clutter, 0);
    assert.equal(new HelmSim({ mood: 'nonsense' }).mood, null);
  });

  it('leave the radar as it is at night', () => {
    const sim = new HelmSim({ mood: 'night' });
    assert.equal(sim.mood, 'night');
    assert.equal(sim.radarRange, RADAR_RANGE);
    assert.ok(dropAt(sim, RADAR_RANGE - 300, 20).detected);
  });

  it('shorten the radar in a storm', () => {
    const sim = new HelmSim({ mood: 'storm' });
    assert.ok(sim.radarRange < RADAR_RANGE && sim.idRange < ID_RANGE);
    assert.ok(!dropAt(sim, sim.radarRange + 200, 150).detected, 'beyond the storm radar');
    const near = new HelmSim({ mood: 'storm' });
    assert.ok(dropAt(near, near.radarRange - 300, 150).detected, 'a high drone inside it');
  });

  it('bury a low drone in the sea clutter until it is close', () => {
    const sim = new HelmSim({ mood: 'storm' });
    const far = dropAt(sim, sim.clutter + 400, 20);
    assert.ok(!far.detected, 'low and far: lost in the clutter');
    const close = dropAt(new HelmSim({ mood: 'storm' }), 2000, 20);
    assert.ok(close.detected, 'low and close: seen');
    assert.ok(dropAt(new HelmSim({ mood: 'storm' }), 3200, 150).detected, 'high and far: seen');
  });
});

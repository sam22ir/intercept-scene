import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { heliState, PAD } from '../src/models/helicopter.js';

describe('the deck helicopter', () => {
  it('is a pure function of time: the same time gives the same state', () => {
    const a = heliState(333.3);
    heliState(900);
    assert.deepEqual(heliState(333.3), a);
  });
  it('starts parked on the pad, flies and lands again, never jumping', () => {
    assert.deepEqual([heliState(0).x, heliState(0).y, heliState(0).z], [PAD.x, PAD.y, PAD.z]);
    let prev = heliState(0);
    let flights = 0;
    let wasFlying = false;
    let maxH = 0;
    for (let t = 0.1; t < 1200; t += 0.1) {
      const s = heliState(t);
      assert.ok(Math.hypot(s.x - prev.x, s.y - prev.y, s.z - prev.z) < 6, `no jump at ${t.toFixed(1)} s`);
      assert.ok(s.y >= PAD.y - 1e-9, 'never below the pad');
      if (s.flying && !wasFlying) flights += 1;
      wasFlying = s.flying;
      maxH = Math.max(maxH, s.y - PAD.y);
      prev = s;
    }
    assert.ok(flights >= 4, 'it flies now and then');
    assert.ok(maxH > 20, 'it climbs well clear of the deck');
    for (const t of [0, 5, 400.5, 1000]) {
      const s = heliState(t);
      if (!s.flying && s.rpm === 0) assert.deepEqual([s.x, s.y, s.z], [PAD.x, PAD.y, PAD.z], 'parked means on the pad');
    }
  });
});

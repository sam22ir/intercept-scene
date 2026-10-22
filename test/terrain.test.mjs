import test from 'node:test';
import assert from 'node:assert/strict';
import { islandLayout, farShipLayout, islandHeight, landHeightAtWorld, WORLD_PERIOD } from '../src/terrain.js';

test('islands are deterministic, far from the origin and clear of the ship lane', () => {
  const a = islandLayout(7);
  assert.deepEqual(a, islandLayout(7));
  for (const i of a) {
    assert.ok(Math.hypot(i.x, i.z) > 3000);
    assert.ok(Math.abs(i.z) > i.radius * 1.3 + 1000, `island at z ${i.z} radius ${i.radius}`);
  }
  for (const s of farShipLayout(3)) assert.ok(Math.abs(s.z) > 600);
});

test('the land stands above the sea in the middle of an island and not offshore', () => {
  const isl = islandLayout(7).sort((p, q) => q.radius - p.radius)[0];
  assert.ok(islandHeight(isl, 0, 0) > 10, 'the middle is land');
  assert.equal(islandHeight(isl, isl.radius * 2, 0), -6);
  assert.ok(landHeightAtWorld([isl], isl.x, isl.z) > 10);
  assert.ok(landHeightAtWorld([isl], isl.x + isl.radius * 3, isl.z) <= 0);
});

test('an island repeats every WORLD_PERIOD, so a drone far from the origin can still fly into one', () => {
  const isl = islandLayout(7).sort((p, q) => q.radius - p.radius)[0];
  const h0 = landHeightAtWorld([isl], isl.x, isl.z);
  assert.ok(Math.abs(landHeightAtWorld([isl], isl.x + 3 * WORLD_PERIOD, isl.z - 2 * WORLD_PERIOD) - h0) < 1e-9);
});

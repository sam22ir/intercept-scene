// The mini map's view (src/mapView.js): what it is centred on, how far it reaches, the ring and the wheel, and what is remembered.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  AUTO_STEPS, MAP_FAR, MAP_NEAR, MAP_VIEW_KEY, RING_SPAN, autoRadius, loadMapView, pointerAngle, radiusAtAngle, radiusLabel, ringAngle, ringStep, saveMapView, validateMapView, wheelRadius,
} from '../src/mapView.js';

describe('the mini map view', () => {
  it('starts on the ship and automatic, and refuses nonsense', () => {
    assert.deepEqual(validateMapView(null), { center: 'ship', radius: null });
    assert.deepEqual(validateMapView({ center: 'moon', radius: 'x' }), { center: 'ship', radius: null });
    assert.deepEqual(validateMapView({ center: 'drone', radius: 900 }), { center: 'drone', radius: 900 });
    assert.equal(validateMapView({ radius: 1e9 }).radius, MAP_FAR);
    assert.equal(validateMapView({ radius: 1 }).radius, MAP_NEAR);
  });

  it('hides the rings until they are asked for', () => {
    assert.ok(!validateMapView(null).rings);
    assert.ok(!validateMapView({ rings: 'yes' }).rings);
    assert.equal(validateMapView({ center: 'drone', rings: true }).rings, true);
  });

  it('remembers the view', () => {
    const store = new Map();
    globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
    try {
      saveMapView({ center: 'drone', radius: 2000 });
      assert.ok(store.has(MAP_VIEW_KEY));
      assert.deepEqual(loadMapView(), { center: 'drone', radius: 2000 });
    } finally {
      delete globalThis.localStorage;
    }
    assert.deepEqual(loadMapView(), { center: 'ship', radius: null }, 'no storage is fine');
  });

  it('the ring turns clockwise to come closer, and its angle and radius are one and the same', () => {
    assert.equal(ringAngle(MAP_FAR), -RING_SPAN);
    assert.equal(ringAngle(MAP_NEAR), RING_SPAN);
    for (const r of [200, 750, 3000, 15000]) assert.ok(Math.abs(radiusAtAngle(ringAngle(r)) - r) < 1e-6, String(r));
    assert.ok(radiusAtAngle(50) < radiusAtAngle(-50));
  });

  it('a pointer on the rim gives its angle, and the gap at the bottom goes to the nearer end', () => {
    assert.equal(Math.round(pointerAngle(0, -100)), 0);
    assert.equal(Math.round(pointerAngle(100, 0)), 90);
    assert.equal(Math.round(pointerAngle(-100, 0)), -90);
    assert.equal(pointerAngle(1, 100), RING_SPAN);
    assert.equal(pointerAngle(-1, 100), -RING_SPAN);
  });

  it('the wheel zooms by steps and stops at both ends', () => {
    assert.ok(wheelRadius(1000, 1) > 1000);
    assert.ok(wheelRadius(1000, -1) < 1000);
    assert.equal(wheelRadius(MAP_FAR, 1), MAP_FAR);
    assert.equal(wheelRadius(MAP_NEAR, -1), MAP_NEAR);
  });

  it('automatic zoom holds a drone 15 km out and more', () => {
    assert.equal(autoRadius(100), 300);
    assert.ok(autoRadius(15000) >= 15000 * 1.15);
    assert.ok(autoRadius(21000) >= 21000);
    assert.equal(AUTO_STEPS.at(-1), MAP_FAR);
  });

  it('rings and labels stay readable at any range', () => {
    for (const R of [150, 300, 750, 1000, 2000, 4500, 7000, 15000, 25000]) assert.ok(Math.floor(R / ringStep(R)) <= 7, `${R}: ${Math.floor(R / ringStep(R))} rings`);
    assert.equal(radiusLabel(750), '750 m');
    assert.equal(radiusLabel(1500), '1.5 km');
    assert.equal(radiusLabel(15000), '15 km');
  });
});

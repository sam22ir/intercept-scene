// The default flight path stays within the drone's attitude limits: at most 50 degrees of
// bank and 20 degrees of pitch (nose up or down), from the catapult release to the end of
// the path, for every ship and mission. The bank angle follows speed^2 / (g * turn radius),
// so a regression here usually means a turn got tighter or the cruise speed went up.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

const SCENARIO_URL = new URL('../src/scenario.js', import.meta.url);
const D = 180 / Math.PI;
const MAX_BANK = 50;
const MAX_PITCH = 20;

async function load(ship, mode) {
  globalThis.__SHIP_VARIANT = ship;
  globalThis.__SCENARIO = mode;
  delete globalThis.__ENGAGE;
  return import(`${SCENARIO_URL.href}?attitude=${ship}-${mode}`);
}

for (const ship of ['fwd', 'aft']) {
  for (const mode of ['intercept', 'chute']) {
    describe(`attitude limits ${ship}-${mode}`, () => {
      it('never banks past 50 degrees or pitches past 20 degrees', async () => {
        const S = await load(ship, mode);
        const end = Number.isFinite(S.scenario.tChute) ? S.scenario.tChute - 0.5 : S.scenario.engagements.at(-1).tLaunch;
        const pos = new THREE.Vector3();
        const q = new THREE.Quaternion();
        const nose = new THREE.Vector3();
        const wing = new THREE.Vector3();
        let bank = 0;
        let pitch = -Infinity;
        let low = Infinity;
        for (let t = S.scenario.tRelease; t <= end; t += 0.05) {
          S.planePose(t, pos, q);
          nose.set(0, 0, 1).applyQuaternion(q);
          wing.set(1, 0, 0).applyQuaternion(q);
          bank = Math.max(bank, Math.abs(Math.asin(wing.y) * D));
          pitch = Math.max(pitch, Math.asin(nose.y) * D);
          low = Math.min(low, Math.asin(nose.y) * D);
        }
        assert.ok(bank <= MAX_BANK + 1e-6, `bank ${bank.toFixed(1)} > ${MAX_BANK}`);
        assert.ok(pitch <= MAX_PITCH, `pitch ${pitch.toFixed(1)} > ${MAX_PITCH}`);
        assert.ok(low >= -MAX_PITCH, `dive ${low.toFixed(1)} < -${MAX_PITCH}`);
      });
    });
  }
}

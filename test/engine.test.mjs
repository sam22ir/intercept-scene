// The drone's engine model (src/models/engine.js): where it sits, and that it stays inside the space
// between the firewall and the propeller (nothing pokes through the fuselage or the prop). Geometry only,
// so it runs in Node.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Kit, mat } from '../src/models/kit.js';
import { addEngine, addFlange, ENGINE_Y, ENGINE_Z } from '../src/models/engine.js';

const M = {
  alu: mat(0xb9bec2), metal: mat(0x8d9399), dark: mat(0x1d1f22), black: mat(0x0f1012), white: mat(0xf0f0ec),
  copper: mat(0xb8733a), green: mat(0x6fb43a), blue: mat(0x4f86b8), orange: mat(0xf08a1c),
};

function boxOf(build) {
  const k = new Kit();
  build(k);
  const box = new THREE.Box3();
  for (const mesh of k.build().children) box.union(new THREE.Box3().setFromBufferAttribute(mesh.geometry.attributes.position));
  return { box, k, meshes: k.build().children };
}
const names = (k) => [...k.buckets.keys()].length;

describe('the engine', () => {
  const { box, k, meshes } = boxOf((kit) => addEngine(kit, M));
  const TOP_Y = 0.25; // the fuselage's roof line (plane.js)

  it('is a boxer twin about 0.6 m wide, centred on the crankshaft', () => {
    near(box.min.x, -0.31, 0.02);
    near(box.max.x, 0.31, 0.02);
    near((box.min.x + box.max.x) / 2, 0, 1e-3);
  });

  it('keeps everything below the roof line in front of the firewall (z = 1.885) and behind the propeller flange (z = 2.29)', () => {
    let rear = Infinity;
    for (const m of meshes) {
      const p = m.geometry.attributes.position;
      for (let i = 0; i < p.count; i++) if (p.getY(i) < TOP_Y) rear = Math.min(rear, p.getZ(i));
    }
    assert.ok(rear > 1.885, `rear of the low parts ${rear}`);
    assert.ok(box.max.z < 2.29, `front ${box.max.z}`);
  });

  it('lets the intake tower lean back over the roof, clear of it', () => {
    let lowest = Infinity;
    for (const m of meshes) {
      const p = m.geometry.attributes.position;
      for (let i = 0; i < p.count; i++) if (p.getZ(i) < 1.885) lowest = Math.min(lowest, p.getY(i));
    }
    assert.ok(lowest > TOP_Y + 0.05, `the part behind the firewall is only ${(lowest - TOP_Y).toFixed(2)} m above the roof`);
  });

  it('stands about 0.4 m above the shaft with the carburettor and bell, and hangs no lower than its headers', () => {
    assert.ok(box.max.y > ENGINE_Y + 0.35 && box.max.y < ENGINE_Y + 0.45, `top ${box.max.y}`);
    assert.ok(box.min.y > ENGINE_Y - 0.21, `bottom ${box.min.y}`);
  });

  it('uses every material it is given: aluminium, steel, black, green, copper and the dark intake throat', () => {
    assert.ok(names(k) >= 6);
    for (const m of [M.alu, M.metal, M.black, M.green, M.copper, M.dark]) assert.ok(k.buckets.has(m), 'a material is unused');
  });

  it('is built around the shaft at the plane\'s engine position', () => {
    near(ENGINE_Y, 0.07, 1e-9);
    near(ENGINE_Z, 2.06, 1e-9);
  });
});

describe('the propeller flange', () => {
  const { box } = boxOf((kit) => addFlange(kit, M));

  it('is a disc about 0.16 m across on the shaft, a few centimetres deep', () => {
    near(box.max.x, 0.078, 0.005);
    near(box.min.x, -0.078, 0.005);
    near(box.max.y, 0.078, 0.005);
    assert.ok(box.min.z > -0.03 && box.max.z < 0.085, `z ${box.min.z} .. ${box.max.z}`);
  });
});

function near(a, b, tol) { assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b}`); }

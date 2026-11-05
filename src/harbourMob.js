import * as THREE from 'three';
import { deckHeight } from './scenario.js';
import { BUOY_DRIFT } from './harbour.js';

// The man overboard drill's pieces in the water (the model is MobSim in harbour.js): the casualty, a still figure in an orange
// life jacket riding the swell (no animation: the mission has no animated people); the lifebuoy thrown from the bridge wing two
// seconds after the shout, with its smoke float giving off orange smoke that drifts downwind; a ring on the water round him that
// pulses so he can be found from a distance; and, once she is stopped with him abeam, the recovery line from her side to him, then
// him hoisted up her side and aboard. Everything is a function of the sim's time and state.

const std = (color, o = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.7, metalness: 0.05, ...o });
const ease = (x) => { const c = Math.min(Math.max(x, 0), 1); return c * c * (3 - 2 * c); };

function casualtyModel() {
  const g = new THREE.Group();
  const orange = std(0xff6a14, { roughness: 0.55 }), skin = std(0x8e5a3a), hair = std(0x1b1410, { roughness: 0.9 }), navy = std(0x1f2a44);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.12, 14, 10), skin); head.position.y = 0.32; g.add(head);
  const hairM = new THREE.Mesh(new THREE.SphereGeometry(0.127, 12, 6, 0, Math.PI * 2, 0, Math.PI * 0.5), hair); hairM.position.set(-0.015, 0.33, 0); g.add(hairM);
  const collar = new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.09, 8, 16), orange); collar.rotation.x = Math.PI / 2; collar.position.y = 0.15; g.add(collar);
  const chest = new THREE.Mesh(new THREE.CapsuleGeometry(0.18, 0.2, 3, 10).scale(0.8, 1, 1.15), orange); chest.position.y = -0.1; g.add(chest);
  for (const s of [-1, 1]) { // arms out on the water, still
    const arm = new THREE.Mesh(new THREE.CapsuleGeometry(0.05, 0.45, 2, 6), navy);
    arm.rotation.x = s * 1.2; arm.position.set(0.05, 0.02, s * 0.38); g.add(arm);
  }
  const reflector = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.05, 0.16), new THREE.MeshBasicMaterial({ color: 0xe8f0ff, toneMapped: false })); reflector.position.set(0.17, 0.12, 0); g.add(reflector);
  return g;
}
function lifebuoyModel() {
  const g = new THREE.Group();
  const orange = std(0xff5a10, { roughness: 0.5 }), white = std(0xf2f2ee, { roughness: 0.5 });
  for (let i = 0; i < 8; i++) {
    const seg = new THREE.Mesh(new THREE.TorusGeometry(0.36, 0.1, 8, 6, Math.PI / 4), i % 2 ? white : orange);
    seg.rotation.set(Math.PI / 2, 0, (i * Math.PI) / 4);
    g.add(seg);
  }
  const float = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.11, 0.42, 10), orange); float.position.set(0.75, 0.12, 0); g.add(float);
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.06, 10), std(0x222222)); cap.position.set(0.75, 0.36, 0); g.add(cap);
  const line = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 0.01, 0.4, 4), std(0xe8dcc0)); line.rotation.z = Math.PI / 2; line.position.set(0.55, 0.05, 0); g.add(line);
  return g;
}
const puffTex = (() => {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const x = c.getContext('2d');
  const gr = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, 'rgba(255,150,60,0.95)'); gr.addColorStop(0.5, 'rgba(255,120,40,0.5)'); gr.addColorStop(1, 'rgba(255,110,30,0)');
  x.fillStyle = gr; x.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
})();

export function createMobScene(scene) {
  const group = new THREE.Group();
  group.visible = false;
  scene.add(group);
  const casualty = casualtyModel(), buoy = lifebuoyModel();
  group.add(casualty, buoy);
  // the ring round him: a thin band on the water that grows and fades every two seconds
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.94, 1, 48).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xff7a1a, transparent: true, depthWrite: false, toneMapped: false }));
  group.add(ring);
  // the smoke float's smoke: puffs born in turn, rising and drifting downwind as they grow and fade
  const N = 36, LIFE = 9;
  const puffs = Array.from({ length: N }, () => {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: puffTex, transparent: true, depthWrite: false }));
    group.add(s);
    return s;
  });
  // the recovery line, from her side to him
  const SEG = 14;
  const rope = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.03, 0.03, 1, 5, 1, true), std(0xe8dcc0, { roughness: 0.9 }), SEG);
  rope.frustumCulled = false;
  group.add(rope);
  const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _p = new THREE.Vector3(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _m = new THREE.Matrix4(), UP = new THREE.Vector3(0, 1, 0);
  const HIDE = new THREE.Matrix4().makeScale(0, 0, 0);
  function drawRope(S, E, sag) {
    let prev = null;
    for (let i = 0; i <= SEG; i++) {
      const u = i / SEG;
      const p = new THREE.Vector3().lerpVectors(S, E, u);
      p.y = Math.max(p.y - sag * 4 * u * (1 - u), 0.05);
      if (prev) {
        _a.subVectors(p, prev);
        const len = _a.length();
        _q.setFromUnitVectors(UP, _a.normalize());
        _m.compose(_b.addVectors(prev, p).multiplyScalar(0.5), _q, _s.set(1, len, 1));
        rope.setMatrixAt(i - 1, _m);
      }
      prev = p;
    }
    rope.instanceMatrix.needsUpdate = true;
  }
  const hideRope = () => { for (let i = 0; i < SEG; i++) rope.setMatrixAt(i, HIDE); rope.instanceMatrix.needsUpdate = true; };
  let tDone = null;

  return {
    // `ship` is her model (its matrixWorld places points on her), `camPos` the camera (the ring keeps a size that can be seen)
    update(t, sim, ship, camPos) {
      const c0 = sim.casualty;
      group.visible = !!c0 && sim.kind === 'mob';
      if (!group.visible) { tDone = null; return; }
      const p = sim.casualtyPos(t);
      const bob = 0.12 * Math.sin(t * 1.3) + 0.05 * Math.sin(t * 2.9 + 1);
      // him: in the water, then (recovered) up her side and aboard
      if (sim.stage === 'done') tDone ??= t;
      else tDone = null;
      const side = sim.side;
      const deckPt = (ax) => _p.set(ax, deckHeight(ax) + 0.6, side * 6.9).applyMatrix4(ship.group.matrixWorld).clone();
      if (tDone !== null) {
        const k = (t - tDone) / 9; // nine seconds: hauled to her side, then up it
        const atSide = _p.set(-6, 0, side * (7.5 + 0.6)).applyMatrix4(ship.group.matrixWorld).clone();
        const top = deckPt(-6);
        if (k < 0.45) casualty.position.lerpVectors(new THREE.Vector3(p.x, bob, p.z), atSide, ease(k / 0.45));
        else casualty.position.lerpVectors(atSide, top, ease((k - 0.45) / 0.55));
        casualty.visible = k < 1.05;
        if (casualty.visible) drawRope(deckPt(-6), casualty.position.clone().setY(casualty.position.y + 0.3), 0.3); else hideRope();
      } else {
        casualty.position.set(p.x, bob - 0.05, p.z);
        casualty.visible = true;
        if (sim.stage === 'recover') drawRope(deckPt(-6), casualty.position.clone().setY(0.2), 1.2 * (1 - Math.min(sim.recoverHold / 3, 1)) + 0.3);
        else hideRope();
      }
      casualty.rotation.set(0.05 * Math.sin(t * 0.9), -Math.atan2(p.z - sim.z, p.x - sim.x) + Math.PI, 0.06 * Math.sin(t * 1.1)); // he faces her
      // the lifebuoy: in flight from the bridge wing, then on the water
      const bp = sim.buoyPos(t);
      if (bp) {
        buoy.position.set(bp.x, 0.05 + 0.1 * Math.sin(t * 1.4 + 2), bp.z);
        buoy.rotation.set(0.08 * Math.sin(t * 1.2), 0.4, 0.08 * Math.cos(t * 1.0));
        buoy.visible = true;
      } else if (t > c0.t0 && t < c0.t0 + 2) {
        const k = (t - c0.t0) / 2;
        const from = _p.set(12.6, 11.8, side * 7.6).applyMatrix4(ship.group.matrixWorld).clone();
        buoy.position.lerpVectors(from, new THREE.Vector3(c0.bx, 0, c0.bz), k);
        buoy.position.y += Math.sin(Math.PI * k) * 4;
        buoy.rotation.set(k * 9, 0, k * 4);
        buoy.visible = true;
      } else buoy.visible = false;
      // its smoke
      const smokeOn = bp && sim.stage !== 'done';
      for (let i = 0; i < N; i++) {
        const s = puffs[i];
        if (!smokeOn) { s.visible = false; continue; }
        const age = (t - c0.t0 - 2 + (i * LIFE) / N) % LIFE;
        const k = age / LIFE;
        s.visible = true;
        s.position.set(bp.x + 0.75 + BUOY_DRIFT.x * 14 * age, 0.4 + age * 0.9 + age * age * 0.05, bp.z + BUOY_DRIFT.z * 14 * age);
        s.scale.setScalar(0.8 + age * 1.3);
        s.material.opacity = 0.85 * (1 - k) * Math.min(1, age * 2);
      }
      // the ring: big enough to see from where the camera is
      const d = camPos ? Math.hypot(camPos.x - p.x, camPos.y, camPos.z - p.z) : 100;
      const ph = (t % 2) / 2;
      ring.position.set(p.x, 0.15, p.z);
      ring.scale.setScalar(Math.max(4, d * 0.02) * (0.6 + ph));
      ring.material.opacity = (1 - ph) * 0.9;
      ring.visible = tDone === null;
    },
  };
}

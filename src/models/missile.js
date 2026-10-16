import * as THREE from 'three';
import { Kit, hexa, mat, canvasTexture } from './kit.js';

// Short-range interceptor, ~3.4 m. Nose along local +Z.
const R = 0.11;
const Z_TAIL = -1.75;
const Z_NOSE = 1.65;

function bodyTexture() {
  // u = around the body, v = along (0 tail .. 1 nose).
  return canvasTexture(512, 1024, (ctx, W, H) => {
    const V = (z) => H * (1 - (z - Z_TAIL) / (Z_NOSE - Z_TAIL));
    ctx.fillStyle = '#e4e6e0';
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = 'rgba(60,60,60,0.7)';
    ctx.lineWidth = 3;
    for (const z of [-1.35, -0.4, 0.55, 1.05]) {
      ctx.beginPath();
      ctx.moveTo(0, V(z));
      ctx.lineTo(W, V(z));
      ctx.stroke();
    }
    ctx.fillStyle = '#e8b416';
    ctx.fillRect(0, V(0.95), W, V(0.75) - V(0.95));
    ctx.fillStyle = '#7b4a26';
    ctx.fillRect(0, V(-0.55), W, V(-0.68) - V(-0.55));
    ctx.fillStyle = '#2b2d30';
    ctx.font = 'bold 34px sans-serif';
    ctx.textAlign = 'center';
    for (const [u, rot] of [[0.25, Math.PI / 2], [0.75, -Math.PI / 2]]) {
      ctx.save();
      ctx.translate(u * W, V(0));
      ctx.rotate(rot);
      ctx.fillText('LOT 07-920', 0, 12);
      ctx.restore();
    }
  });
}

// Thin trapezoid fin, span along local +Y, leading edge at zLE.
function fin(rootChord, tipChord, span, sweep, t, zLE) {
  return hexa([
    [-t, R * 0.9, zLE - rootChord], [-t, R * 0.9, zLE], [t, R * 0.9, zLE], [t, R * 0.9, zLE - rootChord],
    [-t * 0.5, R + span, zLE - sweep - tipChord], [-t * 0.5, R + span, zLE - sweep],
    [t * 0.5, R + span, zLE - sweep], [t * 0.5, R + span, zLE - sweep - tipChord],
  ]);
}

export function createMissile() {
  const group = new THREE.Group();
  group.name = 'missile';
  const body = new THREE.MeshStandardMaterial({ map: bodyTexture(), metalness: 0.3, roughness: 0.42 });
  const grey = mat(0x8c9194, { metalness: 0.5, roughness: 0.45 });
  const dark = mat(0x26292c, { metalness: 0.6, roughness: 0.4 });
  const glass = mat(0x1a2a36, { metalness: 0.9, roughness: 0.05 });

  const k = new Kit();
  // Body and ogive nose as one lathe so the texture runs continuously.
  const prof = [];
  const S = 48;
  for (let i = 0; i <= S; i++) {
    const z = Z_TAIL + ((Z_NOSE - 0.04 - Z_TAIL) * i) / S;
    const n = THREE.MathUtils.clamp((z - 0.95) / (Z_NOSE - 0.95), 0, 1);
    prof.push(new THREE.Vector2(Math.max(0.012, R * Math.sqrt(1 - n * n)), z));
  }
  const lathe = new THREE.LatheGeometry(prof, 24);
  lathe.rotateX(Math.PI / 2);
  k.add(lathe, body);
  k.add(new THREE.SphereGeometry(0.03, 12, 8), glass, { pos: [0, 0, Z_NOSE - 0.04] });
  const boat = new THREE.CylinderGeometry(R, R * 0.8, 0.12, 24, 1, true);
  boat.rotateX(Math.PI / 2);
  k.add(boat, dark, { pos: [0, 0, Z_TAIL - 0.06] });
  const nozzle = new THREE.CylinderGeometry(0.06, 0.075, 0.14, 18, 1, true);
  nozzle.rotateX(Math.PI / 2);
  k.add(nozzle, dark, { pos: [0, 0, Z_TAIL - 0.17] });
  for (let i = 0; i < 4; i++) {
    const a = Math.PI / 4 + (i * Math.PI) / 2;
    k.add(fin(0.42, 0.2, 0.26, 0.18, 0.012, Z_TAIL + 0.45), grey, { rot: [0, 0, a] });
    k.add(fin(0.14, 0.06, 0.1, 0.06, 0.008, 1.2), grey, { rot: [0, 0, a] });
  }
  k.add(new THREE.BoxGeometry(0.035, 0.03, 1.4), grey, { pos: [0, -R - 0.012, -0.4] });
  const model = k.build();
  model.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  group.add(model);

  // Exhaust: two nested additive flame cones and a glow sprite.
  const flames = [];
  for (const [len, rad, color, op] of [[1.8, 0.08, 0xfff0c0, 1], [3.2, 0.14, 0xff9a3c, 0.7]]) {
    const geo = new THREE.ConeGeometry(rad, len, 16, 1, true);
    geo.rotateX(-Math.PI / 2);
    geo.translate(0, 0, Z_TAIL - 0.22 - len / 2);
    const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      color: new THREE.Color(color).multiplyScalar(2.2), transparent: true, opacity: op,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    group.add(m);
    flames.push(m);
  }
  const glow = new THREE.Sprite(new THREE.SpriteMaterial({
    map: canvasTexture(64, 64, (ctx) => {
      const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
      g.addColorStop(0, 'rgba(255,240,200,1)');
      g.addColorStop(0.3, 'rgba(255,170,60,0.7)');
      g.addColorStop(1, 'rgba(255,120,20,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 64, 64);
    }),
    blending: THREE.AdditiveBlending, depthWrite: false,
  }));
  glow.scale.setScalar(2.4);
  glow.position.z = Z_TAIL - 0.5;
  group.add(glow);

  return {
    group,
    // Flicker as a pure function of t.
    setExhaust(t) {
      const f = 0.85 + 0.15 * Math.sin(t * 90) * Math.sin(t * 37);
      flames[0].scale.set(1, 1, f);
      flames[1].scale.set(1, 1, 0.9 + 0.2 * Math.sin(t * 53));
      glow.scale.setScalar(2.4 * f);
    },
  };
}

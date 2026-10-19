import * as THREE from 'three';
import { Kit, mat, canvasTexture } from './kit.js';
import { addEngine, addFlange } from './engine.js';

// Orange target drone (H-10 style): boxy fuselage, high straight wing,
// exposed two-cylinder boxer engine (models/engine.js) with a two-blade tractor prop, no
// landing gear (catapult launch). ~4.4 m long, 5.4 m span.
// Nose points along local +Z, left wing along +X, origin ~ centre of mass.
// Direct children of `group` are the pieces it breaks into on impact.

const TOP_Y = 0.25; // fuselage top line (wing sits on it)

// --- Lofting -------------------------------------------------------------------
// Connect closed loops of equal point count. UV: u around the loop, v along
// the stations (stations are evenly spaced, so painted detail isn't stretched).
function loft(loops, { capStart = true, capEnd = true } = {}) {
  const S = loops.length;
  const N = loops[0].length;
  const pos = [];
  const uv = [];
  const P = (i, j) => new THREE.Vector3(...loops[i][j % N]);
  const centre = (loop) => loop.reduce((s, p) => s.add(new THREE.Vector3(...p)), new THREE.Vector3()).divideScalar(N);
  // Loop direction and station order vary between callers (left/right wing,
  // fin): pick the winding that makes normals point away from the loop centre.
  const mid = Math.floor(S / 2);
  const a0 = P(mid, 0), b0 = P(mid, 1), c0 = P(mid + 1 < S ? mid + 1 : mid - 1, 1);
  const n0 = new THREE.Vector3().crossVectors(b0.clone().sub(a0), c0.clone().sub(a0));
  if (mid + 1 >= S) n0.negate();
  const flip = n0.dot(a0.clone().sub(centre(loops[mid]))) < 0;
  for (let i = 0; i < S - 1; i++) {
    for (let j = 0; j < N; j++) {
      const a = P(i, j), b = P(i, j + 1), c = P(i + 1, j + 1), d = P(i + 1, j);
      const u0 = j / N, u1 = (j + 1) / N, v0 = i / (S - 1), v1 = (i + 1) / (S - 1);
      if (!flip) {
        pos.push(...a, ...b, ...c, ...a, ...c, ...d);
        uv.push(u0, v0, u1, v0, u1, v1, u0, v0, u1, v1, u0, v1);
      } else {
        pos.push(...a, ...c, ...b, ...a, ...d, ...c);
        uv.push(u0, v0, u1, v1, u1, v0, u0, v0, u0, v1, u1, v1);
      }
    }
  }
  const cap = (i, inward) => {
    const c = centre(loops[i]);
    const away = c.clone().sub(centre(loops[inward]));
    for (let j = 0; j < N; j++) {
      const a = P(i, j), b = P(i, j + 1);
      const n = new THREE.Vector3().crossVectors(a.clone().sub(c), b.clone().sub(c));
      if (n.dot(away) >= 0) pos.push(...c, ...a, ...b); else pos.push(...c, ...b, ...a);
      uv.push(0.5, 0.5, 0.5, 0.5, 0.5, 0.5);
    }
  };
  if (capStart) cap(0, 1);
  if (capEnd) cap(S - 1, S - 2);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.computeVertexNormals();
  return g;
}

// Rounded rectangle loop in the XY plane at depth z. Starts at the bottom
// centre and runs toward +X (left side), top, -X (right side).
function roundedRect(hw, hh, r, cy, z, n = 40) {
  const pts = [];
  for (let k = 0; k < n; k++) {
    const a = -Math.PI / 2 + (k / n) * Math.PI * 2; // angle from bottom, CCW seen from the nose
    // Superellipse gives a rounded box with a single parameter.
    const e = 2 / (1 + 6 * (1 - r / Math.min(hw, hh)));
    const c = Math.cos(a), s = Math.sin(a);
    const x = Math.sign(c) * Math.abs(c) ** e * hw;
    const y = Math.sign(s) * Math.abs(s) ** e * hh;
    pts.push([x, cy + y, z]);
  }
  return pts;
}

// NACA-style airfoil loop: TE -> upper -> LE -> lower -> TE (cosine spaced).
// Returns [chordwise 0..1 from LE, thickness offset] pairs.
function airfoil(n = 36, t = 0.13, camber = 0.03) {
  const pts = [];
  for (let k = 0; k < n; k++) {
    const th = (k / n) * Math.PI * 2;
    const xc = (1 + Math.cos(th)) / 2;
    const yt = 5 * t * (0.2969 * Math.sqrt(xc) - 0.126 * xc - 0.3516 * xc ** 2 + 0.2843 * xc ** 3 - 0.1036 * xc ** 4);
    const yc = camber * 4 * xc * (1 - xc);
    pts.push([xc, k < n / 2 ? yc + yt : yc - yt]);
  }
  return pts;
}

// --- Textures ---------------------------------------------------------------------

const ORANGE = '#ff5a14';

function fuselageTexture() {
  return canvasTexture(1024, 1024, (ctx, W, H) => {
    // u (x) = around (0 bottom, .25 left, .5 top, .75 right); v (y) = along, top = nose.
    ctx.fillStyle = ORANGE;
    ctx.fillRect(0, 0, W, H);
    const g = ctx.createLinearGradient(0, 0, W, 0);
    g.addColorStop(0, 'rgba(0,0,0,0.12)');
    g.addColorStop(0.5, 'rgba(255,255,255,0.06)');
    g.addColorStop(1, 'rgba(0,0,0,0.12)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    const V = (z) => H * (1 - (z + 2.3) / 4.15); // z in metres -> canvas y
    ctx.strokeStyle = 'rgba(70,20,0,0.55)';
    ctx.lineWidth = 2;
    for (const z of [1.55, 0.9, 0.2, -0.55, -1.4]) {
      ctx.beginPath();
      ctx.moveTo(0, V(z));
      ctx.lineTo(W, V(z));
      ctx.stroke();
    }
    // Access hatches with screw dots on both sides.
    for (const uc of [0.25, 0.75]) {
      for (const [z0, z1] of [[1.45, 1.0], [0.1, -0.35]]) {
        const x0 = uc * W - 50, x1 = uc * W + 50;
        ctx.strokeRect(x0, V(z0), x1 - x0, V(z1) - V(z0));
        ctx.fillStyle = 'rgba(60,20,0,0.6)';
        for (let x = x0 + 6; x < x1; x += 14) {
          ctx.fillRect(x, V(z0) + 3, 3, 3);
          ctx.fillRect(x, V(z1) - 6, 3, 3);
        }
      }
    }
    // Parachute hatch on top, aft of the wing.
    ctx.strokeStyle = 'rgba(40,10,0,0.8)';
    ctx.lineWidth = 3;
    ctx.strokeRect(0.5 * W - 70, V(-0.45), 140, V(-1.25) - V(-0.45));
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 22px sans-serif';
    ctx.textAlign = 'center';
    ctx.save();
    ctx.translate(0.5 * W, V(-0.85));
    ctx.rotate(Math.PI / 2);
    ctx.fillText('PARACHUTE', 0, 8);
    ctx.restore();
    // Side stencils (read correctly from each side; see plane-texture notes in CLAUDE.md).
    ctx.font = 'bold 30px sans-serif';
    ctx.save();
    ctx.translate(0.25 * W, V(0.6));
    ctx.rotate(Math.PI / 2);
    ctx.fillText('H10-1727', 0, 10);
    ctx.restore();
    ctx.save();
    ctx.translate(0.75 * W, V(0.6));
    ctx.rotate(-Math.PI / 2);
    ctx.fillText('H10-1727', 0, 10);
    ctx.restore();
    // Black anti-glare / wire channel along the top.
    ctx.fillStyle = '#1d1c19';
    ctx.fillRect(0.5 * W - 14, V(1.85), 28, V(-2.25) - V(1.85));
    ctx.fillStyle = 'rgba(200,190,160,0.35)';
    for (let y = V(1.8); y < V(-2.2); y += 22) ctx.fillRect(0.5 * W - 14, y, 28, 2);
    // Red/white "propeller" warning band near the nose.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, V(1.72), W, 10);
    ctx.fillStyle = '#c0141a';
    for (let x = 0; x < W; x += 40) ctx.fillRect(x, V(1.72), 20, 10);
    // Grime underneath.
    const gr = ctx.createLinearGradient(0, 0, 0.12 * W, 0);
    gr.addColorStop(0, 'rgba(40,30,20,0.35)');
    gr.addColorStop(1, 'rgba(40,30,20,0)');
    ctx.fillStyle = gr;
    ctx.fillRect(0, 0, 0.12 * W, H);
    ctx.save();
    ctx.scale(-1, 1);
    ctx.fillRect(-W, 0, 0.12 * W, H);
    ctx.restore();
  });
}

// Wing/tail surface texture: u around the airfoil (0 TE upper, .5 LE, 1 TE
// lower), v root -> tip. Hinge line at 75 % chord over [hinge0, hinge1] span.
function surfaceTexture({ hinge0, hinge1, text }) {
  return canvasTexture(512, 512, (ctx, W, H) => {
    ctx.fillStyle = ORANGE;
    ctx.fillRect(0, 0, W, H);
    const V = (v) => H * (1 - v);
    ctx.strokeStyle = 'rgba(70,20,0,0.7)';
    ctx.lineWidth = 2;
    for (const u of [1 / 6, 5 / 6]) {
      ctx.beginPath();
      ctx.moveTo(u * W, V(hinge0));
      ctx.lineTo(u * W, V(hinge1));
      ctx.stroke();
    }
    for (const v of [hinge0, hinge1]) {
      ctx.beginPath();
      ctx.moveTo(0, V(v));
      ctx.lineTo(W / 6, V(v));
      ctx.moveTo((5 / 6) * W, V(v));
      ctx.lineTo(W, V(v));
      ctx.stroke();
    }
    // Spar / rib lines.
    ctx.strokeStyle = 'rgba(70,20,0,0.25)';
    for (let v = 0.12; v < 1; v += 0.12) {
      ctx.beginPath();
      ctx.moveTo(W * 0.2, V(v));
      ctx.lineTo(W * 0.8, V(v));
      ctx.stroke();
    }
    // Leading-edge wear.
    const g = ctx.createLinearGradient(W * 0.44, 0, W * 0.56, 0);
    g.addColorStop(0, 'rgba(255,255,255,0)');
    g.addColorStop(0.5, 'rgba(255,230,200,0.25)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    if (text) {
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 34px sans-serif';
      ctx.textAlign = 'center';
      ctx.save();
      ctx.translate(W * 0.3, V(0.86));
      ctx.rotate(-Math.PI / 2);
      ctx.fillText(text, 0, 12);
      ctx.restore();
    }
  });
}

function tailDecal() {
  const tex = canvasTexture(512, 256, (ctx, W, H) => {
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 92px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('B-9HG', W / 2, 105);
    ctx.font = 'bold 78px sans-serif';
    ctx.fillText('H10-1727', W / 2, 205);
  });
  return new THREE.MeshStandardMaterial({ map: tex, transparent: true, roughness: 0.5, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 });
}

// --- Model --------------------------------------------------------------------------

function fuselageGeometry() {
  const loops = [];
  const Z0 = -2.3;
  const Z1 = 1.85;
  const S = 42;
  for (let i = 0; i < S; i++) {
    const z = Z0 + ((Z1 - Z0) * i) / (S - 1);
    const aft = THREE.MathUtils.smoothstep(z, -2.3, -0.3); // 0 at tail -> 1 mid
    const fore = 1 - THREE.MathUtils.smoothstep(z, 1.1, 1.85);
    const hw = 0.07 + 0.155 * aft - 0.03 * (1 - fore);
    const hh = 0.085 + 0.155 * aft - 0.035 * (1 - fore);
    const top = TOP_Y - 0.035 * (1 - fore);
    loops.push(roundedRect(hw, hh, Math.min(hw, hh) * 0.4, top - hh, z));
  }
  return loft(loops);
}

// Straight wing half: constant chord with a short tapered, rounded tip.
function wingGeometry(side, { span, chord, thick, yRoot, zLE, dihedral }) {
  const af = airfoil(36, thick);
  const loops = [];
  const S = 26;
  for (let i = 0; i < S; i++) {
    const f = i / (S - 1);
    const x = side * (0.02 + span * f);
    const tip = THREE.MathUtils.smoothstep(f, 0.86, 1);
    const c = chord * (1 - 0.35 * tip) * (f === 1 ? 0.6 : 1);
    const le = zLE - chord * 0.08 * tip;
    const y = yRoot + Math.abs(x) * Math.tan(dihedral);
    loops.push(af.map(([xc, yt]) => [x, y + yt * c * (f === 1 ? 0.3 : 1), le - xc * c]));
  }
  return loft(loops, { capStart: true, capEnd: true });
}

function finGeometry() {
  const af = airfoil(28, 0.11, 0);
  const loops = [];
  const S = 14;
  for (let i = 0; i < S; i++) {
    const f = i / (S - 1);
    const y = TOP_Y - 0.13 + 0.82 * f;
    const c = 0.62 - 0.26 * f;
    const le = -1.65 - 0.42 * f; // swept back
    loops.push(af.map(([xc, yt]) => [yt * c, y, le - xc * c]));
  }
  return loft(loops);
}

export function createPlane() {
  const group = new THREE.Group();
  group.name = 'plane';

  const orange = new THREE.MeshStandardMaterial({ map: fuselageTexture(), metalness: 0.15, roughness: 0.45 });
  const wingMat = new THREE.MeshStandardMaterial({ map: surfaceTexture({ hinge0: 0.5, hinge1: 0.95, text: 'H10' }), metalness: 0.15, roughness: 0.45 });
  const tailMat = new THREE.MeshStandardMaterial({ map: surfaceTexture({ hinge0: 0.05, hinge1: 0.95 }), metalness: 0.15, roughness: 0.45 });
  const metal = mat(0x8d9399, { metalness: 0.85, roughness: 0.35 });
  const alu = mat(0xb9bec2, { metalness: 0.8, roughness: 0.3 });
  const dark = mat(0x1d1f22, { metalness: 0.4, roughness: 0.6 });
  const black = mat(0x0f1012, { metalness: 0.2, roughness: 0.7 });
  const white = mat(0xf0f0ec, { metalness: 0.1, roughness: 0.5 });
  const copper = mat(0xb8733a, { metalness: 0.7, roughness: 0.35, side: THREE.DoubleSide }); // exhaust headers and the open intake bell
  const green = mat(0x6fb43a, { metalness: 0.35, roughness: 0.5 }); // the carburettor
  const blue = mat(0x4f86b8, { metalness: 0.7, roughness: 0.4 }); // the flange bolts
  const flangeOrange = mat(0xf08a1c, { metalness: 0.5, roughness: 0.35 }); // the anodised propeller flange
  const engineMats = { alu, metal, dark, black, white, copper, green, blue, orange: flangeOrange };

  const shadowed = (obj) => {
    obj.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    return obj;
  };

  // Fuselage + engine ------------------------------------------------------------
  const fuselage = new THREE.Group();
  fuselage.name = 'fuselage';
  fuselage.userData.drag = 0.25;
  const fk = new Kit();
  fk.add(fuselageGeometry(), orange);
  // Firewall plate and engine mount.
  fk.add(new THREE.BoxGeometry(0.34, 0.34, 0.03), dark, { pos: [0, 0.07, 1.87] });
  for (const [x, y] of [[0.12, 0.18], [-0.12, 0.18], [0.12, -0.04], [-0.12, -0.04]]) {
    fk.rod([x, y, 1.88], [x * 0.5, 0.07 + (y - 0.07) * 0.5, 2.0], 0.012, metal, 5);
  }
  // The engine: crankcase, two finned cylinders, plugs and leads, carburettor and intake bell, exhaust headers.
  addEngine(fk, engineMats);
  // Muffler under the engine, and its tail pipe.
  fk.add(new THREE.CapsuleGeometry(0.045, 0.22, 4, 10), metal, { pos: [0, -0.16, 1.98], rot: [0, 0, Math.PI / 2] });
  fk.rod([0.12, -0.16, 1.98], [0.16, -0.2, 1.7], 0.014, metal, 6);
  // Top antenna, GPS puck, pitot.
  fk.add(new THREE.CylinderGeometry(0.004, 0.008, 0.32, 6), black, { pos: [0, TOP_Y + 0.16, -0.75] });
  fk.add(new THREE.CylinderGeometry(0.035, 0.035, 0.015, 16), white, { pos: [0, TOP_Y + 0.008, -0.45] });
  fk.rod([0.12, -0.05, 1.5], [0.12, -0.05, 1.85], 0.006, metal, 5);
  // Nylon skids under the belly where it rests on the cradle.
  for (const z of [0.6, -0.3]) fk.add(new THREE.BoxGeometry(0.26, 0.025, 0.12), black, { pos: [0, -0.22, z] });
  fuselage.add(shadowed(fk.build()));

  // Take-off booster rocket slung under the tail (jettisoned after burnout).
  // Its flame is additive geometry, so its visibility and size are functions
  // of t (setBooster).
  const booster = new THREE.Group();
  booster.position.set(0, -0.2, -1.1);
  booster.rotation.x = -0.14; // nozzle points aft and a little down
  const bk = new Kit();
  const boosterBody = mat(0x4b5148, { metalness: 0.6, roughness: 0.5 });
  const cyl = new THREE.CylinderGeometry(0.1, 0.1, 0.9, 16);
  cyl.rotateX(Math.PI / 2);
  bk.add(cyl, boosterBody);
  const nose = new THREE.SphereGeometry(0.1, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2);
  nose.rotateX(Math.PI / 2);
  bk.add(nose, boosterBody, { pos: [0, 0, 0.45] });
  const bell = new THREE.CylinderGeometry(0.07, 0.125, 0.16, 16, 1, true);
  bell.rotateX(-Math.PI / 2);
  bk.add(bell, dark, { pos: [0, 0, -0.53] });
  for (const z of [0.22, -0.22]) {
    const band = new THREE.TorusGeometry(0.102, 0.012, 6, 20);
    bk.add(band, white, { pos: [0, 0, z] });
  }
  for (const z of [0.25, -0.25]) bk.rod([0, 0.08, z], [0, 0.2, z], 0.012, metal, 4);
  booster.add(shadowed(bk.build()));
  const flameMats = [];
  const flames = [[5.6, 0.3, 0xffd35a, 0.7], [3.2, 0.17, 0xfff3c4, 0.95]].map(([len, rad, color, opacity]) => {
    const geo = new THREE.ConeGeometry(rad, len, 16, 1, true);
    geo.rotateX(-Math.PI / 2); // apex points aft (-z)
    geo.translate(0, 0, -0.6 - len / 2);
    const material = new THREE.MeshBasicMaterial({
      color: new THREE.Color(color).multiplyScalar(2.4), transparent: true, opacity,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    });
    flameMats.push(material);
    const m = new THREE.Mesh(geo, material);
    m.visible = false;
    booster.add(m);
    return m;
  });
  const flameGlow = new THREE.Sprite(new THREE.SpriteMaterial({
    map: canvasTexture(64, 64, (ctx) => {
      const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
      g.addColorStop(0, 'rgba(255,245,210,1)');
      g.addColorStop(0.3, 'rgba(255,190,70,0.75)');
      g.addColorStop(1, 'rgba(255,120,20,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 64, 64);
    }),
    blending: THREE.AdditiveBlending, depthWrite: false, color: new THREE.Color(2, 2, 2),
  }));
  flameGlow.position.z = -0.75;
  flameGlow.visible = false;
  booster.add(flameGlow);
  fuselage.add(booster);
  group.add(fuselage);

  // Wings (high-mounted on the fuselage top) -------------------------------------
  const wingSpec = { span: 2.65, chord: 0.58, thick: 0.13, yRoot: TOP_Y + 0.02, zLE: 0.62, dihedral: THREE.MathUtils.degToRad(1.5) };
  const lights = [];
  for (const side of [1, -1]) {
    const wing = new THREE.Group();
    wing.name = side > 0 ? 'wingL' : 'wingR';
    wing.userData.drag = 0.45;
    const wk = new Kit();
    wk.add(wingGeometry(side, wingSpec), wingMat);
    // Aileron horn and pushrod under the wing.
    wk.add(new THREE.BoxGeometry(0.01, 0.05, 0.03), black, { pos: [side * 1.9, TOP_Y - 0.02, 0.12] });
    wk.rod([side * 1.9, TOP_Y - 0.02, 0.14], [side * 1.9, TOP_Y - 0.01, 0.4], 0.004, metal, 4);
    wing.add(shadowed(wk.build()));
    // Navigation light at the tip: red left, green right.
    const navMat = new THREE.MeshBasicMaterial({ color: side > 0 ? 0xff2020 : 0x20ff40 });
    navMat.color.multiplyScalar(3);
    const nav = new THREE.Mesh(new THREE.SphereGeometry(0.025, 8, 6), navMat);
    nav.position.set(side * (wingSpec.span + 0.02), TOP_Y + 0.07, 0.25);
    wing.add(nav);
    lights.push(nav);
    group.add(wing);
  }
  // Wing root fairing blocks belong to the fuselage.
  fuselage.add(shadowed(new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.04, 0.6), orange).translateY(TOP_Y + 0.01).translateZ(0.33)));

  // Tail: horizontal stabiliser + swept fin -----------------------------------------
  const tail = new THREE.Group();
  tail.name = 'tail';
  tail.userData.drag = 0.5;
  const tk = new Kit();
  for (const side of [1, -1]) {
    tk.add(wingGeometry(side, { span: 0.82, chord: 0.4, thick: 0.09, yRoot: 0.12, zLE: -1.86, dihedral: 0 }), tailMat);
  }
  tk.add(finGeometry(), tailMat);
  tail.add(shadowed(tk.build()));
  // Registration on both sides of the fin, each reading correctly.
  const decalMat = tailDecal();
  for (const side of [1, -1]) {
    const decal = new THREE.Mesh(new THREE.PlaneGeometry(0.42, 0.21), decalMat);
    decal.position.set(side * 0.035, TOP_Y + 0.3, -2.1);
    decal.rotation.y = side * Math.PI / 2;
    decal.rotation.x = 0;
    tail.add(decal);
  }
  const strobeMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(4, 4, 4) });
  const strobe = new THREE.Mesh(new THREE.SphereGeometry(0.03, 8, 6), strobeMat);
  strobe.position.set(0, TOP_Y + 0.7, -2.42);
  tail.add(strobe);
  group.add(tail);

  // Two-blade propeller -----------------------------------------------------------------
  const prop = new THREE.Group();
  prop.name = 'prop';
  prop.userData.drag = 0.3;
  const bladeMat = mat(0x2a1d14, { metalness: 0.05, roughness: 0.55, transparent: true });
  const pk = new Kit();
  addFlange(pk, engineMats); // the orange flange, its steel boss and four blue bolts
  for (const s of [1, -1]) {
    // Twisted, tapered blade with a rounded tip.
    const blade = new THREE.BoxGeometry(0.075, 0.44, 0.016, 1, 14, 1);
    const p = blade.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const r = (p.getY(i) + 0.22) / 0.44; // 0 root .. 1 tip
      const w = (0.7 + 0.5 * Math.sin(Math.PI * Math.min(r * 1.4, 1))) * (r > 0.92 ? 1 - (r - 0.92) * 8 : 1);
      const twist = 0.75 - 0.55 * r;
      const x = p.getX(i) * w;
      const z = p.getZ(i);
      p.setXYZ(i, x * Math.cos(twist) - z * Math.sin(twist), p.getY(i) + 0.26, x * Math.sin(twist) + z * Math.cos(twist));
    }
    blade.computeVertexNormals();
    pk.add(blade, bladeMat, { rot: [0, 0, s > 0 ? 0 : Math.PI] });
  }
  prop.add(shadowed(pk.build()));
  const discMat = new THREE.MeshBasicMaterial({ color: 0x2a2018, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide });
  prop.add(new THREE.Mesh(new THREE.RingGeometry(0.06, 0.49, 48), discMat));
  prop.position.set(0, 0.07, 2.25);
  group.add(prop);

  const parts = group.children.slice();
  for (const p of parts) {
    p.userData.restPos = p.position.clone();
    p.userData.restQuat = p.quaternion.clone();
  }

  const _spin = new THREE.Quaternion();
  const _zAxis = new THREE.Vector3(0, 0, 1);
  return {
    group,
    parts,
    prop,
    // spin01: 0 = stopped, 1 = full rpm (blades blur into a disc).
    setProp(angle, spin01) {
      prop.quaternion.copy(prop.userData.restQuat).multiply(_spin.setFromAxisAngle(_zAxis, angle));
      const blur = THREE.MathUtils.smoothstep(spin01, 0.25, 0.8);
      bladeMat.opacity = 1 - 0.85 * blur;
      discMat.opacity = 0.32 * blur;
    },
    // Anti-collision strobe: double flash once a second, as a function of t.
    setLights(t, on) {
      const ph = ((t % 1) + 1) % 1;
      strobe.visible = on && (ph < 0.05 || (ph > 0.12 && ph < 0.17));
      for (const l of lights) l.visible = on;
    },
    // Booster: ignites at t0, burns until t1, canister drops off shortly after.
    setBooster(t, t0, t1) {
      const on = t >= t0 && t <= t1;
      booster.visible = t < t1 + 0.35;
      for (const f of flames) f.visible = on;
      flameGlow.visible = on;
      if (!on) return;
      const ramp = THREE.MathUtils.smoothstep(t, t0, t0 + 0.12) * (1 - THREE.MathUtils.smoothstep(t, t1 - 0.35, t1));
      const flick = 0.88 + 0.12 * Math.sin(t * 130) * Math.sin(t * 47);
      flames[0].scale.set(1, 1, Math.max(0.01, ramp * flick));
      flames[1].scale.set(1, 1, Math.max(0.01, ramp * (0.9 + 0.1 * Math.sin(t * 77))));
      flameGlow.scale.setScalar(3.2 * ramp * flick);
    },
    restoreParts() {
      for (const p of parts) {
        p.position.copy(p.userData.restPos);
        p.quaternion.copy(p.userData.restQuat);
        p.visible = true;
      }
    },
  };
}

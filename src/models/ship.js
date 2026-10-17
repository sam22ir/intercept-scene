import * as THREE from 'three';
import {
  deckHeight, RAIL, LAUNCHER_PIVOT, TUBE_MOUTH, launcherAim, launcherQuat, shuttleStroke,
  SHIP_VARIANT, PENNANT, FWD_ROOF_Y,
} from '../scenario.js';
import { Kit, hexa, slab, facePanel, mat, canvasTexture, toMatrix } from './kit.js';
import { mulberry32 } from '../rng.js';

// Stealth frigate, ~122 m (C28A style, pennant 920 or 921 by variant). Bow along +X, built in
// the ship frame; main moves `group` along with shipPos(t).

const STERN = -60;
const DRAFT = 4.0;
const BEAM = 7.2; // half-beam at the deck edge

// --- Hull lines -----------------------------------------------------------------
// Each hull "level" (keel, bilge, waterline, knuckle, deck edge) has its own
// stem position so the bow rakes forward with height.
const LEVELS = [
  { name: 'keel', stem: 51, w: 0.5, y: () => -DRAFT },
  { name: 'bilge', stem: 53, w: 5.2, y: () => -DRAFT * 0.62 },
  { name: 'wl', stem: 55.5, w: 6.35, y: () => 0 },
  { name: 'knuckle', stem: 58.5, w: 6.8, y: (x) => deckHeight(x) * 0.42 },
  { name: 'deck', stem: 62, w: BEAM, y: (x) => deckHeight(x) },
];
const STATIONS = 120;

function widthFactor(u) {
  const u0 = 0.56;
  if (u < u0) return 0.93 + 0.07 * Math.min(u / 0.12, 1); // slight transom tumblehome
  const k = (u - u0) / (1 - u0);
  return Math.max(0, 1 - k ** 2.1) ** 0.62;
}

function levelPoint(level, i, side, out) {
  const u = i / STATIONS;
  const x = STERN + (level.stem - STERN) * u;
  const w = level.w * widthFactor(u);
  return out.set(x, level.y(x), side * w);
}

// Strip between two levels, both sides. UVs: u along the hull (flipped on the
// port side so painted lettering reads correctly), v = height. Port side
// uses the lower half of the texture, starboard the upper half.
const V_MIN = -DRAFT - 0.5;
const V_MAX = 9;
function hullStrip(lo, hi) {
  const pos = [];
  const uv = [];
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const d = new THREE.Vector3();
  const U = (x, side) => {
    const n = (x - STERN) / (62 - STERN);
    return side > 0 ? n : 1 - n;
  };
  const V = (y, side) => {
    const n = THREE.MathUtils.clamp((y - V_MIN) / (V_MAX - V_MIN), 0, 1);
    return side > 0 ? 0.5 + 0.5 * n : 0.5 * n;
  };
  for (const side of [1, -1]) {
    for (let i = 0; i < STATIONS; i++) {
      levelPoint(lo, i, side, a);
      levelPoint(lo, i + 1, side, b);
      levelPoint(hi, i + 1, side, c);
      levelPoint(hi, i, side, d);
      const quad = side > 0 ? [a, b, c, a, c, d] : [a, c, b, a, d, c];
      for (const p of quad) {
        pos.push(p.x, p.y, p.z);
        uv.push(U(p.x, side), V(p.y, side));
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.computeVertexNormals();
  return g;
}

function deckSurface() {
  const deck = LEVELS[4];
  const pos = [];
  const uv = [];
  const p = new THREE.Vector3();
  const s = new THREE.Vector3();
  const pp = new THREE.Vector3();
  const sp = new THREE.Vector3();
  const UV = (v) => [(v.x - STERN) / 122, (v.z + BEAM) / (2 * BEAM)];
  for (let i = 0; i < STATIONS; i++) {
    levelPoint(deck, i, -1, p);
    levelPoint(deck, i, 1, s);
    levelPoint(deck, i + 1, -1, pp);
    levelPoint(deck, i + 1, 1, sp);
    for (const v of [p, s, sp, p, sp, pp]) {
      pos.push(v.x, v.y, v.z);
      uv.push(...UV(v));
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.computeVertexNormals();
  return g;
}

function transom() {
  const pts = [];
  for (let l = 0; l < LEVELS.length; l++) {
    pts.push(levelPoint(LEVELS[l], 0, 1, new THREE.Vector3()));
  }
  const pos = [];
  for (let l = 0; l < pts.length - 1; l++) {
    const a = pts[l];
    const b = pts[l + 1];
    const am = a.clone().setZ(-a.z);
    const bm = b.clone().setZ(-b.z);
    for (const v of [a, bm, am, a, b, bm]) pos.push(v.x, v.y, v.z); // faces aft (-X)
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

// Low bulwark around the foredeck, following the deck edge.
function bulwark(x0, height) {
  const deck = LEVELS[4];
  const pos = [];
  const p = new THREE.Vector3();
  const q = new THREE.Vector3();
  for (const side of [1, -1]) {
    for (let i = 0; i < STATIONS; i++) {
      levelPoint(deck, i, side, p);
      levelPoint(deck, i + 1, side, q);
      if (p.x < x0) continue;
      const h0 = height * THREE.MathUtils.smoothstep(p.x, x0, x0 + 4);
      const h1 = height * THREE.MathUtils.smoothstep(q.x, x0, x0 + 4);
      const a = p.clone();
      const b = q.clone();
      const c = q.clone().setY(q.y + h1).setZ(q.z * 1.01);
      const d = p.clone().setY(p.y + h0).setZ(p.z * 1.01);
      const quad = side > 0 ? [a, b, c, a, c, d] : [a, c, b, a, d, c];
      for (const v of quad) pos.push(v.x, v.y, v.z);
      // inner face
      const quadIn = side > 0 ? [a, c, b, a, d, c] : [a, b, c, a, c, d];
      for (const v of quadIn) pos.push(v.x, v.y, v.z * 0.995);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

// --- Textures -----------------------------------------------------------------------

function hullTexture() {
  return canvasTexture(4096, 1024, (ctx, W, H) => {
    const half = H / 2;
    const rng = mulberry32(Number(PENNANT));
    const yToPx = (y) => half - ((y - V_MIN) / (V_MAX - V_MIN)) * half; // within a half
    for (const side of [1, -1]) {
      const top = side > 0 ? 0 : half; // starboard: upper half of the canvas
      const X = (x) => {
        const n = (x - STERN) / 122;
        return (side > 0 ? n : 1 - n) * W;
      };
      ctx.save();
      ctx.translate(0, top);
      ctx.beginPath();
      ctx.rect(0, 0, W, half);
      ctx.clip();
      // Base paint with gentle mottling.
      ctx.fillStyle = '#9ea7ac';
      ctx.fillRect(0, 0, W, half);
      for (let i = 0; i < 2500; i++) {
        const v = 160 + rng() * 30;
        ctx.fillStyle = `rgba(${v},${v + 6},${v + 10},0.18)`;
        ctx.fillRect(rng() * W, rng() * half, 20 + rng() * 80, 4 + rng() * 14);
      }
      // Plate seams.
      ctx.strokeStyle = 'rgba(70,78,84,0.28)';
      ctx.lineWidth = 2;
      for (const y of [1.8, 3.6, 5.4]) {
        ctx.beginPath();
        ctx.moveTo(0, yToPx(y));
        ctx.lineTo(W, yToPx(y));
        ctx.stroke();
      }
      for (let x = STERN + 6; x < 60; x += 6.5) {
        ctx.beginPath();
        ctx.moveTo(X(x), yToPx(-1));
        ctx.lineTo(X(x), yToPx(8));
        ctx.stroke();
      }
      // Rust and grime streaks under scuppers.
      for (let i = 0; i < 70; i++) {
        const x = X(STERN + 4 + rng() * 108);
        const y0 = yToPx(5 + rng() * 0.6);
        const len = 30 + rng() * 120;
        const g = ctx.createLinearGradient(0, y0, 0, y0 + len);
        const brown = rng() < 0.5;
        g.addColorStop(0, brown ? 'rgba(120,80,50,0.35)' : 'rgba(70,72,74,0.3)');
        g.addColorStop(1, 'rgba(120,80,50,0)');
        ctx.fillStyle = g;
        ctx.fillRect(x, y0, 2 + rng() * 5, len);
      }
      // Scupper holes along the deck edge.
      ctx.fillStyle = '#3b4247';
      for (let x = STERN + 3; x < 40; x += 4.2) ctx.fillRect(X(x), yToPx(5.25), 10, 7);
      // Boot topping and waterline.
      ctx.fillStyle = '#2c2321';
      ctx.fillRect(0, yToPx(0.55), W, half);
      ctx.fillStyle = '#5b1f1b';
      ctx.fillRect(0, yToPx(-0.6), W, half);
      // Draft marks near bow and stern.
      ctx.fillStyle = '#e8e8e2';
      ctx.font = 'bold 18px sans-serif';
      for (const x of [48, -55]) {
        for (let d = 1; d <= 4; d++) {
          ctx.fillText(`${d}M`, X(x) - (side > 0 ? 0 : 30), yToPx(-d + 0.9 + 0.5));
        }
      }
      // Anchor hawse pipe.
      ctx.fillStyle = '#23282c';
      ctx.beginPath();
      ctx.ellipse(X(52.5), yToPx(5.7), 26, 20, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(110,70,45,0.45)';
      ctx.fillRect(X(52.5) - 6, yToPx(5.4), 12, 130);
      // Pennant number with drop shadow.
      ctx.font = 'italic bold 230px "Arial Narrow", Arial, sans-serif';
      ctx.textBaseline = 'alphabetic';
      ctx.textAlign = 'center';
      const nx = X(41);
      const ny = yToPx(2.3);
      ctx.fillStyle = 'rgba(40,46,50,0.55)';
      ctx.fillText(PENNANT, nx + 5, ny + 5);
      ctx.fillStyle = '#f3f3ee';
      ctx.fillText(PENNANT, nx, ny);
      ctx.restore();
    }
  });
}

function deckTexture() {
  return canvasTexture(4096, 512, (ctx, W, H) => {
    const rng = mulberry32(21);
    const X = (x) => ((x - STERN) / 122) * W;
    const Z = (z) => ((z + BEAM) / (2 * BEAM)) * H; // canvas top = port
    ctx.fillStyle = '#4c5257';
    ctx.fillRect(0, 0, W, H);
    for (let i = 0; i < 20000; i++) {
      const v = 60 + rng() * 40;
      ctx.fillStyle = `rgba(${v},${v + 3},${v + 6},0.4)`;
      ctx.fillRect(rng() * W, rng() * H, 2 + rng() * 3, 2 + rng() * 3);
    }
    // Helideck: darker non-skid pad with markings.
    ctx.fillStyle = '#3d4246';
    ctx.fillRect(X(-59.5), Z(-6.6), X(-36) - X(-59.5), Z(6.6) - Z(-6.6));
    const cx = X(-46);
    const cz = Z(0.5);
    const r = (5.2 / 122) * W;
    ctx.strokeStyle = '#f0c419';
    ctx.lineWidth = 9;
    ctx.beginPath();
    ctx.ellipse(cx, cz, r, (5.2 / 14.4) * H, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = '#ecebe4';
    ctx.lineWidth = 6;
    ctx.strokeRect(X(-59), Z(-6.3), X(-36.5) - X(-59), Z(6.3) - Z(-6.3));
    ctx.beginPath();
    ctx.moveTo(X(-58.5), Z(0.5));
    ctx.lineTo(X(-37), Z(0.5));
    ctx.setLineDash([30, 20]);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.save();
    ctx.translate(cx, cz);
    ctx.scale(1, H / 14.4 / (W / 122));
    ctx.fillStyle = '#ecebe4';
    ctx.font = 'bold 120px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.rotate(Math.PI / 2);
    ctx.fillText('H', 0, 0);
    ctx.restore();
    // Foredeck walkway lines and anchor-chain plates.
    ctx.strokeStyle = 'rgba(236,235,228,0.5)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(X(30), Z(0));
    ctx.lineTo(X(60), Z(0));
    ctx.stroke();
    ctx.fillStyle = '#2f3438';
    ctx.fillRect(X(46), Z(-2.2), X(54) - X(46), 10);
    ctx.fillRect(X(46), Z(2.2), X(54) - X(46), 10);
  });
}

// --- Detail helpers -------------------------------------------------------------

function railingAlongDeck(kit, metal, x0, x1, side, inset = 0.15) {
  const deck = LEVELS[4];
  const pts = [];
  const p = new THREE.Vector3();
  for (let i = 0; i <= STATIONS; i++) {
    levelPoint(deck, i, side, p);
    if (p.x >= x0 && p.x <= x1) pts.push(p.clone().setZ(p.z - side * inset));
  }
  railingAlong(kit, metal, pts);
}

function railingAlong(kit, metal, pts, height = 1.05, spacing = 1.6) {
  let acc = spacing;
  for (let i = 0; i < pts.length; i++) {
    if (i > 0) acc += pts[i].distanceTo(pts[i - 1]);
    if (acc >= spacing || i === pts.length - 1) {
      acc = 0;
      const b = pts[i];
      kit.rod(b.toArray(), [b.x, b.y + height, b.z], 0.03, metal, 5);
    }
    if (i > 0) {
      const a = pts[i - 1];
      const b = pts[i];
      for (const h of [height, height * 0.5]) {
        kit.rod([a.x, a.y + h, a.z], [b.x, b.y + h, b.z], 0.022, metal, 4);
      }
    }
  }
}

// Life-raft canister on a cradle.
function raft(kit, white, metal, x, y, z) {
  const geo = new THREE.CapsuleGeometry(0.33, 0.95, 4, 10);
  kit.add(geo, white, { pos: [x, y + 0.42, z], rot: [Math.PI / 2, 0, 0] });
  kit.add(new THREE.BoxGeometry(0.7, 0.12, 1.4), metal, { pos: [x, y + 0.06, z] });
}

export function createShip() {
  const group = new THREE.Group();
  group.name = 'ship';

  const hullTex = hullTexture();
  const M = {
    hull: new THREE.MeshStandardMaterial({ map: hullTex, metalness: 0.35, roughness: 0.62 }),
    deck: new THREE.MeshStandardMaterial({ map: deckTexture(), metalness: 0.15, roughness: 0.9 }),
    grey: mat(0x949da3, { metalness: 0.35, roughness: 0.6 }),
    greyLight: mat(0xa9b1b5, { metalness: 0.3, roughness: 0.58 }),
    greyDark: mat(0x6e777d, { metalness: 0.45, roughness: 0.6 }),
    metal: mat(0x9aa2a7, { metalness: 0.7, roughness: 0.4 }),
    black: mat(0x16191c, { metalness: 0.5, roughness: 0.5 }),
    glass: mat(0x0d1a24, { metalness: 0.9, roughness: 0.08 }),
    white: mat(0xd9dbd6, { metalness: 0.1, roughness: 0.55 }),
    red: mat(0xa3231c, { metalness: 0.2, roughness: 0.6 }),
    orange: mat(0xff6a14, { metalness: 0.1, roughness: 0.7 }),
    yellow: mat(0xf0b818, { metalness: 0.2, roughness: 0.6 }),
    rubber: mat(0x2a2d30, { metalness: 0.0, roughness: 0.9 }),
    skin: mat(0xb88a68, { metalness: 0.0, roughness: 0.8 }),
    navy: mat(0x1f2a3d, { metalness: 0.0, roughness: 0.85 }),
  };
  M.metal.userData.noShadow = true;

  // Hull ------------------------------------------------------------------------
  const hull = new Kit();
  for (let l = 0; l < LEVELS.length - 1; l++) hull.add(hullStrip(LEVELS[l], LEVELS[l + 1]), M.hull);
  hull.add(transom(), M.greyDark);
  hull.add(bulwark(36, 0.95), M.grey);
  group.add(hull.build({ name: 'hull' }));

  const deck = new THREE.Mesh(deckSurface(), M.deck);
  deck.receiveShadow = true;
  group.add(deck);

  const k = new Kit();
  const dk = (x) => deckHeight(x);

  // Foredeck fittings ---------------------------------------------------------
  // Breakwater (V-shaped splash wall ahead of the gun).
  for (const s of [1, -1]) {
    k.add(hexa([
      [41, dk(41), 0], [37, dk(37), s * 5.6], [37.25, dk(37), s * 5.6], [41.25, dk(41), 0],
      [41, dk(41) + 0.9, 0], [37, dk(37) + 0.9, s * 5.6], [37.25, dk(37) + 0.9, s * 5.6], [41.25, dk(41) + 0.9, 0],
    ]), M.grey);
  }
  // Windlass, chain and bollards.
  for (const s of [1, -1]) {
    k.add(new THREE.CylinderGeometry(0.55, 0.6, 0.7, 16), M.greyDark, { pos: [49, dk(49) + 0.35, s * 1.8] });
    k.add(new THREE.CylinderGeometry(0.35, 0.35, 0.25, 12), M.black, { pos: [49, dk(49) + 0.82, s * 1.8] });
    for (let i = 0; i < 9; i++) {
      const x = 49.8 + i * 0.32;
      k.add(new THREE.TorusGeometry(0.12, 0.04, 4, 8), M.black, { pos: [x, dk(x) + 0.06, s * 2.2], rot: [Math.PI / 2, i % 2 ? Math.PI / 2 : 0, 0] });
    }
    for (const x of [56, 44, 30, -12, -38, -57]) {
      const z = s * (LEVELS[4].w * widthFactor((x - STERN) / (62 - STERN)) - 0.8);
      for (const dx of [-0.35, 0.35]) {
        k.add(new THREE.CylinderGeometry(0.16, 0.18, 0.5, 10), M.black, { pos: [x + dx, dk(x) + 0.25, z] });
      }
    }
  }
  // Jackstaff with flag at the stem.
  k.rod([60.6, dk(60.6), 0], [60.6, dk(60.6) + 3.2, 0], 0.04, M.metal);

  // 76 mm gun (stealth faceted turret) ----------------------------------------
  const gunX = 32;
  const gy = dk(gunX);
  k.add(new THREE.CylinderGeometry(1.7, 1.9, 0.5, 24), M.greyDark, { pos: [gunX, gy + 0.25, 0] });
  const turret = { x0: gunX - 2.4, x1: gunX + 1.2, tx0: gunX - 2.1, tx1: gunX - 0.2, y0: gy + 0.5, y1: gy + 2.2, w: 1.55, tw: 1.0 };
  k.add(slab(turret), M.grey);
  k.add(slab({ x0: gunX - 2.1, x1: gunX - 0.2, y0: gy + 2.2, y1: gy + 2.45, w: 1.0, tw: 0.75 }), M.grey);
  k.add(facePanel(turret, 'fore', 0.35, 0.65, 0.2, 0.75, 0.02), M.greyDark);
  k.add(new THREE.CylinderGeometry(0.11, 0.13, 4.6, 12), M.grey, { pos: [gunX + 3.2, gy + 1.45, 0], rot: [0, 0, -Math.PI / 2 + 0.06] });
  k.add(new THREE.CylinderGeometry(0.22, 0.25, 0.9, 14), M.grey, { pos: [gunX + 1.45, gy + 1.35, 0], rot: [0, 0, -Math.PI / 2 + 0.06] });
  k.add(new THREE.CylinderGeometry(0.15, 0.15, 0.5, 12), M.greyDark, { pos: [gunX + 5.4, gy + 1.58, 0], rot: [0, 0, -Math.PI / 2 + 0.06] });

  // Forward deckhouse carrying the missile launcher ---------------------------
  const fdh = { x0: 19, x1: 28.5, tx0: 19, tx1: 27.6, y0: dk(19) - 0.1, y1: dk(24) + 2.2, w: 4.6, tw: 4.1 };
  k.add(slab(fdh), M.grey);
  for (const s of [-1, 1]) {
    const face = s < 0 ? 'port' : 'stbd';
    k.add(facePanel(fdh, face, 0.3, 0.42, 0.05, 0.8), M.greyDark); // door
  }
  railingAlong(k, M.metal, [
    new THREE.Vector3(27.4, fdh.y1, -3.9), new THREE.Vector3(27.4, fdh.y1, 3.9),
  ], 0.9);

  // Forward superstructure + bridge ------------------------------------------
  const sup1 = { x0: 4, x1: 19.5, tx0: 4, tx1: 18.6, y0: 5.5, y1: 9.2, w: 6.5, tw: 5.9 };
  const sup2 = { x0: 5.5, x1: 17.4, tx0: 6, tx1: 15.4, y0: 9.2, y1: 12.6, w: 5.9, tw: 5.1 };
  const sup3 = { x0: 6, x1: 13, tx0: 6.4, tx1: 12.2, y0: 12.6, y1: 13.6, w: 4.6, tw: 4.2 };
  k.add(slab(sup1), M.grey).add(slab(sup2), M.grey).add(slab(sup3), M.grey);
  k.add(facePanel(sup2, 'fore', 0.06, 0.94, 0.42, 0.86, 0.02), M.glass);
  for (const face of ['port', 'stbd']) {
    k.add(facePanel(sup2, face, 0.02, 0.32, 0.42, 0.86, 0.02), M.glass);
    k.add(facePanel(sup1, face, 0.12, 0.2, 0.05, 0.8), M.greyDark);
    k.add(facePanel(sup1, face, 0.55, 0.63, 0.05, 0.8), M.greyDark);
    for (let i = 0; i < 4; i++) k.add(facePanel(sup1, face, 0.3 + i * 0.05, 0.33 + i * 0.05, 0.55, 0.7), M.glass);
  }
  // Bridge wings.
  for (const s of [-1, 1]) {
    k.add(hexa([
      [13, 9.2, s * 5.9], [16.2, 9.2, s * 5.9], [16.2, 9.2, s * 6.9], [13, 9.2, s * 6.9],
      [13, 10.3, s * 5.6], [15.6, 10.3, s * 5.6], [15.6, 10.3, s * 6.9], [13, 10.3, s * 6.9],
    ]), M.grey);
  }
  // Integrated mast: enclosed tapering tower.
  const mast = { x0: 6.6, x1: 12, tx0: 7.6, tx1: 10.8, y0: 13.6, y1: 20.5, w: 3.4, tw: 1.9 };
  k.add(slab(mast), M.grey);
  k.add(slab({ x0: 7.2, x1: 11.2, y0: 20.5, y1: 20.8, w: 2.3 }), M.greyDark); // platform
  railingAlong(k, M.metal, [
    new THREE.Vector3(7.2, 20.8, -2.3), new THREE.Vector3(11.2, 20.8, -2.3),
    new THREE.Vector3(11.2, 20.8, 2.3), new THREE.Vector3(7.2, 20.8, 2.3), new THREE.Vector3(7.2, 20.8, -2.3),
  ], 0.8, 1.0);
  for (const face of ['port', 'stbd', 'fore']) {
    k.add(facePanel(mast, face, 0.25, 0.75, 0.35, 0.6, 0.02), M.greyLight); // ESM panels
  }
  // Fire-control director on the bridge roof.
  k.add(new THREE.CylinderGeometry(0.7, 0.8, 1.2, 14), M.grey, { pos: [14.1, 13.2, 0] });
  k.add(new THREE.SphereGeometry(0.85, 16, 12), M.white, { pos: [14.1, 14.5, 0] });
  k.add(new THREE.BoxGeometry(0.5, 0.5, 1.6), M.greyDark, { pos: [14.4, 14.5, 0] });
  // Lattice topmast with yards and antennas.
  const legs = [[8, -1.1], [10.4, -1.1], [10.4, 1.1], [8, 1.1]];
  const topH = 29.5;
  const lp = (i, y) => {
    const f = (y - 20.8) / (topH - 20.8);
    const [x, z] = legs[i];
    return [THREE.MathUtils.lerp(x, 9.2, f * 0.75), y, z * (1 - f * 0.75)];
  };
  for (let i = 0; i < 4; i++) k.rod(lp(i, 20.8), lp(i, topH), 0.07, M.greyDark);
  for (let y = 22.5; y < topH; y += 2.2) {
    for (let i = 0; i < 4; i++) {
      k.rod(lp(i, y), lp((i + 1) % 4, y), 0.04, M.greyDark);
      k.rod(lp(i, y), lp((i + 1) % 4, y + 2.2), 0.03, M.greyDark);
    }
  }
  k.rod([9.2, topH, 0], [9.2, topH + 3.5, 0], 0.05, M.greyDark);
  k.rod([9.2, 25, -3.2], [9.2, 25, 3.2], 0.05, M.greyDark);
  k.rod([9.2, 27.6, -2.2], [9.2, 27.6, 2.2], 0.04, M.greyDark);
  for (const z of [-3, -1.8, 1.8, 3]) k.rod([9.2, 25, z], [9.2, 23.4, z], 0.015, M.black);
  k.add(new THREE.SphereGeometry(0.45, 12, 8), M.white, { pos: [9.2, topH + 0.4, 0] });
  k.add(new THREE.CylinderGeometry(0.25, 0.25, 0.6, 10), M.white, { pos: [9.2, 27.9, 1.7] });
  k.add(new THREE.CylinderGeometry(0.25, 0.25, 0.6, 10), M.white, { pos: [9.2, 27.9, -1.7] });

  // Midships: anti-ship missile canisters, boats, rafts -----------------------
  const mid = { x0: -14, x1: 4, y0: 5.5, y1: 8.0, w: 4.4, tw: 4.0 };
  k.add(slab(mid), M.grey);
  for (const s of [-1, 1]) {
    const yaw = s * 0.42;
    for (let r = 0; r < 2; r++) {
      for (let c = 0; c < 2; c++) {
        const cx = -4 + (r - 0.5) * 0.1;
        const cz = s * 1.5 + (c - 0.5) * 0.95;
        const cy = 8.75 + r * 0.9;
        k.add(new THREE.CylinderGeometry(0.42, 0.42, 6.2, 16), M.greyLight, {
          pos: [cx, cy, cz], rot: [0, -yaw, -Math.PI / 2 + 0.17],
        });
      }
    }
    k.add(new THREE.BoxGeometry(4.2, 0.4, 2.2), M.greyDark, { pos: [-4, 8.2, s * 1.5], rot: [0, -yaw, 0] });
    // Boat recess + RHIB on davit.
    const bx = -9.5;
    const by = 6.9;
    const bz = s * 5.5;
    k.add(new THREE.CapsuleGeometry(0.42, 4.6, 4, 12), M.rubber, { pos: [bx, by, bz + 0.6], rot: [0, 0, Math.PI / 2] });
    k.add(new THREE.CapsuleGeometry(0.42, 4.6, 4, 12), M.rubber, { pos: [bx, by, bz - 0.6], rot: [0, 0, Math.PI / 2] });
    k.add(slab({ x0: bx - 2.5, x1: bx + 2.0, tx1: bx + 2.8, y0: by - 0.5, y1: by + 0.15, w: 0.7, tw: 0.95 }), M.orange);
    k.add(new THREE.BoxGeometry(1, 0.9, 0.9), M.greyLight, { pos: [bx - 0.6, by + 0.5, bz] });
    k.rod([bx - 2.2, 8.0, s * 3.9], [bx - 2.2, 10, bz], 0.09, M.greyDark);
    k.rod([bx + 2.2, 8.0, s * 3.9], [bx + 2.2, 10, bz], 0.09, M.greyDark);
    for (let i = 0; i < 4; i++) raft(k, M.white, M.greyDark, 1.2 - i * 1.0, 8.0, s * 3.3);
  }
  // Funnel: sloped block with exhaust grilles.
  const funnel = { x0: -16.5, x1: -10.5, tx0: -15.6, tx1: -11.6, y0: 8.0, y1: 12.2, w: 3.0, tw: 2.4 };
  k.add(slab(funnel), M.grey);
  k.add(slab({ x0: -15.4, x1: -11.8, y0: 12.2, y1: 12.45, w: 2.2 }), M.black);
  for (let i = 0; i < 5; i++) k.add(new THREE.BoxGeometry(3.4, 0.08, 0.08), M.greyDark, { pos: [-13.6, 12.5, -1.6 + i * 0.8] });

  // Aft superstructure: hangar, radome, CIWS ----------------------------------
  const hangar = { x0: -36, x1: -14, tx0: -35.6, tx1: -15, y0: 5.5, y1: 12.0, w: 6.5, tw: 5.7 };
  k.add(slab(hangar), M.grey);
  k.add(facePanel(hangar, 'aft', 0.15, 0.85, 0.02, 0.82, 0.02), M.greyLight); // hangar door
  for (let i = 1; i < 10; i++) k.add(facePanel(hangar, 'aft', 0.15, 0.85, 0.02 + i * 0.08, 0.025 + i * 0.08, 0.04), M.greyDark);
  for (const face of ['port', 'stbd']) {
    k.add(facePanel(hangar, face, 0.62, 0.68, 0.05, 0.7), M.greyDark);
    k.add(facePanel(hangar, face, 0.08, 0.5, 0.86, 0.9), M.greyDark);
  }
  const upper = { x0: -31, x1: -16, tx0: -30, tx1: -17, y0: 12.0, y1: 14.6, w: 4.2, tw: 3.6 };
  k.add(slab(upper), M.grey);
  k.add(slab({ x0: -26.5, x1: -21.5, y0: 14.6, y1: 16.2, w: 1.8, tw: 1.5 }), M.grey); // radome pedestal
  k.add(new THREE.SphereGeometry(2.7, 32, 20), M.white, { pos: [-24, 18.6, 0] });
  k.add(new THREE.CylinderGeometry(1.4, 1.6, 0.6, 20), M.greyDark, { pos: [-24, 16.4, 0] });
  // Close-in weapon system on the hangar roof.
  k.add(new THREE.CylinderGeometry(1.1, 1.3, 0.8, 18), M.grey, { pos: [-33.2, 12.4, 0] });
  k.add(slab({ x0: -34.4, x1: -32.2, tx1: -32.6, y0: 12.8, y1: 14.2, w: 0.85, tw: 0.7 }), M.greyLight);
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2;
    k.add(new THREE.CylinderGeometry(0.035, 0.035, 2.4, 6), M.black, {
      pos: [-31.0, 13.5 + Math.sin(a) * 0.12, Math.cos(a) * 0.12], rot: [0, 0, -Math.PI / 2],
    });
  }
  k.add(new THREE.SphereGeometry(0.55, 14, 10), M.white, { pos: [-18.2, 15.2, 0] });
  k.add(new THREE.CylinderGeometry(0.3, 0.35, 0.6, 10), M.grey, { pos: [-18.2, 14.6, 0] });
  // Whip antennas.
  for (const [x, z] of [[-20, 5.4], [-28, -5.4], [2, 4.2], [-6, -4.2]]) {
    k.rod([x, x > -15 ? 8 : 12, z], [x + 0.6, (x > -15 ? 8 : 12) + 7, z * 1.05], 0.025, M.black, 4, 0.01);
  }
  // Hangar-roof rafts.
  for (const s of [-1, 1]) for (let i = 0; i < 3; i++) raft(k, M.white, M.greyDark, -29 + i * 1.1, 12.0, s * 4.7);

  // Railings --------------------------------------------------------------------
  for (const s of [-1, 1]) {
    railingAlongDeck(k, M.metal, -59.5, -36.5, s);
    railingAlongDeck(k, M.metal, -14, 3.5, s);
    railingAlongDeck(k, M.metal, 19, 36.5, s);
  }
  railingAlong(k, M.metal, [new THREE.Vector3(-59.6, 5.6, -6.2), new THREE.Vector3(-59.6, 5.6, 6.2)]);
  // Helideck safety-net frames.
  for (let x = -58.5; x < -37; x += 1.2) {
    for (const s of [-1, 1]) k.rod([x, 5.45, s * 6.8], [x, 5.75, s * 7.7], 0.025, M.greyDark, 4);
  }

  // Crew in orange life jackets lining the foredeck and on the helideck -------
  const crewPos = [];
  for (let i = 0; i < 9; i++) {
    const x = 34 + i * 1.1;
    for (const s of [-1, 1]) {
      const z = s * (LEVELS[4].w * widthFactor((x - STERN) / (62 - STERN)) - 0.7);
      crewPos.push([x, dk(x), z, s > 0 ? -Math.PI / 2 : Math.PI / 2]);
    }
  }
  crewPos.push([-57, 5.6, 3.5, 0.6], [-56, 5.6, 4.6, 0.3], [-48, 5.6, 4.5, -0.4], [-40, 5.6, -5.5, 2.4]);
  if (SHIP_VARIANT === 'aft') {
    // Keep people out of the launcher stand's footprint.
    for (let i = crewPos.length - 1; i >= 0; i--) {
      if (Math.hypot(crewPos[i][0] - LAUNCHER_PIVOT.x, crewPos[i][2] - LAUNCHER_PIVOT.z) < 2.6) crewPos.splice(i, 1);
    }
  }
  for (const [x, y, z, ry] of crewPos) {
    const place = (geo, material, dy, sx = 1) => k.add(geo, material, toMatrix({ pos: [x, y + dy, z], rot: [0, ry, 0], scale: [sx, 1, 1] }));
    place(new THREE.CylinderGeometry(0.13, 0.15, 0.85, 8), M.navy, 0.43);
    place(new THREE.CylinderGeometry(0.21, 0.17, 0.7, 10), M.orange, 1.2);
    place(new THREE.SphereGeometry(0.12, 10, 8), M.skin, 1.68);
    place(new THREE.CylinderGeometry(0.13, 0.13, 0.08, 10), M.navy, 1.78);
  }

  group.add(k.build({ name: 'superstructure' }));

  // --- Animated parts ----------------------------------------------------------

  // Air-search radar: back-to-back planar arrays on a turning pedestal.
  const radar = new THREE.Group();
  radar.position.set(9.2, 21.2, 0);
  const rk = new Kit();
  rk.add(new THREE.CylinderGeometry(0.45, 0.6, 0.8, 14), M.greyDark, { pos: [0, 0.4, 0] });
  rk.add(new THREE.BoxGeometry(0.5, 1.6, 3.6), M.grey, { pos: [0, 1.6, 0] });
  rk.add(new THREE.BoxGeometry(0.08, 1.4, 3.3), M.greyLight, { pos: [0.29, 1.6, 0] });
  rk.add(new THREE.BoxGeometry(0.08, 1.4, 3.3), M.greyLight, { pos: [-0.29, 1.6, 0] });
  radar.add(rk.build({ castShadow: false }));
  group.add(radar);

  // 8-cell trainable missile launcher.
  const launcher = new THREE.Group();
  launcher.position.copy(LAUNCHER_PIVOT);
  const base = new Kit();
  // Support surface in the launcher's frame: the deckhouse roof (forward fit)
  // or the helideck (aft fit, where the stand is taller and braced).
  const aft = SHIP_VARIANT === 'aft';
  const roof = (aft ? deckHeight(LAUNCHER_PIVOT.x) : FWD_ROOF_Y) - LAUNCHER_PIVOT.y;
  base.add(new THREE.CylinderGeometry(aft ? 0.75 : 1.0, aft ? 1.0 : 1.3, -0.4 - roof, 20), M.greyDark, { pos: [0, (roof - 0.4) / 2, 0] });
  if (aft) {
    base.add(new THREE.BoxGeometry(3.0, 0.14, 3.0), M.greyDark, { pos: [0, roof + 0.07, 0] });
    for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      base.rod([sx * 1.35, roof + 0.14, sz * 1.35], [sx * 0.55, roof * 0.35 - 0.1, sz * 0.55], 0.06, M.greyLight, 6);
      base.add(new THREE.BoxGeometry(0.28, 0.1, 0.28), M.black, { pos: [sx * 1.35, roof + 0.19, sz * 1.35] });
    }
    base.add(new THREE.BoxGeometry(0.9, 0.55, 0.6), M.greyLight, { pos: [-1.9, roof + 0.4, 0] }); // hydraulic unit
  }
  const yawGroup = new THREE.Group();
  const yk = new Kit();
  yk.add(new THREE.CylinderGeometry(0.9, 1.0, 0.5, 18), M.grey, { pos: [0, -0.5, 0] });
  for (const s of [-1, 1]) yk.add(new THREE.BoxGeometry(0.9, 1.2, 0.18), M.grey, { pos: [0, -0.05, s * 1.45] });
  yawGroup.add(yk.build());
  const pitchGroup = new THREE.Group();
  const pk = new Kit();
  pk.add(new THREE.BoxGeometry(3.4, 1.22, 2.6), M.greyLight, { pos: [0.05, 0, 0] });
  pk.add(new THREE.BoxGeometry(0.1, 1.3, 2.7), M.grey, { pos: [-1.6, 0, 0] });
  const caps = [];
  for (let r = 0; r < 2; r++) {
    for (let c = 0; c < 4; c++) {
      const y = r === 0 ? 0.3 : -0.3;
      const z = -0.93 + c * 0.62;
      const isFiring = Math.abs(y - TUBE_MOUTH.y) < 0.01 && Math.abs(z - TUBE_MOUTH.z) < 0.01;
      if (!isFiring) pk.add(new THREE.CylinderGeometry(0.24, 0.24, 0.06, 16), M.white, { pos: [1.76, y, z], rot: [0, 0, Math.PI / 2] });
      pk.add(new THREE.CylinderGeometry(0.26, 0.26, 0.04, 16), M.black, { pos: [1.74, y, z], rot: [0, 0, Math.PI / 2] });
      if (isFiring) caps.push([1.78, y, z]);
    }
  }
  pitchGroup.add(pk.build());
  const fireCap = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.24, 0.06, 16), M.white);
  fireCap.rotation.z = Math.PI / 2;
  fireCap.position.set(...caps[0]);
  pitchGroup.add(fireCap);
  yawGroup.add(pitchGroup);
  launcher.add(base.build(), yawGroup);
  group.add(launcher);

  // Drone catapult: truss frame, rails, sliding cradle -------------------------
  const rail = new THREE.Group();
  rail.position.copy(RAIL.start);
  rail.quaternion.copy(launcherQuat(RAIL.yaw, 0, new THREE.Quaternion()));
  // Inside `rail`, +X runs along the launch heading (level), +Y is up.
  const ck = new Kit();
  const L = RAIL.length;
  const cp = Math.cos(RAIL.pitch);
  const sp = Math.sin(RAIL.pitch);
  const railPt = (s, y = 0, z = 0) => [s * cp - y * sp, s * sp + y * cp, z];
  const deckLocalY = deckHeight(-52) - RAIL.start.y;
  for (const z of [-0.32, 0.32]) {
    // Main rails (I-beams) along the incline.
    ck.add(new THREE.BoxGeometry(L + 0.6, 0.18, 0.16), M.greyLight, toMatrix({ pos: railPt(L / 2, -0.09, z), rot: [0, 0, RAIL.pitch] }));
    ck.add(new THREE.BoxGeometry(L + 0.6, 0.05, 0.32), M.metal, toMatrix({ pos: railPt(L / 2, 0.0, z), rot: [0, 0, RAIL.pitch] }));
    ck.add(new THREE.BoxGeometry(L + 0.6, 0.05, 0.32), M.greyLight, toMatrix({ pos: railPt(L / 2, -0.2, z), rot: [0, 0, RAIL.pitch] }));
  }
  // Pneumatic cylinder under the rails.
  ck.add(new THREE.CylinderGeometry(0.16, 0.16, L, 14), M.greyDark, toMatrix({ pos: railPt(L / 2, -0.45, 0), rot: [0, 0, RAIL.pitch - Math.PI / 2] }));
  // Truss legs down to the deck where it is under the rail, cross-bracing.
  const legS = [0.3, 2.6, 4.9, 7.0];
  for (const s of legS) {
    const top = railPt(s, -0.25, 0);
    for (const z of [-0.75, 0.75]) {
      ck.rod([top[0], top[1], z * 0.45], [top[0] - 0.15, deckLocalY, z], 0.06, M.greyLight, 6);
    }
    ck.rod([top[0] - 0.1, deckLocalY + 0.3, -0.7], [top[0] - 0.1, deckLocalY + 0.3, 0.7], 0.045, M.greyLight, 6);
    ck.rod([top[0], top[1], -0.35], [top[0] - 0.15, deckLocalY, 0.75], 0.035, M.greyLight, 5);
  }
  for (let i = 0; i < legS.length - 1; i++) {
    const a = railPt(legS[i], -0.25, 0);
    const b = railPt(legS[i + 1], -0.25, 0);
    for (const z of [-0.33, 0.33]) ck.rod([a[0], a[1], z], [b[0] - 0.1, deckLocalY + 0.3, z * 2.1], 0.035, M.greyLight, 5);
  }
  // Base frame on the deck.
  ck.add(new THREE.BoxGeometry(7.6, 0.16, 0.16), M.greyLight, { pos: [3.4, deckLocalY + 0.08, -0.75] });
  ck.add(new THREE.BoxGeometry(7.6, 0.16, 0.16), M.greyLight, { pos: [3.4, deckLocalY + 0.08, 0.75] });
  for (const x of [-0.2, 3.4, 7]) ck.add(new THREE.BoxGeometry(0.16, 0.16, 1.6), M.greyLight, { pos: [x, deckLocalY + 0.08, 0] });
  ck.add(new THREE.BoxGeometry(1.4, 0.4, 1.2), M.greyDark, { pos: [-0.6, deckLocalY + 0.2, 0] }); // compressor box
  // Buffers and yellow/black hazard ends.
  const endP = railPt(L + 0.2, -0.1, 0);
  ck.add(new THREE.BoxGeometry(0.3, 0.4, 0.95), M.yellow, toMatrix({ pos: endP, rot: [0, 0, RAIL.pitch] }));
  ck.add(new THREE.BoxGeometry(0.31, 0.12, 0.96), M.black, toMatrix({ pos: [endP[0], endP[1] + 0.06, 0], rot: [0, 0, RAIL.pitch] }));
  rail.add(ck.build({ name: 'catapult' }));

  // Sliding cradle (shuttle) that carries the drone.
  const cradle = new THREE.Group();
  const sk = new Kit();
  sk.add(new THREE.BoxGeometry(1.2, 0.2, 0.9), M.greyDark, { pos: [0, 0.12, 0] });
  for (const z of [-0.28, 0.28]) {
    sk.add(new THREE.BoxGeometry(0.12, 0.42, 0.08), M.yellow, { pos: [-0.35, 0.4, z] });
    sk.add(new THREE.BoxGeometry(0.12, 0.42, 0.08), M.yellow, { pos: [0.35, 0.4, z] });
  }
  sk.add(new THREE.BoxGeometry(0.9, 0.06, 0.62), M.rubber, { pos: [0, 0.6, 0] });
  cradle.add(sk.build());
  cradle.rotation.z = RAIL.pitch;
  rail.add(cradle);
  group.add(rail);

  // Ensign on the stern staff, waving as a function of t.
  const flagGeo = new THREE.PlaneGeometry(2.2, 1.4, 16, 6);
  flagGeo.translate(1.1, 0, 0);
  const flagBase = flagGeo.attributes.position.array.slice();
  const flag = new THREE.Mesh(flagGeo, new THREE.MeshStandardMaterial({
    // Green/white field, red crescent and star.
    map: canvasTexture(256, 160, (ctx, w, h) => {
      const field = () => {
        ctx.fillStyle = '#006233';
        ctx.fillRect(0, 0, w / 2, h);
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(w / 2, 0, w / 2, h);
      };
      field();
      const cx = w / 2;
      const cy = h / 2;
      const r = h * 0.3;
      ctx.fillStyle = '#d21034';
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx + r * 0.3, cy, r * 0.8, 0, Math.PI * 2);
      ctx.clip();
      field();
      ctx.restore();
      ctx.fillStyle = '#d21034';
      ctx.beginPath();
      for (let i = 0; i < 10; i++) {
        const a = -Math.PI / 2 + (i * Math.PI) / 5;
        const rr = i % 2 ? r * 0.16 : r * 0.4;
        ctx.lineTo(cx + r * 0.62 + Math.cos(a) * rr, cy + Math.sin(a) * rr);
      }
      ctx.fill();
    }),
    side: THREE.DoubleSide, roughness: 0.8,
  }));
  const flagPole = new THREE.Group();
  flagPole.position.set(-59.8, 5.6, 0);
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.05, 4.4, 8), M.metal);
  pole.position.y = 2.2;
  flagPole.add(pole);
  flag.position.set(0, 3.6, 0);
  flag.rotation.y = Math.PI; // streams aft
  flagPole.add(flag);
  group.add(flagPole);

  // Click volumes in the ship frame (main reads userData.focus).
  const pickMat = new THREE.MeshBasicMaterial({ visible: false });
  const picks = [
    [new THREE.BoxGeometry(124, 14, 15), [1, 2.5, 0]],
    [new THREE.BoxGeometry(50, 12, 13), [-10, 13, 0]],
    [new THREE.BoxGeometry(6, 18, 5), [9, 25, 0]],
  ].map(([geo, p]) => {
    const m = new THREE.Mesh(geo, pickMat);
    m.position.set(...p);
    m.userData.focus = 'ship';
    group.add(m);
    return m;
  });

  const flagPos = flagGeo.attributes.position;
  return {
    group,
    picks,
    launcher,
    update(t, tLaunch) {
      radar.rotation.y = t * 2.1;
      const { yaw, pitch } = launcherAim(t);
      yawGroup.rotation.y = yaw;
      pitchGroup.rotation.z = pitch;
      // Tube cap blows off at launch (simple ballistic hop in launcher frame).
      const tau = t - tLaunch;
      fireCap.visible = tau < 1.2;
      if (tau > 0) {
        fireCap.position.set(caps[0][0] + 6 * tau, caps[0][1] + 5 * tau - 4.9 * tau * tau, caps[0][2] - 1.5 * tau);
        fireCap.rotation.set(tau * 9, 0, Math.PI / 2 + tau * 7);
      } else {
        fireCap.position.set(...caps[0]);
        fireCap.rotation.set(0, 0, Math.PI / 2);
      }
      const s = shuttleStroke(t);
      cradle.position.set(s * Math.cos(RAIL.pitch), s * Math.sin(RAIL.pitch), 0);
      // Flag ripple.
      for (let i = 0; i < flagPos.count; i++) {
        const x = flagBase[i * 3];
        const y = flagBase[i * 3 + 1];
        const amp = 0.06 + 0.14 * (x / 2.2);
        flagPos.setZ(i, amp * Math.sin(x * 3.2 - t * 9 + y * 0.6));
      }
      flagPos.needsUpdate = true;
    },
  };
}

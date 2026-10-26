import * as THREE from 'three';
import { Kit } from './models/kit.js';
import { mulberry32 } from './rng.js';
import { createVessel } from './harbourShips.js';
import {
  LAND, BREAKWATERS, MOLES, BOAT_ROWS, FACES, RAMP, LIGHTS, BUOYS, ROCKS, BERTH_LABELS, ENTRY_SIGNAL, LOCK_SIGNAL, TURN_CIRCLE, CABLE,
  px, toChart, inPoly, lightOn, mooredFor, compass,
} from './harbour.js';

// The port of Zabana in 3D, built from the outlines in harbour.js (drawn on the chart port-zabana.svg): the land as one heightfield
// (the quays at 2.6 m, the town of 14 500 on a low plain, Mont Breiz (62 m) to the west, the Plage de Kerlann, the rocky coast and,
// beyond the chart, green hills inland), the two breakwaters (deck, wave wall, rock armour outside), the piers, the oil jetty on
// piles, the lock with its mitre gates and swing bridge (they move with the sim), the bassin à flot, the marina's pontoons and
// boats, the fishing basin's boats, the warehouses, the industrial zone and the oil depot, the harbour office, the cranes of the
// Môle Commercial, the shipyard and its slipway, the roads, the lighthouses and the buoys (each light flashes its own character,
// the Cap de l'Ouest red over Les Corbeaux), the entrance and lock signals, the ships alongside, the berth numbers.
// Procedural geometry only, no textures from outside. `update(t, sim, camPos)` blinks the lights, bobs the buoys and moves the lock.

const smooth = (a, b, x) => { const k = Math.min(Math.max((x - a) / (b - a), 0), 1); return k * k * (3 - 2 * k); };
const QUAY = 2.6; // m: the quays and yards
const BW_DECK = 4.0; // m: the breakwaters' deck
const P = (X, Y) => px(X, Y);
const polyPx = (list) => { const pts = list.map(([X, Y]) => P(X, Y)); return { pts, box: box(pts) }; };
function box(pts) {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const p of pts) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); z0 = Math.min(z0, p.z); z1 = Math.max(z1, p.z); }
  return { x0, x1, z0, z1 };
}

// The port's yards (no houses there) and the town's built-up area, as the chart hatches it.
const PORT_ZONE = polyPx([[455, 214], [745, 214], [745, 140], [770, 140], [880, 140], [1060, 140], [1060, 372], [890, 330], [760, 384], [470, 384], [440, 350], [350, 345], [330, 258], [440, 250]]);
const BAF_ZONE = polyPx([[520, 56], [730, 56], [730, 214], [520, 214]]);
const TOWN = polyPx([[330, 120], [470, 110], [740, 110], [870, 195], [870, 318], [745, 362], [745, 236], [465, 236], [465, 362], [350, 330]]);
const inPort = (x, z) => inPoly(PORT_ZONE, x, z) || inPoly(BAF_ZONE, x, z);

// Smooth value noise (0 to 1), for the hills and the colours.
const hash = (ix, iz) => { let h = Math.imul(ix, 374761393) + Math.imul(iz, 668265263); h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };
function vnoise(x, z) {
  const ix = Math.floor(x), iz = Math.floor(z), fx = x - ix, fz = z - iz;
  const u = fx * fx * (3 - 2 * fx), v = fz * fz * (3 - 2 * fz);
  const a = hash(ix, iz), b = hash(ix + 1, iz), c = hash(ix, iz + 1), d = hash(ix + 1, iz + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
const fbm = (x, z) => 0.5 * vnoise(x, z) + 0.28 * vnoise(x * 2.1 + 5, z * 2.1 + 9) + 0.14 * vnoise(x * 4.3 + 1, z * 4.3 + 3) + 0.08 * vnoise(x * 8.7, z * 8.7);

// The nearest coast edge (not the hidden inland ones) and its kind.
function coastNear(poly, x, z) {
  const p = poly.pts;
  let best = Infinity, kind = 'q';
  for (let i = 0; i < p.length; i++) {
    if (poly.kinds[i] === 'x') continue;
    const a = p[i], b = p[(i + 1) % p.length];
    const ex = b.x - a.x, ez = b.z - a.z, l2 = ex * ex + ez * ez || 1;
    const t = Math.min(Math.max(((x - a.x) * ex + (z - a.z) * ez) / l2, 0), 1);
    const d = Math.hypot(x - a.x - ex * t, z - a.z - ez * t);
    if (d < best) { best = d; kind = poly.kinds[i]; }
  }
  return { d: best, kind };
}
// The land's height: the coast's own profile (a quay, rock armour rising to the yard, the beach, a low cliff), then a low plain under
// the town, Mont Breiz (62 m, its contour ellipses on the chart round 200,165), and outside the chart the hills of the hinterland.
function coastH(kind, d, deck = QUAY) {
  if (kind === 'q') return deck;
  if (kind === 'r') return Math.min(0.3 + 0.45 * d, deck);
  if (kind === 'b') return Math.min(0.35 + 0.03 * d, 4);
  return 0.6 + 0.45 * Math.min(d, 28); // a rocky coast, rising to a low cliff
}
function landHeight(x, z) {
  const { d, kind } = coastNear(LAND, x, z);
  let h = coastH(kind, d);
  if (inPort(x, z)) return h;
  const [X, Y] = toChart(x, z);
  h += Math.min(Math.max(0, d - 60) * 0.03, 9); // the plain rises gently from the shore
  const e = ((X - 200) / 120) ** 2 + ((Y - 165) / 70) ** 2;
  h += 62 * Math.exp(-e * 1.55); // Mont Breiz
  const r0 = Math.hypot(X - 560, Y - 200) * 3; // metres from the port
  h += 140 * smooth(2400, 6000, r0) * (0.4 + 0.6 * fbm(x / 1500, z / 1500));
  h += 8 * smooth(200, 700, d) * fbm(x / 240 + 3, z / 240);
  return h;
}

// --- A polygon as a refined triangle mesh ----------------------------------------------------------------------------
// Earcut the outline, then bisect every triangle's longest edge while it is longer than maxLen(x, z) (one split per edge, shared by
// both of its triangles, so the mesh stays watertight). Boundary vertices stay exactly on the outline and remember its edge.
function refine(poly, maxLen) {
  const V = poly.pts.map((p, i) => ({ x: p.x, z: p.z, edge: i }));
  const contour = poly.pts.map((p) => new THREE.Vector2(p.x, p.z));
  let tris = THREE.ShapeUtils.triangulateShape(contour, []).map((t) => [...t]);
  const n0 = V.length;
  const bEdge = new Map(); // boundary edge key -> outline edge
  const key = (a, b) => (a < b ? a * 1e6 + b : b * 1e6 + a);
  for (let i = 0; i < n0; i++) bEdge.set(key(i, (i + 1) % n0), i);
  const len = (a, b) => Math.hypot(V[b].x - V[a].x, V[b].z - V[a].z);
  const longest = (t) => { const l0 = len(t[0], t[1]), l1 = len(t[1], t[2]), l2 = len(t[2], t[0]); return l0 >= l1 && l0 >= l2 ? 0 : l1 >= l2 ? 1 : 2; };
  for (let pass = 0; pass < 40; pass++) {
    const marked = new Set();
    for (const t of tris) {
      const i = longest(t), a = t[i], b = t[(i + 1) % 3];
      if (len(a, b) > maxLen((V[a].x + V[b].x) / 2, (V[a].z + V[b].z) / 2)) marked.add(key(a, b));
    }
    if (!marked.size) break;
    for (let changed = true; changed;) {
      changed = false;
      for (const t of tris) {
        const i = longest(t), kl = key(t[i], t[(i + 1) % 3]);
        if (!marked.has(kl) && (marked.has(key(t[0], t[1])) || marked.has(key(t[1], t[2])) || marked.has(key(t[2], t[0])))) { marked.add(kl); changed = true; }
      }
    }
    const mids = new Map();
    const midOf = (a, b) => {
      const k = key(a, b);
      let i = mids.get(k);
      if (i !== undefined) return i;
      const e = bEdge.get(k);
      i = V.push({ x: (V[a].x + V[b].x) / 2, z: (V[a].z + V[b].z) / 2, edge: e ?? -1 }) - 1;
      if (e !== undefined) { bEdge.set(key(a, i), e); bEdge.set(key(i, b), e); }
      mids.set(k, i);
      return i;
    };
    const out = [];
    for (const t of tris) {
      const i = longest(t), a = t[i], b = t[(i + 1) % 3], c = t[(i + 2) % 3];
      if (!marked.has(key(a, b))) { out.push(t); continue; }
      const m = midOf(a, b);
      if (marked.has(key(b, c))) { const n = midOf(b, c); out.push([m, b, n], [m, n, c]); } else out.push([m, b, c]);
      if (marked.has(key(c, a))) { const n = midOf(c, a); out.push([a, m, n], [n, m, c]); } else out.push([a, m, c]);
    }
    tris = out;
  }
  return { V, tris };
}

function meshOf({ V, tris }, heightOf, colorOf) {
  const pos = new Float32Array(V.length * 3), col = new Float32Array(V.length * 3);
  const c = [0, 0, 0];
  for (let i = 0; i < V.length; i++) {
    const v = V[i];
    const h = heightOf(v);
    v.y = h;
    pos.set([v.x, h, v.z], i * 3);
    colorOf(v, c);
    col.set(c, i * 3);
  }
  const idx = [];
  for (const [a, b, cc] of tris) idx.push(a, b, cc);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}
// Earcut keeps the outline's winding; the mesh must face up.
function upFacing(g) {
  const p = g.attributes.position.array, ix = g.index.array;
  const a = new THREE.Vector3(p[ix[0] * 3], p[ix[0] * 3 + 1], p[ix[0] * 3 + 2]);
  const b = new THREE.Vector3(p[ix[1] * 3], p[ix[1] * 3 + 1], p[ix[1] * 3 + 2]);
  const c = new THREE.Vector3(p[ix[2] * 3], p[ix[2] * 3 + 1], p[ix[2] * 3 + 2]);
  const n = b.sub(a).cross(c.sub(a));
  if (n.y < 0) { for (let i = 0; i < ix.length; i += 3) { const t = ix[i + 1]; ix[i + 1] = ix[i + 2]; ix[i + 2] = t; } g.computeVertexNormals(); }
}

// --- The coast's faces: quay walls, and the slopes into the water ----------------------------------------------------------
function coastSkirt(poly, topOf) {
  const p = poly.pts, n = p.length;
  const outN = [];
  for (let i = 0; i < n; i++) {
    const a = p[i], b = p[(i + 1) % n];
    const l = Math.hypot(b.x - a.x, b.z - a.z) || 1;
    let nx = -(b.z - a.z) / l, nz = (b.x - a.x) / l;
    const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2;
    if (inPoly(poly, mx + nx * 0.5, mz + nz * 0.5)) { nx = -nx; nz = -nz; }
    outN.push([nx, nz]);
  }
  const pos = [], col = [];
  const SK = { q: [0, -6], r: [6, -5], c: [10, -9], b: [42, -2.6] };
  const COL = { q: [0.44, 0.43, 0.41], r: [0.45, 0.44, 0.42], c: [0.34, 0.33, 0.31], b: [0.66, 0.6, 0.48] };
  const STAIN = [0.15, 0.18, 0.15];
  for (let i = 0; i < n; i++) {
    const kind = poly.kinds[i];
    if (kind === 'x') continue;
    const a = p[i], b = p[(i + 1) % n];
    const [out, depth] = SK[kind];
    const ma = mitre(outN[(i - 1 + n) % n], outN[i]), mb = mitre(outN[i], outN[(i + 1) % n]);
    const ta = topOf(a, kind), tb = topOf(b, kind);
    const A0 = [a.x, ta, a.z], B0 = [b.x, tb, b.z];
    const Aw = [a.x + ma[0] * out * 0.05, 0.35, a.z + ma[1] * out * 0.05], Bw = [b.x + mb[0] * out * 0.05, 0.35, b.z + mb[1] * out * 0.05];
    const A1 = [a.x + ma[0] * out, depth, a.z + ma[1] * out], B1 = [b.x + mb[0] * out, depth, b.z + mb[1] * out];
    quad(pos, col, A0, B0, Bw, Aw, lin(COL[kind]), lin(COL[kind]));
    quad(pos, col, Aw, Bw, B1, A1, lin(STAIN), lin(STAIN));
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.computeVertexNormals();
  return { geo: g, outN };
}
const lin = (c) => { const k = new THREE.Color().setRGB(c[0], c[1], c[2], THREE.SRGBColorSpace); return [k.r, k.g, k.b]; };
function mitre(n0, n1) {
  let x = n0[0] + n1[0], z = n0[1] + n1[1];
  const l = Math.hypot(x, z);
  if (l < 0.3) return n1;
  x /= l; z /= l;
  const k = 1 / Math.max(0.5, x * n1[0] + z * n1[1]);
  return [x * k, z * k];
}
function quad(pos, col, a, b, c, d, ca, cb) {
  pos.push(...a, ...b, ...c, ...a, ...c, ...d);
  col.push(...ca, ...ca, ...cb, ...ca, ...cb, ...cb);
}

const std = (color, o = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.75, metalness: 0.1, ...o });
const boxAt = (k, m, w, h, d, x, y, z, ry = 0) => k.add(new THREE.BoxGeometry(w, h, d), m, { pos: [x, y + h / 2, z], rot: [0, ry, 0] });

// --- Lights, buoys and signs ---------------------------------------------------------------------------------------------------
// A light tower `h` metres to the lantern: white with bands in its colour (red, green, or the lighthouses' red top).
function lightTower(h, band, r = 1.6) {
  const k = new Kit();
  const white = std(0xf0f0ea), b = std(band), metal = std(0x3a3f44, { metalness: 0.6 });
  k.add(new THREE.CylinderGeometry(r * 0.75, r * 1.25, h, 16), white, { pos: [0, h / 2, 0] });
  for (const f of [0.3, 0.62]) k.add(new THREE.CylinderGeometry(r * 0.93, r * 1.0, h * 0.12, 16), b, { pos: [0, h * f, 0] });
  k.add(new THREE.CylinderGeometry(r * 1.2, r * 1.2, 0.3, 16), metal, { pos: [0, h + 0.15, 0] });
  k.add(new THREE.CylinderGeometry(r * 0.6, r * 0.6, 1.8, 12), std(0x223038, { metalness: 0.8, roughness: 0.15 }), { pos: [0, h + 1.2, 0] });
  k.add(new THREE.ConeGeometry(r * 0.75, 1.1, 12), b, { pos: [0, h + 2.65, 0] });
  return k.build({ name: 'light' });
}
function buoyModel(kind) {
  const k = new Kit();
  const red = std(0xc4271d), green = std(0x1d8a43), white = std(0xf2f2ee), dark = std(0x23272b), black = std(0x16181a), yellow = std(0xe8b81c);
  const body = { port: red, stbd: green, north: black, south: yellow, safe: red }[kind];
  k.add(new THREE.CylinderGeometry(1.4, 1.6, 1.4, 14), body, { pos: [0, 0.3, 0] });
  if (kind === 'safe') {
    for (let i = 0; i < 8; i++) k.add(new THREE.CylinderGeometry(0.55, 0.62, 3.6, 12, 1, false, (i * Math.PI) / 4, Math.PI / 4), i % 2 ? white : red, { pos: [0, 2.8, 0] });
    k.add(new THREE.SphereGeometry(0.55, 12, 8), red, { pos: [0, 5.3, 0] });
  } else if (kind === 'port') {
    k.add(new THREE.CylinderGeometry(0.75, 0.75, 2.6, 12), red, { pos: [0, 2.3, 0] });
    k.add(new THREE.BoxGeometry(0.9, 0.9, 0.9), red, { pos: [0, 4.4, 0] });
  } else if (kind === 'stbd') {
    k.add(new THREE.CylinderGeometry(0.3, 0.8, 2.6, 12), green, { pos: [0, 2.3, 0] });
    k.add(new THREE.ConeGeometry(0.6, 1.0, 12), green, { pos: [0, 4.3, 0] });
  } else { // the cardinals: black over yellow (north) or yellow over black (south), two cones pointing up or down
    const [top, bot] = kind === 'north' ? [black, yellow] : [yellow, black];
    k.add(new THREE.CylinderGeometry(0.7, 0.75, 1.3, 12), top, { pos: [0, 2.9, 0] });
    k.add(new THREE.CylinderGeometry(0.75, 0.8, 1.3, 12), bot, { pos: [0, 1.6, 0] });
    const up = kind === 'north';
    for (const y of [4.3, 5.3]) k.add(new THREE.ConeGeometry(0.5, 0.8, 12), black, { pos: [0, y, 0], rot: [up ? 0 : Math.PI, 0, 0] });
  }
  k.rod([0, 0.9, 0], [0, 5, 0], 0.06, dark);
  return k.build({ name: `buoy-${kind}` });
}
const glowTex = (() => {
  let t = null;
  return () => {
    if (t) return t;
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d');
    const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.25, 'rgba(255,255,255,0.6)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr;
    g.fillRect(0, 0, 64, 64);
    t = new THREE.CanvasTexture(c);
    return t;
  };
})();
function lamp(color, size = 6) {
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex(), color, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false, fog: false }));
  s.scale.setScalar(size);
  return s;
}
// A sign with text on it (the berth numbers), drawn into a canvas.
function sign(text, bg, fg = '#fff') {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = bg; g.fillRect(0, 0, 128, 128);
  g.strokeStyle = fg; g.lineWidth = 8; g.strokeRect(6, 6, 116, 116);
  g.fillStyle = fg; g.font = `bold ${text.length > 2 ? 54 : 80}px sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(text, 64, 70);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return new THREE.MeshBasicMaterial({ map: t, side: THREE.DoubleSide });
}
const COLORS = { white: 0xfff4d6, red: 0xff3b30, green: 0x3dff7a };

// --- Everything ------------------------------------------------------------------------------------------------------------
// `sim` gives the manoeuvre (which ships lie alongside, her berth and her outline for the ghost on the water).
export function createHarbour(scene, sim) {
  const group = new THREE.Group();
  group.name = 'harbour';
  scene.add(group);
  const rng = mulberry32(11);
  const ground = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 });
  const tmp = new THREE.Color();
  tmp.setSRGB = function (r, g, b) { return this.setRGB(r, g, b, THREE.SRGBColorSpace); };
  const DIM = 0.78;

  // The land: fine near the port, coarser out in the hills.
  const land = refine(LAND, (x, z) => { const r = Math.hypot(x - 250, z - 0); return r < 1800 ? 22 : Math.min(22 + (r - 1800) * 0.06, 420); });
  const landGeo = meshOf(land, (v) => (v.edge >= 0 ? coastH(LAND.kinds[v.edge], 0) : landHeight(v.x, v.z)), (v, c) => {
    const n = fbm(v.x / 60, v.z / 60);
    const near = coastNear(LAND, v.x, v.z);
    if (inPort(v.x, v.z)) tmp.setSRGB(0.52 + 0.07 * n, 0.52 + 0.06 * n, 0.5 + 0.05 * n); // concrete and asphalt
    else if (near.kind === 'b' && near.d < 70) tmp.setSRGB(0.84, 0.76, 0.58); // the sand of Kerlann
    else if (near.kind === 'c' && near.d < 26) tmp.setSRGB(0.4, 0.38, 0.34); // granite rocks
    else if (inPoly(TOWN, v.x, v.z)) tmp.setSRGB(0.5 + 0.06 * n, 0.5 + 0.05 * n, 0.46 + 0.05 * n); // the town's streets and gardens
    else { // the bocage: fields of different greens, darker woods on the hill
      const f = hash(Math.floor(v.x / 140), Math.floor(v.z / 110));
      const wood = smooth(28, 45, v.y);
      tmp.setSRGB(0.26 + 0.12 * f + 0.05 * n - 0.08 * wood, 0.38 + 0.1 * f + 0.05 * n - 0.06 * wood, 0.17 + 0.06 * f - 0.03 * wood);
    }
    c[0] = tmp.r * DIM; c[1] = tmp.g * DIM; c[2] = tmp.b * DIM;
  });
  upFacing(landGeo);
  const landMesh = new THREE.Mesh(landGeo, ground);
  landMesh.receiveShadow = true;
  landMesh.name = 'land';
  group.add(landMesh);

  // The breakwaters: deck, armour slope from the seaward side, wave wall.
  const skirtMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, side: THREE.DoubleSide });
  const bwSk = [];
  for (const B of BREAKWATERS) {
    const bw = refine(B, () => 12);
    const g = meshOf(bw, (v) => {
      if (v.edge >= 0) return B.kinds[v.edge] === 'r' ? 0.3 : BW_DECK;
      const { d, kind } = coastNear(B, v.x, v.z);
      return coastH(kind, d, BW_DECK);
    }, (v, c) => { const n = fbm(v.x / 30, v.z / 30); [c[0], c[1], c[2]] = lin([0.52 + 0.06 * n, 0.51 + 0.06 * n, 0.48 + 0.05 * n]); });
    upFacing(g);
    const m = new THREE.Mesh(g, ground);
    m.receiveShadow = true;
    group.add(m);
    const sk = coastSkirt(B, (p, kind) => (kind === 'r' ? 0.3 : BW_DECK));
    bwSk.push(sk);
    const sm = new THREE.Mesh(sk.geo, skirtMat); sm.receiveShadow = true; group.add(sm);
  }
  const landSk = coastSkirt(LAND, (p, kind) => coastH(kind, 0));
  { const m = new THREE.Mesh(landSk.geo, skirtMat); m.receiveShadow = true; group.add(m); }
  {
    const k = new Kit();
    const conc = std(0xa7a49b, { roughness: 0.95 });
    BREAKWATERS.forEach((B, bi) => {
      const p = B.pts, n = p.length;
      for (let i = 0; i < n; i++) {
        if (B.kinds[i] !== 'r') continue;
        const a = p[i], b = p[(i + 1) % n], [nx, nz] = bwSk[bi].outN[i];
        const inA = { x: a.x - nx * 8, z: a.z - nz * 8 }, inB = { x: b.x - nx * 8, z: b.z - nz * 8 };
        const len = Math.hypot(inB.x - inA.x, inB.z - inA.z);
        if (len < 4) continue;
        k.add(new THREE.BoxGeometry(len + 2.5, 2.6, 2.4), conc, { pos: [(inA.x + inB.x) / 2, BW_DECK + 1.3, (inA.z + inB.z) / 2], rot: [0, -Math.atan2(inB.z - inA.z, inB.x - inA.x), 0] });
      }
    });
    group.add(k.build({ name: 'wave-wall' }));
  }

  // The piers: solid quays from the sea bed up to the yard; the oil jetty is a deck on piles.
  {
    const k = new Kit();
    const conc = std(0x8e8b84, { roughness: 0.92 }), deck = std(0x77756f, { roughness: 0.95 }), pile = std(0x55524c);
    MOLES.forEach((M, i) => {
      if (i === 3) { // the oil jetty
        const s = new THREE.Shape(M.pts.map((p) => new THREE.Vector2(p.x, -p.z)));
        const g = new THREE.ExtrudeGeometry(s, { depth: 1.2, bevelEnabled: false });
        g.rotateX(-Math.PI / 2); g.translate(0, QUAY - 0.6, 0);
        k.add(g, deck);
        for (const p of M.pts) k.rod([p.x, -6, p.z], [p.x, QUAY - 0.5, p.z], 0.5, pile);
        return;
      }
      const s = new THREE.Shape(M.pts.map((p) => new THREE.Vector2(p.x, -p.z)));
      const g = new THREE.ExtrudeGeometry(s, { depth: QUAY + 6, bevelEnabled: false });
      g.rotateX(-Math.PI / 2); g.translate(0, -6, 0);
      k.add(g, conc);
    });
    // the Ro-Ro ramp (berth 8): a linkspan sloping down to the water at the pier head
    const r0 = P(653, 300), r1 = P(669, 313);
    k.add(new THREE.BoxGeometry(Math.abs(r1.x - r0.x), 0.5, Math.abs(r1.z - r0.z)), std(0x6f7a80, { metalness: 0.4 }), { pos: [(r0.x + r1.x) / 2, 1.4, (r0.z + r1.z) / 2], rot: [0, 0, -0.04] });
    // the shipyard's slipway into the fishing basin
    const s0 = P(361, 287), s1 = P(375, 309);
    k.add(new THREE.BoxGeometry(Math.abs(s1.x - s0.x), 0.4, Math.abs(s1.z - s0.z) + 10), std(0x6b5a3a), { pos: [(s0.x + s1.x) / 2, 0.6, (s0.z + s1.z) / 2 + 5], rot: [0.08, 0, 0] });
    group.add(k.build({ name: 'piers' }));
  }

  // Rock armour: blocks along every rock face, and the rocky shore near the port; Les Corbeaux, barely awash.
  {
    const rocks = [];
    const place = (poly, outN, deck, palette, size, rows, step, armour) => {
      const p = poly.pts, n = p.length;
      for (let i = 0; i < n; i++) {
        if (poly.kinds[i] !== (armour ? 'r' : 'c')) continue;
        const a = p[i], b = p[(i + 1) % n], [nx, nz] = outN[i];
        const len = Math.hypot(b.x - a.x, b.z - a.z);
        if (!armour && Math.hypot((a.x + b.x) / 2, (a.z + b.z) / 2) > 3000) continue;
        for (let s = 0; s < len; s += step) {
          for (let r = 0; r < rows; r++) {
            const off = (r / (rows - 1 || 1)) * (armour ? 10 : 9) - 3 + rng() * 1.5;
            const f = (s + rng() * step) / len;
            const x = a.x + (b.x - a.x) * f - nx * off, z = a.z + (b.z - a.z) * f - nz * off;
            const y = off < 0 ? off * 0.9 : Math.min(0.3 + 0.45 * off, deck) - 0.4;
            rocks.push({ x, y, z, s: size * (0.7 + rng() * 0.6), c: palette[Math.floor(rng() * palette.length)] });
          }
        }
      }
    };
    const armour = [[0.72, 0.71, 0.67], [0.66, 0.65, 0.61], [0.78, 0.77, 0.73], [0.6, 0.59, 0.56]];
    const granite = [[0.46, 0.44, 0.41], [0.38, 0.37, 0.35], [0.52, 0.5, 0.46]];
    BREAKWATERS.forEach((B, i) => place(B, bwSk[i].outN, BW_DECK, armour, 2.3, 4, 2.6, true));
    place(LAND, landSk.outN, QUAY, armour, 2.0, 3, 2.8, true);
    place(LAND, landSk.outN, 14, granite, 2.8, 3, 5, false);
    for (const R of ROCKS) for (let i = 0; i < 24; i++) {
      const a = rng() * Math.PI * 2, d = Math.sqrt(rng()) * R.r;
      rocks.push({ x: R.x + Math.cos(a) * d, y: 0.6 * (1 - d / R.r) - 1.4 + rng() * 0.8, z: R.z + Math.sin(a) * d, s: 2 + rng() * 2.5, c: granite[i % 3] });
    }
    const mesh = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 0), std(0xffffff, { roughness: 0.95, flatShading: true }), rocks.length);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), sc = new THREE.Vector3();
    rocks.forEach((r, i) => {
      q.setFromEuler(e.set(rng() * 3, rng() * 3, rng() * 3));
      m.compose(new THREE.Vector3(r.x, r.y, r.z), q, sc.set(r.s * (0.8 + rng() * 0.4), r.s * (0.6 + rng() * 0.3), r.s * (0.8 + rng() * 0.4)));
      mesh.setMatrixAt(i, m);
      mesh.setColorAt(i, tmp.setSRGB(...r.c));
    });
    mesh.receiveShadow = true;
    group.add(mesh);
  }

  // The roads of the chart (the coast road, the quay road, the D 786, the roads to the station and the industrial zone).
  {
    const roads = [
      'M60,298 C150,290 250,262 340,250 L455,222', 'M455,222 L745,222', 'M505,222 L505,60', 'M330,250 L330,125', 'M745,222 L745,60', 'M745,222 L880,222 L888,318', 'M880,222 L1060,190',
    ];
    const pos = [], col = [], c0 = lin([0.2, 0.21, 0.22]);
    for (const d of roads) {
      const tok = d.match(/[MLC]|-?\d+(\.\d+)?/g); // sample the path at 4 px
      const pts = [];
      let cur = null, i = 0, cmd = 'M';
      const num = () => Number(tok[i++]);
      while (i < tok.length) {
        if (/[MLC]/.test(tok[i])) cmd = tok[i++];
        if (cmd === 'C') {
          const b = [num(), num()], c = [num(), num()], e = [num(), num()];
          for (let s = 1; s <= 12; s++) { const t = s / 12, u = 1 - t; pts.push([u * u * u * cur[0] + 3 * u * u * t * b[0] + 3 * u * t * t * c[0] + t * t * t * e[0], u * u * u * cur[1] + 3 * u * u * t * b[1] + 3 * u * t * t * c[1] + t * t * t * e[1]]); }
          cur = e;
        } else {
          const e = [num(), num()];
          if (cur && cmd === 'L') { const n = Math.ceil(Math.hypot(e[0] - cur[0], e[1] - cur[1]) / 4); for (let s = 1; s <= n; s++) pts.push([cur[0] + ((e[0] - cur[0]) * s) / n, cur[1] + ((e[1] - cur[1]) * s) / n]); } else pts.push(e);
          cur = e;
        }
      }
      for (let j = 1; j < pts.length; j++) {
        const a = P(...pts[j - 1]), b = P(...pts[j]);
        const l = Math.hypot(b.x - a.x, b.z - a.z) || 1, nx = -(b.z - a.z) / l * 4, nz = (b.x - a.x) / l * 4;
        const ya = landHeight(a.x, a.z) + 0.25, yb = landHeight(b.x, b.z) + 0.25;
        quad(pos, col, [a.x + nx, ya, a.z + nz], [b.x + nx, yb, b.z + nz], [b.x - nx, yb, b.z - nz], [a.x - nx, ya, a.z - nz], c0, c0);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.computeVertexNormals();
    const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2 }));
    m.receiveShadow = true;
    group.add(m);
  }

  // The port's buildings: warehouses, the industrial zone, the oil depot and its pipeline, the harbour office, the fish market, the
  // ferry terminal, the cranes of the Môle Commercial, the shipyard, the station.
  {
    const k = new Kit();
    const wall = std(0xd6d2c6), wall2 = std(0xbab4a8), roof = std(0x5a6168, { roughness: 0.6, metalness: 0.3 }), glass = std(0x24323c, { metalness: 0.6, roughness: 0.3 });
    const white = std(0xeeeeea), yellow = std(0xd9a72a, { metalness: 0.3 }), tankC = std(0xe6e6e0, { roughness: 0.5, metalness: 0.3 });
    const bld = (x0, y0, x1, y1, h, walls = wall, r = roof) => {
      const a = P(x0, y0), b = P(x1, y1), cx = (a.x + b.x) / 2, cz = (a.z + b.z) / 2, w = Math.abs(b.x - a.x), d = Math.abs(b.z - a.z);
      const y = landHeight(cx, cz);
      k.add(new THREE.BoxGeometry(w, h, d), walls, { pos: [cx, y + h / 2, cz] });
      k.add(new THREE.BoxGeometry(w + 0.6, 0.6, d + 0.6), r, { pos: [cx, y + h + 0.3, cz] });
      k.add(new THREE.BoxGeometry(w + 0.1, 1.0, d + 0.1), glass, { pos: [cx, y + h * 0.6, cz] });
    };
    bld(612, 64, 642, 79, 11); bld(648, 64, 684, 79, 12); bld(690, 64, 720, 79, 11); // Entrepôts
    bld(770, 150, 810, 172, 13, wall2); bld(820, 150, 870, 172, 14); bld(770, 180, 798, 206, 10); bld(808, 180, 846, 198, 10, wall2); bld(850, 178, 872, 196, 9); // zone industrielle
    bld(523, 238, 539, 250, 7, white); // la criée (pier 1-2)
    bld(588, 236, 602, 246, 8); // the Môle Commercial's office
    bld(653, 236, 669, 244, 9, white); // the ferry terminal
    bld(334, 268, 356, 294, 14, wall2); // the shipyard's shed
    bld(326, 114, 344, 128, 8, std(0xd8cbb0)); // la gare
    { // the harbour office (capitainerie) and its control tower
      const c = P(488, 213), y = landHeight(c.x, c.z);
      k.add(new THREE.BoxGeometry(42, 10, 48), white, { pos: [c.x, y + 5, c.z] });
      k.add(new THREE.CylinderGeometry(4, 4.5, 22, 12), white, { pos: [c.x - 10, y + 11, c.z + 12] });
      k.add(new THREE.CylinderGeometry(6, 5, 4, 12), glass, { pos: [c.x - 10, y + 24, c.z + 12] });
      k.add(new THREE.CylinderGeometry(6.4, 6.4, 0.6, 12), std(0x2a5d8a), { pos: [c.x - 10, y + 26.3, c.z + 12] });
    }
    // the oil depot: four tanks and the pipeline to the oil jetty
    for (const [X, Y] of [[905, 232], [935, 232], [905, 262], [935, 262]]) {
      const c = P(X, Y), y = landHeight(c.x, c.z);
      k.add(new THREE.CylinderGeometry(31, 31, 16, 32), tankC, { pos: [c.x, y + 8, c.z] });
      k.add(new THREE.CylinderGeometry(31.5, 31.5, 0.6, 32), std(0x9aa0a4, { metalness: 0.5 }), { pos: [c.x, y + 16.2, c.z] });
      k.add(new THREE.CylinderGeometry(34, 34, 1.4, 32, 1, true), std(0x8e8b84), { pos: [c.x, y + 0.7, c.z] }); // the bund
    }
    const pipe = [[895, 244], [760, 238], [740, 258], [713, 258]].map(([X, Y]) => P(X, Y));
    for (let i = 1; i < pipe.length; i++) k.rod([pipe[i - 1].x, QUAY + 1.2, pipe[i - 1].z], [pipe[i].x, QUAY + 1.2, pipe[i].z], 0.45, std(0x8a8f94, { metalness: 0.5 }));
    // the cranes of the Môle Commercial (berths 3-5): portal cranes on the east face, jibs over the Bassin
    for (const Y of [270, 300, 328]) {
      const c = P(604, Y), y = QUAY;
      for (const dx of [-4, 4]) for (const dz of [-4, 4]) k.rod([c.x + dx, y, c.z + dz], [c.x + dx * 0.5, y + 14, c.z + dz * 0.5], 0.35, yellow);
      boxAt(k, yellow, 5, 5, 5, c.x, y + 14, c.z);
      boxAt(k, std(0x2a2c2e), 3.4, 3, 3.4, c.x, y + 19, c.z + 1.5);
      k.rod([c.x, y + 20, c.z], [c.x - 2, y + 36, c.z + 22], 0.45, yellow);
      k.rod([c.x, y + 22, c.z], [c.x, y + 30, c.z - 6], 0.3, yellow);
    }
    group.add(k.build({ name: 'port-buildings' }));
  }

  // The town: houses on a street grid, white walls and grey slate roofs, granite here and there; the church spire.
  {
    const spots = [];
    const ang = (6 * Math.PI) / 180, ca = Math.cos(ang), sa = Math.sin(ang);
    const STEP = 24;
    for (let i = -70; i <= 70; i++) {
      for (let j = -70; j <= 70; j++) {
        if (i % 5 === 0 || j % 4 === 0) continue; // the streets
        const gx = i * STEP, gz = j * STEP;
        const x = gx * ca - gz * sa + 560 + (rng() - 0.5) * 5, z = gx * sa + gz * ca - 200 + (rng() - 0.5) * 5;
        if (!inPoly(TOWN, x, z) || inPort(x, z) || !inPoly(LAND, x, z)) continue;
        const near = coastNear(LAND, x, z);
        if (near.d < 22) continue;
        if (rng() > 0.85) continue;
        spots.push({ x, z, y: landHeight(x, z) });
      }
    }
    // farms and hamlets out in the bocage
    for (let i = 0; i < 260; i++) {
      const x = 400 + (rng() - 0.5) * 3600, z = -400 + (rng() - 0.5) * 5000;
      if (!inPoly(LAND, x, z) || inPort(x, z) || inPoly(TOWN, x, z) || coastNear(LAND, x, z).d < 60) continue;
      spots.push({ x, z, y: landHeight(x, z), farm: true });
    }
    const walls = ['#f2efe6', '#ece6d6', '#e6e0d2', '#f6f4ee', '#b9b3a6', '#a9a397', '#ded6c4'];
    const slates = ['#4a5058', '#3f454d', '#555c64', '#5b5550'];
    const n = spots.length;
    const bodies = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0), std(0xffffff, { roughness: 0.85 }), n);
    const roofG = new THREE.CylinderGeometry(0.62, 0.62, 1, 3, 1).rotateZ(Math.PI / 2).rotateY(Math.PI / 2).translate(0, 0.25, 0);
    const roofs = new THREE.InstancedMesh(roofG, std(0xffffff, { roughness: 0.7 }), n);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3();
    spots.forEach((sp, i) => {
      const w = 8 + rng() * 6, d = 10 + rng() * 10, floors = sp.farm ? 1 + Math.floor(rng() * 2) : 2 + Math.floor(rng() * 2);
      const h = floors * 3;
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), -ang + (sp.farm ? rng() * 3 : 0));
      m.compose(new THREE.Vector3(sp.x, sp.y - 1, sp.z), q, s.set(w, h + 1, d));
      bodies.setMatrixAt(i, m);
      bodies.setColorAt(i, tmp.set(walls[Math.floor(rng() * walls.length)]));
      m.compose(new THREE.Vector3(sp.x, sp.y + h, sp.z), q, s.set(w * 1.08, w * 0.42, d * 1.04));
      roofs.setMatrixAt(i, m);
      roofs.setColorAt(i, tmp.set(slates[Math.floor(rng() * slates.length)]));
    });
    bodies.castShadow = roofs.castShadow = true;
    bodies.receiveShadow = roofs.receiveShadow = true;
    group.add(bodies, roofs);
    const k = new Kit();
    const granite = std(0x9a958c), slate = std(0x3f454d);
    const c = P(420, 175), h0 = landHeight(c.x, c.z);
    k.add(new THREE.BoxGeometry(40, 14, 16), granite, { pos: [c.x, h0 + 7, c.z] });
    k.add(new THREE.BoxGeometry(8, 24, 8), granite, { pos: [c.x + 22, h0 + 12, c.z] });
    k.add(new THREE.ConeGeometry(5.5, 18, 4), slate, { pos: [c.x + 22, h0 + 33, c.z], rot: [0, Math.PI / 4, 0] });
    group.add(k.build({ name: 'church' }));
  }

  // Trees: woods on Mont Breiz, hedgerow trees across the bocage.
  {
    const pts = [];
    for (let i = 0; i < 12000 && pts.length < 3800; i++) {
      const x = 300 + (rng() - 0.5) * 5000, z = -300 + (rng() - 0.5) * 6000;
      if (!inPoly(LAND, x, z) || inPort(x, z) || inPoly(TOWN, x, z)) continue;
      const near = coastNear(LAND, x, z);
      if (near.d < 30) continue;
      const h = landHeight(x, z);
      const [X, Y] = toChart(x, z);
      const hill = Math.exp(-(((X - 200) / 120) ** 2 + ((Y - 165) / 70) ** 2) * 1.2);
      const hedge = Math.abs(((x / 140) % 1 + 1) % 1 - 0.5) < 0.05 || Math.abs(((z / 110) % 1 + 1) % 1 - 0.5) < 0.05 ? 0.8 : 0.06;
      if (rng() > Math.max(hill * 0.9, hedge)) continue;
      pts.push({ x, z, y: h, s: 4 + rng() * 4 });
    }
    const im = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 0).translate(0, 0.8, 0), std(0xffffff, { roughness: 0.95, flatShading: true }), pts.length);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3();
    pts.forEach((p, i) => {
      m.compose(new THREE.Vector3(p.x, p.y - 0.5, p.z), q, s.set(p.s, p.s * 1.2, p.s));
      im.setMatrixAt(i, m);
      im.setColorAt(i, tmp.setSRGB(0.13 + rng() * 0.07, 0.25 + rng() * 0.1, 0.11 + rng() * 0.04));
    });
    im.castShadow = true;
    group.add(im);
  }

  // Bollards along the faces where ships lie, the berth numbers on boards.
  {
    const bol = [];
    for (const f of Object.values(FACES)) for (let s = 6; s < f.len - 4; s += 16) bol.push({ x: f.a.x + f.dir.x * s - f.n.x * 1.2, z: f.a.z + f.dir.z * s - f.n.z * 1.2 });
    const bm = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.32, 0.4, 0.9, 8).translate(0, 0.45, 0), std(0x2a2c2e, { metalness: 0.5 }), bol.length);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), one = new THREE.Vector3(1, 1, 1);
    bol.forEach((b, i) => { m.compose(new THREE.Vector3(b.x, QUAY, b.z), q, one); bm.setMatrixAt(i, m); });
    group.add(bm);
    for (const L of BERTH_LABELS) {
      const y = landHeight(L.x, L.z);
      const board = new THREE.Mesh(new THREE.PlaneGeometry(4, 4), sign(L.no, '#1d3a5c'));
      board.position.set(L.x, Math.max(y, QUAY) + 5, L.z);
      board.rotation.y = Math.PI / 2;
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.35, 5, 0.35), std(0x1d3a5c));
      post.position.set(L.x, Math.max(y, QUAY) + 2.5, L.z);
      group.add(board, post);
    }
  }

  // The ghost of her berth on the water (shown during the berthing), and the turning circle (during an évitage).
  let ghost = null;
  if (sim.target) {
    const T = sim.target, c = Math.cos(T.psi), s = Math.sin(T.psi);
    ghost = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(sim.ship.outline.map(([a, b]) => new THREE.Vector3(T.x + a * c - b * s, 0.25, T.z + a * s + b * c))),
      new THREE.LineDashedMaterial({ color: 0x3ddc84, dashSize: 4, gapSize: 3, toneMapped: false, transparent: true, opacity: 0.9 }));
    ghost.computeLineDistances();
    group.add(ghost);
  }
  const circle = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(Array.from({ length: 96 }, (_, i) => new THREE.Vector3(TURN_CIRCLE.x + Math.cos((i / 96) * Math.PI * 2) * TURN_CIRCLE.r, 0.25, TURN_CIRCLE.z + Math.sin((i / 96) * Math.PI * 2) * TURN_CIRCLE.r))),
    new THREE.LineDashedMaterial({ color: 0xd04aa0, dashSize: 8, gapSize: 6, toneMapped: false, transparent: true, opacity: 0.8 }));
  circle.computeLineDistances();
  circle.visible = false;
  group.add(circle);

  // The ships alongside.
  const vessels = [];
  for (const v of sim.moored ?? mooredFor('A')) {
    const obj = createVessel(v.type, { L: v.len, B: v.beam });
    obj.position.set(v.x, 0, v.z);
    obj.rotation.y = -v.psi;
    group.add(obj);
    vessels.push({ obj, ph: rng() * 6 });
  }

  // The fishing basin's boats on their pontoons, and the marina's (≈ 80 berths).
  {
    const boats = [];
    for (const R of BOAT_ROWS) { // bow-on to the north and south quays
      const b = R.box, south = R.name.includes('Sud');
      for (let z = b.z0 + 4; z < b.z1 - 3; z += 6.5) boats.push({ x: south ? b.x0 + 9 : b.x1 - 9, z, psi: south ? 0 : Math.PI, len: 13 + rng() * 6, fish: true });
    }
    const k = new Kit();
    const deck = std(0x6b5b45);
    const pont = [[[774, 262], [774, 316]], [[774, 266], [836, 266]], [[774, 312], [836, 312]], [[790, 270], [790, 308]], [[812, 270], [812, 308]]];
    for (const [a0, b0] of pont) {
      const a = P(...a0), b = P(...b0), L = Math.hypot(b.x - a.x, b.z - a.z);
      k.add(new THREE.BoxGeometry(L, 0.5, 2.2), deck, { pos: [(a.x + b.x) / 2, 0.35, (a.z + b.z) / 2], rot: [0, -Math.atan2(b.z - a.z, b.x - a.x), 0] });
      if (a0[0] === b0[0] && a0[0] !== 774) continue;
      const n = Math.floor(L / 4.5);
      for (let i = 0; i < n; i++) {
        if (rng() < 0.15) continue;
        const f = (i + 0.5) / n, x = a.x + (b.x - a.x) * f, z = a.z + (b.z - a.z) * f;
        for (const sd of [-1, 1]) if (rng() < 0.8) boats.push({ x: x + (a0[1] === b0[1] ? sd * 7 : 0), z: z + (a0[0] === b0[0] ? sd * 7 : 0), psi: a0[1] === b0[1] ? (sd > 0 ? 0 : Math.PI) : (sd > 0 ? Math.PI / 2 : -Math.PI / 2), len: 8 + rng() * 5 });
      }
    }
    group.add(k.build({ name: 'pontoons' }));
    const hullG = new THREE.CylinderGeometry(0.17, 0.12, 1, 6, 1).rotateZ(Math.PI / 2).scale(1, 0.55, 1);
    const hulls = new THREE.InstancedMesh(hullG, std(0xffffff, { roughness: 0.55 }), boats.length);
    const masts = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.008, 0.008, 1.3, 4).translate(0, 0.7, 0), std(0xc8ccd0, { metalness: 0.6 }), boats.length);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3();
    const hc = ['#f4f4f0', '#2d6db5', '#f4f4f0', '#c94b30', '#f4f4f0', '#2f9e8a', '#1d3a5c'];
    let nm = 0;
    boats.forEach((b, i) => {
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), -b.psi);
      m.compose(new THREE.Vector3(b.x, 0.3, b.z), q, s.set(b.len, b.len, b.len));
      hulls.setMatrixAt(i, m);
      hulls.setColorAt(i, tmp.set(b.fish ? hc[1 + Math.floor(rng() * 3)] : hc[Math.floor(rng() * hc.length)]));
      if (!b.fish) { masts.setMatrixAt(nm++, m); }
    });
    masts.count = nm;
    hulls.castShadow = true;
    group.add(hulls, masts);
  }

  // The lock: two pairs of mitre gates (they swing into the walls as they open) and the swing bridge over the sea end.
  const lockParts = {};
  {
    const wood = std(0x4a3a2a), steel = std(0x5d666c, { metalness: 0.5 });
    const leaves = (Y) => [-1, 1].map((sd) => {
      const pivot = new THREE.Group();
      const hinge = P(sd < 0 ? 568 : 582, Y);
      pivot.position.set(hinge.x, 0, hinge.z);
      const leaf = new THREE.Mesh(new THREE.BoxGeometry(1.4, 8, 22.5), wood);
      leaf.position.set(0, QUAY - 3.5, -sd * 11.2);
      pivot.add(leaf);
      group.add(pivot);
      return { pivot, sd };
    });
    lockParts.south = leaves(232);
    lockParts.north = leaves(172);
    const pv = P(588, 222);
    const bridge = new THREE.Group();
    bridge.position.set(pv.x, 0, pv.z);
    const deck = new THREE.Mesh(new THREE.BoxGeometry(7, 1.0, 64), steel);
    deck.position.set(0, QUAY + 0.9, -26);
    const rail = new THREE.Mesh(new THREE.BoxGeometry(0.2, 1.1, 64), std(0xc23b2b));
    rail.position.set(3.4, QUAY + 1.9, -26);
    bridge.add(deck, rail);
    group.add(bridge);
    lockParts.bridge = bridge;
  }

  // The lights (their towers and lanterns), the buoys, the entrance signals (feux de passe) and the lock's signal.
  const lamps = [];
  for (const L of LIGHTS) {
    const h = L.height;
    const onLand = h > 12;
    const y0 = onLand ? landHeight(L.x, L.z) : BW_DECK;
    const band = L.color === 'red' ? 0xc02a22 : L.color === 'green' ? 0x1f8a4a : L.id.startsWith('align') ? 0xe0782a : 0xc02a22;
    const th = onLand ? Math.max(6, h - y0) : h; // the chart gives the light's height above the sea
    const t = lightTower(th, band, h > 30 ? 3 : h > 12 ? 2 : 1.6);
    t.position.set(L.x, y0, L.z);
    group.add(t);
    const s = lamp(COLORS[L.color], h > 30 ? 16 : 9);
    s.position.set(L.x, y0 + th + 1.2, L.z);
    group.add(s);
    lamps.push({ s, char: L.char, L });
  }
  const buoys = BUOYS.map((b, i) => {
    const g = buoyModel(b.kind);
    g.position.set(b.x, 0, b.z);
    group.add(g);
    const s = lamp(b.kind === 'stbd' ? COLORS.green : b.kind === 'port' ? COLORS.red : COLORS.white, 5);
    s.position.set(0, 6, 0);
    g.add(s);
    lamps.push({ s, char: b.char });
    return { g, ph: i * 1.3 };
  });
  const signal = (at, deck) => { // a mast with a red and a green lamp, one lit at a time
    const k = new Kit();
    k.rod([0, 0, 0], [0, 9, 0], 0.25, std(0x2a2c2e));
    boxAt(k, std(0x1a1c1e), 1.4, 3.4, 1.4, 0, 7, 0);
    const g = k.build({ name: 'signal' });
    g.position.set(at.x, deck, at.z);
    group.add(g);
    const red = lamp(COLORS.red, 5), green = lamp(COLORS.green, 5);
    red.position.set(at.x, deck + 9.6, at.z); green.position.set(at.x, deck + 7.8, at.z);
    group.add(red, green);
    return { red, green };
  };
  const entrySig = signal(ENTRY_SIGNAL, BW_DECK);
  const lockSig = signal(LOCK_SIGNAL, QUAY);
  // a yellow board where the submarine cable comes ashore (no anchoring)
  {
    const c = CABLE[0], y = landHeight(c.x, c.z);
    const b = new THREE.Mesh(new THREE.PlaneGeometry(3, 3), sign('⚓✕', '#e8b81c', '#1a1a1a'));
    b.position.set(c.x, y + 4, c.z); b.rotation.set(0, Math.PI / 2, Math.PI / 4);
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.3, 4, 0.3), std(0x2a2c2e)); post.position.set(c.x, y + 2, c.z);
    group.add(b, post);
  }

  const capOuest = lamps.find((l) => l.L?.id === 'capOuest');
  return {
    group,
    ghost,
    landHeight,
    // t: seconds of game time (the lights' rhythms run on it); sim: the lock's gates and the signals; camPos: the Cap de l'Ouest's sector
    update(t, sim, camPos) {
      for (const l of lamps) l.s.visible = lightOn(l.char, t + (l.L ? 0 : 0.37 * lamps.indexOf(l)));
      if (capOuest && camPos) { // red over Les Corbeaux (bearing from the light 200° to 240°), white elsewhere
        const b = compass(Math.atan2(camPos.z - capOuest.L.z, camPos.x - capOuest.L.x));
        capOuest.s.material.color.setHex(b > capOuest.L.red[0] && b < capOuest.L.red[1] ? COLORS.red : COLORS.white);
      }
      for (const b of buoys) {
        b.g.position.y = 0.18 * Math.sin(t * 1.1 + b.ph);
        b.g.rotation.x = 0.05 * Math.sin(t * 0.9 + b.ph);
        b.g.rotation.z = 0.05 * Math.cos(t * 0.8 + b.ph);
      }
      for (const v of vessels) v.obj.position.y = 0.06 * Math.sin(t * 0.5 + v.ph);
      if (sim && sim.lock) {
        for (const [key, open] of [['south', sim.lock.south], ['north', sim.lock.north]]) for (const L of lockParts[key]) L.pivot.rotation.y = L.sd * (key === 'south' ? 1 : -1) * open * 1.3;
        lockParts.bridge.rotation.y = -sim.lock.bridge * Math.PI / 2;
      }
      if (sim && sim.route) {
        const red = sim.entryLight === 'red';
        entrySig.red.visible = red; entrySig.green.visible = !red;
        const lr = sim.lockLight === 'red';
        lockSig.red.visible = lr; lockSig.green.visible = !lr;
        if (ghost) ghost.visible = sim.stage === 'berth';
        circle.visible = sim.stage === 'evitage';
      } else {
        entrySig.red.visible = lockSig.red.visible = true; entrySig.green.visible = lockSig.green.visible = false;
        if (ghost) ghost.visible = false;
      }
    },
  };
}

void RAMP;

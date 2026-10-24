import * as THREE from 'three';
import { Kit } from './models/kit.js';
import { createShip } from './models/ship.js';
import { mulberry32 } from './rng.js';
import { LAND, BREAKWATER, ROCKS, MOORED, FACES, TARGET_BERTH, BUOYS, LIGHTS, px, inPoly, HALF_LENGTH, HULL_OUTLINE } from './harbour.js';

// The port of Jijel in 3D, built from the outlines in harbour.js (which were traced on the Google Earth images): the land as one
// heightfield (its quays at 2.6 m, the town on a plain that rises to green hills inland, the beach, the rocky headland), the north
// breakwater's deck and wave wall, vertical quay walls, rock armour on the seaward faces, the port's sheds (blue roofs, as in the
// images), the town as instanced houses and flats with flat and tiled roofs, two minarets, trees on the hills, the pier-head lights,
// the buoys, the ships and submarines alongside, the fishing boats, the bollards and fenders, and berth 7's green marks (the
// people and her mooring lines are harbourCrew.js's).
// Procedural geometry only, no textures from outside. `update(t)` blinks the lights and bobs the buoys.

const smooth = (a, b, x) => { const k = Math.min(Math.max((x - a) / (b - a), 0), 1); return k * k * (3 - 2 * k); };
const QUAY = 2.6; // m: the quays and yards
const BW_DECK = 3.4; // m: the north breakwater's deck

// The port's yards (no houses there): the land between the coast road and the water, read off the images.
const PORT_ZONE = [[150, 15], [560, 60], [560, 160], [391, 240], [142, 330], [185, 440], [270, 404], [575, 350], [640, 405], [620, 700], [545, 760], [330, 790], [320, 1235], [290, 1235], [35, 800], [35, 200], [140, 170]]
  .map(([x, y]) => px(x, y));
const portZone = { pts: PORT_ZONE, box: box(PORT_ZONE) };
function box(pts) {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const p of pts) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); z0 = Math.min(z0, p.z); z1 = Math.max(z1, p.z); }
  return { x0, x1, z0, z1 };
}

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
// The land's height: the coast's own profile (a quay, rock armour rising to the yard, the beach, a low cliff), then, outside the
// port's yards, a slow rise across the town and the hills inland, 2 to 5 km out.
function coastH(kind, d, deck = QUAY) {
  if (kind === 'q') return deck;
  if (kind === 'r') return Math.min(0.3 + 0.45 * d, deck);
  if (kind === 'b') return Math.min(0.35 + 0.035 * d, QUAY);
  return 0.6 + 0.5 * Math.min(d, 26); // a rocky coast, rising to a low cliff
}
function landHeight(x, z) {
  const { d, kind } = coastNear(LAND, x, z);
  let h = coastH(kind, d);
  if (inPoly(portZone, x, z)) return h;
  const r0 = Math.hypot(x + 150, z + 500); // from the town's middle
  h += Math.max(0, d - 90) * 0.022;
  h += 380 * smooth(1300, 4800, r0) * (0.45 + 0.55 * fbm(x / 1100, z / 1100));
  h += 1000 * smooth(5500, 11000, r0) * (0.35 + 0.65 * fbm(x / 2600 + 11, z / 2600 + 4)); // the mountains of the Petite Kabylie behind
  h += 18 * smooth(300, 900, d) * fbm(x / 260 + 3, z / 260);
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
    // mark each triangle's longest edge where it is too long; then, so no triangle is left with a split edge that is not its
    // longest, mark the longest edge of every triangle that has any marked edge (longest-edge bisection keeps them well shaped)
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

function meshOf({ V, tris }, heightOf, colorOf, flip) {
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
  for (const [a, b, cc] of tris) flip ? idx.push(a, cc, b) : idx.push(a, b, cc);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}
// Earcut keeps the outline's winding; the mesh must face up.
function upFacing(g) { // flip the winding if the first triangle faces down
  const p = g.attributes.position.array, ix = g.index.array;
  const a = new THREE.Vector3(p[ix[0] * 3], p[ix[0] * 3 + 1], p[ix[0] * 3 + 2]);
  const b = new THREE.Vector3(p[ix[1] * 3], p[ix[1] * 3 + 1], p[ix[1] * 3 + 2]);
  const c = new THREE.Vector3(p[ix[2] * 3], p[ix[2] * 3 + 1], p[ix[2] * 3 + 2]);
  const n = b.sub(a).cross(c.sub(a));
  if (n.y < 0) { for (let i = 0; i < ix.length; i += 3) { const t = ix[i + 1]; ix[i + 1] = ix[i + 2]; ix[i + 2] = t; } g.computeVertexNormals(); }
}

// --- The coast's faces: quay walls, and the slopes into the water ----------------------------------------------------------
// Each outline edge gets a face from its top down below the sea: a vertical wall for a quay, a slope out and down for the rest
// (steep for rock armour and the cliffs, long and shallow for the beach). The outward direction is mitred at each vertex.
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
  const COL = { q: [0.42, 0.41, 0.38], r: [0.42, 0.4, 0.37], c: [0.34, 0.3, 0.25], b: [0.62, 0.55, 0.43] };
  const STAIN = [0.16, 0.19, 0.15];
  for (let i = 0; i < n; i++) {
    const kind = poly.kinds[i];
    if (kind === 'x') continue;
    const a = p[i], b = p[(i + 1) % n];
    const [out, depth] = SK[kind];
    // the mitred outward direction at each end
    const ma = mitre(outN[(i - 1 + n) % n], outN[i]), mb = mitre(outN[i], outN[(i + 1) % n]);
    const ta = topOf(a, kind), tb = topOf(b, kind);
    const A0 = [a.x, ta, a.z], B0 = [b.x, tb, b.z];
    // a quay wall has a dark weed line just above the water; the slopes go in two steps (the tide line, then down)
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

// --- Small craft and the ships alongside ------------------------------------------------------------------------------------
const std = (color, o = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.75, metalness: 0.1, ...o });
// A hull seen from above (bow +x), extruded up `h` and laid so y is up: a straight side and a pointed bow over the last `bow` of it.
function hullGeo(len, beam, h, bow = 0.25, y0 = 0) {
  const s = new THREE.Shape();
  const L = len / 2, B = beam / 2, xb = L - len * bow;
  s.moveTo(-L, -B * 0.92);
  s.lineTo(xb, -B);
  s.quadraticCurveTo(L * 0.96, -B * 0.7, L, 0);
  s.quadraticCurveTo(L * 0.96, B * 0.7, xb, B);
  s.lineTo(-L, B * 0.92);
  s.quadraticCurveTo(-L - B * 0.25, 0, -L, -B * 0.92);
  const g = new THREE.ExtrudeGeometry(s, { depth: h, bevelEnabled: false, curveSegments: 6 });
  g.rotateX(-Math.PI / 2);
  g.translate(0, y0, 0);
  return g;
}
const boxAt = (k, m, w, h, d, x, y, z, ry = 0) => k.add(new THREE.BoxGeometry(w, h, d), m, { pos: [x, y + h / 2, z], rot: [0, ry, 0] });

function makeFerry() {
  const k = new Kit();
  const navy = std(0x1d3a5c), white = std(0xeef0ee, { roughness: 0.6 }), dark = std(0x18222c, { metalness: 0.5, roughness: 0.3 }), red = std(0xb42a22);
  k.add(hullGeo(120, 20, 6, 0.22, -4), navy);
  k.add(hullGeo(118, 19.6, 4.5, 0.22, 2), white);
  for (const [x0, x1, y, w] of [[-52, 30, 6.5, 18.5], [-44, 22, 9.5, 17.5], [-30, 14, 12.5, 15]]) {
    boxAt(k, white, x1 - x0, 3, w, (x0 + x1) / 2, y, 0);
    boxAt(k, dark, x1 - x0 + 0.2, 1.1, w + 0.2, (x0 + x1) / 2, y + 1.2, 0); // the window band
  }
  boxAt(k, white, 9, 4, 13, 18, 15.5, 0); // the bridge
  boxAt(k, dark, 9.2, 1.4, 13.2, 18, 17.3, 0);
  k.add(new THREE.CylinderGeometry(2.6, 3.2, 8, 12), white, { pos: [-30, 19.5, 0] });
  k.add(new THREE.CylinderGeometry(2.62, 2.62, 1.6, 12), red, { pos: [-30, 22.6, 0] });
  return k.build({ name: 'ferry' });
}
function makeSubmarine() {
  const k = new Kit();
  const black = std(0x15181b, { roughness: 0.55, metalness: 0.2 });
  const hull = new THREE.CapsuleGeometry(4.6, 58, 6, 16);
  hull.rotateZ(Math.PI / 2);
  hull.scale(1, 0.85, 1);
  k.add(hull, black, { pos: [0, -2.6, 0] });
  k.add(new THREE.BoxGeometry(11, 6, 2.6), black, { pos: [10, 3, 0] }); // the sail
  k.add(new THREE.BoxGeometry(5, 0.4, 7.5), black, { pos: [10, 4.2, 0] }); // the planes on the sail
  k.add(new THREE.BoxGeometry(4, 4.5, 0.5), black, { pos: [-32, 0.5, 0] }); // the rudder
  boxAt(k, std(0x2b2f33), 40, 0.15, 3.2, -2, 0.85, 0); // the casing
  return k.build({ name: 'submarine' });
}
function makeTug() {
  const k = new Kit();
  const red = std(0xa8281e), black = std(0x1a1c1e), white = std(0xe8e8e2), tyre = std(0x111111, { roughness: 0.9 });
  k.add(hullGeo(30, 9, 3.4, 0.35, -2), black);
  k.add(hullGeo(29.6, 8.8, 1.6, 0.35, 1.4), red);
  boxAt(k, white, 9, 3, 6.5, 3, 3, 0);
  boxAt(k, white, 5.5, 2.4, 6.8, 4, 6, 0);
  boxAt(k, std(0x1b2a36, { metalness: 0.6, roughness: 0.2 }), 5.6, 0.9, 6.9, 4, 7.1, 0);
  k.rod([4, 8.4, 0], [4, 12.5, 0], 0.15, white);
  k.add(new THREE.TorusGeometry(4.4, 0.45, 6, 18, Math.PI), tyre, { pos: [13.5, 1.6, 0], rot: [Math.PI / 2, 0, Math.PI / 2] });
  return k.build({ name: 'tug' });
}
function makeBarge() {
  const k = new Kit();
  k.add(hullGeo(60, 13, 4, 0.08, -2.5), std(0x2a2d30));
  k.add(new THREE.BoxGeometry(58, 0.4, 12.4), std(0xa8452e), { pos: [0, 1.7, 0] });
  boxAt(k, std(0xe3e1d8), 7, 4, 10, -24, 1.9, 0);
  return k.build({ name: 'barge' });
}

// --- The pier-head light towers and the buoys -------------------------------------------------------------------------------
function lightTower(color) {
  const k = new Kit();
  const white = std(0xf0f0ea), band = std(color === 'red' ? 0xc02a22 : 0x1f8a4a), metal = std(0x3a3f44, { metalness: 0.6 });
  k.add(new THREE.CylinderGeometry(1.5, 2.1, 10, 14), white, { pos: [0, 5, 0] });
  for (const y of [3.2, 6.6]) k.add(new THREE.CylinderGeometry(1.72, 1.86, 1.6, 14), band, { pos: [0, y, 0] });
  k.add(new THREE.CylinderGeometry(2.3, 2.3, 0.3, 14), metal, { pos: [0, 10.15, 0] });
  k.add(new THREE.CylinderGeometry(0.9, 0.9, 1.6, 10), std(0x223038, { metalness: 0.8, roughness: 0.15 }), { pos: [0, 11.1, 0] });
  k.add(new THREE.ConeGeometry(1.1, 0.9, 10), band, { pos: [0, 12.35, 0] });
  return k.build({ name: 'light' });
}
function buoyModel(kind) {
  const k = new Kit();
  const red = std(0xc4271d), green = std(0x1d8a43), white = std(0xf2f2ee), dark = std(0x23272b);
  k.add(new THREE.CylinderGeometry(1.4, 1.6, 1.4, 14), kind === 'stbd' ? green : red, { pos: [0, 0.3, 0] });
  if (kind === 'fairway') {
    for (let i = 0; i < 4; i++) k.add(new THREE.CylinderGeometry(0.55, 0.62, 3.6, 12, 1, false, (i * Math.PI) / 2, Math.PI / 4), i % 2 ? white : red, { pos: [0, 2.8, 0] });
    for (let i = 0; i < 4; i++) k.add(new THREE.CylinderGeometry(0.55, 0.62, 3.6, 12, 1, false, (i * Math.PI) / 2 + Math.PI / 4, Math.PI / 4), i % 2 ? red : white, { pos: [0, 2.8, 0] });
    k.add(new THREE.SphereGeometry(0.55, 12, 8), red, { pos: [0, 5.3, 0] });
  } else if (kind === 'port') {
    k.add(new THREE.CylinderGeometry(0.75, 0.75, 2.6, 12), red, { pos: [0, 2.3, 0] });
    k.add(new THREE.BoxGeometry(0.9, 0.9, 0.9), red, { pos: [0, 4.4, 0] });
  } else {
    k.add(new THREE.CylinderGeometry(0.3, 0.8, 2.6, 12), green, { pos: [0, 2.3, 0] });
    k.add(new THREE.ConeGeometry(0.6, 1.0, 12), green, { pos: [0, 4.3, 0] });
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
// A sign with a number on it (berth 3 and berth 7), drawn into a canvas.
function sign(text, bg, fg = '#fff') {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = bg; g.fillRect(0, 0, 128, 128);
  g.strokeStyle = fg; g.lineWidth = 8; g.strokeRect(6, 6, 116, 116);
  g.fillStyle = fg; g.font = 'bold 86px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(text, 64, 70);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return new THREE.MeshBasicMaterial({ map: t, side: THREE.DoubleSide });
}

// --- Everything ------------------------------------------------------------------------------------------------------------
export function createHarbour(scene) {
  const group = new THREE.Group();
  group.name = 'harbour';
  scene.add(group);
  const rng = mulberry32(7);
  const ground = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 });

  // The land: fine near the port, coarser out on the hills.
  const land = refine(LAND, (x, z) => { const r = Math.hypot(x + 200, z + 300); return r < 1600 ? 24 : Math.min(24 + (r - 1600) * 0.06, 420); });
  const tmp = new THREE.Color();
  tmp.setSRGB = function (r, g, b) { return this.setRGB(r, g, b, THREE.SRGBColorSpace); };
  const DIM = 0.74; // the ground's albedo: concrete and dry earth reflect far less than they seem to, and the sun here is strong
  const landGeo = meshOf(land, (v) => (v.edge >= 0 ? coastH(LAND.kinds[v.edge], 0) : landHeight(v.x, v.z)), (v, c) => {
    const n = fbm(v.x / 60, v.z / 60);
    const port = inPoly(portZone, v.x, v.z);
    const near = coastNear(LAND, v.x, v.z);
    if (port) tmp.setSRGB(0.55 + 0.08 * n, 0.54 + 0.07 * n, 0.5 + 0.06 * n); // concrete and asphalt
    else if (near.kind === 'b' && near.d < 75) tmp.setSRGB(0.8, 0.71, 0.55); // sand
    else if (near.kind === 'c' && near.d < 30) tmp.setSRGB(0.42, 0.38, 0.31); // the rocks of the headland
    else {
      const town = 1 - smooth(1500, 2600, Math.hypot(v.x + 150, v.z + 500));
      const hill = smooth(40, 160, v.y);
      // town ground (streets, yards) toward the green of the scrub and pine on the hills, bare rock on the highest tops
      const g0 = [0.47 + 0.08 * n, 0.44 + 0.06 * n, 0.38 + 0.05 * n], g1 = [0.2 + 0.12 * n, 0.3 + 0.1 * n, 0.14 + 0.05 * n], g2 = [0.48, 0.45, 0.4];
      const k = Math.max(1 - town, hill);
      const r = smooth(300, 420, v.y);
      tmp.setSRGB(g0[0] + (g1[0] - g0[0]) * k, g0[1] + (g1[1] - g0[1]) * k, g0[2] + (g1[2] - g0[2]) * k).lerp(new THREE.Color().setRGB(...g2, THREE.SRGBColorSpace), r * 0.6);
    }
    c[0] = tmp.r * DIM; c[1] = tmp.g * DIM; c[2] = tmp.b * DIM;
  });
  upFacing(landGeo);
  const landMesh = new THREE.Mesh(landGeo, ground);
  landMesh.receiveShadow = true;
  landMesh.name = 'land';
  group.add(landMesh);

  // The north breakwater: its deck, and the slope of the armour up to it from the seaward side.
  const bw = refine(BREAKWATER, () => 18);
  const bwGeo = meshOf(bw, (v) => {
    if (v.edge >= 0) return BREAKWATER.kinds[v.edge] === 'r' ? 0.3 : BW_DECK;
    const { d, kind } = coastNear(BREAKWATER, v.x, v.z);
    return coastH(kind, d, BW_DECK);
  }, (v, c) => { const n = fbm(v.x / 30, v.z / 30); [c[0], c[1], c[2]] = lin([0.5 + 0.06 * n, 0.49 + 0.06 * n, 0.46 + 0.05 * n]); });
  upFacing(bwGeo);
  const bwMesh = new THREE.Mesh(bwGeo, ground);
  bwMesh.receiveShadow = true;
  group.add(bwMesh);

  // Quay walls and the slopes into the water.
  const skirtMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, side: THREE.DoubleSide });
  const landSk = coastSkirt(LAND, (p, kind) => coastH(kind, 0));
  const bwSk = coastSkirt(BREAKWATER, (p, kind) => (kind === 'r' ? 0.3 : BW_DECK));
  for (const s of [landSk, bwSk]) { const m = new THREE.Mesh(s.geo, skirtMat); m.receiveShadow = true; group.add(m); }

  // The wave wall along the breakwater's seaward side, a few metres in from the armour's foot.
  {
    const k = new Kit();
    const conc = std(0xa7a49b, { roughness: 0.95 });
    const p = BREAKWATER.pts, n = p.length;
    for (let i = 0; i < n; i++) {
      if (BREAKWATER.kinds[i] !== 'r') continue;
      const a = p[i], b = p[(i + 1) % n], [nx, nz] = bwSk.outN[i];
      const inA = { x: a.x - nx * 9, z: a.z - nz * 9 }, inB = { x: b.x - nx * 9, z: b.z - nz * 9 };
      const len = Math.hypot(inB.x - inA.x, inB.z - inA.z);
      if (len < 4) continue;
      const ang = Math.atan2(inB.z - inA.z, inB.x - inA.x);
      k.add(new THREE.BoxGeometry(len + 2.5, 2.6, 2.4), conc, { pos: [(inA.x + inB.x) / 2, BW_DECK + 1.3, (inA.z + inB.z) / 2], rot: [0, -ang, 0] });
    }
    group.add(k.build({ name: 'wave-wall' }));
  }

  // Rock armour: concrete blocks and boulders along every rock face, from below the water up the slope.
  {
    const rocks = [];
    const NEAR = 2600; // m from the port: natural rocks further out are never seen up close
    const place = (poly, outN, deck, palette, size, rows, step, inward) => {
      const p = poly.pts, n = p.length;
      for (let i = 0; i < n; i++) {
        if (poly.kinds[i] !== (inward ? 'r' : 'c')) continue;
        const a = p[i], b = p[(i + 1) % n], [nx, nz] = outN[i];
        const len = Math.hypot(b.x - a.x, b.z - a.z);
        if (!inward && Math.hypot((a.x + b.x) / 2, (a.z + b.z) / 2 + 300) > NEAR) continue;
        for (let s = 0; s < len; s += step) {
          for (let r = 0; r < rows; r++) {
            const off = (r / (rows - 1 || 1)) * (inward ? 11 : 9) - 3 + rng() * 1.5; // metres inland of the waterline (+) or out (-)
            const f = (s + rng() * step) / len;
            const x = a.x + (b.x - a.x) * f - nx * off, z = a.z + (b.z - a.z) * f - nz * off;
            const y = off < 0 ? off * 0.9 : Math.min(0.3 + 0.45 * off, deck) - 0.4;
            rocks.push({ x, y, z, s: size * (0.7 + rng() * 0.6), c: palette[Math.floor(rng() * palette.length)] });
          }
        }
      }
    };
    const armour = [[0.72, 0.71, 0.67], [0.66, 0.65, 0.61], [0.78, 0.77, 0.73], [0.6, 0.59, 0.56]];
    const natural = [[0.44, 0.39, 0.33], [0.36, 0.32, 0.27], [0.5, 0.45, 0.38]];
    place(BREAKWATER, bwSk.outN, BW_DECK, armour, 2.3, 4, 2.8, true);
    place(LAND, landSk.outN, QUAY, armour, 2.0, 3, 2.8, true);
    place(LAND, landSk.outN, 14, natural, 2.8, 3, 5, false);
    for (const R of ROCKS) { // the rocks awash: a heap each
      for (let i = 0; i < 26; i++) {
        const a = rng() * Math.PI * 2, d = Math.sqrt(rng()) * R.r;
        rocks.push({ x: R.c.x + Math.cos(a) * d, y: 1.8 * (1 - d / R.r) - 1.2 + rng(), z: R.c.z + Math.sin(a) * d, s: 2.5 + rng() * 3, c: natural[i % 3] });
      }
    }
    const geo = new THREE.IcosahedronGeometry(1, 0);
    const mesh = new THREE.InstancedMesh(geo, std(0xffffff, { roughness: 0.95, flatShading: true }), rocks.length);
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

  // The port's sheds and offices (blue roofs where the images show them), and a few stacks of containers.
  {
    const k = new Kit();
    const wall = std(0xd9d6cc), wall2 = std(0xbfbab0), blue = std(0x2f5fb8, { roughness: 0.55, metalness: 0.3 }), white = std(0xe8e8e4), glass = std(0x24323c, { metalness: 0.6, roughness: 0.3 });
    const shed = (x, y, len, wid, h, rot, roof = blue, walls = wall) => {
      const c = px(x, y), a = (rot * Math.PI) / 180;
      k.add(new THREE.BoxGeometry(len, h, wid), walls, { pos: [c.x, QUAY + h / 2, c.z], rot: [0, -a, 0] });
      const ridge = new THREE.CylinderGeometry(wid * 0.56, wid * 0.56, len, 3, 1);
      ridge.rotateZ(Math.PI / 2);
      ridge.scale(1, 0.22, 1);
      k.add(ridge, roof, { pos: [c.x, QUAY + h + wid * 0.04, c.z], rot: [0, -a, 0] });
      k.add(new THREE.BoxGeometry(len * 0.92, 1.2, wid + 0.1), glass, { pos: [c.x, QUAY + h * 0.62, c.z], rot: [0, -a, 0] });
    };
    // rot: the long side's bearing from north, in degrees (the images are north-up)
    shed(420, 140, 105, 62, 12, 115);
    shed(245, 98, 72, 38, 11, 100);
    shed(345, 84, 42, 24, 9, 100);
    shed(190, 82, 36, 30, 9, 100);
    shed(475, 105, 30, 20, 8, 100);
    shed(92, 306, 92, 40, 10, 90, white, wall2);
    shed(118, 548, 42, 32, 10, 80);
    shed(80, 420, 60, 30, 14, 160, std(0x9aa3a8), wall);
    shed(160, 620, 50, 24, 9, 120, std(0x8f989c), wall2);
    // offices at the breakwater's root
    boxAt(k, wall, 30, 14, 16, px(520, 52).x, QUAY, px(520, 52).z, -0.17);
    boxAt(k, glass, 30.2, 1.2, 16.2, px(520, 52).x, QUAY + 9, px(520, 52).z, -0.17);
    // container stacks (instanced below)
    group.add(k.build({ name: 'sheds' }));
    const boxes = [];
    const stack = (x, y, rows, cols, rot) => {
      const c = px(x, y), a = (rot * Math.PI) / 180, ca = Math.cos(a), sa = Math.sin(a);
      for (let i = 0; i < rows; i++) for (let j = 0; j < cols; j++) {
        const h = 1 + Math.floor(rng() * 3);
        for (let l = 0; l < h; l++) boxes.push({ x: c.x + ca * j * 6.4 - sa * i * 2.7, z: c.z + sa * j * 6.4 + ca * i * 2.7, y: QUAY + l * 2.6, a });
      }
    };
    stack(455, 92, 5, 3, 100);
    stack(470, 680, 6, 5, 60);
    stack(530, 640, 4, 4, 60);
    stack(1000, 120, 3, 2, 98);
    const cols = [0xb03a2e, 0x2e6db0, 0xd9a72a, 0x2e8b57, 0x8a8f94, 0xd8d8d0, 0x7a3a8a];
    const im = new THREE.InstancedMesh(new THREE.BoxGeometry(6.1, 2.55, 2.45), std(0xffffff, { roughness: 0.7, metalness: 0.3 }), boxes.length);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion();
    boxes.forEach((b, i) => {
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), -b.a);
      m.compose(new THREE.Vector3(b.x, b.y + 1.28, b.z), q, new THREE.Vector3(1, 1, 1));
      im.setMatrixAt(i, m);
      im.setColorAt(i, tmp.setHex(cols[Math.floor(rng() * cols.length)]));
    });
    im.castShadow = im.receiveShadow = true;
    group.add(im);
  }

  // The town: houses and blocks of flats on a street grid, white and cream with flat roofs, some with red tiles; denser by the
  // port, thinning out up the hills. Two mosques with their minarets.
  {
    const spots = [];
    const ang = (12 * Math.PI) / 180, ca = Math.cos(ang), sa = Math.sin(ang);
    const STEP = 27;
    for (let i = -110; i <= 110; i++) {
      for (let j = -110; j <= 110; j++) {
        if (i % 5 === 0 || j % 4 === 0) continue; // the streets
        const gx = i * STEP, gz = j * STEP;
        const x = gx * ca - gz * sa - 300 + (rng() - 0.5) * 6, z = gx * sa + gz * ca - 700 + (rng() - 0.5) * 6;
        const r0 = Math.hypot(x + 150, z + 500);
        if (r0 > 3000) continue;
        if (!inPoly(LAND, x, z) || inPoly(portZone, x, z)) continue;
        const near = coastNear(LAND, x, z);
        if (near.d < (near.kind === 'b' ? 95 : 32)) continue;
        const h = landHeight(x, z);
        const p = (1 - smooth(900, 3000, r0)) * (1 - smooth(60, 220, h));
        if (rng() > p * 0.95) continue;
        spots.push({ x, z, y: h, r0 });
      }
    }
    const walls = ['#ece6d6', '#f3efe6', '#e2d6bb', '#e8dcc2', '#d8d1c3', '#efe6d1', '#e6e0d2', '#d6c7a6'];
    const tiles = ['#b4532f', '#a6482a', '#bf6640', '#9c4126'];
    const n = spots.length;
    const bodies = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0), std(0xffffff, { roughness: 0.85 }), n);
    const roofG = new THREE.ConeGeometry(0.75, 1, 4, 1).rotateY(Math.PI / 4).translate(0, 0.5, 0);
    const roofs = new THREE.InstancedMesh(roofG, std(0xffffff, { roughness: 0.8 }), n);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -ang), s = new THREE.Vector3();
    let nr = 0;
    spots.forEach((sp, i) => {
      const w = 9 + rng() * 11, d = 9 + rng() * 11;
      const tall = sp.r0 < 1600 && rng() < 0.22;
      const floors = tall ? 5 + Math.floor(rng() * 6) : 1 + Math.floor(rng() * 4);
      const h = floors * 3.1;
      m.compose(new THREE.Vector3(sp.x, sp.y - 1.5, sp.z), q, s.set(tall ? w * 1.5 : w, h + 1.5, d));
      bodies.setMatrixAt(i, m);
      bodies.setColorAt(i, tmp.set(walls[Math.floor(rng() * walls.length)]));
      if (!tall && rng() < 0.45) {
        m.compose(new THREE.Vector3(sp.x, sp.y + h, sp.z), q, s.set(w * 1.05, 2.6 + rng(), d * 1.05));
        roofs.setMatrixAt(nr, m);
        roofs.setColorAt(nr++, tmp.set(tiles[Math.floor(rng() * tiles.length)]));
      }
    });
    roofs.count = nr;
    bodies.castShadow = roofs.castShadow = true;
    bodies.receiveShadow = roofs.receiveShadow = true;
    group.add(bodies, roofs);

    const k = new Kit();
    const white = std(0xf4f2ea), green = std(0x2f7a55, { roughness: 0.5 });
    for (const [x, y] of [[-180, 520], [-520, 980]]) {
      const c = px(x, y), h0 = landHeight(c.x, c.z);
      k.add(new THREE.BoxGeometry(26, 9, 26), white, { pos: [c.x, h0 + 4.5, c.z] });
      k.add(new THREE.SphereGeometry(8, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), green, { pos: [c.x, h0 + 9, c.z] });
      k.add(new THREE.BoxGeometry(4.4, 34, 4.4), white, { pos: [c.x + 15, h0 + 17, c.z + 15] });
      k.add(new THREE.BoxGeometry(5.4, 1.2, 5.4), white, { pos: [c.x + 15, h0 + 28, c.z + 15] });
      k.add(new THREE.BoxGeometry(3.6, 4, 3.6), green, { pos: [c.x + 15, h0 + 36, c.z + 15] });
      k.add(new THREE.ConeGeometry(2.4, 3, 4), green, { pos: [c.x + 15, h0 + 39.5, c.z + 15], rot: [0, Math.PI / 4, 0] });
    }
    group.add(k.build({ name: 'mosques' }));
  }

  // Trees: pine and scrub on the hills, palms along the corniche.
  {
    const pts = [];
    for (let i = 0; i < 9000 && pts.length < 4200; i++) {
      const a = rng() * Math.PI * 2, r = 400 + rng() * 5200;
      const x = -150 + Math.cos(a) * r, z = -500 + Math.sin(a) * r;
      if (!inPoly(LAND, x, z) || inPoly(portZone, x, z)) continue;
      const h = landHeight(x, z);
      const dens = smooth(25, 120, h) * (0.4 + fbm(x / 300, z / 300));
      if (rng() > dens) continue;
      pts.push({ x, z, y: h, s: 4 + rng() * 5 });
    }
    const im = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 0).translate(0, 0.8, 0), std(0xffffff, { roughness: 0.95, flatShading: true }), pts.length);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3();
    pts.forEach((p, i) => {
      m.compose(new THREE.Vector3(p.x, p.y - 0.5, p.z), q, s.set(p.s, p.s * 1.25, p.s));
      im.setMatrixAt(i, m);
      im.setColorAt(i, tmp.setSRGB(0.12 + rng() * 0.08, 0.22 + rng() * 0.1, 0.1 + rng() * 0.04));
    });
    im.castShadow = true;
    group.add(im);
  }

  // Bollards and fenders along the faces where ships lie, and berth 7's green marks.
  {
    const bol = [], fen = [];
    for (const f of Object.values(FACES)) {
      for (let s = 6; s < f.len - 4; s += 16) {
        const deck = f === FACES.north || f === FACES.arm ? BW_DECK : QUAY;
        bol.push({ x: f.a.x + f.dir.x * s - f.n.x * 1.2, z: f.a.z + f.dir.z * s - f.n.z * 1.2, y: deck });
        fen.push({ x: f.a.x + f.dir.x * (s + 8) + f.n.x * 0.35, z: f.a.z + f.dir.z * (s + 8) + f.n.z * 0.35, y: deck - 1.8, a: f.psi });
      }
    }
    const bm = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.32, 0.4, 0.9, 8).translate(0, 0.45, 0), std(0x2a2c2e, { metalness: 0.5 }), bol.length);
    const fm = new THREE.InstancedMesh(new THREE.BoxGeometry(2.2, 2.2, 0.7), std(0x121212, { roughness: 0.9 }), fen.length);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), one = new THREE.Vector3(1, 1, 1);
    bol.forEach((b, i) => { m.compose(new THREE.Vector3(b.x, b.y, b.z), q.identity(), one); bm.setMatrixAt(i, m); });
    fen.forEach((b, i) => { q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), -b.a); m.compose(new THREE.Vector3(b.x, b.y, b.z), q, one); fm.setMatrixAt(i, m); });
    group.add(bm, fm);
  }
  const berthMarks = new THREE.Group();
  {
    const B = TARGET_BERTH, f = B.face, mat = new THREE.MeshBasicMaterial({ color: 0x3ddc84, toneMapped: false });
    const c = { x: f.a.x + f.dir.x * f.len * B.t, z: f.a.z + f.dir.z * f.len * B.t };
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(B.len, 0.08, 0.9), mat);
    stripe.position.set(c.x - f.n.x * 0.6, BW_DECK + 0.05, c.z - f.n.z * 0.6);
    stripe.rotation.y = -f.psi;
    berthMarks.add(stripe);
    for (const e of [-1, 1]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.4, 4, 0.4), mat);
      const ex = c.x + f.dir.x * e * B.len / 2 - f.n.x * 1.5, ez = c.z + f.dir.z * e * B.len / 2 - f.n.z * 1.5;
      post.position.set(ex, BW_DECK + 2, ez);
      const board = new THREE.Mesh(new THREE.PlaneGeometry(3.2, 3.2), sign('7', '#1f8a4a'));
      board.position.set(ex, BW_DECK + 5.2, ez);
      board.rotation.y = -f.psi - Math.PI / 2;
      berthMarks.add(post, board);
    }
    // the berth's outline on the water, where she is to lie
    const line = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(HULL_OUTLINE.map(([a, b]) => new THREE.Vector3(B.x + a * Math.cos(B.psi) - b * Math.sin(B.psi), 0.25, B.z + a * Math.sin(B.psi) + b * Math.cos(B.psi)))),
      new THREE.LineDashedMaterial({ color: 0x3ddc84, dashSize: 3, gapSize: 2, toneMapped: false, transparent: true, opacity: 0.9 }));
    line.computeLineDistances();
    line.name = 'ghost';
    berthMarks.add(line);
    const s3 = FACES.pier, c3 = { x: s3.a.x + s3.dir.x * s3.len * 0.36, z: s3.a.z + s3.dir.z * s3.len * 0.36 };
    const b3 = new THREE.Mesh(new THREE.PlaneGeometry(3.2, 3.2), sign('3', '#2a4a7a'));
    b3.position.set(c3.x - s3.n.x * 1.5 + s3.dir.x * (HALF_LENGTH + 8), QUAY + 3.2, c3.z - s3.n.z * 1.5 + s3.dir.z * (HALF_LENGTH + 8));
    b3.rotation.y = -s3.psi - Math.PI / 2;
    const p3 = new THREE.Mesh(new THREE.BoxGeometry(0.35, 3, 0.35), std(0x2a4a7a));
    p3.position.set(b3.position.x, QUAY + 1.5, b3.position.z);
    group.add(b3, p3);
  }
  group.add(berthMarks);

  // The ships alongside.
  const vessels = [];
  for (const v of MOORED) {
    let obj;
    if (v.type === 'frigate' || v.type === 'corvette') {
      const s = createShip({ crew: false, catapult: false, ensign: v.type === 'corvette' ? 'red' : 'navy' });
      s.update(1000, Infinity);
      obj = s.group;
      obj.scale.setScalar(v.len / 116);
    } else obj = { ferry: makeFerry, submarine: makeSubmarine, tug: makeTug, barge: makeBarge }[v.type]();
    obj.position.set(v.x, 0, v.z);
    obj.rotation.y = -v.psi;
    group.add(obj);
    vessels.push({ obj, v, ph: rng() * 6 });
  }

  // Fishing boats: rafted along the old quays at the west end and filling the fishing harbour.
  {
    const boats = [];
    const quayRow = (x0, y0, x1, y1, nb, side) => {
      const a = px(x0, y0), b = px(x1, y1), dx = b.x - a.x, dz = b.z - a.z, L = Math.hypot(dx, dz);
      for (let i = 0; i < nb; i++) {
        const f = (i + 0.5) / nb;
        boats.push({ x: a.x + dx * f + (-dz / L) * side * 4, z: a.z + dz * f + (dx / L) * side * 4, psi: Math.atan2(-dx * side, dz * side) + (rng() - 0.5) * 0.2, len: 9 + rng() * 8 });
      }
    };
    quayRow(60, 205, 215, 178, 9, 1);
    quayRow(150, 340, 185, 430, 6, 1);
    // the fishing harbour: rows of boats moored bow-on to pontoons
    const pont = [];
    for (let r = 0; r < 5; r++) {
      const a = px(345 + r * 4, 840 + r * 70), b = px(520 + r * 30, 860 + r * 70);
      pont.push([a, b]);
      const dx = b.x - a.x, dz = b.z - a.z, L = Math.hypot(dx, dz);
      for (let i = 0; i < L / 6.5; i++) {
        const f = (i + 0.5) / (L / 6.5);
        for (const side of [-1, 1]) {
          if (rng() < 0.2) continue;
          const nx = -dz / L * side, nz = dx / L * side, l = 9 + rng() * 9;
          boats.push({ x: a.x + dx * f + nx * (l / 2 + 1.5), z: a.z + dz * f + nz * (l / 2 + 1.5), psi: Math.atan2(-nz, -nx), len: l });
        }
      }
    }
    const k = new Kit();
    const deck = std(0x6b5b45);
    for (const [a, b] of pont) {
      const L = Math.hypot(b.x - a.x, b.z - a.z);
      k.add(new THREE.BoxGeometry(L, 0.5, 2.2), deck, { pos: [(a.x + b.x) / 2, 0.35, (a.z + b.z) / 2], rot: [0, -Math.atan2(b.z - a.z, b.x - a.x), 0] });
    }
    group.add(k.build({ name: 'pontoons' }));
    const hulls = new THREE.InstancedMesh(hullGeo(1, 0.34, 0.14, 0.35, -0.05), std(0xffffff, { roughness: 0.6 }), boats.length);
    const cabs = new THREE.InstancedMesh(new THREE.BoxGeometry(0.22, 0.12, 0.22).translate(-0.05, 0.15, 0), std(0xf2f2ee), boats.length);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3();
    const hc = ['#f4f4f0', '#2d6db5', '#f4f4f0', '#3a8fd0', '#c94b30', '#f4f4f0', '#2f9e8a'];
    boats.forEach((b, i) => {
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), -b.psi);
      m.compose(new THREE.Vector3(b.x, 0, b.z), q, s.set(b.len, b.len, b.len));
      hulls.setMatrixAt(i, m);
      hulls.setColorAt(i, tmp.set(hc[Math.floor(rng() * hc.length)]));
      cabs.setMatrixAt(i, m);
    });
    hulls.castShadow = true;
    group.add(hulls, cabs);
  }

  // The pier-head lights (red on the south mole, green on the east arm) and the buoys, with their lamps.
  const lamps = [];
  LIGHTS.forEach((L, i) => {
    const t = lightTower(L.color);
    const y0 = L.color === 'red' ? QUAY : BW_DECK;
    t.position.set(L.x, y0, L.z);
    group.add(t);
    const s = lamp(L.color === 'red' ? 0xff3b30 : 0x3dff7a, 9);
    s.position.set(L.x, y0 + 11.2, L.z);
    group.add(s);
    lamps.push({ s, period: 4, on: 0.6, ph: i * 2 });
  });
  const buoys = BUOYS.map((b, i) => {
    const g = buoyModel(b.kind);
    g.position.set(b.x, 0, b.z);
    group.add(g);
    const s = lamp(b.kind === 'stbd' ? 0x3dff7a : b.kind === 'port' ? 0xff3b30 : 0xffffff, 5);
    s.position.set(0, 6, 0);
    g.add(s);
    lamps.push({ s, period: b.kind === 'fairway' ? 8 : 3, on: b.kind === 'fairway' ? 2 : 0.5, ph: i * 0.7 });
    return { g, ph: i * 1.3 };
  });

  return {
    group,
    berthMarks,
    ghost: berthMarks.getObjectByName('ghost'),
    landHeight,
    // t: seconds (any clock): the lamps blink, the buoys and the ships alongside bob (her mooring lines are harbourCrew.js's)
    update(t) {
      for (const l of lamps) l.s.visible = ((t + l.ph) % l.period) < l.on;
      for (const b of buoys) {
        b.g.position.y = 0.18 * Math.sin(t * 1.1 + b.ph);
        b.g.rotation.x = 0.05 * Math.sin(t * 0.9 + b.ph);
        b.g.rotation.z = 0.05 * Math.cos(t * 0.8 + b.ph);
      }
      for (const v of vessels) v.obj.position.y = 0.06 * Math.sin(t * 0.5 + v.ph);
    },
  };
}

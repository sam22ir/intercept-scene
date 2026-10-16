import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// Modelling helpers. Detailed models are built from hundreds of small parts;
// Kit collects them per material and merges each material into one mesh so
// the scene stays at a few dozen draw calls.

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);

export class Kit {
  constructor() {
    this.buckets = new Map(); // material -> geometry[]
  }

  // place: { pos:[x,y,z], rot:[x,y,z] (radians, XYZ), scale:[x,y,z]|number } or a Matrix4
  add(geo, material, place) {
    let g = geo.index ? geo.toNonIndexed() : geo.clone();
    for (const name of Object.keys(g.attributes)) {
      if (name !== 'position' && name !== 'normal' && name !== 'uv') g.deleteAttribute(name);
    }
    if (!g.attributes.uv) {
      g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
    }
    if (!g.attributes.normal) g.computeVertexNormals();
    if (place) g.applyMatrix4(place.isMatrix4 ? place : toMatrix(place));
    if (!this.buckets.has(material)) this.buckets.set(material, []);
    this.buckets.get(material).push(g);
    return this;
  }

  // Cylinder between two points.
  rod(a, b, radius, material, radialSegments = 6, radiusB = radius) {
    const A = new THREE.Vector3(...a);
    const B = new THREE.Vector3(...b);
    const len = A.distanceTo(B);
    if (len < 1e-4) return this;
    const geo = new THREE.CylinderGeometry(radiusB, radius, len, radialSegments, 1);
    _q.setFromUnitVectors(_up, _p.subVectors(B, A).normalize());
    _m.compose(A.add(B).multiplyScalar(0.5), _q, _s.set(1, 1, 1));
    return this.add(geo, material, _m);
  }

  build({ castShadow = true, receiveShadow = true, name } = {}) {
    const group = new THREE.Group();
    if (name) group.name = name;
    for (const [material, geos] of this.buckets) {
      const merged = mergeGeometries(geos, false);
      const mesh = new THREE.Mesh(merged, material);
      mesh.castShadow = castShadow && !material.userData.noShadow;
      mesh.receiveShadow = receiveShadow;
      group.add(mesh);
    }
    return group;
  }
}

export function toMatrix({ pos = [0, 0, 0], rot = [0, 0, 0], scale = 1 } = {}) {
  _q.setFromEuler(_e.set(rot[0], rot[1], rot[2]));
  const s = typeof scale === 'number' ? _s.setScalar(scale) : _s.set(...scale);
  return new THREE.Matrix4().compose(_p.set(...pos), _q, s);
}

// Hexahedron from 8 corners: bottom quad then top quad, each ordered
// (x0,z0) (x1,z0) (x1,z1) (x0,z1) looking down. Flat-shaded, planar UVs in
// metres. Covers slanted stealth blocks, wedges and tapered housings.
export function hexa(c) {
  const faces = [
    [0, 3, 2, 1], // bottom
    [4, 5, 6, 7], // top
    [0, 1, 5, 4], // -z side
    [1, 2, 6, 5], // +x end
    [2, 3, 7, 6], // +z side
    [3, 0, 4, 7], // -x end
  ];
  const pos = [];
  const uv = [];
  const V = c.map((p) => new THREE.Vector3(...p));
  const centroid = V.reduce((s, v) => s.add(v), new THREE.Vector3()).divideScalar(8);
  const n = new THREE.Vector3();
  const e1 = new THREE.Vector3();
  const e2 = new THREE.Vector3();
  const fc = new THREE.Vector3();
  for (const [a, b, cc, d] of faces) {
    e1.subVectors(V[b], V[a]);
    e2.subVectors(V[cc], V[a]);
    n.crossVectors(e1, e2).normalize();
    // Corner order may be mirrored (e.g. port/starboard copies): make every
    // face wind counter-clockwise from outside so normals and culling are right.
    fc.copy(V[a]).add(V[b]).add(V[cc]).add(V[d]).multiplyScalar(0.25).sub(centroid);
    const flip = n.dot(fc) < 0;
    if (flip) n.negate();
    const ax = Math.abs(n.x) > Math.abs(n.z) ? 'z' : 'x';
    const quad = flip ? [V[a], V[cc], V[b], V[a], V[d], V[cc]] : [V[a], V[b], V[cc], V[a], V[cc], V[d]];
    for (const v of quad) {
      pos.push(v.x, v.y, v.z);
      uv.push(Math.abs(n.y) > 0.7 ? v.x : v[ax], Math.abs(n.y) > 0.7 ? v.z : v.y);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.computeVertexNormals();
  return g;
}

// Symmetric block about z = 0 with sloped sides and ends.
// x0/x1: bottom aft/fore, tx0/tx1: top aft/fore, w/tw: bottom/top half-width.
export function slab({ x0, x1, tx0 = x0, tx1 = x1, y0, y1, w, tw = w }) {
  return hexa([
    [x0, y0, -w], [x1, y0, -w], [x1, y0, w], [x0, y0, w],
    [tx0, y1, -tw], [tx1, y1, -tw], [tx1, y1, tw], [tx0, y1, tw],
  ]);
}

// A quad lying on one face of a slab, inset by fractions (u along the face's
// horizontal edge, v up the face), pushed out along the normal. Used for
// windows, doors, vents and panels on sloped walls.
export function facePanel(s, face, u0, u1, v0, v1, offset = 0.03) {
  const { x0, x1, tx0 = x0, tx1 = x1, y0, y1, w, tw = w } = s;
  let bl, br, tl, tr; // corners as seen from outside
  if (face === 'fore') { bl = [x1, y0, w]; br = [x1, y0, -w]; tl = [tx1, y1, tw]; tr = [tx1, y1, -tw]; }
  if (face === 'aft') { bl = [x0, y0, -w]; br = [x0, y0, w]; tl = [tx0, y1, -tw]; tr = [tx0, y1, tw]; }
  if (face === 'port') { bl = [x1, y0, -w]; br = [x0, y0, -w]; tl = [tx1, y1, -tw]; tr = [tx0, y1, -tw]; }
  if (face === 'stbd') { bl = [x0, y0, w]; br = [x1, y0, w]; tl = [tx0, y1, tw]; tr = [tx1, y1, tw]; }
  const P = (u, v) => {
    const b = new THREE.Vector3().lerpVectors(new THREE.Vector3(...bl), new THREE.Vector3(...br), u);
    const t = new THREE.Vector3().lerpVectors(new THREE.Vector3(...tl), new THREE.Vector3(...tr), u);
    return b.lerp(t, v);
  };
  const a = P(u0, v0);
  const b = P(u1, v0);
  const c = P(u1, v1);
  const d = P(u0, v1);
  const n = new THREE.Vector3().crossVectors(new THREE.Vector3().subVectors(b, a), new THREE.Vector3().subVectors(d, a)).normalize();
  for (const v of [a, b, c, d]) v.addScaledVector(n, offset);
  const g = new THREE.BufferGeometry();
  const p = [a, b, c, a, c, d].flatMap((v) => [v.x, v.y, v.z]);
  g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1], 2));
  g.computeVertexNormals();
  return g;
}

export function mat(color, { metalness = 0.3, roughness = 0.6, ...rest } = {}) {
  return new THREE.MeshStandardMaterial({ color, metalness, roughness, ...rest });
}

export function canvasTexture(w, h, draw, { srgb = true } = {}) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d'), w, h);
  const tex = new THREE.CanvasTexture(c);
  if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

import * as THREE from 'three';

// An island for the ship duel, built from the sim's own circle (x, z, r, h) so what the eye sees is what stops the shells and the radar
// (duel.js: height h * (1 - (d / r)^2)^1.2 inside the circle). The shape is that cone broken up with fractal noise in plan (x, z), never in
// angle alone, so there is no pattern radiating from the middle: a ragged coastline with bays and headlands, ridges and gullies, sand at the
// water's edge, grass and darker woods on the slopes, bare rock where it is steep or high. Smooth-shaded vertex colours; no textures.
// The base goes under the water, so the waves lap at it.
const RINGS = 44, SECTORS = 112;

const fract = (v) => v - Math.floor(v);
const smooth = (t) => t * t * (3 - 2 * t);

export function createIslet({ x, z, r, h }) {
  const seed = ((Math.floor(x) * 73856093) ^ (Math.floor(z) * 19349663)) >>> 0;
  const so = (seed % 997) * 0.37;
  const hash = (ix, iz, k) => fract(Math.sin(ix * 127.1 + iz * 311.7 + k * 74.7 + so) * 43758.5453);
  const vnoise = (px, pz, k = 0) => {
    const ix = Math.floor(px), iz = Math.floor(pz), fx = smooth(px - ix), fz = smooth(pz - iz);
    const a = hash(ix, iz, k), b = hash(ix + 1, iz, k), c = hash(ix, iz + 1, k), d = hash(ix + 1, iz + 1, k);
    return a + (b - a) * fx + (c - a) * fz + (a - b - c + d) * fx * fz;
  };
  const fbm = (px, pz, oct, k = 0) => {
    let amp = 0.5, f = 1, sum = 0, norm = 0;
    for (let i = 0; i < oct; i++) { sum += amp * vnoise(px * f, pz * f, k + i); norm += amp; amp *= 0.5; f *= 2.03; }
    return sum / norm; // 0..1
  };
  // A ridged version (sharp crests): 1 at the crest lines, 0 in the gullies.
  const ridge = (px, pz, oct, k) => 1 - Math.abs(2 * fbm(px, pz, oct, k) - 1);

  const heightAt = (d, th) => {
    const ct = Math.cos(th), st = Math.sin(th), px = ct * d, pz = st * d;
    // The coast: the radius wanders with noise on the circle (two scales), so there are bays and headlands.
    const wob = 1 + 0.2 * (fbm(ct * 1.7 + 11, st * 1.7 + 5, 3, 40) - 0.5) * 2 + 0.06 * (vnoise(ct * 6 + 3, st * 6 + 9, 50) - 0.5);
    const u = d / (r * Math.max(0.78, wob));
    if (u >= 1) return -7 * Math.min(1, (u - 1) / 0.25); // under the sea beyond the shore
    const base = h * (1 - u * u) ** 1.2;
    const s = 1 / (r * 0.55);
    const relief = 0.55 * fbm(px * s, pz * s, 5, 0) + 0.45 * ridge(px * s * 0.8 + 7, pz * s * 0.8 + 3, 4, 20);
    const shore = Math.min(1, u / 0.12); // the very edge stays low, like a beach
    return base * (0.45 + 0.85 * relief) * (0.25 + 0.75 * shore);
  };

  const pos = [], col = [], idx = [], n2 = [];
  pos.push(0, heightAt(0, 0), 0);
  for (let j = 1; j <= RINGS; j++) {
    const d = (r * 1.3 * j) / RINGS;
    for (let s = 0; s < SECTORS; s++) {
      const th = (2 * Math.PI * s) / SECTORS;
      pos.push(Math.cos(th) * d, heightAt(d, th), Math.sin(th) * d);
    }
  }
  const at = (j, s) => 1 + (j - 1) * SECTORS + (s % SECTORS);
  for (let s = 0; s < SECTORS; s++) idx.push(0, at(1, s + 1), at(1, s));
  for (let j = 1; j < RINGS; j++) for (let s = 0; s < SECTORS; s++) idx.push(at(j, s), at(j, s + 1), at(j + 1, s), at(j, s + 1), at(j + 1, s + 1), at(j + 1, s));
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();

  // Colours by height, steepness and a little noise (woods, bare patches), from the finished normals.
  const nrm = g.attributes.normal;
  const sand = new THREE.Color(0.78, 0.7, 0.5), wet = new THREE.Color(0.4, 0.36, 0.27), grass = new THREE.Color(0.27, 0.42, 0.18), wood = new THREE.Color(0.11, 0.24, 0.12);
  const dry = new THREE.Color(0.42, 0.45, 0.22), rock = new THREE.Color(0.47, 0.45, 0.42), rockDark = new THREE.Color(0.3, 0.29, 0.28), c = new THREE.Color();
  for (let i = 0; i < pos.length / 3; i++) {
    const px = pos[i * 3], y = pos[i * 3 + 1], pz = pos[i * 3 + 2];
    const slope = 1 - nrm.getY(i);
    const patch = fbm(px * 0.045 + 3, pz * 0.045 + 8, 4, 70);
    const grain = vnoise(px * 0.35, pz * 0.35, 90);
    if (y < 0.6) c.copy(wet);
    else if (y < 3.2) c.copy(wet).lerp(sand, Math.min(1, (y - 0.6) / 1.2));
    else {
      c.copy(sand).lerp(grass, Math.min(1, (y - 3.2) / 5));
      c.lerp(wood, smooth(Math.min(1, Math.max(0, (patch - 0.45) / 0.25))) * Math.min(1, (y - 5) / 6)); // darker woods on the middle slopes
      c.lerp(dry, smooth(Math.min(1, Math.max(0, (0.4 - patch) / 0.25))) * 0.6); // dry grass in the clearings
    }
    const bare = Math.max(smooth(Math.min(1, Math.max(0, (slope - 0.16) / 0.2))), smooth(Math.min(1, Math.max(0, (y / h - 0.72) / 0.2))));
    if (y > 1.5) c.lerp(rock.clone().lerp(rockDark, grain * 0.7), bare);
    const sh = 0.88 + 0.24 * grain;
    col.push(c.r * sh * 0.5, c.g * sh * 0.5, c.b * sh * 0.5); // the scene is lit hard: dark colours read as the real thing
  }
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  const mesh = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }));
  mesh.position.set(x, 0, z);
  mesh.name = 'islet';
  return mesh;
}

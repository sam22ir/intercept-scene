import * as THREE from 'three';
import { mulberry32 } from './rng.js';
import { islandLayout, islandHeight, farShipLayout, fbm } from './terrain.js';

// Scenery and weather for the mission looks (see looks.js). Everything is generated at load from seeded noise: no textures
// or assets, so the offline file stays self-contained. These things stand still in the world, so they are a yardstick for
// speed and height; `environment.js` re-places them every frame around a far-flying camera (the `userData.base` of each
// child), and they are only ever drawn through the scene's fog, so a wrap jump happens while they are fogged out.

// --- islands -------------------------------------------------------------------------------------------------------
// Low-poly heightfields (the land itself is in terrain.js, which the flight model also reads): a pale beach, scrub, then
// bare rock on the steep and high parts, with the sun's side lit by the slope (baked into vertex colours, no lights).
const SUN_L = new THREE.Vector3(-0.5, 0.62, 0.55).normalize();

function islandGeometry(isl) {
  const SEG = 40;
  const RINGS = 14;
  const { radius, height } = isl;
  const pos = [];
  const idx = [];
  for (let j = 0; j <= RINGS; j++) {
    const r = (j / RINGS) * radius * 1.3;
    for (let i = 0; i < SEG; i++) {
      const th = (i / SEG) * Math.PI * 2;
      const x = Math.cos(th) * r;
      const z = Math.sin(th) * r;
      pos.push(x, islandHeight(isl, x, z), z);
    }
  }
  for (let j = 0; j < RINGS; j++) {
    for (let i = 0; i < SEG; i++) {
      const a = j * SEG + i;
      const b = j * SEG + ((i + 1) % SEG);
      const c = (j + 1) * SEG + i;
      const d = (j + 1) * SEG + ((i + 1) % SEG);
      idx.push(a, c, b, b, c, d);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const n = geo.attributes.normal;
  const col = [];
  for (let v = 0; v < pos.length / 3; v++) {
    const y = pos[v * 3 + 1];
    const slope = 1 - n.getY(v);
    const lit = 0.55 + 0.6 * Math.max(0, n.getX(v) * SUN_L.x + n.getY(v) * SUN_L.y + n.getZ(v) * SUN_L.z);
    let c;
    if (y < 3) c = [0.5, 0.45, 0.32]; // sand and wet rock at the waterline
    else if (y < height * 0.55 && slope < 0.42) c = [0.12, 0.2, 0.09].map((x, k) => x + 0.04 * k * fbm(pos[v * 3] * 0.02, pos[v * 3 + 2] * 0.02)); // scrub
    else c = [0.3, 0.27, 0.24]; // rock
    col.push(c[0] * lit, c[1] * lit, c[2] * lit);
  }
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  return geo;
}

export function createIslands(count) {
  const group = new THREE.Group();
  const mat = new THREE.MeshBasicMaterial({ vertexColors: true });
  for (const isl of islandLayout(count)) {
    const m = new THREE.Mesh(islandGeometry(isl), mat);
    m.position.set(isl.x, 0, isl.z);
    m.userData.base = m.position.clone();
    m.frustumCulled = false;
    group.add(m);
  }
  return group;
}

// --- far ships -----------------------------------------------------------------------------------------------------
// Merchant ships on the horizon: a dark hull, a white block aft and a funnel. Still, but a ship that far off would hardly
// move in a minute anyway.
export function createFarShips(count) {
  const group = new THREE.Group();
  const hull = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.09, 0.07, 0.07) });
  const red = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.35, 0.06, 0.05) });
  const white = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.75, 0.75, 0.72) });
  const box = (w, h, d, mat, x, y, z) => { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat); m.position.set(x, y, z); return m; };
  for (const sh of farShipLayout(count)) {
    const s = new THREE.Group();
    const L = sh.length;
    s.add(box(L, 14, 24, hull, 0, 5, 0), box(L * 0.97, 3, 23, red, 0, -1, 0), box(L * 0.14, 20, 20, white, -L * 0.36, 17, 0), box(6, 10, 8, red, -L * 0.36, 30, 0));
    s.position.set(sh.x, 0, sh.z);
    s.rotation.y = sh.heading;
    s.userData.base = s.position.clone();
    group.add(s);
  }
  return group;
}

// --- buoys ---------------------------------------------------------------------------------------------------------
// A scatter of channel-marker buoys over the sea near the camera, for judging speed and height when flying low: a grid
// of cells with a jitter, wrapped around the camera so there are always some under it. Each bobs a little (a function of
// the scene time, so it scrubs). Instanced: one draw call.
export function createBuoys(count) {
  const n = Math.ceil(Math.sqrt(count));
  const CELL = 700;
  const PERIOD = n * CELL;
  const rng = mulberry32(31337);
  const geo = new THREE.CylinderGeometry(0.25, 1.1, 3.4, 10);
  geo.translate(0, 1.7, 0);
  const mat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const mesh = new THREE.InstancedMesh(geo, mat, n * n);
  mesh.frustumCulled = false;
  const base = [];
  const colours = [new THREE.Color(0.9, 0.18, 0.1), new THREE.Color(0.95, 0.55, 0.05), new THREE.Color(0.1, 0.4, 0.15), new THREE.Color(0.9, 0.85, 0.2)];
  for (let i = 0; i < n * n; i++) {
    base.push({ x: ((i % n) + rng()) * CELL, z: (Math.floor(i / n) + rng()) * CELL, ph: rng() * 6.28, s: 1.6 + rng() * 1.2 });
    // the ship's lane (z within 70 m of her track, which runs along +X) stays clear: wrapped, the buoy would stand in it
    if (Math.abs(((base[i].z + PERIOD / 2) % PERIOD) - PERIOD / 2) < 70) base[i].z += 140;
    mesh.setColorAt(i, colours[Math.floor(rng() * colours.length)]);
  }
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const p = new THREE.Vector3();
  const sc = new THREE.Vector3();
  return {
    mesh,
    follow(cam, t) {
      for (let i = 0; i < base.length; i++) {
        const b = base[i];
        p.set(b.x + Math.round((cam.x - b.x) / PERIOD) * PERIOD, 0.15 + 0.25 * Math.sin(t * 1.3 + b.ph), b.z + Math.round((cam.z - b.z) / PERIOD) * PERIOD);
        e.set(0.08 * Math.sin(t * 0.9 + b.ph), 0, 0.08 * Math.cos(t * 1.1 + b.ph));
        q.setFromEuler(e);
        sc.setScalar(b.s);
        m.compose(p, q, sc);
        mesh.setMatrixAt(i, m);
      }
      mesh.instanceMatrix.needsUpdate = true;
    },
  };
}

// --- weather -------------------------------------------------------------------------------------------------------
// Rain squalls: a dark cloud mass with a curtain of streaks falling to the sea, standing on the horizon. Low cloud banks:
// long pale mounds sitting on the water. Both are sprites with their base on the sea, tinted by the sky and veiled toward
// the horizon colour with distance (they ignore the scene fog, being made of it).
function squallTexture() {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 512;
  const ctx = c.getContext('2d');
  const r = mulberry32(8);
  // the rain curtain: vertical streaks, strongest under the cloud, thinning toward the sea
  for (let i = 0; i < 260; i++) {
    const x = 20 + r() * 216;
    const w = 0.6 + r() * 1.4;
    const y0 = 130 + r() * 40;
    const y1 = 330 + r() * 180;
    const g = ctx.createLinearGradient(0, y0, 0, y1);
    g.addColorStop(0, `rgba(190,200,210,${0.1 + r() * 0.22})`);
    g.addColorStop(1, 'rgba(190,200,210,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x, y0, w, y1 - y0);
  }
  // the cloud mass above it: dark, lumpy and soft
  for (let i = 0; i < 90; i++) {
    const x = 20 + r() * 216;
    const y = 30 + r() * 120;
    const rad = 22 + r() * 40;
    const g = ctx.createRadialGradient(x, y, 0, x, y, rad);
    const k = 70 + Math.floor(r() * 60);
    g.addColorStop(0, `rgba(${k},${k + 6},${k + 16},0.85)`);
    g.addColorStop(1, `rgba(${k},${k + 6},${k + 16},0)`);
    ctx.fillStyle = g;
    ctx.fillRect(x - rad, y - rad, rad * 2, rad * 2);
  }
  // a soft edge all round, so the sprite has no visible rectangle
  ctx.globalCompositeOperation = 'destination-in';
  const side = ctx.createLinearGradient(0, 0, 256, 0);
  side.addColorStop(0, 'rgba(0,0,0,0)');
  side.addColorStop(0.18, 'rgba(0,0,0,1)');
  side.addColorStop(0.82, 'rgba(0,0,0,1)');
  side.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = side;
  ctx.fillRect(0, 0, 256, 512);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
function bankTexture() {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 128;
  const ctx = c.getContext('2d');
  const r = mulberry32(21);
  for (let i = 0; i < 80; i++) {
    const x = 40 + r() * 432;
    const y = 128 - 10 - r() * 60 * Math.sin(((x - 40) / 432) * Math.PI);
    const rad = 14 + r() * 32;
    const g = ctx.createRadialGradient(x, y, 0, x, y, rad);
    g.addColorStop(0, 'rgba(245,245,248,0.5)');
    g.addColorStop(1, 'rgba(245,245,248,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x - rad, y - rad, rad * 2, rad * 2);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function createWeatherSprites(squalls, banks, overcast, horizon, fogFar) {
  const rng = mulberry32(555);
  const group = new THREE.Group();
  const squallTex = squalls ? squallTexture() : null;
  const bankTex = banks ? bankTexture() : null;
  const veil = (base, dist) => base.clone().lerp(horizon, Math.min(0.9, (dist / fogFar) ** 1.3)); // farther off, nearer the horizon's colour, as the fog does
  const place = (sprite, a, d, w, h) => {
    sprite.center.set(0.5, 0);
    sprite.position.set(Math.cos(a) * d, -30, Math.sin(a) * d);
    sprite.scale.set(w, h, 1);
    sprite.userData.base = sprite.position.clone();
    sprite.userData.opacity = sprite.material.opacity;
    group.add(sprite);
  };
  for (let i = 0; i < squalls; i++) {
    const a = (i / squalls) * Math.PI * 2 + rng() * 0.9;
    const d = fogFar * (0.42 + rng() * 0.38); // inside the fog's reach, so a squall is never a dark card over water that has already faded out
    const dark = horizon.clone().multiplyScalar(0.4 + 0.3 * (1 - overcast));
    const gl = (dark.r + dark.g + dark.b) / 3;
    dark.lerp(new THREE.Color(gl, gl, gl * 1.08), 0.55); // a squall is slate grey, whatever the sunset
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: squallTex, transparent: true, depthWrite: false, fog: false, opacity: 0.88, color: veil(dark, d),
    }));
    const w = 3500 + rng() * 3500;
    place(sprite, a, d, w, w * (0.5 + 0.2 * rng()));
  }
  for (let i = 0; i < banks; i++) {
    const a = rng() * Math.PI * 2;
    const d = fogFar * (0.3 + rng() * 0.55);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: bankTex, transparent: true, depthWrite: false, fog: false, opacity: 0.55 + rng() * 0.25,
      color: veil(horizon.clone().multiplyScalar(1.05), d),
    }));
    const w = 4500 + rng() * 5000;
    place(sprite, a, d, w, w * (0.12 + 0.05 * rng()));
  }
  return group;
}

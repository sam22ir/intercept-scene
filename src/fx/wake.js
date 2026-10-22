// A ship's wake, as a real one: ribbons laid along the track she has sailed over the last minute. One per ship; it
// draws from a ship's state (time, position, heading, turn rate, speed), so the same code serves Solo Air Defense
// and the ship duel's two frigates.
//  core   the propeller wash right behind the stern: dense white foam, streaky along the track, thinning out
//  slick  the wide turbulent water round it: faint and pale, lasting longer
// The foam is a generated texture laid still on the water (its length runs along the track), so it stays where she left it:
// the patches do not travel with her. They curve with her turns, because they follow the track.
import * as THREE from 'three';

const WAKE_N = 90;
const WAKE_DT = 0.6;
const WAKE_SPAN = WAKE_N * WAKE_DT; // s of track kept
const STERN = 56; // m from her centre to the stern

function foamTexture() {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = 'rgba(255, 255, 255, 0.38)';
  g.fillRect(0, 0, 256, 256);
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 1500; i++) {
    const x = rnd() * 256;
    const y = rnd() * 256;
    const r = 1.5 + rnd() * rnd() * 14;
    const a = 0.12 + rnd() * 0.7;
    for (const [dx, dy] of [[0, 0], [256, 0], [-256, 0], [0, 256], [0, -256]]) { // wrapped, so it tiles
      const grd = g.createRadialGradient(x + dx, y + dy, 0, x + dx, y + dy, r);
      grd.addColorStop(0, `rgba(255, 255, 255, ${a})`);
      grd.addColorStop(1, 'rgba(255, 255, 255, 0)');
      g.fillStyle = grd;
      g.fillRect(x + dx - r, y + dy - r, 2 * r, 2 * r);
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// A ribbon of `sections` cross-sections of three vertices (left edge, centre, right edge): edges transparent, so it has soft sides.
function makeRibbon(foam, sections, order) {
  const pos = new Float32Array(sections * 9);
  const col = new Float32Array(sections * 12);
  const uv = new Float32Array(sections * 6);
  const index = [];
  for (let i = 0; i < sections - 1; i++) {
    const a = i * 3;
    const b = a + 3;
    index.push(a, a + 1, b, a + 1, b + 1, b, a + 1, a + 2, b + 1, a + 2, b + 2, b + 1);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 4));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(index);
  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: foam, vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide }));
  mesh.frustumCulled = false;
  mesh.renderOrder = order;
  return { pos, col, uv, geo, sections, mesh };
}

// Writes cross-section k of a ribbon: centre (cx, cz), across-track direction (px, pz), half width, alpha, rgb, texture coordinates.
function ribbonSection(r, k, cx, cz, px, pz, half, alpha, rgb, v, vScale, y) {
  r.pos.set([cx + px * half, y, cz + pz * half, cx, y, cz, cx - px * half, y, cz - pz * half], k * 9);
  r.col.set([rgb[0], rgb[1], rgb[2], 0, rgb[0], rgb[1], rgb[2], alpha, rgb[0], rgb[1], rgb[2], 0], k * 12);
  r.uv.set([0, v / vScale, 0.5, v / vScale, 1, v / vScale], k * 6);
}
function hideSection(r, k) { r.col.fill(0, k * 12, k * 12 + 12); }
const CORE_RGB = [1, 1, 1];
const SLICK_RGB = [0.8, 0.92, 0.98];

export function createWake(scene) {
  const foam = foamTexture();
  const core = makeRibbon(foam, WAKE_N, 2);
  const slick = makeRibbon(foam, WAKE_N, 1);
  scene.add(core.mesh, slick.mesh);
  const hist = [];
  let last = -Infinity;
  let pathLen = 0; // m sailed since the start: the texture's coordinate along the track
  let lastX = null;
  let lastZ = null;
  const clear = () => { hist.length = 0; last = -Infinity; pathLen = 0; lastX = null; };
  // `s` is the ship: { t, x, z, psi, r, u } (the time, her position, heading, turn rate and speed).
  function update(s) {
    if (s.t < last) clear();
    if (lastX !== null) pathLen += Math.hypot(s.x - lastX, s.z - lastZ);
    lastX = s.x;
    lastZ = s.z;
    const cs = Math.cos(s.psi);
    const sn = Math.sin(s.psi);
    const sx = s.x - cs * STERN;
    const sz = s.z - sn * STERN;
    if (s.t - last >= WAKE_DT) {
      hist.unshift({ x: sx, z: sz, psi: s.psi, t: s.t, s: pathLen, turn: Math.min(Math.abs(s.r) / 0.09, 1.4), u: Math.max(s.u, 0) });
      if (hist.length > WAKE_N) hist.pop();
      last = s.t;
    }
    for (let i = 0; i < WAKE_N; i++) {
      const h = hist[i];
      if (!h) { hideSection(core, i); hideSection(slick, i); continue; }
      const age = s.t - h.t;
      const u = Math.min(age / WAKE_SPAN, 1);
      const psi = i === 0 ? s.psi : h.psi; // the newest section is at the stern, wherever she is now
      const px = -Math.sin(psi);
      const pz = Math.cos(psi);
      const bx = i === 0 ? sx : h.x;
      const bz = i === 0 ? sz : h.z;
      const len = i === 0 ? pathLen : h.s;
      const sf = Math.min(h.u / 7, 1); // no wash to speak of at a crawl
      // The wash: narrow and dense, the foam thinning out over the minute; wider and stronger in a hard turn.
      ribbonSection(core, i, bx, bz, px, pz, (4.5 + 6.5 * Math.sqrt(u)) * (1 + 0.5 * h.turn), Math.min(1.0 * (1 - u) ** 1.2 * sf * (1 + 0.3 * h.turn), 1), CORE_RGB, len, 40, 0.45);
      // The slick: the turbulent water round it.
      ribbonSection(slick, i, bx, bz, px, pz, 4 + 17 * Math.pow(u, 0.55), 0.34 * (1 - u) ** 1.2 * sf, SLICK_RGB, len, 90, 0.4);
    }
    for (const r of [core, slick]) {
      r.geo.attributes.position.needsUpdate = true;
      r.geo.attributes.color.needsUpdate = true;
      r.geo.attributes.uv.needsUpdate = true;
    }
  }
  // Wipes the track and hides the ribbons (a ship that has gone, until update() draws her wake again).
  const hide = () => {
    clear();
    for (let i = 0; i < WAKE_N; i++) { hideSection(core, i); hideSection(slick, i); }
    for (const r of [core, slick]) {
      r.geo.attributes.position.needsUpdate = true;
      r.geo.attributes.color.needsUpdate = true;
      r.geo.attributes.uv.needsUpdate = true;
    }
  };
  return { update, clear, hide };
}

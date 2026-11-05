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

// The `kelvin` wake (the ship duel), drawn after aerial photos of boats under way: a churned white wash with two
// propeller bands down its middle, and the two divergent arms of the Kelvin wave fanning out from the bow in a V.
// All of it follows the speed she had when she made it: at a crawl there is next to nothing; at flank the wash is wide
// and bright, the arms are crisp, run long and the V narrows a little.
const BOW = 52; // m from her centre to the bow shoulder, where the arms start
const U_FULL = 38 * 0.514444; // m/s: the duel player's flank (the other ships top out lower)
const KELVIN_SLOW = 19.5 * Math.PI / 180; // half-angle of the V (the Kelvin angle)
const KELVIN_FAST = 15.5 * Math.PI / 180; // narrower at flank, as in the photos

// The wash: across the ribbon two bright propeller bands; along it, foam drawn out in streaks (v runs along the track).
function washTexture() {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 256;
  const g = c.getContext('2d');
  for (let x = 0; x < 256; x++) {
    const f = x / 255;
    const band = Math.exp(-(((f - 0.36) / 0.09) ** 2)) + Math.exp(-(((f - 0.64) / 0.09) ** 2));
    g.fillStyle = `rgba(255, 255, 255, ${0.3 + 0.45 * band})`;
    g.fillRect(x, 0, 1, 256);
  }
  let seed = 11;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 1800; i++) {
    const x = 10 + rnd() * 236;
    const y = rnd() * 256;
    const r = 1.5 + rnd() * rnd() * 9;
    const k = 2.5 + rnd() * 4; // drawn out along the track
    const a = 0.1 + rnd() * 0.6;
    for (const dy of [0, 256, -256]) {
      g.save();
      g.translate(x, y + dy);
      g.scale(1, k);
      const grd = g.createRadialGradient(0, 0, 0, 0, 0, r);
      grd.addColorStop(0, `rgba(255, 255, 255, ${a})`);
      grd.addColorStop(1, 'rgba(255, 255, 255, 0)');
      g.fillStyle = grd;
      g.fillRect(-r, -r, 2 * r, 2 * r);
      g.restore();
    }
  }
  // dark gaps of clear water torn through the foam
  g.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < 260; i++) {
    const x = rnd() * 256;
    const y = rnd() * 256;
    const r = 2 + rnd() * 6;
    for (const dy of [0, 256, -256]) {
      g.save();
      g.translate(x, y + dy);
      g.scale(1, 2 + rnd() * 3);
      const grd = g.createRadialGradient(0, 0, 0, 0, 0, r);
      grd.addColorStop(0, 'rgba(0, 0, 0, 0.55)');
      grd.addColorStop(1, 'rgba(0, 0, 0, 0)');
      g.fillStyle = grd;
      g.fillRect(-r, -r, 2 * r, 2 * r);
      g.restore();
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// The arms: a broken line of short crests slanting across it, like the feathered V lines in the photos.
function crestTexture() {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 256;
  const g = c.getContext('2d');
  let seed = 5;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  g.lineCap = 'round';
  for (let i = 0; i < 420; i++) {
    const x = 64 + (rnd() + rnd() + rnd() - 1.5) * 50; // gathered on the arm's line
    const y = rnd() * 256;
    const len = 6 + rnd() * 22;
    const ang = 0.9 + (rnd() - 0.5) * 0.5; // slanting across the arm
    const dx = Math.sin(ang) * len * 0.5;
    const dy = Math.cos(ang) * len * 0.5;
    g.strokeStyle = `rgba(255, 255, 255, ${0.15 + rnd() * 0.6})`;
    g.lineWidth = 1 + rnd() * 3;
    for (const oy of [0, 256, -256]) {
      g.beginPath();
      g.moveTo(x - dx, y - dy + oy);
      g.lineTo(x + dx, y + dy + oy);
      g.stroke();
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const smooth = (a, b, x) => { const k = Math.min(Math.max((x - a) / (b - a), 0), 1); return k * k * (3 - 2 * k); };

export function createWake(scene, { kelvin = false } = {}) {
  const foam = foamTexture();
  const core = makeRibbon(kelvin ? washTexture() : foam, WAKE_N, 2);
  const slick = makeRibbon(foam, WAKE_N, 1);
  scene.add(core.mesh, slick.mesh);
  const crest = kelvin ? crestTexture() : null;
  const arms = kelvin ? [makeRibbon(crest, WAKE_N, 3), makeRibbon(crest, WAKE_N, 3)] : [];
  for (const a of arms) scene.add(a.mesh);
  const ribbons = [core, slick, ...arms];
  if (kelvin) for (const r of [core, ...arms]) r.mesh.material.toneMapped = false; // foam is white, not the tone-mapped grey
  const ax = new Float32Array(WAKE_N);
  const az = new Float32Array(WAKE_N);
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
      hist.unshift({ x: sx, z: sz, bx: s.x + cs * BOW, bz: s.z + sn * BOW, psi: s.psi, t: s.t, s: pathLen, turn: Math.min(Math.abs(s.r) / 0.09, 1.4), u: Math.max(s.u, 0) });
      if (hist.length > WAKE_N) hist.pop();
      last = s.t;
    }
    if (kelvin) {
      kelvinUpdate(s, cs, sn, sx, sz);
      flush();
      return;
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
    flush();
  }
  function flush() {
    for (const r of ribbons) {
      r.geo.attributes.position.needsUpdate = true;
      r.geo.attributes.color.needsUpdate = true;
      r.geo.attributes.uv.needsUpdate = true;
    }
  }
  // The photo wake. Each sample keeps the speed she had when she passed there, so a burst of speed leaves a bright,
  // wide stretch of wake behind her and a slow stretch stays faint and narrow, as it does on the water.
  function kelvinUpdate(s, cs, sn, sx, sz) {
    for (let i = 0; i < WAKE_N; i++) {
      const h = hist[i];
      if (!h) { for (const r of ribbons) hideSection(r, i); continue; }
      const age = s.t - h.t;
      const u = Math.min(age / WAKE_SPAN, 1);
      const sp = Math.min(h.u / U_FULL, 1); // 0 stopped, 1 flank
      const psi = i === 0 ? s.psi : h.psi;
      const px = -Math.sin(psi);
      const pz = Math.cos(psi);
      const bx = i === 0 ? sx : h.x;
      const bz = i === 0 ? sz : h.z;
      const len = i === 0 ? pathLen : h.s;
      // The wash: its whiteness and width grow with speed, it spreads and thins as it ages, wider in a hard turn.
      const washA = Math.min(smooth(0.04, 0.45, sp) * (1 - u) ** 1.4 * (1 + 0.25 * h.turn), 1);
      const washW = (5 + 5 * sp + (5 + 14 * sp) * Math.sqrt(u)) * (1 + 0.45 * h.turn);
      ribbonSection(core, i, bx, bz, px, pz, washW, washA, CORE_RGB, len, 22 + 20 * sp, 0.45);
      // The slick: the pale churned water round the wash, wider at speed.
      ribbonSection(slick, i, bx, bz, px, pz, (6 + 10 * sp) + (10 + 34 * sp) * Math.pow(u, 0.55), 0.32 * (1 - u) ** 1.3 * smooth(0.03, 0.4, sp), SLICK_RGB, len, 90, 0.4);
    }
    // The Kelvin arms: a wave made at the bow when she was `d` m back along her track has spread `d tan(theta)` to
    // each side by now, so the arms are her past bow positions pushed out sideways. They curve with her turns.
    const n = Math.min(hist.length, WAKE_N);
    for (let side = 0; side < 2; side++) {
      const r = arms[side];
      const sg = side === 0 ? 1 : -1;
      for (let i = 0; i < n; i++) {
        const h = hist[i];
        const d = i === 0 ? 0 : Math.max(pathLen - h.s, 0);
        const sp = Math.min(h.u / U_FULL, 1);
        const th = KELVIN_SLOW + (KELVIN_FAST - KELVIN_SLOW) * Math.min(sp, 1);
        const psi = i === 0 ? s.psi : h.psi;
        const ox = i === 0 ? s.x + cs * BOW : h.bx;
        const oz = i === 0 ? s.z + sn * BOW : h.bz;
        const off = sg * (d * Math.tan(th) + 4); // starts at the bow's shoulder, not on the stem
        ax[i] = ox - Math.sin(psi) * off;
        az[i] = oz + Math.cos(psi) * off;
      }
      for (let i = 0; i < WAKE_N; i++) {
        if (i >= n) { hideSection(r, i); continue; }
        const h = hist[i];
        const age = s.t - h.t;
        const u = Math.min(age / WAKE_SPAN, 1);
        const d = i === 0 ? 0 : Math.max(pathLen - h.s, 0);
        const sp = Math.min(h.u / U_FULL, 1);
        // across the arm: square to the line through its neighbours
        const i0 = Math.max(i - 1, 0);
        const i1 = Math.min(i + 1, n - 1);
        let tx = ax[i0] - ax[i1];
        let tz = az[i0] - az[i1];
        const tl = Math.hypot(tx, tz) || 1;
        tx /= tl;
        tz /= tl;
        // white water hugging the bow, then a crisp crest line that fades as it spreads and ages
        const bowWave = 1 + 0.9 * Math.exp(-d / 35);
        const a = 1.1 * smooth(0.08, 0.55, sp) * (1 - u) ** 1.6 * bowWave * smooth(0, 8, d + 2);
        const half = Math.min(2.5 + d * (0.03 + 0.03 * sp), 22);
        ribbonSection(r, i, ax[i], az[i], -tz, tx, half, Math.min(a, 1), CORE_RGB, d, 34, 0.5);
      }
    }
  }
  // Wipes the track and hides the ribbons (a ship that has gone, until update() draws her wake again).
  const hide = () => {
    clear();
    for (let i = 0; i < WAKE_N; i++) for (const r of ribbons) hideSection(r, i);
    flush();
  };
  return { update, clear, hide };
}

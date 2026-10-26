import * as THREE from 'three';
import { Kit } from './models/kit.js';

// The ships of the port of Zabana, procedural (no textures): the merchant ships the player handles in the standard manoeuvres (the
// cargo, the coaster, the general cargo ship, the tanker, the Ro-Ro ferry), the trawler, and the traffic's tugs, pilot boat and
// yachts. Ship frame as the frigate's: x ahead, y up (the sea is y = 0), z to starboard. `createVessel(type, { L, B })` returns a
// group whose `userData.bridge` is the wheelhouse eye [x, y] in that frame (the bridge views put the camera there).

const mats = new Map();
const paint = (hex, rough = 0.72, metal = 0.12) => {
  const k = `${hex}/${rough}/${metal}`;
  if (!mats.has(k)) mats.set(k, new THREE.MeshStandardMaterial({ color: hex, roughness: rough, metalness: metal }));
  return mats.get(k);
};
const GLASS = () => paint(0x16222c, 0.25, 0.5);
// The glass of a ship's windows (one shared material): the bridge views hide her own, which stands right in front of the eye.
export const glassOf = (group) => group.children.filter((m) => m.material === GLASS());

// A hull seen from above (bow +x), extruded from y0 up to y1: a parallel middle body, a fine bow over `bow` of her length, a
// rounded stern.
function hullGeo(L, B, y0, y1, bow = 0.2) {
  const s = new THREE.Shape();
  const H = L / 2, W = B / 2, xb = H - L * bow;
  s.moveTo(-H, -W * 0.86);
  s.quadraticCurveTo(-H + W * 0.3, -W, -H + W * 0.9, -W);
  s.lineTo(xb, -W);
  s.quadraticCurveTo(H * 0.97, -W * 0.72, H, 0);
  s.quadraticCurveTo(H * 0.97, W * 0.72, xb, W);
  s.lineTo(-H + W * 0.9, W);
  s.quadraticCurveTo(-H + W * 0.3, W, -H, W * 0.86);
  s.lineTo(-H, -W * 0.86);
  const g = new THREE.ExtrudeGeometry(s, { depth: y1 - y0, bevelEnabled: false, curveSegments: 8 });
  g.rotateX(-Math.PI / 2);
  g.translate(0, y0, 0);
  return g;
}
const box = (k, m, w, h, d, x, y, z, ry = 0) => k.add(new THREE.BoxGeometry(w, h, d), m, { pos: [x, y + h / 2, z], rot: [0, ry, 0] });

// A deckhouse: tiers of white decks with a dark window band, bridge wings on the top tier, a funnel behind with the company's band.
function house(k, { x, len, B, y0, tiers, tierH = 2.8, funnel = 0xc23b2b, wings = true }) {
  const white = paint(0xeceeec, 0.6), glass = GLASS();
  let y = y0;
  for (let i = 0; i < tiers; i++) {
    const l = len * (1 - i * 0.05), w = B * (i === tiers - 1 ? 0.86 : 0.8);
    box(k, white, l, tierH, w, x, y, 0);
    box(k, glass, l + 0.12, 0.9, w + 0.12, x, y + tierH * 0.45, 0);
    y += tierH;
  }
  if (wings) box(k, white, 3.2, 0.5, B * 1.02, x + len * 0.42, y - tierH - 0.3, 0); // the bridge wings, at the wheelhouse floor
  box(k, glass, 0.3, 1.4, B * 0.8, x + len * 0.5 * (1 - (tiers - 1) * 0.05), y - tierH * 0.55, 0); // the bridge windows
  const fx = x - len * 0.42;
  k.add(new THREE.CylinderGeometry(B * 0.11, B * 0.13, 7, 14), white, { pos: [fx, y + 3.5, 0] });
  k.add(new THREE.CylinderGeometry(B * 0.112, B * 0.112, 1.6, 14), paint(funnel, 0.55), { pos: [fx, y + 4.6, 0] });
  k.add(new THREE.CylinderGeometry(B * 0.114, B * 0.114, 0.8, 14), paint(0x1c1c1c, 0.6), { pos: [fx, y + 6.8, 0] });
  k.rod([x, y, 0], [x, y + 7, 0], 0.2, paint(0x3a3f44, 0.5, 0.5)); // the radar mast
  box(k, paint(0x3a3f44, 0.5, 0.5), 0.4, 0.25, 4, x, y + 6, 0);
  return y; // the top of the house
}

function merchant(kind, L, B) {
  const k = new Kit();
  const T = kind === 'tanker' ? 0.055 * L : 0.045 * L; // the draught shown below the water
  const D = kind === 'ferry' ? 0.06 * L : 0.05 * L + 2; // the freeboard to the main deck
  const hullC = { cargo: 0x2f3e4a, general: 0x6b2f2a, coaster: 0x274d3a, tanker: 0x3a2f2c, ferry: 0xf2f2ee }[kind];
  k.add(hullGeo(L, B, -T, D, kind === 'ferry' ? 0.24 : 0.18), paint(hullC, 0.7));
  k.add(hullGeo(L * 1.004, B * 1.01, -T - 0.05, 0.6, kind === 'ferry' ? 0.24 : 0.18), paint(kind === 'ferry' ? 0x1d3a5c : 0x8a2a22, 0.75)); // boot topping
  k.add(hullGeo(L * 0.985, B * 0.96, D, D + 0.15, 0.18), paint(kind === 'tanker' ? 0x8a3a2a : 0x5a5f63, 0.85)); // the deck
  const steel = paint(0x30363b, 0.55, 0.4), yellow = paint(0xd9a72a, 0.6, 0.3);
  let bridge = [0, 0];
  if (kind === 'ferry') {
    // the Ro-Ro ferry: a tall superstructure over most of her length, the bridge forward, the stern door aft
    const white = paint(0xeef0ee, 0.6), dark = GLASS(), navy = paint(0x1d3a5c, 0.6);
    const decks = [[-0.42, 0.3, 4], [-0.36, 0.26, 3], [-0.28, 0.2, 3]];
    let y = D;
    for (const [a, b, h] of decks) {
      box(k, white, (b - a) * L, h, B * 0.94, ((a + b) / 2) * L, y, 0);
      box(k, dark, (b - a) * L + 0.2, 1.1, B * 0.95, ((a + b) / 2) * L, y + h * 0.5, 0);
      y += h;
    }
    box(k, white, 12, 3.4, B * 0.86, 0.26 * L, y, 0); // the bridge
    box(k, dark, 0.3, 1.5, B * 0.8, 0.26 * L + 6.1, y + 1.4, 0);
    box(k, white, 3, 0.5, B * 1.04, 0.29 * L, y - 0.3, 0); // wings, at the wheelhouse floor
    bridge = [0.26 * L + 4.5, y + 1.9];
    k.add(new THREE.CylinderGeometry(3, 3.6, 9, 14), white, { pos: [-0.2 * L, y + 4.5, 0] });
    k.add(new THREE.CylinderGeometry(3.05, 3.05, 1.8, 14), navy, { pos: [-0.2 * L, y + 7, 0] });
    box(k, paint(0x9aa0a4, 0.6, 0.4), 1, D - 0.5, B * 0.6, -L / 2 - 0.2, 0.5, 0); // the stern door
  } else {
    const hx = kind === 'coaster' || kind === 'general' ? -0.36 * L : -0.38 * L;
    const top = house(k, { x: hx, len: Math.min(0.12 * L, 22), B, y0: D, tiers: kind === 'tanker' ? 5 : 4, funnel: kind === 'tanker' ? 0x1f5fa8 : 0xc23b2b });
    bridge = [hx + Math.min(0.12 * L, 22) * 0.38, top - 1.4];
    if (kind === 'tanker') {
      // the pipe deck: pipes along her length, the catwalk, the manifold and its crane amidships
      for (const z of [-B * 0.18, -B * 0.06, B * 0.06, B * 0.18]) k.rod([hx + 14, D + 0.9, z], [0.42 * L, D + 0.9, z], 0.35, paint(0x6c7378, 0.5, 0.5));
      box(k, steel, 0.42 * L - hx - 14, 0.3, 1.2, (hx + 14 + 0.42 * L) / 2, D + 2.4, 0);
      box(k, paint(0xa33a2a, 0.6), 4, 2.4, B * 0.7, 0, D + 0.15, 0);
      k.rod([0, D, B * 0.3], [0, D + 9, B * 0.3], 0.4, yellow);
      k.rod([0, D + 9, B * 0.3], [8, D + 7, B * 0.1], 0.25, yellow);
    } else {
      // hatch covers between cranes (cargo, general), or a container stack (coaster)
      const x0 = hx + 0.1 * L, x1 = 0.4 * L, n = kind === 'general' ? 3 : kind === 'coaster' ? 4 : 5;
      const step = (x1 - x0) / n;
      const BOXC = [0xb03a2e, 0x2e6db0, 0xd9a72a, 0x2e8b57, 0x8a8f94, 0xd8d8d0];
      for (let i = 0; i < n; i++) {
        const cx = x0 + step * (i + 0.5);
        if (kind === 'coaster') {
          for (let r = -1; r <= 1; r++) for (let t = 0; t < 2 + ((i + r) % 2); t++) box(k, paint(BOXC[(i * 3 + r + 5 + t) % BOXC.length], 0.7, 0.3), step * 0.9, 2.5, B * 0.28, cx, D + 0.15 + t * 2.55, r * B * 0.3);
        } else {
          box(k, paint(kind === 'general' ? 0x3a6b8a : 0x8a5a2a, 0.7, 0.2), step * 0.78, 1.4, B * 0.72, cx, D + 0.15, 0);
        }
        if (kind !== 'coaster' && i < n - 1) { // a deck crane between the hatches
          const kx = cx + step * 0.5;
          k.add(new THREE.CylinderGeometry(0.9, 1.1, 8, 10), yellow, { pos: [kx, D + 4, B * 0.2] });
          k.rod([kx, D + 8, B * 0.2], [kx + step * 0.42, D + 11, B * 0.05], 0.3, yellow);
        }
      }
    }
    k.rod([0.45 * L, D, 0], [0.45 * L, D + 9, 0], 0.25, steel); // the foremast
  }
  const g = k.build({ name: kind });
  g.userData.bridge = bridge;
  return g;
}

function trawler(L = 25, B = 7.5) {
  const k = new Kit();
  const blue = paint(0x2d6db5, 0.6), white = paint(0xf2f2ee, 0.6), red = paint(0xb43a2a, 0.7), steel = paint(0x40464b, 0.5, 0.4);
  k.add(hullGeo(L, B, -2.4, 2.2, 0.32), blue);
  k.add(hullGeo(L * 1.01, B * 1.02, -2.45, 0.3, 0.32), red);
  box(k, white, L * 0.24, 2.6, B * 0.7, L * 0.16, 2.2, 0); // the wheelhouse, forward
  box(k, GLASS(), L * 0.245, 0.8, B * 0.71, L * 0.16, 3.6, 0);
  box(k, white, L * 0.16, 1.4, B * 0.6, L * 0.16, 4.8, 0);
  k.rod([-L * 0.42, 2.2, -B * 0.42], [-L * 0.42, 7.5, -B * 0.42], 0.18, steel); // the gantry aft
  k.rod([-L * 0.42, 2.2, B * 0.42], [-L * 0.42, 7.5, B * 0.42], 0.18, steel);
  k.rod([-L * 0.42, 7.5, -B * 0.42], [-L * 0.42, 7.5, B * 0.42], 0.18, steel);
  k.rod([L * 0.02, 2.2, 0], [L * 0.02, 9, 0], 0.15, steel); // the mast and its outriggers
  k.rod([L * 0.02, 7.5, 0], [L * 0.02 - 2, 5.5, B * 1.4], 0.08, steel);
  k.rod([L * 0.02, 7.5, 0], [L * 0.02 - 2, 5.5, -B * 1.4], 0.08, steel);
  const g = k.build({ name: 'trawler' });
  g.userData.bridge = [L * 0.2, 4.3];
  return g;
}
function tug(L = 30, B = 10) {
  const k = new Kit();
  const red = paint(0xa8281e, 0.6), black = paint(0x1a1c1e, 0.7), white = paint(0xe8e8e2, 0.6), tyre = paint(0x111111, 0.9, 0);
  k.add(hullGeo(L, B, -3, 2.4, 0.35), black);
  k.add(hullGeo(L * 0.99, B * 0.98, 1.4, 3.0, 0.35), red);
  box(k, white, 9, 3, 6.5, 3, 3, 0);
  box(k, white, 5.5, 2.4, 6.8, 4, 6, 0);
  box(k, GLASS(), 5.6, 0.9, 6.9, 4, 7.1, 0);
  k.rod([4, 8.4, 0], [4, 12.5, 0], 0.15, white);
  k.add(new THREE.TorusGeometry(B * 0.42, 0.5, 6, 18, Math.PI), tyre, { pos: [L * 0.45, 1.8, 0], rot: [Math.PI / 2, 0, Math.PI / 2] });
  for (const z of [-B / 2, B / 2]) box(k, tyre, L * 0.7, 0.8, 0.5, 0, 1.4, z * 1.02);
  return k.build({ name: 'tug' });
}
function pilotBoat(L = 18, B = 5.5) {
  const k = new Kit();
  const orange = paint(0xf26a1b, 0.55), white = paint(0xf2f2ee, 0.6), black = paint(0x1a1c1e, 0.7);
  k.add(hullGeo(L, B, -1.2, 1.6, 0.35), black);
  k.add(hullGeo(L * 0.99, B * 0.99, 0.2, 1.8, 0.35), orange);
  box(k, white, L * 0.32, 2.2, B * 0.72, L * 0.02, 1.8, 0);
  box(k, GLASS(), L * 0.325, 0.8, B * 0.73, L * 0.02, 3.0, 0);
  k.rod([0, 4, 0], [0, 6.5, 0], 0.08, white);
  return k.build({ name: 'pilot' });
}
function yacht(L = 12, B = 4) {
  const k = new Kit();
  const white = paint(0xf6f6f2, 0.45), teak = paint(0x9a7a52, 0.8, 0), steel = paint(0xb8bec4, 0.3, 0.7);
  k.add(hullGeo(L, B, -0.6, 1.1, 0.4), white);
  k.add(hullGeo(L * 0.92, B * 0.9, 1.1, 1.18, 0.4), teak);
  box(k, white, L * 0.3, 0.7, B * 0.6, -L * 0.02, 1.1, 0);
  k.rod([L * 0.08, 1.1, 0], [L * 0.08, 1.1 + L * 1.25, 0], 0.08, steel); // the mast
  k.rod([L * 0.08, 2.4, 0], [-L * 0.38, 2.3, 0], 0.06, steel); // the boom
  const sail = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(L * 0.07, 2.5, 0), new THREE.Vector3(L * 0.07, 1.1 + L * 1.2, 0), new THREE.Vector3(-L * 0.36, 2.5, 0)]);
  sail.computeVertexNormals();
  k.add(sail, new THREE.MeshStandardMaterial({ color: 0xf4f2ea, roughness: 0.9, side: THREE.DoubleSide }));
  return k.build({ name: 'yacht' });
}

export function createVessel(type, { L, B } = {}) {
  switch (type) {
    case 'cargo': case 'general': case 'coaster': case 'tanker': case 'ferry': return merchant(type, L ?? 180, B ?? 28);
    case 'trawler': return trawler(L, B);
    case 'tug': return tug(L, B);
    case 'pilot': return pilotBoat(L, B);
    case 'yacht': return yacht(L, B);
    default: return merchant('cargo', L ?? 120, B ?? 18);
  }
}

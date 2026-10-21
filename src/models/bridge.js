import * as THREE from 'three';
import { Kit } from './kit.js';

// The wheelhouse seen from inside, for the Solo Air Defense bridge view (the eye stands in it, BRIDGE_EYE in helm.js). The ship model's
// exterior is single-sided, so from inside only what is built here shows: a floor and a ceiling with light strips, the front and side
// walls with their window bands (a sill below, a header above, pillars between), a back wall with its door, a console along the
// front with screens, a helm wheel that turns with the rudder, two telegraph levers that follow the ordered speed, and two chairs.
// Ship frame: x ahead, y up, z to starboard; the room is x 6.6 to 15.5, z -4.4 to 4.4, y 9.25 to 12.5. Procedural geometry only.
const lit = (color, glow = 0.22) => new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: glow, roughness: 0.85, metalness: 0.15 });
const glow = (color) => new THREE.MeshBasicMaterial({ color, toneMapped: false });

export function createBridge() {
  const M = {
    wall: lit(0x3a444c),
    trim: lit(0x1b2126, 0.15),
    deck: lit(0x232a30, 0.2),
    console: lit(0x4a555d, 0.25),
    seat: lit(0x1d2a3a, 0.2),
    brass: lit(0xb08a3c, 0.3),
    wheel: lit(0x6a4a2a, 0.3),
    light: glow(0xfff1d0),
    green: glow(0x2c9c78),
    cyan: glow(0x2480ad),
    amber: glow(0xc98a2c),
  };
  const k = new Kit();
  const X0 = 6.6;
  const X1 = 15.5;
  const W = 4.4;
  const Y0 = 9.25;
  const Y1 = 12.5;
  const SILL = 10.6;
  const HEAD = 12.05;
  const box = (mat, sx, sy, sz, x, y, z, rot) => k.add(new THREE.BoxGeometry(sx, sy, sz), mat, { pos: [x, y, z], rot });
  // Floor and ceiling, with light strips along it.
  box(M.deck, X1 - X0, 0.08, 2 * W, (X0 + X1) / 2, Y0 + 0.02, 0);
  box(M.wall, X1 - X0, 0.12, 2 * W, (X0 + X1) / 2, Y1 + 0.02, 0);
  for (const z of [-2.2, 0, 2.2]) box(M.light, X1 - X0 - 1.6, 0.03, 0.18, (X0 + X1) / 2, Y1 - 0.06, z);
  // Front wall: a sill, a header and pillars between the windows.
  box(M.wall, 0.25, SILL - Y0, 2 * W, X1, (Y0 + SILL) / 2, 0);
  box(M.wall, 0.25, Y1 - HEAD, 2 * W, X1, (HEAD + Y1) / 2, 0);
  for (const z of [-W, -2.95, -1.5, 1.5, 2.95, W]) box(M.trim, 0.25, HEAD - SILL, 0.2, X1, (SILL + HEAD) / 2, z);
  // Side walls: the same, with their own pillars.
  for (const s of [-1, 1]) {
    box(M.wall, X1 - X0, SILL - Y0, 0.2, (X0 + X1) / 2, (Y0 + SILL) / 2, s * W);
    box(M.wall, X1 - X0, Y1 - HEAD, 0.2, (X0 + X1) / 2, (HEAD + Y1) / 2, s * W);
    for (const x of [8.2, 10.2, 12.2, 14.2]) box(M.trim, 0.2, HEAD - SILL, 0.2, x, (SILL + HEAD) / 2, s * W);
    box(M.trim, X1 - X0, 0.05, 0.28, (X0 + X1) / 2, SILL + 0.02, s * (W - 0.04)); // the sill's lip
  }
  // Back wall with its door.
  box(M.wall, 0.15, Y1 - Y0, 2 * W, X0, (Y0 + Y1) / 2, 0);
  box(M.trim, 0.2, 2.1, 1.0, X0 + 0.02, Y0 + 1.1, -2.2);
  box(M.amber, 0.04, 0.12, 0.5, X0 + 0.13, Y0 + 1.6, -2.2);
  box(M.trim, 0.2, 1.4, 1.8, X0 + 0.02, Y0 + 1.7, 2.3);
  // The front console: a long desk under the windows with a sloped top, three screens and a keypad bar, and a lower plinth.
  box(M.console, 1.3, 0.95, 7.6, 14.7, Y0 + 0.5, 0);
  box(M.console, 0.9, 0.1, 7.6, 14.5, Y0 + 1.06, 0, [0, 0, -0.35]);
  for (const [z, c] of [[-2.5, M.cyan], [0, M.green], [2.5, M.cyan]]) {
    box(M.trim, 0.06, 0.62, 0.98, 14.34, Y0 + 1.32, z, [0, 0, -0.5]);
    box(c, 0.02, 0.5, 0.86, 14.31, Y0 + 1.34, z, [0, 0, -0.5]);
  }
  for (let i = 0; i < 12; i++) box(i % 3 ? M.green : M.amber, 0.03, 0.03, 0.06, 14.6, Y0 + 1.1, -3.3 + i * 0.6, [0, 0, -0.35]);
  // The helm: a pedestal with the wheel on it, and the telegraphs either side.
  k.add(new THREE.CylinderGeometry(0.2, 0.28, 0.95, 14), M.console, { pos: [13.5, Y0 + 0.5, 0] });
  for (const z of [-1.25, 1.25]) {
    k.add(new THREE.CylinderGeometry(0.15, 0.2, 0.9, 12), M.console, { pos: [13.9, Y0 + 0.5, z] });
    box(M.brass, 0.3, 0.04, 0.3, 13.9, Y0 + 0.97, z);
  }
  // Two chairs behind.
  for (const z of [-2.6, 2.6]) {
    k.add(new THREE.CylinderGeometry(0.06, 0.2, 0.9, 10), M.trim, { pos: [11.4, Y0 + 0.45, z] });
    box(M.seat, 0.6, 0.12, 0.6, 11.4, Y0 + 0.95, z);
    box(M.seat, 0.1, 0.65, 0.58, 11.1, Y0 + 1.3, z);
  }
  const group = new THREE.Group();
  group.name = 'bridge-interior';
  const room = k.build({ name: 'wheelhouse', castShadow: false, receiveShadow: false });
  group.add(room);

  // The wheel: a rim and spokes in a vertical plane facing aft, turning about the x axis (to starboard: clockwise from behind).
  const wheel = new THREE.Group();
  wheel.position.set(13.5, Y0 + 1.25, 0);
  const wk = new Kit();
  wk.add(new THREE.TorusGeometry(0.34, 0.025, 8, 28), M.wheel, { rot: [0, Math.PI / 2, 0] });
  wk.add(new THREE.CylinderGeometry(0.06, 0.06, 0.12, 10), M.brass, { rot: [0, 0, Math.PI / 2] });
  for (let i = 0; i < 6; i++) {
    const a = (i * Math.PI) / 3;
    wk.rod([0, Math.cos(a) * 0.04, Math.sin(a) * 0.04], [0, Math.cos(a) * 0.4, Math.sin(a) * 0.4], 0.012, M.wheel, 5);
  }
  wheel.add(wk.build({ name: 'wheel', castShadow: false, receiveShadow: false }));
  group.add(wheel);
  // The telegraph levers, each pivoting at the top of its pedestal.
  const levers = [-1.25, 1.25].map((z) => {
    const g = new THREE.Group();
    g.position.set(13.9, Y0 + 1.0, z);
    const lk = new Kit();
    lk.rod([0, 0, 0], [0, 0.32, 0], 0.025, M.brass, 6);
    lk.add(new THREE.SphereGeometry(0.06, 10, 8), M.amber, { pos: [0, 0.34, 0] });
    g.add(lk.build({ castShadow: false, receiveShadow: false }));
    group.add(g);
    return g;
  });
  return {
    group,
    // rudder: -1 (hard to port) to +1 (hard to starboard); order: 0 (slow astern) to 1 (flank), the telegraph's setting.
    update(rudder, order) {
      wheel.rotation.x = rudder * 2.4;
      for (const l of levers) l.rotation.z = (0.5 - order) * 1.0; // ahead is forward (toward the bow, x): the lever leans with the order
    },
  };
}

import * as THREE from 'three';
import { Kit, mat, canvasTexture } from './kit.js';
import { HeliFlight } from '../heliFlight.js';

// A naval helicopter (Super Lynx Mk140 as flown by the Algerian Navy): a boxy fuselage with a blunt glazed nose and a chin radar, a tail boom with a swept fin and a four-blade tail rotor on the starboard side, a four-blade
// main rotor, wheeled gear. Nose along +X, the wheels at y = 0; procedural geometry only. It stands on the pad (PAD) and, every so
// often, spins up, lifts off, flies a circuit round the ship and lands again, only for the look of it (heliFlight.js decides when:
// never while the ship is turning); `userData.update(state)` poses it from that state.
export function createHelicopter() {
  const M = {
    body: mat(0x9a9c8c, { metalness: 0.3, roughness: 0.55 }),
    belly: mat(0x73766a, { metalness: 0.35, roughness: 0.6 }),
    glass: mat(0x0d1a24, { metalness: 0.9, roughness: 0.08 }),
    black: mat(0x16191c, { metalness: 0.5, roughness: 0.5 }),
    rubber: mat(0x1d1f21, { metalness: 0, roughness: 0.9 }),
    steel: mat(0xaab2b7, { metalness: 0.7, roughness: 0.4 }),
    blade: mat(0x23272b, { metalness: 0.3, roughness: 0.6 }),
    tip: mat(0xe8e8e0, { metalness: 0.2, roughness: 0.6 }),
    white: mat(0xeeeeea, { metalness: 0.1, roughness: 0.6 }),
    green: mat(0x2f7a3a, { metalness: 0.2, roughness: 0.6 }),
    yellow: mat(0xe0a817, { metalness: 0.2, roughness: 0.6 }),
    red: mat(0xa3231c, { metalness: 0.2, roughness: 0.6 }),
    navRed: new THREE.MeshBasicMaterial({ color: 0xff3020 }),
    navGreen: new THREE.MeshBasicMaterial({ color: 0x30ff60 }),
    navWhite: new THREE.MeshBasicMaterial({ color: 0xffffff }),
  };
  const k = new Kit();
  const sph = (r) => new THREE.SphereGeometry(r, 20, 14);
  // Fuselage: a lofted superellipse tube through stations (x, centre height, half height, half width, squareness), pointed at the
  // nose and tapering into the boom. The belly and the windscreen are patches of the same loft in their own materials.
  const ST = [
    [3.3, 1.72, 0.3, 0.3, 2.2], [3.15, 1.78, 0.62, 0.72, 2.6], [2.7, 1.88, 0.85, 0.98, 3.0], [2.0, 1.97, 0.97, 1.1, 3.2],
    [1.0, 2.0, 1.05, 1.17, 3.2], [-0.5, 2.0, 1.05, 1.17, 3.2], [-1.6, 2.02, 0.95, 1.02, 2.8], [-2.5, 2.1, 0.72, 0.72, 2.5],
    [-3.4, 2.22, 0.5, 0.45, 2.3], [-4.8, 2.32, 0.4, 0.33, 2.1], [-6.0, 2.48, 0.33, 0.25, 2.0], [-6.9, 2.62, 0.28, 0.2, 2.0],
  ];
  const sp = (v, p) => Math.sign(v) * Math.abs(v) ** (2 / p);
  function loft(stations, a0, a1, grow = 1, n = 28) {
    const pos = [];
    const idx = [];
    for (const [x, yc, hh, w, p] of stations) {
      for (let j = 0; j <= n; j++) {
        const th = a0 + ((a1 - a0) * j) / n;
        pos.push(x, yc + hh * grow * sp(Math.sin(th), p), w * grow * sp(Math.cos(th), p));
      }
    }
    for (let i = 0; i < stations.length - 1; i++) {
      for (let j = 0; j < n; j++) {
        const a = i * (n + 1) + j;
        const b = a + n + 1;
        idx.push(a, a + 1, b, a + 1, b + 1, b);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  }
  k.add(loft(ST, 0, Math.PI * 2), M.body);
  k.add(loft(ST.slice(2, 8), Math.PI + 0.4, Math.PI * 2 - 0.4, 1.006), M.belly);
  k.add(loft(ST.slice(0, 4), 0.25, Math.PI - 0.25, 1.012), M.glass);
  k.add(new THREE.BoxGeometry(0.06, 0.06, 1.5), M.black, { pos: [2.55, 2.7, 0], rot: [0, 0, 0.55] }); // windscreen header
  for (const s of [-1, 1]) {
    k.rod([3.2, 2.1, s * 0.3], [2.35, 2.7, s * 0.6], 0.03, M.black, 5); // windscreen pillar
    k.add(new THREE.BoxGeometry(1.0, 0.5, 0.05), M.glass, { pos: [1.4, 2.25, s * 1.13], rot: [0, s * 0.05, 0] });
    k.add(new THREE.BoxGeometry(1.5, 0.5, 0.05), M.glass, { pos: [-0.5, 2.25, s * 1.16] });
    k.add(new THREE.BoxGeometry(0.05, 1.3, 0.06), M.black, { pos: [0.55, 1.95, s * 1.16] }); // the door line
    k.add(new THREE.BoxGeometry(0.05, 1.3, 0.06), M.black, { pos: [-1.35, 1.95, s * 1.0] });
    k.add(new THREE.CylinderGeometry(0.27, 0.27, 0.04, 20), M.green, { pos: [-2.0, 2.05, s * 0.88], rot: [Math.PI / 2, 0, 0] }); // the roundel
    k.add(new THREE.CylinderGeometry(0.15, 0.15, 0.05, 20), M.white, { pos: [-2.0, 2.05, s * 0.88], rot: [Math.PI / 2, 0, 0] });
    k.add(new THREE.BoxGeometry(0.7, 0.07, 0.03), M.yellow, { pos: [0.1, 2.0, s * 1.17], rot: [0, 0, 0.5] }); // the door stripe
  }
  // Engine cowlings on the roof, the mast, the exhaust (an IR suppressor) and the antennas.
  k.add(sph(1), M.body, { pos: [-0.4, 3.0, 0], scale: [1.8, 0.55, 0.85] });
  k.add(new THREE.CylinderGeometry(0.16, 0.22, 0.6, 12), M.steel, { pos: [0.1, 3.4, 0] });
  k.add(new THREE.CylinderGeometry(0.14, 0.18, 0.6, 10), M.black, { pos: [-1.9, 3.12, 0], rot: [0, 0, Math.PI / 2 + 0.2] });
  k.rod([-0.9, 3.5, 0.3], [-1.1, 4.1, 0.3], 0.015, M.steel, 4); // a whip antenna
  k.add(new THREE.CylinderGeometry(0.01, 0.01, 0.8, 4), M.steel, { pos: [3.9, 1.62, 0], rot: [0, 0, Math.PI / 2] }); // the pitot
  k.add(sph(1), M.body, { pos: [3.0, 1.22, 0], scale: [0.8, 0.5, 0.75] }); // the big chin radar
  k.add(sph(0.2), M.black, { pos: [3.55, 1.55, 0.3] }); // a sensor ball on the nose
  for (const s of [-1, 1]) {
    k.add(new THREE.CylinderGeometry(0.2, 0.2, 1.3, 12), s > 0 ? M.green : M.red, { pos: [-0.2, 1.3, s * 1.0], rot: [0, 0, Math.PI / 2] }); // a sponson with its light
    k.add(new THREE.CylinderGeometry(0.2, 0.2, 1.1, 12), M.body, { pos: [-1.1, 1.3, s * 0.98], rot: [0, 0, Math.PI / 2] });
    k.add(new THREE.CylinderGeometry(0.38, 0.38, 0.05, 20), M.black, { pos: [-0.8, 3.0, s * 0.83], rot: [Math.PI / 2, 0, 0] }); // a round engine intake
  }
  // Main rotor (its own group, turning on the mast): the hub, four sleeves and slightly drooping blades with yellow tips, and a
  // faint disc that shows as it spins fast.
  const rk = new Kit();
  rk.add(new THREE.CylinderGeometry(0.34, 0.38, 0.2, 16), M.black, { pos: [0, 0.02, 0] });
  rk.add(new THREE.CylinderGeometry(0.22, 0.3, 0.28, 12), M.steel, { pos: [0, -0.2, 0] }); // the swashplate
  for (let i = 0; i < 4; i++) {
    const a = 0.45 + (i * Math.PI) / 2;
    const c = Math.cos(a);
    const s = Math.sin(a);
    const droop = -0.06;
    rk.add(new THREE.BoxGeometry(0.7, 0.09, 0.2), M.black, { pos: [0.55 * c, -0.05, -0.55 * s], rot: [s * droop, a, -c * droop] }); // a sleeve
    rk.add(new THREE.BoxGeometry(4.6, 0.05, 0.3), M.blade, { pos: [3.0 * c, -0.17, -3.0 * s], rot: [s * droop, a, -c * droop] });
    rk.add(new THREE.BoxGeometry(0.45, 0.052, 0.31), M.tip, { pos: [5.1 * c, -0.3, -5.1 * s], rot: [s * droop, a, -c * droop] });
  }
  // Rotor head detail: pitch links up from the swashplate, black root cuffs, a damper on each sleeve and a black tip cap.
  for (let i = 0; i < 4; i++) {
    const a = 0.45 + (i * Math.PI) / 2;
    const c = Math.cos(a);
    const sn = Math.sin(a);
    rk.rod([0.2 * c, -0.3, -0.2 * sn], [0.62 * c, -0.07, -0.62 * sn], 0.02, M.steel, 5);
    rk.add(new THREE.BoxGeometry(0.5, 0.1, 0.24), M.black, { pos: [1.0 * c, -0.1, -1.0 * sn], rot: [0, a, 0] });
    rk.add(new THREE.CylinderGeometry(0.05, 0.05, 0.4, 8), M.steel, { pos: [0.5 * c, 0.1, -0.5 * sn], rot: [Math.PI / 2, 0, a] });
    rk.add(new THREE.BoxGeometry(0.06, 0.054, 0.32), M.black, { pos: [5.35 * c, -0.31, -5.35 * sn], rot: [0, a, 0] });
    rk.add(new THREE.BoxGeometry(0.5, 0.054, 0.32), M.red, { pos: [4.4 * c, -0.28, -4.4 * sn], rot: [-sn * 0.06, a, c * 0.06] });
  }
  const rotor = new THREE.Group();
  rotor.position.set(0.1, 3.72, 0);
  const blades = rk.build({ name: 'main-rotor' });
  rotor.add(blades);
  const disc = new THREE.Mesh(
    new THREE.CircleGeometry(5.2, 40),
    new THREE.MeshBasicMaterial({ color: 0xcfd8de, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide }),
  );
  disc.rotation.x = -Math.PI / 2;
  disc.position.y = -0.3;
  rotor.add(disc);
  // A swept fin, a stabiliser with an end plate each side, and the tail rotor: four striped blades on the starboard side of the fin.
  const FC = [-7.35, 3.3];
  const fin = new THREE.Shape();
  fin.moveTo(-5.9, 2.4);
  fin.lineTo(-7.05, 4.05);
  fin.lineTo(-7.65, 4.05);
  fin.lineTo(-7.8, 2.75);
  fin.lineTo(-7.0, 2.45);
  fin.lineTo(-5.9, 2.4);
  k.add(new THREE.ExtrudeGeometry(fin, { depth: 0.2, bevelEnabled: false }), M.body, { pos: [0, 0, -0.1] });
  k.add(new THREE.BoxGeometry(0.7, 0.05, 1.9), M.body, { pos: [-6.1, 2.5, 0] });
  for (const s of [-1, 1]) k.add(new THREE.BoxGeometry(0.55, 0.55, 0.04), M.body, { pos: [-6.1, 2.78, s * 0.95] });
  k.add(new THREE.CylinderGeometry(0.1, 0.1, 0.12, 10), M.black, { pos: [FC[0], FC[1], 0.14], rot: [Math.PI / 2, 0, 0] });
  const tk = new Kit();
  tk.add(new THREE.CylinderGeometry(0.1, 0.1, 0.16, 10), M.black, { rot: [Math.PI / 2, 0, 0] });
  for (let i = 0; i < 4; i++) {
    const a = (i * Math.PI) / 2 + 0.3;
    const c = Math.cos(a);
    const sn = Math.sin(a);
    for (const [r0, r1, m] of [[0.1, 0.45, M.blade], [0.45, 0.7, M.white], [0.7, 0.95, M.red]]) {
      const mid = (r0 + r1) / 2;
      tk.add(new THREE.BoxGeometry(0.1, r1 - r0, 0.025), m, { pos: [-mid * sn, mid * c, 0], rot: [0, 0.3, a] });
    }
  }
  const tail = new THREE.Group();
  tail.position.set(FC[0], FC[1], 0.24);
  tail.add(tk.build({ name: 'tail-rotor' }));
  // Wheeled landing gear: two main wheels on sponsons, one nose wheel, struts, and a beacon under the tail.
  for (const s of [-1, 1]) {
    k.rod([-0.2, 1.1, s * 0.75], [-0.3, 0.4, s * 1.2], 0.06, M.steel, 6);
    k.add(new THREE.CylinderGeometry(0.34, 0.34, 0.22, 16), M.rubber, { pos: [-0.3, 0.34, s * 1.25], rot: [Math.PI / 2, 0, 0] });
    k.add(new THREE.CylinderGeometry(0.16, 0.16, 0.24, 10), M.steel, { pos: [-0.3, 0.34, s * 1.25], rot: [Math.PI / 2, 0, 0] });
  }
  k.rod([2.2, 1.2, 0], [2.3, 0.4, 0], 0.05, M.steel, 6);
  k.add(new THREE.CylinderGeometry(0.28, 0.28, 0.2, 16), M.rubber, { pos: [2.3, 0.28, 0], rot: [Math.PI / 2, 0, 0] });
  k.add(new THREE.SphereGeometry(0.1, 8, 6), M.red, { pos: [-1.2, 1.0, 0] });
  // Navigation lights: red to port (-Z), green to starboard (+Z), white on the fin.
  k.add(new THREE.SphereGeometry(0.07, 8, 6), M.navRed, { pos: [2.4, 1.55, -0.65] });
  k.add(new THREE.SphereGeometry(0.07, 8, 6), M.navGreen, { pos: [2.4, 1.55, 0.65] });
  k.add(new THREE.SphereGeometry(0.07, 8, 6), M.navWhite, { pos: [-7.8, 4.05, 0] });

  // More fuselage detail: panel lines, wipers and handles, the hoist, the torpedo and missile, antennas, lights, gear linkage,
  // and the serial and name in painted letters.
  for (const x of [1.6, 0.0, -1.1, -2.3, -3.5]) for (const s of [-1, 1]) {
    const wd = x > -0.6 ? 1.17 : x > -1.8 ? 1.0 : x > -2.9 ? 0.7 : 0.45;
    k.add(new THREE.BoxGeometry(0.02, 0.9, 0.012), M.belly, { pos: [x, 2.0, s * (wd - 0.01)] });
  }
  for (const s of [-1, 1]) {
    k.add(new THREE.BoxGeometry(1.0, 0.025, 0.012), M.belly, { pos: [0.2, 1.55, s * 1.15] }); // a sill line
    k.add(new THREE.BoxGeometry(0.06, 0.2, 0.06), M.steel, { pos: [0.2, 1.95, s * 1.2] }); // the door handle
    k.add(new THREE.BoxGeometry(2.4, 0.04, 0.05), M.steel, { pos: [0.1, 2.52, s * 1.17] }); // the door's top rail
    k.add(new THREE.BoxGeometry(0.5, 0.04, 0.2), M.steel, { pos: [-0.2, 1.2, s * 1.1], rot: [0, 0, 0] }); // a step
    k.rod([3.0, 1.8, s * 0.55], [2.75, 2.5, s * 0.7], 0.012, M.black, 4); // a wiper
    k.add(new THREE.BoxGeometry(0.18, 0.12, 0.03), M.black, { pos: [-1.55, 2.7, s * 0.5], rot: [0, 0, 0.3] }); // a blade antenna on the spine
    for (const dz of [-1, 1]) k.add(new THREE.CylinderGeometry(0.05, 0.05, 0.1, 8), M.black, { pos: [1.35, 2.62, s * 0.85 + dz * 0.0], rot: [Math.PI / 2, 0, 0] });
    // the main gear's strut, brace and torque link
    k.rod([-0.6, 1.35, s * 0.95], [-0.3, 0.4, s * 1.2], 0.04, M.steel, 5);
    k.rod([-0.3, 0.75, s * 1.2], [-0.45, 0.5, s * 1.2], 0.025, M.black, 4);
    k.add(new THREE.BoxGeometry(0.55, 0.05, 0.3), M.black, { pos: [-0.3, 0.64, s * 1.25] }); // the wheel guard
  }
  // twin nose wheels
  k.add(new THREE.CylinderGeometry(0.28, 0.28, 0.12, 16), M.rubber, { pos: [2.3, 0.28, 0.2], rot: [Math.PI / 2, 0, 0] });
  k.add(new THREE.CylinderGeometry(0.28, 0.28, 0.12, 16), M.rubber, { pos: [2.3, 0.28, -0.2], rot: [Math.PI / 2, 0, 0] });
  k.add(new THREE.CylinderGeometry(0.1, 0.1, 0.5, 8), M.steel, { pos: [2.3, 0.28, 0], rot: [Math.PI / 2, 0, 0] });
  // the cable cutter on the mast top and one under the nose, the searchlight and the rescue hoist
  k.rod([0.1, 3.75, 0], [0.1, 3.95, 0], 0.018, M.steel, 4);
  k.add(new THREE.BoxGeometry(0.04, 0.3, 0.04), M.steel, { pos: [3.2, 1.25, 0.0] });
  k.add(sph(0.2), M.steel, { pos: [2.8, 1.18, 0.55], scale: [1, 0.7, 1] });
  k.add(new THREE.BoxGeometry(0.4, 0.18, 0.3), M.black, { pos: [0.2, 3.0, 1.02], rot: [0, 0, 0] });
  k.rod([0.2, 3.0, 1.05], [0.5, 2.55, 1.3], 0.04, M.steel, 5);
  k.add(new THREE.CylinderGeometry(0.1, 0.1, 0.22, 10), M.red, { pos: [0.5, 2.45, 1.3] }); // the hoist head
  // a torpedo on a centre pylon and a missile under each sponson
  k.add(new THREE.BoxGeometry(0.5, 0.2, 0.08), M.steel, { pos: [0.9, 0.88, 0] });
  k.add(new THREE.CylinderGeometry(0.17, 0.17, 2.6, 14), M.body, { pos: [0.9, 0.7, 0], rot: [0, 0, Math.PI / 2] });
  k.add(new THREE.CylinderGeometry(0.0, 0.17, 0.3, 14), M.black, { pos: [2.35, 0.7, 0], rot: [0, 0, -Math.PI / 2] });
  k.add(new THREE.CylinderGeometry(0.175, 0.175, 0.12, 14), M.yellow, { pos: [0.3, 0.7, 0], rot: [0, 0, Math.PI / 2] });
  for (const s of [-1, 1]) {
    k.add(new THREE.BoxGeometry(0.4, 0.18, 0.06), M.steel, { pos: [-0.3, 1.1, s * 1.05] });
    k.add(new THREE.CylinderGeometry(0.1, 0.1, 2.0, 12), M.white, { pos: [-0.3, 0.95, s * 1.05], rot: [0, 0, Math.PI / 2] });
    k.add(new THREE.CylinderGeometry(0.0, 0.1, 0.28, 12), M.black, { pos: [0.84, 0.95, s * 1.05], rot: [0, 0, -Math.PI / 2] });
    k.add(new THREE.BoxGeometry(0.22, 0.02, 0.4), M.black, { pos: [-1.1, 0.95, s * 1.05] });
    k.add(new THREE.BoxGeometry(0.22, 0.4, 0.02), M.black, { pos: [-1.1, 0.95, s * 1.05] });
  }
  // belly: the RAST probe's housing, a blade antenna, and the tail bumper under the fin
  k.add(new THREE.CylinderGeometry(0.18, 0.18, 0.1, 12), M.black, { pos: [-0.6, 0.92, 0] });
  k.add(new THREE.BoxGeometry(0.3, 0.2, 0.03), M.black, { pos: [-2.4, 1.4, 0] });
  k.rod([-6.6, 2.35, 0], [-7.1, 1.7, 0], 0.04, M.steel, 5);
  k.add(new THREE.CylinderGeometry(0.1, 0.1, 0.1, 10), M.rubber, { pos: [-7.1, 1.65, 0], rot: [Math.PI / 2, 0, 0] });
  // boom: a strake along its side, the tail rotor gearbox and the anti-collision beacon
  k.add(new THREE.BoxGeometry(2.0, 0.04, 0.05), M.belly, { pos: [-4.8, 2.45, 0.32], rot: [0, -0.03, 0] });
  k.add(new THREE.BoxGeometry(0.4, 0.3, 0.3), M.body, { pos: [-7.5, 3.35, 0.2] });
  k.add(new THREE.CylinderGeometry(0.06, 0.07, 0.1, 8), M.navRed, { pos: [-7.4, 4.12, 0] });
  k.add(new THREE.BoxGeometry(0.2, 0.14, 0.2), M.black, { pos: [-6.2, 2.78, 0], rot: [0, 0, 0.3] }); // the boom light
  k.rod([-6.6, 2.5, 0.2], [-6.15, 2.5, 0.9], 0.015, M.steel, 4); // stabiliser struts
  k.rod([-6.6, 2.5, -0.2], [-6.15, 2.5, -0.9], 0.015, M.steel, 4);
  // exhaust: a ribbed suppressor and its rim
  for (let i = 0; i < 4; i++) k.add(new THREE.TorusGeometry(0.16, 0.012, 6, 14), M.steel, { pos: [-1.7 - i * 0.14, 3.1 + i * 0.03, 0], rot: [0, Math.PI / 2, 0] });
  // intake rims and the cowl's hinge lines
  for (const s of [-1, 1]) {
    k.add(new THREE.TorusGeometry(0.38, 0.03, 6, 20), M.steel, { pos: [-0.8, 3.0, s * 0.83] });
    k.add(new THREE.BoxGeometry(1.2, 0.015, 0.012), M.belly, { pos: [-0.6, 2.8, s * 0.82] });
  }
  // The painted letters: the serial on the boom and the name on the rear of the cabin, written for each side to read forwards.
  const letters = (text, w, h, size, color) => canvasTexture(256, Math.round((256 * h) / w), (ctx, W, H) => {
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = color;
    ctx.font = `bold ${size}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, W / 2, H / 2);
  });
  const decal = (tex, w, h, x, y, z, side, yaw) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshStandardMaterial({ map: tex, transparent: true, roughness: 0.7, polygonOffset: true, polygonOffsetFactor: -2 }));
    m.position.set(x, y, z);
    m.rotation.y = side < 0 ? Math.PI - yaw : yaw; // turned to follow the boom's taper
    return m;
  };
  const serial = letters('LC-32', 0.7, 0.21, 90, '#2b2d2b');
  const name = letters('ALGERIAN NAVAL FORCES', 1.5, 0.14, 13, '#2b2d2b');
  const decals = [];
  for (const s of [-1, 1]) {
    decals.push(decal(serial, 0.7, 0.21, -3.2, 2.34, s * 0.5, s, -0.28));
    decals.push(decal(name, 1.5, 0.14, -4.9, 2.31, s * 0.35, s, -0.085));
  }

  const group = new THREE.Group();
  group.name = 'helicopter';
  group.add(k.build({ name: 'fuselage' }), rotor, tail, ...decals);
  const e = new THREE.Euler();
  group.userData.update = (st) => {
    group.position.set(st.x, st.y, st.z);
    group.rotation.copy(e.set(st.roll, st.yaw, st.pitch, 'YZX'));
    rotor.rotation.y = -st.spin;
    tail.rotation.z = st.spin * 4.5;
    disc.material.opacity = 0.16 * Math.min(1, st.rpm * 1.4) ** 2;
    blades.visible = st.rpm < 0.6; // a fast rotor is the disc, not 4 strobing blades
  };
  group.userData.update(new HeliFlight().state);
  return group;
}

import * as THREE from 'three';
import { Kit } from './kit.js';

// A merchant ship for the Ship duel's traffic: a container ship, about as long as a frigate (the duel's hull boxes are the same size for all
// ships). Procedural geometry only. Ship frame as the frigate's: x ahead, y up (the sea is y = 0), z to starboard.
const paint = (color) => new THREE.MeshStandardMaterial({ color, roughness: 0.78, metalness: 0.1 });

const BOX_COLORS = [0xb5412f, 0x2f6f9a, 0xd0a23a, 0x3e8a5c, 0x8a8f96, 0xa8532b, 0x2b4f7a];

export function createMerchant() {
  const M = {
    hull: paint(0x3a2f2c),
    boot: paint(0x7a2a24),
    deck: paint(0x5a5f63),
    house: paint(0xe4e6e8),
    glass: new THREE.MeshStandardMaterial({ color: 0x15202b, roughness: 0.3, metalness: 0.4 }),
    funnel: paint(0xc23b2b),
    steel: paint(0x30363b),
  };
  const boxes = BOX_COLORS.map(paint);
  const k = new Kit();
  // The hull: a plan outline with a raked, pointed bow, extruded from below the waterline up to the main deck.
  const plan = new THREE.Shape();
  plan.moveTo(58, 0);
  plan.lineTo(50, 5.4);
  plan.lineTo(34, 8);
  plan.lineTo(-52, 8);
  plan.lineTo(-58, 6.4);
  plan.lineTo(-58, -6.4);
  plan.lineTo(-52, -8);
  plan.lineTo(34, -8);
  plan.lineTo(50, -5.4);
  plan.closePath();
  const hullGeo = new THREE.ExtrudeGeometry(plan, { depth: 9.4, bevelEnabled: false });
  hullGeo.rotateX(-Math.PI / 2); // the extrusion becomes the height
  k.add(hullGeo, M.hull, { pos: [0, -3.4, 0] });
  const boot = new THREE.ExtrudeGeometry(plan, { depth: 2.2, bevelEnabled: false });
  boot.rotateX(-Math.PI / 2);
  k.add(boot, M.boot, { pos: [0, -3.2, 0], scale: [1.012, 1, 1.012] });
  // The deck, the container stacks forward of the house, a bow mast and two cranes.
  k.add(new THREE.BoxGeometry(100, 0.2, 14.4), M.deck, { pos: [-1, 6.1, 0] });
  const rng = (i) => ((Math.sin(i * 91.7) * 43758.5453) % 1 + 1) % 1;
  let n = 0;
  for (let x = -26; x <= 40; x += 11.2) {
    for (let row = -1; row <= 1; row++) {
      const tiers = 2 + Math.floor(rng(++n) * 3);
      for (let t = 0; t < tiers; t++) k.add(new THREE.BoxGeometry(10.8, 2.5, 4.3), boxes[Math.floor(rng(++n) * boxes.length)], { pos: [x, 7.5 + t * 2.55, row * 4.6] });
    }
  }
  // The house aft, with its bridge windows, a funnel and a radar mast.
  k.add(new THREE.BoxGeometry(14, 11, 13), M.house, { pos: [-42, 11.7, 0] });
  k.add(new THREE.BoxGeometry(8, 3.4, 14.4), M.house, { pos: [-40, 18.9, 0] });
  k.add(new THREE.BoxGeometry(0.4, 1.3, 13.8), M.glass, { pos: [-35.9, 19.3, 0] });
  for (const z of [-5, 0, 5]) k.add(new THREE.BoxGeometry(0.3, 1.6, 2.6), M.glass, { pos: [-35.1, 13, z] });
  k.add(new THREE.CylinderGeometry(2.1, 2.5, 6.5, 12), M.funnel, { pos: [-46, 20.8, 0] });
  k.add(new THREE.CylinderGeometry(2.15, 2.15, 1, 12), M.steel, { pos: [-46, 24.3, 0] });
  k.rod([-40, 20.6, 0], [-40, 27, 0], 0.18, M.steel, 6);
  k.add(new THREE.BoxGeometry(0.4, 0.3, 3.4), M.steel, { pos: [-40, 27.1, 0] });
  k.rod([50, 6.2, 0], [50, 15, 0], 0.22, M.steel, 6);
  for (const x of [-12, 14]) {
    k.rod([x, 6.2, 8.4], [x, 17, 8.4], 0.35, M.steel, 6);
    k.rod([x, 17, 8.4], [x, 17, -4], 0.25, M.steel, 6);
  }
  const group = k.build({ name: 'merchant' });
  return { group, update() {} };
}

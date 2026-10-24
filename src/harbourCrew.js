import * as THREE from 'three';
import { deckHeight } from './scenario.js';
import { START_BERTH, TARGET_BERTH, FACES, LAND, BREAKWATER, MOORED, TELEGRAPH, RUDDER_MAX, KT, px, compass, clearance } from './harbour.js';
import { drawChart } from './harbourMap.js';

// The people of the harbour mission and the work they do, all driven by the simulation's state (sim.t, the stage, when the
// lines went and when they went on):
//   - on the bridge (only drawn in the bridge views): the helmsman at the wheel, his hands on its rim as it turns; the officer
//     of the watch by the port telegraph, who reaches for it when you ring a new order and now and then looks out through his
//     binoculars; a lookout at the starboard windows sweeping with his glasses; a rating at the radar. Jointed figures, seen up close.
//   - the bridge's instruments, drawn live into canvas textures: the radar (the port's echoes, a turning sweep with its afterglow),
//     the chart screen (heading up), the conning display, the overhead rudder / rate-of-turn panel, the clock; a paper chart
//     on a chart table at the back.
//   - the mooring lines as real ropes with sag: alongside berth 3 they are fast; on L the linesmen on the quay lift each eye
//     off its bollard and let it drop, and the deck party heaves it in, one line after another; at berth 7 the deck party
//     throws each line across, the linesmen catch it and drop the eye over the bollard, and the crew heave it tight.
//   - the deck party (two forward, two aft, in orange life jackets) and the linesmen (hi-vis), and people ashore: walkers on the
//     corniche, the coast road and the beach, dockers by the sheds, anglers on the breakwater heads and the marina breakwater,
//     people chatting on the quays, fishermen on the pontoons. An instanced crowd: one draw call per body part for all of them.
//   - gulls wheeling over the port.
// Ship frame: bow +x, starboard +z, y up (scenario.js). A figure stands on its feet at y = 0 and faces +x.

const QUAY = 2.6, BW_DECK = 3.4;
const Y0 = 9.25; // the wheelhouse floor (models/bridge.js)
const ease = (x) => { const c = Math.min(Math.max(x, 0), 1); return c * c * (3 - 2 * c); };
const clamp01 = (x) => Math.min(Math.max(x, 0), 1);
const lerp = (a, b, k) => a + (b - a) * k;
const hash = (i) => { let h = Math.imul(i + 1, 2654435761); h ^= h >>> 15; return (h >>> 0) / 4294967296; };

// --- The crowd: every figure is seven instanced parts posed each frame ---------------------------------------------------------
// A pose: legL legR (swing forward, rad), armL armR (raise forward), rollL rollR (out to the side), bend (forward at the hips),
// headYaw, sit (0 standing, 1 sitting on the ground with the legs out), rod (an angler's rod in the right hand).
const PARTS = ['legL', 'legR', 'torso', 'armL', 'armR', 'head', 'hair', 'rod'];
function createCrowd(scene, max) {
  const geo = {
    legL: new THREE.BoxGeometry(0.15, 0.88, 0.15).translate(0, -0.44, 0),
    legR: new THREE.BoxGeometry(0.15, 0.88, 0.15).translate(0, -0.44, 0),
    torso: new THREE.CapsuleGeometry(0.17, 0.3, 3, 8).scale(0.75, 1, 1.2).translate(0, 0.3, 0),
    armL: new THREE.CapsuleGeometry(0.05, 0.52, 2, 6).translate(0, -0.31, 0),
    armR: new THREE.CapsuleGeometry(0.05, 0.52, 2, 6).translate(0, -0.31, 0),
    head: new THREE.SphereGeometry(0.115, 10, 8),
    hair: new THREE.SphereGeometry(0.125, 10, 5, 0, Math.PI * 2, 0, Math.PI * 0.5).translate(0.01, 0.02, 0),
    rod: new THREE.CylinderGeometry(0.008, 0.018, 3.8, 4).translate(0, 1.9, 0),
  };
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.82, metalness: 0.02 });
  const mesh = {};
  for (const p of PARTS) {
    const m = new THREE.InstancedMesh(geo[p], mat, max);
    m.count = 0;
    m.castShadow = p !== 'rod';
    m.frustumCulled = false; // the instances spread over the whole port
    scene.add(m);
    mesh[p] = m;
  }
  const agents = [];
  const col = new THREE.Color();
  const M = new THREE.Matrix4(), U = new THREE.Matrix4(), T = new THREE.Matrix4(), R = new THREE.Matrix4(), P = new THREE.Matrix4();
  const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);
  function add(a) {
    const i = agents.length;
    const look = { shirt: a.shirt ?? '#d9d4c8', arms: a.arms ?? a.shirt ?? '#d9d4c8', trousers: a.trousers ?? '#3a3f48', skin: a.skin ?? '#b98a62', hair: a.hair ?? '#2a211b' };
    const c = { legL: look.trousers, legR: look.trousers, torso: look.shirt, armL: look.arms, armR: look.arms, head: look.skin, hair: look.hair, rod: '#3b2c1c' };
    for (const p of PARTS) { mesh[p].setColorAt(i, col.set(c[p])); mesh[p].count = i + 1; }
    const agent = { x: 0, y: 0, z: 0, psi: 0, visible: true, legL: 0, legR: 0, armL: 0.05, armR: 0.05, rollL: 0.08, rollR: 0.08, bend: 0, headYaw: 0, sit: 0, rod: false, ...a };
    agents.push(agent);
    return agent;
  }
  const set = (p, i, m) => mesh[p].setMatrixAt(i, m);
  function flush() {
    for (let i = 0; i < agents.length; i++) {
      const a = agents[i];
      if (!a.visible) { for (const p of PARTS) set(p, i, ZERO); continue; }
      M.makeRotationY(-a.psi).setPosition(a.x, a.y - a.sit * 0.62, a.z);
      const hip = 0.9;
      for (const [p, z, sw] of [['legL', -0.1, a.legL], ['legR', 0.1, a.legR]]) {
        P.copy(M).multiply(T.makeTranslation(0, hip, z)).multiply(R.makeRotationZ(sw + a.sit * 1.5));
        set(p, i, P);
      }
      U.copy(M).multiply(T.makeTranslation(0, hip, 0)).multiply(R.makeRotationZ(-a.bend));
      set('torso', i, U);
      P.copy(U).multiply(T.makeTranslation(0, 0.72, 0)).multiply(R.makeRotationY(a.headYaw));
      set('head', i, P);
      set('hair', i, P);
      P.copy(U).multiply(T.makeTranslation(0, 0.56, -0.24)).multiply(R.makeRotationZ(a.armL)).multiply(T.makeRotationX(a.rollL));
      set('armL', i, P);
      P.copy(U).multiply(T.makeTranslation(0, 0.56, 0.24)).multiply(R.makeRotationZ(a.armR)).multiply(T.makeRotationX(-a.rollR));
      set('armR', i, P);
      if (a.rod) {
        P.copy(U).multiply(T.makeTranslation(0.32, 0.45, 0.24)).multiply(R.makeRotationZ(-(Math.PI / 2 - 0.62)));
        set('rod', i, P);
      } else set('rod', i, ZERO);
    }
    for (const p of PARTS) { mesh[p].instanceMatrix.needsUpdate = true; if (mesh[p].instanceColor) mesh[p].instanceColor.needsUpdate = true; }
  }
  return { add, flush, agents };
}
// A few ready poses.
function walkPose(a, phase, amt = 1) {
  const s = Math.sin(phase);
  a.legL = 0.42 * s * amt; a.legR = -0.42 * s * amt;
  a.armL = -0.32 * s * amt; a.armR = 0.32 * s * amt;
  a.rollL = a.rollR = 0.08; a.bend = 0.04; a.sit = 0;
}
function standPose(a, t, ph = 0) {
  a.legL = a.legR = 0; a.armL = 0.05 + 0.03 * Math.sin(t * 0.7 + ph); a.armR = 0.05 + 0.03 * Math.sin(t * 0.6 + ph + 1);
  a.rollL = a.rollR = 0.09; a.bend = 0.02 * Math.sin(t * 0.4 + ph); a.sit = 0;
}

// --- A jointed figure for the bridge (seen from a metre or two) ----------------------------------------------------------------
const mats = new Map();
const matOf = (hex, rough = 0.75) => { const k = `${hex}/${rough}`; if (!mats.has(k)) mats.set(k, new THREE.MeshStandardMaterial({ color: hex, roughness: rough, metalness: 0.05, envMapIntensity: 0.45 })); return mats.get(k); };
function capsule(r, len, mat, y, parent, sx = 1, sz = 1) {
  const m = new THREE.Mesh(new THREE.CapsuleGeometry(r, len, 3, 10).scale(sx, 1, sz), mat);
  m.position.y = y;
  parent.add(m);
  return m;
}
function jointed({ shirt = 0xe9ecef, trousers = 0x1f2a3a, skin = 0xb98a62, hair = 0x2a211b, cap = null, vest = null, epaulettes = false }) {
  const root = new THREE.Group();
  const hips = new THREE.Group(); hips.position.y = 0.94; root.add(hips);
  const pelvis = new THREE.Mesh(new THREE.CapsuleGeometry(0.13, 0.08, 3, 10).rotateX(Math.PI / 2).scale(0.8, 0.9, 1), matOf(trousers)); hips.add(pelvis);
  const spine = new THREE.Group(); spine.position.y = 0.06; hips.add(spine);
  capsule(0.15, 0.3, matOf(shirt), 0.27, spine, 0.78, 1.25);
  if (vest) capsule(0.158, 0.22, matOf(vest), 0.24, spine, 0.8, 1.27);
  const belt = new THREE.Mesh(new THREE.BoxGeometry(0.21, 0.05, 0.35), matOf(0x111111, 0.5)); belt.position.y = 0.03; spine.add(belt);
  if (epaulettes) for (const s of [-1, 1]) { const e = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.015, 0.06), matOf(0x111a2c)); e.position.set(0, 0.52, s * 0.17); spine.add(e); const g = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.018, 0.012), matOf(0xd4af37, 0.3)); g.position.set(0, 0.53, s * 0.17); spine.add(g); }
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.05, 0.08, 8), matOf(skin)); neck.position.y = 0.55; spine.add(neck);
  const head = new THREE.Group(); head.position.y = 0.6; spine.add(head);
  const skull = new THREE.Mesh(new THREE.SphereGeometry(0.105, 14, 10), matOf(skin)); skull.scale.set(1.05, 1.12, 0.95); skull.position.y = 0.1; head.add(skull);
  const nose = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.04, 0.025), matOf(skin)); nose.position.set(0.105, 0.09, 0); head.add(nose);
  for (const s of [-1, 1]) { const eye = new THREE.Mesh(new THREE.SphereGeometry(0.012, 6, 4), matOf(0x111111, 0.3)); eye.position.set(0.095, 0.13, s * 0.035); head.add(eye); }
  const hairM = new THREE.Mesh(new THREE.SphereGeometry(0.112, 12, 6, 0, Math.PI * 2, 0, Math.PI * 0.55), matOf(hair, 0.9)); hairM.position.set(-0.01, 0.12, 0); head.add(hairM);
  if (cap) {
    const crown = new THREE.Mesh(new THREE.CylinderGeometry(0.115, 0.11, 0.07, 14), matOf(cap.top ?? cap.band)); crown.position.y = 0.22; head.add(crown);
    const band = new THREE.Mesh(new THREE.CylinderGeometry(0.112, 0.112, 0.035, 14), matOf(cap.band)); band.position.y = 0.18; head.add(band);
    const peak = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.075, 0.012, 12, 1, false, -Math.PI / 2, Math.PI), matOf(0x111111, 0.3)); peak.position.set(0.07, 0.165, 0); peak.rotation.z = -0.25; head.add(peak);
  }
  const binos = new THREE.Group(); binos.position.set(0.14, 0.13, 0); binos.visible = false; head.add(binos);
  for (const s of [-1, 1]) { const b = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.032, 0.14, 10), matOf(0x18191b, 0.4)); b.rotation.z = Math.PI / 2; b.position.set(0.05, 0, s * 0.035); binos.add(b); }
  const limb = (y, z) => { const g = new THREE.Group(); g.position.set(0, y, z); return g; };
  const arm = (s) => {
    const sh = limb(0.48, s * 0.2); spine.add(sh);
    capsule(0.05, 0.2, matOf(shirt), -0.14, sh);
    const el = limb(-0.29, 0); sh.add(el);
    capsule(0.043, 0.19, matOf(shirt), -0.12, el);
    const hand = new THREE.Mesh(new THREE.SphereGeometry(0.045, 8, 6), matOf(skin)); hand.scale.set(1, 1.2, 0.7); hand.position.y = -0.27; el.add(hand);
    return { sh, el };
  };
  const leg = (s) => {
    const hp = limb(-0.02, s * 0.1); hips.add(hp);
    capsule(0.07, 0.3, matOf(trousers), -0.22, hp);
    const kn = limb(-0.45, 0); hp.add(kn);
    capsule(0.058, 0.3, matOf(trousers), -0.21, kn);
    const shoe = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.08, 0.11), matOf(0x0d0d0d, 0.4)); shoe.position.set(0.05, -0.43, 0); kn.add(shoe);
    return { hp, kn };
  };
  const L = arm(-1), R = arm(1), LL = leg(-1), LR = leg(1);
  root.traverse((o) => { if (o.isMesh) o.castShadow = false; });
  return {
    group: root, binos,
    // the same pose fields as the crowd's, plus elbows (elL, elR, + bends the forearm up), knees, and the head's pitch
    pose(p) {
      L.sh.rotation.set(p.rollL ?? 0.08, 0, p.armL ?? 0.05, 'XYZ'); R.sh.rotation.set(-(p.rollR ?? 0.08), 0, p.armR ?? 0.05, 'XYZ');
      L.el.rotation.z = p.elL ?? 0.15; R.el.rotation.z = p.elR ?? 0.15;
      LL.hp.rotation.z = p.legL ?? 0; LR.hp.rotation.z = p.legR ?? 0;
      LL.kn.rotation.z = -(p.knL ?? 0); LR.kn.rotation.z = -(p.knR ?? 0);
      spine.rotation.z = -(p.bend ?? 0);
      head.rotation.set(0, p.headYaw ?? 0, -(p.headPitch ?? 0), 'YXZ');
    },
  };
}

// --- Canvas screens ----------------------------------------------------------------------------------------------------------
function screen(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return { c, g: c.getContext('2d'), tex, mat: new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }) };
}
// A flat screen in the ship's frame: centre, size, facing aft and tilted up by `tilt` (the console's screens), or by `yaw`.
function screenMesh(s, w, h, pos, { tilt = 0, yaw = -Math.PI / 2 } = {}) {
  const g = new THREE.PlaneGeometry(w, h);
  g.rotateY(yaw);
  if (tilt) g.rotateZ(-tilt);
  const m = new THREE.Mesh(g, s.mat);
  m.position.set(...pos);
  return m;
}
const pad3 = (d) => String(Math.round(d) % 360).padStart(3, '0');

// --- Everything --------------------------------------------------------------------------------------------------------------
export function createHarbourCrew({ scene, ship, bridge, landHeight }) {
  const crowd = createCrowd(scene, 220);
  const shipM = () => ship.group.matrixWorld;
  const _v = new THREE.Vector3();
  const toWorld = (x, y, z) => _v.set(x, y, z).applyMatrix4(shipM()).clone();

  // ---- The bridge team (children of the wheelhouse group, so they show only in the bridge views) ----
  const team = new THREE.Group();
  bridge.group.add(team);
  const navy = 0x1c2a44, white = 0xeef0f2;
  const helmsman = jointed({ shirt: 0x2b3d5c, trousers: navy, skin: 0x7e5134, hair: 0x1b1410, cap: { band: navy, top: navy } });
  helmsman.group.position.set(12.98, Y0, 0);
  const oow = jointed({ shirt: white, trousers: navy, skin: 0x93613f, hair: 0x2b2018, cap: { band: navy, top: white }, epaulettes: true });
  oow.group.position.set(13.25, Y0, -1.72);
  const lookout = jointed({ shirt: 0x2b3d5c, trousers: navy, skin: 0x6e452c, hair: 0x15100c, vest: 0xe06a1c });
  lookout.group.position.set(12.7, Y0, 3.75);
  lookout.group.rotation.y = -Math.PI / 2; // facing the starboard windows
  const radarman = jointed({ shirt: 0x2b3d5c, trousers: navy, skin: 0x86573a, hair: 0x231a14 });
  radarman.group.position.set(9.6, Y0, -2.95);
  radarman.group.rotation.y = Math.PI / 2; // facing the radar, to port
  team.add(helmsman.group, oow.group, lookout.group, radarman.group);

  // ---- The bridge's instruments ----
  const inst = new THREE.Group();
  bridge.group.add(inst);
  const radar = screen(384, 384), ecdis = screen(512, 300), conn = screen(512, 300), over = screen(768, 128), clock = screen(128, 128), chart = screen(768, 512);
  // the console's three screens (left, middle, right), laid over models/bridge.js's own, tilted with them
  inst.add(screenMesh(radar, 0.5, 0.5, [14.29, Y0 + 1.34, -2.5], { tilt: 0.5 }));
  inst.add(screenMesh(ecdis, 0.84, 0.49, [14.29, Y0 + 1.34, 0], { tilt: 0.5 }));
  inst.add(screenMesh(conn, 0.84, 0.49, [14.29, Y0 + 1.34, 2.5], { tilt: 0.5 }));
  // the radar's own display on a pedestal at the back, port side (the rating watches it)
  const dark = matOf(0x2a3238, 0.6), metal = matOf(0x5c666d, 0.4);
  const ped = new THREE.Mesh(new THREE.BoxGeometry(0.6, 1.05, 0.7), dark); ped.position.set(9.6, Y0 + 0.52, -3.75); inst.add(ped);
  const hood = new THREE.Mesh(new THREE.BoxGeometry(0.66, 0.5, 0.18), dark); hood.position.set(9.6, Y0 + 1.35, -3.78); inst.add(hood);
  inst.add(screenMesh(radar, 0.46, 0.46, [9.6, Y0 + 1.35, -3.68], { yaw: 0 }));
  // the overhead panel above the front windows: rudder angle, rate of turn, speed, heading
  const panel = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.34, 2.3), dark); panel.position.set(15.05, 12.2, 0); inst.add(panel);
  inst.add(screenMesh(over, 2.24, 0.3, [14.985, 12.2, 0]));
  for (const z of [-1.0, 1.0]) { const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.16, 6), metal); rod.position.set(15.05, 12.43, z); inst.add(rod); }
  // the clock above the door
  const rim = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.04, 20), matOf(0x9a8a5a, 0.35)); rim.rotation.z = Math.PI / 2; rim.position.set(6.7, 11.75, -0.6); inst.add(rim);
  inst.add(screenMesh(clock, 0.3, 0.3, [6.73, 11.75, -0.6], { yaw: Math.PI / 2 }));
  // the chart table at the back, a paper chart on it, a lamp, parallel rules and dividers
  const tableTop = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.06, 1.5), matOf(0x6b4a2c, 0.6)); tableTop.position.set(7.35, Y0 + 0.95, 1.2); inst.add(tableTop);
  const tableBody = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.9, 1.45), matOf(0x4a3420, 0.7)); tableBody.position.set(7.35, Y0 + 0.47, 1.2); inst.add(tableBody);
  const paper = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 0.92).rotateX(-Math.PI / 2).rotateY(Math.PI / 2), chart.mat); paper.position.set(7.35, Y0 + 0.985, 1.2); inst.add(paper);
  const rule = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.012, 0.5), matOf(0x9ccfe0, 0.2)); rule.position.set(7.2, Y0 + 0.995, 1.0); rule.rotation.y = 0.4; inst.add(rule);
  const lampArm = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.5, 6), metal); lampArm.position.set(7.0, Y0 + 1.22, 1.85); lampArm.rotation.x = 0.4; inst.add(lampArm);
  const lampHead = new THREE.Mesh(new THREE.ConeGeometry(0.08, 0.12, 12, 1, true), matOf(0x8a2a22, 0.4)); lampHead.position.set(7.05, Y0 + 1.45, 1.75); inst.add(lampHead);
  // VHF sets and a binocular box on the console, a mug of coffee by the helm
  for (const z of [-3.4, 3.4]) {
    const vhf = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.09, 0.3), dark); vhf.position.set(14.95, 12.35 - 0.12, z); inst.add(vhf);
    const disp = new THREE.Mesh(new THREE.PlaneGeometry(0.16, 0.035).rotateY(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x7fffb0, toneMapped: false })); disp.position.set(14.835, 12.24, z); inst.add(disp);
  }
  const mug = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.036, 0.1, 12), matOf(0xf0efe8, 0.4)); mug.position.set(14.35, Y0 + 1.16, 0.75); inst.add(mug);
  const coffee = new THREE.Mesh(new THREE.CircleGeometry(0.035, 12).rotateX(-Math.PI / 2), matOf(0x3a2210, 0.2)); coffee.position.set(14.35, Y0 + 1.205, 0.75); inst.add(coffee);
  const binoBox = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.12, 0.3), matOf(0x3b2a1a, 0.6)); binoBox.position.set(14.4, Y0 + 1.16, -3.1); inst.add(binoBox);
  // the paper chart: printed once, with the pilot's pencilled route out and back
  {
    const fake = { x: -60, z: -150, psi: 0, track: [], u: 0, v: 0, r: 0, stage: 'alongside', mark: null };
    const k = drawChart(chart.g, chart.c.width, chart.c.height, fake, { half: 560, paper: true });
    const P = (x, z) => [chart.c.width / 2 + (z - fake.z) * k, chart.c.height / 2 - (x - fake.x) * k];
    const route = [START_BERTH, px(720, 300), px(960, 400), px(1030, 470), px(1300, 520), px(1720, 560), px(1300, 470), px(1030, 470), px(900, 330), TARGET_BERTH];
    const g = chart.g;
    g.strokeStyle = 'rgba(40,40,40,0.75)'; g.lineWidth = 1.6; g.setLineDash([]);
    g.beginPath(); route.forEach((p, i) => { const [a, b] = P(p.x, p.z); i ? g.lineTo(a, b) : g.moveTo(a, b); }); g.stroke();
    g.fillStyle = 'rgba(30,30,30,0.85)'; g.font = 'italic 15px serif';
    g.fillText('JIJEL', 40, 300); g.fillText('Port de Jijel', 60, 60);
    const [ta, tb] = P(TARGET_BERTH.x, TARGET_BERTH.z); g.fillText('7', ta + 6, tb - 6);
    const [sa, sb] = P(START_BERTH.x, START_BERTH.z); g.fillText('3', sa - 4, sb + 18);
    g.strokeStyle = 'rgba(120,60,40,0.8)'; g.strokeRect(6, 6, chart.c.width - 12, chart.c.height - 12);
    chart.tex.needsUpdate = true;
  }

  function drawRadar(sim, t) {
    const { g, c } = radar, W = c.width, R = W / 2 - 8, RANGE = 1500;
    g.fillStyle = '#020a06'; g.fillRect(0, 0, W, W);
    g.save(); g.translate(W / 2, W / 2);
    g.beginPath(); g.arc(0, 0, R, 0, Math.PI * 2); g.clip();
    const k = R / RANGE, cs = Math.cos(-sim.psi), sn = Math.sin(-sim.psi);
    const P = (x, z) => { const dx = (z - sim.z) * k, dy = -(x - sim.x) * k; return [dx * cs - dy * sn, dx * sn + dy * cs]; }; // heading up
    g.fillStyle = 'rgba(80,255,140,0.85)';
    for (const poly of [LAND, BREAKWATER, ...MOORED]) {
      g.beginPath();
      poly.pts.forEach((p, i) => { const [a, b] = P(p.x, p.z); i ? g.lineTo(a, b) : g.moveTo(a, b); });
      g.closePath(); g.fill();
    }
    g.strokeStyle = 'rgba(80,255,140,0.28)'; g.lineWidth = 1;
    for (let r = 1; r <= 3; r++) { g.beginPath(); g.arc(0, 0, (R * r) / 3, 0, Math.PI * 2); g.stroke(); }
    g.beginPath(); g.moveTo(0, 0); g.lineTo(0, -R); g.stroke(); // the heading line
    // the afterglow: everything the sweep has not just passed fades toward black
    const sweep = (t * Math.PI * 2) / 2.5;
    if (g.createConicGradient) {
      const cg = g.createConicGradient(sweep - Math.PI / 2, 0, 0);
      cg.addColorStop(0, 'rgba(2,10,6,0)'); cg.addColorStop(0.02, 'rgba(2,10,6,0.05)'); cg.addColorStop(1, 'rgba(2,10,6,0.82)');
      g.fillStyle = cg; g.fillRect(-R, -R, 2 * R, 2 * R);
    }
    g.strokeStyle = 'rgba(160,255,190,0.9)'; g.lineWidth = 2;
    g.beginPath(); g.moveTo(0, 0); g.lineTo(Math.sin(sweep) * R, -Math.cos(sweep) * R); g.stroke();
    g.fillStyle = '#ffd166'; g.fillRect(-2, -2, 4, 4);
    g.restore();
    g.fillStyle = 'rgba(160,255,190,0.9)'; g.font = 'bold 15px monospace';
    g.fillText('RANGE 0.75 NM', 10, 20); g.fillText(`HDG ${pad3(compass(sim.psi))}`, W - 92, 20); g.fillText('H UP', 10, W - 10);
    radar.tex.needsUpdate = true;
  }
  function drawEcdis(sim) {
    const { g, c } = ecdis;
    drawChart(g, c.width, c.height, sim, { half: 380, headingUp: true });
    g.fillStyle = 'rgba(5,12,20,0.75)'; g.fillRect(0, 0, c.width, 30);
    g.fillStyle = '#9fe8ff'; g.font = 'bold 17px monospace';
    g.fillText(`ECDIS  HDG ${pad3(compass(sim.psi))}°  SOG ${(Math.hypot(sim.u, sim.v) / KT).toFixed(1)} kn`, 10, 21);
    ecdis.tex.needsUpdate = true;
  }
  function drawConn(sim) {
    const { g, c } = conn, W = c.width, H = c.height;
    g.fillStyle = '#06101a'; g.fillRect(0, 0, W, H);
    const cell = (x, y, label, value, unit, color = '#e8f4ff') => {
      g.fillStyle = 'rgba(255,255,255,0.06)'; g.fillRect(x, y, 240, 82);
      g.fillStyle = '#7f95a8'; g.font = 'bold 15px sans-serif'; g.fillText(label, x + 10, y + 22);
      g.fillStyle = color; g.font = 'bold 38px monospace'; g.fillText(value, x + 10, y + 66);
      g.fillStyle = '#7f95a8'; g.font = '16px sans-serif'; g.fillText(unit, x + 10 + g.measureText(value).width + 30, y + 66);
    };
    const rud = (sim.rudder * 180) / Math.PI;
    const depth = 3.8 + Math.min(clearance(sim.x, sim.z), 300) * 0.055; // under the keel, shoaling toward the quays
    cell(10, 10, 'HEADING', `${pad3(compass(sim.psi))}.${Math.floor((compass(sim.psi) % 1) * 10)}`, '°');
    cell(262, 10, 'SPEED (LOG)', (sim.u / KT).toFixed(1), 'kn');
    cell(10, 102, 'RUDDER', `${Math.abs(rud).toFixed(0)} ${rud > 0.5 ? 'S' : rud < -0.5 ? 'P' : ''}`, '°', rud > 0.5 ? '#3ddc84' : rud < -0.5 ? '#ff5d61' : '#e8f4ff');
    cell(262, 102, 'RATE OF TURN', `${((sim.r * 180) / Math.PI * 60).toFixed(0)}`, '°/min');
    cell(10, 194, 'ENGINE ORDER', TELEGRAPH[sim.order].name.toUpperCase(), '', sim.ordered > 0 ? '#3ddc84' : sim.ordered < 0 ? '#ff5d61' : '#e8f4ff');
    cell(262, 194, 'DEPTH UNDER KEEL', depth.toFixed(1), 'm', depth < 5 ? '#ffc454' : '#e8f4ff');
    conn.tex.needsUpdate = true;
  }
  function drawOver(sim) {
    const { g, c } = over, W = c.width, H = c.height;
    g.fillStyle = '#0b0e10'; g.fillRect(0, 0, W, H);
    const dial = (cx, label, v, max, unit) => {
      const r = 48, cy = 78;
      g.strokeStyle = '#3a4248'; g.lineWidth = 10; g.beginPath(); g.arc(cx, cy, r, Math.PI * 1.15, Math.PI * 1.85); g.stroke();
      g.strokeStyle = '#d23b33'; g.beginPath(); g.arc(cx, cy, r, Math.PI * 1.15, Math.PI * 1.5); g.stroke();
      g.strokeStyle = '#2aa35c'; g.beginPath(); g.arc(cx, cy, r, Math.PI * 1.5, Math.PI * 1.85); g.stroke();
      const a = Math.PI * 1.5 + Math.max(-1, Math.min(1, v / max)) * Math.PI * 0.35;
      g.strokeStyle = '#ffffff'; g.lineWidth = 4; g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx + Math.cos(a) * (r - 4), cy + Math.sin(a) * (r - 4)); g.stroke();
      g.fillStyle = '#9aa6ad'; g.font = 'bold 14px sans-serif'; g.textAlign = 'center'; g.fillText(label, cx, 20); g.fillText(`${Math.abs(v).toFixed(0)}${unit}`, cx, 112); g.textAlign = 'left';
    };
    dial(100, 'RUDDER', (sim.rudder * 180) / Math.PI, 35, '°');
    dial(290, 'RATE OF TURN', (sim.r * 180) / Math.PI * 60, 30, '°/min');
    g.fillStyle = '#9aa6ad'; g.font = 'bold 14px sans-serif';
    g.fillText('SPEED', 430, 30); g.fillText('HEADING', 600, 30);
    g.fillStyle = '#ffcf6b'; g.font = 'bold 44px monospace';
    g.fillText((sim.u / KT).toFixed(1), 420, 86); g.fillText(pad3(compass(sim.psi)), 595, 86);
    over.tex.needsUpdate = true;
  }
  function drawClock() {
    const { g, c } = clock, W = c.width, d = new Date();
    g.fillStyle = '#f4f1e6'; g.beginPath(); g.arc(W / 2, W / 2, W / 2 - 2, 0, Math.PI * 2); g.fill();
    g.strokeStyle = '#222'; g.lineWidth = 3;
    for (let i = 0; i < 12; i++) { const a = (i * Math.PI) / 6; g.beginPath(); g.moveTo(W / 2 + Math.sin(a) * 50, W / 2 - Math.cos(a) * 50); g.lineTo(W / 2 + Math.sin(a) * 58, W / 2 - Math.cos(a) * 58); g.stroke(); }
    const hand = (a, l, w) => { g.lineWidth = w; g.beginPath(); g.moveTo(W / 2, W / 2); g.lineTo(W / 2 + Math.sin(a) * l, W / 2 - Math.cos(a) * l); g.stroke(); };
    const h = d.getHours() % 12 + d.getMinutes() / 60, m = d.getMinutes() + d.getSeconds() / 60;
    hand((h * Math.PI) / 6, 32, 5); hand((m * Math.PI) / 30, 46, 3);
    g.strokeStyle = '#c0392b'; hand((d.getSeconds() * Math.PI) / 30, 50, 1.5);
    clock.tex.needsUpdate = true;
  }

  // ---- The mooring lines: four ropes, each a chain of short cylinders through a sagging curve ----
  const SEG = 18;
  const ropes = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.065, 0.065, 1, 6, 1, true), new THREE.MeshStandardMaterial({ color: 0xa8956a, roughness: 0.9 }), 4 * SEG);
  ropes.frustumCulled = false;
  ropes.castShadow = true;
  scene.add(ropes);
  // each line: her fairlead (ship frame x), where it leads along the quay (+ ahead), the order it is handled in
  const LINES = [{ ax: 50, reach: 24, name: 'bow line' }, { ax: 36, reach: -18, name: 'forward spring' }, { ax: -36, reach: 18, name: 'after spring' }, { ax: -52, reach: -24, name: 'stern line' }];
  const LET_GO_ORDER = [3, 2, 1, 0]; // the stern line first, the bow line last
  const FAST_ORDER = [0, 3, 1, 2]; // the bow and stern lines first, then the springs
  const STEP = 1.8; // s between lines
  const sideOf = (f, psi) => (f.n.x * Math.sin(psi) - f.n.z * Math.cos(psi) > 0 ? 1 : -1); // the side of her that lies to the quay
  // A berth's bollards (fixed in the world), from her pose alongside it.
  function bollards(f, x, z, psi) {
    const c = Math.cos(psi), s = Math.sin(psi);
    return LINES.map((L) => {
      const qx = x + c * (L.ax + L.reach), qz = z + s * (L.ax + L.reach);
      const d = (qx - f.a.x) * f.n.x + (qz - f.a.z) * f.n.z;
      return new THREE.Vector3(qx - f.n.x * (d + 1.1), 0, qz - f.n.z * (d + 1.1));
    });
  }
  const deckOf = (f) => (f === FACES.north || f === FACES.arm ? BW_DECK : QUAY);
  const berth3 = { f: START_BERTH.face, side: sideOf(START_BERTH.face, START_BERTH.psi), bol: bollards(START_BERTH.face, START_BERTH.x, START_BERTH.z, START_BERTH.psi) };
  for (const b of berth3.bol) b.y = deckOf(berth3.f) + 0.75;
  let berth7 = null; // fixed when she makes fast
  const berth7Guess = () => { // before that, where her lines will go if she lies as the berth is marked
    const bol = bollards(TARGET_BERTH.face, TARGET_BERTH.x, TARGET_BERTH.z, TARGET_BERTH.psi);
    for (const b of bol) b.y = BW_DECK + 0.75;
    return { f: TARGET_BERTH.face, side: sideOf(TARGET_BERTH.face, TARGET_BERTH.psi), bol };
  };
  const fair = (L, side) => toWorld(L.ax, deckHeight(L.ax) + 0.9, side * 4.3);
  const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _m = new THREE.Matrix4(), UP = new THREE.Vector3(0, 1, 0);
  const HIDE = new THREE.Matrix4().makeScale(0, 0, 0);
  function drawRope(li, S, E, sag, float) {
    let prev = null;
    for (let i = 0; i <= SEG; i++) {
      const u = i / SEG;
      const p = new THREE.Vector3().lerpVectors(S, E, u);
      p.y -= sag * 4 * u * (1 - u);
      if (float && p.y < 0.06) p.y = 0.06; // a slack line floats on the water
      if (prev) {
        _a.subVectors(p, prev);
        const len = _a.length();
        _q.setFromUnitVectors(UP, _a.normalize());
        _m.compose(_b.addVectors(prev, p).multiplyScalar(0.5), _q, _s.set(1, len, 1));
        ropes.setMatrixAt(li * SEG + i - 1, _m);
      }
      prev = p;
    }
  }
  const hideRope = (li) => { for (let i = 0; i < SEG; i++) ropes.setMatrixAt(li * SEG + i, HIDE); };

  // ---- The deck party and the linesmen (crowd figures) ----
  const deck = LINES.map((L, i) => crowd.add({ shirt: '#e8641c', arms: '#24324a', trousers: '#24324a', skin: ['#a87850', '#8e6142', '#c09070', '#9a6c48'][i], hair: '#1a1410' }));
  const linesmen3 = LINES.map((L, i) => crowd.add({ shirt: '#f2d21b', arms: '#4a5560', trousers: '#2e3540', skin: ['#9a6c48', '#b48662', '#8e6142', '#a87850'][i], hair: '#f2f2ee' }));
  const linesmen7 = LINES.map((L, i) => crowd.add({ shirt: '#f28a1b', arms: '#4a5560', trousers: '#2e3540', skin: ['#b48662', '#9a6c48', '#a87850', '#8e6142'][i], hair: '#f2f2ee' }));

  // Where the line's free end is, and what the two men handling it are doing, `tau` seconds into their part of the job.
  function letGo(i, tau, S, B, f, man, sailor, t) {
    const W = new THREE.Vector3(B.x + f.n.x * 2.6, 0.06, B.z + f.n.z * 2.6); // just off the quay wall
    const hands = new THREE.Vector3(B.x - f.n.x * 0.2, B.y + 0.6, B.z - f.n.z * 0.2);
    sailorIdle(sailor, t, i);
    if (tau < 0) { man.bend = 0.05; return { E: B, sag: 0.35 }; }
    if (tau < 1.3) { // he stoops to the bollard and lifts the eye off it
      const k = tau / 1.3;
      man.bend = 0.9 * Math.sin(Math.PI * k); man.armL = man.armR = 0.5 + 0.6 * k;
      return { E: new THREE.Vector3().lerpVectors(B, hands, ease(k)), sag: 0.5 };
    }
    if (tau < 2.3) { // and lets it drop between the quay and her side
      const k = (tau - 1.3) / 1.0;
      man.bend = 0.3 * k; man.armL = man.armR = 1.1 + 0.5 * Math.sin(Math.PI * k);
      const E = new THREE.Vector3().lerpVectors(hands, W, ease(k));
      E.y += Math.sin(Math.PI * k) * 0.6;
      return { E, sag: 1 + k };
    }
    if (tau < 9.5) { // the deck party heaves it in, hand over hand
      const k = ease((tau - 2.3) / 7.2);
      haul(sailor, t);
      man.armL = man.armR = 0.05;
      const E = new THREE.Vector3().lerpVectors(W, S, k);
      if (k < 0.75) E.y = 0.06;
      else E.y = lerp(0.06, S.y, (k - 0.75) / 0.25);
      return { E, sag: 2.5 * (1 - k), float: true };
    }
    return null; // aboard and coiled down
  }
  function makeFast(i, tau, S, B, f, man, sailor, t) {
    const hands = new THREE.Vector3(B.x - f.n.x * 0.5, B.y + 0.9, B.z - f.n.z * 0.5);
    standPose(man, t, i);
    sailorIdle(sailor, t, i);
    man.armR = 1.3 + 0.25 * Math.sin(t * 3 + i); // he holds a hand up for the line
    if (tau < 0) return null;
    if (tau < 1.4) { // she throws it: the line flies across
      const k = tau / 1.4;
      sailor.armR = -0.8 + 3.2 * ease(k * 2); sailor.bend = -0.1;
      const E = new THREE.Vector3().lerpVectors(S, hands, ease(k));
      E.y += Math.sin(Math.PI * k) * 3;
      return { E, sag: 0.5 };
    }
    if (tau < 3.2) { // he catches it, walks the eye to the bollard and drops it over
      const k = ease((tau - 1.4) / 1.8);
      man.armR = man.armL = 0.8; man.bend = 0.7 * Math.sin(Math.PI * k);
      return { E: new THREE.Vector3().lerpVectors(hands, B, k), sag: 1.6 };
    }
    // the deck party heaves it taut
    if (tau < 7) haul(sailor, t);
    man.armR = 0.05;
    return { E: B, sag: lerp(1.6, 0.35, ease((tau - 3.2) / 3.8)) };
  }
  function haul(a, t) { a.armL = 1.0 + 0.45 * Math.sin(t * 4.5); a.armR = 1.0 + 0.45 * Math.sin(t * 4.5 + Math.PI); a.bend = 0.35; a.legL = 0.2; a.legR = -0.2; }
  function sailorIdle(a, t, i) { standPose(a, t, i); }

  // ---- People ashore ----
  const H = (x, z) => landHeight(x, z);
  const people = [];
  const SHIRTS = ['#e8e4da', '#3c5a8a', '#8a2f2f', '#2f6a4a', '#d8c9a8', '#40454d', '#c06a2a', '#f0f0ec', '#5a4a7a', '#22252b'];
  const TROUSERS = ['#2e3540', '#3b3f45', '#57534b', '#1f2430', '#6a5f50', '#2b2f38'];
  const SKINS = ['#b98a62', '#a87850', '#8e6142', '#c69a74', '#9a6c48', '#d1a983'];
  const HAIRS = ['#1a1410', '#2b2018', '#3a2a1c', '#121212', '#f2f2ee', '#7a1f2a', '#1f3a5a']; // the last ones: a white, maroon or blue headscarf
  let seed = 0;
  const rnd = () => hash(seed++);
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const person = (extra = {}) => crowd.add({ shirt: pick(SHIRTS), trousers: pick(TROUSERS), skin: pick(SKINS), hair: pick(HAIRS), ...extra });
  // walkers back and forth along a path (image pixels), at their own pace and spacing
  const walk = (pathPx, n, height, extra = {}) => {
    const pts = pathPx.map(([x, y]) => px(x, y));
    const segs = []; let L = 0;
    for (let i = 1; i < pts.length; i++) { const l = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z); segs.push({ a: pts[i - 1], b: pts[i], s0: L, l }); L += l; }
    for (let i = 0; i < n; i++) people.push({ kind: 'walk', a: person(extra), segs, L, s0: rnd() * 2 * L, v: 1.0 + rnd() * 0.5, side: (rnd() - 0.5) * 6, height });
  };
  const stand = (x, y, psiDeg, height, extra = {}, kind = 'stand') => people.push({ kind, a: person(extra), p: px(x, y), psi: (psiDeg * Math.PI) / 180, height, ph: rnd() * 10 });
  walk([[-120, -62], [60, -30], [200, 5], [330, 38]], 22, 'land'); // the corniche
  walk([[22, 200], [26, 500], [34, 800], [60, 1000]], 18, 'land'); // the coast road along the port
  walk([[60, 194], [215, 168]], 6, QUAY); // the old quay
  walk([[300, 424], [550, 382]], 5, QUAY, { shirt: '#f2d21b' }); // dockers on the central pier
  walk([[640, 112], [990, 164]], 7, BW_DECK); // the breakwater's deck
  walk([[455, 1270], [600, 1460], [705, 1630]], 16, 'land'); // the beach
  walk([[400, 640], [550, 625]], 5, QUAY, { shirt: '#f28a1b' }); // the south basin's yard
  for (const [x, y, d] of [[1092, 420, 90], [1100, 398, 85], [1088, 372, 80], [1080, 340, 90]]) stand(x, y, d, BW_DECK, {}, 'angler');
  for (const [x, y, d] of [[905, 519, 140], [888, 528, 150], [870, 537, 145]]) stand(x, y, d, QUAY, {}, 'angler');
  for (const [x, y, d] of [[612, 990, 70], [640, 1070, 75], [662, 1130, 70]]) stand(x, y, d, QUAY, {}, 'angler');
  // people chatting: twos and threes on the quays and the corniche
  for (const [x, y, n] of [[120, 190, 3], [300, 40, 2], [60, 300, 2], [480, 600, 3], [600, 1300, 3], [520, 1380, 2], [-40, -40, 3]]) {
    for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2; stand(x + Math.cos(a) * 1.2, y + Math.sin(a) * 1.2, 180 - (a * 180) / Math.PI, 'land', {}, 'chat'); }
  }
  for (let i = 0; i < 14; i++) stand(480 + rnd() * 160, 1300 + rnd() * 260, rnd() * 360, 'land', {}, rnd() < 0.5 ? 'sit' : 'stand'); // on the sand
  for (let i = 0; i < 10; i++) stand(360 + rnd() * 170, 850 + rnd() * 280, rnd() * 360, 0.7, { shirt: pick(['#2f5f9a', '#c94b30', '#e8e4da']) }, 'fisher'); // on the pontoons
  for (const p of people) if (p.kind !== 'walk') {
    p.a.x = p.p.x; p.a.z = p.p.z; p.a.psi = p.psi;
    p.a.y = p.height === 'land' ? H(p.p.x, p.p.z) : p.height;
    p.a.rod = p.kind === 'angler';
  }

  // ---- Gulls ----
  const NG = 14;
  const gullGeo = (() => {
    const g = new THREE.BufferGeometry();
    // two wings from the body out to the tips, raised in y with |z| so a scale in y flaps them
    const v = [0.25, 0, 0, -0.2, 0, 0, 0.0, 0.25, 0.75, 0.25, 0, 0, 0.0, 0.25, -0.75, -0.2, 0, 0];
    g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
    g.computeVertexNormals();
    return g;
  })();
  const gulls = new THREE.InstancedMesh(gullGeo, new THREE.MeshStandardMaterial({ color: 0xf4f4f0, side: THREE.DoubleSide, roughness: 0.8 }), NG);
  gulls.frustumCulled = false;
  scene.add(gulls);
  const gullData = Array.from({ length: NG }, (_, i) => ({ c: px(500 + hash(i) * 600, 150 + hash(i + 50) * 500), r: 40 + hash(i + 9) * 120, h: 18 + hash(i + 3) * 40, w: (0.12 + hash(i + 7) * 0.12) * (hash(i + 11) < 0.5 ? 1 : -1), ph: hash(i + 13) * 6.3, s: 1.6 + hash(i + 17) * 0.6 }));

  // ---- Each frame ----
  let tTel = -Infinity;
  let lastScreens = 0, lastClock = -1;
  const _gm = new THREE.Matrix4(), _gq = new THREE.Quaternion(), _gp = new THREE.Vector3(), _gs = new THREE.Vector3(), _ge = new THREE.Euler();
  return {
    // the officer of the watch answers a new engine order (he reaches for the telegraph)
    telegraph(t) { tTel = t; },
    // the bridge's interior is drawn: its screens are worth redrawing
    update(t, sim, { bridgeView = false } = {}) {
      // -- the bridge team --
      if (bridgeView) {
        const wheelA = (sim.rudder / RUDDER_MAX) * 2.4;
        helmsman.pose({ armL: 1.1 + 0.28 * Math.sin(wheelA), armR: 1.1 - 0.28 * Math.sin(wheelA), elL: 0.45, elR: 0.45, rollL: 0.18, rollR: 0.18, bend: 0.06, headYaw: 0.05 * Math.sin(t * 0.3), headPitch: 0.05 });
        const tt = t - tTel;
        const glass = (t % 19) > 12; // now and then he looks out through his binoculars
        if (tt < 1.6) { // the telegraph: his right hand goes to the lever and pushes it
          const k = Math.sin(Math.PI * clamp01(tt / 1.6));
          oow.pose({ armR: 0.2 + 0.9 * k, elR: 0.3 + 0.2 * k, rollR: -0.25 * k, armL: 0.05, bend: 0.12 * k, headPitch: 0.25 * k, headYaw: 0.35 * k });
          oow.binos.visible = false;
        } else if (glass) {
          oow.pose({ armL: 1.45, armR: 1.45, elL: 1.9, elR: 1.9, rollL: -0.25, rollR: -0.25, headYaw: 0.25 * Math.sin(t * 0.35), headPitch: -0.04 });
          oow.binos.visible = true;
        } else {
          oow.pose({ armL: 0.08, armR: -0.15, elL: 0.2, elR: 1.6, rollL: 0.1, rollR: 0.2, headYaw: 0.6 * Math.sin(t * 0.21), headPitch: 0.02 }); // a hand at his back, looking about
          oow.binos.visible = false;
        }
        lookout.pose({ armL: 1.45, armR: 1.45, elL: 1.9, elR: 1.9, rollL: -0.25, rollR: -0.25, headYaw: 0.5 * Math.sin(t * 0.17), headPitch: -0.03 });
        lookout.binos.visible = true;
        radarman.pose({ armL: 0.5, armR: 0.35, elL: 1.2, elR: 1.4, bend: 0.25, headPitch: 0.35, headYaw: 0.1 * Math.sin(t * 0.5) });
        if (t - lastScreens > 0.08 || t < lastScreens) { // about 12 times a second
          lastScreens = t;
          drawRadar(sim, t); drawEcdis(sim); drawConn(sim); drawOver(sim);
        }
        const sec = new Date().getSeconds();
        if (sec !== lastClock) { lastClock = sec; drawClock(); }
      }

      // -- the lines and the men who handle them --
      const stage = sim.stage;
      const letGoT = sim.tStart; // when L let her go (null while she is still fast)
      if (stage === 'done' && !berth7) { // make fast: the lines go where she lies now
        const f = TARGET_BERTH.face;
        berth7 = { f, side: sideOf(f, sim.psi), bol: bollards(f, sim.x, sim.z, sim.psi) };
        for (const b of berth7.bol) b.y = BW_DECK + 0.75;
      }
      if (stage !== 'done') berth7 = null;
      const b7 = berth7 ?? berth7Guess();
      const near7 = stage === 'berth' && Math.hypot(sim.x - TARGET_BERTH.x, sim.z - TARGET_BERTH.z) < 450;
      const atStart = stage === 'alongside' || (letGoT !== null && t - letGoT < 30 && stage !== 'done');
      for (let i = 0; i < 4; i++) {
        const L = LINES[i];
        const sailor = deck[i];
        let res = null, berth = null;
        if (stage === 'alongside') { berth = berth3; res = { E: berth3.bol[i], sag: 0.35 }; standPose(linesmen3[i], t, i); sailorIdle(sailor, t, i); }
        else if (atStart) { berth = berth3; res = letGo(i, t - letGoT - LET_GO_ORDER.indexOf(i) * STEP, fair(L, berth3.side), berth3.bol[i], berth3.f, linesmen3[i], sailor, t); }
        else if (stage === 'done') { berth = berth7; res = makeFast(i, t - sim.tFast - FAST_ORDER.indexOf(i) * STEP, fair(L, berth7.side), berth7.bol[i], berth7.f, linesmen7[i], sailor, t); }
        if (res) drawRope(i, fair(L, (berth ?? berth3).side), res.E, res.sag, res.float);
        else hideRope(i);
        // the deck party: at their stations while there is line work to do or about to be
        const side = (stage === 'done' ? b7.side : stage === 'berth' ? sideOf(TARGET_BERTH.face, sim.psi) : berth3.side);
        sailor.visible = stage === 'alongside' || atStart || near7 || stage === 'done';
        const sx = L.ax > 0 ? L.ax - 2.2 : L.ax + 2.2;
        const w = toWorld(sx, deckHeight(sx), side * 3.3);
        Object.assign(sailor, { x: w.x, y: w.y, z: w.z, psi: sim.psi + side * Math.PI / 2 });
        if (near7) { sailorIdle(sailor, t, i); sailor.armR = 0.2; }
        // the linesmen on the quays
        const place = (man, bz, f, show) => {
          man.visible = show;
          if (!show) return;
          const B = bz;
          man.x = B.x - f.n.x * 1.4 + f.dir.x * 0.6; man.z = B.z - f.n.z * 1.4 + f.dir.z * 0.6; man.y = deckOf(f);
          man.psi = Math.atan2(f.n.z, f.n.x);
        };
        // after letting go, berth 3's men walk off along the quay
        const gone = letGoT !== null && t - letGoT > 12;
        place(linesmen3[i], berth3.bol[i], berth3.f, stage === 'alongside' || (atStart && t - letGoT < 26));
        if (gone && linesmen3[i].visible) {
          const d = (t - letGoT - 12) * 1.3;
          linesmen3[i].x -= berth3.f.dir.x * d; linesmen3[i].z -= berth3.f.dir.z * d;
          linesmen3[i].psi = Math.atan2(-berth3.f.dir.z, -berth3.f.dir.x);
          walkPose(linesmen3[i], d * 4.5);
        }
        place(linesmen7[i], b7.bol[i], b7.f, near7 || stage === 'done');
        if (near7) { standPose(linesmen7[i], t, i); if (i === 0) { linesmen7[i].armR = 2.4 + 0.4 * Math.sin(t * 5); linesmen7[i].rollR = 0.4; } } // one waves her in
      }
      ropes.instanceMatrix.needsUpdate = true;

      // -- people ashore --
      for (const p of people) {
        const a = p.a;
        if (p.kind === 'walk') {
          let s = (p.s0 + p.v * t) % (2 * p.L);
          const back = s > p.L;
          if (back) s = 2 * p.L - s;
          let seg = p.segs[0];
          for (const q of p.segs) if (s >= q.s0) seg = q;
          const k = (s - seg.s0) / seg.l;
          const dx = (seg.b.x - seg.a.x) / seg.l, dz = (seg.b.z - seg.a.z) / seg.l;
          const side = back ? -p.side : p.side; // keep to their own side of the path, each way
          a.x = seg.a.x + (seg.b.x - seg.a.x) * k - dz * side * 0.5;
          a.z = seg.a.z + (seg.b.z - seg.a.z) * k + dx * side * 0.5;
          a.y = p.height === 'land' ? H(a.x, a.z) : p.height;
          a.psi = Math.atan2(dz, dx) + (back ? Math.PI : 0);
          walkPose(a, (s * 2 * Math.PI) / 1.45);
        } else if (p.kind === 'angler') {
          standPose(a, t, p.ph); a.armR = 1.0 + 0.05 * Math.sin(t * 0.8 + p.ph); a.armL = 0.9; a.rollL = -0.2;
        } else if (p.kind === 'chat') {
          standPose(a, t, p.ph);
          const talk = Math.sin(t * 0.5 + p.ph) > 0.4; // whoever is talking moves a hand
          if (talk) { a.armR = 0.7 + 0.3 * Math.sin(t * 3.1 + p.ph); a.headYaw = 0.2 * Math.sin(t * 0.9 + p.ph); }
        } else if (p.kind === 'sit') {
          standPose(a, t, p.ph); a.sit = 1; a.armL = a.armR = -0.4; a.bend = -0.25;
        } else if (p.kind === 'fisher') {
          standPose(a, t, p.ph); a.bend = 0.5 + 0.3 * Math.sin(t * 0.7 + p.ph); a.armL = a.armR = 0.7 + 0.2 * Math.sin(t * 1.3 + p.ph); // mending nets
        } else standPose(a, t, p.ph);
      }
      crowd.flush();

      // -- gulls --
      for (let i = 0; i < NG; i++) {
        const G = gullData[i];
        const ang = G.ph + t * G.w;
        _gp.set(G.c.x + Math.cos(ang) * G.r, G.h + 3 * Math.sin(t * 0.4 + i), G.c.z + Math.sin(ang) * G.r);
        const head = ang + (G.w > 0 ? Math.PI / 2 : -Math.PI / 2);
        _gq.setFromEuler(_ge.set(0, -head, (G.w > 0 ? -1 : 1) * 0.35, 'YXZ'));
        const flap = Math.sin(t * 9 + i * 1.7) > -0.2 ? Math.sin(t * 9 + i * 1.7) : -0.2; // flapping, with glides between
        _gm.compose(_gp, _gq, _gs.set(G.s, G.s * (0.3 + flap * (Math.sin(t * 0.3 + i) > 0 ? 1 : 0.15)), G.s));
        gulls.setMatrixAt(i, _gm);
      }
      gulls.instanceMatrix.needsUpdate = true;
    },
  };
}

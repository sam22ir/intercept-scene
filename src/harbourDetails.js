import * as THREE from 'three';
import { deckHeight } from './scenario.js';
import { START_BERTH, TARGET_BERTH, LAND, BREAKWATER, MOORED, TELEGRAPH, KT, px, compass, clearance } from './harbour.js';
import { drawChart } from './harbourMap.js';

// The harbour mission's working details, all driven by the simulation's state (sim.t, the stage, when the lines went and when
// they went on). There are no people: the owner asked for none.
//   - the bridge's instruments (only drawn in the bridge views), drawn live into canvas textures: the radar (the port's echoes, a
//     turning sweep with its afterglow), the chart screen (heading up), the conning display, the overhead rudder / rate-of-turn
//     panel, the clock; a paper chart on a chart table at the back, a lamp, radios, a binocular box and a mug.
//   - the mooring lines as real ropes with sag: alongside berth 3 they are fast; on L each eye lifts off its bollard, drops
//     between the quay and her side and is heaved in, stern line first; at berth 7 each line flies across, drops over its
//     bollard and is heaved taut, bow and stern lines first.
//   - gulls wheeling over the port.
// Ship frame: bow +x, starboard +z, y up (scenario.js).

const QUAY = 2.6, BW_DECK = 3.4;
const Y0 = 9.25; // the wheelhouse floor (models/bridge.js)
const ease = (x) => { const c = Math.min(Math.max(x, 0), 1); return c * c * (3 - 2 * c); };
const lerp = (a, b, k) => a + (b - a) * k;
const hash = (i) => { let h = Math.imul(i + 1, 2654435761); h ^= h >>> 15; return (h >>> 0) / 4294967296; };
const mats = new Map();
const matOf = (hex, rough = 0.75) => { const k = `${hex}/${rough}`; if (!mats.has(k)) mats.set(k, new THREE.MeshStandardMaterial({ color: hex, roughness: rough, metalness: 0.05, envMapIntensity: 0.45 })); return mats.get(k); };

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

export function createHarbourDetails({ scene, ship, bridge }) {
  const _v = new THREE.Vector3();
  const toWorld = (x, y, z) => _v.set(x, y, z).applyMatrix4(ship.group.matrixWorld).clone();

  // ---- The bridge's instruments (children of the wheelhouse group, so they show only in the bridge views) ----
  const inst = new THREE.Group();
  bridge.group.add(inst);
  const radar = screen(384, 384), ecdis = screen(512, 300), conn = screen(512, 300), over = screen(768, 128), clock = screen(128, 128), chart = screen(768, 512);
  // the console's three screens (left, middle, right), laid over models/bridge.js's own, tilted with them
  inst.add(screenMesh(radar, 0.5, 0.5, [14.29, Y0 + 1.34, -2.5], { tilt: 0.5 }));
  inst.add(screenMesh(ecdis, 0.84, 0.49, [14.29, Y0 + 1.34, 0], { tilt: 0.5 }));
  inst.add(screenMesh(conn, 0.84, 0.49, [14.29, Y0 + 1.34, 2.5], { tilt: 0.5 }));
  // the radar's own display on a pedestal at the back, port side
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
  // the chart table at the back, a paper chart on it, a lamp and parallel rules
  const tableTop = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.06, 1.5), matOf(0x6b4a2c, 0.6)); tableTop.position.set(7.35, Y0 + 0.95, 1.2); inst.add(tableTop);
  const tableBody = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.9, 1.45), matOf(0x4a3420, 0.7)); tableBody.position.set(7.35, Y0 + 0.47, 1.2); inst.add(tableBody);
  const paper = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 0.92).rotateX(-Math.PI / 2).rotateY(Math.PI / 2), chart.mat); paper.position.set(7.35, Y0 + 0.985, 1.2); inst.add(paper);
  const rule = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.012, 0.5), matOf(0x9ccfe0, 0.2)); rule.position.set(7.2, Y0 + 0.995, 1.0); rule.rotation.y = 0.4; inst.add(rule);
  const lampArm = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.5, 6), metal); lampArm.position.set(7.0, Y0 + 1.22, 1.85); lampArm.rotation.x = 0.4; inst.add(lampArm);
  const lampHead = new THREE.Mesh(new THREE.ConeGeometry(0.08, 0.12, 12, 1, true), matOf(0x8a2a22, 0.4)); lampHead.position.set(7.05, Y0 + 1.45, 1.75); inst.add(lampHead);
  // VHF sets overhead, a binocular box and a mug of coffee on the console
  for (const z of [-3.4, 3.4]) {
    const vhf = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.09, 0.3), dark); vhf.position.set(14.95, 12.23, z); inst.add(vhf);
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
  // each line: her fairlead (ship frame x), where it leads along the quay (+ ahead)
  const LINES = [{ ax: 50, reach: 24 }, { ax: 36, reach: -18 }, { ax: -36, reach: 18 }, { ax: -52, reach: -24 }]; // bow line, forward spring, after spring, stern line
  const LET_GO_ORDER = [3, 2, 1, 0]; // the stern line first, the bow line last
  const FAST_ORDER = [0, 3, 1, 2]; // the bow and stern lines first, then the springs
  const STEP = 1.8; // s between lines
  const sideOf = (f, psi) => (f.n.x * Math.sin(psi) - f.n.z * Math.cos(psi) > 0 ? 1 : -1); // the side of her that lies to the quay
  // A berth's bollards (fixed in the world), from her pose alongside it.
  function bollards(f, x, z, psi, deck) {
    const c = Math.cos(psi), s = Math.sin(psi);
    return LINES.map((L) => {
      const qx = x + c * (L.ax + L.reach), qz = z + s * (L.ax + L.reach);
      const d = (qx - f.a.x) * f.n.x + (qz - f.a.z) * f.n.z;
      return new THREE.Vector3(qx - f.n.x * (d + 1.1), deck + 0.75, qz - f.n.z * (d + 1.1));
    });
  }
  const berth3 = { f: START_BERTH.face, side: sideOf(START_BERTH.face, START_BERTH.psi), bol: bollards(START_BERTH.face, START_BERTH.x, START_BERTH.z, START_BERTH.psi, QUAY) };
  let berth7 = null; // fixed when she makes fast, from where she lies
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
  // Where a line's free end is, `tau` seconds into its part of the job: letting go (off the bollard, into the water, heaved in) ...
  function letGo(tau, S, B, f) {
    const W = new THREE.Vector3(B.x + f.n.x * 2.6, 0.06, B.z + f.n.z * 2.6); // just off the quay wall
    const lift = new THREE.Vector3(B.x - f.n.x * 0.2, B.y + 0.6, B.z - f.n.z * 0.2);
    if (tau < 0) return { E: B, sag: 0.35 };
    if (tau < 1.3) return { E: new THREE.Vector3().lerpVectors(B, lift, ease(tau / 1.3)), sag: 0.5 };
    if (tau < 2.3) {
      const k = (tau - 1.3) / 1.0;
      const E = new THREE.Vector3().lerpVectors(lift, W, ease(k));
      E.y += Math.sin(Math.PI * k) * 0.6;
      return { E, sag: 1 + k };
    }
    if (tau < 9.5) {
      const k = ease((tau - 2.3) / 7.2);
      const E = new THREE.Vector3().lerpVectors(W, S, k);
      E.y = k < 0.75 ? 0.06 : lerp(0.06, S.y, (k - 0.75) / 0.25);
      return { E, sag: 2.5 * (1 - k), float: true };
    }
    return null; // aboard and coiled down
  }
  // ... and making fast (across to the quay, over the bollard, heaved taut).
  function makeFast(tau, S, B, f) {
    if (tau < 0) return null;
    const over = new THREE.Vector3(B.x - f.n.x * 0.5, B.y + 0.9, B.z - f.n.z * 0.5);
    if (tau < 1.4) {
      const k = tau / 1.4;
      const E = new THREE.Vector3().lerpVectors(S, over, ease(k));
      E.y += Math.sin(Math.PI * k) * 3;
      return { E, sag: 0.5 };
    }
    if (tau < 3.2) return { E: new THREE.Vector3().lerpVectors(over, B, ease((tau - 1.4) / 1.8)), sag: 1.6 };
    return { E: B, sag: lerp(1.6, 0.35, ease((tau - 3.2) / 3.8)) };
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
  let lastScreens = 0, lastClock = -1;
  const _gm = new THREE.Matrix4(), _gq = new THREE.Quaternion(), _gp = new THREE.Vector3(), _gs = new THREE.Vector3(), _ge = new THREE.Euler();
  return {
    update(t, sim, { bridgeView = false } = {}) {
      // -- the bridge's screens, about 12 times a second while they can be seen --
      if (bridgeView) {
        if (t - lastScreens > 0.08 || t < lastScreens) {
          lastScreens = t;
          drawRadar(sim, t); drawEcdis(sim); drawConn(sim); drawOver(sim);
        }
        const sec = new Date().getSeconds();
        if (sec !== lastClock) { lastClock = sec; drawClock(); }
      }

      // -- the mooring lines --
      const stage = sim.stage, letGoT = sim.tStart;
      if (stage === 'done' && sim.tFast !== null && !berth7) {
        const f = TARGET_BERTH.face;
        berth7 = { f, side: sideOf(f, sim.psi), bol: bollards(f, sim.x, sim.z, sim.psi, BW_DECK) };
      }
      if (stage !== 'done') berth7 = null;
      const atStart = stage === 'alongside' || (letGoT !== null && t - letGoT < 30 && stage !== 'done');
      for (let i = 0; i < 4; i++) {
        let res = null, berth = berth3;
        if (stage === 'alongside') res = { E: berth3.bol[i], sag: 0.35 };
        else if (atStart && letGoT !== null) res = letGo(t - letGoT - LET_GO_ORDER.indexOf(i) * STEP, fair(LINES[i], berth3.side), berth3.bol[i], berth3.f);
        else if (berth7) { berth = berth7; res = makeFast(t - sim.tFast - FAST_ORDER.indexOf(i) * STEP, fair(LINES[i], berth7.side), berth7.bol[i], berth7.f); }
        if (res) drawRope(i, fair(LINES[i], berth.side), res.E, res.sag, res.float);
        else hideRope(i);
      }
      ropes.instanceMatrix.needsUpdate = true;

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

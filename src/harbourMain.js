import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createEnvironment } from './environment.js';
import { createShip } from './models/ship.js';
import { createBridge } from './models/bridge.js';
import { createWake } from './fx/wake.js';
import { CameraRig } from './cameraRig.js';
import { pointScale } from './fx/particles.js';
import { menuText } from './menu.js';
import { createHarbour } from './harbourScene.js';
import { createHarbourMap } from './harbourMap.js';
import { createHarbourAudio } from './harbourAudio.js';
import { createHarbourDetails } from './harbourDetails.js';
import { createMobScene } from './harbourMob.js';
import {
  HarbourSim, MobSim, MOB_STEPS, MOB_ZONE, TELEGRAPH, STOP_ORDER, RUDDER_MAX, KT, SPEED_LIMIT, TARGET_BERTH, START_BERTH, LIGHTS, FAIRWAY, HALF_BEAM, BERTH_TOL, compass, thrusterFactor,
} from './harbour.js';
import './helm.css'; // the manual flight's gear and menu (body.mission-fly)
import './harbour.css';

// Entry point of "Harbour pilot", mission id `harbour` (the model is harbour.js, the port harbourScene.js): you take the frigate
// out of Jijel's naval harbour and bring her back alongside. Real time, like Solo Air Defense; start.js imports it when the
// mission is picked.
//
// Views (1 to 6, V cycles): the bridge (drag looks round), the bridge wing over the side toward the quay (press 2 again for the
// other wing), behind her, the chart view straight down (north up), a free orbit, and the pier-head tower on the east arm.

const canvas = document.querySelector('#scene');
const loadingEl = document.querySelector('#loading');
document.body.classList.add('mission-fly', 'mission-harbour'); // the manual flight's bare interface, and this one's own
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, logarithmicDepthBuffer: false });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.75;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, 1, 0.5, 30000);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.maxDistance = 3000;
controls.maxPolarAngle = Math.PI * 0.48;
controls.enabled = false;
const rig = new CameraRig(camera, controls);

const env = createEnvironment(renderer, scene, { look: 'harbour' }); // a clear afternoon (looks.js); the hills are the port's own
env.setShadowSize(2048);
env.ocean.material.uniforms.uShipX.value = 1e7; // the shader's straight-line wake: she turns, she has her own
const harbour = createHarbour(scene);
const ship = createShip({ catapult: false });
ship.group.rotation.order = 'YXZ';
scene.add(ship.group);
const bridge = createBridge();
bridge.group.visible = false;
ship.group.add(bridge.group);
const wake = createWake(scene);
const map = createHarbourMap();
const audio = createHarbourAudio();
// The exercise: the harbour (out and back in, mission `harbour`) or the man overboard drill (mission `mob`); start.js sets it.
const DRILL = globalThis.__HARBOUR_DRILL ?? (new URLSearchParams(location.search).get('mode') === 'mob' ? 'mob' : 'harbour');
const sim = DRILL === 'mob' ? new MobSim() : new HarbourSim();
const mobScene = createMobScene(scene); // the casualty, the lifebuoy and its smoke, the recovery line (the drill only)
const details = createHarbourDetails({ scene, ship, bridge }); // the bridge's screens, the mooring lines, the gulls

// --- The banner --------------------------------------------------------------------------------------------------------
const banner = document.querySelector('#shot-caption');
let bannerUntil = 0;
function say(text, tone = '', ms = 3400) {
  banner.textContent = text;
  banner.className = `shot-caption ${tone === 'danger' ? 'danger' : ''} hb-say-${tone || 'info'}`;
  banner.hidden = false;
  bannerUntil = performance.now() + ms;
}

// --- Views ---------------------------------------------------------------------------------------------------------------
const VIEWS = ['bridge', 'wing', 'behind', 'above', 'orbit', 'tower'];
const VIEW_NAMES = { bridge: 'Bridge', wing: 'Bridge wing', behind: 'Behind her', above: 'Chart view', orbit: 'Orbit', tower: 'Pier-head tower' };
const BRIDGE_EYE = new THREE.Vector3(11.7, 11.0, 0); // behind the wheel, on the centreline (models/bridge.js)
let view = 'behind';
let lookYaw = 0, lookPitch = -0.04; // bridge: degrees off the bow (+ starboard), radians up
let wingSide = 1; // +1 the starboard wing
let wingYaw = 0, wingPitch = 0;
let behindDist = 210, behindYaw = 0, camYaw = 0, snap = true;
let aboveH = 520;
let towerZoom = 1;
const lookAt = new THREE.Vector3();
const _a = new THREE.Vector3(), _b = new THREE.Vector3();
const shipTarget = (out) => out.set(sim.x, 6, sim.z);
// The wing that faces the quay she is at (or coming to), else the one she last used.
function quaySide() {
  const f = sim.stage === 'alongside' ? START_BERTH.face : TARGET_BERTH.face;
  const c = Math.cos(sim.psi), s = Math.sin(sim.psi);
  return f.n.x * s - f.n.z * c > 0 ? 1 : -1;
}
function setView(v, quiet = false) {
  if (v === 'wing' && view === 'wing') wingSide = -wingSide; // a second press goes to the other wing
  else if (v === 'wing') { // the wing over the quay she is at, or (the drill) over the side the casualty is on
    const r = sim.kind === 'mob' ? sim.rel() : null;
    wingSide = r ? (r.az > 0 ? 1 : -1) : sim.stage === 'alongside' || sim.stage === 'berth' ? quaySide() : wingSide;
    wingYaw = 0; wingPitch = 0;
  }
  view = v;
  if (!quiet) intro = null;
  camera.up.set(0, 1, 0);
  if (v === 'orbit') {
    controls.enabled = true;
    shipTarget(controls.target);
    const fx = Math.cos(sim.psi), fz = Math.sin(sim.psi);
    camera.position.set(sim.x - fx * 180 - fz * 160, 120, sim.z - fz * 180 + fx * 160);
    rig.focus('ship', shipTarget, 260, 40);
  } else { controls.enabled = false; rig.free(); }
  snap = true;
  viewButtons.forEach((b) => b.classList.toggle('active', b.dataset.view === v));
  if (!quiet) say(v === 'wing' ? `Bridge wing, ${wingSide > 0 ? 'starboard' : 'port'} side` : VIEW_NAMES[v], '', 1400);
}

// The opening shot: high over the harbour, then down behind her alongside the pier. Any key or click skips it.
let intro = new URLSearchParams(location.search).get('intro') === '0' ? null : { t: 0 };
const INTRO = 7;
const ease = (x) => { const c = Math.min(Math.max(x, 0), 1); return c * c * (3 - 2 * c); };
function skipIntro() { if (intro && intro.t > 0.4) intro = null; }
window.addEventListener('keydown', skipIntro, true);
window.addEventListener('pointerdown', skipIntro, true);

function behindPose(out, look) {
  const ang = camYaw + THREE.MathUtils.degToRad(behindYaw);
  out.set(sim.x - Math.cos(ang) * behindDist, behindDist * 0.2 + 14, sim.z - Math.sin(ang) * behindDist);
  look.set(sim.x + Math.cos(camYaw) * 40, 4, sim.z + Math.sin(camYaw) * 40);
}

let fov = 50;
function setFov(f) { if (Math.abs(camera.fov - f) > 0.01) { camera.fov = f; camera.updateProjectionMatrix(); } }
function updateCamera(dt) {
  bridge.group.visible = view === 'bridge' || view === 'wing';
  const k = 1 - Math.exp(-dt / 0.6);
  if (snap) camYaw = sim.psi;
  else camYaw += Math.atan2(Math.sin(sim.psi - camYaw), Math.cos(sim.psi - camYaw)) * k;
  if (intro) {
    intro.t += dt;
    const u = ease(intro.t / INTRO);
    behindPose(_a, _b);
    const hx = 260, hz = 900; // high over the sea east of the harbour, looking in at the port
    const from = new THREE.Vector3(hx, 650, hz), fromLook = new THREE.Vector3(-150, 0, -350);
    camera.position.lerpVectors(from, _a, u);
    lookAt.lerpVectors(fromLook, _b, ease((intro.t - 1) / (INTRO - 1)));
    camera.lookAt(lookAt);
    setFov(50);
    if (intro.t >= INTRO) { intro = null; snap = false; }
    return;
  }
  const wantNear = view === 'above' ? Math.min(Math.max(aboveH * 0.05, 0.5), 60) : view === 'bridge' || view === 'wing' ? 0.3 : 0.6;
  if (camera.near !== wantNear) { camera.near = wantNear; camera.updateProjectionMatrix(); }
  let wantFov = 50;
  if (view === 'orbit') {
    rig.update();
    controls.update();
    if (camera.position.y < 3) camera.position.y = 3;
  } else if (view === 'bridge') {
    bridge.update(THREE.MathUtils.clamp(sim.rudder / RUDDER_MAX, -1, 1), sim.order / (TELEGRAPH.length - 1));
    ship.group.localToWorld(camera.position.copy(BRIDGE_EYE));
    const yaw = THREE.MathUtils.degToRad(lookYaw);
    _a.set(Math.cos(yaw) * Math.cos(lookPitch), Math.sin(lookPitch), Math.sin(yaw) * Math.cos(lookPitch)).transformDirection(ship.group.matrixWorld);
    camera.lookAt(lookAt.copy(camera.position).add(_a));
    wantFov = 58;
  } else if (view === 'wing') {
    // Out on the wing, over her side, looking down at the water between her and the quay (drag looks round).
    ship.group.localToWorld(camera.position.set(12.6, 11.8, wingSide * 7.6)); // at the end of the wing, over her side
    const yaw = THREE.MathUtils.degToRad(wingYaw) + wingSide * Math.PI * 0.62;
    const pitch = -0.32 + wingPitch;
    _a.set(Math.cos(yaw) * Math.cos(pitch), Math.sin(pitch), Math.sin(yaw) * Math.cos(pitch)).transformDirection(ship.group.matrixWorld);
    camera.lookAt(lookAt.copy(camera.position).add(_a));
    wantFov = 62;
  } else if (view === 'above') {
    camera.position.set(sim.x, aboveH, sim.z);
    camera.up.set(1, 0, 0); // north up
    camera.lookAt(sim.x, 0, sim.z);
  } else if (view === 'tower') {
    // The lantern gallery of the green light on the east arm: a long lens that keeps her about the same size.
    const L = LIGHTS[1];
    camera.position.set(L.x, 3.4 + 12.5, L.z);
    camera.lookAt(sim.x, 5, sim.z);
    const d = Math.hypot(sim.x - L.x, sim.z - L.z);
    wantFov = THREE.MathUtils.clamp((2 * Math.atan(170 / Math.max(d, 1)) * 180) / Math.PI / towerZoom, 4, 70);
  } else {
    behindPose(camera.position, lookAt);
    camera.lookAt(lookAt);
  }
  fov += (wantFov - fov) * (view === 'tower' ? 1 - Math.exp(-dt / 0.4) : 1);
  setFov(fov);
  snap = false;
}

let drag = null;
canvas.addEventListener('pointerdown', (e) => { if (e.button === 0 && view !== 'orbit') drag = { x: e.clientX, y: e.clientY }; });
window.addEventListener('pointerup', () => { drag = null; });
window.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  drag = { x: e.clientX, y: e.clientY };
  if (view === 'bridge') {
    lookYaw = ((lookYaw + dx * 0.25 + 540) % 360) - 180;
    lookPitch = THREE.MathUtils.clamp(lookPitch - dy * 0.004, -0.9, 0.6);
  } else if (view === 'wing') {
    wingYaw += dx * 0.25;
    wingPitch = THREE.MathUtils.clamp(wingPitch - dy * 0.004, -0.9, 0.9);
  } else if (view === 'behind') behindYaw += dx * 0.3;
});
canvas.addEventListener('dblclick', () => { lookYaw = 0; lookPitch = -0.04; wingYaw = 0; wingPitch = 0; behindYaw = 0; behindDist = 210; aboveH = 520; towerZoom = 1; });
canvas.addEventListener('wheel', (e) => {
  const f = Math.exp(e.deltaY * 0.001);
  if (view === 'behind') behindDist = THREE.MathUtils.clamp(behindDist * f, 70, 1500);
  else if (view === 'above') aboveH = THREE.MathUtils.clamp(aboveH * f, 120, 6000);
  else if (view === 'tower') towerZoom = THREE.MathUtils.clamp(towerZoom / f, 0.3, 6);
}, { passive: true });

// --- Readouts --------------------------------------------------------------------------------------------------------------
// The task card (top right), the conning display (bottom middle: rudder, heading, speed, telegraph, thrusters, hull), the berthing
// display (left, near the berth: her distance off the quay at the bow and the stern, and how far along), and the end card.
const taskEl = document.createElement('div');
taskEl.className = 'hb-task';
const dockEl = document.createElement('div');
dockEl.className = 'hb-dock';
const endEl = document.createElement('div');
endEl.className = 'hb-end';
endEl.hidden = true;
document.body.append(taskEl, dockEl, endEl);

const ORDER_STAGES = ['alongside', 'depart', 'sea', 'return', 'berth'];
const brgTo = (x, z) => compass(Math.atan2(z - sim.z, x - sim.x));
const pad3 = (d) => String(Math.round(d) % 360).padStart(3, '0');
const dist = (m) => (m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`);
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
function wtHtml() { // the man overboard drill: the Williamson turn, ticked off as she does it
  if (!sim.casualty) return '';
  const w = sim.wt, sideName = sim.side > 0 ? 'starboard' : 'port', other = sim.side > 0 ? 'port' : 'starboard';
  const recip = pad3(compass(sim.h0 + Math.PI));
  const li = (done, now, text, cls = '') => `<li class="${done ? 'hb-done' : now ? 'hb-now' : ''} ${cls}">${text}</li>`;
  const dev = Math.round(sim.deviation);
  return `<ol class="hb-wt">`
    + li(w.firstRudder === 'right', w.firstRudder === null, `Hard ${sideName}${w.firstRudder === 'wrong' ? ': wrong way first' : ''}`, w.firstRudder === 'wrong' ? 'bad' : '')
    + li(w.phase >= 1, w.phase === 0 && w.firstRudder !== null, w.phase >= 1 ? `Hard ${other} at ${Math.round(w.reversedAt)}° off` : `At 60° off, hard ${other} · now ${Math.max(0, dev)}°`)
    + li(w.phase >= 2, w.phase === 1, `Steady on ${recip}°, back down the wake`)
    + li(sim.stage === 'done', w.phase >= 2 || sim.stage === 'recover', 'Slow down, stop with him abeam')
    + `</ol><div class="hb-mark"><span>In the water</span><b>${mmss(sim.t - sim.tAlarm)}</b></div>`;
}
function taskHtml() {
  const st = sim.stageText;
  const list = sim.kind === 'mob' ? MOB_STEPS : ORDER_STAGES;
  const n = list.indexOf(sim.stage);
  const steps = list.map((s, i) => `<i class="${i < n || sim.stage === 'done' ? 'done' : i === n ? 'now' : ''}"></i>`).join('');
  const m = sim.mark;
  const mk = m ? `<div class="hb-mark"><span>${m.name}</span><b>${dist(Math.hypot(m.x - sim.x, m.z - sim.z))}</b><b>${pad3(brgTo(m.x, m.z))}°</b></div>` : '';
  const inside = sim.inside, kn = Math.abs(sim.u) / KT;
  const lim = inside ? `<div class="hb-limit ${kn > SPEED_LIMIT + 0.2 ? 'over' : ''}">Harbour speed limit <b>${SPEED_LIMIT} kn</b></div>` : '';
  return `<div class="hb-steps">${steps}</div><div class="hb-ttl">${st.title}</div><p>${st.task}</p>${mk}${lim}${sim.kind === 'mob' ? wtHtml() : ''}`;
}
// --- The steering readouts: Solo Air Defense's strip (the .helm-ship styles in helm.css) --------------------------------------
// Round badges at the left (hull, speed against the harbour limit, thrusters, contacts), the dome in the middle (the heading slides
// round its rim, the rudder is the arc on its outer line, the speed under it) between two brass propellers and the telegraph bars,
// and round command buttons at the right (the lines, the horn, sail again). Each badge and button tells what it is on hover.
const PROP_SVG = '<svg viewBox="-24 -24 48 48" aria-hidden="true"><defs><linearGradient id="pp-brass" x1="0" y1="-23" x2="9" y2="-6" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#f6e4a2"/><stop offset="0.55" stop-color="#d9b45c"/><stop offset="1" stop-color="#9b7632"/></linearGradient></defs><g class="pp-rot">'
  + [0, 90, 180, 270].map((a) => `<g transform="rotate(${a})"><path d="M-2 -6 C-8.5 -9.5 -9.5 -19 -4 -22.6 C1 -24.5 8.4 -22 9 -17.6 C7 -12 4 -8 2.2 -6 Z" class="pp-blade"/><path d="M-3.4 -9 C-6 -13 -5.8 -18 -3 -20.6" class="pp-edge"/></g>`).join('')
  + '</g><circle r="5.4" class="pp-hubring"/><circle r="3" class="pp-hub"/><circle r="1" class="pp-cap"/></svg>';
const shipEl = document.createElement('div');
shipEl.id = 'harbour-ship';
shipEl.className = 'helm-ship hp-ship';
const statHost = document.createElement('div'), centre = document.createElement('div'), cmdHost = document.createElement('div'), domeHost = document.createElement('div');
statHost.className = 'hs-badges';
cmdHost.className = 'hs-badges hs-cmds';
centre.className = 'hs-centre';
const propL = document.createElement('div'), propR = document.createElement('div'), barL = document.createElement('div'), barR = document.createElement('div');
propL.className = 'hs-prop pp-l'; propR.className = 'hs-prop pp-r';
propL.innerHTML = propR.innerHTML = PROP_SVG;
propL.title = propR.title = 'The two screws: they turn with the engine order (backwards astern)';
barL.className = barR.className = 'hs-lvl'; // the telegraph: four notches ahead (dead slow to full), lit from the bottom; astern lights them blue
barL.innerHTML = barR.innerHTML = '<i></i><i></i><i></i><i></i>';
barL.title = barR.title = 'Engine telegraph (↑ ↓)';
centre.append(barL, propL, domeHost, propR, barR);
shipEl.append(statHost, centre, cmdHost);
document.body.appendChild(shipEl);
const propRotL = propL.querySelector('.pp-rot'), propRotR = propR.querySelector('.pp-rot');
let propAng = 0, rev = 0;
function spinProps(dt) {
  rev += ((sim.ordered / 16) - rev) * (1 - Math.exp(-dt / 1.5)); // the screws run up and down with the order, not at once
  propAng = (propAng + rev * 7 * dt) % (Math.PI * 2);
  const deg = (propAng * 180) / Math.PI;
  propRotL.style.transform = `rotate(${-deg}deg)`; propRotR.style.transform = `rotate(${deg}deg)`; // twin screws, turning outward
  const ahead = Math.max(0, sim.order - STOP_ORDER), astern = Math.max(0, STOP_ORDER - sim.order);
  for (const bar of [barL, barR]) {
    const n = bar.children.length;
    for (let q = 0; q < n; q++) {
      const fromBottom = n - 1 - q;
      bar.children[q].className = fromBottom < ahead ? (fromBottom === n - 1 ? 'top' : 'on') : fromBottom < astern ? 'astern' : '';
    }
  }
  const blur = Math.min(1, Math.abs(rev)).toFixed(2);
  propL.style.setProperty('--blur', blur); propR.style.setProperty('--blur', blur);
}
const DOME_R = 94, DOME_K = 1.5; // the rim's radius (svg units) and how many degrees of arc a degree of heading takes
const f1 = (v, d = 0) => v.toFixed(d);
function domeSvg() {
  const h = compass(sim.psi);
  const cx = 100, cy = 100;
  const pt = (r, a) => [(cx + r * Math.cos(a)).toFixed(1), (cy - r * Math.sin(a)).toFixed(1)];
  let ticks = '', labels = '';
  for (let d = Math.ceil((h - 58) / 5) * 5; d <= h + 58; d += 5) {
    const a = Math.PI / 2 - THREE.MathUtils.degToRad((d - h) * DOME_K);
    if (a < 0.05 || a > Math.PI - 0.05) continue;
    const major = d % 30 === 0;
    const [x1, y1] = pt(DOME_R, a), [x2, y2] = pt(DOME_R - (major ? 9 : d % 10 === 0 ? 6 : 3.5), a);
    ticks += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" class="${major ? 'mj' : ''}"/>`;
    if (major) { const [x, y] = pt(DOME_R - 23, a); labels += `<text x="${x}" y="${y}" class="dl">${String(((d % 360) + 360) % 360).padStart(3, '0')}</text>`; }
  }
  // the rudder: an arc on the rim's outer line, from the top (midships), red to port and green to starboard
  const RR = DOME_R + 2.5, span = THREE.MathUtils.degToRad(74);
  const th = THREE.MathUtils.clamp(sim.rudder / RUDDER_MAX, -1, 1) * span;
  const p0 = pt(RR, Math.PI / 2), p1 = pt(RR, Math.PI / 2 - th), pl = pt(RR, Math.PI / 2 + span), pr = pt(RR, Math.PI / 2 - span);
  const fill = Math.abs(th) > 0.01 ? `<path d="M${p0[0]},${p0[1]} A${RR},${RR} 0 0 ${th > 0 ? 1 : 0} ${p1[0]},${p1[1]}" class="rf ${th > 0 ? 'stbd' : 'port'}"/>` : '';
  const kn = sim.u / KT;
  const way = kn > 0.05 ? 'ahead' : kn < -0.05 ? 'astern' : 'stopped';
  const side = Math.abs(sim.v) > 0.03 ? ` · ${f1(Math.abs(sim.v) / KT, 1)} ${sim.v > 0 ? '▶' : '◀'}` : '';
  return `<svg viewBox="0 0 200 104" class="dome-svg" aria-hidden="true"><path d="M6,100 A${DOME_R},${DOME_R} 0 0 1 194,100" class="rim"/>${ticks}${labels}`
    + `<path d="M${cx - 4},${cy - DOME_R - 1} L${cx + 4},${cy - DOME_R - 1} L${cx},${cy - DOME_R + 6} Z" class="lub"/>`
    + `<text x="${cx}" y="79" class="hd">${pad3(h)}°</text>`
    + `<path d="M${pl[0]},${pl[1]} A${RR},${RR} 0 0 1 ${pr[0]},${pr[1]}" class="rt"/>${fill}`
    + `<line x1="${p0[0]}" y1="${(Number(p0[1]) - 4).toFixed(1)}" x2="${p0[0]}" y2="${(Number(p0[1]) + 4).toFixed(1)}" class="rm"/>`
    + `<text x="${cx}" y="94" class="sp">${f1(Math.abs(kn), 1)}<tspan> kn ${way}${side}</tspan></text></svg>`;
}
const RING_C = 2 * Math.PI * 20;
function badge(cls, icon, frac, title, sub, chip) {
  const k = Math.max(0, Math.min(1, frac));
  return `<div class="hs-badge ${cls}"><svg class="hb-ring" viewBox="0 0 46 46" aria-hidden="true"><circle class="hb-bg" cx="23" cy="23" r="20"/><circle class="hb-fg" cx="23" cy="23" r="20" style="stroke-dasharray:${(RING_C * k).toFixed(1)} 126"/></svg>`
    + `<span class="hb-ico"><svg viewBox="0 0 24 24">${icon}</svg></span>${chip === '' ? '' : `<i class="hb-chip">${chip}</i>`}<span class="hb-tip"><b>${title}</b><small>${sub}</small></span></div>`;
}
const BI = { // 24 x 24 drawings, animated by CSS (helm.css .hb-bob / .hb-wave, harbour.css .hpb-*)
  hull: '<g class="hb-bob"><path class="hb-fill" d="M2 15h18.2l3-1.6-2.1 5.6H4.6z"/><path d="M8.6 15l1.5-4h6l2.2 4"/><path d="M11.6 11l.9-2.6h3.3l.8 2.6"/><path d="M14.3 8.4V3.6M13 5.2h2.6"/><circle cx="7.4" cy="13.1" r="1.4"/></g><path class="hb-wave" d="M1 21.4q2-1.3 4 0t4 0 4 0 4 0 4 0 4 0"/>',
  speed: '<path d="M3.5 17a8.5 8.5 0 1 1 17 0"/><path d="M6 17h1.4M16.6 17H18M12 8.6V10M7.4 10.8l1 1M16.6 10.8l-1 1"/><g class="hpb-needle"><path class="hb-fill" d="M12 17l-1.2-1.2 5-4.4 .6.6z"/></g><circle cx="12" cy="17" r="1.4"/>',
  thr: '<path class="hb-fill" d="M12 2.5c3 3 3.6 6.5 3.6 9.5v9.5H8.4V12c0-3 .6-6.5 3.6-9.5z"/><g class="hpb-push"><path d="M17.8 7.5h4M20 5.6l1.9 1.9L20 9.4"/><path d="M6.2 17.5h-4M4 15.6l-1.9 1.9L4 19.4"/></g>',
  bump: '<path d="M3 20.5h18M5.5 20.5V8.5h3v12M15.5 20.5V8.5h3v12"/><rect class="hb-fill" x="9.6" y="11.5" width="4.8" height="6" rx="1.2"/><g class="hpb-hit"><path d="M12 3v3M8.6 4.4l1.3 2.2M15.4 4.4l-1.3 2.2"/></g>',
};
function badgesHtml() {
  const hull = 100 - sim.damage, n = sim.contacts.touch + sim.contacts.hard + sim.contacts.crash;
  const tone = sim.stage === 'wrecked' ? 'out' : sim.damage === 0 ? 'ok' : sim.damage < 40 ? 'hurt' : 'bad';
  const kn = Math.abs(sim.u) / KT, inside = sim.inside;
  const sCls = !inside ? 'sea' : kn > SPEED_LIMIT + 0.2 ? 'over' : kn > SPEED_LIMIT - 1 ? 'near' : 'ok';
  const tf = thrusterFactor(sim.u), busy = Math.abs(sim.thr.yaw) + Math.abs(sim.thr.sway) > 0.05;
  return badge(`hb-hull ${tone}`, BI.hull, hull / 100, 'Hull', `${Math.round(hull)} % · ${sim.contacts.hard} hard contacts, ${sim.contacts.crash} collisions`, '')
    + badge(`hpb-speed ${sCls}`, BI.speed, kn / (inside ? SPEED_LIMIT : 16), inside ? `Harbour limit ${SPEED_LIMIT} kn` : 'Speed', `${f1(kn, 1)} kn${inside ? (sCls === 'over' ? ': too fast inside' : ' inside the harbour') : ' outside the harbour'}`, f1(kn, 0))
    + badge(`hpb-thr ${tf < 0.05 ? 'off' : busy ? 'busy' : 'ok'}`, BI.thr, tf, 'Thrusters', tf < 0.05 ? 'no effect above 5 kn' : `${Math.round(tf * 100)} % · Q E turn, A D sideways`, '')
    + badge(`hpb-bump ${sim.contacts.hard + sim.contacts.crash ? 'bad' : n ? 'warn' : 'ok'}`, BI.bump, 1, 'Contacts', n ? `${sim.contacts.touch} touches, ${sim.contacts.hard} hard, ${sim.contacts.crash} collisions` : 'none yet', String(n));
}
const CI = { // the commands' drawings, 32 x 32
  lines: '<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M7 27h18M10 27v-9h4v9M18 27v-9h4v9M8.5 18h15"/><g class="hpc-rope"><path d="M12 18c0-5 2-9 8-11.5M20 6.5c2.5-1 5-.6 6.5 1"/><circle class="fill" cx="27" cy="8" r="2.2"/></g></svg>',
  horn: '<svg viewBox="0 0 32 32" aria-hidden="true"><path class="fill" d="M5 13h4l9-6v18l-9-6H5z"/><path d="M9 13v6"/><g class="hpc-waves"><path d="M21.5 11.5a6 6 0 0 1 0 9"/><path class="w2" d="M24.5 8.5a10 10 0 0 1 0 15"/></g></svg>',
  again: '<svg viewBox="0 0 32 32" aria-hidden="true"><g class="fu-turn"><path d="M26 16a10 10 0 1 1-3.2-7.4M26 6v6h-6"/></g></svg>',
};
const cmd = (cls, act, icon, title, sub, key, on) => `<button type="button" class="helm-act ${cls}${on ? ' go' : ''}" data-act="${act}"><i class="sp-ico">${icon}</i><span class="sp-txt"><b>${title}</b><small>${sub}</small></span><kbd>${key}</kbd></button>`;
function cmdHtml() {
  const b = sim.stage === 'berth' ? sim.berthState() : null;
  const lt = sim.stage === 'alongside' ? ['Let go the lines', 'fore and aft, stern line first'] : b ? ['Make fast', b.ok ? 'she lies still: lines on' : b.why] : sim.stage === 'done' ? ['All fast', 'alongside berth 7'] : ['Lines', 'stowed: they go on at berth 7'];
  return (sim.kind === 'mob' ? '' : cmd('helm-act-heli hpc-lines', 'lines', CI.lines, lt[0], lt[1], 'L', sim.stage === 'alongside' || (b && b.ok)))
    + cmd('hpc-horn', 'horn', CI.horn, 'Ship\'s horn', 'one prolonged blast leaving the berth', 'B', false)
    + cmd('fu-again', 'again', CI.again, 'Sail again', sim.kind === 'mob' ? 'the drill again, from the start' : 'back alongside berth 3', 'R', sim.over);
}
cmdHost.addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  ({ lines: () => sim.lineKey(), horn: () => { audio.horn(); say('One prolonged blast', '', 1600); }, again: () => restart() })[btn.dataset.act]?.();
  btn.blur();
});
let lastBadges = '', lastDome = '', lastCmd = '';
function updateBottom(dt) {
  const bd = badgesHtml();
  if (bd !== lastBadges) { statHost.innerHTML = bd; lastBadges = bd; }
  const dm = `<div class="hs-dome">${domeSvg()}</div>`;
  if (dm !== lastDome) { domeHost.innerHTML = dm; lastDome = dm; }
  const cm = cmdHtml();
  if (cm !== lastCmd) { cmdHost.innerHTML = cm; lastCmd = cm; }
  spinProps(dt);
}
function recoverHtml() {
  const r = sim.rel();
  if (!r || r.d > 350 || sim.stage === 'done') return '';
  if (sim.stage !== 'recover' && sim.wt.phase < 2 && r.d > 60) return ''; // only once she is coming back to him
  const Z = MOB_ZONE, off = Math.abs(r.az) - HALF_BEAM;
  const sog = Math.hypot(sim.u, sim.v) / KT;
  const abeam = r.ax > Z.aft && r.ax < Z.fwd;
  const okOff = Math.abs(r.az) > Z.near && Math.abs(r.az) < Z.far;
  const hold = sim.recoverHold / Z.hold;
  const why = !abeam ? (r.ax > 0 ? `He is ${Math.round(r.ax)} m ahead: come on slowly` : `He is ${Math.round(-r.ax)} m astern: she has overshot`)
    : !okOff ? (off < 2 ? 'Too close: keep him clear of her side' : 'Closer: within 20 m of her side') : sog >= Z.speed / KT ? 'Stop her: under 1 knot' : 'Hold her steady';
  return `<div class="hb-dtl">Casualty · ${r.az > 0 ? 'starboard' : 'port'} side</div>`
    + `<div class="hb-gaps"><div><span>Ahead</span><b class="${abeam ? 'ok' : 'far'}">${Math.round(r.ax)}<small>m</small></b></div><div><span>Off her side</span><b class="${okOff ? 'ok' : off < 2 ? 'bad' : 'far'}">${Math.max(0, off).toFixed(0)}<small>m</small></b></div></div>`
    + `<div class="hb-row"><span>Speed over the ground</span><b class="${sog >= Z.speed / KT ? 'bad' : ''}">${sog.toFixed(1)} kn</b></div>`
    + `<div class="hb-row"><span>Range</span><b>${Math.round(r.d)} m</b></div>`
    + (sim.stage === 'recover' ? `<div class="hb-ready">Line on him: hauling in <i style="--p:${Math.min(hold, 1).toFixed(2)}"></i></div>` : `<div class="hb-why">${why}</div>`);
}
function dockHtml() {
  if (sim.kind === 'mob') return recoverHtml();
  if (sim.stage !== 'berth' && sim.stage !== 'done') return '';
  const b = sim.berthState();
  if (b.dist > 320) return '';
  const T = BERTH_TOL;
  const gap = (v) => `<b class="${v < 0.4 ? 'bad' : v > T.offMax - HALF_BEAM + 1.5 ? 'far' : 'ok'}">${v.toFixed(1)}<small>m</small></b>`;
  const hold = sim.berthHold / T.hold;
  const ready = b.ok ? `<div class="hb-ready">Ready: lines going on <i style="--p:${Math.min(hold, 1).toFixed(2)}"></i></div>` : `<div class="hb-why">${b.why}</div>`;
  const along = Math.round(b.along);
  return `<div class="hb-dtl">Berth 7 · ${TARGET_BERTH.face.name}</div>`
    + `<div class="hb-gaps"><div><span>Bow off</span>${gap(b.gapFwd)}</div><div><span>Stern off</span>${gap(b.gapAft)}</div></div>`
    + `<div class="hb-row"><span>Along the berth</span><b>${along === 0 ? 'on the mark' : `${Math.abs(along)} m ${along > 0 ? 'east' : 'west'}`}</b></div>`
    + `<div class="hb-row"><span>Closing the quay</span><b class="${b.closing > HARD_KN ? 'bad' : ''}">${(b.closing / KT).toFixed(2)} kn</b></div>`
    + `<div class="hb-row"><span>Off parallel</span><b>${(b.head * 180 / Math.PI).toFixed(1)}°</b></div>${sim.stage === 'done' ? '' : ready}`;
}
const HARD_KN = 0.5;
function endHtml() {
  const r = sim.result;
  const again = '<div class="hb-end-b"><button type="button" data-act="again">Try again <kbd>R</kbd></button><button type="button" data-act="menu">Main menu</button></div>';
  if (sim.kind === 'mob' && sim.stage === 'lost') {
    return `<div class="hb-end-k bad">Casualty lost</div><h2>${r.lost === 'screws' ? 'Drawn into the screws' : 'She ran him down'}</h2><p>${r.lost === 'screws' ? 'Keep the stern swung away from him and stop the screws before he is near them.' : 'Come up to him slowly, with him on her side, never under her bow.'}</p>${again}`;
  }
  if (sim.kind === 'mob' && sim.stage === 'done') {
    const stars = '★'.repeat(r.stars) + '<i>' + '★'.repeat(3 - r.stars) + '</i>';
    return `<div class="hb-end-k">Casualty recovered</div><div class="hb-stars">${stars}</div><h2>He is aboard</h2>`
      + `<dl><dt>In the water</dt><dd>${mmss(r.time)}</dd><dt>First rudder</dt><dd>${r.firstRudder === 'right' ? (r.immediate ? 'toward him, at once' : 'toward him, but late') : r.firstRudder === 'wrong' ? 'away from him: the stern swung at him' : 'none'}</dd>`
      + `<dt>Williamson turn</dt><dd>${r.williamson ? `yes: reversed at ${Math.round(r.reversedAt)}° off` : r.reversedAt !== null ? `reversed at ${Math.round(r.reversedAt)}° off (50 to 75 is right)` : 'not used'}</dd>`
      + `<dt>Contacts</dt><dd>${r.contacts.touch + r.contacts.hard + r.contacts.crash}</dd></dl>${again}`;
  }
  if (sim.stage === 'wrecked') {
    return `<div class="hb-end-k">Holed</div><h2>The pilot is relieved</h2><p>She hit too hard to go on: ${sim.contacts.hard} hard contacts and ${sim.contacts.crash} collisions.</p><div class="hb-end-b"><button type="button" data-act="again">Sail again <kbd>R</kbd></button><button type="button" data-act="menu">Main menu</button></div>`;
  }
  const stars = '★'.repeat(r.stars) + '<i>' + '★'.repeat(3 - r.stars) + '</i>';
  return `<div class="hb-end-k">All fast · berth 7</div><div class="hb-stars">${stars}</div><h2>Finished with engines</h2>`
    + `<dl><dt>Time from letting go</dt><dd>${mmss(r.time)}</dd><dt>Fastest inside</dt><dd>${r.maxInside.toFixed(1)} kn${r.overLimit > 1 ? ` · ${Math.round(r.overLimit)} s over ${SPEED_LIMIT} kn` : ''}</dd>`
    + `<dt>Contacts</dt><dd>${r.contacts.touch} touches · ${r.contacts.hard} hard · ${r.contacts.crash} collisions</dd><dt>Hull</dt><dd>${Math.round(100 - r.damage)} %</dd>`
    + `<dt>Alongside</dt><dd>${Math.abs(Math.round(r.along))} m from the mark · ${r.gapFwd.toFixed(1)} m / ${r.gapAft.toFixed(1)} m off</dd></dl>`
    + `<div class="hb-end-b"><button type="button" data-act="again">Sail again <kbd>R</kbd></button><button type="button" data-act="menu">Main menu</button></div>`;
}
endEl.addEventListener('click', (e) => {
  const a = e.target.closest('button')?.dataset.act;
  if (a === 'again') restart();
  else if (a === 'menu') document.querySelector('#btn-ship').click();
});

// The keys for this moment, as Solo Air Defense shows them (the #fly-keys tiles in helm.css; the keys button in the view strip shows
// them). A tile can be clicked or held: it does what the key does.
const keysEl = document.createElement('div');
keysEl.id = 'fly-keys';
keysEl.className = 'fly-keys';
document.body.appendChild(keysEl);
const HELD = new Set(['ArrowLeft', 'ArrowRight', 'q', 'e', 'a', 'd']);
keysEl.addEventListener('pointerdown', (e) => {
  const key = e.target instanceof Element ? e.target.closest('.fk-btn')?.dataset.key : null;
  if (!key) return;
  e.preventDefault();
  window.dispatchEvent(new KeyboardEvent('keydown', { key }));
  const up = () => { window.dispatchEvent(new KeyboardEvent('keyup', { key })); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up); };
  if (HELD.has(key)) { window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up); } else up();
});
function keysHtml() {
  const k = (key, label, data, on = false) => `<span class="fk fk-btn${on ? ' on' : ''}" data-key="${data}"><kbd>${key}</kbd>${label}</span>`;
  const out = [];
  if (sim.stage === 'alongside') out.push(k('L', 'let go the lines', 'l', true));
  if (sim.stage === 'berth' && sim.berthState().ok) out.push(k('L', 'make fast', 'l', true));
  if (sim.over) out.push(k('R', 'sail again', 'r', true));
  out.push(k('←', 'port', 'ArrowLeft', input.wheel < 0), k('→', 'starboard', 'ArrowRight', input.wheel > 0), k('↑', 'more ahead', 'ArrowUp'), k('↓', 'more astern', 'ArrowDown'));
  out.push(k('Q', 'turn to port', 'q', input.turn < 0), k('E', 'turn to stbd', 'e', input.turn > 0), k('A', 'sideways port', 'a', input.slide < 0), k('D', 'sideways stbd', 'd', input.slide > 0));
  out.push(k('B', 'horn', 'b'), k('V', 'next view', 'v'));
  return out.join('');
}

// --- The view strip (Solo Air Defense's .helm-views: icons, the one in use opens into a pill with its name) and the gear menu ---
const strip = document.createElement('div');
strip.className = 'helm-views';
const MOTION = !globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const ICONS = { // drawn for what each view is
  bridge: '<g class="wheel"><circle cx="12" cy="12" r="6.2"/><circle cx="12" cy="12" r="1.7"/><path d="M12 2.5v4M12 17.5v4M2.5 12h4M17.5 12h4M5.3 5.3l2.5 2.5M16.2 16.2l2.5 2.5M18.7 5.3l-2.5 2.5M7.8 16.2l-2.5 2.5"/></g>',
  wing: '<path d="M3 20.5h18"/><path d="M5 20.5V10h8.5l5.5 4v6.5"/><path d="M13.5 10V6h-4v4M7.5 14h3M14 14h3"/><g class="lines"><path d="M20 9l2.5-1.5M20 12h3"/></g>',
  behind: '<path d="M8 14h13l-2.5 4H10z"/><path d="M12 14v-3h5l1.5 3"/><g class="lines"><path d="M2 12.5h3.5M1 15.5h4.5M3 18.5h3.5"/></g>',
  above: '<path d="M12 2.5c3.2 3 4.3 7 4.3 11v5.7L14 22h-4l-2.3-2.8v-5.7c0-4 1.1-8 4.3-11z"/><path d="M12 8v10M9.7 13h4.6"/>',
  orbit: '<g transform="rotate(-25 12 12)"><ellipse cx="12" cy="12" rx="9.5" ry="4.6"/>' + (MOTION ? '<circle r="1.7" style="fill:currentColor"><animateMotion dur="3.2s" repeatCount="indefinite" path="M21.5 12a9.5 4.6 0 1 1 -19 0a9.5 4.6 0 1 1 19 0"/></circle>' : '<circle cx="21.5" cy="12" r="1.7" style="fill:currentColor"/>') + '</g><path d="M9.7 12.6h4.6l-.9 1.5h-2.8zM12 10.3v2.3"/>',
  tower: '<path d="M9.2 21l1.1-8h3.4l1.1 8M7.5 13h9l1.3-4H6.2zM10 9V5.5h4V9M12 2.5v3"/><g class="sweep"><path class="beam" d="M12 4.2L21 1.5v5.4z"/></g>',
};
strip.innerHTML = VIEWS.map((v, i) => `<button type="button" data-view="${v}" title="${VIEW_NAMES[v]} (${i + 1})" aria-label="${VIEW_NAMES[v]}"><svg viewBox="0 0 24 24">${ICONS[v]}</svg><span>${VIEW_NAMES[v]}</span></button>`).join('');
document.body.appendChild(strip);
const viewButtons = [...strip.querySelectorAll('button[data-view]')];
viewButtons.forEach((b) => b.addEventListener('click', () => { setView(b.dataset.view); b.blur(); }));
{ // the keys button: shows or hides the key tiles (hidden at the start)
  const kb = document.createElement('button');
  kb.type = 'button';
  kb.className = 'helm-keys-btn';
  kb.title = 'Keys';
  kb.setAttribute('aria-label', 'Show the keys');
  kb.setAttribute('aria-pressed', 'false');
  kb.innerHTML = '<svg viewBox="0 0 24 24"><rect x="2.5" y="6" width="19" height="12" rx="2.5"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/></svg>';
  strip.appendChild(kb);
  kb.addEventListener('click', () => { const on = keysEl.classList.toggle('show'); kb.classList.toggle('active', on); kb.setAttribute('aria-pressed', String(on)); kb.blur(); });
}

const FOLD_KEY = 'intercept.uiHidden';
const foldButton = document.querySelector('#btn-fold');
const unfoldButton = document.querySelector('#btn-unfold');
const menuButton = document.querySelector('#btn-menu');
const menuEl = document.querySelector('#menu');
const keysSheet = document.querySelector('#keys');
function setMenu(open) { menuEl.hidden = !open; menuButton.setAttribute('aria-expanded', String(open)); }
function setKeys(open) { keysSheet.hidden = !open; }
function closePopovers() { const was = !menuEl.hidden || !keysSheet.hidden; setMenu(false); setKeys(false); return was; }
function setFolded(on, save = true) {
  if (on) closePopovers();
  document.body.classList.toggle('ui-hidden', on);
  unfoldButton.hidden = !on;
  foldButton.setAttribute('aria-expanded', String(!on));
  if (save) try { localStorage.setItem(FOLD_KEY, on ? '1' : '0'); } catch { /* storage unavailable */ }
}
foldButton.addEventListener('click', () => setFolded(true));
unfoldButton.addEventListener('click', () => setFolded(false));
menuButton.addEventListener('click', () => setMenu(menuEl.hidden));
menuEl.addEventListener('click', (e) => { if (e.target.closest('button, a')) setMenu(false); });
document.querySelector('#btn-keys').addEventListener('click', () => setKeys(true));
document.querySelector('#keys-close').addEventListener('click', () => setKeys(false));
window.addEventListener('pointerdown', (e) => {
  if (!menuEl.hidden && !e.target.closest('#menu, #btn-menu')) setMenu(false);
  if (!keysSheet.hidden && !e.target.closest('#keys, #btn-keys')) setKeys(false);
}, true);
try { setFolded(localStorage.getItem(FOLD_KEY) === '1', false); } catch { setFolded(false, false); }
document.querySelector('#btn-ship').addEventListener('click', () => {
  try { sessionStorage.setItem('intercept.chooser', '1'); location.reload(); } catch { location.search = ''; }
});
{
  const t = menuText(DRILL);
  document.querySelector('.brand b').textContent = t.brand;
  const sub = document.querySelector('#mission-sub');
  if (sub) sub.textContent = t.sub;
}

const soundButton = document.querySelector('#btn-sound');
function setSound(on) {
  audio.setEnabled(on);
  soundButton.classList.toggle('active', on);
  soundButton.setAttribute('aria-pressed', String(on));
  try { localStorage.setItem('intercept.sound', on ? '1' : '0'); } catch { /* storage unavailable */ }
}
let soundPref = true;
try { soundPref = localStorage.getItem('intercept.sound') !== '0'; } catch { /* storage unavailable */ }
setSound(soundPref);
if (!audio.supported) { soundButton.disabled = true; soundButton.title = 'Sound is not available in this browser'; }
soundButton.addEventListener('click', () => setSound(!audio.enabled));

const hudButton = document.querySelector('#btn-hud');
let hudOn = true;
function setHud(on) {
  hudOn = on;
  for (const el of [taskEl, shipEl, dockEl]) el.hidden = !on;
  hudButton.classList.toggle('active', on);
  hudButton.setAttribute('aria-pressed', String(on));
}
hudButton.addEventListener('click', () => setHud(!hudOn));
const mapButton = document.querySelector('#btn-map');
function setMap(on) {
  map.setEnabled(on);
  mapButton.classList.toggle('active', on);
  mapButton.setAttribute('aria-pressed', String(on));
  try { localStorage.setItem('intercept.map', on ? '1' : '0'); } catch { /* storage unavailable */ }
}
try { setMap(localStorage.getItem('intercept.map') !== '0'); } catch { setMap(true); }
mapButton.addEventListener('click', () => setMap(!map.enabled));

{ // the gear: everything the mission needs, in one menu (the old row of buttons is hidden in harbour.css)
  menuButton.innerHTML = '<svg><use href="#i-gear"/></svg>';
  menuButton.title = 'Settings';
  menuButton.setAttribute('aria-label', 'Settings');
  const restartButton = document.createElement('button');
  restartButton.addEventListener('click', () => restart());
  const fsButton = document.querySelector('#btn-fullscreen');
  fsButton.addEventListener('click', () => { try { if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen(); } catch { /* not allowed here */ } });
  const MI = { // a small drawing in front of each entry (helm.css .mi)
    restart: '<path class="mi-a" d="M20 12a8 8 0 1 1-2.6-5.9M20 4v4.5h-4.5"/>',
    menu: '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>',
    readouts: '<rect x="3.5" y="4.5" width="17" height="12" rx="2"/><path d="M7 13l3-3.2 2.4 2 3.6-4.3M9 20h6M12 16.5V20"/>',
    chart: '<path d="M3.5 6l5.5-2 6 2 5.5-2v14l-5.5 2-6-2-5.5 2z"/><path d="M9 4v14M15 6v14"/>',
    sound: '<path d="M4 9.5h3.5L12 6v12l-4.5-3.5H4z"/><path class="mi-w1" d="M15.5 9.2a4 4 0 0 1 0 5.6"/><path class="mi-w2" d="M18.2 6.8a7.5 7.5 0 0 1 0 10.4"/>',
    full: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
    hide: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/><path class="mi-a" d="M4 4l16 16"/>',
    keys: '<rect x="2.5" y="6" width="19" height="12" rx="2.5"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7.5 14h9"/>',
  };
  const item = (b, label, key, ic) => { b.className = ''; b.setAttribute('role', 'menuitem'); b.innerHTML = `<span class="mi-l">${ic ? `<svg class="mi" viewBox="0 0 24 24" aria-hidden="true">${MI[ic]}</svg>` : ''}${label}</span>${key ? `<kbd>${key}</kbd>` : ''}`; return b; };
  const head = (t) => { const h = document.createElement('div'); h.className = 'menu-h'; h.textContent = t; return h; };
  item(restartButton, 'Sail again', 'R', 'restart');
  item(document.querySelector('#btn-ship'), 'Main menu', '', 'menu');
  item(hudButton, 'Readouts', 'H', 'readouts');
  item(mapButton, 'Chart', 'N', 'chart');
  item(soundButton, 'Sound', 'S', 'sound');
  item(fsButton, 'Fullscreen', '', 'full');
  item(foldButton, 'Hide the interface', 'C', 'hide');
  item(document.querySelector('#btn-keys'), 'Keyboard shortcuts', '?', 'keys');
  const switchButton = document.createElement('button');
  item(switchButton, DRILL === 'mob' ? 'Harbour: out and back in' : 'Drill: man overboard', '', 'restart');
  switchButton.addEventListener('click', () => { try { const u = new URL(location.href); u.searchParams.set('mode', DRILL === 'mob' ? 'harbour' : 'mob'); u.searchParams.set('start', '1'); location.href = u.toString(); } catch { /* not allowed here */ } });
  menuEl.replaceChildren(head('Mission'), restartButton, switchButton, document.querySelector('#btn-ship'), head('Display'), hudButton, mapButton, foldButton, fsButton, head('Sound'), soundButton, head('Help'), document.querySelector('#btn-keys'));
  menuButton.addEventListener('click', () => {
    for (const [b, on] of [[hudButton, hudOn], [mapButton, map.enabled], [soundButton, audio.enabled]]) { b.classList.toggle('active', on); b.setAttribute('aria-pressed', String(on)); }
  });
}

keysSheet.querySelector('dl').innerHTML = [
  ['<kbd>←</kbd> <kbd>→</kbd>', 'Rudder to port / starboard while held; let go and it comes back amidships. The rudder needs water past it: at a crawl she hardly answers'],
  ['<kbd>↑</kbd> <kbd>↓</kbd>', 'Engine telegraph, one step: full, half, slow and slow astern, stop, dead slow, slow, half, full ahead'],
  ['<kbd>Q</kbd> <kbd>E</kbd>', 'Bow and stern thrusters against each other: she turns on the spot to port / starboard (full below 1 kn, nothing from 5 kn)'],
  ['<kbd>A</kbd> <kbd>D</kbd>', 'Both thrusters together: she moves sideways to port / starboard'],
  ['<kbd>L</kbd>', 'Let go the lines (at the start); make fast once she lies still alongside berth 7'],
  ['<kbd>B</kbd>', 'The ship\'s horn: one prolonged blast as she leaves the berth'],
  ['<kbd>1</kbd> to <kbd>6</kbd>', 'Bridge, bridge wing (again: the other wing), behind, chart view, orbit, pier-head tower'],
  ['<kbd>V</kbd>', 'Next view · drag looks round, the wheel zooms, double click resets'],
  ['<kbd>N</kbd>', 'Chart (click it to change the scale)'],
  ['<kbd>R</kbd>', 'Sail again'],
  ['<kbd>S</kbd>', 'Sound on / off'],
  ['<kbd>H</kbd> <kbd>C</kbd>', 'Readouts, hide the interface'],
].map(([k, d]) => `<dt>${k}</dt><dd>${d}</dd>`).join('');
keysSheet.querySelector('.keys-note').textContent = DRILL === 'mob'
  ? 'Man overboard: hard over toward his side at once, the Williamson turn (reverse at 60° off), back down the wake, stop with him abeam'
  : 'Jijel naval harbour: out between the pier heads, round the fairway buoy, back in and alongside berth 7 · 6 knots inside';

// --- Keys --------------------------------------------------------------------------------------------------------------------
const input = { wheel: 0, turn: 0, slide: 0 };
const held = new Set();
function syncInput() {
  input.wheel = (held.has('ArrowRight') ? 1 : 0) - (held.has('ArrowLeft') ? 1 : 0);
  input.turn = (held.has('e') ? 1 : 0) - (held.has('q') ? 1 : 0);
  input.slide = (held.has('d') ? 1 : 0) - (held.has('a') ? 1 : 0);
}
function restart() {
  sim.reset();
  wake.clear();
  audio.reset();
  endEl.hidden = true;
  banner.hidden = true;
  setView('behind', true);
  say(DRILL === 'mob' ? 'On passage at 10 knots. Keep a good lookout' : 'Alongside berth 3, lines fast. L lets go', '', 4000);
}

window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLElement && e.target.closest('input, textarea, select')) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (['ArrowLeft', 'ArrowRight', 'q', 'e', 'a', 'd'].includes(key)) { held.add(key); syncInput(); e.preventDefault(); return; }
  if (e.repeat) { if (key.startsWith('Arrow')) e.preventDefault(); return; }
  switch (key) {
    case 'ArrowUp': sim.telegraph(+1); break;
    case 'ArrowDown': sim.telegraph(-1); break;
    case 'l': sim.lineKey(); break;
    case 'b': audio.horn(); say('One prolonged blast', '', 1600); break;
    case 'r': restart(); break;
    case 'v': setView(VIEWS[(VIEWS.indexOf(view) + 1) % VIEWS.length]); break;
    case '1': case '2': case '3': case '4': case '5': case '6': setView(VIEWS[Number(key) - 1]); break;
    case 'h': setHud(!hudOn); break;
    case 'n': setMap(!map.enabled); break;
    case 's': setSound(!audio.enabled); break;
    case 'c': setFolded(!document.body.classList.contains('ui-hidden')); break;
    case '?': setKeys(keysSheet.hidden); break;
    case 'Escape': closePopovers(); break;
    default: return;
  }
  if (key !== 'Escape') e.preventDefault();
});
window.addEventListener('keyup', (e) => {
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (held.delete(key)) syncInput();
});
window.addEventListener('blur', () => { held.clear(); syncInput(); });

// --- Loop --------------------------------------------------------------------------------------------------------------------
function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  pointScale.value = (h * renderer.getPixelRatio()) / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));
}
window.addEventListener('resize', resize);
resize();

function applyState() {
  const t = sim.t;
  const roll = sim.heel + 0.008 * Math.sin(t * 0.52) + 0.003 * Math.sin(t * 1.3 + 1);
  const pitch = 0.003 * Math.sin(t * 0.37 + 0.4);
  ship.group.position.set(sim.x, 0.05 * Math.sin(t * 0.61), sim.z);
  ship.group.rotation.set(roll, -sim.psi, pitch);
  ship.group.updateMatrixWorld(true);
  ship.update(1000 + t, Infinity);
  env.ocean.material.uniforms.uTime.value = t;
  if (!sim.lines) wake.update({ t, x: sim.x, z: sim.z, psi: sim.psi, r: sim.r, u: sim.u });
  harbour.update(t);
  details.update(t, sim, { bridgeView: view === 'bridge' || view === 'wing' });
  harbour.ghost.visible = sim.stage === 'berth';
  mobScene.update(t, sim, ship, camera.position);
}

let lastTask = '', lastDock = '', lastKeys = '', frames = 0, last = performance.now();
let endShown = false;
renderer.setAnimationLoop((now) => {
  const dt = Math.max(0, Math.min((now - last) / 1000, 0.1));
  last = now;
  if (!intro) sim.advance(dt, input);
  for (const e of sim.takeEvents()) {
    audio.event(e);
    if (e.type === 'say') say(e.text, e.tone, e.tone === 'danger' ? 4200 : 3600);
    else if (e.type === 'telegraph') { // the order is repeated back
      const o = TELEGRAPH[e.order];
      say(`${o.kn > 0 ? `${o.name} ahead` : o.kn === 0 ? 'Stop engines' : o.name}, aye`, '', 1700);
    }
  }
  applyState();
  updateCamera(dt);
  audio.update(sim, view === 'bridge' ? 1 : view === 'wing' ? 0.4 : 0);
  env.follow(camera.position);
  env.setShadowFocus(_b.set(sim.x, 0, sim.z), view === 'above' ? Math.min(aboveH * 0.6, 400) : 140);
  map.update(sim);
  if (hudOn) {
    const tk = taskHtml(); if (tk !== lastTask) { taskEl.innerHTML = tk; lastTask = tk; }
    updateBottom(dt);
    const dk = dockHtml(); if (dk !== lastDock) { dockEl.innerHTML = dk; dockEl.classList.toggle('show', !!dk); lastDock = dk; }
  }
  const ky = keysHtml(); if (ky !== lastKeys) { keysEl.innerHTML = ky; lastKeys = ky; }
  if (sim.over && !endShown) { endShown = true; setTimeout(() => { if (sim.over) { endEl.innerHTML = endHtml(); endEl.hidden = false; } }, 1800); }
  if (!sim.over) endShown = false;
  if (!banner.hidden && performance.now() > bannerUntil) banner.hidden = true;
  renderer.render(scene, camera);
  if (frames++ === 0) loadingEl?.remove();
});

setView('behind', true);
say(DRILL === 'mob' ? 'On passage off Jijel at 10 knots. Man overboard drill: be ready' : 'Alongside berth 3 in Jijel, lines fast. L lets go, then take her out', '', 6000);
window.__harbour = { sim, camera, controls, renderer, scene, env, harbour, ship: ship.group, setView, restart, FAIRWAY, get view() { return view; } };

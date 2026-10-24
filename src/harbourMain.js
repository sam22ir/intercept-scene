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
import { createHarbourCrew } from './harbourCrew.js';
import {
  HarbourSim, TELEGRAPH, RUDDER_MAX, KT, STAGES, SPEED_LIMIT, TARGET_BERTH, START_BERTH, LIGHTS, FAIRWAY, HALF_BEAM, BERTH_TOL, compass, thrusterFactor,
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
const sim = new HarbourSim();
const crew = createHarbourCrew({ scene, ship, bridge, landHeight: harbour.landHeight }); // the bridge team, the line handlers, the people ashore

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
const BRIDGE_EYE = new THREE.Vector3(11.9, 11.0, 1.5); // a pace to starboard of the helmsman, who stands at the wheel on the centreline
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
  else if (v === 'wing') { wingSide = sim.stage === 'alongside' || sim.stage === 'berth' ? quaySide() : wingSide; wingYaw = 0; wingPitch = 0; }
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
const connEl = document.createElement('div');
connEl.className = 'hb-conn';
const dockEl = document.createElement('div');
dockEl.className = 'hb-dock';
const endEl = document.createElement('div');
endEl.className = 'hb-end';
endEl.hidden = true;
document.body.append(taskEl, connEl, dockEl, endEl);

const ORDER_STAGES = ['alongside', 'depart', 'sea', 'return', 'berth'];
const brgTo = (x, z) => compass(Math.atan2(z - sim.z, x - sim.x));
const pad3 = (d) => String(Math.round(d) % 360).padStart(3, '0');
const dist = (m) => (m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`);
function taskHtml() {
  const st = STAGES[sim.stage];
  const n = ORDER_STAGES.indexOf(sim.stage);
  const steps = ORDER_STAGES.map((s, i) => `<i class="${i < n || sim.stage === 'done' ? 'done' : i === n ? 'now' : ''}"></i>`).join('');
  const m = sim.mark;
  const mk = m ? `<div class="hb-mark"><span>${m.name}</span><b>${dist(Math.hypot(m.x - sim.x, m.z - sim.z))}</b><b>${pad3(brgTo(m.x, m.z))}°</b></div>` : '';
  const inside = sim.inside, kn = Math.abs(sim.u) / KT;
  const lim = inside ? `<div class="hb-limit ${kn > SPEED_LIMIT + 0.2 ? 'over' : ''}">Harbour speed limit <b>${SPEED_LIMIT} kn</b></div>` : '';
  return `<div class="hb-steps">${steps}</div><div class="hb-ttl">${st.title}</div><p>${st.task}</p>${mk}${lim}`;
}
const RUD_R = 38;
function rudderSvg() {
  const a = THREE.MathUtils.clamp(sim.rudder / RUDDER_MAX, -1, 1) * 70; // degrees on the dial
  const ticks = [-70, -35, 0, 35, 70].map((d) => { const r = (d * Math.PI) / 180; return `<path d="M${50 + Math.sin(r) * (RUD_R - 6)} ${50 - Math.cos(r) * (RUD_R - 6)}L${50 + Math.sin(r) * RUD_R} ${50 - Math.cos(r) * RUD_R}"/>`; }).join('');
  const r = (a * Math.PI) / 180;
  return `<svg viewBox="0 6 100 56" class="hb-rud"><path class="arc p" d="M${50 - Math.sin(1.22) * RUD_R} ${50 - Math.cos(1.22) * RUD_R}A${RUD_R} ${RUD_R} 0 0 1 50 ${50 - RUD_R}"/><path class="arc s" d="M50 ${50 - RUD_R}A${RUD_R} ${RUD_R} 0 0 1 ${50 + Math.sin(1.22) * RUD_R} ${50 - Math.cos(1.22) * RUD_R}"/><g class="tk">${ticks}</g><path class="ndl" d="M50 50L${50 + Math.sin(r) * (RUD_R - 4)} ${50 - Math.cos(r) * (RUD_R - 4)}"/><circle cx="50" cy="50" r="3.5" class="hub"/></svg>`;
}
function tapeSvg() {
  const h = compass(sim.psi);
  let s = '';
  for (let d = Math.floor(h / 10) * 10 - 40; d <= h + 40; d += 5) {
    const x = 60 + (d - h) * 1.4;
    const major = d % 10 === 0;
    s += `<path d="M${x} ${major ? 14 : 18}V24"/>`;
    if (d % 30 === 0) s += `<text x="${x}" y="11">${pad3((d + 360) % 360)}</text>`;
  }
  return `<svg viewBox="0 0 120 26" class="hb-tape"><g>${s}</g><path class="ptr" d="M60 25l-3.5 -6h7z"/></svg>`;
}
function connHtml() {
  const kn = sim.u / KT;
  const rot = (sim.r * 180 / Math.PI) * 60; // degrees a minute
  const thrF = thrusterFactor(sim.u);
  const tel = TELEGRAPH.map((o, i) => `<li class="${i === sim.order ? 'on' : ''} ${o.kn < 0 ? 'ast' : o.kn > 0 ? 'ahd' : 'stp'}">${o.name}</li>`).reverse().join('');
  const arrow = (v, cls) => `<i class="hb-thr ${cls} ${v < -0.05 ? 'l' : v > 0.05 ? 'r' : ''}" style="--a:${Math.abs(v).toFixed(2)}"></i>`;
  const bow = sim.thr.yaw + sim.thr.sway, stern = -sim.thr.yaw + sim.thr.sway; // + pushes to starboard
  const hull = 100 - sim.damage;
  return `<div class="hb-c hb-c-rud"><span>Rudder</span>${rudderSvg()}<b>${Math.abs(Math.round(sim.rudder * 180 / Math.PI))}° ${sim.rudder > 0.01 ? 'stbd' : sim.rudder < -0.01 ? 'port' : 'mid'}</b></div>`
    + `<div class="hb-c hb-c-hdg"><span>Heading</span><b class="big">${pad3(compass(sim.psi))}°</b>${tapeSvg()}<small>Turn ${rot >= 0 ? '▶' : '◀'} ${Math.abs(rot).toFixed(0)}°/min</small></div>`
    + `<div class="hb-c hb-c-spd"><span>Speed</span><b class="big">${Math.abs(kn).toFixed(1)}<small>kn</small></b><small>${kn > 0.05 ? 'ahead' : kn < -0.05 ? 'astern' : 'stopped'}${Math.abs(sim.v) > 0.03 ? ` · ${(Math.abs(sim.v) / KT).toFixed(1)} kn ${sim.v > 0 ? 'to stbd' : 'to port'}` : ''}</small></div>`
    + `<div class="hb-c hb-c-tel"><span>Telegraph</span><ul>${tel}</ul></div>`
    + `<div class="hb-c hb-c-thr ${thrF < 0.05 ? 'off' : ''}"><span>Thrusters</span><div class="hb-hull">${arrow(bow, 'bow')}<svg viewBox="0 0 20 60"><path d="M10 2C15 10 16 20 16 30V56H4V30C4 20 5 10 10 2Z"/></svg>${arrow(stern, 'stern')}</div><small>${thrF < 0.05 ? `above ${5} kn` : `${Math.round(thrF * 100)} %`}</small></div>`
    + `<div class="hb-c hb-c-dmg ${hull < 60 ? 'bad' : hull < 99 ? 'warn' : ''}"><span>Hull</span><b>${Math.round(hull)}<small>%</small></b><div class="hb-bar"><i style="width:${hull}%"></i></div><small>${sim.contacts.touch + sim.contacts.hard + sim.contacts.crash} contacts</small></div>`;
}
function dockHtml() {
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
  if (sim.stage === 'wrecked') {
    return `<div class="hb-end-k">Holed</div><h2>The pilot is relieved</h2><p>She hit too hard to go on: ${sim.contacts.hard} hard contacts and ${sim.contacts.crash} collisions.</p><div class="hb-end-b"><button type="button" data-act="again">Sail again <kbd>R</kbd></button><button type="button" data-act="menu">Main menu</button></div>`;
  }
  const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
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

// The keys for this moment, at the foot of the screen (hidden at the start: the keys button shows it).
const keysEl = document.createElement('div');
keysEl.className = 'hb-keys';
document.body.appendChild(keysEl);
function keysHtml() {
  const k = (key, label, on = false) => `<span class="fk ${on ? 'on' : ''}"><kbd>${key}</kbd>${label}</span>`;
  const out = [k('← →', 'rudder', input.wheel !== 0), k('↑ ↓', 'telegraph')];
  out.push(k('Q E', 'turn on the spot', input.turn !== 0), k('A D', 'sideways', input.slide !== 0));
  if (sim.stage === 'alongside') out.unshift(k('L', 'let go the lines', true));
  if (sim.stage === 'berth' && sim.berthState().ok) out.unshift(k('L', 'make fast', true));
  out.push(k('B', 'horn'), k('1–6', 'views'));
  return out.join('');
}

// --- The view strip and the gear menu ------------------------------------------------------------------------------------------
const strip = document.createElement('div');
strip.className = 'hb-views';
const ICONS = {
  bridge: '<circle cx="12" cy="12" r="6.2"/><circle cx="12" cy="12" r="1.7"/><path d="M12 2.5v4M12 17.5v4M2.5 12h4M17.5 12h4"/>',
  wing: '<path d="M4 20V9h9l6 4v7z"/><path d="M13 9V5h-4M4 14h15"/>',
  behind: '<path d="M8 14h13l-2.5 4H10z"/><path d="M12 14v-3h5l1.5 3"/><path d="M2 12.5h3.5M1 15.5h4.5M3 18.5h3.5"/>',
  above: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M12 6.5c2 2 2.6 4.5 2.6 7v3.5H9.4V13.5c0-2.5.6-5 2.6-7z"/>',
  orbit: '<g transform="rotate(-25 12 12)"><ellipse cx="12" cy="12" rx="9.5" ry="4.6"/></g><path d="M9.7 12.6h4.6l-.9 1.5h-2.8z"/>',
  tower: '<path d="M10 21l1-12h2l1 12z"/><path d="M9.5 9h5M10.5 6h3v3h-3z"/><path d="M6 6.5L3 5M18 6.5L21 5M6 8.5L3 10M18 8.5L21 10"/>',
};
strip.innerHTML = VIEWS.map((v, i) => `<button type="button" data-view="${v}" title="${VIEW_NAMES[v]} (${i + 1})" aria-label="${VIEW_NAMES[v]}"><svg viewBox="0 0 24 24">${ICONS[v]}</svg><span>${VIEW_NAMES[v]}</span></button>`).join('')
  + '<button type="button" class="hb-keys-btn" title="Keys" aria-label="Show the keys" aria-pressed="false"><svg viewBox="0 0 24 24"><rect x="2.5" y="6" width="19" height="12" rx="2.5"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/></svg></button>';
document.body.appendChild(strip);
const viewButtons = [...strip.querySelectorAll('button[data-view]')];
viewButtons.forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
const keysBtn = strip.querySelector('.hb-keys-btn');
keysBtn.addEventListener('click', () => { const on = keysEl.classList.toggle('show'); keysBtn.classList.toggle('active', on); keysBtn.setAttribute('aria-pressed', String(on)); keysBtn.blur(); });

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
  const t = menuText('harbour');
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
  for (const el of [taskEl, connEl, dockEl]) el.hidden = !on;
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
  const item = (b, label, key) => { b.className = ''; b.setAttribute('role', 'menuitem'); b.innerHTML = `${label}${key ? `<kbd>${key}</kbd>` : ''}`; return b; };
  const head = (t) => { const h = document.createElement('div'); h.className = 'menu-h'; h.textContent = t; return h; };
  item(restartButton, 'Sail again', 'R');
  item(document.querySelector('#btn-ship'), 'Main menu', '');
  item(hudButton, 'Readouts', 'H');
  item(mapButton, 'Chart', 'N');
  item(soundButton, 'Sound', 'S');
  item(fsButton, 'Fullscreen', '');
  item(foldButton, 'Hide the interface', 'C');
  item(document.querySelector('#btn-keys'), 'Keyboard shortcuts', '?');
  menuEl.replaceChildren(head('Mission'), restartButton, document.querySelector('#btn-ship'), head('Display'), hudButton, mapButton, foldButton, fsButton, head('Sound'), soundButton, head('Help'), document.querySelector('#btn-keys'));
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
keysSheet.querySelector('.keys-note').textContent = 'Jijel naval harbour: out between the pier heads, round the fairway buoy, back in and alongside berth 7 · 6 knots inside';

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
  say('Alongside berth 3, lines fast. L lets go', '', 4000);
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
  crew.update(t, sim, { bridgeView: view === 'bridge' || view === 'wing' });
  harbour.ghost.visible = sim.stage === 'berth';
}

let lastTask = '', lastConn = '', lastDock = '', lastKeys = '', frames = 0, last = performance.now();
let endShown = false;
renderer.setAnimationLoop((now) => {
  const dt = Math.max(0, Math.min((now - last) / 1000, 0.1));
  last = now;
  if (!intro) sim.advance(dt, input);
  for (const e of sim.takeEvents()) {
    audio.event(e);
    if (e.type === 'say') say(e.text, e.tone, e.tone === 'danger' ? 4200 : 3600);
    else if (e.type === 'telegraph') { // the officer of the watch rings it down and repeats the order
      crew.telegraph(sim.t);
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
    const cn = connHtml(); if (cn !== lastConn) { connEl.innerHTML = cn; lastConn = cn; }
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
say('Alongside berth 3 in Jijel, lines fast. L lets go, then take her out', '', 6000);
window.__harbour = { sim, camera, controls, renderer, scene, env, harbour, ship: ship.group, setView, restart, FAIRWAY, get view() { return view; } };

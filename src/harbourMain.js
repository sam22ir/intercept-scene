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
import { createVessel, glassOf } from './harbourShips.js';
import {
  HarbourSim, MobSim, MOB_STEPS, MOB_ZONE, ROUTES, CHECKLIST, STOP_ORDER, RUDDER_MAX, KT, LIGHTS, HALF_BEAM, BERTH_TOL, TIDES, TUGS,
  compass, thrusterFactor, tugFactor, toChart,
} from './harbour.js';
import './helm.css'; // the manual flight's gear and menu (body.mission-fly)
import './harbour.css';

// Entry point of "Harbour pilot", mission id `harbour` (the model is harbour.js, the port harbourScene.js): the port of Zabana and its
// eight standard manoeuvres (A to H), with traffic. Real time, like Solo Air Defense; start.js imports it when the mission is picked.
// The man overboard drill (mission `mob`) shares the scene. Harbour pilot speaks French (the owner asked); the drill keeps English.
//
// Views (1 to 6, V cycles): the bridge (drag looks round), the bridge wing over the side toward the quay (press 2 again for the
// other wing), behind her, the chart view straight down (north up), a free orbit, and the east jetty head's light with a long lens.

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
controls.maxDistance = 4000;
controls.maxPolarAngle = Math.PI * 0.48;
controls.enabled = false;
const rig = new CameraRig(camera, controls);

// The exercise: the harbour (mission `harbour`) or the man overboard drill (mission `mob`); start.js sets it.
const params = new URLSearchParams(location.search);
const DRILL = globalThis.__HARBOUR_DRILL ?? (params.get('mode') === 'mob' ? 'mob' : 'harbour');
const FR = DRILL !== 'mob';
const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } } };
// The manoeuvre (?route=A..H, else the last one sailed), the tide (springs / neaps / the manoeuvre's own) and the traffic (on / off).
const ROUTE_KEY = 'intercept.harbour.route', TIDE_KEY = 'intercept.harbour.tide', TRAFFIC_KEY = 'intercept.harbour.traffic';
const routeParam = (params.get('route') ?? '').toUpperCase();
const routeId = ROUTES[routeParam] ? routeParam : ROUTES[store.get(ROUTE_KEY)] ? store.get(ROUTE_KEY) : 'A';
const tidePref = store.get(TIDE_KEY); // 'spring', 'neap' or null (the manoeuvre's)
const trafficOn = store.get(TRAFFIC_KEY) !== '0';
let choosing = FR && !ROUTES[routeParam]; // no manoeuvre in the address: show the chooser first
const sim = DRILL === 'mob' ? new MobSim() : new HarbourSim({ route: routeId, spring: tidePref ? tidePref === 'spring' : undefined, traffic: trafficOn });

const env = createEnvironment(renderer, scene, { look: 'harbour' }); // an Atlantic afternoon (looks.js); the land is the port's own
env.setShadowSize(2048);
env.ocean.material.uniforms.uShipX.value = 1e7; // the shader's straight-line wake: she turns, she has her own
const harbour = createHarbour(scene, sim);
// Her model: the frigate for the drill, the manoeuvre's merchant ship (or trawler) otherwise; the wheelhouse interior is the frigate's,
// moved so its eye stands at her own bridge.
const ship = sim.ship.id === 'frigate' ? createShip({ catapult: false }) : { group: createVessel(sim.ship.id, { L: sim.ship.L, B: sim.ship.B }), update() {} };
ship.group.rotation.order = 'YXZ';
scene.add(ship.group);
const bridge = createBridge();
bridge.group.visible = false;
const BRIDGE_AT = ship.group.userData.bridge ?? [11.7, 11.0];
const bridgeHolder = new THREE.Group();
bridgeHolder.position.set(BRIDGE_AT[0] - 11.7, BRIDGE_AT[1] - 11.0, 0);
bridgeHolder.add(bridge.group);
ship.group.add(bridgeHolder);
const ownGlass = sim.ship.id === 'frigate' ? [] : glassOf(ship.group);
const wake = createWake(scene);
const map = createHarbourMap();
const audio = createHarbourAudio();
const mobScene = createMobScene(scene); // the casualty, the lifebuoy and its smoke, the recovery line (the drill only)
const details = createHarbourDetails({ scene, ship, bridge, sim }); // the bridge's screens, the mooring lines, the gulls
// The traffic's ships (models made once; moved each frame from the model).
const trafficModels = new Map();
if (sim.traffic) {
  for (const v of sim.traffic.vessels) {
    const g = createVessel(v.type, { L: v.L, B: v.B });
    g.visible = false;
    scene.add(g);
    trafficModels.set(v, { g, ph: Math.random() * 6 });
  }
}

// --- Words ---------------------------------------------------------------------------------------------------------------
const L = FR ? {
  views: { bridge: 'Passerelle', wing: 'Aileron', behind: 'Derrière', above: 'Vue carte', orbit: 'Orbite', tower: 'Feu de la jetée Est' },
  wing: (s) => `Aileron ${s > 0 ? 'tribord' : 'bâbord'}`,
  aye: (o) => `${o.name}, bien reçu`,
  start: 'Manœuvre', menu: 'Menu principal', readouts: 'Affichages', chart: 'Carte', sound: 'Son', full: 'Plein écran', hide: 'Masquer l\'interface', keys: 'Raccourcis clavier',
  mission: 'Mission', display: 'Affichage', help: 'Aide', again: 'Recommencer', switchTo: 'Exercice : homme à la mer (anglais)', settings: 'Réglages',
} : {
  views: { bridge: 'Bridge', wing: 'Bridge wing', behind: 'Behind her', above: 'Chart view', orbit: 'Orbit', tower: 'Jetty-head light' },
  wing: (s) => `Bridge wing, ${s > 0 ? 'starboard' : 'port'} side`,
  aye: (o) => `${o.kn > 0 ? `${o.name} ahead` : o.kn === 0 ? 'Stop engines' : o.name}, aye`,
  start: 'Exercise', menu: 'Main menu', readouts: 'Readouts', chart: 'Chart', sound: 'Sound', full: 'Fullscreen', hide: 'Hide the interface', keys: 'Keyboard shortcuts',
  mission: 'Mission', display: 'Display', help: 'Help', again: 'Sail again', switchTo: 'Harbour pilot: Zabana (French)', settings: 'Settings',
};

// --- The banner and the VHF ---------------------------------------------------------------------------------------------
const banner = document.querySelector('#shot-caption');
let bannerUntil = 0;
function say(text, tone = '', ms = 3400) {
  banner.textContent = text;
  banner.className = `shot-caption ${tone === 'danger' ? 'danger' : ''} hb-say-${tone || 'info'}`;
  banner.hidden = false;
  bannerUntil = performance.now() + ms;
}
const vhfEl = document.createElement('div');
vhfEl.className = 'hb-vhf';
vhfEl.hidden = true;
document.body.appendChild(vhfEl);
const radioLog = [];
let vhfUntil = 0;
function radio(from, text) {
  radioLog.push({ from, text });
  if (radioLog.length > 4) radioLog.shift();
  vhfEl.innerHTML = `<div class="hb-vhf-h">VHF 12</div>${radioLog.map((r) => `<p><b>${r.from}</b> ${r.text}</p>`).join('')}`;
  vhfEl.hidden = false;
  vhfUntil = performance.now() + 9000;
}

// --- Views ---------------------------------------------------------------------------------------------------------------
const VIEWS = ['bridge', 'wing', 'behind', 'above', 'orbit', 'tower'];
const VIEW_NAMES = L.views;
const BRIDGE_EYE = new THREE.Vector3(11.7, 11.0, 0); // behind the wheel, on the centreline (models/bridge.js), in the holder's frame
const SHIP_L = sim.ship.L;
let view = 'behind';
let lookYaw = 0, lookPitch = -0.04; // bridge: degrees off the bow (+ starboard), radians up
let wingSide = 1; // +1 the starboard wing
let wingYaw = 0, wingPitch = 0;
const BEHIND0 = Math.max(210, SHIP_L * 1.7);
let behindDist = BEHIND0, behindYaw = 0, camYaw = 0, snap = true;
let aboveH = Math.max(520, SHIP_L * 3.5);
let towerZoom = 1;
const lookAt = new THREE.Vector3();
const _a = new THREE.Vector3(), _b = new THREE.Vector3();
const shipTarget = (out) => out.set(sim.x, 6, sim.z);
// The wing that faces the quay she is at (or coming to), else the one she last used.
function quaySide() {
  const f = sim.stage === 'alongside' && sim.route?.start?.berth ? null : sim.target?.face;
  if (!f) return 1;
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
    camera.position.set(sim.x - fx * SHIP_L * 1.5 - fz * SHIP_L * 1.4, SHIP_L, sim.z - fz * SHIP_L * 1.5 + fx * SHIP_L * 1.4);
    rig.focus('ship', shipTarget, SHIP_L * 2.2, 40);
  } else { controls.enabled = false; rig.free(); }
  snap = true;
  viewButtons.forEach((b) => b.classList.toggle('active', b.dataset.view === v));
  if (!quiet) say(v === 'wing' ? L.wing(wingSide) : VIEW_NAMES[v], '', 1400);
}

// The opening shot: high over the bay, then down behind her. Any key or click skips it.
let intro = params.get('intro') === '0' ? null : { t: 0 };
const INTRO = 7;
const ease = (x) => { const c = Math.min(Math.max(x, 0), 1); return c * c * (3 - 2 * c); };
function skipIntro() { if (intro && intro.t > 0.4 && !choosing) intro = null; }
window.addEventListener('keydown', skipIntro, true);
window.addEventListener('pointerdown', skipIntro, true);

function behindPose(out, look) {
  const ang = camYaw + THREE.MathUtils.degToRad(behindYaw);
  out.set(sim.x - Math.cos(ang) * behindDist, behindDist * 0.2 + 14, sim.z - Math.sin(ang) * behindDist);
  look.set(sim.x + Math.cos(camYaw) * 40, 4, sim.z + Math.sin(camYaw) * 40);
}

let fov = 50;
const tower = LIGHTS.find((l) => l.id === 'jeteeEst');
function setFov(f) { if (Math.abs(camera.fov - f) > 0.01) { camera.fov = f; camera.updateProjectionMatrix(); } }
function updateCamera(dt) {
  bridge.group.visible = view === 'bridge' || view === 'wing';
  for (const m of ownGlass) m.visible = !(view === 'bridge' && !intro);
  const k = 1 - Math.exp(-dt / 0.6);
  if (snap) camYaw = sim.psi;
  else camYaw += Math.atan2(Math.sin(sim.psi - camYaw), Math.cos(sim.psi - camYaw)) * k;
  if (intro) {
    if (!choosing) intro.t += dt;
    const u = ease(intro.t / INTRO);
    behindPose(_a, _b);
    const from = new THREE.Vector3(-1500, 700, 900), fromLook = new THREE.Vector3(250, 0, 60); // high over the bay, looking in at the port
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
    bridge.update(THREE.MathUtils.clamp(sim.rudder / RUDDER_MAX, -1, 1), sim.order / (sim.tel.length - 1));
    bridgeHolder.localToWorld(camera.position.copy(BRIDGE_EYE));
    const yaw = THREE.MathUtils.degToRad(lookYaw);
    _a.set(Math.cos(yaw) * Math.cos(lookPitch), Math.sin(lookPitch), Math.sin(yaw) * Math.cos(lookPitch)).transformDirection(ship.group.matrixWorld);
    camera.lookAt(lookAt.copy(camera.position).add(_a));
    wantFov = 58;
  } else if (view === 'wing') {
    // Out on the wing, over her side, looking down at the water between her and the quay (drag looks round).
    const wx = sim.ship.id === 'frigate' ? 12.6 : BRIDGE_AT[0], wy = sim.ship.id === 'frigate' ? 11.8 : BRIDGE_AT[1] + 0.6;
    ship.group.localToWorld(camera.position.set(wx, wy, wingSide * (sim.ship.B / 2 + 0.1)));
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
    // The lantern gallery of the green light on the Digue Est head: a long lens that keeps her about the same size.
    camera.position.set(tower.x, 4 + 12.5, tower.z);
    camera.lookAt(sim.x, 5, sim.z);
    const d = Math.hypot(sim.x - tower.x, sim.z - tower.z);
    wantFov = THREE.MathUtils.clamp((2 * Math.atan(SHIP_L * 1.5 / Math.max(d, 1)) * 180) / Math.PI / towerZoom, 4, 70);
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
canvas.addEventListener('dblclick', () => { lookYaw = 0; lookPitch = -0.04; wingYaw = 0; wingPitch = 0; behindYaw = 0; behindDist = BEHIND0; aboveH = Math.max(520, SHIP_L * 3.5); towerZoom = 1; });
canvas.addEventListener('wheel', (e) => {
  const f = Math.exp(e.deltaY * 0.001);
  if (view === 'behind') behindDist = THREE.MathUtils.clamp(behindDist * f, 60, 2500);
  else if (view === 'above') aboveH = THREE.MathUtils.clamp(aboveH * f, 120, 7000);
  else if (view === 'tower') towerZoom = THREE.MathUtils.clamp(towerZoom / f, 0.3, 6);
}, { passive: true });

// --- Readouts --------------------------------------------------------------------------------------------------------------
// The task card (top right: the stages, the order, the next mark, the zone's speed limit, the tide, the port's signals, the
// check-list), the berthing display (left, near the berth), the end card.
const taskEl = document.createElement('div');
taskEl.className = 'hb-task';
const dockEl = document.createElement('div');
dockEl.className = 'hb-dock';
const endEl = document.createElement('div');
endEl.className = 'hb-end';
endEl.hidden = true;
document.body.append(taskEl, dockEl, endEl);

const brgTo = (x, z) => compass(Math.atan2(z - sim.z, x - sim.x));
const pad3 = (d) => String(Math.round(d) % 360).padStart(3, '0');
const dist = (m) => (m >= 1000 ? `${(m / 1000).toFixed(2).replace('.', FR ? ',' : '.')} km` : `${Math.round(m)} m`);
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const dec = (v, d = 1) => (FR ? v.toFixed(d).replace('.', ',') : v.toFixed(d));
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
// The port's state, in chips: the entrance lights, the lock's light (D), the tugs, the pilot, VHF 12, the tide and the stream.
function portHtml() {
  const chip = (cls, text, title) => `<span class="hb-chip-s ${cls}" title="${title}">${text}</span>`;
  const out = [];
  out.push(chip(sim.entryLight === 'red' ? 'red' : 'green', `Passe ${sim.entryLight === 'red' ? '●' : '●'}`, sim.entryLight === 'red' ? 'Feux de passe rouges : un navire sort, entrée interdite' : 'Feux de passe verts : entrée autorisée'));
  if (sim.route.lock) out.push(chip(sim.lockLight === 'red' ? 'red' : 'green', 'Écluse ●', sim.lockLight === 'red' ? 'Feu rouge : n\'approchez pas du sas' : 'Feu vert : entrez dans le sas'));
  if (sim.needsTugs || sim.tugs !== 'none') out.push(chip(sim.tugs === 'fast' ? 'ok' : sim.tugs === 'called' ? 'warn' : 'off', sim.tugs === 'fast' ? 'Remorqueurs pris' : sim.tugs === 'called' ? 'Remorqueurs en route' : 'Remorqueurs (T)', 'Remorquage obligatoire au-delà de 120 m'));
  if (sim.needsPilot) out.push(chip(sim.pilotAboard ? 'ok' : 'off', sim.pilotAboard ? 'Pilote à bord' : 'Pilote : zone P', 'Pilote obligatoire au-delà de 80 m'));
  out.push(chip(sim.vhf ? 'ok' : 'off', sim.vhf ? 'VHF 12 ✓' : 'VHF 12 (K)', 'Annoncer l\'arrivée ou le départ sur VHF 12'));
  if (sim.anchor) out.push(chip('warn', sim.anchor.weighing !== null ? 'On vire l\'ancre' : 'Au mouillage', 'M : virer l\'ancre'));
  const T = sim.spring ? TIDES.spring : TIDES.neap;
  const st = sim.stream.kn;
  const tide = `<div class="hb-tide"><span>${T.name} · ${sim.hour < 0 ? 'flot' : 'jusant'} · PM${sim.hour >= 0 ? '+' : '−'}${dec(Math.abs(sim.hour), 1)} h</span><b>${dec(sim.tide, 2)} m</b>${Math.abs(st) > 0.05 ? `<em>courant ${dec(Math.abs(st), 1)} nd ${st > 0 ? '090°' : '270°'}</em>` : ''}</div>`;
  return `<div class="hb-chips">${out.join('')}</div>${tide}`;
}
const ITEM_ICON = { ok: '✓', fail: '✕', todo: '', na: '' };
function checklistHtml() {
  const rows = CHECKLIST.map((t, i) => [i + 1, t, sim.items[i + 1]]).filter(([, , st]) => st !== 'na');
  return `<details class="hb-check" ${checkOpen ? 'open' : ''}><summary>Check-list d'escale <i>${rows.filter((r) => r[2] === 'ok').length}/${rows.length}</i></summary><ol>${rows.map(([n, t, st]) => `<li class="hb-ck-${st}" value="${n}"><i>${ITEM_ICON[st]}</i>${t}</li>`).join('')}</ol></details>`;
}
let checkOpen = true;
taskEl.addEventListener('toggle', (e) => { if (e.target.matches?.('details.hb-check')) checkOpen = e.target.open; }, true);
function taskHtml() {
  const st = sim.stageText;
  const list = sim.kind === 'mob' ? MOB_STEPS : sim.stages;
  const n = list.indexOf(sim.stage);
  const steps = list.map((s, i) => `<i class="${i < n || sim.stage === 'done' ? 'done' : i === n ? 'now' : ''}"></i>`).join('');
  const m = sim.mark;
  const mk = m ? `<div class="hb-mark"><span>${m.name}</span><b>${dist(Math.hypot(m.x - sim.x, m.z - sim.z))}</b><b>${pad3(brgTo(m.x, m.z))}°</b></div>` : '';
  if (sim.kind === 'mob') return `<div class="hb-steps">${steps}</div><div class="hb-ttl">${st.title}</div><p>${st.task}</p>${mk}${wtHtml()}`;
  const R = sim.route, kn = Math.abs(sim.u) / KT, z = sim.zone;
  const lim = z.kn < Infinity ? `<div class="hb-limit ${kn > z.kn + 0.2 ? 'over' : ''}">Vitesse limitée <b>${z.kn} nd</b> · ${z.name}</div>` : '';
  const cross = sim.crossing ? `<div class="hb-cross ${sim.crossing.done ? (sim.crossing.ok ? 'ok' : 'bad') : ''}">Croisement : ${sim.crossing.done ? (sim.crossing.ok ? 'bâbord sur bâbord, dans la zone ✓' : sim.crossing.why) : 'bâbord sur bâbord entre G3-R4 et G1-R2, 6 nd au plus'}</div>` : '';
  return `<div class="hb-route" style="--rc:${R.color}"><b>${R.id}</b><span>${R.title}</span></div><div class="hb-steps">${steps}</div><div class="hb-ttl">${st.title}</div><p>${st.task}</p>${mk}${lim}${cross}${portHtml()}${checklistHtml()}`;
}
// --- The steering readouts: Solo Air Defense's strip (the .helm-ship styles in helm.css) --------------------------------------
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
propL.title = propR.title = FR ? 'L\'hélice : elle tourne avec l\'ordre machine (à l\'envers en arrière)' : 'The two screws: they turn with the engine order (backwards astern)';
barL.className = barR.className = 'hs-lvl'; // the telegraph: four notches ahead (dead slow to full), lit from the bottom; astern lights them blue
barL.innerHTML = barR.innerHTML = '<i></i><i></i><i></i><i></i>';
barL.title = barR.title = FR ? 'Transmetteur d\'ordres (↑ ↓)' : 'Engine telegraph (↑ ↓)';
centre.append(barL, propL, domeHost, propR, barR);
shipEl.append(statHost, centre, cmdHost);
document.body.appendChild(shipEl);
const propRotL = propL.querySelector('.pp-rot'), propRotR = propR.querySelector('.pp-rot');
let propAng = 0, rev = 0;
const FULL = sim.tel[sim.tel.length - 1].kn;
function spinProps(dt) {
  rev += ((sim.ordered / FULL) - rev) * (1 - Math.exp(-dt / 1.5)); // the screws run up and down with the order, not at once
  propAng = (propAng + rev * 7 * dt) % (Math.PI * 2);
  const deg = (propAng * 180) / Math.PI;
  propRotL.style.transform = `rotate(${-deg}deg)`; propRotR.style.transform = `rotate(${deg}deg)`;
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
  const RR = DOME_R + 2.5, span = THREE.MathUtils.degToRad(74);
  const th = THREE.MathUtils.clamp(sim.rudder / RUDDER_MAX, -1, 1) * span;
  const p0 = pt(RR, Math.PI / 2), p1 = pt(RR, Math.PI / 2 - th), pl = pt(RR, Math.PI / 2 + span), pr = pt(RR, Math.PI / 2 - span);
  const fill = Math.abs(th) > 0.01 ? `<path d="M${p0[0]},${p0[1]} A${RR},${RR} 0 0 ${th > 0 ? 1 : 0} ${p1[0]},${p1[1]}" class="rf ${th > 0 ? 'stbd' : 'port'}"/>` : '';
  const kn = sim.u / KT;
  const way = FR ? (kn > 0.05 ? 'en avant' : kn < -0.05 ? 'en arrière' : 'stoppé') : (kn > 0.05 ? 'ahead' : kn < -0.05 ? 'astern' : 'stopped');
  const side = Math.abs(sim.v) > 0.03 ? ` · ${dec(Math.abs(sim.v) / KT, 1)} ${sim.v > 0 ? '▶' : '◀'}` : '';
  return `<svg viewBox="0 0 200 104" class="dome-svg" aria-hidden="true"><path d="M6,100 A${DOME_R},${DOME_R} 0 0 1 194,100" class="rim"/>${ticks}${labels}`
    + `<path d="M${cx - 4},${cy - DOME_R - 1} L${cx + 4},${cy - DOME_R - 1} L${cx},${cy - DOME_R + 6} Z" class="lub"/>`
    + `<text x="${cx}" y="79" class="hd">${pad3(h)}°</text>`
    + `<path d="M${pl[0]},${pl[1]} A${RR},${RR} 0 0 1 ${pr[0]},${pr[1]}" class="rt"/>${fill}`
    + `<line x1="${p0[0]}" y1="${(Number(p0[1]) - 4).toFixed(1)}" x2="${p0[0]}" y2="${(Number(p0[1]) + 4).toFixed(1)}" class="rm"/>`
    + `<text x="${cx}" y="94" class="sp">${dec(Math.abs(kn), 1)}<tspan> ${FR ? 'nd' : 'kn'} ${way}${side}</tspan></text></svg>`;
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
  depth: '<path d="M2 6.5q2.5-1.6 5 0t5 0 5 0 5 0"/><path class="hb-fill" d="M7 9.5h10l-1.6 3.4H8.6z"/><path d="M12 13v6M9.5 17l2.5 2.5 2.5-2.5"/><path d="M2 21.5h20"/>',
};
function badgesHtml() {
  const hull = 100 - sim.damage, n = sim.contacts.touch + sim.contacts.hard + sim.contacts.crash;
  const tone = sim.stage === 'wrecked' ? 'out' : sim.damage === 0 ? 'ok' : sim.damage < 40 ? 'hurt' : 'bad';
  const kn = Math.abs(sim.u) / KT;
  const lim = sim.route ? sim.zone.kn : Infinity;
  const sCls = lim === Infinity ? 'sea' : kn > lim + 0.2 ? 'over' : kn > lim - 1 ? 'near' : 'ok';
  const tf = Math.min(1, thrusterFactor(sim.u, sim.ship.thrFade) + (sim.tugs === 'fast' ? tugFactor(sim.u) : 0)), busy = Math.abs(sim.thr.yaw) + Math.abs(sim.thr.sway) > 0.05;
  if (!FR) {
    return badge(`hb-hull ${tone}`, BI.hull, hull / 100, 'Hull', `${Math.round(hull)} % · ${sim.contacts.hard} hard contacts, ${sim.contacts.crash} collisions`, '')
      + badge(`hpb-speed ${sCls}`, BI.speed, kn / 16, 'Speed', `${dec(kn, 1)} kn`, dec(kn, 0))
      + badge(`hpb-thr ${tf < 0.05 ? 'off' : busy ? 'busy' : 'ok'}`, BI.thr, tf, 'Thrusters', tf < 0.05 ? 'no effect above 5 kn' : `${Math.round(tf * 100)} % · Q E turn, A D sideways`, '')
      + badge(`hpb-bump ${sim.contacts.hard + sim.contacts.crash ? 'bad' : n ? 'warn' : 'ok'}`, BI.bump, 1, 'Contacts', n ? `${sim.contacts.touch} touches, ${sim.contacts.hard} hard, ${sim.contacts.crash} collisions` : 'none yet', String(n));
  }
  const ukc = sim.ukc;
  return badge(`hb-hull ${tone}`, BI.hull, hull / 100, 'Coque', `${Math.round(hull)} % · ${sim.contacts.hard} contacts durs, ${sim.contacts.crash} collisions, ${sim.groundings} échouages`, '')
    + badge(`hpb-speed ${sCls}`, BI.speed, kn / (lim < Infinity ? lim : FULL), lim < Infinity ? `Limite ${lim} nd · ${sim.zone.name}` : 'Vitesse', `${dec(kn, 1)} nd${sCls === 'over' ? ' : trop vite' : ''}`, dec(kn, 0))
    + badge(`hpb-depth ${ukc < 0 ? 'bad' : ukc < 1.5 ? 'warn' : 'ok'}`, BI.depth, Math.min(1, Math.max(0, ukc) / 6), 'Eau sous la quille', `${dec(ukc, 1)} m · tirant d'eau ${dec(sim.ship.T, 1)} m, marée ${dec(sim.tide, 1)} m`, dec(Math.max(0, ukc), 0))
    + badge(`hpb-thr ${tf < 0.05 ? 'off' : busy ? 'busy' : 'ok'}`, BI.thr, tf, sim.tugs === 'fast' ? 'Propulseurs et remorqueurs' : 'Propulseurs', tf < 0.05 ? `sans effet au-dessus de ${sim.tugs === 'fast' ? TUGS.none : sim.ship.thrFade} nd` : `${Math.round(tf * 100)} % · Q E pivoter, A D en crabe`, '')
    + badge(`hpb-bump ${sim.contacts.hard + sim.contacts.crash ? 'bad' : n ? 'warn' : 'ok'}`, BI.bump, 1, 'Contacts', n ? `${sim.contacts.touch} touchers, ${sim.contacts.hard} durs, ${sim.contacts.crash} collisions` : 'aucun', String(n));
}
const CI = { // the commands' drawings, 32 x 32
  lines: '<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M7 27h18M10 27v-9h4v9M18 27v-9h4v9M8.5 18h15"/><g class="hpc-rope"><path d="M12 18c0-5 2-9 8-11.5M20 6.5c2.5-1 5-.6 6.5 1"/><circle class="fill" cx="27" cy="8" r="2.2"/></g></svg>',
  horn: '<svg viewBox="0 0 32 32" aria-hidden="true"><path class="fill" d="M5 13h4l9-6v18l-9-6H5z"/><path d="M9 13v6"/><g class="hpc-waves"><path d="M21.5 11.5a6 6 0 0 1 0 9"/><path class="w2" d="M24.5 8.5a10 10 0 0 1 0 15"/></g></svg>',
  again: '<svg viewBox="0 0 32 32" aria-hidden="true"><g class="fu-turn"><path d="M26 16a10 10 0 1 1-3.2-7.4M26 6v6h-6"/></g></svg>',
  tugs: '<svg viewBox="0 0 32 32" aria-hidden="true"><path class="fill" d="M4 21h15l3-3H8z"/><path d="M9 18v-4h5v4M11 14v-3"/><path d="M22 18c2-1 4-3 6-3"/><path d="M2 25q3-1.5 6 0t6 0 6 0 6 0 6 0"/></svg>',
  vhf: '<svg viewBox="0 0 32 32" aria-hidden="true"><rect class="fill" x="10" y="9" width="10" height="18" rx="2"/><path d="M13 9V3M13 14h4M13 18h4"/><g class="hpc-waves"><path d="M23 12a5 5 0 0 1 0 7"/><path class="w2" d="M26 9a9 9 0 0 1 0 13"/></g></svg>',
  anchor: '<svg viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="6" r="2.5"/><path d="M16 8.5V27M10 13h12M6 20q1 7 10 7t10-7"/></svg>',
};
const cmd = (cls, act, icon, title, sub, key, on) => `<button type="button" class="helm-act ${cls}${on ? ' go' : ''}" data-act="${act}"><i class="sp-ico">${icon}</i><span class="sp-txt"><b>${title}</b><small>${sub}</small></span><kbd>${key}</kbd></button>`;
function cmdHtml() {
  if (!FR) return cmd('hpc-horn', 'horn', CI.horn, 'Ship\'s horn', 'one prolonged blast', 'B', false) + cmd('fu-again', 'again', CI.again, 'Sail again', 'the drill again, from the start', 'R', sim.over);
  const b = sim.stage === 'berth' ? sim.berthState() : null;
  const lt = sim.stage === 'alongside' ? ['Larguer les amarres', 'garde arrière en premier'] : b ? ['Tourner les amarres', b.ok ? 'elle est stoppée : amarrez' : b.why] : sim.stage === 'done' && sim.lines ? ['Amarré', '2 pointes, 2 traversiers, 2 gardes'] : ['Amarres', 'saisies : elles se tournent à poste'];
  const tg = sim.tugs === 'fast' ? ['Larguer les remorqueurs', 'AV tire, AR pousse'] : sim.tugs === 'called' ? ['Remorqueurs', 'en route vers vous'] : ['Remorqueurs', sim.needsTugs ? 'obligatoires : appelez-les' : 'sur demande'];
  return cmd('helm-act-heli hpc-lines', 'lines', CI.lines, lt[0], lt[1], 'L', sim.stage === 'alongside' || (b && b.ok))
    + (sim.ship.id !== 'trawler' ? cmd('hpc-tugs', 'tugs', CI.tugs, tg[0], tg[1], 'T', sim.needsTugs && sim.tugs === 'none') : '')
    + cmd('hpc-vhf', 'vhf', CI.vhf, 'VHF 12', sim.vhf ? 'capitainerie, écluse' : 'annoncez-vous', 'K', !sim.vhf)
    + cmd('hpc-anchor', 'anchor', CI.anchor, sim.anchor ? 'Virer l\'ancre' : 'Mouiller', sim.anchor ? '20 s pour la remonter' : 'en zone de mouillage', 'M', false)
    + cmd('hpc-horn', 'horn', CI.horn, 'Sifflet', 'un son prolongé', 'B', false)
    + cmd('fu-again', 'again', CI.again, 'Recommencer', `manœuvre ${sim.route.id} depuis le début`, 'R', sim.over);
}
cmdHost.addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  ({ lines: () => sim.lineKey(), tugs: () => sim.tugKey(), vhf: () => sim.vhfKey(), anchor: () => sim.anchorKey(), horn: () => horn(), again: () => restart() })[btn.dataset.act]?.();
  btn.blur();
});
function horn() { audio.horn(); say(FR ? 'Un son prolongé' : 'One prolonged blast', '', 1600); }
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
  if (sim.stage !== 'berth' || !sim.target) return '';
  const b = sim.berthState();
  if (b.dist > Math.max(320, SHIP_L * 1.6)) return '';
  const T = BERTH_TOL;
  const gap = (v) => `<b class="${v < 0.4 ? 'bad' : v > T.gap ? 'far' : 'ok'}">${dec(v, 1)}<small>m</small></b>`;
  const hold = sim.berthHold / T.hold;
  const ready = b.ok ? `<div class="hb-ready">Prête : on tourne les amarres <i style="--p:${Math.min(hold, 1).toFixed(2)}"></i></div>` : `<div class="hb-why">${b.why}</div>`;
  const along = Math.round(b.along);
  const ramp = sim.target.ramp;
  return `<div class="hb-dtl">${sim.target.name}</div>`
    + (ramp ? `<div class="hb-gaps"><div><span>Arrière / rampe</span>${gap(b.gapFwd)}</div><div><span>Décalage</span><b class="${Math.abs(b.along) < 6 ? 'ok' : 'far'}">${Math.abs(along)}<small>m</small></b></div></div>`
      : `<div class="hb-gaps"><div><span>Avant / quai</span>${gap(b.gapFwd)}</div><div><span>Arrière / quai</span>${gap(b.gapAft)}</div></div>`
        + `<div class="hb-row"><span>Le long du poste</span><b>${along === 0 ? 'au repère' : `${Math.abs(along)} m`}</b></div>`)
    + `<div class="hb-row"><span>Vitesse vers le quai</span><b class="${b.closing > 0.3 * KT ? 'bad' : ''}">${dec(Math.max(0, b.closing) / KT, 2)} nd</b></div>`
    + `<div class="hb-row"><span>Écart de cap</span><b>${dec((b.head * 180) / Math.PI, 1)}°</b></div>${ready}`;
}
function endHtml() {
  const r = sim.result;
  const again = `<div class="hb-end-b"><button type="button" data-act="again">${FR ? 'Recommencer' : 'Try again'} <kbd>R</kbd></button>${FR ? '<button type="button" data-act="choose">Autre manœuvre</button>' : ''}<button type="button" data-act="menu">${FR ? 'Menu principal' : 'Main menu'}</button></div>`;
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
    if (!FR) return `<div class="hb-end-k">Holed</div><h2>The pilot is relieved</h2><p>She hit too hard to go on: ${sim.contacts.hard} hard contacts and ${sim.contacts.crash} collisions.</p>${again}`;
    return `<div class="hb-end-k bad">Avarie</div><h2>Le pilote est relevé</h2><p>Le navire a heurté trop fort : ${sim.contacts.hard} contacts durs, ${sim.contacts.crash} collisions, ${sim.groundings} échouages.</p>${again}`;
  }
  const stars = '★'.repeat(r.stars) + '<i>' + '★'.repeat(3 - r.stars) + '</i>';
  const items = CHECKLIST.map((t, i) => [i + 1, t, r.items[i + 1]]).filter(([, , s]) => s !== 'na');
  const viol = r.violations.length ? `<ul class="hb-viol">${[...new Set(r.violations.map((v) => v.text))].map((t) => `<li>${t}</li>`).join('')}</ul>` : '<p class="hb-clean">Aucune infraction aux consignes de circulation.</p>';
  return `<div class="hb-end-k">Manœuvre ${r.route} · ${sim.route.kind === 'out' ? 'pilote débarqué' : sim.route.kind === 'turn' ? 'évitage et sortie' : 'amarré'}</div><div class="hb-stars">${stars}</div><h2>${sim.route.title}</h2>`
    + `<div class="hb-score"><b>${r.score}</b><span>/ 100</span></div>`
    + `<dl><dt>Durée</dt><dd>${mmss(r.time)}</dd><dt>Plus vite dans le port</dt><dd>${dec(r.maxInside, 1)} nd${r.overLimit > 1 ? ` · ${Math.round(r.overLimit)} s au-dessus de la limite` : ''}</dd>`
    + `<dt>Contacts</dt><dd>${r.contacts.touch} touchers · ${r.contacts.hard} durs · ${r.contacts.crash} collisions${r.groundings ? ` · ${r.groundings} échouages` : ''}</dd><dt>Coque</dt><dd>${Math.round(100 - r.damage)} %</dd>`
    + (sim.target ? `<dt>À poste</dt><dd>${Math.abs(Math.round(r.along))} m du repère${sim.target.ramp ? '' : ` · ${dec(r.gapFwd, 1)} m / ${dec(r.gapAft, 1)} m du quai`}</dd>` : '')
    + (r.crossing ? `<dt>Croisement</dt><dd>${r.crossing.ok ? 'bâbord sur bâbord, dans la zone' : r.crossing.why || 'non fait'}</dd>` : '') + '</dl>'
    + `<ol class="hb-end-ck">${items.map(([n, t, s]) => `<li class="hb-ck-${s}" value="${n}"><i>${ITEM_ICON[s]}</i>${t}</li>`).join('')}</ol>${viol}${again}`;
}
endEl.addEventListener('click', (e) => {
  const a = e.target.closest('button')?.dataset.act;
  if (a === 'again') restart();
  else if (a === 'choose') openChooser();
  else if (a === 'menu') document.querySelector('#btn-ship').click();
});

// --- The manoeuvre chooser (Harbour pilot): the chart's eight standard manoeuvres -------------------------------------------
const chooserEl = document.createElement('div');
chooserEl.className = 'hb-choose';
chooserEl.hidden = true;
document.body.appendChild(chooserEl);
function openChooser() {
  choosing = true;
  const tide = tidePref ?? '';
  chooserEl.innerHTML = '<div class="hb-choose-in"><div class="hb-choose-h"><b>Port de Zabana</b><span>Manœuvres types · carte imaginaire à but pédagogique</span></div><div class="hb-choose-g">'
    + Object.values(ROUTES).map((R) => `<button type="button" data-route="${R.id}" class="${R.id === routeId ? 'cur' : ''}" style="--rc:${R.color}"><i>${R.id}</i><b>${R.title}</b><small>${R.text.join(' ')}</small><em>${R.where}</em></button>`).join('')
    + '</div><div class="hb-choose-o"><label>Marée <select data-opt="tide"><option value="">celle de la manœuvre</option><option value="spring">vive-eau</option><option value="neap">morte-eau</option></select></label>'
    + `<label><input type="checkbox" data-opt="traffic" ${trafficOn ? 'checked' : ''}> Trafic dans la baie et le port</label>`
    + `${sim.kind === 'mob' ? '' : '<button type="button" data-act="close">Continuer la manœuvre en cours</button>'}</div></div>`;
  chooserEl.querySelector('select').value = tide;
  chooserEl.hidden = false;
}
chooserEl.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.act === 'close') { chooserEl.hidden = true; choosing = false; return; }
  const id = b.dataset.route;
  if (!id) return;
  store.set(ROUTE_KEY, id);
  const t = chooserEl.querySelector('select').value;
  if (t) store.set(TIDE_KEY, t); else try { localStorage.removeItem(TIDE_KEY); } catch { /* storage unavailable */ }
  store.set(TRAFFIC_KEY, chooserEl.querySelector('input[data-opt=traffic]').checked ? '1' : '0');
  try { const u = new URL(location.href); u.searchParams.set('route', id); u.searchParams.set('start', '1'); location.href = u.toString(); } catch { /* not allowed here */ }
});

// The keys for this moment, as Solo Air Defense shows them (the #fly-keys tiles in helm.css). A tile can be clicked or held.
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
  if (!FR) {
    if (sim.over) out.push(k('R', 'sail again', 'r', true));
    out.push(k('←', 'port', 'ArrowLeft', input.wheel < 0), k('→', 'starboard', 'ArrowRight', input.wheel > 0), k('↑', 'more ahead', 'ArrowUp'), k('↓', 'more astern', 'ArrowDown'));
    out.push(k('Q', 'turn to port', 'q', input.turn < 0), k('E', 'turn to stbd', 'e', input.turn > 0), k('A', 'sideways port', 'a', input.slide < 0), k('D', 'sideways stbd', 'd', input.slide > 0));
    out.push(k('B', 'horn', 'b'), k('V', 'next view', 'v'));
    return out.join('');
  }
  if (sim.stage === 'alongside') out.push(k('L', 'larguer', 'l', true));
  if (sim.stage === 'berth' && sim.berthState().ok) out.push(k('L', 'amarrer', 'l', true));
  if (!sim.vhf) out.push(k('K', 'VHF 12', 'k', true));
  if (sim.needsTugs && sim.tugs === 'none') out.push(k('T', 'remorqueurs', 't', true));
  if (sim.over) out.push(k('R', 'recommencer', 'r', true));
  out.push(k('←', 'bâbord', 'ArrowLeft', input.wheel < 0), k('→', 'tribord', 'ArrowRight', input.wheel > 0), k('↑', 'plus en avant', 'ArrowUp'), k('↓', 'plus en arrière', 'ArrowDown'));
  out.push(k('Q', 'pivoter bâbord', 'q', input.turn < 0), k('E', 'pivoter tribord', 'e', input.turn > 0), k('A', 'crabe bâbord', 'a', input.slide < 0), k('D', 'crabe tribord', 'd', input.slide > 0));
  out.push(k('T', 'remorqueurs', 't'), k('M', 'ancre', 'm'), k('B', 'sifflet', 'b'), k('V', 'vue suivante', 'v'));
  return out.join('');
}

// --- The view strip (Solo Air Defense's .helm-views) and the gear menu ---------------------------------------------------------
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
  kb.title = FR ? 'Touches' : 'Keys';
  kb.setAttribute('aria-label', FR ? 'Afficher les touches' : 'Show the keys');
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
  if (save) store.set(FOLD_KEY, on ? '1' : '0');
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
setFolded(store.get(FOLD_KEY) === '1', false);
document.querySelector('#btn-ship').addEventListener('click', () => {
  try { sessionStorage.setItem('intercept.chooser', '1'); location.reload(); } catch { location.search = ''; }
});
{
  const t = menuText(DRILL);
  document.querySelector('.brand b').textContent = t.brand;
  const sub = document.querySelector('#mission-sub');
  if (sub) sub.textContent = FR ? `Zabana · manœuvre ${sim.route.id}` : t.sub;
}

const soundButton = document.querySelector('#btn-sound');
function setSound(on) {
  audio.setEnabled(on);
  soundButton.classList.toggle('active', on);
  soundButton.setAttribute('aria-pressed', String(on));
  store.set('intercept.sound', on ? '1' : '0');
}
setSound(store.get('intercept.sound') !== '0');
if (!audio.supported) { soundButton.disabled = true; soundButton.title = FR ? 'Le son n\'est pas disponible dans ce navigateur' : 'Sound is not available in this browser'; }
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
  store.set('intercept.map', on ? '1' : '0');
}
setMap(store.get('intercept.map') !== '0');
mapButton.addEventListener('click', () => setMap(!map.enabled));

{ // the gear: everything the mission needs, in one menu (the old row of buttons is hidden in harbour.css)
  menuButton.innerHTML = '<svg><use href="#i-gear"/></svg>';
  menuButton.title = L.settings;
  menuButton.setAttribute('aria-label', L.settings);
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
    route: '<path d="M5 20c0-6 6-5 6-10a3 3 0 0 1 6 0c0 4-4 4-4 10"/><circle cx="14" cy="10" r="1"/>',
  };
  const item = (b, label, key, ic) => { b.className = ''; b.setAttribute('role', 'menuitem'); b.innerHTML = `<span class="mi-l">${ic ? `<svg class="mi" viewBox="0 0 24 24" aria-hidden="true">${MI[ic]}</svg>` : ''}${label}</span>${key ? `<kbd>${key}</kbd>` : ''}`; return b; };
  const head = (t) => { const h = document.createElement('div'); h.className = 'menu-h'; h.textContent = t; return h; };
  item(restartButton, L.again, 'R', 'restart');
  item(document.querySelector('#btn-ship'), L.menu, '', 'menu');
  item(hudButton, L.readouts, 'H', 'readouts');
  item(mapButton, L.chart, 'N', 'chart');
  item(soundButton, L.sound, 'S', 'sound');
  item(fsButton, L.full, '', 'full');
  item(foldButton, L.hide, 'C', 'hide');
  item(document.querySelector('#btn-keys'), L.keys, '?', 'keys');
  const switchButton = document.createElement('button');
  item(switchButton, L.switchTo, '', 'restart');
  switchButton.addEventListener('click', () => { try { const u = new URL(location.href); u.searchParams.set('mode', DRILL === 'mob' ? 'harbour' : 'mob'); u.searchParams.set('start', '1'); location.href = u.toString(); } catch { /* not allowed here */ } });
  const chooseButton = document.createElement('button');
  item(chooseButton, 'Choisir la manœuvre (A à H)', 'G', 'route');
  chooseButton.addEventListener('click', () => openChooser());
  menuEl.replaceChildren(head(L.mission), restartButton, ...(FR ? [chooseButton] : []), switchButton, document.querySelector('#btn-ship'), head(L.display), hudButton, mapButton, foldButton, fsButton, head(L.sound), soundButton, head(L.help), document.querySelector('#btn-keys'));
  menuButton.addEventListener('click', () => {
    for (const [b, on] of [[hudButton, hudOn], [mapButton, map.enabled], [soundButton, audio.enabled]]) { b.classList.toggle('active', on); b.setAttribute('aria-pressed', String(on)); }
  });
}

keysSheet.querySelector('dl').innerHTML = (FR ? [
  ['<kbd>←</kbd> <kbd>→</kbd>', 'Barre à bâbord / tribord tant que la touche est tenue ; relâchée, elle revient au zéro. Le gouvernail a besoin d\'erre : à très faible vitesse elle répond à peine'],
  ['<kbd>↑</kbd> <kbd>↓</kbd>', 'Transmetteur d\'ordres, un cran : arrière toute, demi, arrière lente, stop, avant très lente (2 nd), lente (5 nd), demi (8 nd), toute'],
  ['<kbd>Q</kbd> <kbd>E</kbd>', 'Propulseurs (et remorqueurs) l\'un contre l\'autre : elle pivote sur place à bâbord / tribord (propulseurs sans effet au-dessus de 4 à 5 nd, remorqueurs jusqu\'à 6 nd)'],
  ['<kbd>A</kbd> <kbd>D</kbd>', 'Ensemble : elle se déplace en crabe vers bâbord / tribord'],
  ['<kbd>L</kbd>', 'Larguer les amarres (au départ) ; les tourner une fois stoppée à poste'],
  ['<kbd>T</kbd>', 'Remorqueurs : les appeler (ils viennent du poste 2 et prennent l\'avant et l\'arrière), ou les larguer'],
  ['<kbd>K</kbd>', 'VHF 12 : annoncer l\'arrivée ou le départ, demander l\'éclusage, la hauteur d\'eau'],
  ['<kbd>M</kbd>', 'Mouiller l\'ancre (2,5 nd au plus ; interdit dans le chenal et près du câble) ou la virer'],
  ['<kbd>B</kbd>', 'Le sifflet : un son prolongé'],
  ['<kbd>1</kbd> à <kbd>6</kbd>', 'Passerelle, aileron (encore : l\'autre aileron), derrière, vue carte, orbite, feu de la jetée Est'],
  ['<kbd>V</kbd>', 'Vue suivante · glisser pour regarder, molette pour zoomer, double clic pour revenir'],
  ['<kbd>N</kbd> <kbd>G</kbd>', 'Carte (cliquer pour changer l\'échelle) · choisir la manœuvre'],
  ['<kbd>R</kbd>', 'Recommencer'],
  ['<kbd>S</kbd> <kbd>H</kbd> <kbd>C</kbd>', 'Son, affichages, masquer l\'interface'],
] : [
  ['<kbd>←</kbd> <kbd>→</kbd>', 'Rudder to port / starboard while held; let go and it comes back amidships. The rudder needs water past it: at a crawl she hardly answers'],
  ['<kbd>↑</kbd> <kbd>↓</kbd>', 'Engine telegraph, one step: full, half, slow and slow astern, stop, dead slow, slow, half, full ahead'],
  ['<kbd>Q</kbd> <kbd>E</kbd>', 'Bow and stern thrusters against each other: she turns on the spot to port / starboard (full below 1 kn, nothing from 5 kn)'],
  ['<kbd>A</kbd> <kbd>D</kbd>', 'Both thrusters together: she moves sideways to port / starboard'],
  ['<kbd>B</kbd>', 'The ship\'s horn: one prolonged blast'],
  ['<kbd>1</kbd> to <kbd>6</kbd>', 'Bridge, bridge wing (again: the other wing), behind, chart view, orbit, jetty-head light'],
  ['<kbd>V</kbd>', 'Next view · drag looks round, the wheel zooms, double click resets'],
  ['<kbd>N</kbd>', 'Chart (click it to change the scale)'],
  ['<kbd>R</kbd>', 'Sail again'],
  ['<kbd>S</kbd>', 'Sound on / off'],
  ['<kbd>H</kbd> <kbd>C</kbd>', 'Readouts, hide the interface'],
]).map(([k, d]) => `<dt>${k}</dt><dd>${d}</dd>`).join('');
keysSheet.querySelector('.keys-note').textContent = FR
  ? `Port de Zabana · manœuvre ${sim.route.id} : ${sim.route.title} · 8 nd avant-port, 5 nd bassins, 2 nd écluse`
  : 'Man overboard: hard over toward his side at once, the Williamson turn (reverse at 60° off), back down the wake, stop with him abeam';
const keysTitle = keysSheet.querySelector('h2, h3');
if (keysTitle && FR) keysTitle.textContent = 'Raccourcis clavier';

// --- Keys --------------------------------------------------------------------------------------------------------------------
const input = { wheel: 0, turn: 0, slide: 0 };
const held = new Set();
function syncInput() {
  input.wheel = (held.has('ArrowRight') ? 1 : 0) - (held.has('ArrowLeft') ? 1 : 0);
  input.turn = (held.has('e') ? 1 : 0) - (held.has('q') ? 1 : 0);
  input.slide = (held.has('d') ? 1 : 0) - (held.has('a') ? 1 : 0);
}
const startText = () => (FR
  ? (sim.route.kind === 'out' ? `Manœuvre ${sim.route.id} : à quai au poste 6, amarres tournées. Prévenez VHF 12 (K), puis larguez (L)` : sim.route.kind === 'turn' ? `Manœuvre ${sim.route.id} : dans le cercle d'évitage, remorqueurs pris. Pivotez sur tribord` : `Manœuvre ${sim.route.id} : sur rade de Zabana à ${sim.route.start.kn} nd. Annoncez-vous sur VHF 12 (K)`)
  : 'On passage in the Baie de Zabana at 10 knots. Man overboard drill: be ready');
function restart() {
  sim.reset();
  wake.clear();
  audio.reset();
  endEl.hidden = true;
  banner.hidden = true;
  setView('behind', true);
  say(startText(), '', 5000);
}

window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLElement && e.target.closest('input, textarea, select')) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (choosing && key !== 'Escape') return;
  if (['ArrowLeft', 'ArrowRight', 'q', 'e', 'a', 'd'].includes(key)) { held.add(key); syncInput(); e.preventDefault(); return; }
  if (e.repeat) { if (key.startsWith('Arrow')) e.preventDefault(); return; }
  switch (key) {
    case 'ArrowUp': sim.telegraph(+1); break;
    case 'ArrowDown': sim.telegraph(-1); break;
    case 'l': sim.lineKey(); break;
    case 't': sim.tugKey(); break;
    case 'k': sim.vhfKey(); break;
    case 'm': sim.anchorKey(); break;
    case 'g': if (FR) openChooser(); break;
    case 'b': horn(); break;
    case 'r': restart(); break;
    case 'v': setView(VIEWS[(VIEWS.indexOf(view) + 1) % VIEWS.length]); break;
    case '1': case '2': case '3': case '4': case '5': case '6': setView(VIEWS[Number(key) - 1]); break;
    case 'h': setHud(!hudOn); break;
    case 'n': setMap(!map.enabled); break;
    case 's': setSound(!audio.enabled); break;
    case 'c': setFolded(!document.body.classList.contains('ui-hidden')); break;
    case '?': setKeys(keysSheet.hidden); break;
    case 'Escape': if (choosing && sim.kind !== 'mob' && ROUTES[routeParam]) { chooserEl.hidden = true; choosing = false; } closePopovers(); break;
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
  const roll = sim.heel + 0.008 * Math.sin(t * 0.52) * (116 / SHIP_L) + 0.003 * Math.sin(t * 1.3 + 1);
  const pitch = 0.003 * Math.sin(t * 0.37 + 0.4);
  ship.group.position.set(sim.x, 0.05 * Math.sin(t * 0.61), sim.z);
  ship.group.rotation.set(roll, -sim.psi, pitch);
  ship.group.updateMatrixWorld(true);
  ship.update(1000 + t, Infinity);
  env.ocean.material.uniforms.uTime.value = t;
  if (!sim.lines) wake.update({ t, x: sim.x, z: sim.z, psi: sim.psi, r: sim.r, u: sim.u });
  harbour.update(t, sim, camera.position);
  details.update(t, sim, { bridgeView: view === 'bridge' || view === 'wing' });
  mobScene.update(t, sim, ship, camera.position);
  for (const [v, m] of trafficModels) {
    const vis = sim.traffic.visible(v);
    m.g.visible = vis;
    if (!vis) continue;
    m.g.position.set(v.x, 0.05 * Math.sin(t * 0.7 + m.ph), v.z);
    m.g.rotation.set(0.01 * Math.sin(t * 0.6 + m.ph) * (v.L < 40 ? 3 : 1), -v.psi, 0);
  }
}

let lastTask = '', lastDock = '', lastKeys = '', frames = 0, last = performance.now();
let endShown = false;
renderer.setAnimationLoop((now) => {
  const dt = Math.max(0, Math.min((now - last) / 1000, 0.1));
  last = now;
  if (!intro && !choosing) sim.advance(dt, input);
  for (const e of sim.takeEvents()) {
    audio.event(e);
    if (e.type === 'say') say(e.text, e.tone, e.tone === 'danger' ? 4200 : 3600);
    else if (e.type === 'vhf') radio(e.from, e.text);
    else if (e.type === 'telegraph') say(L.aye(sim.tel[e.order]), '', 1700); // the order is repeated back
  }
  applyState();
  updateCamera(dt);
  audio.update(sim, view === 'bridge' ? 1 : view === 'wing' ? 0.4 : 0);
  env.follow(camera.position);
  env.setShadowFocus(_b.set(sim.x, 0, sim.z), view === 'above' ? Math.min(aboveH * 0.6, 500) : Math.max(140, SHIP_L * 0.9));
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
  if (!vhfEl.hidden && performance.now() > vhfUntil) vhfEl.hidden = true;
  renderer.render(scene, camera);
  if (frames++ === 0) loadingEl?.remove();
});

setView('behind', true);
if (choosing) openChooser();
else say(startText(), '', 6000);
window.__harbour = { sim, camera, controls, renderer, scene, env, harbour, ship: ship.group, setView, restart, openChooser, ROUTES, toChart, get view() { return view; } };

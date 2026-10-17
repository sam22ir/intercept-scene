import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  scenario, planePos, planePose, planeVel, propAngle, propSpin01, missilePose, shipPos, tubeMouth, SHIP_SPEED, SHIP_VARIANT, PENNANT,
} from './scenario.js';
import { createLabels } from './labels.js';
import { createParachute } from './models/parachute.js';
import { createPathEditor, toast } from './pathEditor.js';
import { createEnvironment } from './environment.js';
import { createShip } from './models/ship.js';
import { createPlane } from './models/plane.js';
import { createMissile } from './models/missile.js';
import { createDebris, createEffects } from './fx/effects.js';
import { pointScale } from './fx/particles.js';
import { CameraRig } from './cameraRig.js';
import { createTimeline } from './timeline.js';
import { createDirector } from './director.js';
import { createAudio } from './audio.js';
import { createHud } from './hud.js';
import { createRecorder } from './recorder.js';
import { createPair } from './pair.js';
import { createShare, readShareParams, stripShareParams } from './share.js';
import { createEngagePanel, SEEK_KEY } from './engagePanel.js';

const canvas = document.querySelector('#scene');
const loadingEl = document.querySelector('#loading');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
const PIXEL_RATIO_CAP = { high: 2, medium: 1.5, low: 1 };
renderer.setPixelRatio(Math.min(window.devicePixelRatio, PIXEL_RATIO_CAP.high));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.75;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, 1, 0.3, 30000);
camera.position.set(-30, 13, -26);

const controls = new OrbitControls(camera, canvas);
controls.target.set(-47, 7.5, -4);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.maxDistance = 6000;
controls.maxPolarAngle = Math.PI * 0.495;

// Idle rendering: the loop keeps running (clock, controls, audio, UI) but the
// scene is only drawn when something visible changed. invalidate() forces the
// next frame; input events and UI toggles call it.
let invalidations = 0;
let renderCount = 0;
function invalidate() { invalidations++; }
for (const type of ['pointerdown', 'pointermove', 'pointerup', 'wheel', 'keydown', 'click', 'resize', 'visibilitychange']) {
  window.addEventListener(type, invalidate, { capture: true, passive: true });
}
canvas.addEventListener('webglcontextrestored', invalidate);

const env = createEnvironment(renderer, scene);

const ship = createShip();
scene.add(ship.group);
const plane = createPlane();
scene.add(plane.group);
const missile = createMissile();
scene.add(missile.group);

const debris = scenario.hasMissile ? createDebris(plane) : null;
const chute = scenario.hasMissile ? null : createParachute();
if (chute) scene.add(chute.group);
const effects = createEffects(scene, debris);
if (debris) scenario.tEnd = scenario.tHit + debris.fallTime + 5;
// Pair mission: the second drone, its missile, wreck and effects.
const pair = scenario.engagements.length > 1 ? createPair(scene) : null;
if (pair) scenario.tEnd = Math.max(scenario.tEnd, pair.tDone);

// Floating tags + missile path; the on/off choice is remembered per viewer.
const labels = createLabels(scene);
const labelsButton = document.querySelector('#btn-labels');
function setLabels(on) {
  invalidate();
  labels.setEnabled(on);
  labelsButton.classList.toggle('active', on);
  labelsButton.setAttribute('aria-pressed', String(on));
  try { localStorage.setItem('intercept.labels', on ? '1' : '0'); } catch { /* storage unavailable */ }
}
let labelsPref = true;
try { labelsPref = localStorage.getItem('intercept.labels') !== '0'; } catch { /* storage unavailable */ }
setLabels(labelsPref);
labelsButton.addEventListener('click', () => setLabels(!labels.enabled));

// --- Applying a moment in time ----------------------------------------------

const telemetry = { planeAlt: 0, planeSpeed: 0, missileSpeed: null, range: null };
const _mPos = new THREE.Vector3();
const _lPos = new THREE.Vector3();
const _lVel = new THREE.Vector3();
const _lShip = new THREE.Vector3();

function applyTime(t) {
  const { tHit, tLaunch } = scenario;

  shipPos(t, ship.group.position);
  ship.update(t, tLaunch, pair?.e.tLaunch);

  if (t < tHit) {
    plane.restoreParts();
    telemetry.planeSpeed = planePose(t, plane.group.position, plane.group.quaternion);
    plane.setProp(propAngle(t), propSpin01(t));
    telemetry.planeAlt = plane.group.position.y;
  } else {
    debris.apply(t - tHit);
    telemetry.planeSpeed = 0;
    telemetry.planeAlt = debris.fuselagePos(t - tHit, _mPos).y;
  }
  plane.setLights(t, t < tHit);
  plane.setBooster(t, scenario.tBoost0, scenario.tBoost1);
  chute?.update(t, plane.group.position, plane.group.quaternion);

  const flying = t > tLaunch && t < tHit;
  missile.group.visible = flying;
  if (flying) {
    telemetry.missileSpeed = missilePose(t, missile.group.position, missile.group.quaternion);
    missile.setExhaust(t);
    telemetry.range = missile.group.position.distanceTo(plane.group.position);
  } else {
    telemetry.missileSpeed = null;
    telemetry.range = null;
  }

  labels.update({
    t,
    dronePos: t < tHit ? plane.group.position : debris.fuselagePos(t - tHit, _lPos),
    droneSpeed: t < tHit ? planeVel(t, _lVel).length() : 0,
    droneAlt: telemetry.planeAlt,
    droneRange: (t < tHit ? plane.group.position : _lPos).distanceTo(_lShip.copy(ship.group.position).setY(10)),
    missilePos: missile.group.position,
    missileSpeed: telemetry.missileSpeed ?? 0,
    missileRange: telemetry.range ?? 0,
    shipPos: ship.group.position,
    shipSpeed: SHIP_SPEED,
    second: pair?.apply(t),
  });
  if (pair && rig.id === 'missile2' && t >= pair.e.tHit) setFocus('plane2', 60); // out of the fireball
  if (pair) missile2Button.disabled = t >= pair.e.tHit;

  const ou = env.ocean.material.uniforms;
  ou.uTime.value = t;
  ou.uShipX.value = ship.group.position.x;
  effects.update(t);
}

// --- Focus targets ------------------------------------------------------------
// Each target always resolves to a world position, even when the object itself
// is not on screen: the missile waits in its launch tube and ends at the blast
// point, the drone hands over to its falling fuselage.

// The drone in flight, then its falling fuselage, at any time t (used by the
// focus targets, the Director and the audio).
function dronePosAt(t, out) {
  if (t < scenario.tHit) return planePos(t, out);
  debris.fuselagePos(t - scenario.tHit, out);
  out.y = Math.max(out.y, 0); // keep watching the splash once it sinks
  return out;
}

const targets = {
  plane: {
    pos: (out) => {
      if (clock.t < scenario.tHit) return out.copy(plane.group.position);
      return dronePosAt(clock.t, out);
    },
    distance: 14, minDistance: 2.5, hitRadius: 4,
  },
  missile: {
    pos: (out) => {
      if (clock.t <= scenario.tLaunch) return tubeMouth(clock.t, out);
      if (clock.t >= scenario.tHit) return out.copy(scenario.hitPos);
      return out.copy(missile.group.position);
    },
    distance: 9, minDistance: 1.5, hitRadius: 3,
  },
  ship: { pos: (out) => out.copy(ship.group.position).setY(10), distance: 190, minDistance: 40 },
};
if (pair) {
  targets.plane2 = {
    pos: (out) => (clock.t < pair.e.tHit ? out.copy(pair.plane.group.position) : pair.dronePosAt(clock.t, out)),
    distance: 14, minDistance: 2.5, hitRadius: 4,
  };
  targets.missile2 = {
    pos: (out) => {
      if (clock.t <= pair.e.tLaunch) return tubeMouth(clock.t, out, 1);
      if (clock.t >= pair.e.tHit) return out.copy(pair.e.hitPos);
      return out.copy(pair.missile.group.position);
    },
    distance: 9, minDistance: 1.5, hitRadius: 3,
  };
}

// Invisible pick volumes. Drone and missile spheres grow with camera distance
// so they stay clickable when they are only a few pixels across; the ship's
// boxes ride along inside its group.
const pickMat = new THREE.MeshBasicMaterial({ visible: false });
const pickables = [...ship.picks];
for (const id of pair ? ['plane', 'missile', 'plane2', 'missile2'] : ['plane', 'missile']) {
  const m = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), pickMat);
  m.userData.focus = id;
  scene.add(m);
  pickables.push(m);
}

function updatePickables() {
  for (const m of pickables) {
    const target = targets[m.userData.focus];
    if (!target.hitRadius) continue;
    target.pos(m.position);
    m.scale.setScalar(Math.max(target.hitRadius, camera.position.distanceTo(m.position) * 0.025));
  }
}

const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
function pick(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  const hits = raycaster.intersectObjects(pickables, false)
    .filter((h) => h.object.userData.focus !== 'missile' || missile.group.visible)
    .filter((h) => h.object.userData.focus !== 'missile2' || pair.missile.group.visible)
    .filter((h) => h.object.userData.focus !== 'plane2' || pair.plane.group.visible);
  // Small moving objects win over the ship they overlap.
  const small = hits.find((h) => h.object.userData.focus !== 'ship');
  return (small ?? hits[0])?.object.userData.focus ?? null;
}

const rig = new CameraRig(camera, controls);
// Pair mission: extra focus buttons for the second drone and its missile.
for (const el of document.querySelectorAll('[data-pair-only]')) el.hidden = !pair;
const missile2Button = document.querySelector('[data-focus="missile2"]');
const focusButtons = document.querySelectorAll('[data-focus]');
function setFocus(id, distance) {
  invalidate();
  if (directing) setDirector(false); // any manual camera choice ends the Director
  if (id === 'free' || !targets[id]) rig.free();
  else rig.focus(id, targets[id].pos, distance ?? targets[id].distance, targets[id].minDistance);
  focusButtons.forEach((b) => b.classList.toggle('active', b.dataset.focus === rig.id));
}
focusButtons.forEach((b) => b.addEventListener('click', () => setFocus(b.dataset.focus)));
const missileButton = document.querySelector('[data-focus="missile"]');
document.querySelector('#btn-ship').addEventListener('click', () => {
  stripShareParams(); // the chooser starts a new view: drop t, focus, cam and the shared path
  try { sessionStorage.setItem('intercept.chooser', '1'); location.reload(); } catch { location.search = ''; }
});

// --- Director: cinematic cuts ---------------------------------------------------
// While on, the Director places the camera every frame (OrbitControls and the
// focus rig are bypassed). Any manual camera input hands control back.

const fuselagePiece = debris?.pieces.find((p) => p.part.name === 'fuselage');
const director = createDirector({
  dronePos: dronePosAt,
  tWater: debris ? scenario.tHit + fuselagePiece.tauWater : scenario.tSplash,
  second: pair && {
    dronePos: pair.dronePosAt,
    tWater: pair.e.tHit + pair.debris.pieces.find((p) => p.part.name === 'fuselage').tauWater,
  },
});
const directorButton = document.querySelector('#btn-director');
const shotCaption = document.querySelector('#shot-caption');
let directing = false;
let currentShot = null;
const dirLook = new THREE.Vector3();
let dirShadowR = 75;

function setDirector(on) {
  if (on === directing) return;
  directing = on;
  invalidate();
  directorButton.classList.toggle('active', on);
  directorButton.setAttribute('aria-pressed', String(on));
  controls.enabled = !on;
  if (on) {
    rig.free();
    focusButtons.forEach((b) => b.classList.remove('active'));
  } else {
    shotCaption.hidden = true;
    currentShot = null;
    // Hand the view to OrbitControls without a jump: keep the camera where it is and
    // aim the orbit target level with it (a low shot looks up, which the polar limit forbids).
    const dist = Math.max(camera.position.distanceTo(dirLook), 5);
    camera.getWorldDirection(controls.target).setY(0).normalize()
      .multiplyScalar(dist).add(camera.position);
    controls.update();
    focusButtons.forEach((b) => b.classList.toggle('active', b.dataset.focus === 'free'));
  }
}
directorButton.addEventListener('click', () => { if (!directing && editor.active) return; setDirector(!directing); });
canvas.addEventListener('pointerdown', () => { if (directing) setFocus('free'); }, true);
canvas.addEventListener('wheel', () => { if (directing) setFocus('free'); }, { passive: true, capture: true });
try {
  if (new URLSearchParams(location.search).get('cam') === 'director') setDirector(true);
} catch { /* no query string available */ }

// --- Sound ----------------------------------------------------------------------

const audio = createAudio({
  dronePos: dronePosAt,
  splashTimes: debris ? debris.pieces.map((p) => scenario.tHit + p.tauWater) : [scenario.tSplash],
  pair: pair && { dronePos: pair.dronePosAt, splashTimes: pair.splashTimes },
});
// Hide/show the whole interface (Hide button in the top bar, Show button, or the C key); remembered.
const FOLD_KEY = 'intercept.uiHidden'; // not the old panelFolded key: that one only folded a panel
const foldButton = document.querySelector('#btn-fold');
const unfoldButton = document.querySelector('#btn-unfold');
let panelFolded = false;
function setPanelFolded(on, save = true) {
  panelFolded = on;
  invalidate();
  if (on) closePopovers();
  document.body.classList.toggle('ui-hidden', on);
  unfoldButton.hidden = !on;
  foldButton.setAttribute('aria-expanded', String(!on));
  if (save) try { localStorage.setItem(FOLD_KEY, on ? '1' : '0'); } catch { /* storage unavailable */ }
}
foldButton.addEventListener('click', () => setPanelFolded(true));
unfoldButton.addEventListener('click', () => setPanelFolded(false));

// "More" menu and the keyboard-shortcuts sheet. Esc, a click outside, or picking an item closes them.
const menuButton = document.querySelector('#btn-menu');
const menuEl = document.querySelector('#menu');
const keysEl = document.querySelector('#keys');
function setMenu(open) {
  menuEl.hidden = !open;
  menuButton.setAttribute('aria-expanded', String(open));
  invalidate();
}
function setKeys(open) { keysEl.hidden = !open; invalidate(); }
function closePopovers() {
  const was = !menuEl.hidden || !keysEl.hidden;
  setMenu(false); setKeys(false);
  return was;
}
menuButton.addEventListener('click', () => setMenu(menuEl.hidden));
menuEl.addEventListener('click', (e) => { if (e.target.closest('button, a')) setMenu(false); });
document.querySelector('#btn-keys').addEventListener('click', () => setKeys(true));
document.querySelector('#keys-close').addEventListener('click', () => setKeys(false));
window.addEventListener('pointerdown', (e) => {
  if (!menuEl.hidden && !e.target.closest('#menu, #btn-menu')) setMenu(false);
  if (!keysEl.hidden && !e.target.closest('#keys, #btn-keys')) setKeys(false);
}, true);
try { setPanelFolded(localStorage.getItem(FOLD_KEY) === '1', false); } catch { /* storage unavailable */ }

const MISSION_NAME = { intercept: 'Intercept', chute: 'Recovery', pair: 'Two drones' };
document.querySelector('#mission-sub').textContent = `${PENNANT} · ${SHIP_VARIANT === 'aft' ? 'Aft' : 'Fwd'} launcher · ${MISSION_NAME[scenario.mode] ?? scenario.mode}`;

const soundButton = document.querySelector('#btn-sound');
function setSound(on) {
  invalidate();
  audio.setEnabled(on);
  soundButton.classList.toggle('active', on);
  soundButton.setAttribute('aria-pressed', String(on));
  try { localStorage.setItem('intercept.sound', on ? '1' : '0'); } catch { /* storage unavailable */ }
}
let soundPref = true;
try { soundPref = localStorage.getItem('intercept.sound') !== '0'; } catch { /* storage unavailable */ }
audio.setEnabled(soundPref);
soundButton.classList.toggle('active', soundPref);
soundButton.setAttribute('aria-pressed', String(soundPref));
if (!audio.supported) { soundButton.disabled = true; soundButton.title = 'Sound is not available in this browser'; }
soundButton.addEventListener('click', () => setSound(!audio.enabled));

let downAt = null;
canvas.addEventListener('pointerdown', (e) => { downAt = [e.clientX, e.clientY]; });
canvas.addEventListener('pointerup', (e) => {
  if (!downAt || editor.active) { downAt = null; return; }
  const moved = Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]);
  downAt = null;
  if (moved > 5) return; // that was an orbit drag
  const id = pick(e.clientX, e.clientY);
  if (id) setFocus(id);
});
let hoverQueued = false;
canvas.addEventListener('pointermove', (e) => {
  if (hoverQueued || e.buttons || editor.active) return;
  hoverQueued = true;
  requestAnimationFrame(() => {
    hoverQueued = false;
    document.body.classList.toggle('hovering', !!pick(e.clientX, e.clientY));
  });
});

const hud = createHud();

// --- Clock + timeline UI ------------------------------------------------------

const clock = createTimeline(scenario, {
  onKey(key, e) {
    if ((e.ctrlKey || e.metaKey) && !editor.active) return; // only the path editor (undo) uses chords
    if (key === 'Escape' && closePopovers()) return; // Esc closes an open menu or sheet first
    if (key === 'Escape' && engagePanel.active) { engagePanel.close(); return; }
    if (editor.active) { editor.onKey(key, e); return; }
    if (key === 'e' || key === 'E') { engagePanel.close(); editor.toggle(); return; }
    if (key === 'g' || key === 'G') { if (!editor.active) engagePanel.toggle(); return; }
    if (key === '?') { setKeys(keysEl.hidden); return; }
    if (key === 'Escape') setFocus('free');
    if (key === '1') setFocus('plane');
    if (key === '2' && scenario.hasMissile) setFocus('missile');
    if (key === '3') setFocus('ship');
    if (key === '4' && pair) setFocus('plane2');
    if (key === '5' && pair) setFocus('missile2');
    if (key === 'l' || key === 'L') setLabels(!labels.enabled);
    if (key === 'd' || key === 'D') setDirector(!directing);
    if (key === 's' || key === 'S') setSound(!audio.enabled);
    if (key === 'h' || key === 'H') hud.toggle();
    if (key === 'c' || key === 'C') setPanelFolded(!panelFolded);
  },
});

// Deep link (?t=, ?focus=): open paused at that moment, on that target.
const shared = readShareParams();
if (shared.t !== null) { clock.playing = false; clock.seek(shared.t); }
else {
  // After "Apply & replay" in the engagement panel: start just before the launch, playing.
  try {
    const seek = parseFloat(sessionStorage.getItem(SEEK_KEY));
    sessionStorage.removeItem(SEEK_KEY);
    if (Number.isFinite(seek)) clock.seek(Math.min(Math.max(seek, 0), scenario.tEnd));
  } catch { /* storage unavailable */ }
}
const sharedFocus = shared.focus === 'plane' || shared.focus === 'ship' || (shared.focus === 'missile' && scenario.hasMissile) ? shared.focus : null;
if (!directing) setFocus(sharedFocus ?? 'plane'); // default: open on the drone sitting on its cradle

// "Copy link": ship, mission, moment, camera focus and (if custom) the flight path.
createShare({
  button: document.querySelector('#btn-link'),
  toast,
  onChange: invalidate,
  getState: () => ({
    ship: SHIP_VARIANT,
    mode: scenario.mode,
    t: clock.t,
    focus: rig.id,
    director: directing,
    path: scenario.customPath ? scenario.activePath : null,
  }),
});

// Path editor: pauses at t = 0 and hides the labels while drawing.
let labelsBeforeEdit = true;
const editor = createPathEditor({
  scene, camera, controls, canvas, clock,
  onEnter() { engagePanel.close(); invalidate(); labelsBeforeEdit = labels.enabled; labels.setEnabled(false); setFocus('free'); },
  onExit() { invalidate(); labels.setEnabled(labelsBeforeEdit); },
});
const engagePanel = createEngagePanel({ onOpen: invalidate, onClose: invalidate });
document.querySelector('#btn-engage').addEventListener('click', () => { if (editor.active) editor.exit(); });
if (scenario.sharedPath) {
  toast('Viewing shared path — your own saved path is untouched. Edit path to make it yours.');
} else if (scenario.customPath) {
  toast(scenario.outOfArc
    ? `Custom path active — the drone is never on the ${SHIP_VARIANT === 'aft' ? 'aft' : 'forward'} launcher's side of the ship when it fires, so the missile has to cross the ship. Bring the drone in from ${SHIP_VARIANT === 'aft' ? 'astern' : 'ahead'}.`
    : scenario.interceptMiss > 15
    ? `Custom path active — the missile misses it by ${Math.round(scenario.interceptMiss)} m before the hit is forced. Bring the drone back toward the ship.`
    : 'Custom flight path active — open Edit path to change it or restore the default.');
} else if (scenario.customEngage && scenario.hasMissile) {
  toast('Custom missile engagement active — open Missile engagement (G) to change it or reset it.');
}

createRecorder({
  canvas, clock, audio, scenario, setDirector, isDirecting: () => directing, isBusy: () => editor.active,
});

// --- Loop -------------------------------------------------------------------

function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h, false);
  labels.resize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  invalidate();
  pointScale.value = (h * renderer.getPixelRatio()) / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));
}
window.addEventListener('resize', resize);
resize();

// --- Adaptive quality ----------------------------------------------------------
// Frame time is measured only between consecutive frames that were both drawn
// (idle skips would otherwise read as slow frames). The tier is decided once from
// the first ~3 s of drawing, with at most one later step down. ?quality= pins it.
const QUALITY = {
  high: { shadow: 2048, density: 1 },
  medium: { shadow: 1024, density: 1 },
  low: { shadow: 512, density: 0.5 },
};
const forcedQuality = (() => {
  try {
    const q = new URLSearchParams(location.search).get('quality');
    return q in QUALITY ? q : null;
  } catch { return null; }
})();
let quality = 'high';
function setQuality(tier) {
  quality = tier;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, PIXEL_RATIO_CAP[tier]));
  env.setShadowSize(QUALITY[tier].shadow);
  scene.traverse((o) => { if (o.isParticleField) o.setDensity(QUALITY[tier].density); });
  resize(); // pointScale depends on the pixel ratio
}
if (forcedQuality) setQuality(forcedQuality);

const perf = { stage: forcedQuality ? 'done' : 'first', samples: [], skip: 3, start: 0, wait: 0, prevNow: 0, prevDrawn: false };
const median = (a) => [...a].sort((x, y) => x - y)[a.length >> 1];
function sampleFrame(now, drawn) {
  if (perf.stage === 'done') return;
  const had = perf.prevDrawn;
  const dtMs = now - perf.prevNow;
  perf.prevDrawn = drawn;
  perf.prevNow = now;
  if (!drawn || !had) return;
  if (perf.stage === 'wait') {
    if (now >= perf.wait) { perf.stage = 'second'; perf.samples = []; perf.start = now; perf.skip = 0; }
    return;
  }
  if (perf.skip > 0) { perf.skip--; perf.start = now; return; } // shader compiles and first uploads
  if (perf.start === 0) perf.start = now;
  perf.samples.push(dtMs);
  const n = perf.samples.length;
  const m = median(perf.samples);
  const elapsed = now - perf.start;
  if (perf.stage === 'first') {
    if ((n >= 3 && m > 100) || (elapsed >= 3000 && n >= 8)) {
      setQuality(m > 30 ? 'low' : m > 22 ? 'medium' : 'high');
      perf.stage = quality === 'low' ? 'done' : 'wait';
      perf.wait = now + 5000;
      perf.prevDrawn = false;
    }
  } else if (elapsed >= 3000 && n >= 8) { // one later check: step down once if it still struggles
    if (m > 33) setQuality(quality === 'high' ? 'medium' : 'low');
    perf.stage = 'done';
  }
}

// Snapshot of what was last drawn.
const drawn = { t: NaN, rig: null, shot: null, inv: -1, mat: new Float64Array(16) };
function needsRender() {
  camera.updateMatrixWorld();
  const e = camera.matrixWorld.elements;
  let same = true;
  for (let i = 0; i < 16; i++) if (Math.abs(e[i] - drawn.mat[i]) > 1e-5) { same = false; break; }
  return !same || clock.t !== drawn.t || rig.id !== drawn.rig || currentShot !== drawn.shot
    || invalidations !== drawn.inv || editor.active;
}
function markDrawn() {
  drawn.t = clock.t; drawn.rig = rig.id; drawn.shot = currentShot; drawn.inv = invalidations;
  drawn.mat.set(camera.matrixWorld.elements);
}

const shadowCenter = new THREE.Vector3();
let last = performance.now();
renderer.setAnimationLoop((now) => {
  const dt = Math.max(0, Math.min((now - last) / 1000, 0.1));
  last = now;
  clock.tick(dt);
  applyTime(clock.t);
  // The missile ceases to exist at impact: hand the camera to the wreckage.
  const missileGone = clock.t >= scenario.tHit;
  missileButton.disabled = !scenario.hasMissile || missileGone;
  if (missileGone && rig.id === 'missile') setFocus('plane', 60); // pull back out of the fireball
  editor.update();
  updatePickables();
  if (directing) {
    const shot = director.pose(clock.t, camera.position, dirLook);
    if (shot !== currentShot) {
      currentShot = shot;
      shotCaption.textContent = shot.label;
      shotCaption.hidden = false;
      dirShadowR = shot.shadowR;
    }
    if (camera.position.y < 1) camera.position.y = 1;
    camera.lookAt(dirLook);
  } else {
    rig.update();
    controls.update();
    if (camera.position.y < 1) camera.position.y = 1; // never dip under the (single-sided) sea
  }

  const close = rig.id !== 'ship' && rig.id !== 'free' && !!targets[rig.id];
  if (directing) env.setShadowFocus(dirLook, dirShadowR);
  else env.setShadowFocus(close ? targets[rig.id].pos(shadowCenter) : targets.ship.pos(shadowCenter), close ? 25 : 75);
  audio.update(clock.t, camera, clock);

  clock.renderUI();
  hud.update(clock.t);
  const draw = needsRender();
  if (draw) {
    renderer.render(scene, camera);
    labels.render(scene, camera);
    markDrawn();
    renderCount++;
    loadingEl?.remove(); // first frame is on screen
  }
  sampleFrame(now, draw);
});

// Debug/inspection handle.
window.__scene = {
  get renderCount() { return renderCount; },
  get quality() { return quality; },
  invalidate, perf,
  scenario, clock, setFocus, camera, controls, rig, renderer, chute, director, audio, setDirector, pair,
  plane: plane.group, missile: missile.group, ship: ship.group,
};

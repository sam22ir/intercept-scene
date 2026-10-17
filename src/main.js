import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  scenario, planePos, planePose, planeVel, propAngle, propSpin01, missilePose, shipPos, tubeMouth, SHIP_SPEED,
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

const canvas = document.querySelector('#scene');
const loadingEl = document.querySelector('#loading');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
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

// Floating tags + missile path; the on/off choice is remembered per viewer.
const labels = createLabels(scene);
const labelsButton = document.querySelector('#btn-labels');
function setLabels(on) {
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
  ship.update(t, tLaunch);

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
  });

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

// Invisible pick volumes. Drone and missile spheres grow with camera distance
// so they stay clickable when they are only a few pixels across; the ship's
// boxes ride along inside its group.
const pickMat = new THREE.MeshBasicMaterial({ visible: false });
const pickables = [...ship.picks];
for (const id of ['plane', 'missile']) {
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
    .filter((h) => h.object.userData.focus !== 'missile' || missile.group.visible);
  // Small moving objects win over the ship they overlap.
  const small = hits.find((h) => h.object.userData.focus !== 'ship');
  return (small ?? hits[0])?.object.userData.focus ?? null;
}

const rig = new CameraRig(camera, controls);
const focusButtons = document.querySelectorAll('[data-focus]');
function setFocus(id, distance) {
  if (directing) setDirector(false); // any manual camera choice ends the Director
  if (id === 'free' || !targets[id]) rig.free();
  else rig.focus(id, targets[id].pos, distance ?? targets[id].distance, targets[id].minDistance);
  focusButtons.forEach((b) => b.classList.toggle('active', b.dataset.focus === rig.id));
}
focusButtons.forEach((b) => b.addEventListener('click', () => setFocus(b.dataset.focus)));
const missileButton = document.querySelector('[data-focus="missile"]');
document.querySelector('#btn-ship').addEventListener('click', () => {
  try { sessionStorage.setItem('intercept.chooser', '1'); location.reload(); } catch { location.search = ''; }
});

// --- Director: cinematic cuts ---------------------------------------------------
// While on, the Director places the camera every frame (OrbitControls and the
// focus rig are bypassed). Any manual camera input hands control back.

const fuselagePiece = debris?.pieces.find((p) => p.part.name === 'fuselage');
const director = createDirector({
  dronePos: dronePosAt,
  tWater: debris ? scenario.tHit + fuselagePiece.tauWater : scenario.tSplash,
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
});
const soundButton = document.querySelector('#btn-sound');
function setSound(on) {
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

// --- Clock + timeline UI ------------------------------------------------------

const clock = createTimeline(scenario, {
  onKey(key, e) {
    if (editor.active) { editor.onKey(key, e); return; }
    if (key === 'e' || key === 'E') { editor.toggle(); return; }
    if (key === 'Escape') setFocus('free');
    if (key === '1') setFocus('plane');
    if (key === '2' && scenario.hasMissile) setFocus('missile');
    if (key === '3') setFocus('ship');
    if (key === 'l' || key === 'L') setLabels(!labels.enabled);
    if (key === 'd' || key === 'D') setDirector(!directing);
    if (key === 's' || key === 'S') setSound(!audio.enabled);
  },
});

if (!directing) setFocus('plane'); // open on the drone sitting on its cradle

// Path editor: pauses at t = 0 and hides the labels while drawing.
let labelsBeforeEdit = true;
const editor = createPathEditor({
  scene, camera, controls, canvas, clock,
  onEnter() { labelsBeforeEdit = labels.enabled; labels.setEnabled(false); setFocus('free'); },
  onExit() { labels.setEnabled(labelsBeforeEdit); },
});
if (scenario.customPath) {
  toast(scenario.interceptMiss > 15
    ? `Custom path active — the missile misses it by ${Math.round(scenario.interceptMiss)} m before the hit is forced. Bring the drone back toward the ship.`
    : 'Custom flight path active — open Edit path to change it or restore the default.');
}

const tm = {
  alt: document.querySelector('#tm-alt'),
  speed: document.querySelector('#tm-speed'),
  mspeed: document.querySelector('#tm-mspeed'),
  range: document.querySelector('#tm-range'),
};
function renderTelemetry() {
  const destroyed = clock.t >= scenario.tHit;
  tm.alt.textContent = `${Math.max(0, telemetry.planeAlt).toFixed(0)} m`;
  tm.speed.textContent = destroyed ? 'destroyed' : `${(telemetry.planeSpeed * 3.6).toFixed(0)} km/h`;
  tm.mspeed.textContent = telemetry.missileSpeed == null ? '—' : `${(telemetry.missileSpeed * 3.6).toFixed(0)} km/h`;
  tm.range.textContent = telemetry.range == null ? '—' : `${telemetry.range.toFixed(0)} m`;
}

// --- Loop -------------------------------------------------------------------

function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h, false);
  labels.resize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  pointScale.value = (h * renderer.getPixelRatio()) / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));
}
window.addEventListener('resize', resize);
resize();

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

  const close = rig.id === 'plane' || rig.id === 'missile';
  if (directing) env.setShadowFocus(dirLook, dirShadowR);
  else env.setShadowFocus(close ? targets[rig.id].pos(shadowCenter) : targets.ship.pos(shadowCenter), close ? 25 : 75);
  audio.update(clock.t, camera, clock.playing);

  clock.renderUI();
  renderTelemetry();
  renderer.render(scene, camera);
  labels.render(scene, camera);
  loadingEl?.remove(); // first frame is on screen
});

// Debug/inspection handle.
window.__scene = {
  scenario, clock, setFocus, camera, controls, rig, renderer, chute, director, audio, setDirector,
  plane: plane.group, missile: missile.group, ship: ship.group,
};

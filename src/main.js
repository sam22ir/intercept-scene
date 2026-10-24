import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  scenario, planePos, planePose, planeVel, propAngle, propSpin01, missilePose, shipPos, tubeMouth, SHIP_SPEED, SHIP_VARIANT,
} from './scenario.js';
import { createLabels } from './labels.js';
import { createTrails } from './trails.js';
import { createMinimap } from './minimap.js';
import { createParachute } from './models/parachute.js';
import { createPathEditor, toast } from './pathEditor.js';
import { createEnvironment } from './environment.js';
import { lookFor } from './looks.js';
import { createShipFx } from './fx/shipFx.js';
import { wireWeather } from './weatherButton.js';
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
import { menuText } from './menu.js';
import { createRecorder } from './recorder.js';
import { createShare, readShareParams, stripShareParams } from './share.js';
import { createEngagePanel, SEEK_KEY } from './engagePanel.js';
import { createVTrack, createCamStrip } from './vtrack.js';
import './helm.css';
import './layout-v.css';

// The drill's look and layout (body.mission-maneuvers in style.css: the vertical timeline, the camera strip, the
// compact playback panel, the slim readout cards and the map at the bottom right), as the formations mission
// wears it too; layout-v.css puts back what the drill hides and styles the drone's own cards.
document.body.classList.add('mission-maneuvers', 'mission-drone');

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

const env = createEnvironment(renderer, scene, { look: lookFor(scenario.mode) });

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
wireWeather({ look: env.look, getTime: () => clock.t });
const shipFx = createShipFx(scene, { tEnd: scenario.tEnd, sea: env.look?.sea.state ?? 1 });

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

// Trajectory trails: ship track, drone path and missile path, in their own colours.
const trails = createTrails(scene);
const trailsButton = document.querySelector('#btn-trails');
function setTrails(on) {
  invalidate();
  trails.setEnabled(on);
  trailsButton.classList.toggle('active', on);
  trailsButton.setAttribute('aria-pressed', String(on));
  try { localStorage.setItem('intercept.trails', on ? '1' : '0'); } catch { /* storage unavailable */ }
}
let trailsPref = true;
try { trailsPref = localStorage.getItem('intercept.trails') !== '0'; } catch { /* storage unavailable */ }
setTrails(trailsPref);
trailsButton.addEventListener('click', () => setTrails(!trails.enabled));
// Mini map: a small round radar, bow up, of the ship, drones and missiles.
const minimap = createMinimap({ dronePosAt: (t, out) => dronePosAt(t, out) });
const mapButton = document.querySelector('#btn-map');
function setMap(on) {
  invalidate();
  minimap.setEnabled(on);
  mapButton.classList.toggle('active', on);
  mapButton.setAttribute('aria-pressed', String(on));
  try { localStorage.setItem('intercept.map', on ? '1' : '0'); } catch { /* storage unavailable */ }
}
let mapPref = true;
try { mapPref = localStorage.getItem('intercept.map') !== '0'; } catch { /* storage unavailable */ }
setMap(mapPref);
mapButton.addEventListener('click', () => setMap(!minimap.enabled));
minimap.update(0);

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

  trails.update(t);
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
  shipFx.update(t);
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
});
const directorButton = document.querySelector('#btn-director');
const shotCaption = document.querySelector('#shot-caption');
let directing = false;
let currentShot = null;
const dirLook = new THREE.Vector3();
const _dirTmp = new THREE.Vector3();
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
    // Hand the view to OrbitControls without a jump: keep the camera where it is and put the orbit target
    // along the line it looks down, so the first drag turns the view from exactly where the shot left it. Only
    // a shot that looks up (which the polar limit forbids) is levelled; the target never goes under the sea.
    let dist = Math.max(camera.position.distanceTo(dirLook), 5);
    const dir = camera.getWorldDirection(_dirTmp);
    if (dir.y > 0) dir.setY(0).normalize();
    else if (dir.y < -1e-3) dist = Math.max(Math.min(dist, camera.position.y / -dir.y), 2);
    controls.target.copy(camera.position).addScaledVector(dir, dist);
    controls.update();
    focusButtons.forEach((b) => b.classList.toggle('active', b.dataset.focus === 'free'));
  }
}
directorButton.addEventListener('click', () => { if (!directing && editor.active) return; setDirector(!directing); });
canvas.addEventListener('pointerdown', () => { if (directing) setFocus('free'); }, true);
canvas.addEventListener('wheel', () => { if (directing) setFocus('free'); }, { passive: true, capture: true });

// --- Sound ----------------------------------------------------------------------

const audio = createAudio({
  dronePos: dronePosAt,
  splashTimes: debris ? debris.pieces.map((p) => scenario.tHit + p.tauWater) : [scenario.tSplash],
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

{
  // The top bar's title and subtitle come from the same words as the start screen (menu.js).
  const t = menuText(scenario.mode, SHIP_VARIANT);
  document.querySelector('.brand b').textContent = t.brand;
  document.querySelector('#mission-sub').textContent = t.sub;
}

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

const hud = createHud({ onUnits: (u) => { labels.setUnits(u); invalidate(); }, missionSub: menuText(scenario.mode, SHIP_VARIANT).sub });

// --- Clock + timeline UI ------------------------------------------------------

const clock = createTimeline(scenario, {
  onKey(key, e) {
    if ((e.ctrlKey || e.metaKey) && !editor.active) return; // only the path editor (undo) uses chords
    if (key === 'Escape' && closePopovers()) return; // Esc closes an open menu or sheet first
    if (key === 'Escape' && engagePanel.active) { engagePanel.close(); return; }
    if (editor.active) { editor.onKey(key, e); return; }
    if (key === 'e' || key === 'E') { engagePanel.close(); editor.toggle(); return; }
    if (key === ',') { clock.prevEvent(); return; }
    if (key === '.') { clock.nextEvent(); return; }
    if (key === '[') { clock.slower(); return; }
    if (key === ']') { clock.faster(); return; }
    if (key === 'g' || key === 'G') { if (!editor.active) engagePanel.toggle(); return; }
    if (key === '?') { setKeys(keysEl.hidden); return; }
    if (key === 'Escape') setFocus('free');
    if (key === '1') setFocus('plane');
    if (key === '2' && scenario.hasMissile) setFocus('missile');
    if (key === '3') setFocus('ship');
    if (key === 'l' || key === 'L') setLabels(!labels.enabled);
    if (key === 't' || key === 'T') setTrails(!trails.enabled);
    if (key === 'm' || key === 'M') setMap(!minimap.enabled);
    if (key === 'd' || key === 'D') setDirector(!directing);
    if (key === 's' || key === 'S') setSound(!audio.enabled);
    if (key === 'h' || key === 'H') hud.toggle();
    if (key === 'u' || key === 'U') hud.toggleUnits();
    if (key === 'c' || key === 'C') setPanelFolded(!panelFolded);
  },
});

// The timeline stands on end down the left on wide windows, and the camera buttons move to the top strip.
const vtrack = createVTrack({ events: scenario.events, tEnd: scenario.tEnd, clock, invalidate, fmt: (t) => `${t.toFixed(1)} s` });
createCamStrip({ invalidate });
// The cards hang just under the top bar, whatever its height is at this window width (as in the drill).
if (typeof ResizeObserver === 'function') {
  const topbar = document.querySelector('#topbar');
  // Set on the next frame, never inside the callback (that would be a "ResizeObserver loop", shown as fatal).
  new ResizeObserver(() => requestAnimationFrame(() => {
    document.documentElement.style.setProperty('--bar-h', `${topbar.offsetHeight}px`);
    document.documentElement.style.setProperty('--bar-w', `${topbar.offsetWidth}px`);
  })).observe(topbar);
}

// Deep link (?t=, ?focus=): open paused at that moment, on that target.
const shared = readShareParams();
if (shared.t !== null) { clock.playing = false; clock.seek(shared.t); }
else {
  // After "Apply & replay" in the engagement panel: start just before the launch, playing.
  try {
    const seek = parseFloat(sessionStorage.getItem(SEEK_KEY));
    sessionStorage.removeItem(SEEK_KEY);
    if (Number.isFinite(seek)) { clock.seek(Math.min(Math.max(seek, 0), scenario.tEnd)); clock.playing = true; }
  } catch { /* storage unavailable */ }
}
const sharedFocus = shared.focus === 'plane' || shared.focus === 'ship' || (shared.focus === 'missile' && scenario.hasMissile) ? shared.focus : null;
// The default view is the cinematic camera (the Director). A shared link opens on its own
// camera: the one it names (?focus=, ?cam=free) or the cinematic cuts (?cam=director).
if (shared.director || (!sharedFocus && !shared.free)) setDirector(true);
else setFocus(sharedFocus ?? 'free');

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
    extra: env.look ? { weather: env.look.weather } : undefined, // the same sky and sea for whoever opens the link
  }),
});

// Path editor: pauses at t = 0 and hides the labels while drawing.
let labelsBeforeEdit = true;
let trailsBeforeEdit = true;
const editor = createPathEditor({
  scene, camera, controls, canvas, clock,
  onEnter() { engagePanel.close(); invalidate(); labelsBeforeEdit = labels.enabled; labels.setEnabled(false); trailsBeforeEdit = trails.enabled; trails.setEnabled(false); setFocus('free'); },
  onExit() { invalidate(); labels.setEnabled(labelsBeforeEdit); trails.setEnabled(trailsBeforeEdit); },
});
// While the engagement panel is open it takes the vertical timeline's place on the left (body.engaging hides that).
const engagePanel = createEngagePanel({
  onOpen() { document.body.classList.add('engaging'); invalidate(); },
  onClose() { document.body.classList.remove('engaging'); invalidate(); },
});
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
  trails.resize(w, h);
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
  vtrack.update(clock.t);
  hud.update(clock.t, rig.id);
  minimap.update(clock.t);
  updateWatchBadges(clock.t);
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

// --- The look of Solo Air Defense, for the watch missions: a gear menu, icons on the camera strip with a keys button, round badges for the
// drone, the missile and the ship at the foot. (Styles: helm.css, layout-v.css, scoped to body.mission-drone.) --------------------------------
const watchBadges = document.createElement('div');
{
  const MOTION = !globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const DRONE = '<path class="hb-fill" d="M12 3.4c.9 1.2 1.2 3 1.2 5.2l.2 7.6-1.4 3-1.4-3 .2-7.6c0-2.2.3-4 1.2-5.2z"/><path d="M12 9.4L2.6 12.2l.6 2L12 12.8l8.8 1.4.6-2z"/><path d="M12 18l-4.2 1.2.4 1.6 3.8-.6 3.8.6.4-1.6z"/>';
  const MISSILE = '<path class="hb-fill" d="M12 2.5c1.7 1.7 2.1 4.2 2.1 6.8v7.2H9.9V9.3c0-2.6.4-5.1 2.1-6.8z"/><path class="hb-flame" d="M10.7 17.2h2.6L12 21.6z"/><path d="M9.9 13l-2.6 3.8h2.6M14.1 13l2.6 3.8h-2.6"/>';
  const FRIGATE = '<g class="hb-bob"><path class="hb-fill" d="M2 15h18.2l3-1.6-2.1 5.6H4.6z"/><path d="M8.6 15l1.5-4h6l2.2 4"/><path d="M11.6 11l.9-2.6h3.3l.8 2.6"/><path d="M14.3 8.4V3.6M13 5.2h2.6"/><circle cx="7.4" cy="13.1" r="1.4"/><path d="M18.4 14.9v-1.3h1.5v1.3M19.9 14.2h2"/><path d="M2.6 14.1h3.4"/></g><path class="hb-wave" d="M1 21.4q2-1.3 4 0t4 0 4 0 4 0 4 0 4 0"/>';
  const CAM = {
    free: '<g transform="rotate(-25 12 12)"><ellipse cx="12" cy="12" rx="9.5" ry="4.6"/>' + (MOTION ? '<circle r="1.7" style="fill:currentColor"><animateMotion dur="3.2s" repeatCount="indefinite" path="M21.5 12a9.5 4.6 0 1 1 -19 0a9.5 4.6 0 1 1 19 0"/></circle>' : '<circle cx="21.5" cy="12" r="1.7" style="fill:currentColor"/>') + '</g><circle cx="12" cy="12" r="1.3" style="fill:currentColor"/>',
    plane: '<g transform="rotate(90 12 12) scale(.8) translate(3 3)">' + DRONE + '</g><g class="lines"><path d="M2 8h4M1 12h5M2 16h4"/></g>',
    missile: '<path d="M3 19C7 6 15 3.5 20 8"/><path d="M16 4.8l4.4 3.4-4.8 2.4"/><circle cx="3.5" cy="18.5" r="1.4" style="fill:currentColor;stroke:none"/><g class="lines"><path d="M8 20.5h4M13 20.5h3"/></g>',
    ship: '<path class="hb-fill" d="M2 15h18.2l3-1.6-2.1 5.6H4.6z"/><path d="M8.6 15l1.5-4h6l2.2 4M14.3 11V5.6"/><path d="M1 21.4q2-1.3 4 0t4 0 4 0 4 0 4 0"/>',
  };
  CAM.plane2 = CAM.plane; CAM.missile2 = CAM.missile;
  for (const b of document.querySelectorAll('.seg.cam [data-focus]')) {
    const label = b.textContent.trim();
    b.classList.add('cs-btn');
    b.setAttribute('aria-label', label);
    b.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true">' + (CAM[b.dataset.focus] ?? CAM.free) + '</svg><span>' + label + '</span>';
  }
  { // the keys button at the end of the camera strip
    const kb = document.createElement('button');
    kb.type = 'button';
    kb.className = 'cs-btn cs-keys';
    kb.title = 'Keyboard shortcuts (?)';
    kb.setAttribute('aria-label', 'Keyboard shortcuts');
    kb.innerHTML = '<svg viewBox="0 0 24 24"><rect x="2.5" y="6" width="19" height="12" rx="2.5"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/></svg>';
    document.querySelector('.seg.cam').appendChild(kb);
    kb.addEventListener('click', () => { setKeys(keysEl.hidden); kb.blur(); });
  }

  { // the gear
    menuButton.innerHTML = '<svg><use href="#i-gear"/></svg>';
    menuButton.title = 'Settings';
    menuButton.setAttribute('aria-label', 'Settings');
    const MI = {
      menu: '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>',
      cine: '<rect x="3" y="7" width="13" height="10" rx="2"/><path d="M16 11l5-3v8l-5-3"/>',
      tags: '<path d="M3.5 12.2V4.5h7.7l9 9a1.6 1.6 0 0 1 0 2.2l-5 5a1.6 1.6 0 0 1-2.2 0z"/><circle cx="8" cy="9" r="1.3"/>',
      trails: '<path d="M3 19C7 6 15 3.5 20 8"/><path d="M16 4.8l4.4 3.4-4.8 2.4"/><circle cx="3.5" cy="18.5" r="1.4" style="fill:currentColor;stroke:none"/>',
      readouts: '<rect x="3.5" y="4.5" width="17" height="12" rx="2"/><path d="M7 13l3-3.2 2.4 2 3.6-4.3M9 20h6M12 16.5V20"/>',
      map: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4"/><path class="mi-a" d="M12 12l5.5-5"/>',
      sound: '<path d="M4 9.5h3.5L12 6v12l-4.5-3.5H4z"/><path class="mi-w1" d="M15.5 9.2a4 4 0 0 1 0 5.6"/><path class="mi-w2" d="M18.2 6.8a7.5 7.5 0 0 1 0 10.4"/>',
      units: '<path d="M4 17a8 8 0 1 1 16 0"/><path d="M12 17l4-5"/>',
      edit: '<path d="M4 20l1-4 11-11 3 3L8 19z"/><path d="M14 7l3 3"/>',
      engage: '<circle cx="12" cy="12" r="7"/><path d="M12 2.5v4M12 17.5v4M2.5 12h4M17.5 12h4"/>',
      rec: '<circle cx="12" cy="12" r="7.5"/><circle cx="12" cy="12" r="3" style="fill:currentColor"/>',
      link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
      hide: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/><path class="mi-a" d="M4 4l16 16"/>',
      keys: '<rect x="2.5" y="6" width="19" height="12" rx="2.5"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7.5 14h9"/>',
      dl: '<path d="M12 4v11M7.5 11L12 15.5 16.5 11M5 20h14"/>',
    };
    const q = (id) => document.querySelector(id);
    const item = (b, label, key, ic) => { b.className = 'mi-item'; b.setAttribute('role', 'menuitem'); b.innerHTML = '<span class="mi-l"><svg class="mi" viewBox="0 0 24 24" aria-hidden="true">' + MI[ic] + '</svg>' + label + '</span>' + (key ? '<kbd>' + key + '</kbd>' : ''); return b; };
    const head = (t) => { const h = document.createElement('div'); h.className = 'menu-h'; h.textContent = t; return h; };
    const keep = (el) => el;
    const link = q('#dl-offline');
    if (link) { link.className = 'mi-item'; link.innerHTML = '<span class="mi-l"><svg class="mi" viewBox="0 0 24 24" aria-hidden="true">' + MI.dl + '</svg>Download offline version</span>'; }
    const shipBtn = q('#btn-ship'), keysBtn = q('#btn-keys');
    item(shipBtn, 'Main menu', '', 'menu');
    item(q('#btn-director'), 'Cinematic camera', 'D', 'cine');
    item(q('#btn-labels'), 'Tags and missile path', 'L', 'tags');
    item(q('#btn-trails'), 'Trajectories', 'T', 'trails');
    item(q('#btn-hud'), 'Readouts', 'H', 'readouts');
    item(q('#btn-map'), 'Mini map', 'M', 'map');
    item(q('#btn-sound'), 'Sound', 'S', 'sound');
    item(q('#btn-units'), 'Speeds in knots', 'U', 'units');
    item(q('#btn-edit'), 'Edit flight path', 'E', 'edit');
    item(q('#btn-engage'), 'Missile engagement', 'G', 'engage');
    item(q('#btn-record'), 'Record', '', 'rec');
    item(q('#btn-link'), 'Copy link to this moment', '', 'link');
    item(foldButton, 'Hide the interface', 'C', 'hide');
    item(keysBtn, 'Keyboard shortcuts', '?', 'keys');
    menuEl.replaceChildren(head('Mission'), shipBtn, head('Camera'), q('#btn-director'), q('#btn-labels'), q('#btn-trails'),
      head('Display'), q('#btn-hud'), q('#btn-map'), q('#btn-units'), foldButton,
      head('Sound'), q('#btn-sound'), head('Sea'), ...[q('#sea-row'), q('#btn-weather')].filter(keep),
      head('Tools'), q('#btn-edit'), q('#btn-engage'), q('#btn-record'), q('#btn-link'), head('Help'), keysBtn, ...[link].filter(keep));
  }

  // The badges: drone altitude and speed, the missile, the frigate's range.
  watchBadges.className = 'watch-badges';
  document.body.appendChild(watchBadges);
}
const WB_RING = 2 * Math.PI * 20;
const wbIcon = {
  alt: '<path class="hb-fill" d="M2 20.5l6.2-9.5 4 5.2 3-4 6.8 8.3z"/><g class="hb-lift"><path d="M12 8.2V2.6M9.4 5L12 2.4 14.6 5"/></g>',
  speed: '<path d="M3.2 17.5a8.8 8.8 0 1 1 17.6 0"/><path d="M5.6 17.5h1.6M16.8 17.5h1.6M12 8.7v1.6M6.2 11.2l1.1 1.1M17.8 11.2l-1.1 1.1"/><g class="hb-needle"><path d="M12 17.5l4.2-5.6"/></g><circle cx="12" cy="17.5" r="1.5" style="fill:currentColor;stroke:none"/>',
  missile: '<path class="hb-fill" d="M12 2.5c1.7 1.7 2.1 4.2 2.1 6.8v7.2H9.9V9.3c0-2.6.4-5.1 2.1-6.8z"/><path class="hb-flame" d="M10.7 17.2h2.6L12 21.6z"/><path d="M9.9 13l-2.6 3.8h2.6M14.1 13l2.6 3.8h-2.6"/>',
  ship: '<g class="hb-bob"><path class="hb-fill" d="M2 15h18.2l3-1.6-2.1 5.6H4.6z"/><path d="M8.6 15l1.5-4h6l2.2 4"/><path d="M11.6 11l.9-2.6h3.3l.8 2.6"/><path d="M14.3 8.4V3.6M13 5.2h2.6"/><circle cx="7.4" cy="13.1" r="1.4"/><path d="M18.4 14.9v-1.3h1.5v1.3M19.9 14.2h2"/><path d="M2.6 14.1h3.4"/></g><path class="hb-wave" d="M1 21.4q2-1.3 4 0t4 0 4 0 4 0 4 0 4 0"/>',
};
function wbBadge(cls, icon, frac, title, sub, chip) {
  const fr = Math.max(0, Math.min(1, frac));
  return '<div class="hs-badge ' + cls + '"><svg class="hb-ring" viewBox="0 0 46 46" aria-hidden="true"><circle class="hb-bg" cx="23" cy="23" r="20"/><circle class="hb-fg" cx="23" cy="23" r="20" style="stroke-dasharray:' + (WB_RING * fr).toFixed(1) + ' 126"/></svg>'
    + '<span class="hb-ico"><svg viewBox="0 0 24 24">' + icon + '</svg></span>' + (chip === '' ? '' : '<i class="hb-chip">' + chip + '</i>') + '<span class="hb-tip"><b>' + title + '</b><small>' + sub + '</small></span></div>';
}
let lastWb = '';
const _wb = new THREE.Vector3();
function updateWatchBadges(t) {
  const { tHit } = scenario;
  const down = t >= tHit;
  const alt = Math.max(0, telemetry.planeAlt);
  const spd = telemetry.planeSpeed;
  const pos = t < tHit ? plane.group.position : dronePosAt(t, _wb);
  const rng = pos.distanceTo(ship.group.position);
  const ms = telemetry.missileSpeed;
  let html = wbBadge('hb-alt' + (down ? ' out' : alt < 15 ? ' low' : ''), wbIcon.alt, alt / 200, 'Drone altitude', Math.round(alt) + ' m' + (down ? ' · wreck' : ''), String(Math.round(alt)))
    + wbBadge('hb-spd' + (down ? ' out' : ''), wbIcon.speed, spd / 110, 'Drone speed', Math.round(spd) + ' m/s · ' + Math.round(spd * 3.6) + ' km/h', String(Math.round(spd)));
  if (scenario.mode !== 'chute') {
    html += wbBadge('hb-msl ' + (ms === null || ms === undefined ? (t > tHit ? 'out' : 'ok') : 'arm'), wbIcon.missile, ms ? ms / 400 : 0, 'Missile', ms ? Math.round(ms) + ' m/s · ' + Math.round(telemetry.range ?? 0) + ' m to the drone' : (t > tHit ? 'spent' : 'waiting in its tube'), ms ? String(Math.round(ms)) : '');
  }
  html += wbBadge('hb-hull', wbIcon.ship, 1 - rng / 2500, 'Frigate', Math.round(rng) + ' m from the drone', rng >= 1000 ? (rng / 1000).toFixed(1) : String(Math.round(rng)));
  if (html !== lastWb) { watchBadges.innerHTML = html; lastWb = html; }
}

// Debug/inspection handle.
window.__scene = {
  get renderCount() { return renderCount; },
  get quality() { return quality; },
  invalidate, perf,
  scenario, clock, setFocus, camera, controls, rig, renderer, chute, director, audio, setDirector,
  plane: plane.group, missile: missile.group, ship: ship.group,
};

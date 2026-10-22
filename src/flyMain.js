import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { scenario, shipPos, RAIL, SHIP_SPEED } from './scenario.js';
import { ShipPlume } from './fx/shipFx.js';
import { islandLayout } from './terrain.js';
import { wireWeather } from './weatherButton.js';
import { createEnvironment } from './environment.js';
import { createShip } from './models/ship.js';
import { createPlane } from './models/plane.js';
import { createMissile } from './models/missile.js';
import { createParachute } from './models/parachute.js';
import { createDebris } from './fx/effects.js';
import { createLiveFx } from './fx/liveFx.js';
import { pointScale } from './fx/particles.js';
import { CameraRig } from './cameraRig.js';
import { createFlyMap } from './flyMap.js';
import { createFlyAudio } from './flyAudio.js';
import { menuText } from './menu.js';
import {
  FlySim, T_SPOOL, T_RELEASE, BOOST_TIME, DEFAULT_SPEED, MISSILE_RANGE,
} from './fly.js';

// Entry point of "Fly the drone" (see fly.js for the model). Unlike the other missions nothing here is a
// pure function of a clock: the pilot's keys drive a real-time simulation, and this file draws it. start.js
// imports it instead of main.js when that mission is picked.

const canvas = document.querySelector('#scene');
const loadingEl = document.querySelector('#loading');
document.body.classList.add('mission-fly');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.75;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, 1, 0.3, 30000); // keep the field of view at 50: pointScale is set in resize()
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.maxDistance = 6000;
controls.maxPolarAngle = Math.PI * 0.495;
controls.enabled = false; // only the orbit view uses it
const rig = new CameraRig(camera, controls);

const env = createEnvironment(renderer, scene, { look: 'fly' });
env.setShadowSize(1024);
const ship = createShip();
scene.add(ship.group);
const plane = createPlane();
scene.add(plane.group);
const missile = createMissile();
missile.group.visible = false;
scene.add(missile.group);
const chute = createParachute();
scene.add(chute.group);
const fx = createLiveFx(scene);
const plume = new ShipPlume(fx);
wireWeather({ look: env.look });
const SHIP_VEL = { x: SHIP_SPEED, z: 0 };
const audio = createFlyAudio();

// The cruise speed is remembered (default 75 m/s).
const SPEED_KEY = 'intercept.fly.speed';
let savedSpeed = DEFAULT_SPEED;
try { savedSpeed = Number(localStorage.getItem(SPEED_KEY)) || DEFAULT_SPEED; } catch { /* storage unavailable */ }
const sim = new FlySim({ speed: savedSpeed, islands: env.look?.scenery.islands ? islandLayout(env.look.scenery.islands) : [] });
sim.setSpeed(savedSpeed);
// The recovery scenario this mission borrows would open the parachute at its own scripted time: not before
// the pilot cuts the engine.
scenario.tChute = Infinity;
scenario.tSplash = Infinity;

// --- State on the screen ---------------------------------------------------------------------------------------------
let debris = null; // the wreck, once the drone is hit or crashes
let hudOn = true;
let view = 'chase'; // chase | orbit | tower
const VIEWS = ['chase', 'orbit', 'tower'];
const VIEW_NAMES = { chase: 'Chase camera', orbit: 'Orbit camera (drag to look round)', tower: 'Tower camera' };

const input = { left: 0, right: 0, up: 0, down: 0 };

// --- The banner: short messages from the model ----------------------------------------------------------------
const banner = document.querySelector('#shot-caption');
banner.classList.add('call');
let bannerUntil = 0;
function say(text, tone = '', ms = 2600) {
  banner.textContent = text;
  banner.hidden = false;
  banner.classList.remove('standby', 'execute', 'station', 'danger');
  const cls = { ok: 'execute', warn: 'standby', bad: 'danger' }[tone];
  if (cls) banner.classList.add(cls);
  bannerUntil = performance.now() + ms;
}

// --- Events from the model ---------------------------------------------------------------------------------------------
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _q = new THREE.Quaternion();
const ZAXIS = new THREE.Vector3(0, 0, 1);

function startWreck() {
  const w = sim.wreck;
  plane.restoreParts();
  debris = createDebris(plane, 0, w);
  fx.startWreck(debris, w.t);
  // The heavy fuselage's splash, when it reaches the water.
  for (const pc of debris.pieces) {
    if (pc.part.name !== 'fuselage') continue;
    debris.piecePos(pc, pc.tauWater, _a);
    audio.later('splash', _a, pc.tauWater);
  }
  chute.group.visible = false;
  scenario.tChute = Infinity;
}

function handleEvents() {
  for (const e of sim.takeEvents()) {
    audio.event(e, sim);
    switch (e.type) {
      case 'say': say(e.text, e.tone); break;
      case 'chute':
        scenario.tChute = e.t; // the parachute model reads these two
        scenario.tSplash = sim.tSplash;
        fx.chutePop(sim.pos, sim.t);
        break;
      case 'splashdown': fx.splashAt(e.pos, sim.t, 1); break;
      case 'fire': fx.launchBillow(e.pos, e.dir, sim.t); break;
      case 'explosion':
        fx.explosion(e.pos, sim.t);
        startWreck();
        break;
      case 'crash':
        if (e.kind === 'ship' || e.kind === 'land') fx.explosion(e.pos, sim.t); else fx.splashAt(e.pos, sim.t, 2.4);
        startWreck();
        break;
      case 'missile-lost':
        if (e.pos.y < 8) fx.splashAt(e.pos, sim.t, 1.2);
        break;
      default: break;
    }
  }
}

// --- Drawing the simulation --------------------------------------------------------------------------------------------
let exhaustT = 0;
let trailLast = null;
let trailT = 0;

function applyState(dt) {
  const t = sim.t;
  shipPos(t, ship.group.position);
  ship.group.updateMatrixWorld(true);
  plume.update(t, ship.group, SHIP_VEL, env.look?.sea.state ?? 1);
  ship.update(t, sim.shots[0]?.tFire ?? Infinity, sim.shots[1]?.tFire ?? Infinity, {
    aim: sim.launcher, cradleT: sim.cradleT,
  });
  const ou = env.ocean.material.uniforms;
  ou.uTime.value = t;
  ou.uShipX.value = ship.group.position.x;

  const wrecked = sim.phase === 'crashed' || sim.phase === 'destroyed';
  if (wrecked && debris) {
    debris.apply(t - sim.wreck.t);
  } else {
    plane.group.position.copy(sim.pos);
    plane.group.quaternion.copy(sim.quat);
    plane.setProp(sim.prop, sim.spin);
    plane.setLights(t, true);
    plane.setBooster(sim.cradleT, T_SPOOL, T_RELEASE + BOOST_TIME);
    chute.update(t, plane.group.position, plane.group.quaternion);
  }

  // The booster's plume (and the blast across the deck plate while it is still on the rail).
  const burn = sim.cradleT - T_SPOOL; // s since ignition (0 before the catapult fires)
  if (sim.tLaunch !== null && burn >= 0 && burn < T_RELEASE - T_SPOOL + BOOST_TIME && !wrecked) {
    plane.group.updateMatrixWorld(true);
    _a.set(0, -0.3, -1.7).applyQuaternion(sim.quat).add(sim.pos); // nozzle
    _b.set(0, 0, 1).applyQuaternion(sim.quat); // nose direction
    const total = T_RELEASE - T_SPOOL + BOOST_TIME;
    const ramp = Math.min(1, burn / 0.15) * Math.min(1, (total - burn) / 0.5);
    fx.boosterPlume(_a, _b, sim.vel, t, dt, ramp);
    if (burn < T_RELEASE - T_SPOOL + 0.3) fx.deckBlast(_a, _b, t, dt);
  }
  // Faint exhaust haze behind the drone while the engine runs.
  if (sim.phase === 'flight') {
    exhaustT += dt;
    while (exhaustT >= 0.06) {
      exhaustT -= 0.06;
      fx.exhaust(sim.pos, t);
    }
  }

  // The missile and its smoke trail (one puff every few metres).
  const m = sim.missile;
  missile.group.visible = !!m;
  if (m) {
    missile.group.position.copy(m.pos);
    missile.group.quaternion.copy(_q.setFromUnitVectors(ZAXIS, m.dir));
    missile.setExhaust(t);
    if (!trailLast) trailLast = m.pos.clone();
    trailT += dt;
    const gap = trailLast.distanceTo(m.pos);
    const n = Math.min(60, Math.floor(gap / 2.5));
    for (let i = 1; i <= n; i++) fx.missileTrail(_c.lerpVectors(trailLast, m.pos, i / n), t);
    if (n > 0) trailLast.copy(m.pos);
  } else {
    trailLast = null;
  }
}

// --- Camera ------------------------------------------------------------------------------------------------------------
let camAlpha = 0; // the chase camera's heading, smoothed toward the drone's
let snapCam = true;
const lookAt = new THREE.Vector3();
const focus = new THREE.Vector3();
const wrapPi = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const droneFocus = (out) => {
  if (debris && (sim.phase === 'crashed' || sim.phase === 'destroyed')) {
    debris.fuselagePos(sim.t - sim.wreck.t, out);
    out.y = Math.max(out.y, 0.5);
    return out;
  }
  return out.copy(sim.pos);
};

function updateCamera(dt) {
  droneFocus(focus);
  const wrecked = sim.phase === 'crashed' || sim.phase === 'destroyed';
  if (view === 'orbit') {
    rig.update();
    controls.update();
    if (camera.position.y < 1) camera.position.y = 1;
    return;
  }
  if (view === 'tower') {
    camera.position.copy(ship.group.position).add(_a.set(8, 46, 0));
    lookAt.copy(focus);
    camera.lookAt(lookAt);
    return;
  }
  // Chase: behind and above, turning with the drone (the heading is smoothed so a snap turn is not a lurch).
  const heading = sim.phase === 'deck' || sim.phase === 'cat' ? Math.atan2(RAIL.dir.z, RAIL.dir.x) : sim.alpha;
  const nose = _b.set(0, 0, 1).applyQuaternion(sim.quat);
  const noseAlpha = sim.phase === 'chute' || sim.phase === 'splashed' ? Math.atan2(nose.z, nose.x) : heading;
  if (wrecked) camAlpha += 0.25 * dt;
  else if (snapCam) camAlpha = noseAlpha;
  else camAlpha += wrapPi(noseAlpha - camAlpha) * (1 - Math.exp(-dt / 0.45));
  const hang = sim.phase === 'chute' || sim.phase === 'splashed';
  const dist = wrecked ? 46 : hang ? 28 : sim.phase === 'deck' ? 17 : 16;
  const lift = wrecked ? 14 : hang ? 8 : 4.2;
  camera.position.set(
    focus.x - Math.cos(camAlpha) * dist, focus.y + lift, focus.z - Math.sin(camAlpha) * dist,
  );
  lookAt.copy(focus);
  if (!wrecked) lookAt.addScaledVector(_c.set(Math.cos(camAlpha), 0, Math.sin(camAlpha)), hang ? 0 : 7).y += 0.8;
  if (camera.position.y < 1) camera.position.y = 1;
  camera.lookAt(lookAt);
  snapCam = false;
}

function setView(v) {
  view = v;
  if (v === 'orbit') {
    controls.enabled = true;
    rig.focus('plane', droneFocus, 17, 2.5);
  } else {
    controls.enabled = false;
    rig.free();
    snapCam = true;
  }
  say(VIEW_NAMES[v], '', 1600);
}

// --- Readouts ------------------------------------------------------------------------------------------------------------
const root = document.querySelector('#hud');
const live = root.querySelector('.hud-live');
root.querySelector('.hud-debrief').hidden = true;
const sparkEl = root.querySelector('.hud-spark');
if (sparkEl) sparkEl.remove();
let lastHtml = '';
const f = (v, d = 0) => v.toFixed(d);
const tile = (label, value, unit, cls = '') => `<div class="tile ${cls}"><span>${label}</span><b>${value}${unit ? `<small>${unit}</small>` : ''}</b></div>`;
const head = (title, chip, tone) => `<div class="hud-head"><b>${title}</b><span class="chip ${tone}">${chip}</span></div>`;

function stateChip() {
  switch (sim.phase) {
    case 'deck':
      if (!sim.engineOn) return ['Engine off', ''];
      if (sim.spin < 0.999) return [`Engine ${f(sim.spin * 100)} %`, 'warn'];
      return ['Ready to launch', 'ok'];
    case 'cat': return ['Catapult', 'live'];
    case 'flight': return ['Flying', 'live'];
    case 'chute': return ['Under canopy', 'warn'];
    case 'splashed': return ['Afloat', 'ok'];
    case 'destroyed': return ['Destroyed', 'bad'];
    default: return ['Crashed', 'bad'];
  }
}

function hudHtml() {
  const [chip, tone] = stateChip();
  const out = [];
  const air = sim.phase === 'flight' || sim.phase === 'chute' || sim.phase === 'cat';
  const alt = sim.altitude;
  const low = sim.phase === 'flight' && alt < 20 ? (alt < 8 ? 'threat-high' : 'threat') : '';
  const rangeShip = sim.shipRange();
  const toShip = _a.copy(ship.group.position).sub(sim.pos);
  const rel = ((Math.atan2(toShip.z, toShip.x) * 180) / Math.PI - sim.headingDeg + 540) % 360 - 180; // + = to the drone's right
  const bearing = Math.abs(rel) < 5 ? 'ahead' : Math.abs(rel) > 175 ? 'astern' : `${f(Math.abs(rel))}° ${rel > 0 ? 'right' : 'left'}`;
  let tiles;
  if (sim.phase === 'deck' || sim.phase === 'cat') {
    tiles = tile('Engine', sim.engineOn ? `${f(sim.spin * 100)}` : 'off', sim.engineOn ? '%' : '', sim.engineOn && sim.spin >= 0.999 ? 'threat' : '')
      + tile('Cruise speed', f(sim.speedTarget), 'm/s')
      + tile('Rail', sim.phase === 'cat' ? 'firing' : sim.armed ? 'armed' : 'ready', '');
  } else if (sim.phase === 'destroyed' || sim.phase === 'crashed') {
    tiles = tile('Status', sim.phase === 'destroyed' ? 'Shot down' : sim.wreck?.kind === 'ship' ? 'Hit the ship' : sim.wreck?.kind === 'land' ? 'Hit an island' : 'Hit the sea', '', 'wide');
  } else {
    tiles = tile('Altitude', f(alt), 'm', low)
      + tile('Speed', f(sim.speed), 'm/s')
      + tile('Heading', f(sim.headingDeg).padStart(3, '0'), '°')
      + tile('Climb', f(sim.vel.y, 1), 'm/s')
      + tile('Ship', f(rangeShip), 'm')
      + tile('Bearing', bearing, '');
  }
  out.push(`<div class="hud-sec">${head('Drone', chip, tone)}<div class="tiles">${tiles}</div></div>`);

  // The missile.
  const m = sim.missile;
  let mHead;
  let mTiles;
  const left = 2 - sim.shots.length;
  if (m) {
    const age = sim.t - m.tFire;
    mHead = head('Missile', 'In flight', 'warn');
    mTiles = tile('To target', f(m.pos.distanceTo(sim.pos)), 'm') + tile('Speed', f(m.vel.length()), 'm/s') + tile('Flight', f(age, 1), 's', 'opt');
  } else if (sim.shot && sim.shot.tFire === null) {
    mHead = head('Missile', 'Launcher turning', 'warn');
    mTiles = tile('Rounds left', f(left), '');
  } else {
    mHead = head('Missile', left > 0 ? 'Ready' : 'Empty', left > 0 ? '' : 'bad');
    mTiles = tile('Rounds left', f(left), '') + tile('Range limit', f(MISSILE_RANGE / 1000, 1), 'km');
  }
  if (!air && sim.phase !== 'splashed') mTiles = tile('Rounds left', f(left), '') + tile('F', 'needs the drone airborne', '', 'opt');
  out.push(`<div class="hud-sec">${mHead}<div class="tiles">${mTiles}</div></div>`);
  return out.join('');
}

// The line of keys at the foot of the screen: the useful ones for this moment first.
const keysEl = document.createElement('div');
keysEl.id = 'fly-keys';
keysEl.className = 'fly-keys';
document.body.appendChild(keysEl);
let lastKeys = '';
function keysHtml() {
  const k = (key, label, on = false) => `<span class="fk${on ? ' on' : ''}"><kbd>${key}</kbd>${label}</span>`;
  const arrows = `${k('←', '', false)}${k('→', 'turn')}${k('↑', '')}${k('↓', 'pitch')}`;
  switch (sim.phase) {
    case 'deck':
      if (!sim.engineOn) return `${k('E', 'start the engine', true)}${k('F', 'missile')}${k('V', 'camera')}`;
      return `${k('L', sim.spin >= 0.999 ? 'catapult: go!' : 'catapult (at full power)', true)}${k('E', 'engine off')}${k('V', 'camera')}`;
    case 'cat': return k('…', 'launching');
    case 'flight': return `${arrows}${k('E', 'engine off: parachute')}${k('F', 'missile')}${k('V', 'camera')}`;
    case 'chute': case 'splashed': return `${k('F', 'missile')}${k('R', 'fly again', true)}${k('V', 'camera')}`;
    default: return `${k('R', 'fly again', true)}${k('V', 'camera')}`;
  }
}

// --- Interface: hide, menu, keys sheet -------------------------------------------------------------------------------
const FOLD_KEY = 'intercept.uiHidden';
const foldButton = document.querySelector('#btn-fold');
const unfoldButton = document.querySelector('#btn-unfold');
const menuButton = document.querySelector('#btn-menu');
const menuEl = document.querySelector('#menu');
const keysSheet = document.querySelector('#keys');
function setMenu(open) { menuEl.hidden = !open; menuButton.setAttribute('aria-expanded', String(open)); }
function setKeys(open) { keysSheet.hidden = !open; }
function closePopovers() {
  const was = !menuEl.hidden || !keysSheet.hidden;
  setMenu(false); setKeys(false);
  return was;
}
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
let folded = false;
try { folded = localStorage.getItem(FOLD_KEY) === '1'; } catch { /* storage unavailable */ }
setFolded(folded, false);
document.querySelector('#btn-ship').addEventListener('click', () => {
  try { sessionStorage.setItem('intercept.chooser', '1'); location.reload(); } catch { location.search = ''; }
});
{
  const t = menuText('fly'); // the same words as the start screen (menu.js)
  document.querySelector('.brand b').textContent = t.brand;
  document.querySelector('#mission-sub').textContent = t.sub;
}

// Sound (the Sound button and S): remembered like the other missions'. The context starts at the first key or click.
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
soundButton.title = 'Sound: engine, catapult, missile, explosion, wind and surf (S)';
if (!audio.supported) { soundButton.disabled = true; soundButton.title = 'Sound is not available in this browser'; }
soundButton.addEventListener('click', () => setSound(!audio.enabled));

// A "Fly again" entry in the menu, and the readouts button.
const restartButton = document.createElement('button');
restartButton.id = 'btn-restart';
restartButton.setAttribute('role', 'menuitem');
restartButton.innerHTML = 'Fly again<kbd>R</kbd>';
menuEl.insertBefore(restartButton, menuEl.firstChild);
restartButton.addEventListener('click', () => restart());

// The map (bow up, centred on the drone); the choice is remembered like the other missions'.
const map = createFlyMap();
const mapButton = document.querySelector('#btn-map');
function setMap(on) {
  map.setEnabled(on);
  mapButton.classList.toggle('active', on);
  mapButton.setAttribute('aria-pressed', String(on));
  try { localStorage.setItem('intercept.map', on ? '1' : '0'); } catch { /* storage unavailable */ }
}
let mapPref = true;
try { mapPref = localStorage.getItem('intercept.map') !== '0'; } catch { /* storage unavailable */ }
setMap(mapPref);
mapButton.addEventListener('click', () => setMap(!map.enabled));

const hudButton = document.querySelector('#btn-hud');
function setHud(on) {
  hudOn = on;
  root.hidden = !on;
  hudButton.classList.toggle('active', on);
  hudButton.setAttribute('aria-pressed', String(on));
}
hudButton.addEventListener('click', () => setHud(!hudOn));
setHud(true);

// The keys sheet for this mission.
keysSheet.querySelector('dl').innerHTML = [
  ['<kbd>←</kbd> <kbd>→</kbd>', 'Bank and turn left / right'],
  ['<kbd>↑</kbd> <kbd>↓</kbd>', 'Climb / dive'],
  ['<kbd>E</kbd>', 'Engine: starts it on the ship; in the air it cuts it for good and the parachute opens'],
  ['<kbd>L</kbd>', 'Catapult (the engine must be running; it fires at full power)'],
  ['<kbd>F</kbd>', 'Fire the frigate\'s missile at the drone'],
  ['<kbd>R</kbd>', 'Fly again'],
  ['<kbd>V</kbd>', 'Camera: chase, orbit, tower'],
  ['<kbd>[</kbd> <kbd>]</kbd>', 'Cruise speed (default 75 m/s)'],
  ['<kbd>M</kbd>', 'Map (click it to change the zoom)'],
  ['<kbd>S</kbd>', 'Sound on / off'],
  ['<kbd>H</kbd> <kbd>C</kbd>', 'Readouts, hide the interface'],
].map(([k, d]) => `<dt>${k}</dt><dd>${d}</dd>`).join('');
keysSheet.querySelector('.keys-note').textContent = 'Fly with the arrow keys · the engine only starts on the ship · the missile always finds you';

// --- Keys ------------------------------------------------------------------------------------------------------------
const ARROWS = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };
function restart() {
  sim.reset();
  plane.restoreParts();
  debris = null;
  fx.clear();
  audio.reset();
  scenario.tChute = Infinity;
  scenario.tSplash = Infinity;
  chute.group.visible = false;
  missile.group.visible = false;
  trailLast = null;
  exhaustT = 0;
  banner.hidden = true;
  snapCam = true;
  if (view === 'orbit') rig.focus('plane', droneFocus, 17, 2.5);
  say('Back on the deck: E starts the engine', '', 2400);
}

window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLElement && e.target.closest('input, textarea, select')) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const arrow = ARROWS[e.key];
  if (arrow) {
    input[arrow] = 1;
    e.preventDefault(); // never scroll or step a focused control
    return;
  }
  if (e.repeat) return;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  switch (key) {
    case 'e': sim.toggleEngine(); break;
    case 'l': sim.catapult(); break;
    case 'f': sim.fire(); break;
    case 'r': restart(); break;
    case 'v': setView(VIEWS[(VIEWS.indexOf(view) + 1) % VIEWS.length]); break;
    case 'h': setHud(!hudOn); break;
    case 'm': setMap(!map.enabled); break;
    case 's': setSound(!audio.enabled); break;
    case 'c': setFolded(!document.body.classList.contains('ui-hidden')); break;
    case '[': case ']': {
      sim.setSpeed(sim.speedTarget + (key === ']' ? 5 : -5));
      try { localStorage.setItem(SPEED_KEY, String(sim.speedTarget)); } catch { /* storage unavailable */ }
      say(`Cruise speed ${sim.speedTarget} m/s`, '', 1600);
      break;
    }
    case '?': setKeys(keysSheet.hidden); break;
    case 'Escape': closePopovers(); break;
    case ' ': e.preventDefault(); break;
    default: return;
  }
  if (key !== 'Escape') e.preventDefault();
});
window.addEventListener('keyup', (e) => {
  const arrow = ARROWS[e.key];
  if (arrow) input[arrow] = 0;
});
window.addEventListener('blur', () => { for (const k of Object.keys(input)) input[k] = 0; });

// --- Loop ---------------------------------------------------------------------------------------------------------------
function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  pointScale.value = (h * renderer.getPixelRatio()) / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));
}
window.addEventListener('resize', resize);
resize();

let last = performance.now();
let frames = 0;
renderer.setAnimationLoop((now) => {
  const dt = Math.max(0, Math.min((now - last) / 1000, 0.1));
  last = now;
  sim.advance(dt, input);
  handleEvents();
  applyState(dt);
  updateCamera(dt);
  audio.update(sim, camera, dt);
  env.follow(camera.position);
  droneFocus(focus);
  env.setShadowFocus(sim.phase === 'deck' || sim.phase === 'cat' ? ship.group.position : focus, sim.phase === 'deck' ? 70 : 45);
  fx.update(sim.t);
  map.update(sim);
  if (hudOn) {
    const html = hudHtml();
    if (html !== lastHtml) { live.innerHTML = html; lastHtml = html; }
  }
  const keys = keysHtml();
  if (keys !== lastKeys) { keysEl.innerHTML = keys; lastKeys = keys; }
  if (!banner.hidden && performance.now() > bannerUntil) banner.hidden = true;
  renderer.render(scene, camera);
  if (frames++ === 0) loadingEl?.remove(); // the first frame is on screen
});

// Greeting, and the inspection handle.
say('E starts the engine, L fires the catapult', '', 4200);
window.__fly = { sim, camera, controls, rig, renderer, scene, env, fx, plane: plane.group, missile: missile.group, ship: ship.group, setView, restart, get debris() { return debris; } };

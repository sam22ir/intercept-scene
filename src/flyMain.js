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
import './helm.css';
import {
  FlySim, T_SPOOL, T_RELEASE, BOOST_TIME, DEFAULT_SPEED, MISSILE_RANGE, MAX_BANK,
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
  syncViews();
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

// --- The look of Solo Air Defense, for the drone: a gear menu, an icon view strip, and one bottom row (info badges, the flight dome between
// two propellers and throttle bars, the command buttons). The styles are helm.css's. -----------------------------------------------------
const MOTION = !globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const VIEW_LABELS = { chase: 'Chase', orbit: 'Orbit', tower: 'Tower' };
const VIEW_ICONS = {
  chase: '<path class="hb-fill" d="M14 10.5l7 3-7 3-1.6-3z"/><path d="M12.4 13.5L9.8 9.6M12.4 13.5l-2.6 3.9"/><g class="lines"><path d="M2 11h5M1 14h7M3 17h5"/></g>',
  orbit: '<g transform="rotate(-25 12 12)"><ellipse cx="12" cy="12" rx="9.5" ry="4.6"/>' + (MOTION ? '<circle r="1.7" style="fill:currentColor"><animateMotion dur="3.2s" repeatCount="indefinite" path="M21.5 12a9.5 4.6 0 1 1 -19 0a9.5 4.6 0 1 1 19 0"/></circle>' : '<circle cx="21.5" cy="12" r="1.7" style="fill:currentColor"/>') + '</g><path d="M9.7 12.6h4.6l-.9 1.5h-2.8zM12 10.3v2.3"/>',
  tower: '<path d="M9.2 21l1.1-8h3.4l1.1 8M7.5 13h9l1.3-4H6.2zM10 9V5.5h4V9M12 2.5v3"/><g class="sweep"><path class="beam" d="M12 4.2L21 1.5v5.4z"/></g>',
};
const strip = document.createElement('div');
strip.className = 'helm-views';
strip.innerHTML = VIEWS.map((v, i) => '<button type="button" data-view="' + v + '" title="' + VIEW_NAMES[v] + ' (V)" aria-label="' + VIEW_LABELS[v] + '"><svg viewBox="0 0 24 24">' + VIEW_ICONS[v] + '</svg><span>' + VIEW_LABELS[v] + '</span></button>').join('');
document.body.appendChild(strip);
const viewButtons = [...strip.querySelectorAll('button')];
viewButtons.forEach((b) => b.addEventListener('click', () => { setView(b.dataset.view); b.blur(); }));
function syncViews() { for (const b of viewButtons) b.classList.toggle('active', b.dataset.view === view); }
{ // the keys button: shows or hides the key bar (hidden at the start)
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
syncViews();

{ // the top bar is one gear: its menu holds everything the mission needs
  menuButton.innerHTML = '<svg><use href="#i-gear"/></svg>';
  menuButton.title = 'Settings';
  menuButton.setAttribute('aria-label', 'Settings');
  const fsButton = document.querySelector('#btn-fullscreen');
  const MI = {
    restart: '<path class="mi-a" d="M20 12a8 8 0 1 1-2.6-5.9M20 4v4.5h-4.5"/>',
    menu: '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>',
    readouts: '<rect x="3.5" y="4.5" width="17" height="12" rx="2"/><path d="M7 13l3-3.2 2.4 2 3.6-4.3M9 20h6M12 16.5V20"/>',
    map: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4"/><path class="mi-a" d="M12 12l5.5-5"/>',
    sound: '<path d="M4 9.5h3.5L12 6v12l-4.5-3.5H4z"/><path class="mi-w1" d="M15.5 9.2a4 4 0 0 1 0 5.6"/><path class="mi-w2" d="M18.2 6.8a7.5 7.5 0 0 1 0 10.4"/>',
    full: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
    hide: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/><path class="mi-a" d="M4 4l16 16"/>',
    keys: '<rect x="2.5" y="6" width="19" height="12" rx="2.5"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7.5 14h9"/>',
  };
  const item = (b, label, key, ic) => { b.className = ''; b.setAttribute('role', 'menuitem'); b.innerHTML = '<span class="mi-l"><svg class="mi" viewBox="0 0 24 24" aria-hidden="true">' + MI[ic] + '</svg>' + label + '</span>' + (key ? '<kbd>' + key + '</kbd>' : ''); return b; };
  const head = (t) => { const h = document.createElement('div'); h.className = 'menu-h'; h.textContent = t; return h; };
  const weatherBtn = document.querySelector('#btn-weather'), seaRow = document.querySelector('#sea-row');
  const shipBtn = document.querySelector('#btn-ship'), keysBtn = document.querySelector('#btn-keys');
  item(restartButton, 'Fly again', 'R', 'restart');
  item(shipBtn, 'Main menu', '', 'menu');
  item(hudButton, 'Readouts', 'H', 'readouts');
  item(mapButton, 'Map', 'M', 'map');
  item(soundButton, 'Sound', 'S', 'sound');
  item(fsButton, 'Fullscreen', '', 'full');
  item(foldButton, 'Hide the interface', 'C', 'hide');
  item(keysBtn, 'Keyboard shortcuts', '?', 'keys');
  menuEl.replaceChildren(head('Mission'), restartButton, shipBtn, head('Display'), hudButton, mapButton, foldButton, fsButton,
    head('Sound'), soundButton, head('Sea'), ...[seaRow, weatherBtn].filter(Boolean), head('Help'), keysBtn);
  fsButton.addEventListener('click', () => { try { if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen(); } catch { /* not allowed here */ } });
}

// The bottom row. Left: round badges (altitude, speed, missiles left, the frigate); middle: the flight dome between a propeller and a
// throttle bar each side; right: the commands (engine, catapult, the frigate's missile, fly again).
const RING_C = 2 * Math.PI * 20;
function badge(cls, icon, frac, title, sub, chip) {
  const fr = Math.max(0, Math.min(1, frac));
  return '<div class="hs-badge ' + cls + '"><svg class="hb-ring" viewBox="0 0 46 46" aria-hidden="true"><circle class="hb-bg" cx="23" cy="23" r="20"/><circle class="hb-fg" cx="23" cy="23" r="20" style="stroke-dasharray:' + (RING_C * fr).toFixed(1) + ' 126"/></svg>'
    + '<span class="hb-ico"><svg viewBox="0 0 24 24">' + icon + '</svg></span>' + (chip === '' ? '' : '<i class="hb-chip">' + chip + '</i>') + '<span class="hb-tip"><b>' + title + '</b><small>' + sub + '</small></span></div>';
}
const BI = { // 24 x 24 drawings, animated by CSS (helm.css .hb-*)
  alt: '<path class="hb-fill" d="M2 20.5l6.2-9.5 4 5.2 3-4 6.8 8.3z"/><g class="hb-lift"><path d="M12 8.2V2.6M9.4 5L12 2.4 14.6 5"/></g>',
  speed: '<path d="M3.2 17.5a8.8 8.8 0 1 1 17.6 0"/><path d="M5.6 17.5h1.6M16.8 17.5h1.6M12 8.7v1.6M6.2 11.2l1.1 1.1M17.8 11.2l-1.1 1.1"/><g class="hb-needle"><path d="M12 17.5l4.2-5.6"/></g><circle cx="12" cy="17.5" r="1.5" style="fill:currentColor;stroke:none"/>',
  missile: '<path class="hb-fill" d="M12 2.5c1.7 1.7 2.1 4.2 2.1 6.8v7.2H9.9V9.3c0-2.6.4-5.1 2.1-6.8z"/><path class="hb-flame" d="M10.7 17.2h2.6L12 21.6z"/><path d="M9.9 13l-2.6 3.8h2.6M14.1 13l2.6 3.8h-2.6"/>',
  hull: '<g class="hb-bob"><path class="hb-fill" d="M2 15h18.2l3-1.6-2.1 5.6H4.6z"/><path d="M8.6 15l1.5-4h6l2.2 4"/><path d="M11.6 11l.9-2.6h3.3l.8 2.6"/><path d="M14.3 8.4V3.6M13 5.2h2.6"/><circle cx="7.4" cy="13.1" r="1.4"/><path d="M18.4 14.9v-1.3h1.5v1.3M19.9 14.2h2"/><path d="M2.6 14.1h3.4"/></g><path class="hb-wave" d="M1 21.4q2-1.3 4 0t4 0 4 0 4 0 4 0 4 0"/>',
};
const airborne = () => sim.phase === 'flight' || sim.phase === 'chute' || sim.phase === 'cat';
function badgesHtml() {
  const alt = sim.altitude;
  const rng = sim.shipRange();
  const left = 2 - sim.shots.length;
  const wreck = sim.phase === 'crashed' || sim.phase === 'destroyed';
  const altCls = wreck ? 'out' : sim.phase === 'flight' && alt < 20 ? 'low' : '';
  const mCls = sim.missile || sim.shot ? 'arm' : left > 0 ? 'ok' : 'out';
  const mSub = sim.missile ? 'in flight' : sim.shot ? 'launcher turning' : left > 0 ? 'ready · F' : 'none left';
  return badge('hb-alt ' + altCls, BI.alt, alt / 300, 'Altitude', airborne() ? f(alt) + ' m' : 'on the deck', airborne() ? f(alt) : '')
    + badge('hb-spd' + (wreck ? ' out' : ''), BI.speed, sim.speed / 110, 'Airspeed', f(sim.speed) + ' m/s · cruise ' + f(sim.speedTarget), f(sim.speed))
    + badge('hb-msl ' + mCls, BI.missile, left / 2, 'Frigate missiles', left + ' of 2 · ' + mSub, String(left))
    + badge('hb-hull', BI.hull, 1 - rng / 4500, 'Frigate', f(rng) + ' m away', rng >= 1000 ? (rng / 1000).toFixed(1) : f(rng));
}

const PROP_SVG = '<svg viewBox="-24 -24 48 48" aria-hidden="true"><defs><linearGradient id="pp-brass" x1="0" y1="-23" x2="9" y2="-6" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#f6e4a2"/><stop offset="0.55" stop-color="#d9b45c"/><stop offset="1" stop-color="#9b7632"/></linearGradient></defs><g class="pp-rot">'
  + [0, 120, 240].map((a) => '<g transform="rotate(' + a + ')"><path d="M-2 -6 C-8.5 -9.5 -9.5 -19 -4 -22.6 C1 -24.5 8.4 -22 9 -17.6 C7 -12 4 -8 2.2 -6 Z" class="pp-blade"/><path d="M-3.4 -9 C-6 -13 -5.8 -18 -3 -20.6" class="pp-edge"/></g>').join('')
  + '</g><circle r="5.4" class="pp-hubring"/><circle r="3" class="pp-hub"/><circle r="1" class="pp-cap"/></svg>';
const shipEl = document.createElement('div');
shipEl.id = 'fly-ship';
shipEl.className = 'helm-ship fly-ship';
const statHost = document.createElement('div'), centre = document.createElement('div'), cmdHost = document.createElement('div'), domeHost = document.createElement('div');
statHost.className = 'hs-badges';
cmdHost.className = 'hs-badges hs-cmds';
centre.className = 'hs-centre';
const propL = document.createElement('div'), propR = document.createElement('div'), barL = document.createElement('div'), barR = document.createElement('div');
propL.className = propR.className = 'hs-prop';
propL.innerHTML = propR.innerHTML = PROP_SVG;
barL.className = barR.className = 'hs-lvl'; // the engine's power, five notches
barL.innerHTML = barR.innerHTML = '<i></i><i></i><i></i><i></i><i></i>';
centre.append(barL, propL, domeHost, propR, barR);
shipEl.append(statHost, centre, cmdHost);
document.body.appendChild(shipEl);
const propRotL = propL.querySelector('.pp-rot'), propRotR = propR.querySelector('.pp-rot');
let propAng = 0;
function spinProps(dt) {
  propAng = (propAng + sim.spin * 11 * dt) % (Math.PI * 2);
  const deg = (propAng * 180) / Math.PI;
  propRotL.style.transform = 'rotate(' + (-deg) + 'deg)'; propRotR.style.transform = 'rotate(' + deg + 'deg)';
  const lit = Math.round(sim.spin * 5);
  for (const bar of [barL, barR]) {
    const n = bar.children.length;
    for (let q = 0; q < n; q++) bar.children[q].className = (n - 1 - q) < lit ? (q === 0 ? 'top' : 'on') : '';
  }
  const blur = sim.spin.toFixed(2);
  propL.style.setProperty('--blur', blur); propR.style.setProperty('--blur', blur);
}

// The dome: its rim is a heading tape (the degrees slide round it), a needle from the foot swings with the bank, the speed is under it.
const DOME_R = 94;
const DOME_K = 1.5;
function domeSvg() {
  const h = sim.headingDeg;
  const cx = 100, cy = 100;
  const pt = (r, a) => [(cx + r * Math.cos(a)).toFixed(1), (cy - r * Math.sin(a)).toFixed(1)];
  let ticks = '', labels = '';
  for (let d = Math.ceil((h - 58) / 5) * 5; d <= h + 58; d += 5) {
    const a = Math.PI / 2 - THREE.MathUtils.degToRad((d - h) * DOME_K);
    if (a < 0.05 || a > Math.PI - 0.05) continue;
    const major = d % 30 === 0;
    const [x1, y1] = pt(DOME_R, a), [x2, y2] = pt(DOME_R - (major ? 9 : d % 10 === 0 ? 6 : 3.5), a);
    ticks += '<line x1="' + x1 + '" y1="' + y1 + '" x2="' + x2 + '" y2="' + y2 + '" class="' + (major ? 'mj' : '') + '"/>';
    if (major) { const [x, y] = pt(DOME_R - 21, a); labels += '<text x="' + x + '" y="' + y + '" class="dl">' + String(((d % 360) + 360) % 360).padStart(3, '0') + '</text>'; }
  }
  const RR = 60, span = THREE.MathUtils.degToRad(62);
  const th = THREE.MathUtils.clamp(sim.bank / MAX_BANK, -1, 1) * span; // + = banked right
  const p0 = pt(RR, Math.PI / 2), p1 = pt(RR, Math.PI / 2 - th), pl = pt(RR, Math.PI / 2 + span), pr = pt(RR, Math.PI / 2 - span);
  const fill = Math.abs(th) > 0.01 ? '<path d="M' + p0[0] + ',' + p0[1] + ' A' + RR + ',' + RR + ' 0 0 ' + (th > 0 ? 1 : 0) + ' ' + p1[0] + ',' + p1[1] + '" class="rf ' + (th > 0 ? 'stbd' : 'port') + '"/>' : '';
  const clb = sim.vel.y;
  return '<svg viewBox="0 0 200 104" class="dome-svg" aria-hidden="true"><path d="M6,100 A' + DOME_R + ',' + DOME_R + ' 0 0 1 194,100" class="rim"/>' + ticks + labels
    + '<path d="M' + (cx - 4) + ',' + (cy - DOME_R - 1) + ' L' + (cx + 4) + ',' + (cy - DOME_R - 1) + ' L' + cx + ',' + (cy - DOME_R + 6) + ' Z" class="lub"/>'
    + '<text x="' + cx + '" y="79" class="hd">' + f(((h % 360) + 360) % 360).padStart(3, '0') + '°</text>'
    + '<path d="M' + pl[0] + ',' + pl[1] + ' A' + RR + ',' + RR + ' 0 0 1 ' + pr[0] + ',' + pr[1] + '" class="rt"/>' + fill
    + '<line x1="' + p0[0] + '" y1="' + (Number(p0[1]) - 5).toFixed(1) + '" x2="' + p0[0] + '" y2="' + (Number(p0[1]) + 5).toFixed(1) + '" class="rm"/>'
    + '<text x="' + cx + '" y="94" class="sp">' + f(sim.speed) + '<tspan> m/s ' + (airborne() ? (clb > 0.5 ? '↑' : clb < -0.5 ? '↓' : '→') : '') + '</tspan></text></svg>';
}

// The commands: round buttons with an animated drawing, the key, and a tip on hover.
const CI = {
  engine: '<svg viewBox="0 0 32 32" aria-hidden="true"><g class="fu-pulse"><path d="M16 5.5v9.5"/><path d="M9.2 9.6a9.6 9.6 0 1 0 13.6 0"/></g></svg>',
  cat: '<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M3 25h26M3 21.5h12"/><g class="fu-slide"><path class="fill" d="M9 13.5h11l4 3-4 3H9z"/><path d="M13 13.5l-2-4h4l2 4M13 19.5l-2 4h4l2-4"/></g></svg>',
  miss: '<svg viewBox="0 0 32 32" aria-hidden="true"><g transform="rotate(-45 16 16)"><circle class="puff p1" cx="4" cy="16" r="1.6"/><circle class="puff p2" cx="4" cy="16" r="1.6"/><path class="flame" d="M9 14.2L1.5 16 9 17.8z"/><path class="fill" d="M9 13.2h11.5L27 16l-6.5 2.8H9z"/><path d="M9 13.2L5.8 9.8h5.6l1.9 3.4M9 18.8l-3.2 3.4h5.6l1.9-3.4M16 13.2v5.6"/></g></svg>',
  again: '<svg viewBox="0 0 32 32" aria-hidden="true"><g class="fu-turn"><path d="M26 16a10 10 0 1 1-3.2-7.4M26 6v6h-6"/></g></svg>',
};
const cmd = (cls, act, icon, title, sub, key, on) => '<button type="button" class="helm-act ' + cls + (on ? ' go' : '') + '" data-act="' + act + '"><i class="sp-ico">' + icon + '</i><span class="sp-txt"><b>' + title + '</b><small>' + sub + '</small></span><kbd>' + key + '</kbd></button>';
function cmdHtml() {
  const deck = sim.phase === 'deck';
  const full = sim.spin >= 0.999;
  const left = 2 - sim.shots.length;
  const eTitle = deck ? (sim.engineOn ? 'Engine off' : 'Start the engine') : 'Cut the engine';
  const eSub = deck ? (sim.engineOn ? 'back to idle' : 'spool up for the catapult') : 'for good: the parachute opens';
  return cmd('helm-act-heli fu-eng' + (sim.engineOn ? ' on' : ''), 'engine', CI.engine, eTitle, eSub, 'E', deck && !sim.engineOn)
    + cmd('helm-act-heli fu-cat', 'cat', CI.cat, 'Catapult', full ? 'full power: go!' : 'needs the engine at full power', 'L', deck && sim.engineOn && full)
    + cmd('helm-act-miss', 'fire', CI.miss, 'Frigate missile', left > 0 ? 'the ship fires at you (' + left + ' left)' : 'none left', 'F', false)
    + cmd('fu-again', 'again', CI.again, 'Fly again', 'back on the deck', 'R', sim.phase === 'crashed' || sim.phase === 'destroyed' || sim.phase === 'splashed');
}
cmdHost.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  ({ engine: () => sim.toggleEngine(), cat: () => sim.catapult(), fire: () => sim.fire(), again: () => restart() })[b.dataset.act]?.();
  b.blur();
});
let lastBadges = '', lastDome = '', lastCmd = '';
function updateBottom(dt) {
  const bd = badgesHtml();
  if (bd !== lastBadges) { statHost.innerHTML = bd; lastBadges = bd; }
  const dm = '<div class="hs-dome">' + domeSvg() + '</div>';
  if (dm !== lastDome) { domeHost.innerHTML = dm; lastDome = dm; }
  const cm = cmdHtml();
  if (cm !== lastCmd) { cmdHost.innerHTML = cm; lastCmd = cm; }
  spinProps(dt);
}

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
  updateBottom(dt);
  const keys = keysHtml();
  if (keys !== lastKeys) { keysEl.innerHTML = keys; lastKeys = keys; }
  if (!banner.hidden && performance.now() > bannerUntil) banner.hidden = true;
  renderer.render(scene, camera);
  if (frames++ === 0) loadingEl?.remove(); // the first frame is on screen
});

// Greeting, and the inspection handle.
say('E starts the engine, L fires the catapult', '', 4200);
window.__fly = { sim, camera, controls, rig, renderer, scene, env, fx, plane: plane.group, missile: missile.group, ship: ship.group, setView, restart, get debris() { return debris; } };

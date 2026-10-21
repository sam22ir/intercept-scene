import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { createEnvironment } from './environment.js';
import { createShip } from './models/ship.js';
import { createPlane } from './models/plane.js';
import { createMissile } from './models/missile.js';
import { createDebris } from './fx/effects.js';
import { createLiveFx } from './fx/liveFx.js';
import { pointScale } from './fx/particles.js';
import { CameraRig } from './cameraRig.js';
import { LAUNCHER_PIVOT } from './scenario.js';
import { createHelmMap } from './helmMap.js';
import { createHelmAudio } from './helmAudio.js';
import { menuText } from './menu.js';
import {
  HelmSim, SLEW_TIME, TELEGRAPH, RUDDER_MAX, CELLS, MISSILE_RANGE, BRIDGE_EYE, DIRECTOR_EYE, relName, kmText,
} from './helm.js';
import './helm.css';

// Entry point of "Solo Air Defense", mission id `helm` (see helm.js for the model): you sail the frigate with the arrow keys and fight off
// drones with her missiles. Like the manual flight nothing here is a function of a clock: the keys drive a
// real-time simulation and this file draws it. start.js imports it when that mission is picked.
//
// Views (1 to 6, V cycles): the bridge (drag to look round), behind the ship, straight above her (heading up),
// riding the missile, the fire-control sight on the target (a long lens), and a free orbit round the ship.

const canvas = document.querySelector('#scene');
const loadingEl = document.querySelector('#loading');
document.body.classList.add('mission-fly', 'mission-helm'); // the manual flight's interface, and this one's own
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.75;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, 1, 0.3, 30000);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.maxDistance = 4000;
controls.maxPolarAngle = Math.PI * 0.495;
controls.enabled = false;
const rig = new CameraRig(camera, controls);

const env = createEnvironment(renderer, scene);
env.setShadowSize(1024);
env.ocean.material.uniforms.uShipX.value = 1e7; // the shader's straight-line wake: this ship turns, she has her own
const ship = createShip();
ship.group.rotation.order = 'YXZ'; // heading, then heel, then trim
scene.add(ship.group);
const fx = createLiveFx(scene);
const audio = createHelmAudio();
const sim = new HelmSim({ seed: (Date.now() % 100000) | 0 });

// Tags (drones, missiles): an HTML layer like the other missions'.
const labels = new CSS2DRenderer();
labels.domElement.className = 'labels-layer helm-labels';
document.body.appendChild(labels.domElement);
function tag(kind) {
  const el = document.createElement('div');
  el.className = `tag tag-${kind}`;
  el.style.pointerEvents = 'none';
  el.innerHTML = '<div class="tag-title"></div><div class="tag-body"></div>';
  const obj = new CSS2DObject(el);
  obj.center.set(0.5, 1);
  scene.add(obj);
  return { obj, el, title: el.querySelector('.tag-title'), body: el.querySelector('.tag-body') };
}

// --- The ship's wake, as a real one: four ribbons laid along the track she has sailed over the last minute ----------------
//  core   the propeller wash right behind the stern: dense white foam, streaky along the track, thinning out
//  slick  the wide turbulent water round it: faint and pale, lasting longer
// The foam is a generated texture laid still on the water (its length runs along the track), so it stays where she left it:
// the patches do not travel with her. They curve with her turns, because they follow the track.
const WAKE_N = 90;
const WAKE_DT = 0.6;
const WAKE_SPAN = WAKE_N * WAKE_DT; // s of track kept
const wakeHist = [];
let wakeLast = -Infinity;
let pathLen = 0; // m sailed since the start: the texture's coordinate along the track
let lastX = null;
let lastZ = null;
function foamTexture() {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = 'rgba(255, 255, 255, 0.38)';
  g.fillRect(0, 0, 256, 256);
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 1500; i++) {
    const x = rnd() * 256;
    const y = rnd() * 256;
    const r = 1.5 + rnd() * rnd() * 14;
    const a = 0.12 + rnd() * 0.7;
    for (const [dx, dy] of [[0, 0], [256, 0], [-256, 0], [0, 256], [0, -256]]) { // wrapped, so it tiles
      const grd = g.createRadialGradient(x + dx, y + dy, 0, x + dx, y + dy, r);
      grd.addColorStop(0, `rgba(255, 255, 255, ${a})`);
      grd.addColorStop(1, 'rgba(255, 255, 255, 0)');
      g.fillStyle = grd;
      g.fillRect(x + dx - r, y + dy - r, 2 * r, 2 * r);
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const foam = foamTexture();
// A ribbon of `sections` cross-sections of three vertices (left edge, centre, right edge): edges transparent, so it has soft sides.
function makeRibbon(sections, order) {
  const pos = new Float32Array(sections * 9);
  const col = new Float32Array(sections * 12);
  const uv = new Float32Array(sections * 6);
  const index = [];
  for (let i = 0; i < sections - 1; i++) {
    const a = i * 3;
    const b = a + 3;
    index.push(a, a + 1, b, a + 1, b + 1, b, a + 1, a + 2, b + 1, a + 2, b + 2, b + 1);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 4));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(index);
  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: foam, vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide }));
  mesh.frustumCulled = false;
  mesh.renderOrder = order;
  scene.add(mesh);
  return { pos, col, uv, geo, sections };
}
const wakeCore = makeRibbon(WAKE_N, 2);
const wakeSlick = makeRibbon(WAKE_N, 1);
// Writes cross-section k of a ribbon: centre (cx, cz), across-track direction (px, pz), half width, alpha, rgb, texture coordinates.
function ribbonSection(r, k, cx, cz, px, pz, half, alpha, rgb, v, vScale, y) {
  r.pos.set([cx + px * half, y, cz + pz * half, cx, y, cz, cx - px * half, y, cz - pz * half], k * 9);
  r.col.set([rgb[0], rgb[1], rgb[2], 0, rgb[0], rgb[1], rgb[2], alpha, rgb[0], rgb[1], rgb[2], 0], k * 12);
  r.uv.set([0, v / vScale, 0.5, v / vScale, 1, v / vScale], k * 6);
}
function hideSection(r, k) { r.col.fill(0, k * 12, k * 12 + 12); }
const CORE_RGB = [1, 1, 1];
const SLICK_RGB = [0.8, 0.92, 0.98];
function updateWake() {
  if (sim.t < wakeLast) { wakeHist.length = 0; wakeLast = -Infinity; pathLen = 0; lastX = null; }
  if (lastX !== null) pathLen += Math.hypot(sim.x - lastX, sim.z - lastZ);
  lastX = sim.x;
  lastZ = sim.z;
  const cs = Math.cos(sim.psi);
  const sn = Math.sin(sim.psi);
  const sx = sim.x - cs * 56; // the stern
  const sz = sim.z - sn * 56;
  if (sim.t - wakeLast >= WAKE_DT) {
    wakeHist.unshift({ x: sx, z: sz, psi: sim.psi, t: sim.t, s: pathLen, turn: Math.min(Math.abs(sim.r) / 0.09, 1.4), u: Math.max(sim.u, 0) });
    if (wakeHist.length > WAKE_N) wakeHist.pop();
    wakeLast = sim.t;
  }
  for (let i = 0; i < WAKE_N; i++) {
    const h = wakeHist[i];
    if (!h) { hideSection(wakeCore, i); hideSection(wakeSlick, i); continue; }
    const age = sim.t - h.t;
    const u = Math.min(age / WAKE_SPAN, 1);
    const psi = i === 0 ? sim.psi : h.psi; // the newest section is at the stern, wherever she is now
    const px = -Math.sin(psi);
    const pz = Math.cos(psi);
    const bx = i === 0 ? sx : h.x;
    const bz = i === 0 ? sz : h.z;
    const s = i === 0 ? pathLen : h.s;
    const sf = Math.min(h.u / 7, 1); // no wash to speak of at a crawl
    // The wash: narrow and dense, the foam thinning out over the minute; wider and stronger in a hard turn.
    ribbonSection(wakeCore, i, bx, bz, px, pz, (4.5 + 6.5 * Math.sqrt(u)) * (1 + 0.5 * h.turn), Math.min(1.0 * (1 - u) ** 1.2 * sf * (1 + 0.3 * h.turn), 1), CORE_RGB, s, 40, 0.45);
    // The slick: the turbulent water round it.
    ribbonSection(wakeSlick, i, bx, bz, px, pz, 4 + 17 * Math.pow(u, 0.55), 0.34 * (1 - u) ** 1.2 * sf, SLICK_RGB, s, 90, 0.4);
  }
  for (const r of [wakeCore, wakeSlick]) {
    r.geo.attributes.position.needsUpdate = true;
    r.geo.attributes.color.needsUpdate = true;
    r.geo.attributes.uv.needsUpdate = true;
  }
}

// --- Drones and missiles on screen ------------------------------------------------------------------------------------
const PROP_OMEGA = 560;
const vis = new Map(); // drone id -> { plane, tag, debris }
const mvis = new Map(); // missile id -> { model, tag, trailLast }
const strikes = []; // fires burning on board: ship-frame points
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _d = new THREE.Vector3();
const _e = new THREE.Vector3();
const _q = new THREE.Quaternion();
const ZAXIS = new THREE.Vector3(0, 0, 1);

function droneVis(d) {
  let v = vis.get(d.id);
  if (!v) {
    const plane = createPlane();
    plane.setBooster(1e9, 0, 1); // no booster canister: these were launched far away
    scene.add(plane.group);
    v = { plane, tag: tag('drone'), debris: null };
    vis.set(d.id, v);
  }
  return v;
}
function dropVis(id) {
  const v = vis.get(id);
  if (!v) return;
  scene.remove(v.plane.group);
  scene.remove(v.tag.obj);
  v.tag.el.remove();
  vis.delete(id);
}

function handleEvents() {
  for (const e of sim.takeEvents()) {
    audio.event(e);
    switch (e.type) {
      case 'say': say(e.text, e.tone); break;
      case 'slew': startLauncherCine(); break; // F pressed: the launcher is turning onto the target
      case 'acquire': startSightCine(); break; // the launcher is on: through the director's sight, to the target
      case 'lock': showLock(e.id); break; // it has found the target: the sign, through the sight
      case 'fire':
        fx.launchBillow(e.pos, e.dir, sim.t);
        if (cine && (cine.phase === 'slew' || cine.phase === 'sight')) {
          sightEl.hidden = true; // back to the launcher for the firing
          document.body.classList.remove('helm-sighting');
          const m = sim.missiles.find((x) => x.id === e.id);
          cine.mid = e.id;
          if (m) cine.did = m.targetId;
          cine.phase = 'launch';
          cine.tLaunch = sim.t;
        } else startCine(e.id);
        break;
      case 'explosion': {
        fx.explosion(e.pos, sim.t);
        const d = sim.drones.find((x) => x.id === e.id);
        const v = d && vis.get(d.id);
        if (v && d.wreck) {
          v.plane.restoreParts();
          v.debris = createDebris(v.plane, d.id, d.wreck);
          fx.startWreck(v.debris, d.wreck.t);
        }
        break;
      }
      case 'struck': {
        fx.explosion(e.pos, sim.t);
        const v = vis.get(e.id);
        if (v) v.plane.group.visible = false;
        strikes.push({ local: sim.toLocal(e.pos, new THREE.Vector3()).setY(Math.max(e.pos.y, 8)), t: sim.t });
        flash('hit');
        cineStruck(e);
        break;
      }
      case 'alarm': break; // an attack run: the drone's own shot comes only when it really closes in (see updateCamera)
      case 'splash': fx.splashAt(e.pos, sim.t, 1.6); break;
      case 'missile-lost': if (e.pos.y < 8) fx.splashAt(e.pos, sim.t, 1.2); break;
      case 'over': if (cine) pendingOrbit = true; else setView('orbit', true); break; // the shot of the last hit plays out first
      default: break;
    }
  }
}

let smokeT = 0;
function applyState(dt) {
  const t = sim.t;
  // The ship: heading, heel in the turn, and a little roll and pitch from the sea.
  const roll = sim.heel + 0.018 * Math.sin(t * 0.52) + 0.006 * Math.sin(t * 1.3 + 1);
  const pitch = 0.006 * Math.sin(t * 0.37 + 0.4);
  ship.group.position.set(sim.x, 0.12 * Math.sin(t * 0.61), sim.z);
  ship.group.rotation.set(roll, -sim.psi, pitch);
  ship.group.updateMatrixWorld(true);
  ship.update(t, Infinity, Infinity, { aim: sim.launcher, cradleT: 0 });
  env.ocean.material.uniforms.uTime.value = t;
  updateWake();

  // Drones: flying, falling, or gone.
  const seen = new Set();
  for (const d of sim.drones) {
    seen.add(d.id);
    const v = droneVis(d);
    if (d.alive) {
      v.plane.group.visible = true;
      v.plane.group.position.copy(d.pos);
      v.plane.group.quaternion.copy(d.quat);
      v.plane.setProp(t * PROP_OMEGA + d.id, 1);
      v.plane.setLights(t + d.id * 0.3, true);
    } else if (v.debris) {
      v.debris.apply(t - d.wreck.t);
    } else if (d.phase === 'down') {
      v.plane.group.visible = d.pos.y > -3; // into the sea: it sinks out of sight
      d.pos.y -= dt * 0.8;
      v.plane.group.position.copy(d.pos);
    }
    // Its tag: name, range and height while it flies.
    const show = d.alive && d.detected && tagsOn;
    v.tag.obj.visible = show;
    if (show) {
      v.tag.obj.position.copy(d.pos).y += 3;
      const r = sim.rangeTo(d.pos);
      v.tag.el.classList.toggle('dead', d.phase === 'attack' || d.phase === 'pass');
      v.tag.el.classList.toggle('helm-target', d.id === sim.targetId);
      v.tag.title.textContent = `${d.name}${d.id === sim.targetId ? ' · TARGET' : ''}${d.phase === 'attack' ? ' · ATTACK' : ''}`;
      v.tag.body.innerHTML = `${kmText(r)} · ${Math.round(d.pos.y)}<span> m up</span>`;
    }
  }
  for (const id of [...vis.keys()]) if (!seen.has(id)) dropVis(id);

  // Missiles and their smoke.
  const mseen = new Set();
  for (const m of sim.missiles) {
    mseen.add(m.id);
    let v = mvis.get(m.id);
    if (!v) {
      const model = createMissile();
      scene.add(model.group);
      v = { model, trailLast: m.pos.clone() };
      mvis.set(m.id, v);
    }
    v.model.group.position.copy(m.pos);
    v.model.group.quaternion.copy(_q.setFromUnitVectors(ZAXIS, m.dir));
    v.model.setExhaust(t);
    const gap = v.trailLast.distanceTo(m.pos);
    const n = Math.min(160, Math.floor(gap / 1.1));
    for (let i = 1; i <= n; i++) fx.missileSmoke(_c.lerpVectors(v.trailLast, m.pos, i / n), m.dir, t);
    if (n > 0) v.trailLast.copy(m.pos);
  }
  for (const [id, v] of mvis) {
    if (mseen.has(id)) continue;
    scene.remove(v.model.group);
    mvis.delete(id);
  }

  // Fires on board where a drone struck: smoke trailing off her.
  smokeT += dt;
  while (smokeT >= 0.12) {
    smokeT -= 0.12;
    for (const s of strikes) fx.missileTrail(ship.group.localToWorld(_a.copy(s.local)), t);
  }
}

// --- The banner and the alarm --------------------------------------------------------------------------------------
const banner = document.querySelector('#shot-caption');
banner.classList.add('call');
let bannerUntil = 0;
function say(text, tone = '', ms = 3200) {
  banner.textContent = text;
  banner.hidden = false;
  banner.classList.remove('standby', 'execute', 'station', 'danger');
  const cls = { ok: 'execute', warn: 'standby', bad: 'danger' }[tone];
  if (cls) banner.classList.add(cls);
  bannerUntil = performance.now() + ms;
}
const alarmEl = document.createElement('div');
alarmEl.className = 'helm-alarm';
alarmEl.setAttribute('aria-hidden', 'true');
document.body.appendChild(alarmEl);
function flash(kind) {
  alarmEl.classList.remove('hit');
  void alarmEl.offsetWidth; // restart the animation
  alarmEl.classList.add(kind);
}

// --- Camera views -----------------------------------------------------------------------------------------------------
const VIEWS = ['bridge', 'behind', 'above', 'missile', 'sight', 'target', 'orbit'];
const VIEW_NAMES = {
  bridge: 'Bridge (drag to look round)', behind: 'Behind the ship', above: 'Above the ship, heading up',
  missile: 'Riding the missile', sight: 'Radar (the fire-control sight on the target)', target: 'Target (close behind the drone, the camera shaking)', orbit: 'Orbit (drag and wheel)',
};
let view = 'behind';
let lookYaw = 0; // bridge: degrees off the bow, + to starboard
let lookPitch = -0.03;
const BEHIND_DIST = 165; // m behind the ship: far enough to see her whole length, not much more
let behindDist = BEHIND_DIST;
let aboveH = 520;
let camYaw = 0; // the behind view's heading, smoothed
let snap = true;
let fov = 50;
const lookAt = new THREE.Vector3();
const sightEl = document.createElement('div');
sightEl.className = 'helm-sight';
sightEl.hidden = true;
sightEl.innerHTML = '<i class="hs-h"></i><i class="hs-v"></i><i class="hs-box"></i><b class="hs-txt"></b>';
document.body.appendChild(sightEl);
const sightTxt = sightEl.querySelector('.hs-txt');

// The sign that the launcher has caught the target: green corner brackets that close in on the screen centre, and the
// words, for a moment.
const lockEl = document.createElement('div');
lockEl.className = 'helm-lock';
lockEl.hidden = true;
lockEl.innerHTML = '<i class="hl-tl"></i><i class="hl-tr"></i><i class="hl-bl"></i><i class="hl-br"></i><b>TARGET LOCKED</b><small></small>';
document.body.appendChild(lockEl);
let lockTimer = 0;
function showLock(id) {
  const d = sim.drones.find((x) => x.id === id);
  lockEl.querySelector('small').textContent = d ? `${d.name} · ${relName(sim.relBearing(d.pos))} · ${kmText(sim.rangeTo(d.pos))}` : '';
  lockEl.hidden = false;
  lockEl.classList.remove('go');
  void lockEl.offsetWidth; // restart the animation
  lockEl.classList.add('go');
  clearTimeout(lockTimer);
  lockTimer = setTimeout(() => { lockEl.hidden = true; }, 1400);
}

function setFov(f) {
  if (Math.abs(f - camera.fov) < 1e-3) return;
  camera.fov = f;
  camera.updateProjectionMatrix();
  pointScale.value = (window.innerHeight * renderer.getPixelRatio()) / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));
}

const shipTarget = (out) => out.set(sim.x, 10, sim.z);
function setView(v, quiet = false) {
  view = v;
  if (v === 'sight') { sight.fresh = true; sight.searchTime = SIGHT_SEARCH; } // the director starts from the bow and finds the target again
  pendingOrbit = false;
  endCine();
  camera.up.set(0, 1, 0);
  if (v === 'orbit') {
    controls.enabled = true;
    rig.focus('ship', shipTarget, 260, 40);
  } else {
    controls.enabled = false;
    rig.free();
  }
  snap = true;
  sightEl.hidden = v !== 'sight';
  document.body.classList.toggle('helm-sighting', v === 'sight');
  viewButtons.forEach((b) => b.classList.toggle('active', b.dataset.view === v));
  if (v === 'missile' && !sim.missiles.length) say('Riding the missile: no missile in flight yet, the view takes the next one', '', 2600);
  else if (!quiet) say(VIEW_NAMES[v], '', 1500);
}

// --- The intercept camera ------------------------------------------------------------------------------------------------
// The shot is cut automatically and goes back to the view that was on when it is over:
//  - F is pressed: the camera cuts close to the launcher, from the side, to watch it turn (fast) onto the target; then
//    through the director's sight, on the drone, where it finds the target and locks on (the brackets, the TARGET LOCKED sign
//    and a tone) before the round leaves; and back to the launcher to see it fire;
//    it then rides close behind the missile (its flame in the frame, the lens closing in on the drone), and for the last
//    metres goes to the side of the two; time slows only at the moment of a hit (the missile on the drone, or the drone on
//    the ship) and a second after it; it stays on the wreck until
//    the last piece is in the sea (CINE_TAIL more seconds, now none) and goes back;
//  - a drone starts an attack run (and no missile is on it): the same side view of the drone and the ship, closing in;
//  - a drone hits the ship (whichever of the two shots was on): the camera comes in close, from outboard, on the place
//    where it hit, and stays there IMPACT_HOLD seconds, the fire burning, then goes back.
// A missile that is lost, or a drone that goes into the sea, ends the shot at once. Any view key, or I, ends it; it is
// skipped in the free orbit (that view is the player's own, and its controls keep their own camera state).
const CINE_TAIL = 0; // s kept on the scene after the drone is in the sea: none, the view changes back at the splash
const CINE_MAX = 60; // s: a shot never holds the camera longer than this
const IMPACT_HOLD = 5; // s on the place of a hit
const LAUNCH_HOLD = 1.3; // s (of simulated time) the camera stays on the launcher after the round leaves
// The speed of time (1 = real time) in each part of the shot; the loop eases toward it.
const SLOW = { slew: 1, launch: 1, fly: 1, close: 0.3, wreck: 0.3 }; // real time all through, except at the moment of a hit
const HIT_SLOW_SEP = 100; // m: the missile this close to the drone: slow motion (the drone's hit on the ship is in real time)
const HIT_SLOW_AFTER = 1.1; // s of simulated time the slow motion lasts after the hit
const CLOSE_SEP = 380; // m between missile and drone: inside this the shot goes to the side, to see the hit
let timeScale = 1;
let timeTarget = 1;
let cineOn = true;
try { cineOn = localStorage.getItem('intercept.helmcine') !== '0'; } catch { /* storage unavailable */ }
let cine = null;
let pendingOrbit = false; // the ship is out of action: the orbit view comes once the shot of the last hit is over
function newCine(mid, did, phase) {
  sightEl.hidden = true;
  document.body.classList.remove('helm-sighting');
  return { mid, did, phase, t0: sim.t, side: 0, pos: new THREE.Vector3(), look: new THREE.Vector3(), hold: new THREE.Vector3(), tSplash: null, fresh: true, local: new THREE.Vector3(), tImpact: 0, camLocal: new THREE.Vector3(), tLaunch: 0, tBlend: 0, chaseT: 0 };
}
// F has been pressed and the launcher is turning: the camera goes close to it, from the side of the way it will fire.
function startLauncherCine() {
  if (!cineOn || cine || view === 'orbit' || sim.out || !sim.shot) return;
  const aim = sim.shot.aim;
  const px = Math.sin(aim.yaw); // across the line of fire, in the ship's frame (x ahead, z to starboard)
  const pz = Math.cos(aim.yaw);
  const sign = px >= 0 ? 1 : -1; // the camera ahead of the launcher (never inside the ship), on whichever side the shot goes
  cine = newCine(null, sim.shot.droneId, 'slew');
  cine.camLocal.set(LAUNCHER_PIVOT.x + sign * px * 22, LAUNCHER_PIVOT.y + 3.5, LAUNCHER_PIVOT.z + sign * pz * 22);
}
function frameLauncher(c, progress) {
  ship.group.localToWorld(camera.position.copy(c.camLocal));
  camera.lookAt(ship.group.localToWorld(_c.copy(LAUNCHER_PIVOT).setY(LAUNCHER_PIVOT.y + 1.2)));
  return THREE.MathUtils.lerp(42, 28, THREE.MathUtils.smoothstep(progress, 0, 1)); // the zoom in on it
}
// The round leaves: the camera pulls out from the launcher to the side of the ship and frames her whole length.
const LAUNCH_WIDE_DIST = 190; // m abeam of the ship's middle
const LAUNCH_WIDE_TIME = 0.5; // s (simulated) of the pull-out
function frameLaunchWide(c, k) {
  const e = THREE.MathUtils.smoothstep(k, 0, 1);
  const sideZ = Math.sign(c.camLocal.z) || 1;
  _a.set(0, 14, sideZ * LAUNCH_WIDE_DIST);
  _a.lerpVectors(c.camLocal, _a, e);
  ship.group.localToWorld(camera.position.copy(_a));
  _b.copy(LAUNCHER_PIVOT).setY(LAUNCHER_PIVOT.y + 1.2);
  _c.set(0, 8, 0).lerp(_b, 1 - e).setY(THREE.MathUtils.lerp(LAUNCHER_PIVOT.y + 1.2, 8, e));
  _c.x = THREE.MathUtils.lerp(LAUNCHER_PIVOT.x, 0, e);
  camera.lookAt(ship.group.localToWorld(_c));
  return THREE.MathUtils.lerp(28, 46, e);
}
// The launcher is on: the camera goes through the director's sight to the drone. The director starts where the launcher
// points, hunts about the target for a moment (a short search) and locks; the sign comes with the lock.
function startSightCine() {
  if (!cine && cineOn && view !== 'orbit' && !sim.out && sim.shot) { // the launcher close-up did not start: the lock still goes through the sight
    cine = newCine(null, sim.shot.droneId, 'slew');
    cine.camLocal.set(LAUNCHER_PIVOT.x + 22, LAUNCHER_PIVOT.y + 3.5, LAUNCHER_PIVOT.z);
  }
  if (!cine || cine.phase !== 'slew') return;
  const d = sim.drones.find((x) => x.id === cine.did);
  if (!d || !sim.shot) return;
  const aim = sim.shot.aim;
  _a.set(Math.cos(aim.yaw) * Math.cos(aim.pitch), Math.sin(aim.pitch), -Math.sin(aim.yaw) * Math.cos(aim.pitch)).transformDirection(ship.group.matrixWorld);
  sight.aim.copy(_a);
  sight.fresh = false;
  sight.id = d.id;
  sight.phase = 'slew';
  sight.omega = 0;
  sight.searchTime = SIGHT_SEARCH_SHOT;
  cine.phase = 'sight';
  sightEl.hidden = false;
  document.body.classList.add('helm-sighting');
}
function startCine(missileId, droneId = null) {
  if (!cineOn || cine || view === 'orbit' || sim.out) return;
  if (missileId !== null) { // a missile leaves
    const m = sim.missiles.find((x) => x.id === missileId);
    if (!m || !sim.drones.some((d) => d.id === m.targetId && d.alive)) return;
    cine = newCine(m.id, m.targetId, 'approach');
  } else { // an attack run
    if (!sim.drones.some((d) => d.id === droneId && d.alive)) return;
    cine = newCine(null, droneId, 'dive');
  }
}
// A drone has hit the ship at e.pos: close in on the place, from outboard.
function cineStruck(e) {
  if (!cineOn || view === 'orbit') return;
  if (!cine) {
    cine = newCine(null, e.id, 'impact');
    cine.pos.copy(camera.position);
    cine.look.copy(e.pos);
    cine.fresh = false;
  }
  cine.cut = cine.phase !== 'dive2'; // from the final side camera the hit plays on from where it stands
  cine.phase = 'impact';
  cine.tImpact = sim.t;
  cine.local.copy(sim.toLocal(e.pos, _a)).setY(Math.max(e.pos.y, 8)); // the same point the fire burns at
  cine.side = 0;
}
function endCine() {
  timeTarget = 1;
  sight.searchTime = SIGHT_SEARCH;
  if (!cine) return;
  cine = null;
  snap = true; // the view that was on takes the camera back from where it is now
  sightEl.hidden = view !== 'sight';
  document.body.classList.toggle('helm-sighting', view === 'sight');
  if (pendingOrbit) { pendingOrbit = false; setView('orbit', true); }
}
// The side view of two points: the camera on one side of the line between them, far enough to have both in the frame
// and closer as they close; returns the lens (degrees), which closes in with them. `away`: put the camera on the far side
// from the ship (the missile's shot), otherwise on the side the camera is already on.
function frameSide(c, p, q, dt, away, tau = 0.12) {
  const pull = 1 - Math.exp(-dt / tau);
  const sep = p.distanceTo(q);
  _a.subVectors(q, p).setY(0);
  if (_a.lengthSq() < 1) _a.set(1, 0, 0);
  _a.normalize();
  _b.set(-_a.z, 0, _a.x); // to the side of the line between them
  const mid = _c.addVectors(p, q).multiplyScalar(0.5);
  if (!c.side) {
    const ref = away ? _d.set(mid.x - sim.x, 0, mid.z - sim.z) : _d.set(camera.position.x - mid.x, 0, camera.position.z - mid.z);
    c.side = _b.dot(ref) >= 0 ? 1 : -1;
  }
  const dist = THREE.MathUtils.clamp(sep * 1.45 + 45, 70, 6000);
  const want = _d.copy(mid).addScaledVector(_b, c.side * dist);
  want.y = Math.max(mid.y * 0.5 + dist * 0.07 + 6, 5);
  if (c.fresh) { c.pos.copy(want); c.look.copy(mid); c.fresh = false; } else { c.pos.lerp(want, pull); c.look.lerp(mid, pull); }
  camera.position.copy(c.pos);
  camera.lookAt(c.look);
  return THREE.MathUtils.clamp(28 + ((sep - 60) / 540) * 17, 28, 45);
}
// The attacking drone's shot, in two parts. When it really closes in (DRONE_CAM_RANGE) a camera on the sea, abeam of the
// ship, pans with it as it comes in, the lens closing; for its last DRONE_FINAL metres the camera stands fixed to the side of
// the line of the dive, drone and ship both in the frame, and the hit then plays out from that same side (frameImpact).
const DRONE_CAM_RANGE = 650; // m from the ship
const DRONE_FINAL = 230;
function frameDroneCam(c, d, dt) {
  const range = Math.hypot(d.pos.x - sim.x, d.pos.z - sim.z);
  if (c.phase === 'dive' && range < DRONE_FINAL) { // the fixed side camera of the final seconds, set once
    c.phase = 'dive2';
    _a.set(sim.x - d.pos.x, 0, sim.z - d.pos.z).normalize(); // the line of the dive
    _b.set(-_a.z, 0, _a.x); // to the side of it
    _c.set((d.pos.x + sim.x) / 2, 0, (d.pos.z + sim.z) / 2);
    c.side = _b.dot(_d.set(_c.x - sim.x, 0, _c.z - sim.z)) >= 0 ? 1 : -1;
    c.pos.copy(_c).addScaledVector(_b, c.side * 230).setY(14);
    c.look.copy(_c).setY(9);
    c.fresh = false;
  }
  if (c.phase === 'dive2') {
    _c.set(sim.x, 9, sim.z).lerp(d.pos, 0.5); // the middle of drone and ship
    c.look.lerp(_c, 1 - Math.exp(-dt / 0.2));
    camera.position.copy(c.pos);
    camera.lookAt(c.look);
    const sep = Math.hypot(d.pos.x - sim.x, d.pos.z - sim.z);
    return THREE.MathUtils.clamp(THREE.MathUtils.radToDeg(2 * Math.atan(sep * 0.78 / 230)), 26, 58); // both stay in the frame, the lens closing as they meet
  }
  if (!c.side) c.side = d.pos.clone().sub(ship.group.position).dot(_a.set(-Math.sin(sim.psi), 0, Math.cos(sim.psi))) >= 0 ? 1 : -1;
  ship.group.localToWorld(c.pos.set(0, 10, c.side * 85)); // abeam of her, low over the sea, moving with her
  c.look.lerp(d.pos, c.fresh ? 1 : 1 - Math.exp(-dt / 0.08));
  c.fresh = false;
  camera.position.copy(c.pos);
  camera.lookAt(c.look);
  return THREE.MathUtils.clamp(THREE.MathUtils.radToDeg(2 * Math.atan(55 / camera.position.distanceTo(d.pos))), 9, 40); // the lens opens as it comes nearer
}
// The hit: in close, from outboard, on the place; the ship moves, so it is followed in her own frame.
function frameImpact(c, dt) {
  if (sim.t - c.tImpact > IMPACT_HOLD) { endCine(); return null; }
  const P = ship.group.localToWorld(_c.copy(c.local));
  _a.set(-Math.sin(sim.psi), 0, Math.cos(sim.psi)); // starboard
  if (!c.side) c.side = _a.dot(_b.set(camera.position.x - sim.x, 0, camera.position.z - sim.z)) >= 0 ? 1 : -1; // the side it was filmed from
  const want = _d.copy(P).addScaledVector(_a, c.side * 115);
  want.y = P.y + 10;
  if (c.cut) { c.pos.copy(want); c.look.copy(P); c.cut = false; } // a cut to the side of the hit, not a move from the drone's shot
  c.pos.lerp(want, 1 - Math.exp(-dt / 0.6)); // the dolly in
  c.look.lerp(P, 1 - Math.exp(-dt / 0.15));
  camera.position.copy(c.pos);
  if (camera.position.y < 3) camera.position.y = 3;
  camera.lookAt(c.look);
  return 24;
}
// The missile in flight: the camera rides close behind and a little to the side of it, the exhaust trail and the round in
// the frame, looking on along the line to the drone, and the lens closes in as the drone gets nearer. It starts from the
// launcher and sweeps in over a second. (Far from a side view that has both in the frame, here the missile is big.)
function frameChase(c, m, d, dt) {
  const sep = m.pos.distanceTo(d.pos);
  _a.copy(m.dir).normalize();
  _b.crossVectors(_a, UP);
  if (_b.lengthSq() < 1e-4) _b.set(0, 0, 1);
  _b.normalize(); // to the right of the flight
  if (!c.side) c.side = _b.dot(_c.set(m.pos.x - sim.x, 0, m.pos.z - sim.z)) >= 0 ? 1 : -1; // the outboard side
  const want = _d.copy(m.pos).addScaledVector(_a, -24).addScaledVector(_b, c.side * 7);
  want.y = m.pos.y + 4.5;
  c.chaseT += dt;
  c.pos.copy(c.hold).lerp(want, THREE.MathUtils.smoothstep(c.chaseT, 0, 1)); // the sweep from the launcher, then rigid on the round
  _e.subVectors(d.pos, m.pos).normalize();
  c.look.lerp(_c.copy(m.pos).addScaledVector(_e, Math.min(sep, 50)), 1 - Math.exp(-dt / 0.06));
  camera.position.copy(c.pos);
  if (camera.position.y < 3) camera.position.y = 3;
  camera.lookAt(c.look);
  return 52 - 22 * THREE.MathUtils.smoothstep(THREE.MathUtils.clamp((1500 - sep) / 1200, 0, 1), 0, 1);
}
// Frames the shot; returns the lens (degrees), or null once the shot is over.
function updateCine(dt) {
  const c = cine;
  if (c.phase === 'impact') { timeTarget = 1; return frameImpact(c, dt); } // the hit on the ship: real time
  if (c.phase === 'slew') { // the launcher turns, fast: close on it
    if (!sim.shot) { endCine(); return null; } // cancelled
    timeTarget = SLOW.slew;
    return frameLauncher(c, (sim.t - c.t0) / SLEW_TIME);
  }
  if (c.phase === 'sight') { // through the director's sight: it finds the drone and locks on
    const dd = sim.drones.find((x) => x.id === c.did);
    if (!sim.shot || !dd || !dd.alive) { endCine(); return null; }
    timeTarget = 1;
    return aimSight(dt, dd);
  }
  if (c.phase === 'launch') { // the round leaves its cell: still on the launcher
    if (sim.t - c.tLaunch < LAUNCH_HOLD) { timeTarget = SLOW.launch; return frameLaunchWide(c, (sim.t - c.tLaunch) / LAUNCH_WIDE_TIME); }
    c.phase = 'approach'; // then the camera leaves the ship to follow it
    c.tBlend = sim.t;
    c.chaseT = 0;
    c.hold.copy(camera.position); // where the chase starts from
    c.pos.copy(camera.position);
    c.look.copy(ship.group.localToWorld(_c.copy(LAUNCHER_PIVOT)));
    c.fresh = false;
  }
  const m = sim.missiles.find((x) => x.id === c.mid);
  if (m) c.did = m.targetId; // it may have taken another drone
  const d = sim.drones.find((x) => x.id === c.did);
  if (sim.out || !d || sim.t - c.t0 > CINE_MAX) { endCine(); return null; }
  const pull = 1 - Math.exp(-dt / 0.12);
  const flying = c.phase === 'approach' || c.phase === 'close';
  if (flying && !d.alive && d.wreck && d.wreck.kind === 'missile') { c.phase = 'wreck'; c.hold.copy(c.pos); }
  if (flying && !m && d.alive && d.phase === 'attack') c.phase = 'dive'; // the missile is gone, the drone is still coming
  if (c.phase === 'approach' || c.phase === 'close') {
    if (!m || !d.alive) { endCine(); return null; } // the missile was lost, or the drone went into the sea: back to the view
    const sep = m.pos.distanceTo(d.pos);
    if (c.phase === 'approach' && sep < CLOSE_SEP) { c.phase = 'close'; c.side = 0; c.tBlend = sim.t; } // the last metres: to the side, slow
    if (c.phase === 'approach') { timeTarget = SLOW.fly; return frameChase(c, m, d, dt); }
    timeTarget = sep < HIT_SLOW_SEP ? SLOW.close : 1; // slow only in the last instant before the hit
    return frameSide(c, m.pos, d.pos, dt, false, 0.12 + 0.45 * (1 - THREE.MathUtils.clamp((sim.t - c.tBlend) / 1.0, 0, 1)));
  }
  if (c.phase === 'dive' || c.phase === 'dive2') {
    if (!d.alive) { endCine(); return null; } // (a hit on the ship comes as its own event)
    timeTarget = 1; // no slow motion for the drone's hit on the ship
    return frameDroneCam(c, d, dt);
  }
  // The missile's hit: the camera stays where it was and follows the falling pieces until the last one is in the sea.
  const v = vis.get(d.id);
  const tau = sim.t - d.wreck.t;
  if (c.tSplash === null && v?.debris) c.tSplash = d.wreck.t + Math.max(...v.debris.pieces.map((p) => p.tauWater));
  timeTarget = sim.t < d.wreck.t + HIT_SLOW_AFTER ? SLOW.wreck : 1; // the burst in slow motion, then on to the splash
  const tEnd = (c.tSplash ?? d.wreck.t + 8) + CINE_TAIL;
  if (sim.t >= tEnd) { endCine(); return null; }
  if (v?.debris) {
    _a.set(0, 0, 0);
    for (const p of v.debris.pieces) _a.add(v.debris.piecePos(p, tau, _b));
    _a.multiplyScalar(1 / v.debris.pieces.length);
  } else _a.copy(d.wreck.pos);
  c.look.lerp(_a, pull);
  camera.position.copy(c.hold);
  if (camera.position.y < 3) camera.position.y = 3;
  camera.lookAt(c.look);
  return 34;
}

function aimSight(dt, d) {
  // The fire-control director on the bridge roof. It is a real mount, not a camera glued to the drone: it turns at a
  // limited rate, so on entering the view, or when the target changes, it swings round to it with the lens wide, hunts
  // about the target for a moment (a wandering that dies away) while the lens closes in, and then locks on and tracks.
  ship.group.localToWorld(camera.position.copy(DIRECTOR_EYE));
  _a.subVectors(d.pos, camera.position);
  const r = _a.length();
  _a.divideScalar(r || 1); // the way to the target
  if (sight.fresh) { // from the bow, nearly level
    sight.aim.set(Math.cos(sim.psi), 0.06, Math.sin(sim.psi)).normalize();
    sight.fresh = false;
    sight.id = d.id;
    sight.phase = 'slew';
    sight.omega = 0;
  } else if (sight.id !== d.id) { // another target: the mount turns to it
    sight.id = d.id;
    sight.phase = 'slew';
  }
  const fovTrack = THREE.MathUtils.clamp(THREE.MathUtils.radToDeg(2 * Math.atan(22 / r)), 1.2, 30);
  let cmd = _a;
  let fovWant = SIGHT_WIDE;
  if (sight.phase === 'search') {
    const el = sim.t - sight.t0;
    const s = Math.min(el / sight.searchTime, 1);
    if (s >= 1) { sight.phase = 'lock'; if (!cine) showLock(d.id); } // (in a launch shot the lock sign comes from the launcher's own lock)
    else { // hunts about the target, the sweeps shrinking, while the lens closes in
      const A = THREE.MathUtils.degToRad(3.4) * (1 - s) * (1 - s);
      _b.crossVectors(_a, UP).normalize(); // to the right of the line of sight
      _c.crossVectors(_b, _a); // above it
      cmd = _d.copy(_a).addScaledVector(_b, A * Math.sin(el * 5.2 + 0.7)).addScaledVector(_c, A * 0.6 * Math.sin(el * 7.9 + 1.9)).normalize();
      fovWant = THREE.MathUtils.lerp(SIGHT_WIDE, fovTrack, s * s * (3 - 2 * s));
    }
  }
  if (sight.phase === 'lock') fovWant = fovTrack;
  // Turn toward the command at a limited rate, easing in and out of the movement.
  const e = sight.aim.angleTo(cmd);
  sight.omega += (Math.min(SIGHT_RATE, e * 9) - sight.omega) * (1 - Math.exp(-dt / 0.12));
  if (e > 1e-5) sight.aim.lerp(cmd, Math.min(sight.omega * dt, e) / e).normalize();
  const off = sight.aim.angleTo(_a);
  if (sight.phase === 'slew' && off < THREE.MathUtils.degToRad(1.5)) { sight.phase = 'search'; sight.t0 = sim.t; }
  else if (sight.phase === 'lock' && off > THREE.MathUtils.degToRad(3.5)) sight.phase = 'slew'; // lost it: swing back onto it
  camera.lookAt(_e.copy(camera.position).add(sight.aim));
  const wantFov = Math.max(fovWant * sightZoom, 1);
  const found = sight.phase === 'lock';
  sightTxt.textContent = found
    ? `${d.name} · ${relName(sim.relBearing(d.pos))} · ${kmText(sim.rangeTo(d.pos))} · ${Math.round(d.pos.y)} m${sim.engageable(d) ? '' : ' · IN ARC'}`
    : `${d.name} · searching…`;
  sightEl.classList.toggle('lock', found && !sim.engageable(d));
  sightEl.classList.toggle('searching', !found);
  return wantFov;
}

function updateCamera(dt) {
  if (!cine && cineOn && view !== 'orbit' && !sim.out) { // a drone on its attack run really closing in: its own short shot
    const a = sim.drones.find((x) => x.alive && x.phase === 'attack' && Math.hypot(x.pos.x - sim.x, x.pos.z - sim.z) < DRONE_CAM_RANGE);
    if (a) startCine(null, a.id);
  }
  if (cine) {
    const f = updateCine(dt);
    if (f !== null) {
      fov += (f - fov) * (1 - Math.exp(-dt / 0.15));
      setFov(fov);
      return;
    }
  }
  const k = 1 - Math.exp(-dt / 0.5);
  let wantFov = 50;
  if (view === 'orbit') {
    rig.update();
    controls.update();
    if (camera.position.y < 2) camera.position.y = 2;
  } else if (view === 'bridge') {
    ship.group.localToWorld(camera.position.copy(BRIDGE_EYE));
    const yaw = THREE.MathUtils.degToRad(lookYaw);
    _a.set(Math.cos(yaw) * Math.cos(lookPitch), Math.sin(lookPitch), Math.sin(yaw) * Math.cos(lookPitch)).transformDirection(ship.group.matrixWorld);
    lookAt.copy(camera.position).add(_a);
    camera.lookAt(lookAt);
    wantFov = 55;
  } else if (view === 'above') {
    // Straight down, the bow at the top of the screen.
    camera.position.set(sim.x, aboveH, sim.z);
    camera.up.set(Math.cos(sim.psi), 0, Math.sin(sim.psi));
    camera.lookAt(sim.x, 0, sim.z);
  } else if (view === 'missile' && sim.missiles.length) {
    const m = sim.missiles[sim.missiles.length - 1];
    camera.position.copy(m.pos).addScaledVector(m.dir, -10).y += 1.6;
    const tgt = sim.drones.find((d) => d.id === m.targetId);
    lookAt.copy(m.pos).addScaledVector(m.dir, 40);
    if (tgt && tgt.alive) lookAt.lerp(tgt.pos, 0.35);
    camera.lookAt(lookAt);
    snap = true;
  } else if (view === 'target' && sim.target && sim.target.alive) {
    // Close behind the target drone, a little above, looking along its flight; the camera shakes like a hand-held lens.
    const d = sim.target;
    _a.copy(d.vel).normalize();
    camera.position.copy(d.pos).addScaledVector(_a, -15).y += 3.2;
    lookAt.copy(d.pos).addScaledVector(_a, 30);
    camera.lookAt(lookAt);
    const ts = performance.now() / 1000;
    camera.position.x += 0.07 * Math.sin(ts * 41) + 0.04 * Math.sin(ts * 67 + 1);
    camera.position.y += 0.07 * Math.sin(ts * 47 + 2) + 0.03 * Math.sin(ts * 71);
    camera.position.z += 0.07 * Math.sin(ts * 37 + 4) + 0.04 * Math.sin(ts * 59 + 3);
    camera.rotateX(0.0012 * Math.sin(ts * 43 + 1) + 0.0007 * Math.sin(ts * 73));
    camera.rotateY(0.0012 * Math.sin(ts * 39 + 5) + 0.0007 * Math.sin(ts * 61 + 2));
    camera.rotateZ(0.0014 * Math.sin(ts * 31 + 3));
    wantFov = 46;
  } else if (view === 'sight' && sim.target) {
    wantFov = aimSight(dt, sim.target);
  } else {
    // Behind her (also the fallback for the missile and sight views with nothing to show).
    if (snap) camYaw = sim.psi;
    else camYaw += Math.atan2(Math.sin(sim.psi - camYaw), Math.cos(sim.psi - camYaw)) * k;
    const ang = camYaw + THREE.MathUtils.degToRad(behindYaw);
    camera.position.set(sim.x - Math.cos(ang) * behindDist, behindDist * 0.06 + 12, sim.z - Math.sin(ang) * behindDist);
    // Low and close, on the ship herself and looking a little up (about 3.5 degrees above the horizon): she fills the middle of
    // the frame, the bridge and mast against the sky.
    lookAt.set(sim.x + Math.cos(camYaw) * 10, camera.position.y + (behindDist + 10) * 0.062, sim.z + Math.sin(camYaw) * 10);
    camera.lookAt(lookAt);
    snap = false;
    if (view === 'sight') sightTxt.textContent = 'No target on the radar';
  }
  fov += (wantFov - fov) * (view === 'sight' ? 1 - Math.exp(-dt / 0.3) : 1);
  setFov(fov);
}

// --- The radar picture ---------------------------------------------------------------------------------------------------
// A small square at the bottom right, as big as the map, that always shows the fire-control sight: its own mount (the same
// rules as the Radar view: it swings onto the current target, hunts about it, then locks and tracks) and a + on the target,
// whatever the main camera is doing. It is drawn as a second pass of the scene into that square.
const pipEl = document.createElement('div');
pipEl.className = 'helm-pip';
pipEl.innerHTML = '<i class="hp-h"></i><i class="hp-v"></i><i class="hp-box"></i><b class="hp-txt"></b><em>SCOPE</em>';
document.body.appendChild(pipEl);
const pipTxt = pipEl.querySelector('.hp-txt');
const pipCam = new THREE.PerspectiveCamera(24, 1, 0.3, 30000);
const pipSt = { id: null, phase: 'slew', t0: 0, omega: 0, aim: new THREE.Vector3(1, 0.06, 0), fresh: true };
let pipFov = 24;
const pipV3 = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
// What the scope watches. By default the target drone; once a missile leaves, the missile until it reaches the drone, then
// the falling wreck of that drone until the last piece is in the sea.
const pipFocus = { key: null, pos: new THREE.Vector3(), size: 4.5, name: '', kind: 'drone' };
const pipWatch = { did: null };
function pipPick() {
  const m = sim.missiles[sim.missiles.length - 1];
  if (m) {
    pipWatch.did = m.targetId;
    pipFocus.key = `m${m.id}`; pipFocus.pos.copy(m.pos); pipFocus.size = 6; pipFocus.name = 'MISSILE'; pipFocus.kind = 'missile';
    return true;
  }
  const w = pipWatch.did === null ? null : sim.drones.find((x) => x.id === pipWatch.did);
  if (w && !w.alive && w.wreck) {
    const v = vis.get(w.id);
    const tEnd = v?.debris ? w.wreck.t + Math.max(...v.debris.pieces.map((q) => q.tauWater)) : w.wreck.t + 8;
    if (sim.t < tEnd) {
      if (v?.debris) {
        const tau = sim.t - w.wreck.t;
        pipFocus.pos.set(0, 0, 0);
        for (const q of v.debris.pieces) pipFocus.pos.add(v.debris.piecePos(q, tau, pipV3[3]));
        pipFocus.pos.multiplyScalar(1 / v.debris.pieces.length);
      } else pipFocus.pos.copy(w.wreck.pos);
      pipFocus.key = `w${w.id}`; pipFocus.size = 16; pipFocus.name = `${w.name} DOWN`; pipFocus.kind = 'wreck';
      return true;
    }
    pipWatch.did = null;
  }
  return false;
}
function updatePip(dt) {
  const [pa, pb, pc, pd] = pipV3;
  ship.group.localToWorld(pipCam.position.copy(DIRECTOR_EYE));
  const d = sim.target && sim.target.alive ? sim.target : null;
  if (pipSt.fresh) { pipSt.aim.set(Math.cos(sim.psi), 0.06, Math.sin(sim.psi)).normalize(); pipSt.fresh = false; }
  if (!pipPick()) {
    if (d) { pipFocus.key = d.id; pipFocus.pos.copy(d.pos); pipFocus.size = 4.5; pipFocus.name = d.name; pipFocus.kind = 'drone'; }
    else pipFocus.key = null;
  }
  if (pipFocus.key === null) { // nothing to look at: the mount rests along the bow
    pipSt.id = null;
    pipSt.phase = 'slew';
    pipSt.aim.lerp(pa.set(Math.cos(sim.psi), 0.06, Math.sin(sim.psi)).normalize(), 1 - Math.exp(-dt / 0.4)).normalize();
    pipFov += (SIGHT_WIDE - pipFov) * (1 - Math.exp(-dt / 0.3));
    pipCam.lookAt(pb.copy(pipCam.position).add(pipSt.aim));
    pipEl.classList.remove('lock');
    pipEl.classList.add('searching');
    pipTxt.textContent = 'no target';
    return;
  }
  pa.subVectors(pipFocus.pos, pipCam.position);
  const r = pa.length();
  pa.divideScalar(r || 1);
  if (pipSt.id !== pipFocus.key) { pipSt.id = pipFocus.key; pipSt.phase = 'slew'; }
  const fovTrack = THREE.MathUtils.clamp(THREE.MathUtils.radToDeg(2 * Math.atan(pipFocus.size / r)), 0.15, 30); // the lens closes until it fills the square
  let cmd = pa;
  let fovWant = SIGHT_WIDE;
  if (pipSt.phase === 'search') {
    const el = sim.t - pipSt.t0;
    const s = Math.min(el / SIGHT_SEARCH, 1);
    if (s >= 1) pipSt.phase = 'lock';
    else {
      const A = THREE.MathUtils.degToRad(3.4) * (1 - s) * (1 - s);
      pb.crossVectors(pa, UP).normalize();
      pc.crossVectors(pb, pa);
      cmd = pd.copy(pa).addScaledVector(pb, A * Math.sin(el * 5.2 + 0.7)).addScaledVector(pc, A * 0.6 * Math.sin(el * 7.9 + 1.9)).normalize();
      fovWant = THREE.MathUtils.lerp(SIGHT_WIDE, fovTrack, s * s * (3 - 2 * s));
    }
  }
  if (pipSt.phase === 'lock') { fovWant = fovTrack; pipSt.aim.copy(pa); } // locked: held exactly on it
  const e = pipSt.aim.angleTo(cmd);
  pipSt.omega += (Math.min(SIGHT_RATE * (pipFocus.kind === 'drone' ? 1 : 3), e * 9) - pipSt.omega) * (1 - Math.exp(-dt / 0.12));
  if (e > 1e-5) pipSt.aim.lerp(cmd, Math.min(pipSt.omega * dt, e) / e).normalize();
  const off = pipSt.aim.angleTo(pa);
  if (pipSt.phase === 'slew' && off < THREE.MathUtils.degToRad(1.5)) { // on it: the drone is hunted for, the missile and the wreck are held at once
    pipSt.phase = pipFocus.kind === 'drone' ? 'search' : 'lock';
    pipSt.t0 = sim.t;
  } else if (pipSt.phase === 'lock' && off > THREE.MathUtils.degToRad(3.5)) pipSt.phase = 'slew';
  pipCam.lookAt(pb.copy(pipCam.position).add(pipSt.aim));
  pipFov += (fovWant - pipFov) * (1 - Math.exp(-dt / (pipFocus.kind === 'drone' ? 0.15 : 0.08)));
  const found = pipSt.phase === 'lock';
  pipEl.classList.toggle('lock', found);
  pipEl.classList.toggle('searching', !found);
  pipTxt.textContent = found ? `${pipFocus.name} · ${kmText(r)}` : `${pipFocus.name} · searching…`;
}
const pipRect = { x: 0, y: 0, w: 0, h: 0 };
function renderPip() {
  const r = pipEl.getBoundingClientRect();
  if (r.width < 8) return;
  pipRect.x = r.left; pipRect.y = window.innerHeight - r.bottom; pipRect.w = r.width; pipRect.h = r.height;
  pipCam.fov = pipFov;
  pipCam.aspect = 1;
  pipCam.updateProjectionMatrix();
  const keepScale = pointScale.value;
  pointScale.value = (r.height * renderer.getPixelRatio()) / (2 * Math.tan(THREE.MathUtils.degToRad(pipFov / 2)));
  const auto = renderer.shadowMap.autoUpdate;
  renderer.shadowMap.autoUpdate = false;
  renderer.setScissorTest(true);
  renderer.setViewport(pipRect.x, pipRect.y, pipRect.w, pipRect.h);
  renderer.setScissor(pipRect.x, pipRect.y, pipRect.w, pipRect.h);
  const shipShown = ship.group.visible;
  ship.group.visible = false; // the sight looks out from inside her: her own body never blocks it, even into the dead zone
  renderer.render(scene, pipCam);
  ship.group.visible = shipShown;
  renderer.setScissorTest(false);
  renderer.setViewport(0, 0, window.innerWidth, window.innerHeight);
  renderer.shadowMap.autoUpdate = auto;
  pointScale.value = keepScale;
}

let behindYaw = 0;
let sightZoom = 1;
// The fire-control director's mount (see updateCamera): its aim, its turning speed and where it is in finding the target.
const SIGHT_RATE = THREE.MathUtils.degToRad(55); // the fastest it turns, per second
const SIGHT_WIDE = 24; // degrees: the lens while it looks for the target
const SIGHT_SEARCH = 1.7; // s of hunting about the target before it locks
const SIGHT_SEARCH_SHOT = 0.55; // s of it in the shot of a launch: the launcher is already on
const UP = new THREE.Vector3(0, 1, 0);
const sight = { id: null, phase: 'slew', t0: 0, omega: 0, fresh: true, searchTime: SIGHT_SEARCH, aim: new THREE.Vector3(1, 0, 0) };

// Drag on the bridge looks round; drag behind swings round her; the wheel zooms (or narrows the sight). The view turns
// the way the mouse goes, as in the free orbit: drag left and it turns left, drag up and (on the bridge) it looks up.
let drag = null;
canvas.addEventListener('pointerdown', (e) => { if (e.button === 0 && view !== 'orbit') drag = { x: e.clientX, y: e.clientY }; });
window.addEventListener('pointerup', () => { drag = null; });
window.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const dx = e.clientX - drag.x;
  const dy = e.clientY - drag.y;
  drag = { x: e.clientX, y: e.clientY };
  if (view === 'bridge') {
    lookYaw = ((lookYaw + dx * 0.25 + 540) % 360) - 180; // lookYaw is + to starboard: dragging left (dx < 0) looks to port
    lookPitch = THREE.MathUtils.clamp(lookPitch - dy * 0.004, -0.9, 0.6);
  } else if (view === 'behind') behindYaw += dx * 0.3; // the camera swings to starboard, so the view turns to port
});
canvas.addEventListener('dblclick', () => { lookYaw = 0; lookPitch = -0.03; behindYaw = 0; behindDist = BEHIND_DIST; aboveH = 520; sightZoom = 1; });
canvas.addEventListener('wheel', (e) => {
  if (view === 'behind') behindDist = THREE.MathUtils.clamp(behindDist * Math.exp(e.deltaY * 0.001), 60, 1200);
  else if (view === 'above') aboveH = THREE.MathUtils.clamp(aboveH * Math.exp(e.deltaY * 0.001), 150, 4000);
  else if (view === 'sight') sightZoom = THREE.MathUtils.clamp(sightZoom * Math.exp(e.deltaY * 0.001), 0.3, 4);
}, { passive: true });

// --- Readouts --------------------------------------------------------------------------------------------------------
const root = document.querySelector('#hud');
const live = root.querySelector('.hud-live');
root.querySelector('.hud-debrief').hidden = true;
root.querySelector('.hud-spark')?.remove();
let hudOn = true;
let lastHtml = '';
const f = (v, d = 0) => v.toFixed(d);
const tile = (label, value, unit, cls = '') => `<div class="tile ${cls}"><span>${label}</span><b>${value}${unit ? `<small>${unit}</small>` : ''}</b></div>`;
const head = (title, chip, tone) => `<div class="hud-head"><b>${title}</b><span class="chip ${tone}">${chip}</span></div>`;

// The ship's own instruments, in a strip at the foot of the screen above the keys: the wheel, the telegraph, the rounds.
const shipEl = document.createElement('div');
shipEl.id = 'helm-ship';
shipEl.className = 'helm-ship';
document.body.appendChild(shipEl);
let lastShip = '';
// The dome: its rim is a heading tape (the degrees slide round it, the heading itself fixed and bold at the top), inside it
// a needle from the foot swings left and right with the rudder, and the speed is under the needle.
const DOME_R = 94; // svg units, the rim
const DOME_K = 1.5; // degrees of arc on the dome per degree of heading
function domeSvg() {
  const h = sim.headingDeg;
  const cx = 100;
  const cy = 100;
  const pt = (r, a) => `${(cx + r * Math.cos(a)).toFixed(1)},${(cy - r * Math.sin(a)).toFixed(1)}`;
  let ticks = '';
  let labels = '';
  for (let d = Math.ceil((h - 58) / 5) * 5; d <= h + 58; d += 5) {
    const a = Math.PI / 2 - THREE.MathUtils.degToRad((d - h) * DOME_K);
    if (a < 0.05 || a > Math.PI - 0.05) continue;
    const major = d % 30 === 0;
    ticks += `<line x1="${pt(DOME_R, a).split(',')[0]}" y1="${pt(DOME_R, a).split(',')[1]}" x2="${pt(DOME_R - (major ? 9 : d % 10 === 0 ? 6 : 3.5), a).split(',')[0]}" y2="${pt(DOME_R - (major ? 9 : d % 10 === 0 ? 6 : 3.5), a).split(',')[1]}" class="${major ? 'mj' : ''}"/>`;
    if (d % 30 === 0 && Math.abs(d - h) > 11) {
      const [x, y] = pt(DOME_R - 21, a).split(',');
      labels += `<text x="${x}" y="${y}" class="dl">${String(((d % 360) + 360) % 360).padStart(3, '0')}</text>`;
    }
  }
  // The rudder: an arc just inside the scale, from the top (midships) filling left in red (port) or right in green (starboard).
  const RR = 60;
  const span = THREE.MathUtils.degToRad(62);
  const fr = THREE.MathUtils.clamp(sim.rudder / RUDDER_MAX, -1, 1);
  const th = fr * span;
  const p0 = pt(RR, Math.PI / 2).split(',');
  const p1 = pt(RR, Math.PI / 2 - th).split(',');
  const pl = pt(RR, Math.PI / 2 + span).split(',');
  const pr = pt(RR, Math.PI / 2 - span).split(',');
  const fill = Math.abs(th) > 0.01
    ? `<path d="M${p0[0]},${p0[1]} A${RR},${RR} 0 0 ${th > 0 ? 1 : 0} ${p1[0]},${p1[1]}" class="rf ${th > 0 ? 'stbd' : 'port'}"/>` : '';
  return `<svg viewBox="0 0 200 104" class="dome-svg" aria-hidden="true">`
    + `<path d="M6,100 A${DOME_R},${DOME_R} 0 0 1 194,100" class="rim"/>${ticks}${labels}`
    + `<path d="M${cx - 4},${cy - DOME_R - 1} L${cx + 4},${cy - DOME_R - 1} L${cx},${cy - DOME_R + 6} Z" class="lub"/>`
    + `<text x="${cx}" y="${cy - DOME_R + 21}" class="hd">${f(((h % 360) + 360) % 360).padStart(3, '0')}°</text>`
    + `<path d="M${pl[0]},${pl[1]} A${RR},${RR} 0 0 1 ${pr[0]},${pr[1]}" class="rt"/>${fill}`
    + `<line x1="${p0[0]}" y1="${(Number(p0[1]) - 5).toFixed(1)}" x2="${p0[0]}" y2="${(Number(p0[1]) + 5).toFixed(1)}" class="rm"/>`
    + `<text x="${cx}" y="94" class="sp">${f(sim.knots, 1)}<tspan> kn</tspan></text></svg>`;
}
function shipHtml() {
  let wTxt = `${sim.cellsLeft} of ${CELLS} ready`;
  if (sim.shot) wTxt = sim.shot.locked ? 'target locked' : sim.shot.acquiring ? 'acquiring' : 'launcher turning';
  else if (sim.missiles.length) wTxt = `${sim.missiles.length} in flight`;
  const pips = Array.from({ length: CELLS }, (_, i) => `<i class="${i < sim.cellsLeft ? 'on' : ''}"></i>`).join('');
  const hits = Array.from({ length: 3 }, (_, i) => `<i class="${i < sim.strikes ? 'hit' : ''}"></i>`).join('');
  const dmg = sim.out ? 'out of action' : sim.strikes ? `${sim.strikes} of 3 hits` : 'no damage';
  return `<div class="hs-rect hs-dmg${sim.strikes ? ' hurt' : ''}"><span>Damage · ${dmg}</span><div class="hs-pips hs-hits">${hits}</div></div>`
    + `<div class="hs-dome">${domeSvg()}</div>`
    + `<div class="hs-rect hs-ammo"><span>Missiles · ${wTxt}</span><div class="hs-pips">${pips}</div></div>`;
}

function hudHtml() {
  const out = [];
  // The drone data: the target, then the radar contacts.
  const t = sim.target;
  let tTiles = tile('Target', 'none', '', 'wide');
  let tChip = ['No target', ''];
  if (t) {
    const why = sim.engageable(t);
    tChip = why ? ['Out of arc', 'warn'] : ['In arc, ready', 'live'];
    tTiles = tile('Target', t.name, '') + tile('Bearing', relName(sim.relBearing(t.pos)), '', 'brg')
      + tile('Range', kmText(sim.rangeTo(t.pos)), '', sim.rangeTo(t.pos) < 1500 ? 'threat-high' : sim.rangeTo(t.pos) < 3000 ? 'threat' : '')
      + tile('Height', f(t.pos.y), 'm')
      + tile('F', why ? why.replace(/: turn the ship$/, '') : 'in arc, ready', '', `wide ${why ? 'threat' : 'helm-ok'}`);
  }
  out.push(`<div class="hud-sec">${head('Target', ...tChip)}<div class="tiles">${tTiles}</div></div>`);

  // The radar picture: every contact on one line.
  const contacts = sim.detected.sort((a, b) => sim.rangeTo(a.pos) - sim.rangeTo(b.pos));
  const word = { inbound: 'inbound', pass: 'low pass', extend: 'opening', attack: 'ATTACK RUN' };
  const rows = contacts.map((d) => `<div class="helm-contact ${d.phase}${d.id === sim.targetId ? ' sel' : ''}"><b>${d.name}</b>`
    + `<span>${relName(sim.relBearing(d.pos))}</span><span>${kmText(sim.rangeTo(d.pos))}</span><em>${word[d.phase] ?? d.phase}</em></div>`).join('');
  const thr = ['Clear', 'Contact', 'Threat close', 'Under attack'][sim.threat];
  out.push(`<div class="hud-sec">${head('Radar', thr, ['ok', 'warn', 'bad', 'bad'][sim.threat])}`
    + `${rows || '<div class="helm-contact none">No contacts</div>'}`
    + `<div class="helm-score">Drones down <b>${sim.kills}</b> · hits taken <b>${sim.strikes}</b> of 3</div></div>`);
  return out.join('');
}

// The line of keys at the foot of the screen.
const keysEl = document.createElement('div');
keysEl.id = 'fly-keys';
keysEl.className = 'fly-keys';
document.body.appendChild(keysEl);
let lastKeys = '';
let lastKeysH = 0;
function keysHtml() {
  const k = (key, label, on = false) => `<span class="fk${on ? ' on' : ''}"><kbd>${key}</kbd>${label}</span>`;
  if (sim.out) return `${k('R', 'sail again', true)}${k('V', 'camera')}`;
  const t = sim.target;
  const ready = t && !sim.engageable(t) && !sim.shot && sim.cellsLeft > 0;
  return `${k('←', '')}${k('→', 'rudder')}${k('↑', '')}${k('↓', 'telegraph')}${k('F', 'fire', ready)}`
    + `${k('Tab', 'target', sim.detected.length > 1)}${k('1–7', 'views')}${k('V', 'next view')}`;
}

// --- Interface: the top bar, menu, keys sheet, sound, map ---------------------------------------------------------------
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
let folded = false;
try { folded = localStorage.getItem(FOLD_KEY) === '1'; } catch { /* storage unavailable */ }
setFolded(folded, false);
document.querySelector('#btn-ship').addEventListener('click', () => {
  try { sessionStorage.setItem('intercept.chooser', '1'); location.reload(); } catch { location.search = ''; }
});
document.querySelector('#btn-home')?.addEventListener('click', () => document.querySelector('#btn-ship')?.click());
{
  const t = menuText('helm');
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
audio.setEnabled(soundPref);
soundButton.classList.toggle('active', soundPref);
soundButton.setAttribute('aria-pressed', String(soundPref));
soundButton.title = 'Sound: the ship, the drones, the missiles and the alarms (S)';
if (!audio.supported) { soundButton.disabled = true; soundButton.title = 'Sound is not available in this browser'; }
soundButton.addEventListener('click', () => setSound(!audio.enabled));

const restartButton = document.createElement('button');
restartButton.id = 'btn-restart';
restartButton.setAttribute('role', 'menuitem');
restartButton.innerHTML = 'Sail again<kbd>R</kbd>';
menuEl.insertBefore(restartButton, menuEl.firstChild);
restartButton.addEventListener('click', () => restart());

const map = createHelmMap();
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
  shipEl.hidden = !on;
  hudButton.classList.toggle('active', on);
  hudButton.setAttribute('aria-pressed', String(on));
}
hudButton.addEventListener('click', () => setHud(!hudOn));
setHud(true);
let tagsOn = true;

// The view buttons: a strip at the top centre.
const strip = document.createElement('div');
strip.className = 'helm-views';
strip.innerHTML = VIEWS.map((v, i) => `<button type="button" data-view="${v}" title="${VIEW_NAMES[v]} (${i + 1})">${['Bridge', 'Behind', 'Above', 'Missile', 'Radar', 'Target', 'Orbit'][i]}</button>`).join('');
document.body.appendChild(strip);
const viewButtons = [...strip.querySelectorAll('button')];
viewButtons.forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));

keysSheet.querySelector('dl').innerHTML = [
  ['<kbd>←</kbd> <kbd>→</kbd>', 'Rudder to port / starboard while held; let go and it comes back amidships'],
  ['<kbd>↑</kbd> <kbd>↓</kbd>', 'Engine telegraph, one step: slow astern, stop, dead slow, slow, half, full, flank'],
  ['<kbd>F</kbd>', `Fire a missile at the target (${CELLS} cells; ${kmText(MISSILE_RANGE)} at most; ahead and abeam only)`],
  ['<kbd>Tab</kbd>', 'Next target'],
  ['<kbd>1</kbd> to <kbd>6</kbd>', 'Bridge, behind, above, missile, radar, orbit'],
  ['<kbd>V</kbd>', 'Next view · drag looks round, the wheel zooms, double click resets'],
  ['<kbd>R</kbd>', 'Sail again'],
  ['<kbd>M</kbd>', 'Radar (click it to change the range)'],
  ['<kbd>L</kbd>', 'Tags on the drones'],
  ['<kbd>S</kbd>', 'Sound on / off'],
  ['<kbd>H</kbd> <kbd>C</kbd>', 'Readouts, hide the interface'],
].map(([k, d]) => `<dt>${k}</dt><dd>${d}</dd>`).join('');
keysSheet.querySelector('.keys-note').textContent = 'A drone you leave alone makes one low pass, then dives into the ship on its second approach · the guns are coming';

// --- Keys ------------------------------------------------------------------------------------------------------------
const input = { left: 0, right: 0 };
function restart() {
  sim.seed = (Date.now() % 100000) | 0;
  sim.reset();
  for (const id of [...vis.keys()]) dropVis(id);
  for (const [, v] of mvis) scene.remove(v.model.group);
  mvis.clear();
  strikes.length = 0;
  fx.clear();
  audio.reset();
  banner.hidden = true;
  wakeHist.length = 0;
  timeScale = timeTarget = 1;
  setView('behind', true);
  say('Half ahead on 000: watch the radar', '', 3000);
}

window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLElement && e.target.closest('input, textarea, select')) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    input[e.key === 'ArrowLeft' ? 'left' : 'right'] = 1;
    e.preventDefault();
    return;
  }
  if (e.key === 'Tab') { e.preventDefault(); if (!e.repeat) sim.cycleTarget(); return; }
  if (e.repeat) { if (e.key.startsWith('Arrow')) e.preventDefault(); return; }
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  switch (key) {
    case 'ArrowUp': sim.telegraph(+1); break;
    case 'ArrowDown': sim.telegraph(-1); break;
    case 'f': sim.fire(); break;
    case 'r': restart(); break;
    case 'v': setView(VIEWS[(VIEWS.indexOf(view) + 1) % VIEWS.length]); break;
    case '1': case '2': case '3': case '4': case '5': case '6': case '7': setView(VIEWS[Number(key) - 1]); break;
    case 'h': setHud(!hudOn); break;
    case 'm': setMap(!map.enabled); break;
    case 'i':
      cineOn = !cineOn;
      if (!cineOn) endCine();
      try { localStorage.setItem('intercept.helmcine', cineOn ? '1' : '0'); } catch { /* storage unavailable */ }
      say(cineOn ? 'Intercept camera on: the launch, the flight and the hit, slow motion just before it' : 'Intercept camera off', '', 2400);
      break;
    case 'l': tagsOn = !tagsOn; say(tagsOn ? 'Tags on' : 'Tags off', '', 1200); break;
    case 's': setSound(!audio.enabled); break;
    case 'c': setFolded(!document.body.classList.contains('ui-hidden')); break;
    case '?': setKeys(keysSheet.hidden); break;
    case 'Escape': closePopovers(); break;
    case ' ': break;
    default: return;
  }
  if (key !== 'Escape') e.preventDefault();
});
window.addEventListener('keyup', (e) => {
  if (e.key === 'ArrowLeft') input.left = 0;
  if (e.key === 'ArrowRight') input.right = 0;
});
window.addEventListener('blur', () => { input.left = 0; input.right = 0; });

// --- Loop ---------------------------------------------------------------------------------------------------------------
function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h, false);
  labels.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  pointScale.value = (h * renderer.getPixelRatio()) / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));
}
window.addEventListener('resize', resize);
resize();

let last = performance.now();
let frames = 0;
let lastThreat = 0;
renderer.setAnimationLoop((now) => {
  const dt = Math.max(0, Math.min((now - last) / 1000, 0.1));
  last = now;
  timeScale += (timeTarget - timeScale) * (1 - Math.exp(-dt / 0.2));
  if (Math.abs(timeTarget - timeScale) < 0.005) timeScale = timeTarget;
  document.body.classList.toggle('helm-slowmo', timeScale < 0.85);
  sim.advance(dt * timeScale, input);
  handleEvents();
  applyState(dt);
  updateCamera(dt);
  updatePip(dt);
  audio.update(sim, camera, dt);
  env.follow(camera.position);
  env.setShadowFocus(_b.set(sim.x, 0, sim.z), 90);
  fx.update(sim.t);
  map.update(sim);
  const threat = sim.threat;
  if (threat !== lastThreat) {
    document.body.classList.toggle('helm-threat-2', threat === 2);
    document.body.classList.toggle('helm-threat-3', threat === 3);
    lastThreat = threat;
  }
  if (hudOn) {
    const html = hudHtml();
    if (html !== lastHtml) { live.innerHTML = html; lastHtml = html; }
    const sh = shipHtml();
    if (sh !== lastShip) { shipEl.innerHTML = sh; lastShip = sh; }
  }
  const keys = keysHtml();
  if (keys !== lastKeys) { keysEl.innerHTML = keys; lastKeys = keys; }
  const kh = keysEl.offsetHeight;
  if (kh !== lastKeysH) { lastKeysH = kh; document.documentElement.style.setProperty('--keys-h', `${kh}px`); }
  if (!banner.hidden && performance.now() > bannerUntil) banner.hidden = true;
  const sightCam = view === 'sight' || (cine && cine.phase === 'sight');
  if (sightCam) ship.group.visible = false; // the sight looks out from inside her: her own body never blocks it
  renderer.render(scene, camera);
  if (sightCam) ship.group.visible = true;
  renderPip();
  labels.render(scene, camera);
  if (frames++ === 0) loadingEl?.remove();
});

setView('behind', true);
say('Half ahead on 000. ← → rudder, ↑ ↓ telegraph: watch the radar for drones', '', 5200);
window.__helm = { sim, camera, controls, rig, renderer, scene, env, fx, ship: ship.group, setView, restart, get view() { return view; }, get cine() { return cine; } };

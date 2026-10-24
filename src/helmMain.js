import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { createEnvironment, ridgeAngle } from './environment.js';
import { createShip } from './models/ship.js';
import { createBridge } from './models/bridge.js';
import { createPlane } from './models/plane.js';
import { createMissile } from './models/missile.js';
import { createGatling } from './models/gatling.js';
import { createDebris } from './fx/effects.js';
import { createLiveFx } from './fx/liveFx.js';
import { pointScale } from './fx/particles.js';
import { createWake } from './fx/wake.js';
import { CameraRig } from './cameraRig.js';
import { LAUNCHER_PIVOT } from './scenario.js';
import { createHelmMap } from './helmMap.js';
import { createHelmAudio } from './helmAudio.js';
import { menuText } from './menu.js';
import {
  HelmSim, SLEW_TIME, TELEGRAPH, RUDDER_MAX, CELLS, MISSILE_RANGE, MIN_RANGE, GUN_RANGE, GUN_BLOCK, RADAR_RANGE, ARC, BRIDGE_EYE, DIRECTOR_EYE, GUN_MOUNTS, GUN_ROUNDS, DRONE_HP, relName, kmText,
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

const env = createEnvironment(renderer, scene, { calm: true, tallMountains: true });
env.setShadowSize(1024);
env.ocean.material.uniforms.uShipX.value = 1e7; // the shader's straight-line wake: this ship turns, she has her own
const ship = createShip({ catapult: false, helicopter: true });
ship.group.rotation.order = 'YXZ'; // heading, then heel, then trim
scene.add(ship.group);
const bridge = createBridge(); // the wheelhouse's inside, shown only in the bridge view
bridge.group.visible = false;
ship.group.add(bridge.group);
const fx = createLiveFx(scene);
// The two 30 mm rotary guns on the aft deckhouse roof, and their tracers (a pool of short lines flying on a ballistic path).
const gatlings = GUN_MOUNTS.map((m) => {
  const g = createGatling();
  g.group.position.copy(m);
  g.group.position.y -= 1.3; // the mount's pivot is the gun's centre; its base stands on the roof
  ship.group.add(g.group);
  return g;
});
const TRACERS = 220;
const tracers = Array.from({ length: TRACERS }, () => ({ on: false, p: new THREE.Vector3(), v: new THREE.Vector3(), t0: 0 }));
const tracerGeo = new THREE.BufferGeometry();
tracerGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(TRACERS * 6), 3));
// A tracer is a hot orange streak behind a bright white-yellow head that glows.
const tracerLines = new THREE.LineSegments(tracerGeo, new THREE.LineBasicMaterial({ color: 0xff6a1f, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }));
tracerLines.frustumCulled = false;
scene.add(tracerLines);
const glowTex = (() => {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const x = c.getContext('2d');
  const g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,250,225,1)');
  g.addColorStop(0.3, 'rgba(255,190,90,0.7)');
  g.addColorStop(1, 'rgba(255,120,30,0)');
  x.fillStyle = g;
  x.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
})();
const headGeo = new THREE.BufferGeometry();
headGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(TRACERS * 3), 3));
const tracerHeads = new THREE.Points(headGeo, new THREE.PointsMaterial({ map: glowTex, size: 1.1, sizeAttenuation: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, color: 0xffffff }));
tracerHeads.frustumCulled = false;
scene.add(tracerHeads);
let tracerNext = 0;
const gunClock = [0, 0];
const smokeClock = [0, 0];
function updateGuns(dt) {
  const t = sim.t;
  for (let i = 0; i < gatlings.length; i++) {
    const g = sim.guns[i];
    gatlings[i].pose(g.yaw, g.pitch, g.spin, g.firing, t);
    if (!g.firing) continue;
    gunClock[i] += dt;
    smokeClock[i] += dt;
    gatlings[i].muzzle.getWorldQuaternion(_q);
    _a.set(1, 0, 0).applyQuaternion(_q);
    while (smokeClock[i] >= 0.09) { // powder smoke, a wisp at the muzzle every few rounds
      smokeClock[i] -= 0.09;
      gatlings[i].muzzle.getWorldPosition(_c);
      fx.gunSmoke(_c, _b.copy(_a).multiplyScalar(5).add(sim.shipVel(_d)), t);
    }
    while (gunClock[i] >= 0.036) { // a tracer every third round
      gunClock[i] -= 0.036;
      const tr = tracers[tracerNext++ % TRACERS];
      gatlings[i].muzzle.getWorldPosition(tr.p);
      tr.v.copy(_a).multiplyScalar(1050).add(sim.shipVel(_b));
      tr.v.x += (Math.random() - 0.5) * 9; tr.v.y += (Math.random() - 0.5) * 9; tr.v.z += (Math.random() - 0.5) * 9;
      tr.t0 = t - Math.random() * 0.012; // spread over the frame, not all at the muzzle at once
      tr.on = true;
    }
  }
  const pos = tracerGeo.attributes.position;
  const hp = headGeo.attributes.position;
  for (let k = 0; k < TRACERS; k++) {
    const tr = tracers[k];
    let live = false;
    if (tr.on) {
      const age = t - tr.t0;
      if (age > 2.2 || age < 0 || tr.p.y + tr.v.y * age < -1) tr.on = false;
      else {
        _a.copy(tr.p).addScaledVector(tr.v, age);
        _b.copy(tr.v).normalize().multiplyScalar(-34);
        pos.setXYZ(k * 2, _a.x, _a.y, _a.z);
        pos.setXYZ(k * 2 + 1, _a.x + _b.x, _a.y + _b.y, _a.z + _b.z);
        if (age > 0.022) hp.setXYZ(k, _a.x, _a.y, _a.z); // no glowing head right at the muzzle, where it would swamp the gun
        else hp.setXYZ(k, 0, -9999, 0);
        live = true;
      }
    }
    if (!live) { pos.setXYZ(k * 2, 0, -9999, 0); pos.setXYZ(k * 2 + 1, 0, -9999, 0); hp.setXYZ(k, 0, -9999, 0); }
  }
  pos.needsUpdate = true;
  hp.needsUpdate = true;
}
const audio = createHelmAudio();
const sim = new HelmSim({ seed: (Date.now() % 100000) | 0 });
sim.skyline = ridgeAngle;
sim.gunsAuto = true; // the guns start on automatic (A switches it off)

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

// The ship's wake (fx/wake.js, shared with the ship duel).
const wake = createWake(scene);

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
      case 'heli-fire': fx.launchBillow(e.pos, e.dir, sim.t); break; // the helicopter's round: no cut to the launcher
      case 'heli-hit': for (let i = 0; i < 4; i++) fx.missileTrail(e.pos, sim.t); break; // a puff of smoke: it is damaged, not destroyed
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
      case 'gunhit': fx.missileTrail(e.pos, sim.t); break; // a puff where the burst struck
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
  ship.update(t, Infinity, Infinity, { aim: sim.launcher, cradleT: 0, heli: sim.heli.state });
  env.ocean.material.uniforms.uTime.value = t;
  wake.update({ t: sim.t, x: sim.x, z: sim.z, psi: sim.psi, r: sim.r, u: sim.u });

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
    const show = d.alive && d.detected && !d.hidden && tagsOn;
    v.tag.obj.visible = show;
    if (show) {
      v.tag.obj.position.copy(d.pos).y += 3;
      const r = sim.rangeTo(d.pos);
      v.tag.el.classList.toggle('dead', d.phase === 'attack' || d.phase === 'pass');
      v.tag.el.classList.toggle('helm-target', d.id === sim.targetId);
      v.tag.title.textContent = `${d.name}${d.id === sim.targetId ? ' · TARGET' : ''}${d.phase === 'attack' ? ' · ATTACK' : ''}`;
      const taken = Math.max(0, DRONE_HP - d.hp);
      v.tag.body.innerHTML = `${kmText(r)} · ${Math.round(d.pos.y)}<span> m up</span>${taken ? `<span class="tag-hits"> ${'●'.repeat(taken)}${'○'.repeat(DRONE_HP - taken)}</span>` : ''}`;
      // A drone the guns have hurt trails smoke, more the worse it is.
      if (taken >= 2) {
        v.smokeAt = (v.smokeAt ?? 0) - dt;
        if (v.smokeAt <= 0) { v.smokeAt = taken >= 4 ? 0.05 : 0.14; fx.missileTrail(d.pos, t); }
      }
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
      if (m.heli) model.group.scale.setScalar(0.6); // a light air-launched round
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
const orbitTarget = (out) => out.set(sim.x, -40, sim.z); // a little under her, so she stands above the middle of the screen, clear of the instruments
let viewBefore = 'behind'; // the view the target view was left from: the camera goes back to it once the drone has splashed
let tgtWatch = null; // the drone the target view was last on
function setView(v, quiet = false) {
  if (v === 'target' && view !== 'target') viewBefore = view;
  tgtWatch = null;
  view = v;
  radarKeys.l = radarKeys.r = radarKeys.u = radarKeys.d = 0;
  sight.manual = false; // the radar's own controls start on automatic every time
  sight.locked = false;
  radarEl.hidden = v !== 'sight';
  document.body.classList.toggle('helm-radarview', v === 'sight');
  if (v === 'sight') { sight.fresh = true; sight.searchTime = SIGHT_SEARCH; } // the director starts from the bow and finds the target again
  pendingOrbit = false;
  endCine();
  camera.up.set(0, 1, 0);
  if (v === 'orbit') {
    controls.enabled = true;
    // It opens off her starboard beam, a little abaft it and above the water, looking down on her from 300 m (drag and wheel take it from there).
    orbitTarget(controls.target);
    const fx = Math.cos(sim.psi), fz = Math.sin(sim.psi), az = THREE.MathUtils.degToRad(25), el = THREE.MathUtils.degToRad(22);
    const hx = -fz * Math.cos(az) - fx * Math.sin(az), hz = fx * Math.cos(az) - fz * Math.sin(az);
    camera.position.set(controls.target.x + 300 * Math.cos(el) * hx, controls.target.y + 300 * Math.sin(el), controls.target.z + 300 * Math.cos(el) * hz);
    rig.focus('ship', orbitTarget, 300, 40);
  } else {
    controls.enabled = false;
    rig.free();
  }
  snap = true;
  sightEl.hidden = v !== 'sight';
  document.body.classList.toggle('helm-sighting', v === 'sight');
  viewButtons.forEach((b) => b.classList.toggle('active', b.dataset.view === v));
  if (v === 'missile' && !sim.shipMissiles.length) say('Riding the missile: no missile in flight yet, the view takes the next one', '', 2600);
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
  if (!cineOn || cine || view === 'orbit' || view === 'sight' || sim.out || !sim.shot) return; // the radar view stays on its locked target through the shot
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
  if (!cine && cineOn && view !== 'orbit' && view !== 'sight' && !sim.out && sim.shot) { // the launcher close-up did not start: the lock still goes through the sight
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
  sight.manual = false;
  sight.locked = false;
  sight.phase = 'slew';
  sight.omega = 0;
  sight.searchTime = SIGHT_SEARCH_SHOT;
  cine.phase = 'sight';
  sightEl.hidden = false;
  document.body.classList.add('helm-sighting');
}
function startCine(missileId, droneId = null) {
  if (!cineOn || cine || view === 'orbit' || (view === 'sight' && missileId !== null) || sim.out) return;
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
  if (sight.phase === 'slew' && off < THREE.MathUtils.degToRad(sight.locked ? 3 : 1.5)) {
    if (sight.locked) { sight.phase = 'lock'; if (!cine) showLock(d.id); } // a lock the player asked for goes straight on, with no hunting about
    else { sight.phase = 'search'; sight.t0 = sim.t; }
  }
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

const _wp = new THREE.Vector3();
const _wc = new THREE.Vector3();
// Target view after the hit: stays on the drone it was watching (the camera eases back to a point behind and above its
// wreck, looking at it) until it has splashed, then returns to the view it came from. false when there is no wreck to follow.
function wreckShot(dt) {
  const w = tgtWatch === null ? null : sim.drones.find((x) => x.id === tgtWatch);
  if (!w || w.alive || !w.wreck) return false;
  const v = vis.get(w.id);
  const tEnd = v?.debris ? w.wreck.t + Math.max(...v.debris.pieces.map((q) => q.tauWater)) : w.wreck.t + 8;
  if (sim.t >= tEnd) { setView(viewBefore, true); return false; }
  if (v?.debris) {
    const tau = sim.t - w.wreck.t;
    _wp.set(0, 0, 0);
    for (const q of v.debris.pieces) _wp.add(v.debris.piecePos(q, tau, _wc));
    _wp.multiplyScalar(1 / v.debris.pieces.length);
  } else _wp.copy(w.wreck.pos);
  _a.copy(w.wreck.vel).setY(0);
  if (_a.lengthSq() < 1e-6) _a.set(Math.cos(sim.psi), 0, Math.sin(sim.psi));
  _a.normalize();
  _wc.copy(_wp).addScaledVector(_a, -45);
  _wc.y = Math.max(_wp.y + 8, 6);
  if (snap) camera.position.copy(_wc);
  else camera.position.lerp(_wc, 1 - Math.exp(-dt / 0.35));
  snap = false;
  camera.lookAt(_wp);
  return true;
}

function updateCamera(dt) {
  bridge.group.visible = view === 'bridge';
  // Looking straight down from high up nothing is near the camera, so the near plane moves out with the height: the depth buffer then
  // keeps its precision across the 10 km to the land (otherwise the shore flickers where the land dips under the sea).
  const wantNear = view === 'above' ? Math.min(Math.max(aboveH * 0.2, 0.3), 400) : 0.3;
  if (camera.near !== wantNear) { camera.near = wantNear; camera.updateProjectionMatrix(); }
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
    bridge.update(THREE.MathUtils.clamp(sim.rudder / RUDDER_MAX, -1, 1), sim.order / (TELEGRAPH.length - 1));
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
  } else if (view === 'missile' && sim.shipMissiles.length) {
    const m = sim.shipMissiles[sim.shipMissiles.length - 1];
    camera.position.copy(m.pos).addScaledVector(m.dir, -10).y += 1.6;
    const tgt = sim.drones.find((d) => d.id === m.targetId);
    lookAt.copy(m.pos).addScaledVector(m.dir, 40);
    if (tgt && tgt.alive) lookAt.lerp(tgt.pos, 0.35);
    camera.lookAt(lookAt);
    snap = true;
  } else if (view === 'target' && wreckShot(dt)) {
    // The drone is down: the camera holds on its falling wreck until the last piece is in the sea.
    wantFov = 46;
  } else if (view === 'target' && sim.target && sim.target.alive) {
    tgtWatch = sim.target.id;
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
  } else if (view === 'sight' && (sight.manual || !sim.target)) {
    wantFov = aimManual(dt);
  } else if (view === 'sight') {
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
  updateRadarUi();
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
// Which the scope follows: the target (and its wreck once it is down), or the latest missile.
let pipMode = 'target';
const pipSw = document.createElement('div');
pipSw.className = 'hp-sw';
pipSw.innerHTML = '<button data-m="target">Target</button><button data-m="missile">Missile</button>';
pipSw.firstChild.classList.add('on');
pipEl.appendChild(pipSw);
function setPipMode(m) {
  pipMode = m;
  for (const b of pipSw.children) b.classList.toggle('on', b.dataset.m === m);
  pipSt.phase = 'slew';
}
pipSw.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (b) { setPipMode(b.dataset.m); b.blur(); }
});
const pipCam = new THREE.PerspectiveCamera(24, 1, 0.3, 30000);
const pipSt = { id: null, phase: 'slew', t0: 0, omega: 0, aim: new THREE.Vector3(1, 0.06, 0), fresh: true };
let pipFov = 24;
const pipV3 = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
// What the scope watches. By default the target drone; once a missile leaves, the missile until it reaches the drone, then
// the falling wreck of that drone until the last piece is in the sea.
const pipFocus = { key: null, pos: new THREE.Vector3(), size: 4.5, name: '', kind: 'drone' };
const pipWatch = { did: null };
function pipPick() {
  const m = pipMode === 'target' ? null : sim.shipMissiles[sim.shipMissiles.length - 1];
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
  if (pipFocus.kind === 'drone' && pipFocus.key !== null) { // the drone being watched went down (missile or guns): stay on its wreck until the last piece splashes
    const was = sim.drones.find((x) => x.id === pipFocus.key);
    if (was && !was.alive) pipWatch.did = was.id;
  }
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
const sight = { locked: false, manual: false, hover: null, dwell: 0, id: null, phase: 'slew', t0: 0, omega: 0, fresh: true, searchTime: SIGHT_SEARCH, aim: new THREE.Vector3(1, 0, 0) };

// --- The radar view's own controls -----------------------------------------------------------------------------------------
// In the radar view the steering readouts are hidden and the arrows aim the fire-control sight by hand (a drag does too):
// anything that comes within the sight's cone is picked out, and held there for a moment it locks by itself; Enter or the
// LOCK button locks at once, Space or AUTO goes back to the automatic tracking, and every detected drone wears a bracket
// that can be clicked. The pad's buttons also arm and fire the missile and step through the targets.
sight.dragYaw = 0;
sight.dragPitch = 0;
const radarKeys = { l: 0, r: 0, u: 0, d: 0 };
const radarEl = document.createElement('div');
radarEl.className = 'helm-radar';
radarEl.hidden = true;
// The console: two spheres side by side at the foot of the screen, the aim stick (a drag on it turns the sight; a ring round it zooms the lens)
// and FIRE, with the option buttons, round and animated, one cluster each side.
const RICON = { // 32 x 32 drawings, animated by CSS in helm.css (.hr-sweep, .hr-brk, .hr-xh, .flame, .puff)
  auto: '<svg viewBox="0 0 32 32" aria-hidden="true"><g class="hr-sweep"><path d="M26 16a10 10 0 1 1-3.2-7.4M26 6v6h-6"/></g><circle cx="16" cy="16" r="2" style="fill:currentColor;stroke:none"/></svg>',
  next: '<svg viewBox="0 0 32 32" aria-hidden="true"><g class="hr-brk"><path d="M5 11V5h6M21 5h6v6M27 21v6h-6M11 27H5v-6"/></g><circle cx="16" cy="16" r="3.2" class="fill"/><path d="M21 16h5M23.5 13.5L26 16l-2.5 2.5"/></svg>',
  lock: '<svg viewBox="0 0 32 32" aria-hidden="true"><rect x="7" y="14" width="18" height="13" rx="3" class="fill"/><g class="hr-shackle"><path d="M11 14v-4a5 5 0 0 1 10 0v4"/></g><circle cx="16" cy="20.5" r="1.8" style="fill:currentColor;stroke:none"/></svg>',
  arm: '<svg viewBox="0 0 32 32" aria-hidden="true"><g transform="rotate(-45 16 16)"><circle class="puff p1" cx="4" cy="16" r="1.6"/><circle class="puff p2" cx="4" cy="16" r="1.6"/><path class="flame" d="M9 14.2L1.5 16 9 17.8z"/><path class="fill" d="M9 13.2h11.5L27 16l-6.5 2.8H9z"/><path d="M9 13.2L5.8 9.8h5.6l1.9 3.4M9 18.8l-3.2 3.4h5.6l1.9-3.4M16 13.2v5.6"/></g></svg>',
  pick: '<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M3 16s5-8 13-8 13 8 13 8-5 8-13 8S3 16 3 16z"/><circle cx="16" cy="16" r="3.6" class="fill"/></svg>',
};
const optHtml = (icon, title, sub, key) => `<i class="sp-ico">${icon}</i><span class="sp-txt"><b>${title}</b><small>${sub}</small></span><kbd>${key}</kbd>`;
const optBtn = (cls, act, icon, title, sub, key) => `<button type="button" class="helm-act hr-opt ${cls}" data-act="${act}">${optHtml(icon, title, sub, key)}</button>`;
const ZOOM_MIN = 0.3, ZOOM_MAX = 4, ZOOM_SPAN = Math.log(ZOOM_MAX / ZOOM_MIN);
const RING_ARC = 2 * Math.PI * 70 * 0.75; // the zoom ring runs 270 degrees, from the lower left round to the lower right
radarEl.innerHTML = '<div class="hr-marks"></div><div class="hr-console">'
  + '<div class="hr-read"><b class="hr-mode">AUTO</b><span class="hr-brg"></span></div>'
  + '<div class="hr-row"><div class="hr-opts">'
  + optBtn('hr-auto', 'auto', RICON.auto, 'Release / auto', 'back to automatic tracking', 'Space')
  + optBtn('hr-next', 'next', RICON.next, 'Next target', 'step through the drones', 'Tab')
  + optBtn('hr-lock', 'lock', RICON.lock, 'Lock', 'catch the drone in the sight', 'Enter')
  + '</div>'
  + '<div class="hr-stickwrap"><svg class="hr-ring" viewBox="0 0 150 150" aria-label="Zoom"><circle class="hr-rtrack" r="70" cx="75" cy="75"/><circle class="hr-rfill" r="70" cx="75" cy="75"/><circle class="hr-hit" r="70" cx="75" cy="75"/><circle class="hr-rthumb" r="7"/></svg>'
  + '<div class="hr-stick" title="Drag to aim the sight"><i class="hr-knob"></i></div></div>'
  + '<button type="button" class="hr-fireball" data-act="fire" title="Launch the missile (F)"><span>FIRE</span><kbd>F</kbd></button>'
  + '<div class="hr-opts">'
  + optBtn('hr-arm', 'arm', RICON.arm, 'Arm missile', 'make one ready on the target', 'M')
  + optBtn('hr-pick hr-opt-pick', 'pick', RICON.pick, 'Lock nearest to', 'the view or the ship', 'VIEW')
  + '</div></div></div>';
document.body.appendChild(radarEl);
const radarMarks = radarEl.querySelector('.hr-marks');
const radarMode = radarEl.querySelector('.hr-mode');
const radarBrg = radarEl.querySelector('.hr-brg');
const radarPickKbd = radarEl.querySelector('.hr-pick kbd');
const fireBall = radarEl.querySelector('.hr-fireball');
const stickEl = radarEl.querySelector('.hr-stick');
const hitEl = radarEl.querySelector('.hr-hit'), thumbEl = radarEl.querySelector('.hr-rthumb'), fillEl = radarEl.querySelector('.hr-rfill');
const pickSub = radarEl.querySelector('.hr-pick small');
const pressKey = (key) => { window.dispatchEvent(new KeyboardEvent('keydown', { key })); window.dispatchEvent(new KeyboardEvent('keyup', { key })); };
function lockOn(d) {
  sim.targetId = d.id;
  sight.manual = false;
  sight.locked = true; // the aim is held on it: the arrows and the drag leave the sight alone until it is released
  sight.id = d.id;
  sight.phase = 'slew';
  sight.dwell = 0;
  say(`Target ${d.name}: ${relName(sim.relBearing(d.pos))}, ${kmText(sim.rangeTo(d.pos))}`, '');
}
// The detected drone nearest the line of sight, if it is inside the cone (degrees).
function nearestToAim(cone) {
  let best = null;
  let bestA = THREE.MathUtils.degToRad(cone);
  for (const d of sim.detected) {
    const a = _d.subVectors(d.pos, camera.position).normalize().angleTo(sight.aim);
    if (a < bestA) { bestA = a; best = d; }
  }
  return best;
}
// What LOCK / Enter catches: the drone nearest the line of sight (the view) or the one nearest the ship, as chosen on the pad.
let pickMode = 'view';
try { pickMode = localStorage.getItem('intercept.radarpick') === 'ship' ? 'ship' : 'view'; } catch { /* storage unavailable */ }
function lockHover() {
  const d = pickMode === 'ship' ? sim.nearest() : sight.hover ?? nearestToAim(180) ?? sim.nearest();
  if (d) lockOn(d);
  else say('Nothing on the radar to lock', 'warn');
}
// Drag on a control until the pointer lets go.
function dragOn(e, move) {
  const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up); move(null); };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
  move(e);
}
const STICK_TRAVEL = 30; // px the knob can move from the middle
radarEl.addEventListener('pointerdown', (e) => {
  if (e.target.closest('.hr-hit')) { // the zoom ring: drag round it (wide at the lower left, close at the lower right)
    e.preventDefault();
    dragOn(e, (ev) => {
      if (!ev) return;
      const r = hitEl.getBoundingClientRect();
      let a = (Math.atan2(ev.clientY - (r.top + r.height / 2), ev.clientX - (r.left + r.width / 2)) * 180 / Math.PI - 135 + 720) % 360;
      if (a > 270) a = a > 315 ? 0 : 270; // the gap at the bottom snaps to the nearer end
      sightZoom = THREE.MathUtils.clamp(ZOOM_MIN * Math.exp((1 - a / 270) * ZOOM_SPAN), ZOOM_MIN, ZOOM_MAX);
    });
    return;
  }
  if (e.target.closest('.hr-stick')) { // the aim stick: how far it is pushed is how fast the sight turns; it springs back to the middle
    e.preventDefault();
    sight.locked = false; // taking the stick takes the sight back from a lock
    const r = stickEl.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    dragOn(e, (ev) => {
      if (!ev) { radarKeys.l = radarKeys.r = radarKeys.u = radarKeys.d = 0; stickEl.style.setProperty('--kx', '0px'); stickEl.style.setProperty('--ky', '0px'); return; }
      let dx = ev.clientX - cx, dy = ev.clientY - cy;
      const len = Math.hypot(dx, dy);
      if (len > STICK_TRAVEL) { dx *= STICK_TRAVEL / len; dy *= STICK_TRAVEL / len; }
      const x = dx / STICK_TRAVEL, y = dy / STICK_TRAVEL;
      radarKeys.r = Math.max(0, x); radarKeys.l = Math.max(0, -x); radarKeys.d = Math.max(0, y); radarKeys.u = Math.max(0, -y);
      sight.manual = true;
      stickEl.style.setProperty('--kx', `${dx.toFixed(1)}px`); stickEl.style.setProperty('--ky', `${dy.toFixed(1)}px`);
    });
    return;
  }
  const b = e.target.closest('button');
  if (!b) return;
  e.preventDefault();
  if (b.dataset.dir) {
    if (sight.locked) return;
    radarKeys[b.dataset.dir] = 1;
    sight.manual = true;
    const up = () => { radarKeys[b.dataset.dir] = 0; window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up); };
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  } else if (b.dataset.act === 'lock') lockHover();
  else if (b.dataset.act === 'pick') {
    pickMode = pickMode === 'ship' ? 'view' : 'ship';
    try { localStorage.setItem('intercept.radarpick', pickMode); } catch { /* storage unavailable */ }
    say(pickMode === 'ship' ? 'LOCK catches the drone nearest the ship' : 'LOCK catches the drone nearest the view', '');
  }
  else if (b.dataset.act === 'auto') { sight.manual = false; sight.locked = false; }
  else if (b.dataset.act === 'next') { sight.manual = false; pressKey('Tab'); }
  else if (b.dataset.act === 'arm') pressKey('m');
  else if (b.dataset.act === 'fire') pressKey('f');
});
radarMarks.addEventListener('pointerdown', (e) => {
  const m = e.target.closest('.hr-mark');
  const d = m && sim.detected.find((x) => String(x.id) === m.dataset.id);
  if (d) { e.preventDefault(); lockOn(d); }
});
// The sight turned by hand: the arrows (a slow, fine turn when the lens is narrow), a drag, and a hover that locks by dwelling.
function aimManual(dt) {
  sight.locked = false; // nothing left to hold
  ship.group.localToWorld(camera.position.copy(DIRECTOR_EYE));
  if (sight.fresh) {
    sight.aim.set(Math.cos(sim.psi), 0.06, Math.sin(sim.psi)).normalize();
    sight.fresh = false;
  }
  const rate = THREE.MathUtils.degToRad(50) * THREE.MathUtils.clamp(fov / SIGHT_WIDE, 0.12, 1);
  let yaw = Math.atan2(sight.aim.z, sight.aim.x) + (radarKeys.r - radarKeys.l) * rate * dt + sight.dragYaw;
  const pitch = THREE.MathUtils.clamp(Math.asin(THREE.MathUtils.clamp(sight.aim.y, -1, 1)) + (radarKeys.u - radarKeys.d) * rate * dt + sight.dragPitch, -0.25, 1.45);
  sight.dragYaw = 0;
  sight.dragPitch = 0;
  yaw = Math.atan2(Math.sin(yaw), Math.cos(yaw));
  sight.aim.set(Math.cos(pitch) * Math.cos(yaw), Math.sin(pitch), Math.cos(pitch) * Math.sin(yaw));
  camera.lookAt(_e.copy(camera.position).add(sight.aim));
  const d = nearestToAim(Math.max(1.2, fov * 0.14));
  if (d && d === sight.hover) sight.dwell += dt;
  else sight.dwell = 0;
  sight.hover = d;
  if (d && sight.dwell > 0.9) lockOn(d);
  sightEl.classList.toggle('lock', !!d);
  sightEl.classList.toggle('searching', !d);
  sightTxt.textContent = d ? `${d.name} in the sight · ${relName(sim.relBearing(d.pos))} · ${kmText(sim.rangeTo(d.pos))} · locking…` : 'Manual: aim at a drone';
  return Math.max(SIGHT_WIDE * sightZoom, 1);
}
// Brackets on every detected drone in the picture, and the pad's readout.
const radarMarkEls = new Map();
function updateRadarUi() {
  if (view !== 'sight') return;
  const manual = sight.manual || !sim.target;
  radarMode.textContent = sight.locked ? (sight.phase === 'lock' ? 'LOCKED' : 'LOCKING') : sight.manual ? 'MANUAL' : sim.target ? 'AUTO' : 'SCAN';
  radarMode.classList.toggle('manual', manual);
  radarPickKbd.textContent = pickMode === 'ship' ? 'SHIP' : 'VIEW';
  pickSub.textContent = pickMode === 'ship' ? 'the drone nearest the ship (click to change)' : 'the drone nearest the view (click to change)';
  const canFire = sim.cellsLeft > 0 || !!sim.shot;
  fireBall.classList.toggle('empty', !canFire);
  fireBall.classList.toggle('ready', !!sim.shot?.hold);
  fireBall.classList.toggle('lock', !!sim.shot?.locked);
  const zf = 1 - Math.log(sightZoom / ZOOM_MIN) / ZOOM_SPAN, ang = (135 + 270 * zf) * Math.PI / 180;
  thumbEl.setAttribute('cx', (75 + 70 * Math.cos(ang)).toFixed(1));
  thumbEl.setAttribute('cy', (75 + 70 * Math.sin(ang)).toFixed(1));
  fillEl.style.strokeDasharray = `${(RING_ARC * zf).toFixed(1)} 440`;
  radarEl.classList.toggle('locked', sight.locked);
  const rel = THREE.MathUtils.radToDeg(Math.atan2(Math.sin(Math.atan2(sight.aim.z, sight.aim.x) - sim.psi), Math.cos(Math.atan2(sight.aim.z, sight.aim.x) - sim.psi)));
  radarBrg.textContent = `${relName(THREE.MathUtils.degToRad(rel))} · elv ${Math.round(THREE.MathUtils.radToDeg(Math.asin(sight.aim.y)))}° · lens ${Math.round(fov)}°`;
  camera.updateMatrixWorld();
  const seen = new Set();
  for (const d of sim.detected) {
    _a.copy(d.pos).project(camera);
    if (_a.z > 1 || Math.abs(_a.x) > 1.02 || Math.abs(_a.y) > 1.02) continue;
    let el = radarMarkEls.get(d.id);
    if (!el) {
      el = document.createElement('button');
      el.type = 'button';
      el.className = 'hr-mark';
      el.dataset.id = d.id;
      radarMarks.appendChild(el);
      radarMarkEls.set(d.id, el);
    }
    seen.add(d.id);
    el.style.transform = `translate(${((_a.x + 1) / 2 * window.innerWidth).toFixed(1)}px, ${((1 - _a.y) / 2 * window.innerHeight).toFixed(1)}px)`;
    el.classList.toggle('tgt', sim.target === d);
    const txt = `${d.name} · ${kmText(sim.rangeTo(d.pos))}`;
    if (el.textContent !== txt) el.textContent = txt;
  }
  for (const [id, el] of radarMarkEls) if (!seen.has(id)) { el.remove(); radarMarkEls.delete(id); }
}

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
  } else if (view === 'sight') { // drag aims the radar by hand (not while it is locked)
    if (sight.locked) return;
    sight.manual = true;
    sight.dragYaw += dx * THREE.MathUtils.degToRad(fov) / window.innerHeight;
    sight.dragPitch -= dy * THREE.MathUtils.degToRad(fov) / window.innerHeight;
  } else if (view === 'behind') behindYaw += dx * 0.3; // the camera swings to starboard, so the view turns to port
});
canvas.addEventListener('dblclick', () => { lookYaw = 0; lookPitch = -0.03; behindYaw = 0; behindDist = BEHIND_DIST; aboveH = 520; sightZoom = 1; });
canvas.addEventListener('wheel', (e) => {
  if (view === 'behind') behindDist = THREE.MathUtils.clamp(behindDist * Math.exp(e.deltaY * 0.001), 60, 1200);
  else if (view === 'above') aboveH = THREE.MathUtils.clamp(aboveH * Math.exp(e.deltaY * 0.001), 150, 24000); // high enough to see the land, 5 km and more away
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
// The strip is three parts: the hull and kills badges, the dome with a propeller and a throttle bar each side (as in Surface battle), and the
// missiles and guns badges. The badges are rebuilt as text; the propellers and bars stay put so they can turn and light up every frame.
const PROP_SVG = '<svg viewBox="-24 -24 48 48" aria-hidden="true"><defs><linearGradient id="pp-brass" x1="0" y1="-23" x2="9" y2="-6" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#f6e4a2"/><stop offset="0.55" stop-color="#d9b45c"/><stop offset="1" stop-color="#9b7632"/></linearGradient></defs><g class="pp-rot">'
  + [0, 90, 180, 270].map((a) => `<g transform="rotate(${a})"><path d="M-2 -6 C-8.5 -9.5 -9.5 -19 -4 -22.6 C1 -24.5 8.4 -22 9 -17.6 C7 -12 4 -8 2.2 -6 Z" class="pp-blade"/><path d="M-3.4 -9 C-6 -13 -5.8 -18 -3 -20.6" class="pp-edge"/></g>`).join('')
  + '</g><circle r="5.4" class="pp-hubring"/><circle r="3" class="pp-hub"/><circle r="1" class="pp-cap"/></svg>';
const statHost = document.createElement('div'), centre = document.createElement('div'), wpnHost = document.createElement('div'), domeHost = document.createElement('div');
statHost.className = 'hs-badges'; // the info badges (hull, kills, missiles, guns), left of the steering group
wpnHost.className = 'hs-badges hs-cmds'; // the command buttons (helicopter, missile), right of it
centre.className = 'hs-centre';
const propL = document.createElement('div'), propR = document.createElement('div'), barL = document.createElement('div'), barR = document.createElement('div');
propL.className = propR.className = 'hs-prop';
propL.innerHTML = propR.innerHTML = PROP_SVG;
barL.className = barR.className = 'hs-lvl'; // one bar for each engine, five notches: dead slow, slow, half, full, flank (the throttle, not the speed)
barL.innerHTML = barR.innerHTML = '<i></i><i></i><i></i><i></i><i></i>';
centre.append(barL, propL, domeHost, propR, barR);
shipEl.append(statHost, centre, wpnHost);
document.body.appendChild(shipEl);
const propRotL = propL.querySelector('.pp-rot'), propRotR = propR.querySelector('.pp-rot');
let propAng = 0;
function spinProps(dt) {
  const kn = sim.knots;
  propAng = (propAng + kn * 0.18 * dt) % (Math.PI * 2); // about one turn a second at 38 kn; backwards astern
  const deg = (propAng * 180) / Math.PI;
  propRotL.style.transform = `rotate(${-deg}deg)`; propRotR.style.transform = `rotate(${deg}deg)`;
  const ord = sim.order;
  for (const bar of [barL, barR]) { // the bar fills from the bottom with the throttle (slow astern lights the bottom notch in blue)
    const n = bar.children.length;
    for (let q = 0; q < n; q++) { const lit = ord === 0 ? q === n - 1 : (n - 1 - q) < ord - 1; bar.children[q].className = lit ? (ord === 0 ? 'astern' : q === 0 ? 'top' : 'on') : ''; }
  }
  const fast = Math.min(1, Math.abs(kn) / 20);
  propL.style.setProperty('--blur', fast.toFixed(2)); propR.style.setProperty('--blur', fast.toFixed(2));
}
let lastStat = '', lastDome = '';

// Under the radar map: the range and bearing of the drone you are on.
const rangeEl = document.createElement('div');
rangeEl.className = 'helm-range';
document.body.appendChild(rangeEl);
let lastRange = '';
function updateRange() {
  const t = sim.target;
  const html = t ? `<div class="pt-pill" title="Range and bearing of the target">${kmText(sim.rangeTo(t.pos))} · ${relName(sim.relBearing(t.pos))}</div>` : '';
  if (html !== lastRange) { rangeEl.innerHTML = html; lastRange = html; }
}

// The support buttons, round, in a row above the scope: the helicopter (E) and a missile (M, then F to launch), each with its key and a tip on hover.
const actions = wpnHost; // (the commands stand in the bottom row, right of the steering group)
const ICON_HELI = '<svg viewBox="0 0 32 32" aria-hidden="true"><g class="bob"><g class="rotor"><path d="M2 8.5h28"/></g><path d="M16 8.5v3"/><path class="fill" d="M6.5 18c0-3.6 3-6.5 7.5-6.5h5c3.4 0 5.5 2 5.5 4.6v1.9c0 1.4-1.3 2.5-2.9 2.5H10.5C8.2 20.5 6.5 19.7 6.5 18z"/><path class="win" d="M9.5 15.3c.8-1.5 2.4-2.3 4.6-2.3h1.4v4.3H9.2z"/><path d="M24.5 15.3l5.5-2.6v3.4l-5 2"/><circle class="trot" cx="30" cy="12.6" r="2.3"/><path d="M8 24.5h15M11 20.5v4M20 20.5v4"/></g></svg>';
const ICON_MISS = '<svg viewBox="0 0 32 32" aria-hidden="true"><g transform="rotate(-45 16 16)"><circle class="puff p1" cx="4" cy="16" r="1.6"/><circle class="puff p2" cx="4" cy="16" r="1.6"/><path class="flame" d="M9 14.2L1.5 16 9 17.8z"/><path class="fill" d="M9 13.2h11.5L27 16l-6.5 2.8H9z"/><path d="M9 13.2L5.8 9.8h5.6l1.9 3.4M9 18.8l-3.2 3.4h5.6l1.9-3.4M16 13.2v5.6"/></g></svg>';
const supportHtml = (icon, title, sub, key) => `<i class="sp-ico">${icon}</i><span class="sp-txt"><b>${title}</b><small>${sub}</small></span><kbd>${key}</kbd>`;
const heliBtn = document.createElement('button'), missBtn = document.createElement('button');
heliBtn.type = missBtn.type = 'button';
heliBtn.className = 'helm-act helm-act-heli';
missBtn.className = 'helm-act helm-act-miss';
actions.append(heliBtn, missBtn);
heliBtn.addEventListener('click', () => { say(sim.heliRequest(), ''); heliBtn.blur(); });
missBtn.addEventListener('click', () => { if (sim.shot?.hold) sim.launchReady(); else sim.arm(); missBtn.blur(); });
let lastActs = '';
function updateActions() {
  const act = sim.heli.action;
  const hTitle = act === 'land' ? 'Helicopter: land' : 'Helicopter: take off';
  const hSub = act === 'takeoff' ? (sim.standDown ? 'stays: a drone is near' : 'take off') : act === 'land' ? 'bring her in' : 'landing';
  const hOn = act !== null;
  const mHold = !!sim.shot?.hold;
  const mTitle = mHold ? 'Launch the missile' : 'Make a missile ready';
  const mSub = sim.cellsLeft <= 0 && !sim.shot ? 'none left' : mHold ? (sim.shot.locked ? 'locked: press to launch' : 'acquiring the target') : `${sim.cellsLeft} left · on the target`;
  const mOn = sim.cellsLeft > 0 || !!sim.shot;
  const key = [hTitle, hSub, hOn, mTitle, mSub, mOn].join('|');
  if (key === lastActs) return;
  lastActs = key;
  heliBtn.innerHTML = supportHtml(ICON_HELI, hTitle, hSub, 'E'); heliBtn.disabled = !hOn;
  missBtn.innerHTML = supportHtml(ICON_MISS, mTitle, mSub, mHold ? 'F' : 'M'); missBtn.disabled = !mOn;
}
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
    if (d % 30 === 0) {
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
    + `<text x="${cx}" y="79" class="hd">${f(((h % 360) + 360) % 360).padStart(3, '0')}°</text>`
    + `<path d="M${pl[0]},${pl[1]} A${RR},${RR} 0 0 1 ${pr[0]},${pr[1]}" class="rt"/>${fill}`
    + `<line x1="${p0[0]}" y1="${(Number(p0[1]) - 5).toFixed(1)}" x2="${p0[0]}" y2="${(Number(p0[1]) + 5).toFixed(1)}" class="rm"/>`
    + `<text x="${cx}" y="94" class="sp">${f(sim.knots, 1)}<tspan> kn</tspan></text></svg>`;
}
// The weapons card: one row per weapon (the missile cells as little missiles, the guns' ammunition as a bar), and empty slots
// kept for the weapons still to come.
function weaponsHtml() {
  let mState = sim.cellsLeft > 0 ? 'ready' : 'empty';
  if (sim.shot) mState = sim.shot.locked ? 'locked' : sim.shot.acquiring ? 'acquiring' : 'turning';
  else if (sim.shipMissiles.length) mState = `${sim.shipMissiles.length} away`;
  const mCls = sim.shot ? (sim.shot.locked ? 'lock' : 'arm') : sim.cellsLeft > 0 ? 'ok' : 'out';
  const firing = sim.guns.some((g) => g.firing);
  const gState = firing ? 'firing' : sim.gunRounds <= 0 ? 'empty' : sim.gunsAuto ? 'auto' : 'hold G to fire';
  const gMax = GUN_ROUNDS * sim.guns.length;
  const gCls = firing ? 'fire' : sim.gunRounds <= 0 ? 'out' : sim.gunsAuto ? 'auto' : 'ok';
  return badge(`hb-msl ${mCls}`, `<svg viewBox="0 0 24 24">${BI.missile}</svg>`, sim.cellsLeft / CELLS, 'Missiles', `${sim.cellsLeft} of ${CELLS} · ${mState}`, String(sim.cellsLeft))
    + badge(`hb-gun ${gCls}`, `<svg viewBox="0 0 24 24">${BI.guns}</svg>`, sim.gunRounds / gMax, 'Guns', `${sim.gunRounds} rounds · ${gState}`, sim.gunsAuto ? 'A' : '');
}
// A round badge: an animated icon in a ring that shows how much is left, a chip for the number or state, and a tip that opens on hover.
const RING_C = 2 * Math.PI * 20;
function badge(cls, icon, frac, title, sub, chip) {
  const f = Math.max(0, Math.min(1, frac));
  return `<div class="hs-badge ${cls}"><svg class="hb-ring" viewBox="0 0 46 46" aria-hidden="true"><circle class="hb-bg" cx="23" cy="23" r="20"/><circle class="hb-fg" cx="23" cy="23" r="20" style="stroke-dasharray:${(RING_C * f).toFixed(1)} 126"/></svg>`
    + `<span class="hb-ico">${icon}</span>${chip === '' ? '' : `<i class="hb-chip">${chip}</i>`}<span class="hb-tip"><b>${title}</b><small>${sub}</small></span></div>`;
}
const BI = { // 24 x 24 drawings, animated by CSS (helm.css .hb-*)
  hull: '<path class="hb-fill" d="M12 2.8l7.2 2.8v5.4c0 5-3 8.6-7.2 10.2-4.2-1.6-7.2-5.2-7.2-10.2V5.6z"/><path class="hb-tick" d="M8.4 12.2l2.6 2.7 4.8-5.4"/>',
  kills: '<path d="M10.3 10.3L6.2 6.2M13.7 10.3l4.1-4.1M10.3 13.7l-4.1 4.1M13.7 13.7l4.1 4.1"/><rect x="10" y="10" width="4" height="4" rx="1" class="hb-fill"/><g class="hb-rot"><circle cx="5" cy="5" r="2.6"/><circle cx="19" cy="5" r="2.6"/><circle cx="5" cy="19" r="2.6"/><circle cx="19" cy="19" r="2.6"/></g>',
  missile: '<rect x="3.5" y="4" width="17" height="16" rx="2.2"/><g class="hb-cells"><circle cx="8.5" cy="9" r="2"/><circle cx="15.5" cy="9" r="2"/><circle cx="8.5" cy="15" r="2"/><circle cx="15.5" cy="15" r="2"/></g>',
  guns: '<g class="hb-recoil"><path class="hb-fill" d="M3 15.5h5l2-3h8.5v5.5H10l-2-2.5H3z"/></g><path class="hb-muzzle" d="M20.5 13.2l2.3-1.6M21 15.2h2.6M20.5 17.2l2.3 1.6"/><path d="M6 19.5v2M13 19.5v2"/>',
};
function hullBadgeHtml() {
  const left = 3 - sim.strikes;
  const tone = sim.out ? 'out' : sim.strikes === 0 ? 'ok' : sim.strikes === 1 ? 'hurt' : 'bad';
  return badge(`hb-hull ${tone}`, `<svg viewBox="0 0 24 24">${BI.hull}</svg>`, sim.out ? 0 : left / 3, 'Hull', sim.out ? 'out of action' : sim.strikes ? `${sim.strikes} of 3 hits` : 'intact', '');
}
function killsBadgeHtml() {
  return badge('hb-kills', `<svg viewBox="0 0 24 24">${BI.kills}</svg>`, 1, 'Kills', `${sim.kills} drone${sim.kills === 1 ? '' : 's'} shot down`, String(sim.kills));
}
function statHtml() { return hullBadgeHtml() + killsBadgeHtml() + weaponsHtml(); }

// The fire-zone gauges: for each weapon a range bar (0 to ZONE_SCALE) with the band it can engage in lit and a marker for the
// target, plus one short word: READY, or what is still missing (km to close, degrees to turn, blocked).
const ZONE_SCALE = 9000;
function weaponRow(name, band0, band1, range, bad) {
  const pct = (m) => Math.min(m, ZONE_SCALE) / ZONE_SCALE * 100;
  const ready = !bad;
  return `<div class="wz ${ready ? 'ok' : 'no'}"><b>${name}</b><div class="tz-bar"><i class="tz-band" style="left:${pct(band0).toFixed(1)}%;width:${(pct(band1) - pct(band0)).toFixed(1)}%"></i>`
    + `<i class="tz-dot" style="left:${pct(range).toFixed(1)}%"></i></div><em>${ready ? 'READY' : bad}</em></div>`;
}
function zoneHtml(t) {
  const z = sim.zone(t);
  let m = null;
  if (z.tooClose) m = 'TOO CLOSE';
  else if (z.toGo > 0) m = `+${kmText(z.toGo)}`;
  else if (z.turn > 0) m = `TURN ${z.turn}°`;
  let g = null;
  if (z.range > GUN_RANGE) g = `+${kmText(z.range - GUN_RANGE)}`;
  else if (!sim.gunsBearing(t).length) g = 'BLOCKED';
  return `<div class="tg-zone">${weaponRow('MSL', MIN_RANGE, MISSILE_RANGE, z.range, m)}${weaponRow('GUN', 0, GUN_RANGE, z.range, g)}</div>`;
}

// How fast the drone closes on the ship, m/s (negative while it opens).
const _cs = new THREE.Vector3();
function closingSpeed(t, r) {
  _cs.copy(t.vel).sub(sim.shipVel(_b));
  _a.copy(t.pos).sub(_b.set(sim.x, 0, sim.z));
  return -_a.dot(_cs) / (r || 1);
}

// The track dial: the ship at the centre, bow up, the missile arc and the guns' blind sector drawn on it, a sweep going round, every
// contact a blip (fading after the sweep passes it, the target always lit) and, on the target, a tail of where it has been and a
// vector of where it is going.
const DIAL_K = 44 / 6000; // dial units per metre (the rim is 6 km)
const SWEEP_T = 3; // s per turn
const trk = new Map(); // drone id -> its recent world positions [t, x, z]
function trackNote(d) {
  let a = trk.get(d.id);
  if (!a) { a = []; trk.set(d.id, a); }
  if (a.length && sim.t < a[a.length - 1][0]) a.length = 0; // the sim was restarted
  const last = a[a.length - 1];
  if (!last || sim.t - last[0] >= 0.5) { a.push([sim.t, d.pos.x, d.pos.z]); if (a.length > 16) a.shift(); }
  return a;
}
function dialPt(x, z) { // a world point in the ship's frame, bow up (clamped to the rim)
  const dx = x - sim.x;
  const dz = z - sim.z;
  const c = Math.cos(sim.psi);
  const s = Math.sin(sim.psi);
  const fw = dx * c + dz * s;
  const sb = -dx * s + dz * c;
  const m = Math.hypot(fw, sb);
  const k = m > 6000 ? 6000 / m : 1;
  return [50 + sb * k * DIAL_K, 50 - fw * k * DIAL_K];
}
const arcPt = (r, a) => `${(50 + r * Math.sin(a)).toFixed(1)},${(50 - r * Math.cos(a)).toFixed(1)}`; // a: clockwise from the bow
const wedge = (r, a0, a1) => `M50,50L${arcPt(r, a0)}A${r},${r} 0 ${a1 - a0 > Math.PI ? 1 : 0} 1 ${arcPt(r, a1)}Z`;
function dialSvg(sel) {
  const th = ((sim.t / SWEEP_T) % 1) * Math.PI * 2;
  let sweep = '';
  for (let i = 0; i < 9; i += 1) sweep += `<path d="${wedge(44, th - (i + 1) * 0.08, th - i * 0.08)}" style="opacity:${(0.3 * (1 - i / 9) ** 1.6).toFixed(3)}"/>`;
  let blips = '';
  for (const d of sim.detected) {
    if (d === sel) continue;
    const [x, y] = dialPt(d.pos.x, d.pos.z);
    const lag = ((th - Math.atan2(x - 50, 50 - y)) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2);
    blips += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.3" class="dl-dot ${d.phase}" style="opacity:${(0.3 + 0.7 * Math.exp(-lag / 1.5)).toFixed(2)}"/>`;
  }
  let lock = '';
  if (sel) {
    const [x, y] = dialPt(sel.pos.x, sel.pos.z);
    const tail = trackNote(sel).map((p) => dialPt(p[1], p[2]).map((v) => v.toFixed(1)).join(',')).join(' ');
    _a.copy(sel.vel).sub(sim.shipVel(_b)); // its motion over the water, in the ship's frame
    const fw = _a.x * Math.cos(sim.psi) + _a.z * Math.sin(sim.psi);
    const sb = -_a.x * Math.sin(sim.psi) + _a.z * Math.cos(sim.psi);
    const vm = Math.hypot(fw, sb) || 1;
    const vx = x + (sb / vm) * 11;
    const vy = y - (fw / vm) * 11;
    lock = `<polyline points="${tail}" class="dl-tail"/><line x1="${x.toFixed(1)}" y1="${y.toFixed(1)}" x2="${vx.toFixed(1)}" y2="${vy.toFixed(1)}" class="dl-vec"/>`
      + `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="6" class="dl-halo ${sel.phase}"/><circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.8" class="dl-dot sel ${sel.phase}"/>`;
  }
  const gun = GUN_RANGE * DIAL_K;
  return `<svg viewBox="0 0 100 100" class="tk-dial" aria-hidden="true"><circle cx="50" cy="50" r="46" class="dl-bg"/>`
    + `<path d="${wedge(MISSILE_RANGE * DIAL_K, -ARC, ARC)}" class="dl-arc"/>`
    + `<path d="${wedge(gun, -GUN_BLOCK, GUN_BLOCK)}" class="dl-blk"/><circle cx="50" cy="50" r="${gun.toFixed(1)}" class="dl-gun"/>`
    + `<circle cx="50" cy="50" r="22" class="dl-ring"/><circle cx="50" cy="50" r="44" class="dl-ring"/>`
    + `<path d="M50 6V94M6 50H94" class="dl-ax"/><g class="dl-sw">${sweep}</g>`
    + `<path d="M50,50L${arcPt(44, th)}" class="dl-sl"/>${blips}${lock}`
    + `<path d="M50 44l3.6 8.5h-7.2z" class="dl-ship"/></svg>`;
}
// A contact's own little bearing dial for the list: the bow up, a dot where it lies.
function miniDial(d) {
  const b = sim.relBearing(d.pos);
  const x = (12 + Math.sin(b) * 8.2).toFixed(1);
  const y = (12 - Math.cos(b) * 8.2).toFixed(1);
  return `<svg viewBox="0 0 24 24" class="cd" aria-hidden="true"><circle cx="12" cy="12" r="10.5" class="cd-r"/><path d="M12 1.5v3" class="cd-b"/>`
    + `<line x1="12" y1="12" x2="${x}" y2="${y}" class="cd-l"/><circle cx="${x}" cy="${y}" r="2.4" class="cd-p"/></svg>`;
}
const rangeParts = (m) => (m >= 1000 ? [(m / 1000).toFixed(1), 'km'] : [String(Math.round(m)), 'm']);
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const chevs = (closing) => `<span class="tk-chev${closing > 5 ? ' in' : ''}" style="--spd:${Math.max(0.25, 1.6 - closing / 120).toFixed(2)}s">›››</span>`;
const tkCell = (label, value, unit, extra = '') => `<div class="tk-cell"><span>${label}</span><b>${value}<small>${unit}</small></b>${extra}</div>`;

function hudHtml() {
  const out = [];
  // The drone data: one track block for the target, then the radar contacts.
  const t = sim.target;
  const phaseWord = { inbound: 'inbound', pass: 'low pass', extend: 'opening', attack: 'ATTACK' };
  if (t) {
    const r = sim.rangeTo(t.pos);
    const tone = r < 1500 ? 'high' : r < 3000 ? 'mid' : 'low';
    const taken = Math.max(0, DRONE_HP - t.hp);
    const closing = closingSpeed(t, r);
    const eta = closing > 5 ? (r / closing) : null;
    const rel = THREE.MathUtils.radToDeg(sim.relBearing(t.pos));
    const brg = (((sim.headingDeg + rel) % 360) + 360) % 360;
    const [rv, ru] = rangeParts(r);
    out.push(`<div class="hud-sec tg tg-${tone}"><div class="tk-top"><span class="tk-id">TRK<b>${t.name}</b></span><em class="${t.phase}">${phaseWord[t.phase] ?? t.phase}</em>`
      + `<span class="tk-eta${eta !== null && eta < 30 ? ' soon' : ''}">${eta === null ? 'OPENING' : `IMPACT ${mmss(eta)}`}</span></div>`
      + `<div class="tk-main">${dialSvg(t)}<div class="tk-read"><strong class="tg-range">${rv}<small>${ru}</small></strong>`
      + `<span class="tk-brg ${rel < 0 ? 'port' : 'stbd'}">${relName(sim.relBearing(t.pos)).toUpperCase()}</span><span class="tk-true">TRUE ${String(Math.round(brg) % 360).padStart(3, '0')}°</span></div></div>`
      + `<div class="tk-cells">${tkCell('SPEED', Math.round(t.vel.length() * 3.6), 'km/h')}`
      + `<div class="tk-cell${closing > 5 ? ' in' : ''}"><span>CLOSING</span><b>${closing < 0 ? '−' : ''}${Math.round(Math.abs(closing) * 3.6)}<small>km/h</small></b>${chevs(closing)}</div>`
      + `${tkCell('ALT', f(t.pos.y), 'm', `<i class="tk-alt" style="--p:${Math.min(1, t.pos.y / 400).toFixed(2)}"></i>`)}</div>`
      + `<div class="tg-dmg${taken ? ' hurt' : ''}"><span>Damage</span><div class="hs-pips">${Array.from({ length: DRONE_HP }, (_, i) => `<i class="${i < taken ? 'hit' : ''}"></i>`).join('')}</div><em>${taken ? `${taken} of ${DRONE_HP} hits` : 'none'}</em></div>`
      + `${zoneHtml(t)}</div>`);
  } else {
    out.push(`<div class="hud-sec tg tg-none"><div class="tk-top"><span class="tk-id">TRK<b>—</b></span><em>scanning</em><span class="tk-eta">Tab selects</span></div>`
      + `<div class="tk-main">${dialSvg(null)}<div class="tk-read"><strong class="tg-range tg-idle">NO<small>CONTACT</small></strong><span class="tk-true">RADAR ${kmText(RADAR_RANGE)}</span></div></div></div>`);
  }

  // The radar picture: every contact on one line, each with its own little bearing dial.
  const contacts = sim.detected.sort((a, b) => sim.rangeTo(a.pos) - sim.rangeTo(b.pos));
  const word = { inbound: 'inbound', pass: 'low pass', extend: 'opening', attack: 'ATTACK RUN' };
  const rows = contacts.map((d) => {
    const r = sim.rangeTo(d.pos);
    const [rv, ru] = rangeParts(r);
    return `<div class="ct ${d.phase}${d.id === sim.targetId ? ' sel' : ''}">${miniDial(d)}<div class="ct-id"><b>${d.name}</b><em>${word[d.phase] ?? d.phase}</em></div>`
      + `<div class="ct-rg"><strong>${rv}<small>${ru}</small></strong>${chevs(closingSpeed(d, r))}</div></div>`;
  }).join('');
  const thr = ['Clear', 'Contact', 'Threat close', 'Under attack'][sim.threat];
  if (contacts.length > 1) { // the list is only worth its room when there is more than the target to see
    out.push(`<div class="hud-sec">${head(`Radar · ${contacts.length}`, thr, ['ok', 'warn', 'bad', 'bad'][sim.threat])}${rows}</div>`);
  }
  return out.join('');
}

// The line of keys at the foot of the screen.
const keysEl = document.createElement('div');
keysEl.id = 'fly-keys';
keysEl.className = 'fly-keys';
document.body.appendChild(keysEl);
let lastKeys = '';
// The key bar is also clickable: a click does what the key does (G is held while the button is held).
function keyFromBar(e) { return e.target instanceof Element ? e.target.closest('.fk-btn')?.dataset.key : null; }
keysEl.addEventListener('pointerdown', (e) => {
  const key = keyFromBar(e);
  if (!key) return;
  e.preventDefault();
  window.dispatchEvent(new KeyboardEvent('keydown', { key }));
  if (key === 'g') {
    const up = () => { window.dispatchEvent(new KeyboardEvent('keyup', { key })); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up); };
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  } else window.dispatchEvent(new KeyboardEvent('keyup', { key }));
});
let lastKeysH = 0;
function keysHtml() {
  const KEY_OF = { 'Tab': 'Tab', '1–7': null };
  const k = (key, label, on = false) => (KEY_OF[key] === null ? `<span class="fk${on ? ' on' : ''}"><kbd>${key}</kbd>${label}</span>`
    : `<span class="fk fk-btn${on ? ' on' : ''}" data-key="${KEY_OF[key] ?? key.toLowerCase()}"><kbd>${key}</kbd>${label}</span>`);
  if (sim.out) return `${k('R', 'sail again', true)}${k('V', 'camera')}`;
  const radarKeysHtml = view === 'sight' ? '<span class="fk"><kbd>← ↑ ↓ →</kbd>aim radar</span><span class="fk"><kbd>Enter</kbd>lock</span><span class="fk"><kbd>Space</kbd>release</span>' : '';
  const t = sim.target;
  const ready = t && !sim.engageable(t) && !sim.shot && sim.cellsLeft > 0;
  return `${radarKeysHtml}${sim.shot?.hold ? `${k('M', 'stand down')}${k('F', 'launch', sim.shot.locked)}` : k('M', 'ready missile', ready)}${k('G', 'guns (hold)', input.gun === 1)}${k('A', 'auto guns', sim.gunsAuto)}`
    + `${k('E', sim.heli.action === 'takeoff' ? (sim.standDown ? 'heli stays: drone near' : 'heli take off') : sim.heli.action === 'land' ? 'heli land' : 'heli landing', sim.heli.action === null || (sim.standDown && sim.heli.action === 'takeoff'))}${k('D', 'add drone')}${k('Tab', 'target', sim.detected.length > 1)}${k('1–7', 'views')}${k('V', 'next view')}`;
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
  actions.hidden = !on;
  rangeEl.hidden = !on;
  hudButton.classList.toggle('active', on);
  hudButton.setAttribute('aria-pressed', String(on));
}
hudButton.addEventListener('click', () => setHud(!hudOn));
setHud(true);
let tagsOn = true;

// The view buttons: a strip at the top, beside the gear. Each is an icon; the one in use opens into a pill with its name. The last button shows the key bar.
const strip = document.createElement('div');
strip.className = 'helm-views';
const VIEW_LABELS = ['Bridge', 'Behind', 'Above', 'Missile', 'Radar', 'Target', 'Orbit'];
const MOTION = !globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const VIEW_ICONS = { // drawn for what each view is: the wheelhouse wheel, a chase camera, a plan view, a missile, the radar, a target sight, an orbit
  bridge: '<g class="wheel"><circle cx="12" cy="12" r="6.2"/><circle cx="12" cy="12" r="1.7"/><path d="M12 2.5v4M12 17.5v4M2.5 12h4M17.5 12h4M5.3 5.3l2.5 2.5M16.2 16.2l2.5 2.5M18.7 5.3l-2.5 2.5M7.8 16.2l-2.5 2.5"/></g>',
  behind: '<path d="M8 14h13l-2.5 4H10z"/><path d="M12 14v-3h5l1.5 3"/><g class="lines"><path d="M2 12.5h3.5M1 15.5h4.5M3 18.5h3.5"/></g>',
  above: '<path d="M12 2.5c3.2 3 4.3 7 4.3 11v5.7L14 22h-4l-2.3-2.8v-5.7c0-4 1.1-8 4.3-11z"/><path d="M12 8v10M9.7 13h4.6"/>',
  missile: '<path d="M3 19C7 6 15 3.5 20 8"/><path d="M16 4.8l4.4 3.4-4.8 2.4"/><circle cx="3.5" cy="18.5" r="1.4" style="fill:currentColor;stroke:none"/><g class="lines"><path d="M8 20.5h4M13 20.5h3"/></g>',
  sight: '<circle cx="12" cy="12" r="9.3"/><circle cx="12" cy="12" r="4.7"/><g class="sweep"><path d="M12 12L19 5.6"/><path class="beam" d="M12 12L19 5.6A9.3 9.3 0 0 1 21.3 12z"/></g><circle cx="8" cy="8.5" r="1" style="fill:currentColor"/>',
  target: '<circle cx="12" cy="12" r="6"/><path d="M12 2.5v5M12 16.5v5M2.5 12h5M16.5 12h5"/><circle cx="12" cy="12" r="1.1" style="fill:currentColor"/>',
  orbit: '<g transform="rotate(-25 12 12)"><ellipse cx="12" cy="12" rx="9.5" ry="4.6"/>' + (MOTION ? '<circle r="1.7" style="fill:currentColor"><animateMotion dur="3.2s" repeatCount="indefinite" path="M21.5 12a9.5 4.6 0 1 1 -19 0a9.5 4.6 0 1 1 19 0"/></circle>' : '<circle cx="21.5" cy="12" r="1.7" style="fill:currentColor"/>') + '</g><path d="M9.7 12.6h4.6l-.9 1.5h-2.8zM12 10.3v2.3"/>',
};
strip.innerHTML = VIEWS.map((v, i) => `<button type="button" data-view="${v}" title="${VIEW_NAMES[v]} (${i + 1})" aria-label="${VIEW_LABELS[i]}"><svg viewBox="0 0 24 24">${VIEW_ICONS[v]}</svg><span>${VIEW_LABELS[i]}</span></button>`).join('');
document.body.appendChild(strip);
const viewButtons = [...strip.querySelectorAll('button')];
viewButtons.forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
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

// The top bar is one gear: its menu holds everything the mission needs (the old row of buttons is hidden in helm.css).
{
  menuButton.innerHTML = '<svg><use href="#i-gear"/></svg>';
  menuButton.title = 'Settings';
  menuButton.setAttribute('aria-label', 'Settings');
  const tagsButton = document.createElement('button'), cineButton = document.createElement('button');
  tagsButton.id = 'btn-tags'; cineButton.id = 'btn-cine';
  const fsButton = document.querySelector('#btn-fullscreen');
  // A small vector drawing in front of each entry, for what it does (it moves a little on hover: helm.css `.mi`).
  const MI = {
    restart: '<path class="mi-a" d="M20 12a8 8 0 1 1-2.6-5.9M20 4v4.5h-4.5"/>',
    menu: '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>',
    readouts: '<rect x="3.5" y="4.5" width="17" height="12" rx="2"/><path d="M7 13l3-3.2 2.4 2 3.6-4.3M9 20h6M12 16.5V20"/>',
    map: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4"/><path class="mi-a" d="M12 12l5.5-5"/>',
    tags: '<path d="M3.5 12.2V4.5h7.7l9 9a1.6 1.6 0 0 1 0 2.2l-5 5a1.6 1.6 0 0 1-2.2 0z"/><circle cx="8" cy="9" r="1.3"/>',
    cine: '<rect x="3" y="7" width="13" height="10" rx="2"/><path d="M16 11l5-3v8l-5-3"/>',
    sound: '<path d="M4 9.5h3.5L12 6v12l-4.5-3.5H4z"/><path class="mi-w1" d="M15.5 9.2a4 4 0 0 1 0 5.6"/><path class="mi-w2" d="M18.2 6.8a7.5 7.5 0 0 1 0 10.4"/>',
    full: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
    hide: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/><path class="mi-a" d="M4 4l16 16"/>',
    keys: '<rect x="2.5" y="6" width="19" height="12" rx="2.5"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7.5 14h9"/>',
  };
  const item = (b, label, key, ic) => { b.className = ''; b.setAttribute('role', 'menuitem'); b.innerHTML = `<span class="mi-l">${ic ? `<svg class="mi" viewBox="0 0 24 24" aria-hidden="true">${MI[ic]}</svg>` : ''}${label}</span>${key ? `<kbd>${key}</kbd>` : ''}`; return b; };
  const head = (t) => { const h = document.createElement('div'); h.className = 'menu-h'; h.textContent = t; return h; };
  const weatherBtn = document.querySelector('#btn-weather'), seaRow = document.querySelector('#sea-row');
  item(restartButton, 'Sail again', 'R', 'restart');
  item(document.querySelector('#btn-ship'), 'Main menu', '', 'menu');
  item(hudButton, 'Readouts', 'H', 'readouts');
  item(mapButton, 'Radar map', 'N', 'map');
  item(tagsButton, 'Drone tags', 'L', 'tags');
  item(cineButton, 'Intercept camera', 'I', 'cine');
  item(soundButton, 'Sound', 'S', 'sound');
  item(fsButton, 'Fullscreen', '', 'full');
  item(foldButton, 'Hide the interface', 'C', 'hide');
  item(document.querySelector('#btn-keys'), 'Keyboard shortcuts', '?', 'keys');
  menuEl.replaceChildren(head('Mission'), restartButton, document.querySelector('#btn-ship'), head('Display'), hudButton, mapButton, tagsButton, cineButton, foldButton, fsButton,
    head('Sound'), soundButton, head('Sea'), ...[seaRow, weatherBtn].filter(Boolean), head('Help'), document.querySelector('#btn-keys'));
  [hudButton, mapButton, soundButton, tagsButton, cineButton].forEach((b) => b.setAttribute('aria-pressed', 'true'));
  tagsButton.addEventListener('click', () => { tagsOn = !tagsOn; refreshGear(); });
  cineButton.addEventListener('click', () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'i' })); refreshGear(); });
  fsButton.addEventListener('click', () => { try { if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen(); } catch { /* not allowed here */ } });
  function refreshGear() {
    const set = (b, on) => { b.classList.toggle('active', on); b.setAttribute('aria-pressed', String(on)); };
    set(hudButton, hudOn); set(mapButton, map.enabled); set(tagsButton, tagsOn); set(cineButton, cineOn); set(soundButton, audio.enabled);
  }
  menuButton.addEventListener('click', refreshGear);
}

keysSheet.querySelector('dl').innerHTML = [
  ['<kbd>←</kbd> <kbd>→</kbd>', 'Rudder to port / starboard while held; let go and it comes back amidships'],
  ['<kbd>← ↑ ↓ →</kbd> in Radar', 'In the radar view the arrows aim the radar by hand (the steering readouts are hidden there); <kbd>Enter</kbd> locks what is in the sight, <kbd>Space</kbd> goes back to automatic tracking, and a drag aims too'],
  ['<kbd>↑</kbd> <kbd>↓</kbd>', 'Engine telegraph, one step: slow astern, stop, dead slow, slow, half, full, flank'],
  ['<kbd>M</kbd>', `Make a missile ready on the target: the launcher turns and locks, then waits (${CELLS} cells; ${kmText(MISSILE_RANGE)} at most; ahead and abeam only). Press M again to stand it down`],
  ['<kbd>F</kbd>', 'Launch the ready missile (with none ready, it readies and launches one)'],
  ['<kbd>E</kbd>', 'The helicopter: take off, or land (only on a steady course: no rudder, no turn)'],
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
const input = { left: 0, right: 0, gun: 0 }; // gun: G held
function restart() {
  sim.seed = (Date.now() % 100000) | 0;
  sim.reset();
  sim.gunsAuto = true;
  for (const id of [...vis.keys()]) dropVis(id);
  for (const [, v] of mvis) scene.remove(v.model.group);
  mvis.clear();
  strikes.length = 0;
  fx.clear();
  audio.reset();
  banner.hidden = true;
  wake.clear();
  timeScale = timeTarget = 1;
  setView('behind', true);
  say('Half ahead on 000: watch the radar', '', 3000);
}

window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLElement && e.target.closest('input, textarea, select')) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (view === 'sight') { // in the radar view the arrows aim the radar, not the ship
    const dir = { ArrowLeft: 'l', ArrowRight: 'r', ArrowUp: 'u', ArrowDown: 'd' }[e.key];
    if (dir) { if (!sight.locked) { radarKeys[dir] = 1; sight.manual = true; } e.preventDefault(); return; }
    if (e.key === 'Enter') { lockHover(); e.preventDefault(); return; }
    if (e.key === ' ') { sight.manual = false; sight.locked = false; e.preventDefault(); return; }
    if (e.key === 'Tab') sight.manual = false;
  }
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    input[e.key === 'ArrowLeft' ? 'left' : 'right'] = 1;
    e.preventDefault();
    return;
  }
  if (e.key === 'g' || e.key === 'G') { input.gun = 1; e.preventDefault(); return; }
  if (e.key === 'Tab') { e.preventDefault(); if (!e.repeat) sim.cycleTarget(); return; }
  if (e.repeat) { if (e.key.startsWith('Arrow')) e.preventDefault(); return; }
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  switch (key) {
    case 'ArrowUp': sim.telegraph(+1); break;
    case 'ArrowDown': sim.telegraph(-1); break;
    case 'm': sim.arm(); break; // make a missile ready (again: stand it down)
    case 'f': sim.launchReady(); break; // launch the ready missile
    case 'a': sim.toggleAutoGuns(); break;
    case 'd': sim.summon(); break; // send in a drone
    case 'e': say(sim.heliRequest(), ''); break; // the helicopter: take off, or land
    case 'r': restart(); break;
    case 'v': setView(VIEWS[(VIEWS.indexOf(view) + 1) % VIEWS.length]); break;
    case '1': case '2': case '3': case '4': case '5': case '6': case '7': setView(VIEWS[Number(key) - 1]); break;
    case 'h': setHud(!hudOn); break;
    case 'n': setMap(!map.enabled); break;
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
  const rdir = { ArrowLeft: 'l', ArrowRight: 'r', ArrowUp: 'u', ArrowDown: 'd' }[e.key];
  if (rdir) radarKeys[rdir] = 0;
  if (e.key === 'ArrowLeft') input.left = 0;
  if (e.key === 'ArrowRight') input.right = 0;
  if (e.key === 'g' || e.key === 'G') input.gun = 0;
});
window.addEventListener('blur', () => { radarKeys.l = radarKeys.r = radarKeys.u = radarKeys.d = 0; input.left = 0; input.right = 0; input.gun = 0; });

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
  updateGuns(dt * timeScale);
  updatePip(dt);
  audio.update(sim, camera, dt);
  env.follow(camera.position);
  env.setShadowFocus(_b.set(sim.x, 0, sim.z), 90);
  fx.update(sim.t);
  map.sight = view === 'sight' ? { yaw: Math.atan2(sight.aim.z, sight.aim.x), half: Math.atan(Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) * camera.aspect), locked: sight.locked } : null;
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
    const st = statHtml();
    if (st !== lastStat) { statHost.innerHTML = st; lastStat = st; }
    const dm = `<div class="hs-dome">${domeSvg()}</div>`;
    if (dm !== lastDome) { domeHost.innerHTML = dm; lastDome = dm; }
    spinProps(dt);
    updateActions();
    updateRange();
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
window.__helm = { sim, audio, camera, controls, rig, renderer, scene, env, fx, ship: ship.group, setView, restart, get view() { return view; }, get cine() { return cine; } };

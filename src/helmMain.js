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
  HelmSim, TELEGRAPH, RUDDER_MAX, CELLS, MISSILE_RANGE, BRIDGE_EYE, DIRECTOR_EYE, relName, kmText,
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

// --- The ship's wake: a ribbon behind her stern over the last minute ---------------------------------------
const WAKE_N = 90;
const WAKE_DT = 0.6;
const wakeHist = [];
let wakeLast = -Infinity;
const wake = (() => {
  const pos = new Float32Array(WAKE_N * 9);
  const col = new Float32Array(WAKE_N * 12);
  const index = [];
  for (let i = 0; i < WAKE_N - 1; i++) {
    const a = i * 3;
    const b = a + 3;
    index.push(a, a + 1, b, a + 1, b + 1, b, a + 1, a + 2, b + 1, a + 2, b + 2, b + 1);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 4));
  geo.setIndex(index);
  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide }));
  mesh.frustumCulled = false;
  mesh.renderOrder = 2;
  scene.add(mesh);
  return { pos, col, geo };
})();
function updateWake() {
  if (sim.t < wakeLast) { wakeHist.length = 0; wakeLast = -Infinity; }
  if (sim.t - wakeLast >= WAKE_DT) {
    const sx = sim.x - Math.cos(sim.psi) * 56; // from the stern
    const sz = sim.z - Math.sin(sim.psi) * 56;
    wakeHist.unshift({ x: sx, z: sz, psi: sim.psi, t: sim.t, turn: Math.min(Math.abs(sim.r) / 0.04, 1.4), u: Math.max(sim.u, 0) });
    if (wakeHist.length > WAKE_N) wakeHist.pop();
    wakeLast = sim.t;
  }
  for (let i = 0; i < WAKE_N; i++) {
    const h = wakeHist[i];
    if (!h) { wake.col.fill(0, i * 12, i * 12 + 12); continue; }
    const age = sim.t - h.t;
    const u = age / (WAKE_N * WAKE_DT);
    const half = (3 + 12 * Math.sqrt(u)) * (1 + 0.6 * h.turn);
    const px = -Math.sin(h.psi);
    const pz = Math.cos(h.psi);
    // The newest point sits right at the stern, wherever she is now.
    const bx = i === 0 ? sim.x - Math.cos(sim.psi) * 56 : h.x;
    const bz = i === 0 ? sim.z - Math.sin(sim.psi) * 56 : h.z;
    wake.pos.set([bx + px * half, 0.45, bz + pz * half, bx, 0.45, bz, bx - px * half, 0.45, bz - pz * half], i * 9);
    const a = Math.min(0.55 * (1 - u) ** 2 * (0.3 + 0.7 * Math.min(h.u / 8, 1)) * (1 + 0.4 * h.turn), 0.85);
    wake.col.set([0.95, 0.98, 1, 0, 0.95, 0.98, 1, a, 0.95, 0.98, 1, 0], i * 12);
  }
  wake.geo.attributes.position.needsUpdate = true;
  wake.geo.attributes.color.needsUpdate = true;
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
      case 'fire':
        fx.launchBillow(e.pos, e.dir, sim.t);
        if (cine && cine.phase === 'slew') {
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
      case 'alarm': if (e.level === 3) startCine(null, e.id); break; // an attack run: the camera watches it from the side
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
    const n = Math.min(60, Math.floor(gap / 2.5));
    for (let i = 1; i <= n; i++) fx.missileTrail(_c.lerpVectors(v.trailLast, m.pos, i / n), t);
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
const VIEWS = ['bridge', 'behind', 'above', 'missile', 'sight', 'orbit'];
const VIEW_NAMES = {
  bridge: 'Bridge (drag to look round)', behind: 'Behind the ship', above: 'Above the ship, heading up',
  missile: 'Riding the missile', sight: 'Fire-control sight', orbit: 'Orbit (drag and wheel)',
};
let view = 'behind';
let lookYaw = 0; // bridge: degrees off the bow, + to starboard
let lookPitch = -0.03;
let behindDist = 190;
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

function setFov(f) {
  if (Math.abs(f - camera.fov) < 1e-3) return;
  camera.fov = f;
  camera.updateProjectionMatrix();
  pointScale.value = (window.innerHeight * renderer.getPixelRatio()) / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));
}

const shipTarget = (out) => out.set(sim.x, 10, sim.z);
function setView(v, quiet = false) {
  view = v;
  if (v === 'sight') sight.fresh = true; // the director starts from the bow and finds the target again
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
//  - F is pressed: the camera cuts close to the launcher, from the side, in slow motion with a slow zoom, to watch it turn
//    onto the target and fire; then it goes to the side of the shot, keeps the missile and the drone in the frame and closes
//    in as they close on each other (the time eases back to normal in flight and slows again for the last metres), until
//    the hit; it stays on the wreck until the last piece is in the sea, waits CINE_TAIL seconds more, and goes back;
//  - a drone starts an attack run (and no missile is on it): the same side view of the drone and the ship, closing in;
//  - a drone hits the ship (whichever of the two shots was on): the camera comes in close, from outboard, on the place
//    where it hit, and stays there IMPACT_HOLD seconds, the fire burning, then goes back.
// A missile that is lost, or a drone that goes into the sea, ends the shot at once. Any view key, or I, ends it; it is
// skipped in the free orbit (that view is the player's own, and its controls keep their own camera state).
const CINE_TAIL = 2; // s kept on the scene after the drone is in the sea
const CINE_MAX = 60; // s: a shot never holds the camera longer than this
const IMPACT_HOLD = 5; // s on the place of a hit
const LAUNCH_HOLD = 0.8; // s (of simulated time) the camera stays on the launcher after the round leaves
// The speed of time (1 = real time) in each part of the shot; the loop eases toward it.
const SLOW = { slew: 0.4, launch: 0.3, fly: 0.9, close: 0.35, wreck: 0.45 };
let timeScale = 1;
let timeTarget = 1;
let cineOn = true;
try { cineOn = localStorage.getItem('intercept.helmcine') !== '0'; } catch { /* storage unavailable */ }
let cine = null;
let pendingOrbit = false; // the ship is out of action: the orbit view comes once the shot of the last hit is over
function newCine(mid, did, phase) {
  sightEl.hidden = true;
  document.body.classList.remove('helm-sighting');
  return { mid, did, phase, t0: sim.t, side: 0, pos: new THREE.Vector3(), look: new THREE.Vector3(), hold: new THREE.Vector3(), tSplash: null, fresh: true, local: new THREE.Vector3(), tImpact: 0, camLocal: new THREE.Vector3(), tLaunch: 0, tBlend: 0 };
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
  return THREE.MathUtils.lerp(46, 28, THREE.MathUtils.smoothstep(progress, 0, 1)); // the slow zoom
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
  cine.phase = 'impact';
  cine.tImpact = sim.t;
  cine.local.copy(sim.toLocal(e.pos, _a)).setY(Math.max(e.pos.y, 8)); // the same point the fire burns at
  cine.side = 0;
}
function endCine() {
  timeTarget = 1;
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
// The hit: in close, from outboard, on the place; the ship moves, so it is followed in her own frame.
function frameImpact(c, dt) {
  if (sim.t - c.tImpact > IMPACT_HOLD) { endCine(); return null; }
  const P = ship.group.localToWorld(_c.copy(c.local));
  _a.set(-Math.sin(sim.psi), 0, Math.cos(sim.psi)); // starboard
  if (!c.side) c.side = _a.dot(_b.set(camera.position.x - sim.x, 0, camera.position.z - sim.z)) >= 0 ? 1 : -1; // the side it was filmed from
  const want = _d.copy(P).addScaledVector(_a, c.side * 60);
  want.y = P.y + 14;
  c.pos.lerp(want, 1 - Math.exp(-dt / 0.6)); // the dolly in
  c.look.lerp(P, 1 - Math.exp(-dt / 0.15));
  camera.position.copy(c.pos);
  if (camera.position.y < 3) camera.position.y = 3;
  camera.lookAt(c.look);
  return 24;
}
// Frames the shot; returns the lens (degrees), or null once the shot is over.
function updateCine(dt) {
  const c = cine;
  if (c.phase === 'impact') { timeTarget = 1; return frameImpact(c, dt); }
  if (c.phase === 'slew') { // the launcher turns: close on it, in slow motion
    if (!sim.shot) { endCine(); return null; } // cancelled
    timeTarget = SLOW.slew;
    return frameLauncher(c, (sim.t - c.t0) / 1.6);
  }
  if (c.phase === 'launch') { // the round leaves its cell: still on the launcher
    if (sim.t - c.tLaunch < LAUNCH_HOLD) { timeTarget = SLOW.launch; return frameLauncher(c, 1); }
    c.phase = 'approach'; // then the camera leaves the ship to follow it
    c.tBlend = sim.t;
    c.pos.copy(camera.position);
    c.look.copy(ship.group.localToWorld(_c.copy(LAUNCHER_PIVOT)));
    c.fresh = false;
  }
  const m = sim.missiles.find((x) => x.id === c.mid);
  if (m) c.did = m.targetId; // it may have taken another drone
  const d = sim.drones.find((x) => x.id === c.did);
  if (sim.out || !d || sim.t - c.t0 > CINE_MAX) { endCine(); return null; }
  const pull = 1 - Math.exp(-dt / 0.12);
  if (c.phase === 'approach' && !d.alive && d.wreck && d.wreck.kind === 'missile') { c.phase = 'wreck'; c.hold.copy(c.pos); }
  if (c.phase === 'approach' && !m && d.alive && d.phase === 'attack') c.phase = 'dive'; // the missile is gone, the drone is still coming
  if (c.phase === 'approach') {
    if (!m || !d.alive) { endCine(); return null; } // the missile was lost, or the drone went into the sea: back to the view
    const sep = m.pos.distanceTo(d.pos);
    timeTarget = sep < 350 ? SLOW.close : SLOW.fly; // brisk in flight, slow for the last metres
    return frameSide(c, m.pos, d.pos, dt, true, 0.12 + 0.8 * (1 - THREE.MathUtils.clamp((sim.t - c.tBlend) / 1.6, 0, 1)));
  }
  if (c.phase === 'dive') {
    if (!d.alive) { endCine(); return null; } // (a hit on the ship comes as its own event)
    timeTarget = 1;
    return frameSide(c, _e.set(sim.x, 9, sim.z), d.pos, dt, false);
  }
  // The missile's hit: the camera stays where it was and follows the falling pieces until the last one is in the sea.
  const v = vis.get(d.id);
  const tau = sim.t - d.wreck.t;
  if (c.tSplash === null && v?.debris) c.tSplash = d.wreck.t + Math.max(...v.debris.pieces.map((p) => p.tauWater));
  timeTarget = sim.t < d.wreck.t + 2.2 ? SLOW.wreck : 1; // the burst in slow motion, then on to the splash
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

function updateCamera(dt) {
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
  } else if (view === 'sight' && sim.target) {
    // The fire-control director on the bridge roof. It is a real mount, not a camera glued to the drone: it turns at a
    // limited rate, so on entering the view, or when the target changes, it swings round to it with the lens wide, hunts
    // about the target for a moment (a wandering that dies away) while the lens closes in, and then locks on and tracks.
    const d = sim.target;
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
      const s = Math.min(el / SIGHT_SEARCH, 1);
      if (s >= 1) sight.phase = 'lock';
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
    wantFov = Math.max(fovWant * sightZoom, 1);
    const found = sight.phase === 'lock';
    sightTxt.textContent = found
      ? `${d.name} · ${relName(sim.relBearing(d.pos))} · ${kmText(sim.rangeTo(d.pos))} · ${Math.round(d.pos.y)} m${sim.engageable(d) ? '' : ' · IN ARC'}`
      : `${d.name} · searching…`;
    sightEl.classList.toggle('lock', found && !sim.engageable(d));
    sightEl.classList.toggle('searching', !found);
  } else {
    // Behind her (also the fallback for the missile and sight views with nothing to show).
    if (snap) camYaw = sim.psi;
    else camYaw += Math.atan2(Math.sin(sim.psi - camYaw), Math.cos(sim.psi - camYaw)) * k;
    const ang = camYaw + THREE.MathUtils.degToRad(behindYaw);
    camera.position.set(sim.x - Math.cos(ang) * behindDist, behindDist * 0.3 + 18, sim.z - Math.sin(ang) * behindDist);
    lookAt.set(sim.x + Math.cos(camYaw) * 50, 8, sim.z + Math.sin(camYaw) * 50);
    camera.lookAt(lookAt);
    snap = false;
    if (view === 'sight') sightTxt.textContent = 'No target on the radar';
  }
  fov += (wantFov - fov) * (view === 'sight' ? 1 - Math.exp(-dt / 0.3) : 1);
  setFov(fov);
}
let behindYaw = 0;
let sightZoom = 1;
// The fire-control director's mount (see updateCamera): its aim, its turning speed and where it is in finding the target.
const SIGHT_RATE = THREE.MathUtils.degToRad(55); // the fastest it turns, per second
const SIGHT_WIDE = 24; // degrees: the lens while it looks for the target
const SIGHT_SEARCH = 1.7; // s of hunting about the target before it locks
const UP = new THREE.Vector3(0, 1, 0);
const sight = { id: null, phase: 'slew', t0: 0, omega: 0, fresh: true, aim: new THREE.Vector3(1, 0, 0) };

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
canvas.addEventListener('dblclick', () => { lookYaw = 0; lookPitch = -0.03; behindYaw = 0; behindDist = 190; aboveH = 520; sightZoom = 1; });
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

function hudHtml() {
  const out = [];
  // The ship: heading, speed, the telegraph and the wheel.
  const o = TELEGRAPH[sim.order];
  const ord = o.kn === 0 ? 'Stop' : `${o.name}${o.kn > 0 ? ' ahead' : ''}`;
  const rud = THREE.MathUtils.radToDeg(sim.rudder);
  const rudTxt = Math.abs(rud) < 0.5 ? 'midships' : `${f(Math.abs(rud))}° ${rud > 0 ? 'stbd' : 'port'}`;
  const rot = sim.rateOfTurn;
  const chip = sim.out ? ['Out of action', 'bad'] : sim.strikes ? [`Damage ${sim.strikes}/3`, 'warn'] : ['Under way', 'live'];
  out.push(`<div class="hud-sec">${head('Ship', ...chip)}<div class="tiles">`
    + tile('Heading', f(sim.headingDeg).padStart(3, '0'), '°')
    + tile('Speed', f(sim.knots, 1), 'kn')
    + tile('Telegraph', ord, '', 'wide')
    + `<div class="tile wide helm-rudder"><span>Rudder · ${rudTxt}${Math.abs(rot) >= 1 ? ` · turning ${f(Math.abs(rot))}°/min ${rot > 0 ? 'stbd' : 'port'}` : ''}</span>`
    + `<div class="hr-bar"><i style="--r:${(sim.rudder / RUDDER_MAX).toFixed(3)}"></i></div></div>`
    + '</div></div>');

  // Weapons: rounds, the launcher, the target.
  const t = sim.target;
  let wChip = [`${sim.cellsLeft} of ${CELLS} ready`, sim.cellsLeft ? '' : 'bad'];
  if (sim.shot) wChip = ['Launcher turning', 'warn'];
  else if (sim.missiles.length) wChip = [`${sim.missiles.length} in flight`, 'warn'];
  let tTiles = tile('Target', 'none', '', 'wide');
  if (t) {
    const why = sim.engageable(t);
    tTiles = tile('Target', t.name, '') + tile('Bearing', relName(sim.relBearing(t.pos)), '', 'brg')
      + tile('Range', kmText(sim.rangeTo(t.pos)), '', sim.rangeTo(t.pos) < 1500 ? 'threat-high' : sim.rangeTo(t.pos) < 3000 ? 'threat' : '')
      + tile('Height', f(t.pos.y), 'm')
      + tile('F', why ? why.replace(/: turn the ship$/, '') : 'in arc, ready', '', `wide ${why ? 'threat' : 'helm-ok'}`);
  }
  out.push(`<div class="hud-sec">${head('Missiles', ...wChip)}<div class="tiles">${tTiles}</div></div>`);

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
function keysHtml() {
  const k = (key, label, on = false) => `<span class="fk${on ? ' on' : ''}"><kbd>${key}</kbd>${label}</span>`;
  if (sim.out) return `${k('R', 'sail again', true)}${k('V', 'camera')}`;
  const t = sim.target;
  const ready = t && !sim.engageable(t) && !sim.shot && sim.cellsLeft > 0;
  return `${k('←', '')}${k('→', 'rudder')}${k('↑', '')}${k('↓', 'telegraph')}${k('F', 'fire', ready)}`
    + `${k('Tab', 'target', sim.detected.length > 1)}${k('1–6', 'views')}${k('V', 'next view')}`;
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
  hudButton.classList.toggle('active', on);
  hudButton.setAttribute('aria-pressed', String(on));
}
hudButton.addEventListener('click', () => setHud(!hudOn));
setHud(true);
let tagsOn = true;

// The view buttons: a strip at the top centre.
const strip = document.createElement('div');
strip.className = 'helm-views';
strip.innerHTML = VIEWS.map((v, i) => `<button type="button" data-view="${v}" title="${VIEW_NAMES[v]} (${i + 1})">${['Bridge', 'Behind', 'Above', 'Missile', 'Sight', 'Orbit'][i]}</button>`).join('');
document.body.appendChild(strip);
const viewButtons = [...strip.querySelectorAll('button')];
viewButtons.forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));

keysSheet.querySelector('dl').innerHTML = [
  ['<kbd>←</kbd> <kbd>→</kbd>', 'Rudder to port / starboard while held; let go and it comes back amidships'],
  ['<kbd>↑</kbd> <kbd>↓</kbd>', 'Engine telegraph, one step: slow astern, stop, dead slow, slow, half, full, flank'],
  ['<kbd>F</kbd>', `Fire a missile at the target (${CELLS} cells; ${kmText(MISSILE_RANGE)} at most; ahead and abeam only)`],
  ['<kbd>Tab</kbd>', 'Next target'],
  ['<kbd>1</kbd> to <kbd>6</kbd>', 'Bridge, behind, above, missile, fire-control sight, orbit'],
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
    case '1': case '2': case '3': case '4': case '5': case '6': setView(VIEWS[Number(key) - 1]); break;
    case 'h': setHud(!hudOn); break;
    case 'm': setMap(!map.enabled); break;
    case 'i':
      cineOn = !cineOn;
      if (!cineOn) endCine();
      try { localStorage.setItem('intercept.helmcine', cineOn ? '1' : '0'); } catch { /* storage unavailable */ }
      say(cineOn ? 'Intercept camera on: the launch in slow motion, then the shot followed to the splash' : 'Intercept camera off', '', 2400);
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
  }
  const keys = keysHtml();
  if (keys !== lastKeys) { keysEl.innerHTML = keys; lastKeys = keys; }
  if (!banner.hidden && performance.now() > bannerUntil) banner.hidden = true;
  renderer.render(scene, camera);
  labels.render(scene, camera);
  if (frames++ === 0) loadingEl?.remove();
});

setView('behind', true);
say('Half ahead on 000. ← → rudder, ↑ ↓ telegraph: watch the radar for drones', '', 5200);
window.__helm = { sim, camera, controls, rig, renderer, scene, env, fx, ship: ship.group, setView, restart, get view() { return view; }, get cine() { return cine; } };

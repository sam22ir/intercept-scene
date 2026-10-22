import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { createEnvironment } from './environment.js';
import { createShip } from './models/ship.js';
import { createMerchant } from './models/merchant.js';
import { createBridge } from './models/bridge.js';
import { createGatling } from './models/gatling.js';
import { createLiveFx } from './fx/liveFx.js';
import { ShipPlume } from './fx/shipFx.js';
import { wireWeather } from './weatherButton.js';
import { createWake } from './fx/wake.js';
import { pointScale } from './fx/particles.js';
import { CameraRig } from './cameraRig.js';
import { menuText } from './menu.js';
import { compass, kmText, RUDDER_MAX } from './hull.js';
import { TELEGRAPH, COMPARTMENTS, COMP_IDS, LEVELS, DUEL_LEVELS, GUN_MOUNT_LOCAL, sinkState, HULL_HP } from './duel.js';
import { FleetSim, DT } from './fleet.js';
import { applyOrder, leadOf } from './fleetOrders.js';
import { transferCrew, stocksOf, CREW_RANGE } from './fleetResources.js';
import { SCENARIOS, LEVEL_RULES } from './fleetScoring.js';
import { createFleetMap, ROLE_COLOUR } from './fleetMap.js';
import {
  FORM_LABEL, TURN_STEP, ROLE_NAME, courseOrder, speedOrder, formOrder, sectorOrders, stanceOrder, gotoOrders, courseToOrder, crewTarget,
  rewindTarget, describeOrder, issue, logCrew, withCrewHook, AlertFeed, hullFrac, headingDeg, pad3, shipName, contactLabel, targets,
} from './fleetControls.js';
import './fleet.css';

// Entry point of "Fleet command", mission id `fleet` (the model is fleet.js, over the ship duel's physics): you command a squadron of
// three or four frigates that steer and fight themselves. The orders are the only input: a course, a speed, a formation, a sector
// patrol, hold fire, a destination, a repair crew sent from one ship to another. The tactical radar (fleetMap.js) is the main view; the
// 3D scene shows the same sea from above the squadron, behind a ship, or from her bridge. Real time, but the simulation can be paused to
// plan (orders issued then are stamped with the paused time) and rewound to the moment of an earlier order (Z), because it is a pure
// function of the seed and the order log. start.js imports this file when the mission is picked, with the enemy's level in
// globalThis.__DUEL_LEVEL and the scenario in globalThis.__FLEET_SCENARIO (or ?level= and ?scenario=).

const canvas = document.querySelector('#scene');
const loadingEl = document.querySelector('#loading');
document.body.classList.add('mission-fly', 'mission-fleet'); // the manual flight's interface, and this one's own
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.75;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, 1, 0.3, 40000);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.maxDistance = 4000;
controls.maxPolarAngle = Math.PI * 0.495;
controls.enabled = false;
const rig = new CameraRig(camera, controls);

const env = createEnvironment(renderer, scene, { look: 'duel' });
env.setShadowSize(1024);
env.ocean.material.uniforms.uShipX.value = 1e7; // the shader's straight-line wake: these ships turn, each has her own
const fx = createLiveFx(scene);
wireWeather({ look: env.look });

const HELM_EYE = new THREE.Vector3(11.7, 11.0, 0); // inside the wheelhouse (models/bridge.js)
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _vel = new THREE.Vector3();
const rad = THREE.MathUtils.degToRad;
const clamp = THREE.MathUtils.clamp;

// --- The simulation -----------------------------------------------------------------------------------------------------------
let level = 'normal';
let scenario = 'defend';
let squadSize = 4;
try {
  const q = new URLSearchParams(location.search);
  level = globalThis.__DUEL_LEVEL ?? q.get('level') ?? 'normal';
  scenario = globalThis.__FLEET_SCENARIO ?? q.get('scenario') ?? 'defend';
  squadSize = Number(q.get('n')) || 4;
} catch { /* no address */ }
if (!DUEL_LEVELS.includes(level)) level = 'normal';
if (!SCENARIOS[scenario]) scenario = 'defend';
const crewResult = { last: null };
// A crew moved between ships goes in the order log too (type 'crew'), so a rewind carries it out again.
const sim = new FleetSim({ seed: (Date.now() % 100000) | 0, level, scenario, n: squadSize, hooks: { applyOrder: withCrewHook(applyOrder, transferCrew, crewResult) } });
const feed = new AlertFeed();
let paused = false;
let lastOrderText = '';

// --- The ships ----------------------------------------------------------------------------------------------------------------
// A picture for each ship the simulation has: the squadron, then whoever arrives (raiders, merchants, drones). Pictures are pooled by
// kind, so a ship that is gone, or a run started again, gives hers back. Frigates have no deck crew (it stands in the gun's way).
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
const DRONE_ALT = 24; // m, the height a drone is drawn at (the simulation is flat)
function createDroneModel() {
  const group = new THREE.Group();
  const m = new THREE.MeshStandardMaterial({ color: 0xff7a1a, roughness: 0.6, metalness: 0.15 });
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, 5.4, 10), m);
  body.rotation.z = Math.PI / 2;
  const wing = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.1, 7.5), m);
  const tail = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.08, 2.8), m);
  tail.position.x = -2.3;
  const fin = new THREE.Mesh(new THREE.BoxGeometry(1, 1.1, 0.08), m);
  fin.position.set(-2.4, 0.55, 0);
  const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, blending: THREE.AdditiveBlending, depthWrite: false }));
  glow.scale.setScalar(9);
  glow.position.x = -3;
  group.add(body, wing, tail, fin, glow);
  group.scale.setScalar(1.8);
  return { group };
}
const kindOfShip = (s) => (s.merchant ? 'merchant' : s.kind === 'drone' ? 'drone' : s.team === 0 ? 'ours' : 'enemy');
const shipPool = {};
function makeVisual(s) {
  const key = kindOfShip(s);
  let v = shipPool[key]?.pop();
  if (!v) {
    const m = key === 'drone' ? createDroneModel() : key === 'merchant' ? createMerchant() : createShip({ ensign: key === 'ours' ? 'alg' : 'rus', crew: false });
    m.group.rotation.order = 'YXZ'; // heading, then heel, then trim
    scene.add(m.group);
    const frigate = key === 'ours' || key === 'enemy';
    const gats = frigate ? GUN_MOUNT_LOCAL.map(([x, y, z]) => {
      const g = createGatling();
      g.group.position.set(x, y - 1.3, z);
      m.group.add(g.group);
      return g;
    }) : [];
    let flashSprite = null;
    if (frigate) {
      flashSprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, blending: THREE.AdditiveBlending, depthWrite: false }));
      flashSprite.scale.setScalar(11);
      flashSprite.visible = false;
      scene.add(flashSprite);
    }
    v = { ...m, key, frigate, gats, wake: key === 'drone' ? null : createWake(scene), plume: frigate ? new ShipPlume(fx) : null, flashSprite };
  }
  v.smokeT = 0; v.flash = 0; v.gunClock = [0, 0]; v.sunk = false;
  if (v.plume) v.plume.last = null;
  v.group.visible = true;
  return v;
}
function releaseVisual(v) {
  v.group.visible = false;
  if (v.flashSprite) v.flashSprite.visible = false;
  v.wake?.hide();
  (shipPool[v.key] ??= []).push(v);
}
const ships = [];
function syncShips() {
  while (ships.length < sim.ships.length) ships.push(makeVisual(sim.ships[ships.length]));
  while (ships.length > sim.ships.length) releaseVisual(ships.pop());
}

// --- Shells and tracers (as the ship duel draws them) ---------------------------------------------------------------------------
function streaks(n, size, color, len) {
  const lineGeo = new THREE.BufferGeometry();
  lineGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 6), 3));
  const lines = new THREE.LineSegments(lineGeo, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }));
  const headGeo = new THREE.BufferGeometry();
  headGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  const heads = new THREE.Points(headGeo, new THREE.PointsMaterial({ map: glowTex, size, sizeAttenuation: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, color: 0xffffff }));
  lines.frustumCulled = false;
  heads.frustumCulled = false;
  scene.add(lines, heads);
  return {
    n,
    set(k, p, v) {
      if (!p) { lineGeo.attributes.position.setXYZ(k * 2, 0, -9999, 0); lineGeo.attributes.position.setXYZ(k * 2 + 1, 0, -9999, 0); headGeo.attributes.position.setXYZ(k, 0, -9999, 0); return; }
      _b.set(v[0], v[1], v[2]).normalize().multiplyScalar(-len);
      lineGeo.attributes.position.setXYZ(k * 2, p[0], p[1], p[2]);
      lineGeo.attributes.position.setXYZ(k * 2 + 1, p[0] + _b.x, p[1] + _b.y, p[2] + _b.z);
      headGeo.attributes.position.setXYZ(k, p[0], p[1], p[2]);
    },
    done() { lineGeo.attributes.position.needsUpdate = true; headGeo.attributes.position.needsUpdate = true; },
  };
}
const shellVis = streaks(160, 3.2, 0xffd9a0, 22);
const tracerVis = streaks(600, 1.1, 0xff6a1f, 34);
const tracers = Array.from({ length: 600 }, () => ({ on: false, p: new THREE.Vector3(), v: new THREE.Vector3(), t0: 0 }));
let tracerNext = 0;
syncShips();
const bridge = createBridge(); // the wheelhouse's inside, shown only in the bridge view
bridge.group.visible = false;
let bridgeOwner = -1;

// --- The sea picture: each ship's pose from the simulation ----------------------------------------------------------------------
const ZONE_X = { gun: 32, bridge: 11, engine: -13.5, guns: -33.6, steering: -52 };
function poseShip(i, dt) {
  const s = sim.ships[i];
  const v = ships[i];
  if (v.key === 'drone') {
    v.group.visible = s.tSunk === null;
    v.group.position.set(s.x, DRONE_ALT, s.z);
    v.group.rotation.set(0, -s.psi, 0);
    return;
  }
  const sink = s.tSunk !== null ? sinkState(sim.t - s.tSunk, s.listSide) : null;
  const list = s.listSide * rad(9) * (1 - clamp(s.hp / (v.key === 'merchant' ? 70 : HULL_HP), 0, 1)) ** 2;
  v.group.visible = !sink?.gone;
  v.group.position.set(s.x, sink ? sink.depth : 0, s.z);
  v.group.rotation.set(s.heel + list + (sink?.roll ?? 0), -s.psi, sink?.trim ?? 0);
  v.group.updateMatrixWorld(true);
  if (v.frigate) {
    v.mainGun.pose(s.gun.yaw, s.gun.pitch);
    v.gats.forEach((g, k) => g.pose(s.gats[k].yaw, s.gats[k].pitch, s.gats[k].spin, s.gats[k].firing, sim.t));
    v.update(sim.t, Infinity, Infinity, { aim: { yaw: Math.PI, pitch: 0 }, cradleT: 0 }); // the radar turns; the launcher box stays stowed
  }
  v.wake.update({ t: sim.t, x: s.x, z: s.z, psi: s.psi, r: s.r, u: s.u });
  if (v.plume && !sink?.gone && s.tSunk === null) {
    _vel.x = Math.cos(s.psi) * s.u;
    _vel.z = Math.sin(s.psi) * s.u;
    v.plume.update(sim.t, v.group, _vel, env.look?.sea.state ?? 1);
  }
  if (!v.frigate) return;
  // Smoke and fire: a hurt compartment smokes, one that is out burns; a sinking ship pours it out.
  v.smokeT += dt;
  while (v.smokeT >= 0.14) {
    v.smokeT -= 0.14;
    for (const id of COMP_IDS) {
      const frac = s.comp[id] / COMPARTMENTS[id].hp;
      if (frac > 0.55 || (sink && sink.gone)) continue;
      _a.set(ZONE_X[id] + (Math.random() - 0.5) * 6, 8, (Math.random() - 0.5) * 5);
      fx.fireSmoke(v.group.localToWorld(_a), sim.t, frac <= 0 ? 1.4 : 0.8);
    }
    for (const id of COMP_IDS) {
      if (s.fire[id] < 0.05 || (sink && sink.gone)) continue;
      _a.set(ZONE_X[id] + (Math.random() - 0.5) * 6, 8, (Math.random() - 0.5) * 5);
      fx.fireSmoke(v.group.localToWorld(_a), sim.t, 0.7 + 1.6 * s.fire[id]);
    }
    if (sink && sink.smoke > 0.2) {
      _a.set((Math.random() - 0.5) * 60, 9, (Math.random() - 0.5) * 6);
      fx.fireSmoke(v.group.localToWorld(_a), sim.t, 2 * sink.smoke);
    }
  }
  if (v.flash > 0) { v.flash -= dt; v.flashSprite.visible = v.flash > 0; }
}

function updateWeapons(dt) {
  for (let k = 0; k < shellVis.n; k++) { const sh = sim.shells[k]; shellVis.set(k, sh?.p, sh?.v); }
  shellVis.done();
  ships.forEach((v, i) => {
    const s = sim.ships[i];
    if (!v.frigate) return;
    s.gats.forEach((g, k) => {
      if (!g.firing) return;
      v.gunClock[k] += dt;
      v.gats[k].muzzle.getWorldQuaternion(_q);
      _a.set(1, 0, 0).applyQuaternion(_q);
      while (v.gunClock[k] >= 0.036) {
        v.gunClock[k] -= 0.036;
        const tr = tracers[tracerNext++ % tracers.length];
        v.gats[k].muzzle.getWorldPosition(tr.p);
        const sv = sim.velOf(s);
        tr.v.copy(_a).multiplyScalar(1050).add(_b.set(sv[0], 0, sv[2]));
        tr.v.x += (Math.random() - 0.5) * 9; tr.v.y += (Math.random() - 0.5) * 9; tr.v.z += (Math.random() - 0.5) * 9;
        tr.t0 = sim.t - Math.random() * 0.012;
        tr.on = true;
      }
    });
  });
  const pt = [0, 0, 0], vel = [0, 0, 0];
  for (let k = 0; k < tracers.length; k++) {
    const tr = tracers[k];
    let live = false;
    if (tr.on) {
      const age = sim.t - tr.t0;
      if (age > 2.2 || age < 0 || tr.p.y + tr.v.y * age < -1) tr.on = false;
      else {
        pt[0] = tr.p.x + tr.v.x * age; pt[1] = tr.p.y + tr.v.y * age; pt[2] = tr.p.z + tr.v.z * age;
        vel[0] = tr.v.x; vel[1] = tr.v.y; vel[2] = tr.v.z;
        tracerVis.set(k, age > 0.022 ? pt : [0, -9999, 0], vel);
        live = true;
      }
    }
    if (!live) tracerVis.set(k, null);
  }
  tracerVis.done();
}

// --- The banner, the alert list and the events ------------------------------------------------------------------------------------
const banner = document.querySelector('#shot-caption');
banner.classList.add('call');
let bannerUntil = 0;
function say(text, tone = '', ms = 3200) {
  banner.textContent = text;
  banner.hidden = false;
  banner.classList.remove('standby', 'execute', 'station', 'danger');
  const cls = { ok: 'execute', warn: 'standby', bad: 'danger' }[tone];
  if (cls) banner.classList.add(cls);
  bannerUntil = ms >= 60000 ? Infinity : performance.now() + ms;
}
const alarmEl = document.createElement('div');
alarmEl.className = 'fleet-alarm';
alarmEl.setAttribute('aria-hidden', 'true');
document.body.appendChild(alarmEl);
const flashAlarm = () => { alarmEl.classList.remove('hit'); void alarmEl.offsetWidth; alarmEl.classList.add('hit'); };
const ours = (i) => i >= 0 && i < sim.n;
const compName = (id) => COMPARTMENTS[id].name;
const bearingFromSquad = (x, z) => { const c = sim.centroid(); return pad3(compass(Math.atan2(z - c.z, x - c.x))); };
function handleEvents() {
  for (const e of sim.takeEvents()) {
    if (e.type === 'shot') {
      const v = ships[e.owner];
      if (!v?.frigate) continue;
      v.mainGun.muzzle.getWorldPosition(_c);
      v.flashSprite.position.copy(_c);
      v.flashSprite.visible = true;
      v.flash = 0.09;
      for (let k = 0; k < 7; k++) fx.gunSmoke(_c, _b.set(e.dir[0] * 9, e.dir[1] * 9, e.dir[2] * 9), sim.t);
    } else if (e.type === 'hit') {
      fx.shellBurst(_c.set(...e.pos), sim.t);
      if (ours(e.ship)) { flashAlarm(); say(`${shipName(sim.ships[e.ship])} hit: ${compName(e.comp)}${e.out ? ' out' : ''}`, 'bad', 2400); }
      else if (e.neutral && ours(e.owner)) say('A merchant ship was hit by our guns: hold fire, sinking one loses', 'bad', 3600);
    } else if (e.type === 'arrive') {
      const s = sim.ships[e.ship];
      const brg = s ? bearingFromSquad(s.x, s.z) : '---';
      if (e.kind === 'enemy') say(`Raider reported, bearing ${brg}, ${kmText(e.range)}`, 'warn', 4200);
      else if (e.kind === 'drone') say(`Drone launched, bearing ${brg}`, 'bad', 4200);
      else say(`Merchant ship, bearing ${brg}: do not fire on her`, '', 4200);
    } else if (e.type === 'collision') {
      for (let k = 0; k < 4; k++) fx.shellBurst(_c.set(e.pos[0] + (Math.random() - 0.5) * 10, e.pos[1] + Math.random() * 4, e.pos[2] + (Math.random() - 0.5) * 10), sim.t);
      if (ours(e.a) || ours(e.b)) { flashAlarm(); say(`Collision at ${e.impact.toFixed(0)} m/s`, 'bad', 2600); }
    } else if (e.type === 'gunhit') {
      if (ours(e.ship)) flashAlarm();
    } else if (e.type === 'splash') {
      fx.splashAt(_c.set(e.pos[0], 0, e.pos[2]), sim.t, 1.5);
    } else if (e.type === 'out') {
      if (ours(e.ship)) say(`${shipName(sim.ships[e.ship])}: ${compName(e.comp).toLowerCase()} is out`, 'bad', 3000);
    } else if (e.type === 'sunk') {
      if (e.kind !== 'drone') for (let k = 0; k < 3; k++) fx.explosion(_c.set(e.pos[0] + (k - 1) * 14, e.pos[1], e.pos[2]), sim.t + k * 0.35);
      if (ours(e.ship)) say(`${shipName(sim.ships[e.ship])} is sinking`, 'bad', 4000);
      else if (e.kind === 'drone') { fx.explosion(_c.set(e.pos[0], DRONE_ALT, e.pos[2]), sim.t); say('Drone shot down', 'ok', 2000); }
      else if (!sim.ships[e.ship]?.merchant) say('Raider sunk', 'ok', 2400);
    } else if (e.type === 'drone') {
      const d = sim.ships[e.ship];
      if (e.phase === 'hit' && d) {
        fx.explosion(_c.set(d.x, 12, d.z), sim.t);
        const t = sim.ships[e.target];
        if (t) { flashAlarm(); say(`Drone hit ${shipName(t)}: ${compName(e.comp)}`, 'bad', 3000); }
      }
    } else if (e.type === 'repair') {
      if (ours(e.ship)) say(e.phase === 'start' ? `${shipName(sim.ships[e.ship])}: repairing` : `${shipName(sim.ships[e.ship])}: repair done`, e.phase === 'start' ? 'warn' : 'ok', 2200);
    } else if (e.type === 'fire') {
      if (ours(e.ship)) say(`${shipName(sim.ships[e.ship])}: fire in the ${compName(e.comp).toLowerCase()}`, 'warn', 2400);
    } else if (e.type === 'over') {
      say(e.winner === 0 ? 'Mission accomplished' : 'Mission failed', e.winner === 0 ? 'ok' : 'bad', 60000);
    }
  }
}

// --- Selection and views ------------------------------------------------------------------------------------------------------------
const input = { sel: 'all', view: 'map', paused: false, press: null, rewind: null, restart: null, pick: null, setView: null }; // filled in below
const VIEWS = ['map', 'chase', 'bridge'];
const VIEW_LABELS = { map: 'Map', chase: 'Chase', bridge: 'Bridge' };
const VIEW_NAMES = { map: 'Tactical map: the radar is the view, the sea is seen from above', chase: 'Behind the picked frigate (drag to look round, wheel to zoom)', bridge: 'The picked frigate\'s wheelhouse (drag to look round)' };
let view = 'map';
let lookYaw = 0;
let lookPitch = -0.03;
function setFov(f) {
  if (Math.abs(camera.fov - f) < 0.01) return;
  camera.fov = f;
  camera.updateProjectionMatrix();
  pointScale.value = (window.innerHeight * renderer.getPixelRatio()) / (2 * Math.tan(rad(f / 2)));
}
const focusShip = () => {
  const s = input.sel === 'all' ? leadOf(sim) : sim.ships[input.sel];
  return s && s.tSunk === null ? s : leadOf(sim);
};
const viewButtons = [];
function setView(v) {
  view = v;
  input.view = v;
  const fs = focusShip();
  controls.enabled = v === 'chase';
  if (v === 'chase') {
    _a.set(-1, 0.2, 0).applyAxisAngle(_b.set(0, 1, 0), -fs.psi).multiplyScalar(230).add(_c.set(fs.x, 8, fs.z)); // behind her, a little above
    camera.position.copy(_a);
    controls.target.set(fs.x, 8, fs.z);
    rig.focus('ship', (out) => { const s = focusShip(); return out.set(s.x, 8, s.z); }, 230, 25);
  } else rig.free();
  camera.up.set(v === 'map' ? 1 : 0, v === 'map' ? 0 : 1, 0);
  viewButtons.forEach((b) => { const on = b.dataset.view === v; b.classList.toggle('active', on); b.setAttribute('aria-pressed', String(on)); });
  map.setBig(v === 'map');
  document.body.classList.toggle('fleet-mapview', v === 'map');
}
let frameDt = 1 / 60;
function updateCamera() {
  const fs = focusShip();
  bridge.group.visible = view === 'bridge';
  if (view === 'bridge') {
    if (bridgeOwner !== fs.idx && ships[fs.idx]) { ships[fs.idx].group.add(bridge.group); bridgeOwner = fs.idx; }
    const me = ships[fs.idx].group;
    bridge.update(clamp(fs.rudder / RUDDER_MAX, -1, 1), fs.order / (TELEGRAPH.length - 1));
    me.localToWorld(camera.position.copy(HELM_EYE));
    const yaw = rad(lookYaw);
    _a.set(Math.cos(yaw) * Math.cos(lookPitch), Math.sin(lookPitch), Math.sin(yaw) * Math.cos(lookPitch)).transformDirection(me.matrixWorld);
    camera.lookAt(_b.copy(camera.position).add(_a));
    setFov(55);
  } else if (view === 'chase') {
    setFov(50);
    rig.update();
    controls.update();
  } else { // map: straight above the squadron, north up
    setFov(50);
    const c = sim.centroid();
    let spread = 0;
    for (const s of sim.squad) if (s.tSunk === null) spread = Math.max(spread, Math.hypot(s.x - c.x, s.z - c.z));
    camera.up.set(1, 0, 0);
    camera.position.set(c.x, clamp(spread * 2 + 900, 1000, 6000), c.z);
    camera.lookAt(c.x, 0, c.z);
  }
}

// --- The interface: panels -------------------------------------------------------------------------------------------------------------
document.querySelector('#hud').hidden = true; // the shared readout panel is not used: the fleet has its own below
const ui = document.createElement('div');
ui.id = 'fleet-ui';
ui.className = 'fleet-ui';
ui.innerHTML = '<div class="fleet-ships" id="fleet-ships"></div><div class="fleet-side"><section class="fleet-mission" id="fleet-mission"></section>'
  + '<section class="fleet-contacts" id="fleet-contacts"></section><section class="fleet-alerts" id="fleet-alerts"></section></div>';
document.body.appendChild(ui);
const shipsEl = ui.querySelector('#fleet-ships');
const missionEl = ui.querySelector('#fleet-mission');
const contactsEl = ui.querySelector('#fleet-contacts');
const alertsEl = ui.querySelector('#fleet-alerts');
const pauseEl = document.createElement('div');
pauseEl.className = 'fleet-pause';
pauseEl.hidden = true;
document.body.appendChild(pauseEl);
const endEl = document.createElement('div');
endEl.className = 'fleet-end';
endEl.hidden = true;
document.body.appendChild(endEl);
const keysEl = document.createElement('div');
keysEl.id = 'fly-keys';
keysEl.className = 'fly-keys fleet-keys';
document.body.appendChild(keysEl);

const mmss = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
const bar = (frac, cls = '') => `<s class="${cls}" style="width:${Math.round(clamp(frac, 0, 1) * 100)}%"></s>`;
const COMP_ABBR = { gun: '76', bridge: 'BRG', engine: 'ENG', guns: '30', steering: 'STR' };
const healthClass = (f) => (f <= 0 ? 'out' : f < 0.5 ? 'bad' : f < 0.99 ? 'hurt' : '');

function orderText(s) {
  if (s.tSunk !== null) return 'SUNK';
  const parts = [];
  if (s.stance === 'hold') parts.push('HOLD FIRE');
  if (s.form) parts.push(FORM_LABEL[s.form] ?? s.form);
  else if (s.sector) parts.push(`Patrol ${pad3(s.sector.from)}–${pad3(s.sector.to)}`);
  else if (s.goal.to) parts.push('Going to a point');
  else parts.push(`${pad3(s.goal.course)}° at ${s.goal.kn} kn`);
  return parts.join(' · ');
}
function cardHtml(s) {
  const f = hullFrac(s);
  const st = stocksOf(s);
  const colour = ROLE_COLOUR[s.role];
  const comps = COMP_IDS.map((id) => {
    const cf = s.comp[id] / COMPARTMENTS[id].hp;
    const crew = s.crews.filter((c) => c.to === id).length;
    return `<i class="cp ${healthClass(cf)}" title="${compName(id)} ${Math.round(cf * 100)} %"><s style="height:${Math.round(clamp(cf, 0, 1) * 100)}%"></s><b>${COMP_ABBR[id]}</b>`
      + `<em>${s.fire[id] > 0 ? '<u class="fire">▲</u>' : ''}${s.leak[id] > 0.005 ? '<u class="leak">≈</u>' : ''}${crew ? '<u class="crew">⛑</u>' : ''}</em></i>`;
  }).join('');
  const sel = input.sel === 'all' || input.sel === s.idx;
  const station = s.form ? sim.stationOf(s) : null;
  const off = station ? Math.round(Math.hypot(station.x - s.x, station.z - s.z)) : null;
  const inbound = s.inbound?.length ?? 0;
  return `<button type="button" class="fs-card${sel ? ' sel' : ''}${input.sel === s.idx ? ' only' : ''}${s.tSunk !== null ? ' sunk' : ''}" data-idx="${s.idx}" style="--role:${colour}">`
    + `<span class="fs-head"><b>${s.idx + 1}</b><span>${ROLE_NAME[s.role]}</span><em>${s.tSunk !== null ? 'SINKING' : `${pad3(headingDeg(s))}° · ${sim.knots(s).toFixed(0)} kn`}</em></span>`
    + `<span class="fs-hull"><span class="fs-bar ${f < 0.35 ? 'bad' : f < 0.7 ? 'hurt' : ''}">${bar(f)}</span><em>${Math.round(f * 100)}%</em></span>`
    + `<span class="fs-comps">${comps}</span>`
    + `<span class="fs-line"><span title="76 mm rounds, HE and AP">HE <b>${st.he}</b> AP <b>${st.ap}</b></span><span title="Repair crews aboard${inbound ? ' (+' + inbound + ' on the way)' : ''}">⛑ <b>${st.crews}</b>${inbound ? `<small>+${inbound}</small>` : ''}</span><span class="fs-fuel${st.fuel < 0.2 ? ' bad' : ''}" title="Fuel">⛽ <span class="fs-bar">${bar(st.fuel, st.fuel < 0.2 ? 'bad' : '')}</span></span></span>`
    + `<span class="fs-order${s.stance === 'hold' ? ' hold' : ''}">${orderText(s)}${off !== null && s.tSunk === null ? `<small>${off < 90 ? 'on station' : `${off} m off`}</small>` : ''}</span>`
    + '</button>';
}
let lastShips = '';
function updateShips() {
  const html = sim.squad.map(cardHtml).join('');
  if (html !== lastShips) { shipsEl.innerHTML = html; lastShips = html; }
}
shipsEl.addEventListener('click', (e) => {
  const c = e.target.closest('[data-idx]');
  if (c) pick(Number(c.dataset.idx));
});

let debriefNow = null;
let lastMission = '';
function updateMission() {
  const sc = SCENARIOS[sim.scenario];
  const d = sim.debrief();
  debriefNow = d;
  const lead = leadOf(sim);
  let lines = '';
  if (sim.scenario === 'escort') {
    const merch = sim.ships.filter((s) => s.merchant);
    const total = merch.length + sim.pending.filter((w) => w.kind === 'merchant').length;
    lines = `<div><span>Through the gate</span><b>${d.merchantsCrossed} / ${total}</b></div><div><span>Afloat</span><b>${merch.filter((s) => s.tSunk === null).length}</b></div><div><span>Lost</span><b class="${d.merchantsLost ? 'bad' : ''}">${d.merchantsLost}</b></div>`;
  } else {
    const z = sc.zone;
    const inside = Math.hypot(lead.x - z.x, lead.z - z.z) <= z.r;
    const out = sim._score?.outSince;
    const limit = (LEVEL_RULES[sim.level] ?? LEVEL_RULES.normal).outLimit;
    lines = `<div><span>Lead ship ${lead.idx + 1}</span><b class="${inside ? 'ok' : 'bad'}">${inside ? 'in the zone' : out != null ? `OUT ${Math.max(0, Math.round(limit - (sim.t - out)))} s` : 'OUT'}</b></div>`;
  }
  const html = `<h3>${sc.name.toUpperCase()}<small>${LEVELS[sim.level].name}</small></h3>`
    + `<div class="fm-clock"><b>${mmss(sim.t)}</b><span>of ${mmss(sc.duration)}</span>${bar(sim.t / sc.duration, 'fm-prog')}</div>`
    + `<p>${sc.text}</p>${lastOrderText ? `<p class="fm-last"><b>Last order</b> ${lastOrderText}</p>` : ''}<div class="fm-kv">${lines}<div><span>Raiders sunk</span><b>${d.enemiesSunk}</b></div><div><span>Ships lost</span><b class="${d.losses.length ? 'bad' : ''}">${d.losses.length}</b></div><div><span>Score</span><b>${d.score}</b></div></div>`;
  if (html !== lastMission) { missionEl.innerHTML = html; lastMission = html; }
}

let contactsNow = [];
let lastContacts = '';
function updateContacts() {
  const rows = contactsNow.slice().sort((a, b) => (a.range ?? 1e9) - (b.range ?? 1e9)).slice(0, 9).map((c) => {
    const lab = contactLabel(sim, c);
    const kn = c.u ? Math.round(c.u / 0.5144) : null;
    const where = c.state === 'lost' ? `lost · last seen ${Math.round(20 * (1 - c.conf))} s ago` : `${kmText(c.range)} · ${pad3(c.bearing)}°${kn !== null ? ` · ${kn} kn` : ''}`;
    return `<li class="${c.team === 1 ? 'hostile' : 'neutral'} ${c.state}"><b>${lab.code}</b><span>${c.state === 'detected' ? 'Unidentified' : lab.name}</span><em>${where}</em></li>`;
  }).join('');
  const html = `<h3>CONTACTS<small>${contactsNow.length}</small></h3>${rows ? `<ul>${rows}</ul>` : '<p class="fc-none">Nothing on the radar</p>'}`;
  if (html !== lastContacts) { contactsEl.innerHTML = html; lastContacts = html; }
}

const alertLog = []; // { text, severity, t, real }
let lastAlerts = '';
function takeAlerts() {
  for (const a of feed.take(sim)) {
    alertLog.unshift({ text: a.text, severity: a.severity, t: a.t, real: performance.now() });
    if (alertLog.length > 12) alertLog.pop();
    if (a.severity === 'danger') say(a.text, 'bad', 3000);
    else if (a.severity === 'warn') say(a.text, 'warn', 2400);
  }
}
function updateAlerts() {
  const now = performance.now();
  const rows = alertLog.filter((a) => now - a.real < 60000).slice(0, 6).map((a) => `<li class="${a.severity}${now - a.real > 20000 ? ' old' : ''}"><time>${mmss(a.t)}</time>${a.text}</li>`).join('');
  const html = `<h3>ALERTS</h3>${rows ? `<ul>${rows}</ul>` : '<p class="fc-none">All quiet</p>'}`;
  if (html !== lastAlerts) { alertsEl.innerHTML = html; lastAlerts = html; }
}

let endShown = false;
function updateEnd() {
  const over = sim.winner !== null;
  if (!over) { if (endShown) { endEl.hidden = true; endShown = false; } return; }
  if (endShown) return;
  endShown = true;
  const d = sim.debrief();
  const won = d.status === 'won';
  const acc = d.shots ? Math.round((d.hits / d.shots) * 100) : 0;
  const lost = d.losses.length ? d.losses.map((i) => i + 1).join(', ') : 'none';
  endEl.innerHTML = `<div class="fe-card ${won ? 'won' : 'lost'}"><h2>${won ? 'Mission accomplished' : 'Mission failed'}</h2><p class="fe-verdict">${d.verdict}</p>`
    + `<dl><dt>Time</dt><dd>${mmss(d.time)}</dd><dt>Score</dt><dd>${d.score}</dd><dt>Raiders sunk</dt><dd>${d.enemiesSunk}</dd>`
    + `<dt>Ships lost</dt><dd>${lost}</dd><dt>Gunnery</dt><dd>${d.hits} hits of ${d.shots} (${acc}%)</dd>`
    + `${sim.scenario === 'escort' ? `<dt>Merchants</dt><dd>${d.merchantsCrossed} through the gate · ${d.merchantsSaved} afloat · ${d.merchantsLost} lost</dd>` : ''}`
    + `<dt>Orders given</dt><dd>${sim.log.length}</dd></dl>`
    + '<div class="fe-actions"><button type="button" data-key="r" class="primary">Fight again <kbd>R</kbd></button><button type="button" data-key="z">Rewind <kbd>Z</kbd></button><button type="button" data-act="menu">Main menu</button></div></div>';
  endEl.hidden = false;
}
endEl.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.key) act(b.dataset.key);
  else if (b.dataset.act === 'menu') document.querySelector('#btn-ship').click();
});

// --- The keys bar (also the touch controls) ---------------------------------------------------------------------------------
const kb = (key, face, label, on = false, title = '') => `<button type="button" class="fk${on ? ' on' : ''}" data-key="${key}"${title ? ` title="${title}"` : ''}><kbd>${face}</kbd><span>${label}</span></button>`;
let lastKeys = '';
function keysHtml() {
  const t = targets(sim, input.sel);
  const holding = t.length > 0 && t.every((s) => s.stance === 'hold');
  const first = t[0];
  const patrolling = sim.squad.some((s) => s.tSunk === null && s.sector);
  const formNow = first && first.form ? FORM_LABEL[first.form] : 'form';
  return `<span class="fk-sel"><kbd>0–4</kbd>${input.sel === 'all' ? 'all ships' : `ship ${input.sel + 1}`}</span>`
    + kb('ArrowLeft', '←', 'course') + kb('ArrowRight', '→', '') + kb('ArrowDown', '↓', 'speed') + kb('ArrowUp', '↑', '')
    + kb('f', 'F', formNow, !!(first && first.form)) + kb('p', 'P', 'patrol', patrolling) + kb('e', 'E', holding ? 'HOLD FIRE' : 'fire free', holding)
    + kb('x', 'X', 'crew') + kb(' ', 'Space', paused ? 'PAUSED: plan' : 'pause', paused) + kb('z', 'Z', 'undo') + kb('v', 'V', VIEW_LABELS[view].toLowerCase());
}
keysEl.addEventListener('click', (e) => { const b = e.target.closest('[data-key]'); if (b) act(b.dataset.key); });
keysEl.addEventListener('pointerdown', (e) => { if (e.target.closest('[data-key]')) e.preventDefault(); }); // a tap must not steal the focus

// --- Orders -------------------------------------------------------------------------------------------------------------------------
function give(orders) {
  const done = issue(sim, orders);
  if (!done.length) return false;
  lastOrderText = `${mmss(done[0].t)}  ${done.length > 1 ? `${describeOrder(done[0])} (+${done.length - 1} more)` : describeOrder(done[0])}${paused ? '  · stamped while paused' : ''}`;
  lastShips = '';
  return true;
}
function pick(sel) {
  if (sel !== 'all' && (!sim.squad[sel] || sim.squad[sel].tSunk !== null)) return;
  input.sel = sel;
  lastShips = '';
  if (view === 'chase') setView('chase'); // the camera follows the pick
}
function sendCrew() {
  const from = input.sel === 'all' ? sim.squad.filter((s) => s.tSunk === null).sort((a, b) => b.crews.length - a.crews.length)[0] : sim.squad[input.sel];
  if (!from || from.tSunk !== null) { say('Pick the frigate that sends the crew', 'warn', 2000); return; }
  const to = crewTarget(sim, from.idx, CREW_RANGE);
  if (!to) { say('No other frigate afloat', 'warn', 2000); return; }
  logCrew(sim, from.idx, to.idx);
  if (crewResult.last) {
    say(`A repair crew goes from ship ${from.idx + 1} to ship ${to.idx + 1}`, 'ok', 2600);
    lastOrderText = `${mmss(sim.t)}  Ship ${from.idx + 1}: crew to ship ${to.idx + 1}${paused ? '  · stamped while paused' : ''}`;
  } else {
    sim.log.pop(); // refused: it is not an order
    const d = Math.hypot(from.x - to.x, from.z - to.z);
    say(d > CREW_RANGE ? `Ship ${to.idx + 1} is ${kmText(d)} away: close to under ${kmText(CREW_RANGE)}` : `Ship ${from.idx + 1} has no crew to spare`, 'warn', 2800);
  }
}
let rewinding = false;
function clearScene() {
  fx.clear();
  for (const v of ships) v.wake?.clear();
  tracers.forEach((t) => { t.on = false; });
  alarmEl.classList.remove('hit');
  syncShips();
  for (const v of ships) { if (v.plume) v.plume.last = null; v.smokeT = 0; v.flash = 0; }
  endShown = false;
  endEl.hidden = true;
  lastShips = lastMission = lastContacts = lastAlerts = '';
}
function rewind() {
  if (rewinding) return;
  const t = rewindTarget(sim);
  if (t === null) { say('Nothing to rewind to yet', 'warn', 1800); return; }
  rewinding = true;
  say('Rewinding…', 'warn', 4000);
  setTimeout(() => { // let the banner paint first: the replay runs every step again
    sim.rewindTo(t);
    sim.takeEvents(); // the replay's shots and hits are history, not news
    clearScene();
    feed.sync(sim);
    alertLog.length = 0;
    paused = true;
    input.paused = true;
    rewinding = false;
    lastOrderText = `back at ${mmss(sim.t)} · paused: change the orders, Space to go on`;
    say(`Back at ${mmss(sim.t)}, with the order given then. Space to go on`, 'ok', 4500);
  }, 40);
}
function restart() {
  sim.seed = (Date.now() % 100000) | 0;
  sim.reset();
  sim.log = []; // reset() does not clear the order log, and a rewind would replay the old run's orders
  sim.takeEvents();
  clearScene();
  feed.reset();
  alertLog.length = 0;
  paused = false;
  input.paused = false;
  input.sel = 'all';
  lastOrderText = '';
  banner.hidden = true;
  startBanner();
}
function startBanner() {
  say(`${SCENARIOS[sim.scenario].name}: ${SCENARIOS[sim.scenario].text} Space pauses to plan.`, '', 6000);
}

// --- Keys ---------------------------------------------------------------------------------------------------------------------------
let lastTurn = 0;
function act(raw, repeat = false) {
  const key = raw.length === 1 ? raw.toLowerCase() : raw;
  const now = performance.now();
  switch (key) {
    case 'ArrowLeft': case 'ArrowRight':
      if (now - lastTurn < (repeat ? 250 : 120)) return true; // a held key repeats: a turn of ten degrees every quarter second is plenty, and every one is an order in the log
      lastTurn = now;
      give(courseOrder(sim, input.sel, key === 'ArrowLeft' ? -TURN_STEP : TURN_STEP));
      break;
    case 'ArrowUp': give(speedOrder(sim, input.sel, +1)); break;
    case 'ArrowDown': give(speedOrder(sim, input.sel, -1)); break;
    case '0': pick('all'); break;
    case '1': case '2': case '3': case '4': pick(Number(key) - 1); break;
    case 'f': give(formOrder(sim, input.sel)); break;
    case 'p': give(sectorOrders(sim, input.sel)); break;
    case 'e': give(stanceOrder(sim, input.sel)); break;
    case 'x': sendCrew(); break;
    case ' ': paused = !paused; input.paused = paused; say(paused ? 'Paused: give orders, they are stamped with this moment. Space to go on' : 'Going on', paused ? 'warn' : '', 2400); break;
    case 'z': rewind(); break;
    case 'v': setView(VIEWS[(VIEWS.indexOf(view) + 1) % VIEWS.length]); break;
    case 'r': restart(); break;
    case 'h': setHud(!hudOn); break;
    case 'n': setMap(!mapOn); break;
    case 'l': tagsOn = !tagsOn; break;
    case 'c': setFolded(!document.body.classList.contains('ui-hidden')); break;
    case '?': setKeys(keysSheet.hidden); break;
    case 'Escape': closePopovers(); break;
    default: return false;
  }
  return true;
}
window.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const tag = e.target?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;
  if (e.repeat && e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') { if (e.key === ' ' || e.key.startsWith('Arrow')) e.preventDefault(); return; } // only a held turn repeats
  if (act(e.key, e.repeat)) e.preventDefault();
});
window.addEventListener('blur', () => { lastTurn = 0; });

// --- The map -------------------------------------------------------------------------------------------------------------------------
const map = createFleetMap({
  onPick: (idx) => pick(idx),
  onGround: (x, z, shift) => { give(shift ? courseToOrder(sim, input.sel, x, z) : gotoOrders(sim, input.sel, x, z)); },
});
const mapButton = document.querySelector('#btn-map');
let mapOn = true;
function setMap(on) {
  mapOn = on;
  map.setEnabled(on);
  mapButton.classList.toggle('active', on);
  mapButton.setAttribute('aria-pressed', String(on));
  try { localStorage.setItem('intercept.map', on ? '1' : '0'); } catch { /* storage unavailable */ }
}
try { mapOn = localStorage.getItem('intercept.map') !== '0'; } catch { /* storage unavailable */ }
mapButton.addEventListener('click', () => setMap(!mapOn));

// --- Interface: the top bar, menu, keys sheet ----------------------------------------------------------------------------------------
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
  const t = menuText('fleet');
  document.querySelector('.brand b').textContent = t.brand;
  const sub = document.querySelector('#mission-sub');
  if (sub) sub.textContent = `${SCENARIOS[sim.scenario].name} · ${LEVELS[level].name} · ${sim.n} frigates`;
}
// The top bar's height, for the panels that hang under it (on the next frame: a layout change inside an observer reports a loop).
{
  const topbar = document.querySelector('#topbar');
  let raf = 0;
  const setBar = () => { raf = 0; document.documentElement.style.setProperty('--bar-h', `${topbar.offsetHeight}px`); };
  const queue = () => { if (!raf) raf = requestAnimationFrame(setBar); };
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(queue).observe(topbar);
  window.addEventListener('resize', queue);
  queue();
}

const hudButton = document.querySelector('#btn-hud');
let hudOn = true;
function setHud(on) {
  hudOn = on;
  ui.hidden = !on;
  hudButton.classList.toggle('active', on);
  hudButton.setAttribute('aria-pressed', String(on));
}
hudButton.addEventListener('click', () => setHud(!hudOn));
setHud(true);

const restartButton = document.createElement('button');
restartButton.id = 'btn-restart';
restartButton.setAttribute('role', 'menuitem');
restartButton.innerHTML = 'Start again<kbd>R</kbd>';
menuEl.insertBefore(restartButton, menuEl.firstChild);
restartButton.addEventListener('click', () => restart());

const strip = document.createElement('div');
strip.className = 'fleet-views';
strip.innerHTML = VIEWS.map((v) => `<button type="button" data-view="${v}" title="${VIEW_NAMES[v]} (V)">${VIEW_LABELS[v]}</button>`).join('');
document.body.appendChild(strip);
viewButtons.push(...strip.querySelectorAll('button'));
viewButtons.forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));

keysSheet.querySelector('dl').innerHTML = [
  ['<kbd>1</kbd> to <kbd>4</kbd> <kbd>0</kbd>', 'Pick a frigate (or click her on the radar or her card); 0 picks them all. The orders below go to the pick'],
  ['<kbd>←</kbd> <kbd>→</kbd>', `Turn the picked frigates' course ${TURN_STEP}° to port / starboard (all of them: the lead, while a formation or patrol is ordered, and the others follow)`],
  ['<kbd>↑</kbd> <kbd>↓</kbd>', 'Speed: stop, 5, 10, 16, 22, 28 kn'],
  ['<kbd>F</kbd>', 'Formation, laid off from the lead: column, line abreast, box, diamond (each press the next one)'],
  ['<kbd>P</kbd>', 'Sector patrol: each follower sweeps her own slice round the lead; again to end it'],
  ['<kbd>E</kbd>', 'Hold fire / engage (a held ship does not shoot, even at a raider)'],
  ['<kbd>X</kbd>', `Send a repair crew from the picked frigate to the next one (within ${kmText(CREW_RANGE)}, arrives in 20 s); the sender keeps one`],
  ['click', 'On the radar: a frigate picks her, the sea sends the pick there; shift-click only steers for it. Wheel zooms, drag pans, double click follows the squadron'],
  ['<kbd>Space</kbd>', 'Pause to plan: orders given while paused are stamped with that moment'],
  ['<kbd>Z</kbd>', 'Rewind to the moment of the last order, paused; pressed right after giving an order (or several while paused) it takes them back, and again goes to the one before. The run is replayed from the seed and the order log'],
  ['<kbd>V</kbd>', 'Camera: map, chase the picked frigate (drag, wheel), her bridge (drag looks round)'],
  ['<kbd>R</kbd>', 'Start again'],
  ['<kbd>N</kbd>', 'Radar on / off'],
  ['<kbd>L</kbd> <kbd>H</kbd> <kbd>C</kbd>', 'Tags, readouts, hide the interface'],
].map(([k, d]) => `<dt>${k}</dt><dd>${d}</dd>`).join('');
keysSheet.querySelector('.keys-note').textContent = 'The frigates steer and shoot by themselves: you only give orders · a pause lets you plan, Z takes the last order back';

const soundButton = document.querySelector('#btn-sound');
soundButton.disabled = true;
soundButton.title = 'This mission has no sound yet';

// --- Tags ------------------------------------------------------------------------------------------------------------------------------
const labels = new CSS2DRenderer();
labels.domElement.className = 'labels-layer fleet-labels';
document.body.appendChild(labels.domElement);
const tags = [];
function tagFor(i) {
  if (tags[i]) return tags[i];
  const el = document.createElement('div');
  el.className = 'tag tag-ship';
  el.style.pointerEvents = 'none';
  el.innerHTML = '<div class="tag-title"></div><div class="tag-body"></div>';
  const obj = new CSS2DObject(el);
  obj.center.set(0.5, 1);
  scene.add(obj);
  return (tags[i] = { el, obj, title: el.querySelector('.tag-title'), body: el.querySelector('.tag-body'), text: '' });
}
let tagsOn = true;
function updateTags() {
  const byIdx = new Map(contactsNow.map((c) => [c.idx, c]));
  for (let i = 0; i < Math.max(sim.ships.length, tags.length); i++) {
    const s = sim.ships[i];
    if (!s) { if (tags[i]) tags[i].obj.visible = false; continue; }
    const t = tagFor(i);
    const c = byIdx.get(i);
    const mine = i < sim.n;
    const seen = mine || (c && c.state === 'tracked');
    t.obj.visible = tagsOn && view !== 'map' && seen && !!ships[i]?.group.visible && s.tSunk === null;
    if (!t.obj.visible) continue;
    t.obj.position.set(s.x, s.kind === 'drone' ? DRONE_ALT + 14 : 40, s.z);
    let title, body, colour;
    if (mine) {
      title = `${input.sel === i ? '▶ ' : ''}${i + 1} ${ROLE_NAME[s.role]}`;
      body = `${Math.round(hullFrac(s) * 100)}% · ${orderText(s)}`;
      colour = ROLE_COLOUR[s.role];
    } else {
      const lab = contactLabel(sim, c);
      title = lab.name.toUpperCase();
      body = `${kmText(c.range)} · ${pad3(c.bearing)}°`;
      colour = lab.hostile ? '#ff5d61' : '#9aa4ad';
    }
    if (t.text !== title + body) { t.title.textContent = title; t.body.textContent = body; t.el.style.borderLeftColor = colour; t.text = title + body; }
  }
}

// --- Loop ------------------------------------------------------------------------------------------------------------------------------
function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h, false);
  labels.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  pointScale.value = (h * renderer.getPixelRatio()) / (2 * Math.tan(rad(camera.fov / 2)));
}
window.addEventListener('resize', resize);
resize();

// A drag on the picture looks round the bridge.
let lookDrag = null;
canvas.addEventListener('pointerdown', (e) => { if (e.button === 0 && view === 'bridge') lookDrag = { x: e.clientX, y: e.clientY }; });
window.addEventListener('pointerup', () => { lookDrag = null; });
window.addEventListener('pointermove', (e) => {
  if (!lookDrag || view !== 'bridge') return;
  const dx = e.clientX - lookDrag.x, dy = e.clientY - lookDrag.y;
  lookDrag = { x: e.clientX, y: e.clientY };
  lookYaw = ((lookYaw + dx * 0.25 + 540) % 360) - 180;
  lookPitch = clamp(lookPitch - dy * 0.004, -0.9, 0.6);
});
canvas.addEventListener('dblclick', () => { lookYaw = 0; lookPitch = -0.03; });

setMap(mapOn);
setView('map');
startBanner();
input.press = act;
input.rewind = rewind;
input.restart = restart;
input.pick = pick;
input.setView = setView;

let last = performance.now();
let frames = 0;
let uiClock = 0;
renderer.setAnimationLoop((now) => {
  const dt = Math.max(0, Math.min((now - last) / 1000, 0.1));
  last = now;
  frameDt = dt;
  syncShips();
  if (!paused && !rewinding) sim.advance(dt);
  handleEvents();
  syncShips();
  if (input.sel !== 'all' && sim.squad[input.sel]?.tSunk !== null) pick('all');
  env.ocean.material.uniforms.uTime.value = sim.t;
  const pdt = paused || rewinding ? 0 : dt;
  for (let i = 0; i < ships.length; i++) poseShip(i, pdt);
  updateWeapons(pdt);
  updateCamera();
  env.follow(camera.position);
  env.setShadowFocus(_b.copy(_c.set(sim.centroid().x, 0, sim.centroid().z)), 500);
  fx.update(sim.t);
  contactsNow = sim.contacts();
  takeAlerts();
  uiClock += dt;
  if (mapOn) map.update(sim, { sel: input.sel, contacts: contactsNow });
  if (hudOn && (uiClock > 0.12 || frames < 3)) {
    uiClock = 0;
    updateShips();
    updateMission();
    updateContacts();
    updateAlerts();
  }
  updateEnd();
  updateTags();
  const keys = keysHtml();
  if (keys !== lastKeys) { keysEl.innerHTML = keys; lastKeys = keys; }
  pauseEl.hidden = !paused || sim.winner !== null;
  pauseEl.textContent = `PAUSED · ${mmss(sim.t)} · ${sim.log.length} order${sim.log.length === 1 ? '' : 's'} given`;
  document.documentElement.style.setProperty('--keys-h', `${keysEl.offsetHeight}px`);
  if (!banner.hidden && performance.now() > bannerUntil) banner.hidden = true;
  renderer.render(scene, camera);
  labels.render(scene, camera);
  if (frames++ === 0) loadingEl?.remove();
});

window.__fleet = { sim, ships, camera, scene, renderer, input, controls, map, fx, DT, act };

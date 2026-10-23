import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { createEnvironment } from './environment.js';
import { createShip } from './models/ship.js';
import { createIslet } from './islet.js';
import { createHelicopter } from './models/helicopter.js';
import { PAD } from './heliFlight.js';
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
import { compass, relName, kmText, RUDDER_MAX, HALF_LENGTH, HALF_BEAM } from './hull.js';
import {
  DuelSim, TELEGRAPH, COMPARTMENTS, COMP_IDS, HULL_HP, LEVELS, DUEL_LEVELS, MAIN_ARC, MAIN_RANGE, GUN_MOUNT_LOCAL, sinkState,
  MAIN_MOUNT, MAIN_RELOAD, MUZZLE_V, zoneAt, SWITCH_TIME, CREWS, REPAIR_TIME, REPAIR_WAIT, FRIEND_MAX, LOCK_FRACTION, FOCUS_FRACTION,
} from './duel.js';
import { createDuelAudio } from './duelAudio.js';
import { createDuelMap } from './duelMap.js';
import './duel.css';

// Entry point of "Ship duel", mission id `duel` (see duel.js for the model): you sail a frigate against another and
// they fight with the 76 mm gun on the bow and the 30 mm guns aft until one sinks. Like Solo Air Defense nothing here
// is a function of a clock: the keys drive a real-time simulation and this file draws it. start.js imports it when
// that mission is picked, with the enemy's level in globalThis.__DUEL_LEVEL.
//
// Views (1 to 5, V cycles): behind the ship, the bridge (the wheelhouse),
// straight above (both ships in frame), riding your last shell, and a free orbit round the ship.

const canvas = document.querySelector('#scene');
const loadingEl = document.querySelector('#loading');
document.body.classList.add('mission-fly', 'mission-duel'); // the manual flight's interface, and this one's own
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

const env = createEnvironment(renderer, scene, { look: 'duel', realSea: true });
env.setShadowSize(1024);
env.ocean.material.uniforms.uShipX.value = 1e7; // the shader's straight-line wake: these ships turn, each has her own
const fx = createLiveFx(scene);

const BRIDGE_EYE = new THREE.Vector3(16.9, 11.4, 0); // the long-lens sight on the bridge roof, in the ship's frame
const HELM_EYE = new THREE.Vector3(11.7, 11.0, 0); // inside the wheelhouse, behind the helm wheel (models/bridge.js; as in Solo Air Defense)
let aboveAng = 0, aboveFresh = true; // the Above view's heading of the screen, eased
let camYaw = 0, camPitch = 0; // behind and above: the drag's swing round the ship and lift, back to nothing on every view change
let lookYaw = 0; // bridge: degrees off the bow, + to starboard
let lookPitch = -0.03;
const _a = new THREE.Vector3();
const _vel = new THREE.Vector3();
wireWeather({ look: env.look });
// Fog only far out: everything inside fighting range (8 km) stays crisp, and the sea blends into the horizon colour before the edge of the
// sea plane (32 km), so it meets the sky without a seam (with none at all the far water showed as a pale band under the islands).
// The weather's cloud banks and squalls are upright cards standing on the sea: seen from high up they show a hard line across the water. They
// fade out as the camera climbs (below 150 m nothing changes; from 450 m up they are gone).
const weatherCards = [];
scene.traverse((o) => { if (o.isSprite && o.scale.x > 3000 && o.userData.opacity !== undefined) weatherCards.push(o); });
function fadeWeatherCards() {
  const k = clamp(1 - (camera.position.y - 150) / 300, 0, 1);
  for (const o of weatherCards) { o.material.opacity = o.userData.opacity * k; o.visible = k > 0.01; }
}
env.ocean.material.uniforms.uFogNear.value = scene.fog.near = 9000;
env.ocean.material.uniforms.uFogFar.value = scene.fog.far = 32000;

// --- The state of the sea (a slider in the menu, kept between visits, applied at once) ---------------------------------------------
// 0 is a flat calm and 100 is very high waves. The waves' steepness and the whitecaps follow the slider, and so does how much the ships
// roll and pitch on them (`seaK`, 1 = the original sea) and how much the behind camera sways.
const SEA_MAX = 5.4;
const seaOf = (v) => 0.4 + (v / 100) ** 1.5 * (SEA_MAX - 0.4); // the steepness for a slider value
const SEA_NAMES = [[0.7, 'Calm'], [1.3, 'Slight'], [2.1, 'Moderate'], [3.0, 'Rough'], [4.0, 'Very rough'], [Infinity, 'Very high waves']];
let seaV = 41; // about the mission's own sea (1.7)
try { const v = Number(localStorage.getItem('intercept.duel.sea2')); if (localStorage.getItem('intercept.duel.sea2') !== null && v >= 0 && v <= 100) seaV = v; } catch { /* storage unavailable */ }
let seaK = seaOf(seaV);
const seaRange = document.querySelector('#sea-range');
let seaHook = null; // set once the simulation exists: gives it the sea's height and direction
function applySea() {
  seaK = seaOf(seaV);
  env.setSea(seaK, THREE.MathUtils.clamp((seaK - 0.5) / 1.5, 0, 1.2));
  const n = document.querySelector('#sea-name');
  if (n) n.textContent = SEA_NAMES.find(([lim]) => seaK < lim)[1];
  if (seaHook) seaHook();
}
if (seaRange) {
  document.querySelector('#sea-row').hidden = false;
  seaRange.value = String(seaV);
  seaRange.addEventListener('input', () => {
    seaV = Number(seaRange.value);
    try { localStorage.setItem('intercept.duel.sea2', String(seaV)); } catch { /* storage unavailable */ }
    applySea();
  });
  seaRange.addEventListener('change', () => seaRange.blur()); // so the arrow keys steer again
}
applySea();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _q = new THREE.Quaternion();
const rad = THREE.MathUtils.degToRad;
const clamp = THREE.MathUtils.clamp;

let level = 'normal';
try { level = globalThis.__DUEL_LEVEL ?? new URLSearchParams(location.search).get('level') ?? 'normal'; } catch { /* no address */ }
if (!DUEL_LEVELS.includes(level)) level = 'normal';
const sim = new DuelSim({ seed: (Date.now() % 100000) | 0, level, waves: true, realHandling: true, helmPlayer: true, scouting: true, intro: true, playerReload: 0.5, playerDamage: 2, playerFlankKn: 38, gunRange: MAIN_RANGE - 500, gatAnswers: true, easyGunSafe: true, firingReveals: true });
seaHook = () => { const i = env.seaInfo(); if (i) sim.setSea(i.hs, i.dir); };
seaHook();

// --- The ships --------------------------------------------------------------------------------------------------------
// A picture for each ship the simulation has: yours, the enemy's, then whoever arrives (more enemy frigates, a friendly one, merchants).
// Pictures are pooled, so a ship that is gone, or a fight started again, gives hers back. Frigates have no deck crew (it stands in the
// gun's way); the enemy has her own ensign and a bluer hull.
const shipPool = {};
function makeVisual(s) {
  const key = s.merchant ? 'merchant' : s.team === 1 ? 'rus' : s.idx === 0 ? 'me' : 'alg';
  let v = shipPool[key]?.pop();
  if (!v) {
    const m = s.merchant ? createMerchant() : createShip({ ensign: s.team === 1 ? 'rus' : 'alg', crew: false, ...(s.idx === 0 ? { catapult: false, helicopter: true } : {}) });
    m.group.rotation.order = 'YXZ'; // heading, then heel, then trim
    scene.add(m.group);
    const gats = s.merchant ? [] : GUN_MOUNT_LOCAL.map(([x, y, z]) => {
      const g = createGatling();
      g.group.position.set(x, y - 1.3, z); // the mount's pivot is the gun's centre; its base stands on the roof
      m.group.add(g.group);
      return g;
    });
    const flashSprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, blending: THREE.AdditiveBlending, depthWrite: false }));
    flashSprite.scale.setScalar(11);
    flashSprite.visible = false;
    scene.add(flashSprite);
    v = { ...m, key, gats, wake: createWake(scene), plume: new ShipPlume(fx), flashSprite };
  }
  v.smokeT = 0; v.flash = 0; v.gunClock = [0, 0]; v.mot = null; v.plume.last = null;
  v.group.visible = true;
  return v;
}
function releaseVisual(v) {
  v.group.visible = false;
  v.flashSprite.visible = false;
  v.wake.hide();
  (shipPool[v.key] ??= []).push(v);
}
const ships = [];
// Keeps the pictures in step with the ships the simulation has (called every frame and after a restart).
function syncShips() {
  while (ships.length < sim.ships.length) ships.push(makeVisual(sim.ships[ships.length]));
  while (ships.length > sim.ships.length) releaseVisual(ships.pop());
  syncIslands();
}
// The islands the simulation has, as meshes (rebuilt when a new battle plans new ones).
const isletGroup = new THREE.Group();
scene.add(isletGroup);
let isletKey = '';
function syncIslands() {
  const key = sim.islands.map((i) => `${i.x | 0},${i.z | 0},${i.r | 0}`).join('|');
  if (key === isletKey) return;
  isletKey = key;
  for (const m of [...isletGroup.children]) { isletGroup.remove(m); m.geometry.dispose(); m.material.dispose(); }
  for (const isl of sim.islands) isletGroup.add(createIslet(isl));
}

// The helicopter: on the pad while it is parked or spinning up (the model on the ship), then a world model that flies where the sim says.
const _deck = { x: PAD.x, y: PAD.y, z: PAD.z, yaw: 0, pitch: 0, roll: 0, rpm: 0, spin: 0, flying: false, phase: 'parked' };
function deckHeliState() { _deck.rpm = sim.hop.rpm; _deck.spin = sim.hop.spin; return _deck; }
const strikeHeli = createHelicopter();
strikeHeli.visible = false;
scene.add(strikeHeli);
const _hs = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0, rpm: 1, spin: 0 };
function updateStrikeHeli() {
  const h = sim.hop;
  const show = !!h && h.phase !== 'deck' && h.phase !== 'spin' && h.phase !== 'gone';
  strikeHeli.visible = show;
  if (!show) return;
  _hs.x = h.x; _hs.y = h.y; _hs.z = h.z; _hs.yaw = -h.yaw; _hs.pitch = h.pitch; _hs.roll = h.roll; _hs.rpm = h.rpm; _hs.spin = h.spin;
  strikeHeli.userData.update(_hs);
  for (const m of sim.hmiss) fx.missileTrail(_c.set(m.p[0], m.p[1], m.p[2]), sim.t); // its missiles in the air
}

// --- Shells and tracers ---------------------------------------------------------------------------------------------
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
    n, len,
    set(k, p, v) { // streak k: from p back along -v
      if (!p) { lineGeo.attributes.position.setXYZ(k * 2, 0, -9999, 0); lineGeo.attributes.position.setXYZ(k * 2 + 1, 0, -9999, 0); headGeo.attributes.position.setXYZ(k, 0, -9999, 0); return; }
      _b.set(v[0], v[1], v[2]).normalize().multiplyScalar(-len);
      lineGeo.attributes.position.setXYZ(k * 2, p[0], p[1], p[2]);
      lineGeo.attributes.position.setXYZ(k * 2 + 1, p[0] + _b.x, p[1] + _b.y, p[2] + _b.z);
      headGeo.attributes.position.setXYZ(k, p[0], p[1], p[2]);
    },
    done() { lineGeo.attributes.position.needsUpdate = true; headGeo.attributes.position.needsUpdate = true; },
  };
}
const shellVis = streaks(96, 3.2, 0xffd9a0, 22); // the 76 mm shells: a bright streak with a glowing head
const tracerVis = streaks(400, 1.1, 0xff6a1f, 34); // the 30 mm tracers
const tracers = Array.from({ length: 400 }, () => ({ on: false, p: new THREE.Vector3(), v: new THREE.Vector3(), t0: 0 }));
let tracerNext = 0;
syncShips(); // the two ships to start with (more are added as they arrive)
const bridge = createBridge({ classicWheel: true }); // the wheelhouse's inside, shown only in the bridge view (as in Solo Air Defense)
bridge.group.visible = false;
ships[0].group.add(bridge.group);

// --- The sea picture: each ship's pose from the simulation -------------------------------------------------------------
// Where each compartment really is on the ship (her frame): the turret of the 76 mm, the wheelhouse, the funnel over the engine room, the aft
// 30 mm mounts and the stern over the rudder. The radar view's marks sit here, a locked shell is sent here, and fires burn here.
const ZONE_POS = { gun: [32, 7.5, 0], bridge: [11, 11.5, 0], engine: [-13.5, 10, 0], guns: [-33.6, 13, 0], steering: [-52, 4, 0] };
const ZONE_X = Object.fromEntries(Object.entries(ZONE_POS).map(([id, p]) => [id, p[0]]));
let hgunCount = 0;
const MOT = { heave: [(2 * Math.PI) / 6.5, 0.35], pitch: [(2 * Math.PI) / 6.0, 0.3], roll: [(2 * Math.PI) / 11, 0.13] }; // [w, damping ratio]
let slamShake = 0; // the jolt of the player's bow slam, 0 to 2, dying away
function poseShip(i, dt) {
  const s = sim.ships[i];
  const v = ships[i];
  const sink = s.tSunk !== null ? sinkState(sim.t - s.tSunk, s.listSide) : null;
  const list = s.listSide * rad(9) * (1 - s.hp / HULL_HP) ** 2; // the hurt ship settles to the side she was hit on
  v.group.visible = !sink?.gone;
  // Every ship afloat rides the real waves (the ocean's own table): she heaves with the water under her middle and takes the pitch and roll of
  // its surface under her bow, stern and sides (a hull this long follows the swell, not the chop, so most but not all of it).
  // The hull does not follow the surface instantly: heave, pitch and roll are damped oscillators (periods of about 6.5, 6 and 11 s, the roll
  // lightly damped) driven by the waves' own heave, slope along her and slope across her, so a beam sea sets her rolling, she hangs on a crest
  // and drops after it, and the bow digs in and slams.
  const ride = sink ? null : env.seaRide(s.x, s.z, s.psi, sim.t, s.merchant ? 120 : 110, 14);
  let heaveSea = 0, rollSea = 0, pitchSea = 0;
  if (ride) {
    const m = (v.mot ??= { h: ride.heave, hv: 0, p: ride.pitch, pv: 0, r: -ride.roll, rv: 0, wet: false, cool: 0 });
    if (!(dt > 0 && dt < 0.5)) { m.h = ride.heave; m.hv = 0; m.p = ride.pitch; m.pv = 0; m.r = -ride.roll; m.rv = 0; } // a stall or a restart: just snap
    else {
      const n = Math.max(1, Math.ceil(dt / 0.02)), h = dt / n;
      for (let k = 0; k < n; k++) {
        m.hv += (MOT.heave[0] ** 2 * (ride.heave - m.h) - 2 * MOT.heave[1] * MOT.heave[0] * m.hv) * h; m.h += m.hv * h;
        m.pv += (MOT.pitch[0] ** 2 * (ride.pitch - m.p) - 2 * MOT.pitch[1] * MOT.pitch[0] * m.pv) * h; m.p += m.pv * h;
        m.rv += (MOT.roll[0] ** 2 * (-ride.roll - m.r) - 2 * MOT.roll[1] * MOT.roll[0] * m.rv) * h; m.r += m.rv * h;
      }
    }
    m.r = clamp(m.r, -0.42, 0.42); m.p = clamp(m.p, -0.25, 0.25);
    heaveSea = m.h; rollSea = m.r * 0.9; pitchSea = m.p * 0.9;
    // Slam: the bow, at the end of her pitch, meets a wave that stands well above her stem: spray over the forecastle, a jolt through the hull
    // (and the camera), and a little way lost.
    m.cool = Math.max(0, m.cool - dt);
    const fx0 = Math.cos(s.psi), fz0 = Math.sin(s.psi);
    const water = env.seaHeightAt(s.x + fx0 * 50, s.z + fz0 * 50, sim.t);
    const over = water - (m.h + Math.sin(m.p) * 50) - 4.2; // metres of water above the stem's usual freeboard
    if (over > 0 && !m.wet && m.cool <= 0 && !s.merchant && ride.hs > 1.2) {
      const str = clamp(0.4 + over * 0.5, 0.3, 2);
      m.cool = 1.4;
      _vel.x = Math.cos(s.psi) * s.u; _vel.z = Math.sin(s.psi) * s.u;
      const fwdv = { x: fx0, z: fz0 };
      for (const side of [-1, 1]) for (let q = 0; q < 10; q++) v.plume.fx.bowSpray(v.group.localToWorld(_c.set(50, 2.5, side * 2.6)), _vel, side, 2 + str * 2.5, sim.t, fwdv);
      sim.slam(i, str);
      if (i === 0) slamShake = Math.max(slamShake, str);
    }
    m.wet = over > 0;
  }
  v.group.position.set(s.x, (sink ? sink.depth : 0) + heaveSea, s.z);
  v.group.rotation.set(s.heel + list + rollSea + (sink?.roll ?? 0), -s.psi, pitchSea + (sink?.trim ?? 0));
  v.group.updateMatrixWorld(true);
  if (!s.merchant) {
    v.mainGun.pose(s.gun.yaw, s.gun.pitch);
    v.gats.forEach((g, k) => g.pose(s.gats[k].yaw, s.gats[k].pitch, s.gats[k].spin, s.gats[k].firing, sim.t));
    v.update(sim.t, Infinity, Infinity, { aim: { yaw: Math.PI, pitch: 0 }, cradleT: 0, heli: i === 0 && sim.hop ? deckHeliState() : undefined, heliHidden: i === 0 && sim.hop ? (sim.hop.phase !== 'deck' && sim.hop.phase !== 'spin') : undefined }); // the radar turns; the launcher box stays stowed; the helicopter sits on the pad until it lifts off
  }
  v.wake.update({ t: sim.t, x: s.x, z: s.z, psi: s.psi, r: s.r, u: s.u });
  if (!sink?.gone && s.tSunk === null) { // the funnel's haze and the bow's spray, while she is afloat
    _vel.x = Math.cos(s.psi) * s.u;
    _vel.z = Math.sin(s.psi) * s.u;
    v.plume.update(sim.t, v.group, _vel, seaK);
  }
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
  // The 76 mm shells in the air, straight from the simulation.
  for (let k = 0; k < shellVis.n; k++) { const sh = sim.shells[k]; shellVis.set(k, sh?.p, sh?.v); }
  shellVis.done();
  // The 30 mm tracers: a tracer every third round, flying on their own from the muzzle.
  ships.forEach((v, i) => {
    const s = sim.ships[i];
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

// --- The banner and the events -----------------------------------------------------------------------------------------
const banner = document.querySelector('#shot-caption');
banner.classList.add('call');
let bannerUntil = 0;
// An alert sound goes only with its text on the banner, and only where a call asks for one (`sound`: 'alarm' for bad news about your ship,
// 'ping' for a contact or news). The audio throttles them (duelAudio.js `cue`). The helicopter's radio reports are not shown or heard.
let cueSound = null; // set once the audio exists
function say(text, tone = '', ms = 3200, sound = null) {
  if (sound && cueSound) cueSound(sound, text);
  banner.textContent = text;
  banner.hidden = false;
  banner.classList.remove('standby', 'execute', 'station', 'danger');
  const cls = { ok: 'execute', warn: 'standby', bad: 'danger' }[tone];
  if (cls) banner.classList.add(cls);
  bannerUntil = performance.now() + ms;
}
const alarmEl = document.createElement('div');
alarmEl.className = 'duel-alarm';
alarmEl.setAttribute('aria-hidden', 'true');
document.body.appendChild(alarmEl);
const who = (i) => (i === 0 ? 'Your' : 'Enemy');
// --- The battle log (the debrief) and the kill-cam ----------------------------------------------------------------------------------
// Every notable event is written down with its time; the end card lists them. When a ship sinks a short cinematic orbits her (Esc, Space or
// Enter skip it) while the sim keeps running.
const LOG = [];
const KILL = { on: false, t: 0, dur: 5.5, ship: 0 };
const mmss = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
function shipLabel(i) {
  const s = sim.ships[i];
  if (!s) return 'Ship';
  return s.merchant ? 'Merchant ship' : i === 0 ? 'Your ship' : s.team === 0 ? 'Friendly frigate' : 'Enemy frigate';
}
function sideOf(i) { return i === 0 ? 'Your' : sim.ships[i]?.team === 0 ? 'Friendly' : sim.ships[i]?.merchant ? 'Merchant' : 'Enemy'; }
function record(e) {
  const add = (kind, text) => LOG.push({ t: sim.t, kind, text });
  if (e.type === 'firstshot') add('ok', 'Your first shot');
  else if (e.type === 'arrive') add(e.kind === 'enemy' ? 'bad' : '', e.kind === 'enemy' ? 'Another enemy frigate arrives' : e.kind === 'ally' ? 'A friendly frigate joins you' : 'A merchant ship crosses');
  else if (e.type === 'out') add(e.ship === 0 ? 'bad' : 'ok', `${sideOf(e.ship)} ${COMPARTMENTS[e.comp].name.toLowerCase()} out`);
  else if (e.type === 'fire' && (e.ship === 0 || sim.ships[e.ship]?.team === 1)) add(e.ship === 0 ? 'bad' : 'ok', `Fire in ${e.ship === 0 ? 'your' : 'her'} ${COMPARTMENTS[e.comp].name.toLowerCase()}`);
  else if (e.type === 'sunk') add(e.ship === 0 ? 'bad' : 'ok', `${shipLabel(e.ship)} sunk`);
  else if (e.type === 'ground' && e.ship === 0) add('bad', 'You ran aground');
  else if (e.type === 'collision' && (e.a === 0 || e.b === 0)) add('bad', `Collision at ${e.impact.toFixed(0)} m/s`);
}
function startKill(i) {
  if (INTRO.phase !== 'off') return;
  KILL.on = true; KILL.t = 0; KILL.ship = i;
  KILL.dur = sim.winner !== null || sim.over ? 7 : 5;
  document.body.classList.add('duel-cine');
  say(`${shipLabel(i)} is going down`, i === 0 ? 'bad' : 'ok', KILL.dur * 1000);
}
function endKill() {
  if (!KILL.on) return;
  KILL.on = false;
  if (INTRO.phase === 'off') document.body.classList.remove('duel-cine');
}
function killCamera() {
  if (!KILL.on) return false;
  const s = sim.ships[KILL.ship];
  if (!s) return false;
  const u = KILL.t / KILL.dur, a = s.psi + 2.4 + KILL.t * 0.22, r = 150 - u * 55;
  camera.position.set(s.x + Math.cos(a) * r, 26 - u * 11, s.z + Math.sin(a) * r);
  camera.lookAt(s.x, 7 - u * 4, s.z);
  setFov(42);
  return true;
}
// After an enemy goes down (and her kill-cam), the next one: the living enemy your sight now has (or the nearest), once the radar has her.
let nextEnemyPending = false;
function nextEnemyStep() {
  if (!nextEnemyPending || KILL.on || INTRO.phase !== 'off' || sim.winner !== null) return;
  const live = sim.ships.filter((o) => o.team === 1 && o.tSunk === null && o.det !== false);
  if (!live.length) return; // wait: the next one may still be over the horizon
  nextEnemyPending = false;
  const next = live.includes(sim.enemy) ? sim.enemy : live.reduce((a, b) => (sim.distance(sim.player, a) < sim.distance(sim.player, b) ? a : b));
  sim.setTarget(0, next.idx);
  if (next.stats.shells > 0) { // she is already firing: no question, straight into the sight, the gun firing
    setView('radar');
    setFireLatch(true);
    say(`Under fire · ${relName(sim.relBearing(sim.player))}`, 'bad', 3600, 'alarm');
  } else {
    INTRO.again = true;
    toAsk('Another hostile');
  }
}
const eventHooks = []; // the audio listens here
function handleEvents() {
  for (const e of sim.takeEvents()) {
    for (const h of eventHooks) h(e);
    record(e);
    if (e.type === 'shot') {
      const v = ships[e.owner];
      v.mainGun.muzzle.getWorldPosition(_c);
      v.flashSprite.position.copy(_c);
      v.flashSprite.visible = true;
      v.flash = 0.09;
      for (let k = 0; k < 7; k++) fx.gunSmoke(_c, _b.set(e.dir[0] * 9, e.dir[1] * 9, e.dir[2] * 9), sim.t);
    } else if (e.type === 'contact') {
      say(`Contact ${relName(e.rel)} · ${kmText(e.range)}`, 'warn', 3600, 'ping');
    } else if (e.type === 'lost') {
      say('Contact lost', '', 2400);
    } else if (e.type === 'hgun') {
      for (let n = 0; n < 3; n++) { // tracers down to her
        const tr = tracers[tracerNext++ % tracers.length];
        tr.p.set(...e.pos);
        tr.v.set(e.to[0] - e.pos[0], e.to[1] - e.pos[1], e.to[2] - e.pos[2]).normalize().multiplyScalar(1050);
        tr.v.x += (Math.random() - 0.5) * 12; tr.v.y += (Math.random() - 0.5) * 12; tr.v.z += (Math.random() - 0.5) * 12;
        tr.t0 = sim.t - n * 0.05;
        tr.on = true;
      }
      _c.set(...e.pos);
      for (let k = 0; k < 2; k++) fx.gunSmoke(_c, _b.set(0, 0, 0), sim.t);
      if ((hgunCount++ % 3) === 0) fx.shellBurst(_c.set(...e.to), sim.t);
    } else if (e.type === 'hmissile') {
      fx.launchBillow(_c.set(...e.pos), _b.set(0, -1, 0), sim.t);
    } else if (e.type === 'impact') {
      fx.shellBurst(_c.set(...e.pos), sim.t);
    } else if (e.type === 'ground') {
      for (let k = 0; k < 3; k++) fx.explosion(_c.set(e.pos[0] + (k - 1) * 10, 4, e.pos[2]), sim.t + k * 0.25);
      if (e.ship === 0) { say('Aground: back off', 'bad', 3600, 'alarm'); slamShake = Math.max(slamShake, 2); }
    } else if (e.type === 'hit') {
      fx.shellBurst(_c.set(...e.pos), sim.t);
      if (e.ship === 0) {
        alarmEl.classList.remove('hit'); void alarmEl.offsetWidth; alarmEl.classList.add('hit');
        say(`Hit: ${COMPARTMENTS[e.comp].name}${e.out ? ' out' : ''}`, 'bad', 2200);
      } else if (e.neutral) {
        if (e.owner === 0) say('Merchant hit: hold fire', 'bad', 3600, 'alarm');
      } else if (e.owner === 0) say(`Hit on her ${COMPARTMENTS[e.comp].name.toLowerCase()}${e.out ? ': out' : ''}`, 'ok', 2200);
    } else if (e.type === 'arrive') {
      const where = relName(e.rel);
      if (e.kind === 'enemy') {
        const live = sim.ships.filter((o) => o.team === 1 && o.tSunk === null).length;
        const help = live > 1 ? sim.callFriend() : { ok: false };
        say(`Enemy frigate ${where} · ${kmText(e.range)}`, 'warn', 4200, 'alarm');
      }
      else if (e.kind === 'ally') say(`Friendly ${where} · ${kmText(e.range)}`, 'ok', 4200, 'ping');
      else say(`Merchant ${where}: hold fire`, '', 4200, 'ping');
    } else if (e.type === 'collision') {
      for (let k = 0; k < 4; k++) fx.shellBurst(_c.set(e.pos[0] + (Math.random() - 0.5) * 10, e.pos[1] + Math.random() * 4, e.pos[2] + (Math.random() - 0.5) * 10), sim.t);
      if (e.a === 0 || e.b === 0) {
        alarmEl.classList.remove('hit'); void alarmEl.offsetWidth; alarmEl.classList.add('hit');
        say('Collision', 'bad', 2600, 'alarm');
      }
    } else if (e.type === 'gunhit') {
      if (e.ship === 0) { alarmEl.classList.remove('hit'); void alarmEl.offsetWidth; alarmEl.classList.add('hit'); }
    } else if (e.type === 'splash') {
      fx.splashAt(_c.set(e.pos[0], 0, e.pos[2]), sim.t, 1.5);
      if (e.miss < 60) say(e.owner === 0 ? 'Near miss' : 'Their shell falls close', e.owner === 0 ? '' : 'warn', 1400);
    } else if (e.type === 'out') {
      const moved = e.ship !== 0 ? sightPastOut(e.ship, e.comp) : null;
      say(`${who(e.ship)} ${COMPARTMENTS[e.comp].name.toLowerCase()} out`, e.ship === 0 ? 'bad' : 'ok', 3000, e.ship === 0 ? 'alarm' : 'ping');
    } else if (e.type === 'sunk') {
      if (sim.ships[e.ship]?.team === 1) nextEnemyPending = true;
      startKill(e.ship);
      for (let k = 0; k < 3; k++) fx.explosion(_c.set(e.pos[0] + (k - 1) * 14, e.pos[1], e.pos[2]), sim.t + k * 0.35);
    } else if (e.type === 'ammo') {
      
    } else if (e.type === 'repair') {
      if (e.ship === 0) say(e.phase === 'start' ? `Repairing ${COMPARTMENTS[e.comp].name.toLowerCase()}` : `${COMPARTMENTS[e.comp].name} repaired`, e.phase === 'start' ? 'warn' : 'ok', 2000);
    } else if (e.type === 'fire') {
      if (e.ship === 0) say(`Fire: ${COMPARTMENTS[e.comp].name.toLowerCase()}`, 'warn', 2400, 'alarm');
    } else if (e.type === 'over') {
      say(e.reason === 'merchant' ? 'Merchant sunk: you lose' : e.winner === 0 ? 'You win' : 'You lose', e.winner === 0 ? 'ok' : 'bad', 60000, e.winner === 0 ? 'ping' : 'alarm');
    }
  }
}

// --- Views --------------------------------------------------------------------------------------------------------------
const VIEWS = ['behind', 'bridge', 'above', 'orbit', 'radar'];
const VIEW_LABELS = ['Behind', 'Bridge', 'Above', 'Orbit', 'Radar'];
const VIEW_NAMES = { behind: 'Behind the ship', bridge: 'The bridge', above: 'Straight above', orbit: 'Free orbit', radar: 'Radar (the fire-control sight: aim it at any part of her hull; the helm is locked)' };
let view = 'behind';
let attackReady = false; // the attack question is built further down
function closeAttackSafe() { if (attackReady) closeAttack(); }
function setFov(f) {
  if (Math.abs(camera.fov - f) < 0.01) return;
  camera.fov = f;
  camera.updateProjectionMatrix();
  pointScale.value = (window.innerHeight * renderer.getPixelRatio()) / (2 * Math.tan(rad(f / 2)));
}
const viewButtons = [];
let viewBeforeRadar = 'behind';
let radarPrevManual = false;
function setView(v) {
  closeAttackSafe();
  if (v === 'radar' && view !== 'radar') {
    viewBeforeRadar = view;
    radarPrevManual = sim.player.manual;
    input.left = input.right = 0;
    setManual(true);
    say('Aim: arrows · lock: Space · fire: F · Esc: helm', 'warn', 4200);
  } else if (v !== 'radar' && view === 'radar') setManual(radarPrevManual); // the gun goes on firing: a latched FIRE or a held key carries over
  view = v;
  camYaw = camPitch = 0; aboveFresh = true; lookYaw = 0; lookPitch = -0.03; // going back to a view always opens on its default angle
  radarKeys.l = radarKeys.r = radarKeys.u = radarKeys.d = radarKeys.zi = radarKeys.zo = 0;
  sight.manual = false; // the radar's own controls start on automatic every time
  sight.lock = null;
  sight.fresh = true;
  radarEl.hidden = v !== 'radar';
  sightEl.hidden = v !== 'radar';
  if (ships[0]) ships[0].mainGun.group.visible = v !== 'radar'; // its barrel, trained on her, stood as a white bar up the middle of the sight
  document.body.classList.toggle('duel-radarview', v === 'radar');
  try { flashKeys(); } catch { /* the key bar is built after the first view is set */ }
  map.sight = null;
  controls.enabled = false;
  if (v === 'orbit') orbitOnBoth();
  rig.free();
  camera.up.set(0, 1, 0);
  viewButtons.forEach((b) => { const on = b.dataset.view === v; b.classList.toggle('active', on); b.setAttribute('aria-pressed', String(on)); });
}
// The orbit view: a level camera (the horizon sits in the middle of the screen) at the side of the line between the two ships, far enough back
// that both stand in the gap between the readouts. A drag swings it round them, the wheel moves it in and out; it follows both. With no
// enemy in sight it frames your ship alone.
// The orbit view, in one line: drag right to swing the camera to the right round the ships, drag down to rise (up to sink back), wheel to move in and out, double click to
// start again. The view is tilted down a little so the horizon stands 70 % of the way up the screen (at its default height).
const ORBIT_TILT = Math.atan(0.4 * Math.tan(rad(25)));
let orbitDrag = false;
let orbitFresh = true, orbitAz = 0, orbitZoom = 1, orbitEl = 0; // orbitEl: the drag's lift of the camera (radians above the level view)
const orbitPos = new THREE.Vector3(), orbitLook = new THREE.Vector3();
let orbitDist = 300;
function orbitOnBoth() { orbitFresh = true; orbitAz = 0; orbitZoom = 1; orbitEl = 0; }
function orbitCamera() {
  setFov(50);
  const p = sim.player, e = sim.enemy;
  const both = e && e.tSunk === null && e.det !== false;
  const mx = both ? (p.x + e.x) / 2 : p.x, mz = both ? (p.z + e.z) / 2 : p.z;
  const len = both ? Math.hypot(e.x - p.x, e.z - p.z) : 0;
  const ux = both ? (e.x - p.x) / (len || 1) : 1, uz = both ? (e.z - p.z) / (len || 1) : 0;
  // How much of the width is free of readouts: the ships' span must fit in it.
  const wide = window.innerWidth > 900;
  const free = !hudOn ? 0.84 : wide ? 0.7 : 0.78;
  const tanH = Math.tan(rad(camera.fov / 2)) * camera.aspect;
  const half = len / 2 + 80;
  const want = clamp(half / (tanH * free), 220, 9000) * orbitZoom;
  const k = orbitFresh ? 1 : 1 - Math.exp(-frameDt / 0.6); // the distance eases; the camera itself follows the hand at once
  orbitDist += (want - orbitDist) * k;
  const ang = Math.atan2(ux, -uz) + orbitAz; // the camera stands on the line's left, rotated by the drag
  orbitLook.set(mx, 22, mz);
  orbitPos.set(mx + Math.cos(ang) * orbitDist * Math.cos(orbitEl), 22 + Math.sin(orbitEl) * orbitDist, mz + Math.sin(ang) * orbitDist * Math.cos(orbitEl));
  camera.position.lerp(orbitPos, orbitFresh || orbitDrag ? 1 : 1 - Math.exp(-frameDt / 0.2));
  camera.lookAt(orbitLook);
  camera.rotateX(-ORBIT_TILT); // the same extra tilt at every height
  orbitFresh = false;
}
canvas.style.touchAction = 'none';
canvas.addEventListener('pointerdown', (e) => {
  if (view !== 'orbit' || e.button !== 0) return;
  let x = e.clientX, y = e.clientY;
  orbitDrag = true;
  const move = (ev) => { orbitAz += (ev.clientX - x) * 0.006; orbitEl = clamp(orbitEl + (ev.clientY - y) * 0.004, 0, 1.4); x = ev.clientX; y = ev.clientY; };
  const up = () => { orbitDrag = false; window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up); };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
});
canvas.addEventListener('wheel', (e) => { if (view === 'orbit') orbitZoom = clamp(orbitZoom * Math.exp(e.deltaY * 0.001), 0.5, 2.5); }, { passive: true });
const _fwd = new THREE.Vector3();
function setCamHint() { // tells the simulation what the camera sees, so the helicopter fires where it can be seen
  camera.getWorldDirection(_fwd);
  const vh = rad(camera.fov / 2), hh = Math.atan(Math.tan(vh) * camera.aspect);
  sim.camHint = { p: [camera.position.x, camera.position.y, camera.position.z], f: [_fwd.x, _fwd.y, _fwd.z], half: Math.min(vh, hh) };
}
// Which enemy ships stand behind land as the guns see her: no tag, no marks and no aim on her parts (the helicopter and the map still show her).
const landHidden = [];
function updateLandHidden() {
  const p = sim.player;
  if (!sim.islands.length) { landHidden.length = 0; return; }
  const M = sim.toWorld(p, MAIN_MOUNT);
  for (let i = 0; i < sim.ships.length; i++) {
    const t = sim.ships[i];
    landHidden[i] = i > 0 && t.team === 1 && t.tSunk === null && sim.landBetween(M, [t.x, 6, t.z]);
  }
}
let frameDt = 1 / 60;
let behindHead = 0, behindT = 0, behindOn = false; // the behind camera's own heading, which trails the ship's
function updateCamera() {
  slamShake *= Math.exp(-4 * frameDt);
  if (introCamera() || killCamera()) return;
  if (view !== 'behind') behindOn = false;
  const me = ships[0].group;
  const foe = sim.enemy;
  bridge.group.visible = view === 'bridge';
  if (view === 'orbit') { orbitCamera(); return; }
  if (view === 'behind') {
    setFov(55);
    // Not bolted to the ship: the camera trails her heading (it swings out when she turns), rises and falls and sways with the sea,
    // and leans a little into a turn, while it keeps looking at the point ahead of her real bow.
    const p = sim.player;
    if (!behindOn || sim.t < behindT) behindHead = p.psi;
    behindOn = true; behindT = sim.t;
    behindHead += wrapAngle(p.psi - behindHead) * (1 - Math.exp(-frameDt / 0.9));
    const swell = Math.min(seaK, SEA_MAX);
    const ride = env.seaRide(p.x, p.z, p.psi, sim.t); // the camera rises and falls with the swell under the ship
    const bob = ride ? ride.heave * 0.85 : (Math.sin(sim.t * 0.9) * 1.0 + Math.sin(sim.t * 1.7 + 1) * 0.5) * swell;
    const sway = Math.sin(sim.t * 0.55 + 2) * 0.6 * swell;
    const hx = Math.cos(behindHead), hz = Math.sin(behindHead);
    const cy = Math.cos(behindHead + camYaw), sy = Math.sin(behindHead + camYaw), cp = Math.cos(camPitch), sp = Math.sin(camPitch);
    camera.position.set(p.x - cy * 110 * cp - hz * sway, 34 + bob + 110 * sp, p.z - sy * 110 * cp + hx * sway);
    camera.lookAt(p.x + Math.cos(p.psi) * 45, 6 + bob * 0.3, p.z + Math.sin(p.psi) * 45);
    camera.rotateZ(wrapAngle(p.psi - behindHead) * -0.3 + Math.sin(sim.t * 0.8) * 0.012 * swell);
    if (slamShake > 0.01) { camera.position.y += Math.sin(sim.t * 38) * 0.7 * slamShake; camera.rotateX(Math.sin(sim.t * 29) * 0.012 * slamShake); }
  } else if (view === 'bridge') {
    // The wheelhouse, as in Solo Air Defense: the wheel turns with the rudder and the telegraph levers follow the order; drag looks round.
    bridge.update(clamp(sim.player.rudder / RUDDER_MAX, -1, 1), sim.player.order / (TELEGRAPH.length - 1));
    me.localToWorld(camera.position.copy(HELM_EYE));
    const yaw = rad(lookYaw);
    _a.set(Math.cos(yaw) * Math.cos(lookPitch), Math.sin(lookPitch), Math.sin(yaw) * Math.cos(lookPitch)).transformDirection(me.matrixWorld);
    camera.lookAt(_b.copy(camera.position).add(_a));
    setFov(55);
  } else if (view === 'radar') {
    aimSight(frameDt);
  } else if (view === 'above') {
    // Straight down with the two ships side by side across the screen: the line from the enemy to you runs left to right (you on the right),
    // eased as they move, and the height takes the width of the window, not just the range.
    setFov(50);
    const mx = (sim.player.x + foe.x) / 2, mz = (sim.player.z + foe.z) / 2;
    const want = Math.atan2(sim.player.z - foe.z, sim.player.x - foe.x); // the screen's right, as an angle on the sea (x, z)
    aboveAng = aboveFresh ? want : aboveAng + wrapAngle(want - aboveAng) * (1 - Math.exp(-frameDt / 0.5));
    aboveFresh = false;
    const tanH = Math.tan(rad(camera.fov / 2)) * camera.aspect;
    const h = Math.max(380, (sim.range() * 1.45) / (2 * tanH)); // room for the readouts either side
    const a = aboveAng + camYaw;
    camera.up.set(Math.sin(a), 0, -Math.cos(a)); // up = (dz, -dx)
    camera.position.set(mx, h, mz);
    camera.lookAt(mx, 0, mz);
  }
}

// --- Readouts -------------------------------------------------------------------------------------------------------------
const root = document.querySelector('#hud');
root.classList.add('duel-root');
root.innerHTML = '<div class="duel-hud"></div>';
const hud = root.querySelector('.duel-hud');
let selComp = 0; // the compartment Z has picked for X to send a crew to
function gunStatus(s) {
  const g = s.gun;
  if (s.tSunk !== null) return '';
  if (s.comp.gun <= 0) return 'OUT';
  if (g.ammo <= 0) return 'NO AMMO';
  if (s.idx === 0 && fireLatch) return 'FIRING';
  if (g.landBlocked) return 'LAND IN THE WAY';
  const sol = Math.abs(sim.relBearing(s));
  if (sim.range() > MAIN_RANGE) return 'OUT OF RANGE';
  if (sol > MAIN_ARC) return 'OUT OF ARC';
  if (g.cool > 0) return `LOADING ${g.cool.toFixed(1)} s`;
  if (s.manual) return g.engaged ? (g.onTarget ? 'ON YOUR AIM' : 'TRAINING') : 'aim at her';
  return g.onTarget ? 'ON TARGET' : 'TRAINING';
}
function endHtml() {
  if (sim.winner === null) return '';
  const w = sim.winner === 0;
  const st = sim.player.stats;
  const es = sim.ships.filter((o) => o.team === 1).reduce((a, o) => ({ hits: a.hits + o.stats.hits, shells: a.shells + o.stats.shells }), { hits: 0, shells: 0 });
  const why = sim.over === 'merchant' ? '<p>You sank a merchant ship</p>' : '';
  return `<section class="dh-end ${w ? 'won' : 'lost'}"><h2>${w ? 'You win' : 'You lose'}</h2>${why}`
    + `<p>${Math.round(sim.t)} s · your 76 mm: ${st.hits} of ${st.shells} hit · theirs: ${es.hits} of ${es.shells}</p>`
    + `<ol class="dh-log">${LOG.slice(-14).map((r) => `<li class="${r.kind}"><time>${mmss(r.t)}</time>${r.text}</li>`).join('')}</ol><p><kbd>R</kbd> to fight again</p></section>`;
}
let lastHtml = '';
let hudOn = true;
function updateHud() {
  const html = endHtml(); // the enemy and your ship are on their own cards (targetHtml, boardHtml) in every view
  if (html !== lastHtml) { hud.innerHTML = html; lastHtml = html; root.classList.toggle('dh-over', html !== ''); }
}

// --- The ship's instruments (as Solo Air Defense's strip) ---------------------------------------------------------------------
// Two cards with a dome between them, standing on the bottom edge: your hull and compartments, the heading tape with the rudder arc and
// the speed, and the guns, round, stocks and crews. The enemy and the range stay in the card at the right.
const shipEl = document.createElement('div');
shipEl.id = 'duel-ship';
shipEl.className = 'duel-ship';
// The two propellers stand outside the dome, one each side, and turn with the ship's speed (counter-rotating; backwards when she goes astern).
const PROP_SVG = '<svg viewBox="-24 -24 48 48" aria-hidden="true"><defs><linearGradient id="pp-brass" x1="0" y1="-23" x2="9" y2="-6" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#f6e4a2"/><stop offset="0.55" stop-color="#d9b45c"/><stop offset="1" stop-color="#9b7632"/></linearGradient></defs><g class="pp-rot">'
  + [0, 90, 180, 270].map((a) => `<g transform="rotate(${a})"><path d="M-2 -6 C-8.5 -9.5 -9.5 -19 -4 -22.6 C1 -24.5 8.4 -22 9 -17.6 C7 -12 4 -8 2.2 -6 Z" class="pp-blade"/><path d="M-3.4 -9 C-6 -13 -5.8 -18 -3 -20.6" class="pp-edge"/></g>`).join('')
  + '</g><circle r="5.4" class="pp-hubring"/><circle r="3" class="pp-hub"/><circle r="1" class="pp-cap"/></svg>';
const propL = document.createElement('div'), propR = document.createElement('div'), domeHost = document.createElement('div');
propL.className = propR.className = 'hs-prop';
propL.innerHTML = propR.innerHTML = PROP_SVG;
domeHost.className = 'hs-domehost';
const barL = document.createElement('div'), barR = document.createElement('div');
barL.className = barR.className = 'hs-lvl'; // a sliding bar for each engine: five notches: dead slow, slow, half, full, flank (your throttle, not the speed)
barL.innerHTML = barR.innerHTML = '<i></i><i></i><i></i><i></i><i></i>';
shipEl.append(barL, propL, domeHost, propR, barR);
document.body.appendChild(shipEl);
const propRotL = propL.querySelector('.pp-rot'), propRotR = propR.querySelector('.pp-rot');
let propAng = 0;
function spinProps(dt) {
  const kn = sim.knots(sim.player);
  propAng = (propAng + kn * 0.18 * dt) % (Math.PI * 2); // 38 kn: about one turn a second
  const deg = (propAng * 180) / Math.PI;
  propRotL.style.transform = `rotate(${-deg}deg)`; propRotR.style.transform = `rotate(${deg}deg)`;
  const ord = sim.player.order;
  for (const bar of [barL, barR]) { // top notch first: the bar fills from the bottom with the throttle (slow astern lights the bottom one in blue)
    const n = bar.children.length;
    for (let q = 0; q < n; q++) { const lit = ord === 0 ? q === n - 1 : (n - 1 - q) < ord - 1; bar.children[q].className = lit ? (ord === 0 ? 'astern' : q === 0 ? 'top' : 'on') : ''; }
  }
  const fast = Math.min(1, Math.abs(kn) / 20);
  propL.style.setProperty('--blur', fast.toFixed(2)); propR.style.setProperty('--blur', fast.toFixed(2));
}
let lastShip = '';
const DOME_R = 94;
const DOME_K = 1.5;
const COMP_ABBR = { gun: '76', bridge: 'BRG', engine: 'ENG', guns: '30', steering: 'STR' };
function domeSvg() {
  const p = sim.player;
  const h = sim.headingDeg(p);
  const cx = 100, cy = 100;
  const pt = (r, a) => [(cx + r * Math.cos(a)).toFixed(1), (cy - r * Math.sin(a)).toFixed(1)];
  let ticks = '', labels = '';
  for (let d = Math.ceil((h - 58) / 5) * 5; d <= h + 58; d += 5) {
    const a = Math.PI / 2 - rad((d - h) * DOME_K);
    if (a < 0.05 || a > Math.PI - 0.05) continue;
    const major = d % 30 === 0;
    const [x1, y1] = pt(DOME_R, a), [x2, y2] = pt(DOME_R - (major ? 9 : d % 10 === 0 ? 6 : 3.5), a);
    ticks += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" class="${major ? 'mj' : ''}"/>`;
    if (major) { const [x, y] = pt(DOME_R - 21, a); labels += `<text x="${x}" y="${y}" class="dl">${String(((d % 360) + 360) % 360).padStart(3, '0')}</text>`; }
  }
  const RR = 60, span = rad(62);
  const th = clamp(p.rudder / RUDDER_MAX, -1, 1) * span;
  const p0 = pt(RR, Math.PI / 2), p1 = pt(RR, Math.PI / 2 - th), pl = pt(RR, Math.PI / 2 + span), pr = pt(RR, Math.PI / 2 - span);
  const fill = Math.abs(th) > 0.01 ? `<path d="M${p0[0]},${p0[1]} A${RR},${RR} 0 0 ${th > 0 ? 1 : 0} ${p1[0]},${p1[1]}" class="rf ${th > 0 ? 'stbd' : 'port'}"/>` : '';
  return `<svg viewBox="0 0 200 104" class="dome-svg" aria-hidden="true"><path d="M6,100 A${DOME_R},${DOME_R} 0 0 1 194,100" class="rim"/>${ticks}${labels}`
    + `<path d="M${cx - 4},${cy - DOME_R - 1} L${cx + 4},${cy - DOME_R - 1} L${cx},${cy - DOME_R + 6} Z" class="lub"/>`
    + `<text x="${cx}" y="79" class="hd">${String(Math.round(h) % 360).padStart(3, '0')}°</text>`
    + `<path d="M${pl[0]},${pl[1]} A${RR},${RR} 0 0 1 ${pr[0]},${pr[1]}" class="rt"/>${fill}`
    + `<line x1="${p0[0]}" y1="${(Number(p0[1]) - 5).toFixed(1)}" x2="${p0[0]}" y2="${(Number(p0[1]) + 5).toFixed(1)}" class="rm"/>`
    + `<text x="${cx}" y="94" class="sp">${sim.knots(p).toFixed(1)}<tspan> kn</tspan></text></svg>`;
}
function shipHtml() { // the strip is the dome alone (heading, rudder, speed), centred: the parts are on the board, the guns in the key bar and the sight
  return `<div class="hs-dome">${domeSvg()}</div>`;
}

// --- The status boards (radar view) ---------------------------------------------------------------------------------------------
// Two cards of horizontal bars, one for each part of a ship (no navigation data): yours down the left, with a FIX button on every part
// (each part is repaired alone) and one for all; the enemy you aim at down the right. A click on one of your bars sends a crew there.
let lastRange = '';
const boardEl = document.createElement('div');
boardEl.id = 'duel-board';
boardEl.className = 'duel-pts duel-pts-me';
document.body.appendChild(boardEl);
let lastBoard = '';
const healthColour = (f) => (f <= 0 ? '#ff5d61' : f < 0.5 ? '#ff7a1a' : f < 0.99 ? '#f2c94c' : '#3ddc84');
// How long a ship has if her flooding goes on, as text.
function floodText(p) {
  const left = p.flood > 0.02 && p.tSunk === null ? p.hp / p.flood : Infinity;
  return p.tSunk !== null ? 'SINKING' : Number.isFinite(left) ? `flooding: ${left > 600 ? '10+ min' : left > 90 ? `${Math.round(left / 60)} min` : `${Math.round(left)} s`} left` : 'watertight';
}
// Does her 76 mm bear on the other ship (working, in range, the other ship in her arc)?
function bears(s) {
  if (s.tSunk !== null || s.comp.gun <= 0) return 'OUT';
  if (sim.range() > MAIN_RANGE) return 'out of range';
  return Math.abs(sim.relBearing(s)) <= MAIN_ARC ? 'BEARS' : 'out of arc';
}
// One bar for each part of a ship: name, health bar, the number, fire / leak / crew marks, and (yours) the FIX button with its progress.
function partRows(s, mine, aim = null) {
  return COMP_IDS.map((id) => {
    const f = clamp(s.comp[id] / COMPARTMENTS[id].hp, 0, 1);
    const fix = s.fix[id];
    const crew = s.crews.filter((c) => c.to === id);
    const marks = `${s.fire[id] > 0 ? '<u class="fire">▲</u>' : ''}${s.leak[id] > 0.005 ? '<u class="leak">≈</u>' : ''}${crew.map((c) => `<u class="crew${c.eta > 0 ? ' going' : ''}">⛑</u>`).join('')}`;
    let btn = '';
    if (mine) {
      const busy = fix.left > 0, wait = fix.wait > 0;
      const label = busy ? `${fix.left.toFixed(1)}s` : wait ? `${Math.ceil(fix.wait)}s` : 'FIX';
      const prog = busy ? 1 - fix.left / REPAIR_TIME : wait ? 1 - fix.wait / REPAIR_WAIT : 1;
      btn = `<button type="button" class="bp-fix${busy ? ' busy' : ''}" data-fix="${id}"${busy || wait || s.tSunk !== null ? ' disabled' : ''} title="Repair the ${COMPARTMENTS[id].name.toLowerCase()} alone"><s style="width:${Math.round(prog * 100)}%"></s><span>${label}</span></button>`;
    }
    const cls = f <= 0 ? ' out' : f < 0.5 ? ' bad' : f < 0.99 ? ' hurt' : '';
    return `<div class="br${cls}${mine && COMP_IDS[selComp] === id ? ' sel' : ''}${aim === id ? ' aim' : ''}" data-comp="${mine ? id : ''}" title="${COMPARTMENTS[id].name}${mine ? ': click to send a crew' : ''}">`
      + `<span class="bn">${COMPARTMENTS[id].name}</span><i class="bb"><s style="width:${Math.round(f * 100)}%;background:${healthColour(f)}"></s></i><em>${f <= 0 ? 'OUT' : Math.round(f * 100)}</em><u class="bm">${marks}</u>${btn}</div>`;
  }).join('');
}
// Each part of a ship is one small round badge: its shape in the middle, a ring round it for its state (the arc is the health, in the
// health colour; an orange inner ring is a repair under way), small marks for fire, a leak and crews. The name and the figures show on hover.
const PART_ICON = { // 24 x 24 drawings, animated by CSS (duel.css, `.pi .bob` ...); still while the part is out
  hull: '<g class="bob"><path d="M2 15h20l-3.5 5h-13z"/><path d="M7.5 15v-3.5h7l2 3.5M11 11.5V6M9 8.5h4"/></g><path class="wv" d="M-2 22.5q2-1.4 4 0t4 0t4 0t4 0t4 0t4 0t4 0"/>',
  gun: '<path d="M4 20h11M6 20v-5a4 4 0 0 1 8 0v5"/><g class="recoil"><path d="M13.5 13.5H22"/><path d="M20.5 11.8v3.4"/></g>',
  bridge: '<path d="M3 20h18M5 20v-5l2.5-3.5h9L19 15v5M8.5 15h7"/><path d="M12 11.5V4M9 6.5h6"/><circle class="blink" cx="12" cy="3.4" r="1" style="fill:currentColor"/>',
  engine: '<path d="M3 20h18M5 20v-7h14v7z"/><g class="pis a"><path d="M8 13V8.5M6.2 8.5h3.6"/></g><g class="pis b"><path d="M12 13V8.5M10.2 8.5h3.6"/></g><g class="pis a"><path d="M16 13V8.5M14.2 8.5h3.6"/></g><path d="M8 16.5h8"/>',
  guns: '<path d="M3 20h8M7 20v-4.5M5 15.5h5"/><path class="gat" d="M10 9h12M10 12h12M10 15h12"/><path d="M8.5 7.5v9"/>',
  steering: '<path d="M12 2.5V12"/><circle cx="12" cy="3.8" r="1.3"/><g class="rud"><path d="M10 11.5h4l.9 9.2-2.9-1.7-2.9 1.7z"/></g><path d="M5 22c2.4-1.2 4-1.2 7 0s4.6 1.2 7 0" style="opacity:.6"/>',
};
const RING = 2 * Math.PI * 19;
function badge(id, f, { tip, cls = '', marks = '', rep = null, data = '' }) {
  const col = healthColour(f);
  return `<div class="pt${cls}"${data} aria-label="${tip}"><svg viewBox="0 0 44 44"><circle class="pr-bg" cx="22" cy="22" r="19"/>`
    + `<circle class="pr" cx="22" cy="22" r="19" style="stroke:${col};stroke-dasharray:${(f * RING).toFixed(1)} ${RING.toFixed(1)}"/>`
    + (rep === null ? '' : `<circle class="pr-rep" cx="22" cy="22" r="15" style="stroke-dasharray:${(clamp(rep, 0, 1) * 94.2).toFixed(1)} 94.2"/>`)
    + `<g class="pi" transform="translate(10 10)">${PART_ICON[id]}</g></svg><u class="pm">${marks}</u></div>`;
}
function partBadges(s, mine, aim = null) {
  return COMP_IDS.map((id) => {
    const f = clamp(s.comp[id] / COMPARTMENTS[id].hp, 0, 1);
    const fix = s.fix[id];
    const crew = s.crews.filter((c) => c.to === id);
    const marks = `${s.fire[id] > 0 ? '<i class="fire">▲</i>' : ''}${s.leak[id] > 0.005 ? '<i class="leak">≈</i>' : ''}${crew.length ? '<i class="crew">⛑</i>' : ''}`;
    const rep = mine && fix.left > 0 ? 1 - fix.left / REPAIR_TIME : null;
    const state = f <= 0 ? 'OUT' : `${Math.round(f * 100)}%`;
    const note = mine ? (fix.left > 0 ? ' · repairing' : fix.wait > 0 ? ` · can be repaired in ${Math.ceil(fix.wait)} s` : f < 1 ? ' · click to repair' : '') : '';
    const cls = (mine ? ' mine' : ' foe') + (f <= 0 ? ' out' : f < 0.5 ? ' bad' : f < 0.99 ? ' hurt' : '') + (mine && COMP_IDS[selComp] === id ? ' sel' : '') + (aim === id ? ' aim' : '');
    return badge(id, f, { tip: `${COMPARTMENTS[id].name} · ${state}${note}`, cls, marks, rep, data: mine ? ` data-fix="${id}"` : '' });
  }).join('');
}
// Is there anything of yours to repair (the repair-all button, in the support row)?
function repairReady() {
  const p = sim.player;
  return p.tSunk === null && COMP_IDS.some((id) => p.fix[id].left <= 0 && p.fix[id].wait <= 0 && (p.comp[id] < COMPARTMENTS[id].hp || p.fire[id] > 0 || p.leak[id] > 0.005));
}
function boardHtml() {
  const p = sim.player;
  const hullF = clamp(p.hp / HULL_HP, 0, 1);
  const any = COMP_IDS.some((id) => p.fix[id].left <= 0 && p.fix[id].wait <= 0 && (p.comp[id] < COMPARTMENTS[id].hp || p.fire[id] > 0 || p.leak[id] > 0.005));
  const hull = badge('hull', hullF, { tip: `Your hull · ${Math.round(p.hp)} · ${floodText(p)}`, cls: `${hullF < 0.35 ? ' bad' : hullF < 0.7 ? ' hurt' : ''} hull mine`, marks: p.flood > 0.02 ? '<i class="leak">≈</i>' : '' });
  return hull + partBadges(p, true);
}
boardEl.addEventListener('click', (e) => {
  const fx = e.target.closest?.('[data-fix]');
  if (fx && fx.dataset.fix) { sim.startRepair(0, fx.dataset.fix); lastBoard = ''; return; }
  const z = e.target.closest?.('[data-comp]');
  if (z && z.dataset.comp) { selComp = COMP_IDS.indexOf(z.dataset.comp); sim.assignCrew(0, z.dataset.comp); lastBoard = ''; }
});

// The enemy card (every view, top right): who she is, her hull, range and bearing, her five parts as tiles (the one your sight is on
// outlined), whether her 76 mm bears on you, her flooding, and what your sight is doing.
const targetEl = document.createElement('div');
targetEl.id = 'duel-target';
targetEl.className = 'duel-pts duel-pts-foe';
document.body.appendChild(targetEl);
let lastTarget = '';
// Under the map: the range and bearing of the enemy (and which of them, with several), or that the radar has no contact.
const rangeEl = document.createElement('div');
rangeEl.className = 'duel-range';
document.body.appendChild(rangeEl);
function rangeHtml() {
  const e = sim.enemy;
  if (!e) return '';
  if (e.det === false && e.tSunk === null) return '<div class="pt-pill dim" title="The radar does not have her. Close the range, or send up the helicopter (B).">NO CONTACT</div>';
  const foes = sim.ships.filter((o) => o.team === 1);
  const which = foes.length > 1 ? ` ${foes.indexOf(e) + 1}/${foes.length}` : '';
  return `<div class="pt-pill" title="Range and bearing of the enemy${which}">${kmText(sim.range())} · ${relName(sim.relBearing(sim.player))}${which}</div>`;
}
// Between the two columns of parts: the short name of each, so yours and the enemy's read across.
const namesEl = document.createElement('div');
namesEl.className = 'duel-pts duel-pts-names';
namesEl.innerHTML = [['hull', 'Hull'], ['gun', 'Gun'], ['bridge', 'Bridge'], ['engine', 'Engine'], ['guns', 'Aft'], ['steering', 'Rudder']].map(([id, n]) => `<span class="nm${id === 'hull' ? ' hull' : ''}">${n}</span>`).join('');
document.body.appendChild(namesEl);
function targetHtml() {
  const e = sim.enemy;
  if (!e) return '';
  if (e.det === false && e.tSunk === null) return '';
  const locked = sight.lock && sight.lock.ship === e.idx;
  const aim = view === 'radar' ? (locked ? sight.lock.comp : sight.snap) : null;
  const hullF = clamp(e.hp / HULL_HP, 0, 1);
  const b = bears(e);
  const hull = badge('hull', hullF, { tip: `Enemy hull · ${Math.round(e.hp)} · ${floodText(e)}`, cls: ' hull foe', marks: e.flood > 0.02 ? '<i class="leak">≈</i>' : '' });
  return hull + partBadges(e, false, aim)
    + (b === 'BEARS' ? '<div class="pt-pill hot" title="Her 76 mm bears on you">BEARS ON YOU</div>' : '');
}

const map = createDuelMap();
const drawMap = () => map.update(sim);

// --- Interface: the top bar, menu, keys sheet ---------------------------------------------------------------------------------
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
  const t = menuText('duel');
  document.querySelector('.brand b').textContent = t.brand;
  const sub = document.querySelector('#mission-sub');
  if (sub) sub.textContent = `${t.sub} · ${LEVELS[level].name}`;
}

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
setMap(mapOn);
mapButton.addEventListener('click', () => setMap(!mapOn));

const hudButton = document.querySelector('#btn-hud');
function setHud(on) {
  hudOn = on;
  root.hidden = !on;
  shipEl.hidden = !on;
  boardEl.hidden = !on;
  targetEl.hidden = !on;
  namesEl.hidden = !on;
  rangeEl.hidden = !on;
  hudButton.classList.toggle('active', on);
  hudButton.setAttribute('aria-pressed', String(on));
}
hudButton.addEventListener('click', () => setHud(!hudOn));
setHud(true);

const restartButton = document.createElement('button');
restartButton.id = 'btn-restart';
restartButton.setAttribute('role', 'menuitem');
restartButton.innerHTML = 'Fight again<kbd>R</kbd>';
menuEl.insertBefore(restartButton, menuEl.firstChild);
restartButton.addEventListener('click', () => restart());

const strip = document.createElement('div');
strip.className = 'duel-views';
const MOTION = !globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const VIEW_ICONS = { // drawn for what each view is: a chase camera, the wheelhouse wheel, a plan view, an orbit, the radar
  behind: '<path d="M8 14h13l-2.5 4H10z"/><path d="M12 14v-3h5l1.5 3"/><g class="lines"><path d="M2 12.5h3.5M1 15.5h4.5M3 18.5h3.5"/></g>',
  bridge: '<g class="wheel"><circle cx="12" cy="12" r="6.2"/><circle cx="12" cy="12" r="1.7"/><path d="M12 2.5v4M12 17.5v4M2.5 12h4M17.5 12h4M5.3 5.3l2.5 2.5M16.2 16.2l2.5 2.5M18.7 5.3l-2.5 2.5M7.8 16.2l-2.5 2.5"/></g>',
  above: '<path d="M12 2.5c3.2 3 4.3 7 4.3 11v5.7L14 22h-4l-2.3-2.8v-5.7c0-4 1.1-8 4.3-11z"/><path d="M12 8v10M9.7 13h4.6"/>',
  orbit: '<g transform="rotate(-25 12 12)"><ellipse cx="12" cy="12" rx="9.5" ry="4.6"/>' + (MOTION ? '<circle r="1.7" style="fill:currentColor"><animateMotion dur="3.2s" repeatCount="indefinite" path="M21.5 12a9.5 4.6 0 1 1 -19 0a9.5 4.6 0 1 1 19 0"/></circle>' : '<circle cx="21.5" cy="12" r="1.7" style="fill:currentColor"/>') + '</g><path d="M9.7 12.6h4.6l-.9 1.5h-2.8zM12 10.3v2.3"/>',
  radar: '<circle cx="12" cy="12" r="9.3"/><circle cx="12" cy="12" r="4.7"/><g class="sweep"><path d="M12 12L19 5.6"/><path class="beam" d="M12 12L19 5.6A9.3 9.3 0 0 1 21.3 12z"/></g><circle cx="8" cy="8.5" r="1" style="fill:currentColor"/>',
};
strip.innerHTML = VIEWS.map((v, i) => `<button type="button" data-view="${v}" title="${VIEW_NAMES[v]} (${i + 1})" aria-label="${VIEW_LABELS[i]}"><svg viewBox="0 0 24 24">${VIEW_ICONS[v]}</svg><span>${VIEW_LABELS[i]}</span></button>`).join('');
document.body.appendChild(strip);
viewButtons.push(...strip.querySelectorAll('button'));
viewButtons.forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
{ // the keys button: shows or hides the key bar (hidden at the start)
  const kb = document.createElement('button');
  kb.type = 'button';
  kb.className = 'duel-keys-btn';
  kb.title = 'Keys';
  kb.setAttribute('aria-label', 'Show the keys');
  kb.setAttribute('aria-pressed', 'false');
  kb.innerHTML = '<svg viewBox="0 0 24 24"><rect x="2.5" y="6" width="19" height="12" rx="2.5"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/></svg>';
  strip.appendChild(kb);
  kb.addEventListener('click', () => { const on = keysEl.classList.toggle('show'); kb.classList.toggle('active', on); kb.setAttribute('aria-pressed', String(on)); kb.blur(); });
}

keysSheet.querySelector('dl').innerHTML = [
  ['<kbd>←</kbd> <kbd>→</kbd>', 'Rudder to port / starboard while held; let go and it comes back amidships'],
  ['<kbd>↑</kbd> <kbd>↓</kbd>', 'Engine telegraph (thrust), one step: slow astern, stop, dead slow, slow, half, full, flank. Hulls that touch collide: damage by the closing speed, where they meet'],
  ['<kbd>F</kbd>', `Fire the 76 mm (hold): the gun trains on the enemy by itself within ${Math.round((MAIN_ARC * 180) / Math.PI)}° of the bow and ${kmText(MAIN_RANGE)}, and fires once it is on the aim and loaded`],
  ['<kbd>G</kbd>', `Fire the two 30 mm guns aft (hold): ${kmText(sim.gunRange)}, astern and abeam only; they answer by themselves when hers open fire`],
  ['<kbd>A</kbd>', 'The 30 mm guns on automatic'],
  ['<kbd>Z</kbd> <kbd>X</kbd>', `Z picks the next compartment, X sends a repair crew there (or calls it back): ${CREWS} crews, each puts out fire, slows flooding and mends one compartment`],
  ['<kbd>E</kbd>', `Repair the compartment Z has picked (or press FIX on its bar in the radar view): ${REPAIR_TIME} s, then its fire is out, its leak is stopped and it gets 40 % of its points back; that part can be repaired again after ${REPAIR_WAIT} s`],
  ['<kbd>W</kbd>', 'The wrench: repair every damaged part at once (or the wrench button in the bottom right)'],
  ['<kbd>K</kbd>', 'Call a friendly frigate (or the button at the bottom right): she comes in from astern at full speed and fights; up to three, one every few seconds'],
  ['<kbd>B</kbd>', 'The helicopter: it goes out over the enemy by itself at your first shot, circles her firing its gun and reports by radio (a part out, a fire, another ship joining). B sends it or calls it back. Its radar reaches 7.5 km and sees over the islands; it stays on deck in a very rough sea'],
  ['<kbd>M</kbd>', 'Fire the helicopter missile (two a sortie): at the compartment you have locked or focused in the radar view, else at her gun, then her engine: it takes half of that compartment. If your ship is lost the helicopter avenges her and lands on a friendly frigate'],
  ['<kbd>1</kbd> to <kbd>5</kbd>', 'Behind, bridge, above, orbit, radar'],
  ['<kbd>2</kbd>', 'The wheelhouse, as in Solo Air Defense: the wheel turns with the rudder, the telegraph levers follow the engine order, and a drag looks round (double click looks ahead)'],
  ['<kbd>5</kbd>', 'Radar view: the fire-control sight. Arrows, a drag or the on-screen pad aim it. hold <kbd>Shift</kbd> to zoom in and <kbd>Ctrl</kbd> to zoom out (the wheel, <kbd>+</kbd> <kbd>-</kbd> and the lens track work too) to close the lens until a compartment fills it (<kbd>0</kbd> resets); every enemy hull shows its compartments as marks, and a click lays the sight on one. F fires there: the shell goes to the point under the crosshair, so you choose what to break. Space locks the point under the crosshair (and lets the lock go); Enter fires like F. A merchant or a friendly ship in the sight is not fired on. The helm is locked until Esc'],
  ['<kbd>Tab</kbd>', 'Next enemy to fight (locked until she sinks). More enemy frigates arrive, a friendly frigate joins you, and merchant ships cross the fight: sinking one yourself loses the duel'],
  ['<kbd>V</kbd>', 'Next view · drag looks round in the orbit view, the wheel zooms'],
  ['<kbd>R</kbd>', 'Fight again'],
  ['<kbd>N</kbd>', 'Map'],
  ['<kbd>S</kbd>', 'Sound on / off'],
  ['<kbd>H</kbd> <kbd>C</kbd>', 'Readouts, hide the interface'],
].map(([k, d]) => `<dt>${k}</dt><dd>${d}</dd>`).join('');
keysSheet.querySelector('.keys-note').textContent = 'The 76 mm aims itself unless you take the radar view (7) · a shell takes seconds to arrive and turning spoils your aim';

const audio = createDuelAudio();
eventHooks.push((e) => audio.event(e));
cueSound = (kind, text) => audio.cue(kind, text);
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
soundButton.title = 'Sound: the guns, the hits, the sea and the engines (S)';
if (!audio.supported) { soundButton.disabled = true; soundButton.title = 'Sound is not available in this browser'; }
soundButton.addEventListener('click', () => setSound(!audio.enabled));

// The top bar is one gear: its menu holds everything the battle needs (the old row of buttons is hidden in duel.css).
{
  menuButton.innerHTML = '<svg><use href="#i-gear"/></svg>';
  menuButton.title = 'Settings';
  menuButton.setAttribute('aria-label', 'Settings');
  const tagsButton = document.createElement('button');
  tagsButton.id = 'btn-tags';
  const secMain = document.createElement('button'), secGat = document.createElement('button');
  secMain.id = 'btn-sec-main'; secGat.id = 'btn-sec-gat';
  const fsButton = document.querySelector('#btn-fullscreen');
  // A small vector drawing in front of each entry, for what it does (animated a little on hover or while it is on: duel.css `.mi`).
  const MI = {
    restart: '<path class="mi-a" d="M20 12a8 8 0 1 1-2.6-5.9M20 4v4.5h-4.5"/>',
    menu: '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>',
    readouts: '<rect x="3.5" y="4.5" width="17" height="12" rx="2"/><path d="M7 13l3-3.2 2.4 2 3.6-4.3M9 20h6M12 16.5V20"/>',
    map: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4"/><path class="mi-a" d="M12 12l5.5-5"/>',
    tags: '<path d="M3.5 12.2V4.5h7.7l9 9a1.6 1.6 0 0 1 0 2.2l-5 5a1.6 1.6 0 0 1-2.2 0z"/><circle cx="8" cy="9" r="1.3"/>',
    sec76: '<path d="M4 19h4M6 19V9"/><path d="M6 9l14-5.5v11z" style="fill:currentColor;fill-opacity:.2"/>',
    sec30: '<path d="M4 19h4M6 19V9"/><path d="M6 9l14-2.5M6 9l14 0M6 9l14 2.5"/>',
    sound: '<path d="M4 9.5h3.5L12 6v12l-4.5-3.5H4z"/><path class="mi-w1" d="M15.5 9.2a4 4 0 0 1 0 5.6"/><path class="mi-w2" d="M18.2 6.8a7.5 7.5 0 0 1 0 10.4"/>',
    full: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
    hide: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/><path class="mi-a" d="M4 4l16 16"/>',
    keys: '<rect x="2.5" y="6" width="19" height="12" rx="2.5"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7.5 14h9"/>',
  };
  const item = (b, label, key, ic) => { b.className = ''; b.setAttribute('role', 'menuitem'); b.innerHTML = `<span class="mi-l">${ic ? `<svg class="mi" viewBox="0 0 24 24" aria-hidden="true">${MI[ic]}</svg>` : ''}${label}</span>${key ? `<kbd>${key}</kbd>` : ''}`; return b; };
  const head = (t) => { const h = document.createElement('div'); h.className = 'menu-h'; h.textContent = t; return h; };
  const weatherBtn = document.querySelector('#btn-weather'), seaRow = document.querySelector('#sea-row');
  item(restartButton, 'Fight again', 'R', 'restart');
  item(document.querySelector('#btn-ship'), 'Main menu', '', 'menu');
  item(hudButton, 'Readouts', 'H', 'readouts');
  item(mapButton, 'Mini map', 'N', 'map');
  item(tagsButton, 'Ship tags', 'L', 'tags');
  item(secMain, 'Map: 76 mm sector', '', 'sec76'); item(secGat, 'Map: 30 mm sector', '', 'sec30');
  item(soundButton, 'Sound', 'S', 'sound');
  item(fsButton, 'Fullscreen', '', 'full');
  item(foldButton, 'Hide the interface', 'C', 'hide');
  item(document.querySelector('#btn-keys'), 'Keyboard shortcuts', '?', 'keys');
  menuEl.replaceChildren(head('Battle'), restartButton, document.querySelector('#btn-ship'), head('Display'), hudButton, mapButton, secMain, secGat, tagsButton, foldButton, fsButton,
    head('Sound'), soundButton, head('Sea'), ...[seaRow, weatherBtn].filter(Boolean), head('Help'), document.querySelector('#btn-keys'));
  [hudButton, mapButton, soundButton, tagsButton, secMain, secGat].forEach((b) => b.setAttribute('aria-pressed', 'true'));
  tagsButton.addEventListener('click', () => { tagsOn = !tagsOn; refreshGear(); });
  secMain.addEventListener('click', () => { map.setSector('main', !map.sector('main')); refreshGear(); });
  secGat.addEventListener('click', () => { map.setSector('gat', !map.sector('gat')); refreshGear(); });
  fsButton.addEventListener('click', () => { try { if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen(); } catch { /* not allowed here */ } });
  function refreshGear() {
    const set = (b, on) => { b.classList.toggle('active', on); b.setAttribute('aria-pressed', String(on)); };
    set(hudButton, hudOn); set(mapButton, mapOn); set(tagsButton, tagsOn); set(secMain, map.sector('main')); set(secGat, map.sector('gat')); set(soundButton, audio.enabled);
  }
  menuButton.addEventListener('click', refreshGear); // (tagsOn is declared further down: read it only once the menu opens)
}

const keysEl = document.createElement('div');
keysEl.id = 'fly-keys';
keysEl.className = 'fly-keys';
document.body.appendChild(keysEl);
// The key bar stays hidden until the keys button (next to the views) is pressed.
function flashKeys() { /* the key bar no longer pops up by itself: the keys button next to the views shows it */ }
const input = { left: 0, right: 0, fire: 0, gat: 0, aim: null };
// A click on an entry of the key help presses that key (a tap: down, then up); entries for keys that are held to steer or zoom stay plain.
const KEY_CLICK = { F: 'f', G: 'g', Tab: 'Tab', 'Z X': 'x', E: 'e', W: 'w', B: 'b', M: 'm', A: 'a', R: 'r', K: 'k', Esc: 'Escape', 'click · Space': ' ', 'F · Enter': 'f' };
const k = (key, label, on = false) => `<span class="fk${on ? ' on' : ''}${KEY_CLICK[key] ? ' fk-btn' : ''}"${KEY_CLICK[key] ? ` data-key="${KEY_CLICK[key]}" role="button" tabindex="-1"` : ''}><kbd>${key}</kbd>${label}</span>`;
keysEl.addEventListener('click', (e) => {
  const el = e.target.closest('[data-key]');
  if (!el) return;
  const key = el.dataset.key;
  window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  setTimeout(() => window.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true })), key === 'f' || key === 'g' ? 350 : 60);
});
function keysHtml() {
  if (view === 'radar') {
    return `${k('← → ↑ ↓', 'aim')}${k('Shift Ctrl', 'zoom')}${k('click · Space', 'lock a part', !!sight.lock)}${k('F · Enter', fireLatch ? 'firing: F stops' : 'fire (hold)', input.fire || fireLatch)}`
      + `${k('Tab', 'next target')}${k('B', sim.heliUp ? 'heli: land' : 'heli: go', sim.heliUp)}${k('M', 'heli missile')}${k('K', 'friend')}${k('Esc', 'helm')}`;
  }
  return `${k('← →', 'rudder', input.left || input.right)}${k('↑ ↓', `thrust ${TELEGRAPH[sim.player.order].name}`)}${k('F', 'fire 76 mm (hold)', input.fire)}${k('G', '30 mm (hold)', input.gat)}${k('Tab', 'target')}`
    + `${k('Z X', 'crews')}${k('E', 'repair', sim.player.fix[COMP_IDS[selComp]].left > 0)}${k('W', 'repair all')}${k('B', sim.heliUp ? 'heli: land' : 'heli: go', sim.heliUp)}${k('M', `heli missile ${sim.hop?.ammo ?? 0}`)}`
    + `${k('A', 'auto 30 mm', sim.player.auto)}${k('1–5', 'views')}${k('R', 'again')}`;
}
let lastKeys = '';

// --- Tags --------------------------------------------------------------------------------------------------------------------
const labels = new CSS2DRenderer();
labels.domElement.className = 'labels-layer duel-labels';
document.body.appendChild(labels.domElement);
// A tag over every other ship: ENEMY (the one your guns are on is marked), ALLY, MERCHANT.
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
function updateTag() {
  for (let i = 1; i < Math.max(sim.ships.length, tags.length); i++) {
    const s = sim.ships[i];
    if (!s) { if (tags[i]) tags[i].obj.visible = false; continue; }
    const t = tagFor(i);
    t.obj.visible = tagsOn && !!ships[i]?.group.visible && !(s.team === 1 && s.det === false && s.tSunk === null) && !landHidden[i];
    t.obj.position.set(s.x, 36, s.z);
    const foe = s.team === 1;
    const title = s.merchant ? 'MERCHANT' : foe ? (sim.player.target === i ? '▶ ENEMY' : 'ENEMY') : 'ALLY';
    const body = `${kmText(sim.distance(sim.player, s))} · ${relName(wrapAngle(Math.atan2(s.z - sim.player.z, s.x - sim.player.x) - sim.player.psi))}${s.merchant ? ' · hold fire' : ''}`;
    if (t.text !== title + body) {
      t.title.textContent = title;
      t.body.textContent = body;
      t.el.classList.toggle('tag-ally', s.team === 0);
      t.el.classList.toggle('tag-neutral', s.merchant);
      t.text = title + body;
    }
  }
}
const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));

// --- Keys --------------------------------------------------------------------------------------------------------------------
function restart() {
  sim.seed = (Date.now() % 100000) | 0;
  sim.reset();
  fx.clear();
  syncShips(); // the ones that arrived go back to the pool
  for (const v of ships) v.wake.clear();
  tracers.forEach((t) => { t.on = false; });
  banner.hidden = true;
  LOG.length = 0;
  endKill();
  nextEnemyPending = false;
  alarmEl.classList.remove('hit');
  if (view === 'radar') setView(viewBeforeRadar);
  input.aim = null;
  selComp = 0;
  setManual(false);
  if (fireLatch) setFireLatch(false);
  startIntro();
}
function startBanner() {
  say(`Enemy ${relName(sim.relBearing(sim.player))} · ${kmText(sim.range())}`, '', 5200);
}
window.addEventListener('keydown', (e) => {
  if (KILL.on && (e.key === 'Escape' || e.key === ' ' || e.key === 'Enter')) { endKill(); e.preventDefault(); return; } // skip the kill-cam
  if (INTRO.phase === 'show' && (e.key === 'Escape' || e.key === ' ' || e.key === 'Enter')) { endShow(); e.preventDefault(); return; } // skip the opening shots
  if (INTRO.phase === 'tour' && (e.key === 'Escape' || e.key === ' ' || e.key === 'Enter')) { toAsk(); e.preventDefault(); return; } // skip the tour
  if (INTRO.phase === 'ask' && (e.key === 'Enter' || e.key === 'Escape')) { if (e.key === 'Enter') engage(); else holdFire(); e.preventDefault(); return; }
  if (view === 'radar' && (e.key === 'Shift' || e.key === 'Control')) { radarKeys[e.key === 'Shift' ? 'zi' : 'zo'] = 1; return; } // Shift closes the lens, Ctrl opens it
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const tag = e.target?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;
  if (view === 'radar' && e.key.startsWith('Arrow')) { // the helm is locked: the arrows turn the sight
    const k = { ArrowLeft: 'l', ArrowRight: 'r', ArrowUp: 'u', ArrowDown: 'd' }[e.key];
    radarKeys[k] = 1;
    sight.manual = true;
    sight.lock = null;
    e.preventDefault();
    return;
  }
  if (view === 'radar' && e.key === 'Enter') { input.fire = 1; e.preventDefault(); return; } // Enter fires, like F
  if (view === 'radar' && (e.key === '+' || e.key === '=' || e.key === '-' || e.key === '_')) { // zoom the lens while held
    radarKeys[e.key === '-' || e.key === '_' ? 'zo' : 'zi'] = 1;
    e.preventDefault();
    return;
  }
  if (e.key === 'Tab') { // the next enemy to fight, locked until she sinks
    e.preventDefault();
    if (!e.repeat) pickNextTarget();
    return;
  }
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    input[e.key === 'ArrowLeft' ? 'left' : 'right'] = 1;
    e.preventDefault();
    return;
  }
  if (e.key === 'f' || e.key === 'F') { // F fires while held; with FIRE latched (a long press, in any view) a tap of F stops it
    if (fireLatch && !e.repeat) { setFireLatch(false); say('Ceasefire', '', 1400); } else input.fire = 1;
    e.preventDefault(); return;
  }
  if (e.key === 'g' || e.key === 'G') { input.gat = 1; e.preventDefault(); return; }
  if (e.repeat) { if (e.key.startsWith('Arrow')) e.preventDefault(); return; }
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  switch (key) {
    case 'ArrowUp': sim.telegraph(0, +1); break;
    case 'ArrowDown': sim.telegraph(0, -1); break;
    case 'a': sim.toggleAuto(0); break;
    case 'z': selComp = (selComp + 1) % COMP_IDS.length; break;
    case 'e': sim.startRepair(0, COMP_IDS[selComp]); break;
    case 'w': if (repairReady()) { sim.startRepair(0); lastBoard = ''; } break; // the wrench: repair everything damaged
    case 'b': say(sim.heliRequest(), ''); break;
    case 'k': callFriend(); break; // call a friendly frigate
    case 'm': heliMissile(); break; // fire the helicopter's missile // the helicopter: take off or land
    case 'x': sim.assignCrew(0, COMP_IDS[selComp]); break;
    case 'r': restart(); break;
    case 'v': setView(VIEWS[(VIEWS.indexOf(view) + 1) % VIEWS.length]); break;
    case '1': case '2': case '3': case '4': case '5': setView(VIEWS[Number(key) - 1]); break;
    case 'h': setHud(!hudOn); break;
    case 'n': setMap(!mapOn); break;
    case 'l': tagsOn = !tagsOn; break;
    case 'c': setFolded(!document.body.classList.contains('ui-hidden')); break;
    case '?': setKeys(keysSheet.hidden); break;
    case 'Escape': if (!closePopovers() && view === 'radar') setView(viewBeforeRadar); break;
    case 's': setSound(!audio.enabled); break;
    case ' ': if (view === 'radar') toggleLock(); break;
    case '0': if (view === 'radar') sightZoomGoal = SIGHT_ZOOM0; break;
    default: return;
  }
  if (key !== 'Escape') e.preventDefault();
});
window.addEventListener('keyup', (e) => {
  if (e.key === '+' || e.key === '=' || e.key === 'Shift') radarKeys.zi = 0;
  if (e.key === '-' || e.key === '_' || e.key === 'Control') radarKeys.zo = 0;
  if (e.key.startsWith('Arrow')) radarKeys[{ ArrowLeft: 'l', ArrowRight: 'r', ArrowUp: 'u', ArrowDown: 'd' }[e.key]] = 0;
  if (e.key === 'ArrowLeft') input.left = 0;
  if (e.key === 'ArrowRight') input.right = 0;
  if (e.key === 'f' || e.key === 'F' || e.key === 'Enter') input.fire = 0;
  if (e.key === 'g' || e.key === 'G') input.gat = 0;
});
window.addEventListener('blur', () => { radarKeys.zi = radarKeys.zo = 0; input.left = 0; input.right = 0; input.fire = 0; input.gat = 0; });

// --- The gun by hand: only through the radar view (below) ---------------------------------------------------------------------
// In the radar view the 76 mm goes where the sight points (input.aim); everywhere else the fire control has it.
function setManual(on) {
  if (!sim.setManual(0, on)) return;
  if (!on) input.aim = null;
}
function updateAim() {
  if (view === 'radar') radarAimShell();
  else input.aim = null;
}

// --- The radar view (the Solo Air Defense one) ----------------------------------------------------------------------------------
// The fire-control sight on the bridge roof: a mount that turns at a limited rate. In AUTO it swings onto the enemy you have targeted and holds
// her; the arrows, a drag or the pad turn it by hand (MANUAL) over any part of any ship. The lens zooms (wheel, + and -, the pad's buttons)
// until a compartment fills the view, and each enemy hull carries its compartments as marks you can click to lay the sight on. The shell is
// aimed at the hull point under the crosshair (the fire control leads that point), F or the Fire button shoots. A merchant or a friendly ship
// under the crosshair is not fired on. The helm is locked until you go back.
const SIGHT_RATE = THREE.MathUtils.degToRad(55);
const SIGHT_ZOOM0 = 1.5; // the lens multiplier you start at (smaller is closer)
// `lock` holds the sight on a point of a hull ({ ship, local }, in her frame) as she sails: a compartment you clicked, or the point under the
// crosshair when you press Enter. Aiming by hand, or Space, lets it go.
const sight = { aim: new THREE.Vector3(1, 0.03, 0), manual: false, fresh: true, omega: 0, dragYaw: 0, dragPitch: 0, zone: null, ship: null, warn: null, lock: null, hit: null, snap: null };
// Space and the Lock button: lock the point the sight is on, or let a lock go (the sight is automatic again).
function toggleLock() {
  if (sight.lock) { sight.manual = false; sight.lock = null; } else lockSight();
}
function lockSight() { // Enter: lock the compartment the sight has snapped to, or the one under the crosshair
  let ship = null, comp = null;
  if (sight.snap) { ship = sim.enemy.idx; comp = sight.snap; }
  else if (sight.hit) { ship = sight.hit.ship; comp = zoneAt(sight.hit.local.x); }
  if (comp === null) return;
  sight.lock = { ship, comp };
  sight.manual = false;
}
// A part of hers is out: a sight locked or snapped on it moves to the nearest part along her hull that still works (none left: it stays).
// Returns the part it moved to, or null.
function sightPastOut(ship, comp) {
  const s = sim.ships[ship];
  const onIt = (sight.lock && sight.lock.ship === ship && sight.lock.comp === comp) || (!sight.lock && ship === sim.enemy.idx && sight.snapId === comp);
  if (!s || !onIt) return null;
  let next = null, best = Infinity;
  for (const id of COMP_IDS) {
    if (id === comp || s.comp[id] <= 0) continue;
    const d = Math.abs(ZONE_POS[id][0] - ZONE_POS[comp][0]);
    if (d < best) { best = d; next = id; }
  }
  if (!next) return null;
  if (sight.lock) sight.lock = { ship, comp: next };
  else { sight.lock = { ship, comp: next }; sight.manual = false; } // snapped: lock the new part, so the snap does not slide back
  return next;
}
const radarKeys = { l: 0, r: 0, u: 0, d: 0, zi: 0, zo: 0 };
let sightZoom = SIGHT_ZOOM0;
let sightZoomGoal = SIGHT_ZOOM0;
const zoomSight = (f) => { sightZoomGoal = clamp(sightZoomGoal * f, 0.1, 8); };
const sightEl = document.createElement('div');
sightEl.className = 'duel-sight';
sightEl.hidden = true;
sightEl.innerHTML = '<svg class="hs-ret" viewBox="-110 -110 220 220" aria-hidden="true"><circle r="84"/><circle r="36" class="thin"/><path d="M0,-108V-90M0,90V108M-108,0H-90M90,0H108"/><path d="M-84,0H-14M14,0H84M0,-84V-14M0,14V84"/><path class="thin" d="M-60,-5V5M-48,-5V5M-36,-5V5M-24,-5V5M24,-5V5M36,-5V5M48,-5V5M60,-5V5M-5,-60H5M-5,-48H5M-5,-36H5M-5,-24H5"/><path d="M-10,30H10M-16,50H16M-10,66H10M-16,80H16"/><circle r="2.2" class="dot"/><circle r="7" class="thin"/></svg><b class="hs-txt"></b>';
document.body.appendChild(sightEl);
const sightTxt = sightEl.querySelector('.hs-txt');
const radarEl = document.createElement('div');
radarEl.className = 'duel-radar';
radarEl.hidden = true;
radarEl.innerHTML = '<div class="hr-marks"></div><div class="rc">'
  + '<div class="rc-main"><div class="rc-top"><b class="hr-mode">AUTO</b><span class="hr-brg"></span><b class="hr-zv"></b></div></div>'
  + '<div class="rc-gun"><div class="rc-dial"><svg class="rc-ring" viewBox="0 0 150 150" aria-label="Zoom"><circle class="rc-rtrack" r="70" cx="75" cy="75"/><circle class="rc-rfill" r="70" cx="75" cy="75"/><circle class="rc-hit" r="70" cx="75" cy="75"/><circle class="rc-rthumb" r="7"/></svg>'
  + '<button type="button" class="rc-fire" data-act="fire" title="Fire (hold F)"><span>FIRE</span></button>'
  + '<button type="button" class="rc-lock" data-act="lock" title="Lock the part under the sight, or let the lock go (Space)">LOCK</button></div></div></div>';
document.body.appendChild(radarEl);
const radarMode = radarEl.querySelector('.hr-mode');
const radarBrg = radarEl.querySelector('.hr-brg');
const radarZoom = radarEl.querySelector('.hr-zv');
const marksEl = radarEl.querySelector('.hr-marks');
const hitEl = radarEl.querySelector('.rc-hit');
const thumbEl = radarEl.querySelector('.rc-rthumb');
const fillEl = radarEl.querySelector('.rc-rfill');
const RING_ARC = 2 * Math.PI * 70 * 0.75; // the zoom ring runs 270 degrees, wide at the lower left round to close at the lower right
const fireEl = radarEl.querySelector('.rc-fire');
const lockBtn = radarEl.querySelector('.rc-lock');
let fireLatch = false; // a long press on FIRE keeps the gun firing until the button is tapped again
function setFireLatch(on) {
  fireLatch = on;
  fireEl.classList.toggle('latched', on);
  fireEl.querySelector('span').textContent = on ? 'FIRING' : 'FIRE';
  if (!on) input.fire = 0;
}
const ZOOM_SPAN = Math.log(80); // the zoom goal runs from 8 (wide) to 0.1 (close) along the track
const zoomFrac = () => 1 - Math.log(sightZoomGoal / 0.1) / ZOOM_SPAN;
const radarStick = { x: 0, y: 0 }; // (the on-screen aim stick was removed: always 0; arrows and a drag aim the sight)
// Drag on a control until the pointer lets go.
function dragOn(e, move) {
  const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up); move(null); };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
  move(e);
}
radarEl.addEventListener('pointerdown', (e) => {
  const mark = e.target.closest('.hr-mark');
  if (mark) { // a compartment on a hull: hold the sight on it
    e.preventDefault();
    const i = Number(mark.dataset.ship);
    if (!ships[i]) return;
    sight.lock = { ship: i, comp: mark.dataset.comp };
    sight.manual = false;
    return;
  }
  if (e.target.closest('.rc-hit')) { // the zoom ring: drag round it
    e.preventDefault();
    dragOn(e, (ev) => {
      if (!ev) return;
      const r = hitEl.getBoundingClientRect();
      let a = (Math.atan2(ev.clientY - (r.top + r.height / 2), ev.clientX - (r.left + r.width / 2)) * 180 / Math.PI - 135 + 720) % 360;
      if (a > 270) a = a > 315 ? 0 : 270; // the gap at the bottom snaps to the nearer end
      sightZoomGoal = clamp(0.1 * Math.exp((1 - a / 270) * ZOOM_SPAN), 0.1, 8);
    });
    return;
  }
  const b = e.target.closest('button');
  if (!b) return;
  e.preventDefault();
  const release = (fn) => { const up = () => { fn(); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up); }; window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up); };
  if (b.dataset.act === 'fire') {
    if (fireLatch) { setFireLatch(false); return; } // a tap while it is firing stops it
    input.fire = 1;
    const hold = setTimeout(() => { setFireLatch(true); say('Firing: tap to stop', 'warn', 2400); }, 500);
    release(() => { clearTimeout(hold); if (!fireLatch) input.fire = 0; });
  }
  else if (b.dataset.act === 'auto') { sight.manual = false; sight.lock = null; }
  else if (b.dataset.act === 'lock') toggleLock();
  else if (b.dataset.act === 'next') pickNextTarget();
  else if (b.dataset.act === 'back') setView(viewBeforeRadar);
});
function pickNextTarget() {
  sight.lock = null; // a lock is on one ship's hull: a new target lets it go
  const to = sim.cycleTarget(0);
  if (to) say(`Target ${relName(wrapAngle(Math.atan2(to.z - sim.player.z, to.x - sim.player.x) - sim.player.psi))} · ${kmText(sim.distance(sim.player, to))}`, '', 1800);
  return to;
}
// In the sailing views, a click on an enemy ship (or near her) asks whether to attack her: yes turns the target to her and opens the radar view.
const attackEl = document.createElement('div');
attackEl.className = 'duel-attack';
attackEl.hidden = true;
document.body.appendChild(attackEl);
let attackFor = -1, attackTimer = 0;
function closeAttack() { attackEl.hidden = true; attackFor = -1; clearTimeout(attackTimer); }
function askAttack(i, x, y) {
  const s = sim.ships[i];
  attackFor = i;
  attackEl.innerHTML = `<b>Attack this ship?</b><small>ENEMY · ${kmText(sim.distance(sim.player, s))} · hull ${Math.round(s.hp)}</small>`
    + '<div><button type="button" data-yes>Attack</button><button type="button" data-no>Not now</button></div>';
  attackEl.hidden = false;
  attackEl.style.left = `${clamp(x, 100, innerWidth - 100)}px`;
  attackEl.style.top = `${clamp(y - 20, 90, innerHeight - 140)}px`;
  clearTimeout(attackTimer);
  attackTimer = setTimeout(closeAttack, 8000);
}
attackEl.addEventListener('click', (e) => {
  if (e.target.closest('[data-yes]') && attackFor >= 0 && sim.setTarget(0, attackFor)) { closeAttack(); setView('radar'); return; }
  if (e.target.closest('button')) closeAttack();
});
attackReady = true;
const _pick = new THREE.Vector3();
let downAt = null;
canvas.addEventListener('pointerdown', (e) => { downAt = e.button === 0 ? { x: e.clientX, y: e.clientY } : null; });
canvas.addEventListener('pointerup', (e) => {
  const d = downAt; downAt = null;
  if (!d || view === 'radar' || sim.winner !== null || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 6) return;
  let best = -1, bestD = 70; // pixels: on her or near her
  for (const o of sim.ships) {
    if (o.team !== 1 || o.tSunk !== null || o.det === false || !ships[o.idx]?.group.visible) continue;
    _pick.set(o.x, 10, o.z).project(camera);
    if (_pick.z > 1) continue;
    const dist = Math.hypot((_pick.x * 0.5 + 0.5) * innerWidth - e.clientX, (-_pick.y * 0.5 + 0.5) * innerHeight - e.clientY);
    if (dist < bestD) { bestD = dist; best = o.idx; }
  }
  if (best >= 0) askAttack(best, e.clientX, e.clientY); else closeAttack();
});
let sightDrag = null;
canvas.addEventListener('pointerdown', (e) => { if (e.button === 0 && view === 'radar') sightDrag = { x: e.clientX, y: e.clientY }; });
window.addEventListener('pointerup', () => { sightDrag = null; });
window.addEventListener('pointermove', (e) => {
  if (!sightDrag || view !== 'radar') return;
  const dx = e.clientX - sightDrag.x, dy = e.clientY - sightDrag.y;
  sightDrag = { x: e.clientX, y: e.clientY };
  sight.manual = true;
  sight.lock = null;
  sight.dragYaw += dx * THREE.MathUtils.degToRad(camera.fov) / window.innerHeight;
  sight.dragPitch -= dy * THREE.MathUtils.degToRad(camera.fov) / window.innerHeight;
});
canvas.addEventListener('wheel', (e) => { if (view === 'radar') zoomSight(Math.exp(e.deltaY * 0.0012)); }, { passive: true });
canvas.addEventListener('dblclick', () => { camYaw = camPitch = 0; if (view === 'orbit') orbitOnBoth(); sightZoomGoal = SIGHT_ZOOM0; lookYaw = 0; lookPitch = -0.03; });
// On the bridge a drag looks round the wheelhouse (as in Solo Air Defense): drag left and it turns left.
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
// Behind and above: a drag swings the camera round the ship (and lifts or lowers it behind); it opens on the default angle again after a view change.
let swingDrag = null;
canvas.addEventListener('pointerdown', (e) => { if (e.button === 0 && (view === 'behind' || view === 'above')) swingDrag = { x: e.clientX, y: e.clientY }; });
window.addEventListener('pointerup', () => { swingDrag = null; });
window.addEventListener('pointermove', (e) => {
  if (!swingDrag || (view !== 'behind' && view !== 'above')) return;
  const dx = e.clientX - swingDrag.x, dy = e.clientY - swingDrag.y;
  swingDrag = { x: e.clientX, y: e.clientY };
  camYaw = wrapAngle(camYaw + dx * 0.006);
  if (view === 'behind') camPitch = clamp(camPitch + dy * 0.004, -0.12, 1.0);
});
const _w1 = new THREE.Vector3();
const _w2 = new THREE.Vector3();
const _sm = new THREE.Matrix4();
const hullBox = new THREE.Box3(new THREE.Vector3(-HALF_LENGTH, 0, -HALF_BEAM), new THREE.Vector3(HALF_LENGTH, 18, HALF_BEAM));
const sightRay = new THREE.Ray();
// The turning of the mount and the lens, every frame in the radar view.
function aimSight(dt) {
  const me = ships[0].group;
  me.localToWorld(camera.position.copy(BRIDGE_EYE));
  const foe = sim.enemy;
  _a.set(foe.x, 9, foe.z).sub(camera.position);
  const r = _a.length() || 1;
  _a.divideScalar(r); // the way to the enemy
  if (sight.fresh) { sight.aim.set(Math.cos(sim.player.psi), 0.03, Math.sin(sim.player.psi)).normalize(); sight.fresh = false; sight.omega = 0; }
  sightZoomGoal = clamp(sightZoomGoal * Math.exp((radarKeys.zo - radarKeys.zi) * dt * 1.3), 0.1, 8);
  sightZoom += (sightZoomGoal - sightZoom) * (1 - Math.exp(-dt / 0.1));
  const lens = clamp((Math.atan(80 / r) * 2 * 180) / Math.PI * sightZoom, 0.3, 30);
  sight.snap = null;
  if (sight.lock) { // held on its compartment as she sails
    const ls = sim.ships[sight.lock.ship], lg = ships[sight.lock.ship]?.group;
    if (!ls || !lg || ls.tSunk !== null || landHidden[sight.lock.ship]) sight.lock = null;
    else {
      lg.updateMatrixWorld(true);
      _a.copy(lg.localToWorld(_w1.set(...ZONE_POS[sight.lock.comp]))).sub(camera.position).normalize();
      if (sim.player.target !== sight.lock.ship) sim.setTarget(0, sight.lock.ship);
    }
  } else if (!sight.manual) { // automatic: while the marks are on screen the sight snaps to the nearest one, else it holds her middle
    const tg = sim.enemy, tgG = ships[tg.idx]?.group;
    if (tgG && tg.team === 1 && tg.tSunk === null && !landHidden[tg.idx] && (24 * window.innerHeight) / (2 * r * Math.tan(rad(lens / 2))) >= MARK_MIN) {
      tgG.updateMatrixWorld(true);
      let best = null, bestA = Infinity, keepA = Infinity;
      const live = COMP_IDS.filter((id) => tg.comp[id] > 0);
      for (const id of live.length ? live : COMP_IDS) {
        const ang = sight.aim.angleTo(_w2.copy(tgG.localToWorld(_w1.set(...ZONE_POS[id]))).sub(camera.position).normalize());
        if (ang < bestA) { bestA = ang; best = id; }
        if (id === sight.snapId) keepA = ang;
      }
      sight.snapId = keepA < 1.4 * bestA ? sight.snapId : best; // stay on the one it has until another is clearly nearer
      sight.snap = sight.snapId;
      _a.copy(tgG.localToWorld(_w1.set(...ZONE_POS[sight.snap]))).sub(camera.position).normalize();
    }
  }
  if (sight.manual && !sight.lock) {
    const rate = THREE.MathUtils.degToRad(50) * clamp(lens / 40, 0.004, 1);
    let yaw = Math.atan2(sight.aim.z, sight.aim.x) + (radarKeys.r - radarKeys.l + radarStick.x) * rate * dt + sight.dragYaw;
    const pitch = clamp(Math.asin(clamp(sight.aim.y, -1, 1)) + (radarKeys.u - radarKeys.d + radarStick.y) * rate * dt + sight.dragPitch, -0.25, 0.6);
    yaw = Math.atan2(Math.sin(yaw), Math.cos(yaw));
    sight.aim.set(Math.cos(pitch) * Math.cos(yaw), Math.sin(pitch), Math.cos(pitch) * Math.sin(yaw));
  } else {
    const e = sight.aim.angleTo(_a);
    sight.omega += (Math.min(SIGHT_RATE, e * 9) - sight.omega) * (1 - Math.exp(-dt / 0.12));
    if (e > 1e-5) sight.aim.lerp(_a, Math.min(sight.omega * dt, e) / e).normalize();
  }
  sight.dragYaw = 0;
  sight.dragPitch = 0;
  camera.lookAt(_b.copy(camera.position).add(sight.aim));
  setFov(lens);
}
// The shell goes where the crosshair is: the hull point the sight's ray meets on the nearest ship (the fire control leads it), else the sea
// beside the ship you are targeting. A hull that is not an enemy's (a merchant, a friend) is not fired on: the gun holds.
function radarAimShell() {
  const p = sim.player;
  sight.zone = null; sight.ship = null; sight.warn = null; sight.hit = null;
  if (p.tSunk !== null || sim.winner !== null) { input.aim = null; return; }
  if (landHidden[sim.enemy.idx]) { sight.warn = 'LAND IN THE WAY'; input.aim = null; return; } // she is behind an island: nothing to aim at
  if (sight.lock) { // locked: the shell goes to that compartment, led by her true velocity (a free shot is weak, see duel.js)
    const ls = sim.ships[sight.lock.ship], lg = ships[sight.lock.ship]?.group;
    if (ls && lg && ls.tSunk === null) {
      lg.updateMatrixWorld(true);
      const P = lg.localToWorld(_w1.set(...ZONE_POS[sight.lock.comp]));
      const v = sim.velOf(ls);
      const sol = sim.solve(p, MAIN_MOUNT, MUZZLE_V, true, {}, { p: [P.x, P.y, P.z], v: [v[0], 0, v[2]] });
      sight.zone = sight.lock.comp;
      sight.ship = sight.lock.ship;
      input.aim = { yaw: sol.yaw, pitch: sol.pitch, ship: sight.lock.ship, lock: sight.lock.comp };
      return;
    }
  }
  if (sight.snap && sim.enemy.tSunk === null && ships[sim.enemy.idx]) { // snapped to a compartment but not locked: it lands there, for less
    const ts = sim.enemy, tg = ships[ts.idx].group;
    tg.updateMatrixWorld(true);
    const P = tg.localToWorld(_w1.set(...ZONE_POS[sight.snap]));
    const e = sim.estOf(p, ts);
    const sol = sim.solve(p, MAIN_MOUNT, MUZZLE_V, true, {}, { p: [P.x, P.y, P.z], v: [e[0], 0, e[1]] });
    sight.zone = sight.snap;
    sight.ship = ts.idx;
    input.aim = { yaw: sol.yaw, pitch: sol.pitch, ship: ts.idx, focus: sight.snap };
    return;
  }
  ships[0].group.localToWorld(_c.copy(BRIDGE_EYE));
  sightRay.origin.copy(_c);
  sightRay.direction.copy(sight.aim);
  let best = -1, bestD = Infinity;
  const bestLocal = new THREE.Vector3();
  for (let i = 1; i < sim.ships.length; i++) {
    const s = sim.ships[i], g = ships[i]?.group;
    if (!g || !g.visible || (s.tSunk !== null && sim.t - s.tSunk > 6)) continue;
    g.updateMatrixWorld(true);
    const local = sightRay.clone().applyMatrix4(_sm.copy(g.matrixWorld).invert());
    if (!local.intersectBox(hullBox, _a)) continue;
    const d = local.origin.distanceTo(_a);
    if (d < bestD) { bestD = d; best = i; bestLocal.copy(_a); }
  }
  if (best >= 0) {
    const s = sim.ships[best];
    if (s.team === 1 && s.tSunk === null && !landHidden[best]) {
      const P = ships[best].group.localToWorld(bestLocal.clone());
      sight.zone = sight.snap && sim.enemy.idx === best ? sight.snap : zoneAt(bestLocal.x);
      sight.ship = best;
      sight.hit = { ship: best, local: bestLocal.clone() };
      if (sim.player.target !== best && sight.manual) sim.setTarget(0, best);
      const e = sim.estOf(p, s);
      const sol = sim.solve(p, MAIN_MOUNT, MUZZLE_V, true, {}, { p: [P.x, P.y, P.z], v: [e[0], 0, e[1]] });
      input.aim = { yaw: sol.yaw, pitch: sol.pitch, ship: best, free: true }; // neither locked nor focused: the shell falls in the sea
    } else {
      sight.warn = landHidden[best] ? 'LAND IN THE WAY' : s.tSunk !== null ? 'SINKING' : s.merchant ? 'MERCHANT: HOLD FIRE' : 'FRIENDLY: HOLD FIRE';
      input.aim = null;
    }
    return;
  }
  const tgt = sim.enemy;
  if (tgt.tSunk !== null) { input.aim = null; return; }
  const d = _b.set(tgt.x - _c.x, 0, tgt.z - _c.z); // off any hull: the point on the vertical plane through her, square to the line of sight
  const dist = d.length() || 1;
  const n = d.divideScalar(dist);
  const denom = sight.aim.dot(n);
  if (denom < 1e-4) { input.aim = null; return; }
  const tt = (new THREE.Vector3(tgt.x, 0, tgt.z).sub(_c).dot(n)) / denom;
  const P = _c.clone().addScaledVector(sight.aim, tt);
  P.y = Math.max(0, P.y);
  const e = sim.estOf(p, tgt);
  const sol = sim.solve(p, MAIN_MOUNT, MUZZLE_V, true, {}, { p: [P.x, P.y, P.z], v: [e[0], 0, e[1]] });
  input.aim = { yaw: sol.yaw, pitch: sol.pitch, ship: tgt.idx, free: true };
}
// The compartments of every enemy hull as marks on the screen: a dot each, with the name and its health once the lens is close enough to
// tell them apart. A click lays the sight on one.
const MARK_MIN = 7; // px between neighbouring compartments below which the marks are hidden (and the sight stops snapping to them)
const marks = new Map();
function markFor(key, i, id) {
  let m = marks.get(key);
  if (!m) {
    m = document.createElement('button');
    m.type = 'button';
    m.className = 'hr-mark';
    m.dataset.ship = String(i);
    m.dataset.comp = id;
    m.innerHTML = '<i></i><span></span>';
    marksEl.appendChild(m);
    marks.set(key, m);
  }
  return m;
}
function updateMarks() {
  const shown = new Set();
  if (view === 'radar') {
    const W = window.innerWidth, H = window.innerHeight;
    for (let i = 1; i < sim.ships.length; i++) {
      const s = sim.ships[i], g = ships[i]?.group;
      if (!g || s.team !== 1 || s.tSunk !== null || !g.visible || s.det === false || landHidden[i]) continue;
      const dist = Math.max(1, sim.distance(sim.player, s));
      const ppm = H / (2 * dist * Math.tan(rad(camera.fov / 2))); // pixels to a metre at her range
      const spacing = 24 * ppm; // between the two nearest compartments
      if (spacing < MARK_MIN) continue;
      for (const id of COMP_IDS) {
        g.localToWorld(_a.set(...ZONE_POS[id]));
        _a.project(camera);
        if (_a.z > 1 || Math.abs(_a.x) > 1.05 || Math.abs(_a.y) > 1.05) continue;
        const key = `${i}:${id}`;
        const m = markFor(key, i, id);
        shown.add(key);
        const f = s.comp[id] / COMPARTMENTS[id].hp;
        m.style.transform = `translate(${((_a.x * 0.5 + 0.5) * W).toFixed(1)}px, ${((-_a.y * 0.5 + 0.5) * H).toFixed(1)}px)`;
        m.hidden = false;
        const aimed = sight.ship === i && sight.zone === id;
        m.classList.toggle('aim', aimed);
        m.classList.toggle('out', f <= 0);
        m.classList.toggle('bad', f > 0 && f < 0.5);
        m.classList.toggle('hurt', f >= 0.5 && f < 0.99);
        const label = m.lastChild;
        const text = spacing >= 80 || aimed ? `${COMP_LABEL[id]} ${f <= 0 ? 'OUT' : `${Math.round(f * 100)}%`}` : '';
        if (label.textContent !== text) label.textContent = text;
      }
    }
  }
  for (const [key, m] of marks) if (!shown.has(key)) m.hidden = true;
}
const COMP_LABEL = { gun: '76 mm GUN', bridge: 'BRIDGE', engine: 'ENGINE', guns: '30 mm', steering: 'STEERING' };
function updateRadarUi() {
  updateMarks();
  if (view !== 'radar') return;
  radarMode.textContent = sight.lock ? 'LOCKED' : sight.manual ? 'MANUAL' : 'AUTO';
  radarMode.classList.toggle('manual', sight.manual && !sight.lock);
  radarMode.classList.toggle('locked', !!sight.lock);
  lockBtn.classList.toggle('on', !!sight.lock);
  lockBtn.textContent = sight.lock ? 'RELEASE' : 'LOCK';
  const yaw = Math.atan2(sight.aim.z, sight.aim.x);
  const rel = Math.atan2(Math.sin(yaw - sim.player.psi), Math.cos(yaw - sim.player.psi));
  radarBrg.textContent = `${relName(rel)} · elv ${Math.round(THREE.MathUtils.radToDeg(Math.asin(sight.aim.y)))}° · lens ${camera.fov.toFixed(camera.fov < 3 ? 2 : 1)}°`;
  radarZoom.textContent = `×${(30 / camera.fov).toFixed(camera.fov < 3 ? 0 : 1)}`;
  const zf = clamp(zoomFrac(), 0, 1) * 100;
  const ang = (135 + 2.7 * zf) * Math.PI / 180;
  thumbEl.setAttribute('cx', (75 + 70 * Math.cos(ang)).toFixed(1));
  thumbEl.setAttribute('cy', (75 + 70 * Math.sin(ang)).toFixed(1));
  fillEl.style.strokeDasharray = `${(RING_ARC * zf / 100).toFixed(1)} 440`;
  const gn = sim.player.gun;
  fireEl.style.setProperty('--rl', clamp(1 - gn.cool / sim.reloadTime(sim.player), 0, 1).toFixed(3));
  fireEl.classList.toggle('ready', gn.cool <= 0 && gn.onTarget && !sight.warn && !!sight.lock);
  fireEl.classList.toggle('weak', !sight.lock && !sight.warn);
  fireEl.classList.toggle('sea', !sight.lock && !sight.snap && !sight.warn);
  fireEl.classList.toggle('hold', !!sight.warn || sim.player.comp.gun <= 0 || gn.landBlocked);
  const g = sim.player.gun;
  const foes = sim.ships.filter((o) => o.team === 1);
  const which = foes.length > 1 ? ` ${foes.indexOf(sim.enemy) + 1}/${foes.length}` : '';
  sightEl.classList.toggle('lock', !!sight.zone);
  sightEl.classList.toggle('searching', !sight.zone);
  sightEl.classList.toggle('warn', !!sight.warn);
  const pct = (f) => Math.round(f * 100);
  const aim = sight.zone ? `${sight.lock ? `LOCK ${COMPARTMENTS[sight.zone].name.toUpperCase()} ${pct(LOCK_FRACTION)}%` : sight.snap ? `FOCUS ${COMPARTMENTS[sight.zone].name.toUpperCase()} ${pct(FOCUS_FRACTION)}% · Space` : 'NO AIM'}` : sight.warn ?? 'NO AIM';
  sightTxt.textContent = `${aim} · ${kmText(sim.range())}${which} · ${gunStatus(sim.player)}`;
  map.sight = { yaw, locked: !!sight.zone, fov: 2 * Math.atan(Math.tan(rad(camera.fov / 2)) * camera.aspect) }; // the lens's width on the map
}

// --- Loop --------------------------------------------------------------------------------------------------------------------
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
// Adaptive resolution: the sea and the shadows are fill-rate bound on integrated graphics, so the render scale follows the frame rate
// (down in steps of 0.1 to 0.75 when under 40 fps, back up toward the device cap when over 55). The interface and the look are untouched.
const PR_MAX = Math.min(window.devicePixelRatio, 1.5), PR_MIN = 0.75;
let prAcc = 0, prN = 0;
function adaptScale(dt) {
  if (dt <= 0.0001 || document.hidden) return;
  prAcc += dt; prN++;
  if (prAcc < 1.5) return;
  const avg = prAcc / prN;
  prAcc = 0; prN = 0;
  const pr = renderer.getPixelRatio();
  const next = avg > 1 / 40 ? Math.max(PR_MIN, pr - 0.1) : avg < 1 / 55 ? Math.min(PR_MAX, pr + 0.05) : pr;
  if (Math.abs(next - pr) > 0.001) { renderer.setPixelRatio(next); resize(); }
}
resize();
setView('behind');

// --- The opening: the radar spots her, a fly-out to the enemy, her weapons one by one, the question, the first shot ----------------------
// The battle does not start by itself. The radar sweeps (3 s) and finds an enemy ship; the camera leaves your ship and flies out to her,
// circles her, whipping fast from one weapon to the next and slowing on each while a callout says what it is, then rushes back behind your
// ship; then the question, big and red: engage? Yes opens the Radar view (the sight) on her and leaves the shot to you: aim, then F; hold fire
// goes back to the ship. Nothing fires by itself, and the first shot is always yours: nobody else fires before it (sim.held). Esc, Space or Enter skip the tour; on the question Enter engages and Esc holds fire.
// Each stop is a camera on a circle round her (in her frame: x to her bow, z to starboard; `ang` from her bow towards starboard), looking
// at a point of her hull; her model is the same frigate as yours, so the points are those of your own weapons.
const STOPS = [
  { ang: 0.4, r: 170, h: 34, look: [0, 8, 0], fov: 46, title: 'Hostile frigate', text: () => `${relName(sim.relBearing(sim.player))} · ${kmText(sim.range())} · ${Math.round(sim.knots(sim.enemy))} kn` },
  { ang: 0.62, r: 58, h: 13, look: [32, 7.5, 0], fov: 32, title: '76 mm bow gun', text: () => `Her main weapon: it reaches ${kmText(MAIN_RANGE)}. Knock it out and she cannot hurt you at range.` },
  { ang: 1.45, r: 48, h: 31, look: [9.2, 22.5, 0], fov: 36, title: 'Bridge and fire-control radar', text: () => 'She has seen you too. Hit the bridge and her shells scatter.' },
  { ang: 2.55, r: 56, h: 19, look: [-33.6, 13.8, 0], fov: 34, title: 'Two 30 mm guns aft', text: () => `Deadly inside ${kmText(sim.gunRange)}. Keep off her stern.` },
  { ang: 3.35, r: 72, h: 14, look: [-45, 5, 0], fov: 38, title: 'Engine and rudder', text: () => 'Her weak point: hit them and she can neither run nor turn.' },
];
const TOUR = { fly: 2.6, whip: 0.8, hold: 2.2, back: 1.5 };
const TOUR_LEN = TOUR.fly + STOPS.length * (TOUR.whip + TOUR.hold) + TOUR.back;
const INTRO = { phase: 'off', t: 0, seg: null, stop: -1, p0: new THREE.Vector3(), l0: new THREE.Vector3() }; // scan | tour | ask | off
const cineBars = document.createElement('div');
cineBars.className = 'duel-bars';
cineBars.innerHTML = '<i></i><i></i>';
document.body.appendChild(cineBars);
const introEl = document.createElement('div');
introEl.className = 'duel-hostile';
introEl.hidden = true;
document.body.appendChild(introEl);
const calloutEl = document.createElement('div'); // the weapon's name and what it does, pinned to it on screen
calloutEl.className = 'duel-callout';
calloutEl.hidden = true;
document.body.appendChild(calloutEl);
const showEl = document.createElement('div'); // the title over the opening shots of your own ship
showEl.className = 'duel-title';
showEl.hidden = true;
document.body.appendChild(showEl);
function startIntro(withShow = false) {
  INTRO.phase = 'scan'; INTRO.t = 0; INTRO.seg = null; INTRO.stop = -1;
  introEl.hidden = true; calloutEl.hidden = true; showEl.hidden = true;
  document.body.classList.remove('duel-cine');
  if (withShow) { // the beauty shots of your ship come first, the radar after
    INTRO.phase = 'show';
    document.body.classList.add('duel-cine');
    showEl.innerHTML = '<small>Task force · open sea</small><h2>Your frigate</h2><p>Frigate · 76 mm bow gun · two 30 mm aft · strike helicopter</p>';
    showEl.hidden = false;
    return;
  }
  say('Searching…', '', 3000);
}
function endShow() {
  showEl.hidden = true;
  INTRO.phase = 'scan'; INTRO.t = 0;
  document.body.classList.remove('duel-cine');
  say('Searching…', '', 3000);
}
function endIntro() {
  INTRO.phase = 'off';
  INTRO.again = false;
  introEl.hidden = true; calloutEl.hidden = true; showEl.hidden = true;
  document.body.classList.remove('duel-cine');
  input.fire = 0;
}
function toAsk(tag = 'Hostile contact') {
  const e = sim.enemy;
  calloutEl.hidden = true;
  document.body.classList.remove('duel-cine');
  if (!e || e.det === false || e.tSunk !== null) { endIntro(); say('No contact', 'warn', 3600); return; }
  INTRO.phase = 'ask';
  banner.hidden = true;
  introEl.innerHTML = `<div class="dz-stripe"></div><p class="dz-tag">⚠ ${tag}</p><h2>Enemy frigate</h2>`
    + `<p class="dz-data"><span>${relName(sim.relBearing(sim.player))}</span><span>${kmText(sim.range())}</span><span>hull ${Math.round(e.hp)}</span><span>${LEVELS[sim.level].name}</span></p>`
    + '<div class="dz-btns"><button type="button" data-go>Engage<small>Enter</small></button><button type="button" data-no>Hold fire<small>Esc</small></button></div><div class="dz-stripe"></div>';
  introEl.hidden = false;
}
function engage() {
  endIntro();
  setView('radar');
  say('Weapons free: aim, then F', 'warn', 4200);
}
function holdFire() {
  endIntro();
  say('Fire when ready: F', '', 3600);
}
introEl.addEventListener('click', (e) => {
  if (e.target.closest('[data-go]')) engage();
  else if (e.target.closest('[data-no]')) holdFire();
});
// Where the tour is at time t into it: { kind: 'fly' | 'stop' | 'back', i, u (0..1 through the move), held (s into the stop's hold) }.
function tourSeg(t) {
  if (t < TOUR.fly) return { kind: 'fly', i: 0, u: t / TOUR.fly, held: 0 };
  t -= TOUR.fly;
  const per = TOUR.whip + TOUR.hold;
  if (t < STOPS.length * per) { const i = Math.floor(t / per), w = t - i * per; return { kind: 'stop', i, u: Math.min(1, w / TOUR.whip), held: Math.max(0, w - TOUR.whip) }; }
  return { kind: 'back', i: STOPS.length - 1, u: Math.min(1, (t - STOPS.length * per) / TOUR.back), held: 0 };
}
function introStep(dt) {
  if (INTRO.phase === 'off') return;
  INTRO.t += dt;
  if (sim.shotFired && !INTRO.again && ['show', 'scan', 'tour', 'ask'].includes(INTRO.phase)) { endIntro(); return; } // you fired first yourself
  if (INTRO.phase === 'show') { if (INTRO.t >= SHOW_LEN) endShow(); return; }
  if (INTRO.phase === 'scan') {
    if (INTRO.t > 2.4 && !sim.radarOn) sim.startRadar();
    if (INTRO.t > CONTACT_AT && !document.body.classList.contains('duel-cine')) { // she is found: the bars come in, the reticle closes on her
      document.body.classList.add('duel-cine');
      say('Contact', 'bad', 1200, 'alarm');
    }
    if (INTRO.t > 3.4) {
      INTRO.phase = 'tour'; INTRO.t = 0; INTRO.stop = -1;
      INTRO.p0.copy(camera.position);
      camera.getWorldDirection(INTRO.l0).multiplyScalar(60).add(camera.position);
      document.body.classList.add('duel-cine');
      say('Hostile contact', 'bad', 2400);
    }
  } else if (INTRO.phase === 'tour') {
    if (INTRO.t >= TOUR_LEN) { toAsk(); return; }
    INTRO.seg = tourSeg(INTRO.t);
    const g = INTRO.seg;
    const show = g.kind === 'stop' && g.u > 0.7 ? g.i : -1; // the callout pops as the whip settles
    if (show !== INTRO.stop) {
      INTRO.stop = show;
      calloutEl.hidden = show < 0;
      if (show >= 0) {
        calloutEl.innerHTML = `<i></i><div><b>${STOPS[show].title}</b><small>${STOPS[show].text()}</small></div>`;
        calloutEl.classList.remove('pop'); void calloutEl.offsetWidth; calloutEl.classList.add('pop');
      }
    }
  }
}
const smooth01 = (u) => { const x = clamp(u, 0, 1); return x * x * (3 - 2 * x); };
const whipEase = (u) => 1 - Math.pow(1 - clamp(u, 0, 1), 4); // fast off the mark, slowing onto the weapon
const lerp = (a, b, u) => a + (b - a) * u;
const _tp = new THREE.Vector3(), _tl = new THREE.Vector3(), _tq = new THREE.Vector3();
// A stop's camera and look point in the world, blended from stop `a` to stop `b` by u, the circle drifting on by `drift` radians.
function stopPose(foe, a, b, u, drift, pos, look) {
  const A = STOPS[a], B = STOPS[b];
  const ang = lerp(A.ang, B.ang, u) + drift, r = lerp(A.r, B.r, u), h = lerp(A.h, B.h, u);
  foe.localToWorld(pos.set(Math.cos(ang) * r, h, Math.sin(ang) * r));
  foe.localToWorld(look.set(lerp(A.look[0], B.look[0], u), lerp(A.look[1], B.look[1], u), lerp(A.look[2], B.look[2], u)));
  return lerp(A.fov, B.fov, u);
}
function behindPose(pos, look) { // where the Behind view takes over
  const p = sim.player, hx = Math.cos(p.psi), hz = Math.sin(p.psi);
  pos.set(p.x - hx * 110, 34, p.z - hz * 110);
  look.set(p.x + hx * 45, 6, p.z + hz * 45);
}
// The opening shots of your own ship: a camera on a circle round her (in her frame: x to her bow, z to starboard), glided through the
// keyframes below with a Catmull-Rom curve (no stops between shots): low off the bow quarter, a slow broadside past the bridge, high over the
// stern, then behind her, where the Behind view takes over (the last key is `behindPose`).
const SHOW_LEN = 10;
const SHOW_KEYS = [ // t, ang, r, h, look x, look y, fov
  [0, 0.25, 135, 5, 30, 9, 40],
  [3.2, 1.1, 78, 8, 12, 12, 33],
  [6, 2.3, 96, 30, -8, 8, 38],
  [8.2, 2.9, 120, 44, 10, 6, 46],
  [SHOW_LEN, Math.PI, 110, 34, 45, 6, 55],
];
const _sk = new Array(6).fill(0);
function showPose(t) {
  const K = SHOW_KEYS;
  let i = 0;
  while (i < K.length - 2 && t > K[i + 1][0]) i++;
  const u = clamp((t - K[i][0]) / (K[i + 1][0] - K[i][0]), 0, 1), u2 = u * u, u3 = u2 * u;
  const p0 = K[Math.max(0, i - 1)], p1 = K[i], p2 = K[i + 1], p3 = K[Math.min(K.length - 1, i + 2)];
  for (let j = 0; j < 6; j++) {
    const a = p0[j + 1], b = p1[j + 1], c = p2[j + 1], d = p3[j + 1];
    _sk[j] = 0.5 * (2 * b + (-a + c) * u + (2 * a - 5 * b + 4 * c - d) * u2 + (-a + 3 * b - 3 * c + d) * u3);
  }
  return _sk;
}
// The cinematic camera, or false when the normal one is to run.
function introCamera() {
  if (INTRO.phase === 'show' && ships[0]) {
    const me = ships[0].group, k = showPose(INTRO.t);
    me.updateWorldMatrix(true, false);
    me.localToWorld(camera.position.set(Math.cos(k[0]) * k[1], k[2], Math.sin(k[0]) * k[1]));
    me.localToWorld(_b.set(k[3], k[4], 0));
    camera.position.y = Math.max(camera.position.y, 3.5); // never under the swell
    camera.lookAt(_b);
    setFov(k[5]);
    const t = INTRO.t;
    showEl.style.opacity = String(clamp(Math.min((t - 0.5) / 0.9, (6.4 - t) / 0.9), 0, 1));
    return true;
  }
  if (INTRO.phase !== 'tour' || !ships[0]) return false;
  {
    const foe = ships[sim.enemy.idx]?.group, g = INTRO.seg;
    if (!foe || !g) return false;
    let fov;
    if (g.kind === 'fly') { // out from your ship to her, low over the sea, banking, the lens widening with the speed
      const u = smooth01(g.u);
      const end = stopPose(foe, 0, 0, 0, 0, _tp, _tl);
      fov = lerp(55, end, u) + Math.sin(Math.PI * u) * 22;
      camera.position.lerpVectors(INTRO.p0, _tp, u);
      camera.position.y = lerp(INTRO.p0.y, _tp.y, u) * (1 - 0.55 * Math.sin(Math.PI * u)); // dips toward the sea mid-way
      _b.lerpVectors(INTRO.l0, _tl, smooth01(g.u * 1.6));
      camera.lookAt(_b);
      camera.rotateZ(Math.sin(Math.PI * u) * 0.22 + Math.sin(INTRO.t * 23) * 0.004 * Math.sin(Math.PI * u)); // bank, and a tremor at speed
      setFov(fov);
      return true;
    } else if (g.kind === 'stop') { // whip round her to the weapon, then a slow drift while the callout reads
      fov = stopPose(foe, Math.max(0, g.i - 1), g.i, whipEase(g.u), g.held * 0.035, camera.position, _b);
    } else { // back to your ship, fast and low
      stopPose(foe, g.i, g.i, 1, TOUR.hold * 0.035, _tp, _tl);
      behindPose(_tq, _a);
      const u = smooth01(g.u);
      camera.position.lerpVectors(_tp, _tq, u);
      camera.position.y += Math.sin(Math.PI * u) * 20;
      _b.lerpVectors(_tl, _a, smooth01(g.u * 1.4));
      fov = lerp(STOPS[g.i].fov, 55, u);
    }
    camera.lookAt(_b);
    setFov(fov);
    if (!calloutEl.hidden && g.kind === 'stop') { // pin the callout to the weapon
      camera.updateMatrixWorld();
      _tl.copy(_b).project(camera);
      calloutEl.style.left = `${clamp((_tl.x + 1) / 2 * innerWidth, 20, innerWidth - 20)}px`;
      calloutEl.style.top = `${clamp((1 - _tl.y) / 2 * innerHeight, 80, innerHeight - 80)}px`;
    }
    return true;
  }
}

// --- The hostile marks of the opening: a red ring with sonar pings on the sea round her, a target reticle, a red alert at the edges ------
// From the moment the radar has her (late in the scan) until the question is answered. The ring and pings are flat on the sea, drawn over
// the fog so they read from far off; the reticle is a screen element that closes in on her and locks (`.duel-lock`).
const hostileFx = (() => {
  const g = new THREE.Group();
  const mat = (o) => new THREE.MeshBasicMaterial({ color: 0xff2a33, transparent: true, opacity: o, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, side: THREE.DoubleSide });
  const ring = new THREE.Mesh(new THREE.RingGeometry(96, 104, 128), mat(0.9));
  const inner = new THREE.Mesh(new THREE.RingGeometry(78, 80, 128), mat(0.5));
  const ticks = new THREE.Group(); // four ticks across the ring, like a sight on the sea
  for (let k = 0; k < 4; k++) {
    const t = new THREE.Mesh(new THREE.PlaneGeometry(26, 3), mat(0.9));
    const a = (k * Math.PI) / 2;
    t.position.set(Math.cos(a) * 117, 0, Math.sin(a) * 117);
    t.rotation.set(-Math.PI / 2, 0, -a);
    ticks.add(t);
  }
  const pings = [0, 1, 2].map(() => new THREE.Mesh(new THREE.RingGeometry(98, 104, 96), mat(0.6)));
  for (const m of [ring, inner, ...pings]) m.rotation.x = -Math.PI / 2;
  g.add(ring, inner, ticks, ...pings);
  g.visible = false;
  g.renderOrder = 5;
  scene.add(g);
  return { g, ring, inner, ticks, pings };
})();
const lockEl = document.createElement('div');
lockEl.className = 'duel-lock';
lockEl.hidden = true;
lockEl.innerHTML = '<i></i><i></i><i></i><i></i><b>HOSTILE</b><small></small>';
document.body.appendChild(lockEl);
const lockLabel = lockEl.querySelector('small');
let hostileT = 0, lastLockTxt = '';
const CONTACT_AT = 2.6; // s into the scan: the radar has her
function updateHostileFx(dt) {
  const ph = INTRO.phase, e = sim.enemy;
  const on = !!e && e.tSunk === null && ((ph === 'scan' && INTRO.t > CONTACT_AT) || ph === 'tour' || ph === 'ask');
  hostileFx.g.visible = on;
  document.body.classList.toggle('duel-alert', on && ph !== 'ask');
  if (!on) { hostileT = 0; lockEl.hidden = true; return; }
  hostileT += dt;
  const fx = hostileFx;
  fx.g.position.set(e.x, 0.8, e.z);
  const grow = smooth01(hostileT / 0.6); // the ring snaps open when she is found
  fx.ring.scale.setScalar(0.4 + 0.6 * grow);
  fx.ring.material.opacity = 0.55 + 0.35 * Math.sin(hostileT * 6) ** 2;
  fx.inner.scale.setScalar(grow);
  fx.ticks.rotation.y = hostileT * 0.6;
  fx.ticks.scale.setScalar(grow);
  fx.pings.forEach((m, k) => { // sonar pings rolling outward, one every 0.6 s
    const u = ((hostileT + k * 0.6) % 1.8) / 1.8;
    m.scale.setScalar(1 + u * 2.6);
    m.material.opacity = 0.6 * (1 - u) * grow;
  });
  // The reticle: from the contact through the fly-out and the first look at her, then the callouts take over.
  const seg = INTRO.seg;
  const showLock = ph === 'scan' || (ph === 'tour' && seg && (seg.kind === 'fly' || (seg.kind === 'stop' && seg.i === 0)));
  if (!showLock) { lockEl.hidden = true; return; }
  _tq.set(e.x, 9, e.z).project(camera);
  if (_tq.z > 1) { lockEl.hidden = true; return; } // behind the camera
  const dist = camera.position.distanceTo(_c.set(e.x, 9, e.z));
  const shipPx = (130 / dist) * (innerHeight / 2) / Math.tan(rad(camera.fov / 2)); // about her length on screen
  const close = smooth01(hostileT / 0.9); // the brackets close in from wide, then hold on her
  const size = clamp(lerp(innerHeight * 0.7, Math.max(70, shipPx * 1.15), close), 70, innerHeight * 0.8);
  lockEl.hidden = false;
  lockEl.style.left = `${((_tq.x + 1) / 2) * innerWidth}px`;
  lockEl.style.top = `${((1 - _tq.y) / 2) * innerHeight}px`;
  lockEl.style.setProperty('--s', `${size.toFixed(0)}px`);
  lockEl.classList.toggle('locked', close >= 1);
  const txt = close >= 1 ? `LOCKED · ${kmText(sim.range())}` : 'ACQUIRING…';
  if (txt !== lastLockTxt) { lockLabel.textContent = txt; lastLockTxt = txt; }
}

// --- Calling friends: a button (and K); each call brings one friendly frigate in from astern at full speed, up to three -----------------
const actions = document.createElement('div');
actions.className = 'duel-actions';
document.body.appendChild(actions);
const repBtn = document.createElement('button');
repBtn.type = 'button';
repBtn.className = 'duel-friend duel-rep';
actions.appendChild(repBtn);
repBtn.addEventListener('click', () => { sim.startRepair(0); lastBoard = ''; repBtn.blur(); });
let lastRep = '';
function updateRepairBtn() {
  const on = repairReady();
  const key = String(on);
  if (key === lastRep) return;
  lastRep = key;
  repBtn.innerHTML = supportHtml(ICON_REPAIR, 'Repair all', on ? 'every damaged part' : 'nothing to repair', 'W');
  repBtn.disabled = !on;
}
const friendBtn = document.createElement('button');
friendBtn.type = 'button';
friendBtn.className = 'duel-friend';
actions.appendChild(friendBtn);
const heliBtn = document.createElement('button');
heliBtn.type = 'button';
heliBtn.className = 'duel-friend duel-heli';
actions.appendChild(heliBtn);
const missBtn = document.createElement('button');
missBtn.type = 'button';
missBtn.className = 'duel-friend duel-miss';
actions.appendChild(missBtn);
let lastHeliBtn = '';
function heliMissile() {
  const comp = sight.lock ? sight.lock.comp : sight.snap ?? null; // the part aimed at in the radar view
  const r = sim.heliMissile(view === 'radar' ? comp : null);
  say(r.ok ? (r.queued ? 'Heli: moving in' : `Heli: missile at ${COMPARTMENTS[r.comp].name.toLowerCase()}`) : r.why, r.ok ? 'warn' : 'warn', 2800);
}
heliBtn.addEventListener('click', () => { say(sim.heliRequest(), ''); heliBtn.blur(); });
missBtn.addEventListener('click', () => { heliMissile(); missBtn.blur(); });
// The support buttons' icons: vector drawings, animated by CSS in duel.css (`.sp-ico .sway`, `.rotor`, `.flame`, ...).
const ICON_ANCHOR = '<svg viewBox="0 0 32 32" aria-hidden="true"><path class="wave" d="M-9 29q3-2 6 0t6 0t6 0t6 0t6 0t6 0t6 0t6 0"/><g class="sway"><circle cx="16" cy="6.5" r="2.6"/><path d="M16 9.1V24M11 13h10M6.5 18.5C6.5 22.5 10.5 25 16 25s9.5-2.5 9.5-6.5M6.5 18.5l-2.6 2.4M6.5 18.5l3 1.6M25.5 18.5l2.6 2.4M25.5 18.5l-3 1.6"/></g></svg>';
const ICON_HELI = '<svg viewBox="0 0 32 32" aria-hidden="true"><g class="bob"><g class="rotor"><path d="M2 8.5h28"/></g><path d="M16 8.5v3"/><path class="fill" d="M6.5 18c0-3.6 3-6.5 7.5-6.5h5c3.4 0 5.5 2 5.5 4.6v1.9c0 1.4-1.3 2.5-2.9 2.5H10.5C8.2 20.5 6.5 19.7 6.5 18z"/><path class="win" d="M9.5 15.3c.8-1.5 2.4-2.3 4.6-2.3h1.4v4.3H9.2z"/><path d="M24.5 15.3l5.5-2.6v3.4l-5 2"/><circle class="trot" cx="30" cy="12.6" r="2.3"/><path d="M8 24.5h15M11 20.5v4M20 20.5v4"/></g></svg>';
const ICON_REPAIR = '<svg viewBox="0 0 32 32" aria-hidden="true"><g class="wrench"><path d="M20.6 6.6a6 6 0 0 0-7.4 7.6L5.4 22a2.7 2.7 0 0 0 3.8 3.8l7.8-7.8a6 6 0 0 0 7.6-7.4l-3.8 3.8-3.4-.9-.9-3.4z"/></g><circle cx="7.3" cy="23.9" r="0.9" style="fill:currentColor"/></svg>';
const ICON_MISS = '<svg viewBox="0 0 32 32" aria-hidden="true"><g transform="rotate(-45 16 16)"><path class="smoke s1" d="M3 16h0"/><circle class="puff p1" cx="4" cy="16" r="1.6"/><circle class="puff p2" cx="4" cy="16" r="1.6"/><path class="flame" d="M9 14.2L1.5 16 9 17.8z"/><path class="fill" d="M9 13.2h11.5L27 16l-6.5 2.8H9z"/><path d="M9 13.2L5.8 9.8h5.6l1.9 3.4M9 18.8l-3.2 3.4h5.6l1.9-3.4M16 13.2v5.6"/></g></svg>';
// One support button: an icon, a title and a status line, the key, and a bar that fills while it waits (`wait` 0..1, or null).
const supportHtml = (icon, title, sub, key, wait = null) => `<i class="sp-ico">${icon}</i><span class="sp-txt"><b>${title}</b><small>${sub}</small></span>${key ? `<kbd>${key}</kbd>` : ''}`
  + (wait === null ? '' : `<s class="sp-wait" style="width:${Math.round(clamp(wait, 0, 1) * 100)}%"></s>`);
function updateHeliButtons() {
  const h = sim.hop;
  const up = !!h && (h.phase === 'ingress' || h.phase === 'orbit');
  const title = !h ? '' : h.phase === 'deck' ? 'Send the helicopter' : up ? 'Helicopter: land' : 'Helicopter';
  const sub = !h ? '' : h.phase === 'deck' ? 'scouts and fires on her' : up ? (h.phase === 'orbit' ? 'over the enemy' : 'on its way') : h.phase === 'gone' || h.phase === 'landed' ? 'down' : h.phase;
  const ready = up && h.ammo > 0 && h.mCool <= 0;
  const msub = !h ? '' : !up ? 'send the helicopter first' : h.ammo <= 0 ? 'none left' : h.mCool > 0 ? `ready in ${Math.ceil(h.mCool)} s` : `${h.ammo > 9 ? '∞' : h.ammo} left · at the part you aim at`;
  const mwait = h && up && h.mCool > 0 ? 1 - h.mCool / 8 : null;
  const key = `${title}|${sub}|${msub}|${ready}|${mwait === null ? '' : mwait.toFixed(2)}`;
  if (key === lastHeliBtn) return;
  lastHeliBtn = key;
  heliBtn.innerHTML = supportHtml(ICON_HELI, title, sub, 'B'); heliBtn.hidden = !h;
  missBtn.innerHTML = supportHtml(ICON_MISS, 'Helicopter missile', msub, 'M', mwait); missBtn.hidden = !h; missBtn.disabled = !ready;
}
let lastFriend = '';
function callFriend() {
  const r = sim.callFriend();
  say(r.ok ? 'Frigate called' : r.why, r.ok ? 'ok' : 'warn', 2600);
}
friendBtn.addEventListener('click', () => { callFriend(); friendBtn.blur(); });
function updateFriendBtn() {
  const left = FRIEND_MAX - (sim.friendsCalled ?? 0), wait = Math.max(0, (sim.friendReady ?? 0) - sim.t);
  const sub = left <= 0 ? 'none left' : wait > 0 ? `next in ${Math.ceil(wait)} s` : `${left} of ${FRIEND_MAX} left · from astern`;
  if (sub === lastFriend) return;
  lastFriend = sub;
  friendBtn.innerHTML = supportHtml(ICON_ANCHOR, 'Call a friend', sub, 'K');
  friendBtn.disabled = left <= 0 || wait > 0;
}

startIntro(true); // the opening begins (everything it uses is defined above)
let last = performance.now();
let frames = 0;
renderer.setAnimationLoop((now) => {
  const dt = Math.max(0, Math.min((now - last) / 1000, 0.1));
  last = now;
  frameDt = dt;
  adaptScale(dt);
  syncShips();
  introStep(dt);
  nextEnemyStep();
  if (KILL.on && (KILL.t += dt) > KILL.dur) endKill();
  if (fireLatch) input.fire = 1;
  updateAim();
  sim.advance(dt, input);
  handleEvents();
  syncShips();
  env.ocean.material.uniforms.uTime.value = sim.t;
  for (let i = 0; i < ships.length; i++) poseShip(i, dt);
  updateWeapons(dt);
  updateStrikeHeli();
  updateLandHidden();
  updateCamera();
  fadeWeatherCards();
  setCamHint();
  updateHostileFx(dt);
  env.follow(camera.position);
  env.setShadowFocus(_b.set((sim.player.x + sim.enemy.x) / 2, 0, (sim.player.z + sim.enemy.z) / 2), clamp(sim.range() * 0.5, 120, 600));
  fx.update(sim.t);
  audio.update(sim, camera);
  if (hudOn) {
    updateHud();
    updateFriendBtn(); updateRepairBtn();
    updateHeliButtons();
    const sh = shipHtml();
    if (sh !== lastShip) { domeHost.innerHTML = sh; lastShip = sh; }
    spinProps(dt);
    const bh = boardHtml(); if (bh !== lastBoard) { boardEl.innerHTML = bh; lastBoard = bh; }
    const th = targetHtml(); if (th !== lastTarget) { targetEl.innerHTML = th; lastTarget = th; }
    const rh = rangeHtml(); if (rh !== lastRange) { rangeEl.innerHTML = rh; lastRange = rh; }
  }
  if (mapOn) drawMap();
  updateTag();
  updateRadarUi();
  const keys = keysHtml();
  if (keys !== lastKeys) { keysEl.innerHTML = keys; lastKeys = keys; }
  document.documentElement.style.setProperty('--keys-h', `${keysEl.offsetHeight}px`);
  if (!banner.hidden && performance.now() > bannerUntil) banner.hidden = true;
  renderer.render(scene, camera);
  labels.render(scene, camera);
  if (frames++ === 0) loadingEl?.remove();
});

window.__duel = { sim, camera, controls, scene, renderer, ships, setView, restart, fx, hooks: eventHooks, input, sight, intro: INTRO, log: LOG, kill: KILL };

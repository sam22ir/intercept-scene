import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { createEnvironment } from './environment.js';
import { createShip } from './models/ship.js';
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
  DuelSim, TELEGRAPH, COMPARTMENTS, COMP_IDS, HULL_HP, LEVELS, DUEL_LEVELS, MAIN_ARC, MAIN_RANGE, GUN_MOUNT_LOCAL, GUN_RANGE, sinkState,
  MAIN_MOUNT, MAIN_RELOAD, MUZZLE_V, zoneAt, AMMO_TYPES, SWITCH_TIME, CREWS,
} from './duel.js';
import { createDuelAudio } from './duelAudio.js';
import { createDuelMap } from './duelMap.js';
import './duel.css';

// Entry point of "Ship duel", mission id `duel` (see duel.js for the model): you sail a frigate against another and
// they fight with the 76 mm gun on the bow and the 30 mm guns aft until one sinks. Like Solo Air Defense nothing here
// is a function of a clock: the keys drive a real-time simulation and this file draws it. start.js imports it when
// that mission is picked, with the enemy's level in globalThis.__DUEL_LEVEL.
//
// Views (1 to 6, V cycles): behind the ship, the bridge (looking at the enemy), the gun sight (a long lens on her),
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

const env = createEnvironment(renderer, scene, { look: 'duel' });
env.setShadowSize(1024);
env.ocean.material.uniforms.uShipX.value = 1e7; // the shader's straight-line wake: these ships turn, each has her own
const fx = createLiveFx(scene);

const BRIDGE_EYE = new THREE.Vector3(16.9, 11.4, 0); // where the officer of the watch stands, in the ship's frame
const _a = new THREE.Vector3();
const _vel = new THREE.Vector3();
wireWeather({ look: env.look });
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _q = new THREE.Quaternion();
const rad = THREE.MathUtils.degToRad;
const clamp = THREE.MathUtils.clamp;

let level = 'normal';
try { level = globalThis.__DUEL_LEVEL ?? new URLSearchParams(location.search).get('level') ?? 'normal'; } catch { /* no address */ }
if (!DUEL_LEVELS.includes(level)) level = 'normal';
const sim = new DuelSim({ seed: (Date.now() % 100000) | 0, level });

// --- The two ships --------------------------------------------------------------------------------------------------
// Both with the deck crew left out (it stands in the gun's way). The enemy has her own ensign and a bluer hull.
const ships = [createShip({ crew: false }), createShip({ ensign: 'rus', crew: false })].map((m, i) => {
  m.group.rotation.order = 'YXZ'; // heading, then heel, then trim
  scene.add(m.group);
  const gats = GUN_MOUNT_LOCAL.map(([x, y, z]) => {
    const g = createGatling();
    g.group.position.set(x, y - 1.3, z); // the mount's pivot is the gun's centre; its base stands on the roof
    m.group.add(g.group);
    return g;
  });
  return { ...m, gats, wake: createWake(scene), plume: new ShipPlume(fx), smokeT: 0, flash: 0 };
});

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
const shellVis = streaks(48, 3.2, 0xffd9a0, 22); // the 76 mm shells: a bright streak with a glowing head
const tracerVis = streaks(260, 1.1, 0xff6a1f, 34); // the 30 mm tracers
const tracers = Array.from({ length: 260 }, () => ({ on: false, p: new THREE.Vector3(), v: new THREE.Vector3(), t0: 0 }));
let tracerNext = 0;
const flashSprites = ships.map(() => {
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, blending: THREE.AdditiveBlending, depthWrite: false }));
  sp.scale.setScalar(11);
  sp.visible = false;
  scene.add(sp);
  return sp;
});

// --- The sea picture: each ship's pose from the simulation -------------------------------------------------------------
const ZONE_X = { gun: 32, bridge: 14, engine: -9, guns: -33, steering: -50 }; // where each compartment's fire burns
function poseShip(i, dt) {
  const s = sim.ships[i];
  const v = ships[i];
  const sink = s.tSunk !== null ? sinkState(sim.t - s.tSunk, s.listSide) : null;
  const list = s.listSide * rad(9) * (1 - s.hp / HULL_HP) ** 2; // the hurt ship settles to the side she was hit on
  v.group.visible = !sink?.gone;
  v.group.position.set(s.x, sink ? sink.depth : 0, s.z);
  v.group.rotation.set(s.heel + list + (sink?.roll ?? 0), -s.psi, sink?.trim ?? 0);
  v.group.updateMatrixWorld(true);
  v.mainGun.pose(s.gun.yaw, s.gun.pitch);
  v.gats.forEach((g, k) => g.pose(s.gats[k].yaw, s.gats[k].pitch, s.gats[k].spin, s.gats[k].firing, sim.t));
  v.update(sim.t, Infinity, Infinity, { aim: { yaw: Math.PI, pitch: 0 }, cradleT: 0 }); // the radar turns; the launcher box stays stowed
  v.wake.update({ t: sim.t, x: s.x, z: s.z, psi: s.psi, r: s.r, u: s.u });
  if (!sink?.gone && s.tSunk === null) { // the funnel's haze and the bow's spray, while she is afloat
    _vel.x = Math.cos(s.psi) * s.u;
    _vel.z = Math.sin(s.psi) * s.u;
    v.plume.update(sim.t, v.group, _vel, env.look?.sea.state ?? 1);
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
  if (v.flash > 0) { v.flash -= dt; flashSprites[i].visible = v.flash > 0; }
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
      v.gunClock = (v.gunClock ?? [0, 0]);
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
function say(text, tone = '', ms = 3200) {
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
let lastShell = null; // the player's latest shell, for the gun camera
let shellHold = 0;
const eventHooks = []; // the audio listens here
function handleEvents() {
  for (const e of sim.takeEvents()) {
    for (const h of eventHooks) h(e);
    if (e.type === 'shot') {
      const v = ships[e.owner];
      v.mainGun.muzzle.getWorldPosition(_c);
      flashSprites[e.owner].position.copy(_c);
      flashSprites[e.owner].visible = true;
      v.flash = 0.09;
      for (let k = 0; k < 7; k++) fx.gunSmoke(_c, _b.set(e.dir[0] * 9, e.dir[1] * 9, e.dir[2] * 9), sim.t);
      if (e.owner === 0) { lastShell = sim.shells[sim.shells.length - 1]?.id ?? null; shellHold = 0; }
    } else if (e.type === 'hit') {
      fx.shellBurst(_c.set(...e.pos), sim.t);
      if (e.ship === 0) {
        alarmEl.classList.remove('hit'); void alarmEl.offsetWidth; alarmEl.classList.add('hit');
        say(`Hit: ${COMPARTMENTS[e.comp].name}${e.out ? ' out' : ''}`, 'bad', 2200);
      } else say(`Hit on her ${COMPARTMENTS[e.comp].name.toLowerCase()}${e.out ? ': out' : ''}`, 'ok', 2200);
    } else if (e.type === 'gunhit') {
      if (e.ship === 0) { alarmEl.classList.remove('hit'); void alarmEl.offsetWidth; alarmEl.classList.add('hit'); }
    } else if (e.type === 'splash') {
      fx.splashAt(_c.set(e.pos[0], 0, e.pos[2]), sim.t, 1.5);
      if (e.miss < 60) say(e.owner === 0 ? 'Near miss' : 'Their shell falls close', e.owner === 0 ? '' : 'warn', 1400);
    } else if (e.type === 'out') {
      say(`${who(e.ship)} ${COMPARTMENTS[e.comp].name.toLowerCase()} is out`, e.ship === 0 ? 'bad' : 'ok', 3000);
    } else if (e.type === 'sunk') {
      for (let k = 0; k < 3; k++) fx.explosion(_c.set(e.pos[0] + (k - 1) * 14, e.pos[1], e.pos[2]), sim.t + k * 0.35);
    } else if (e.type === 'ammo') {
      if (e.ship === 0) say(`${AMMO_TYPES[e.kind].name} loaded`, '', 1400);
    } else if (e.type === 'fire') {
      if (e.ship === 0) say(`Fire in the ${COMPARTMENTS[e.comp].name.toLowerCase()}: send a crew`, 'warn', 2400);
    } else if (e.type === 'over') {
      say(e.winner === 0 ? 'The enemy frigate is going down: you win' : 'Your ship is sinking: you lose', e.winner === 0 ? 'ok' : 'bad', 60000);
    }
  }
}

// --- Views --------------------------------------------------------------------------------------------------------------
const VIEWS = ['behind', 'bridge', 'sight', 'above', 'shell', 'orbit', 'radar'];
const VIEW_LABELS = ['Behind', 'Bridge', 'Sight', 'Above', 'Shell', 'Orbit', 'Radar'];
const VIEW_NAMES = { behind: 'Behind the ship', bridge: 'The bridge', sight: 'The gun sight', above: 'Straight above', shell: 'Riding your shell', orbit: 'Free orbit', radar: 'Radar (the fire-control sight: aim it at any part of her hull; the helm is locked)' };
let view = 'behind';
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
  if (v === 'radar' && view !== 'radar') {
    viewBeforeRadar = view;
    radarPrevManual = sim.player.manual;
    input.left = input.right = 0;
    setManual(true);
    say('Radar: arrows, drag or the pad aim the sight, F fires. The helm is locked: Esc goes back', 'warn', 4200);
  } else if (v !== 'radar' && view === 'radar') {
    input.fire = 0;
    setManual(radarPrevManual);
  }
  view = v;
  radarKeys.l = radarKeys.r = radarKeys.u = radarKeys.d = 0;
  sight.manual = false; // the radar's own controls start on automatic every time
  sight.fresh = true;
  radarEl.hidden = v !== 'radar';
  sightEl.hidden = v !== 'radar';
  document.body.classList.toggle('duel-radarview', v === 'radar');
  map.sight = null;
  controls.enabled = v === 'orbit';
  if (v === 'orbit') rig.focus('ship', (out) => out.set(sim.player.x, 8, sim.player.z), 230, 25);
  else rig.free();
  camera.up.set(0, 1, 0);
  viewButtons.forEach((b) => { const on = b.dataset.view === v; b.classList.toggle('active', on); b.setAttribute('aria-pressed', String(on)); });
}
const enemyPoint = (out) => out.set(sim.enemy.x, 9, sim.enemy.z);
let frameDt = 1 / 60;
function updateCamera() {
  const me = ships[0].group;
  const foe = sim.enemy;
  if (view === 'orbit') { setFov(50); rig.update(); controls.update(); return; }
  if (view === 'behind') {
    setFov(55);
    camera.position.copy(me.localToWorld(_a.set(-110, 34, 0)));
    camera.lookAt(me.localToWorld(_b.set(45, 6, 0)));
  } else if (view === 'bridge' || view === 'sight') {
    me.localToWorld(camera.position.copy(BRIDGE_EYE));
    const inView = Math.abs(sim.relBearing(sim.player)) < rad(110);
    if (inView) camera.lookAt(enemyPoint(_b)); else camera.lookAt(me.localToWorld(_b.set(100, 10, 0)));
    const r = sim.range();
    setFov(view === 'sight' ? clamp((Math.atan(70 / r) * 2 * 180) / Math.PI * 2.4, 3.5, 30) : 55);
  } else if (view === 'radar') {
    aimSight(frameDt);
  } else if (view === 'above') {
    setFov(50);
    const mx = (sim.player.x + foe.x) / 2, mz = (sim.player.z + foe.z) / 2;
    const h = Math.max(380, sim.range() * 1.05);
    camera.up.set(Math.cos(sim.player.psi), 0, Math.sin(sim.player.psi));
    camera.position.set(mx, h, mz);
    camera.lookAt(mx, 0, mz);
  } else { // shell: ride the player's last shell, then hold where it landed; with none, a chase view
    setFov(55);
    const sh = sim.shells.find((x) => x.id === lastShell);
    if (sh) {
      shellHold = 1.6;
      _b.set(sh.v[0], sh.v[1], sh.v[2]).normalize();
      camera.position.set(sh.p[0] - _b.x * 26, sh.p[1] - _b.y * 26 + 5, sh.p[2] - _b.z * 26);
      camera.lookAt(sh.p[0] + _b.x * 60, sh.p[1] + _b.y * 60, sh.p[2] + _b.z * 60);
    } else if (shellHold > 0) { shellHold -= 1 / 60; } else {
      camera.position.copy(me.localToWorld(_a.set(-110, 34, 0)));
      camera.lookAt(me.localToWorld(_b.set(45, 6, 0)));
    }
  }
}

// --- Readouts -------------------------------------------------------------------------------------------------------------
const root = document.querySelector('#hud');
root.classList.add('duel-root');
root.innerHTML = '<div class="duel-hud"></div>';
const hud = root.querySelector('.duel-hud');
const bar = (frac, cls = '') => `<i class="${cls}" style="width:${Math.round(clamp(frac, 0, 1) * 100)}%"></i>`;
let selComp = 0; // the compartment Z has picked for X to send a crew to
function cardHtml(i) {
  const s = sim.ships[i];
  const comps = COMP_IDS.map((id) => {
    const f = s.comp[id] / COMPARTMENTS[id].hp;
    const crew = s.crews.filter((c) => c.to === id);
    const tags = `${s.fire[id] > 0 ? `<u class="fire" title="fire">${'▲'.repeat(Math.ceil(s.fire[id] * 3))}</u>` : ''}${s.leak[id] > 0.005 ? '<u class="leak" title="flooding">≈</u>' : ''}${crew.map((c) => `<u class="crew${c.eta > 0 ? ' going' : ''}" title="repair crew">⛑</u>`).join('')}`;
    return `<div class="dh-row ${f <= 0 ? 'out' : f < 0.5 ? 'bad' : f < 0.99 ? 'hurt' : ''}${i === 0 && COMP_IDS[selComp] === id ? ' sel' : ''}"><span>${COMPARTMENTS[id].name}</span><b>${bar(f)}</b><em>${f <= 0 ? 'OUT' : `${Math.round(f * 100)}`}</em>${tags ? `<div class="dh-tags">${tags}</div>` : ''}</div>`;
  }).join('');
  const hp = s.hp / HULL_HP;
  return `<section class="dh-ship ${i ? 'foe' : 'you'}${s.tSunk !== null ? ' sunk' : ''}"><h3>${i ? 'ENEMY' : 'YOUR SHIP'}<small>${i ? LEVELS[sim.level].name : ''}${s.tSunk !== null ? 'SINKING' : ''}</small></h3>`
    + `<div class="dh-row hull"><span>Hull</span><b>${bar(hp, hp < 0.3 ? 'bad' : '')}</b><em>${Math.round(s.hp)}</em></div>${comps}</section>`;
}
function gunStatus(s) {
  const g = s.gun;
  if (s.tSunk !== null) return '';
  if (s.comp.gun <= 0) return 'OUT';
  if (g.ammo <= 0) return 'NO AMMUNITION';
  const sol = Math.abs(sim.relBearing(s));
  if (sim.range() > MAIN_RANGE) return `OUT OF RANGE (${kmText(MAIN_RANGE)})`;
  if (sol > MAIN_ARC) return 'OUT OF ARC: turn her';
  if (g.cool > 0) return `LOADING ${g.cool.toFixed(1)} s`;
  if (s.manual) return g.engaged ? (g.onTarget ? 'ON YOUR AIM' : 'TRAINING') : 'point at her';
  return g.onTarget ? 'ON TARGET' : 'TRAINING';
}
function rangeHtml() {
  return `<div class="dh-range"><span>ENEMY</span><b>${kmText(sim.range())}</b><small>${relName(sim.relBearing(sim.player))}</small></div>`;
}
function endHtml() {
  if (sim.winner === null) return '';
  const w = sim.winner === 0;
  const st = sim.player.stats, es = sim.enemy.stats;
  return `<section class="dh-end ${w ? 'won' : 'lost'}"><h2>${w ? 'You win' : 'You lose'}</h2>`
    + `<p>${Math.round(sim.t)} s · your 76 mm: ${st.hits} of ${st.shells} hit · hers: ${es.hits} of ${es.shells}</p><p><kbd>R</kbd> to fight again</p></section>`;
}
let lastHtml = '';
let hudOn = true;
function updateHud() {
  const html = cardHtml(1) + rangeHtml() + endHtml();
  if (html !== lastHtml) { hud.innerHTML = html; lastHtml = html; }
}

// --- The ship's instruments (as Solo Air Defense's strip) ---------------------------------------------------------------------
// Two cards with a dome between them, standing on the bottom edge: your hull and compartments, the heading tape with the rudder arc and
// the speed, and the guns, round, stocks and crews. The enemy and the range stay in the card at the right.
const shipEl = document.createElement('div');
shipEl.id = 'duel-ship';
shipEl.className = 'duel-ship';
document.body.appendChild(shipEl);
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
function shipHtml() {
  const p = sim.player;
  const cells = COMP_IDS.map((id) => {
    const f = p.comp[id] / COMPARTMENTS[id].hp;
    const crew = p.crews.filter((c) => c.to === id).length;
    return `<i class="cp ${f <= 0 ? 'out' : f < 0.5 ? 'bad' : f < 0.99 ? 'hurt' : ''}${COMP_IDS[selComp] === id ? ' sel' : ''}" title="${COMPARTMENTS[id].name}"><b>${COMP_ABBR[id]}</b><s style="height:${Math.round(clamp(f, 0, 1) * 100)}%"></s>`
      + `<em>${p.fire[id] > 0 ? '<u class="fire">▲</u>' : ''}${p.leak[id] > 0.005 ? '<u class="leak">≈</u>' : ''}${crew ? '<u class="crew">⛑</u>' : ''}</em></i>`;
  }).join('');
  const g = p.gun;
  const dry = p.gats.every((x) => x.ammo <= 0);
  return `<div class="hs-rect hs-hull${p.hp < HULL_HP ? ' hurt' : ''}"><span>HULL <b>${Math.round(p.hp)}</b>${p.tSunk !== null ? ' · SINKING' : ''}</span><div class="hs-cells">${cells}</div></div>`
    + `<div class="hs-dome">${domeSvg()}</div>`
    + `<div class="hs-rect hs-wpn"><span>76 mm <b>${AMMO_TYPES[g.type].name}</b> · HE ${g.stock.he} AP ${g.stock.ap} · ${gunStatus(p)}</span>`
    + `<span>30 mm <b>${dry ? 'DRY' : p.auto ? 'AUTO' : 'HOLD G'}</b> · crews <b>${p.crews.filter((c) => c.to).length}/${CREWS}</b> · ${COMPARTMENTS[COMP_IDS[selComp]].name}</span></div>`;
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
strip.innerHTML = VIEWS.map((v, i) => `<button type="button" data-view="${v}" title="${VIEW_NAMES[v]} (${i + 1})">${VIEW_LABELS[i]}</button>`).join('');
document.body.appendChild(strip);
viewButtons.push(...strip.querySelectorAll('button'));
viewButtons.forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));

keysSheet.querySelector('dl').innerHTML = [
  ['<kbd>←</kbd> <kbd>→</kbd>', 'Rudder to port / starboard while held; let go and it comes back amidships'],
  ['<kbd>↑</kbd> <kbd>↓</kbd>', 'Engine telegraph, one step: slow astern, stop, dead slow, slow, half, full, flank'],
  ['<kbd>F</kbd>', `Fire the 76 mm (hold): the gun trains on the enemy by itself within ${Math.round((MAIN_ARC * 180) / Math.PI)}° of the bow and ${kmText(MAIN_RANGE)}, and fires once it is on the aim and loaded`],
  ['<kbd>G</kbd>', `Fire the two 30 mm guns aft (hold): ${kmText(GUN_RANGE)}, astern and abeam only`],
  ['<kbd>A</kbd>', 'The 30 mm guns on automatic'],
  ['<kbd>Q</kbd>', `Change the 76 mm round, HE or AP: HE starts fires and floods, AP hits one compartment harder; changing costs a ${SWITCH_TIME} s reload`],
  ['<kbd>Z</kbd> <kbd>X</kbd>', `Z picks the next compartment, X sends a repair crew there (or calls it back): ${CREWS} crews, each puts out fire, slows flooding and mends one compartment`],
  ['<kbd>1</kbd> to <kbd>7</kbd>', 'Behind, bridge, sight, above, shell, orbit, radar'],
  ['<kbd>7</kbd>', 'Radar view, like Solo Air Defense: the fire-control sight on the enemy. Arrows, a drag or the on-screen pad aim it over any part of her hull (the label names the compartment), F fires there, Space returns it to auto. The helm is locked until Esc'],
  ['<kbd>V</kbd>', 'Next view · drag looks round in the orbit view, the wheel zooms'],
  ['<kbd>R</kbd>', 'Fight again'],
  ['<kbd>N</kbd>', 'Map'],
  ['<kbd>S</kbd>', 'Sound on / off'],
  ['<kbd>H</kbd> <kbd>C</kbd>', 'Readouts, hide the interface'],
].map(([k, d]) => `<dt>${k}</dt><dd>${d}</dd>`).join('');
keysSheet.querySelector('.keys-note').textContent = 'The 76 mm aims itself unless you take the radar view (7) · a shell takes seconds to arrive and turning spoils your aim';

const audio = createDuelAudio();
eventHooks.push((e) => audio.event(e));
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

const keysEl = document.createElement('div');
keysEl.id = 'fly-keys';
keysEl.className = 'fly-keys';
document.body.appendChild(keysEl);
const input = { left: 0, right: 0, fire: 0, gat: 0, aim: null };
const k = (key, label, on = false) => `<span class="fk${on ? ' on' : ''}"><kbd>${key}</kbd>${label}</span>`;
function keysHtml() {
  return `${k('← →', 'rudder', input.left || input.right)}${k('↑ ↓', 'speed')}${k('F', 'fire 76 mm (hold)', input.fire)}${k('G', '30 mm (hold)', input.gat)}`
    + `${k('Q', `ammo ${AMMO_TYPES[sim.player.gun.type].name}`)}${k('Z X', 'crews')}`
    + `${k('A', 'auto 30 mm', sim.player.auto)}${k('1–7', 'views')}${k('R', 'again')}`;
}
let lastKeys = '';

// --- Tags --------------------------------------------------------------------------------------------------------------------
const labels = new CSS2DRenderer();
labels.domElement.className = 'labels-layer duel-labels';
document.body.appendChild(labels.domElement);
const tagEl = document.createElement('div');
tagEl.className = 'tag tag-ship';
tagEl.style.pointerEvents = 'none';
tagEl.innerHTML = '<div class="tag-title"></div><div class="tag-body"></div>';
const tagObj = new CSS2DObject(tagEl);
tagObj.center.set(0.5, 1);
scene.add(tagObj);
let tagsOn = true;
function updateTag() {
  tagObj.visible = tagsOn && ships[1].group.visible;
  tagObj.position.set(sim.enemy.x, 36, sim.enemy.z);
  tagEl.querySelector('.tag-title').textContent = 'ENEMY';
  tagEl.querySelector('.tag-body').textContent = `${kmText(sim.range())} · ${relName(sim.relBearing(sim.player))}`;
}

// --- Keys --------------------------------------------------------------------------------------------------------------------
function restart() {
  sim.seed = (Date.now() % 100000) | 0;
  sim.reset();
  fx.clear();
  for (const v of ships) v.wake.clear();
  tracers.forEach((t) => { t.on = false; });
  lastShell = null;
  banner.hidden = true;
  alarmEl.classList.remove('hit');
  if (view === 'radar') setView(viewBeforeRadar);
  input.aim = null;
  selComp = 0;
  setManual(false);
  startBanner();
}
function startBanner() {
  say(`Enemy ${relName(sim.relBearing(sim.player))}, ${kmText(sim.range())}: close, turn to bring your gun to bear, and keep her off your stern`, '', 5200);
}
window.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const tag = e.target?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;
  if (view === 'radar' && e.key.startsWith('Arrow')) { // the helm is locked: the arrows turn the sight
    const k = { ArrowLeft: 'l', ArrowRight: 'r', ArrowUp: 'u', ArrowDown: 'd' }[e.key];
    radarKeys[k] = 1;
    sight.manual = true;
    e.preventDefault();
    return;
  }
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    input[e.key === 'ArrowLeft' ? 'left' : 'right'] = 1;
    e.preventDefault();
    return;
  }
  if (e.key === 'f' || e.key === 'F') { input.fire = 1; e.preventDefault(); return; }
  if (e.key === 'g' || e.key === 'G') { input.gat = 1; e.preventDefault(); return; }
  if (e.repeat) { if (e.key.startsWith('Arrow')) e.preventDefault(); return; }
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  switch (key) {
    case 'ArrowUp': sim.telegraph(0, +1); break;
    case 'ArrowDown': sim.telegraph(0, -1); break;
    case 'a': sim.toggleAuto(0); break;
    case 'q': sim.switchAmmo(0); break;
    case 'z': selComp = (selComp + 1) % COMP_IDS.length; break;
    case 'x': sim.assignCrew(0, COMP_IDS[selComp]); break;
    case 'r': restart(); break;
    case 'v': setView(VIEWS[(VIEWS.indexOf(view) + 1) % VIEWS.length]); break;
    case '1': case '2': case '3': case '4': case '5': case '6': case '7': setView(VIEWS[Number(key) - 1]); break;
    case 'h': setHud(!hudOn); break;
    case 'n': setMap(!mapOn); break;
    case 'l': tagsOn = !tagsOn; break;
    case 'c': setFolded(!document.body.classList.contains('ui-hidden')); break;
    case '?': setKeys(keysSheet.hidden); break;
    case 'Escape': if (!closePopovers() && view === 'radar') setView(viewBeforeRadar); break;
    case 's': setSound(!audio.enabled); break;
    case ' ': if (view === 'radar') sight.manual = false; break;
    default: return;
  }
  if (key !== 'Escape') e.preventDefault();
});
window.addEventListener('keyup', (e) => {
  if (e.key.startsWith('Arrow')) radarKeys[{ ArrowLeft: 'l', ArrowRight: 'r', ArrowUp: 'u', ArrowDown: 'd' }[e.key]] = 0;
  if (e.key === 'ArrowLeft') input.left = 0;
  if (e.key === 'ArrowRight') input.right = 0;
  if (e.key === 'f' || e.key === 'F') input.fire = 0;
  if (e.key === 'g' || e.key === 'G') input.gat = 0;
});
window.addEventListener('blur', () => { input.left = 0; input.right = 0; input.fire = 0; input.gat = 0; });

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
// The fire-control sight on the bridge roof: a mount that turns at a limited rate. In AUTO it swings onto the enemy and holds her; the
// arrows, a drag or the pad turn it by hand (MANUAL) over any part of her hull. The shell is aimed at the hull point under the
// crosshair (the fire control leads that point), F or the Fire button shoots. The helm is locked until you go back.
const SIGHT_RATE = THREE.MathUtils.degToRad(55);
const sight = { aim: new THREE.Vector3(1, 0.03, 0), manual: false, fresh: true, omega: 0, dragYaw: 0, dragPitch: 0, zone: null };
const radarKeys = { l: 0, r: 0, u: 0, d: 0 };
let sightZoom = 1.5;
const sightEl = document.createElement('div');
sightEl.className = 'duel-sight';
sightEl.hidden = true;
sightEl.innerHTML = '<i class="hs-h"></i><i class="hs-v"></i><i class="hs-box"></i><b class="hs-txt"></b>';
document.body.appendChild(sightEl);
const sightTxt = sightEl.querySelector('.hs-txt');
const radarEl = document.createElement('div');
radarEl.className = 'duel-radar';
radarEl.hidden = true;
radarEl.innerHTML = '<div class="hr-pad">'
  + '<div class="hr-acts"><button type="button" data-act="auto">Release / auto<kbd>Space</kbd></button><button type="button" data-act="back">Back to the helm<kbd>Esc</kbd></button></div>'
  + '<div class="hr-mid"><div class="hr-read"><b class="hr-mode">AUTO</b><span class="hr-brg"></span></div>'
  + '<div class="hr-dpad"><button type="button" data-dir="u" aria-label="Aim up">▲</button><button type="button" data-dir="l" aria-label="Aim left">◀</button>'
  + '<i class="hr-hub"></i><button type="button" data-dir="r" aria-label="Aim right">▶</button><button type="button" data-dir="d" aria-label="Aim down">▼</button></div></div>'
  + '<div class="hr-acts"><button type="button" data-act="fire" class="hr-fire">Fire<kbd>F</kbd></button><button type="button" data-act="ammo">Change round<kbd>Q</kbd></button></div></div>';
document.body.appendChild(radarEl);
const radarMode = radarEl.querySelector('.hr-mode');
const radarBrg = radarEl.querySelector('.hr-brg');
radarEl.addEventListener('pointerdown', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  e.preventDefault();
  const release = (fn) => { const up = () => { fn(); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up); }; window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up); };
  if (b.dataset.dir) { radarKeys[b.dataset.dir] = 1; sight.manual = true; release(() => { radarKeys[b.dataset.dir] = 0; }); }
  else if (b.dataset.act === 'fire') { input.fire = 1; release(() => { input.fire = 0; }); }
  else if (b.dataset.act === 'auto') sight.manual = false;
  else if (b.dataset.act === 'ammo') sim.switchAmmo(0);
  else if (b.dataset.act === 'back') setView(viewBeforeRadar);
});
let sightDrag = null;
canvas.addEventListener('pointerdown', (e) => { if (e.button === 0 && view === 'radar') sightDrag = { x: e.clientX, y: e.clientY }; });
window.addEventListener('pointerup', () => { sightDrag = null; });
window.addEventListener('pointermove', (e) => {
  if (!sightDrag || view !== 'radar') return;
  const dx = e.clientX - sightDrag.x, dy = e.clientY - sightDrag.y;
  sightDrag = { x: e.clientX, y: e.clientY };
  sight.manual = true;
  sight.dragYaw += dx * THREE.MathUtils.degToRad(camera.fov) / window.innerHeight;
  sight.dragPitch -= dy * THREE.MathUtils.degToRad(camera.fov) / window.innerHeight;
});
canvas.addEventListener('wheel', (e) => { if (view === 'radar') sightZoom = clamp(sightZoom * Math.exp(e.deltaY * 0.001), 0.4, 6); }, { passive: true });
canvas.addEventListener('dblclick', () => { sightZoom = 1.5; });
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
  const lens = clamp((Math.atan(80 / r) * 2 * 180) / Math.PI * sightZoom, 1.2, 30);
  if (sight.manual) {
    const rate = THREE.MathUtils.degToRad(50) * clamp(lens / 40, 0.03, 1);
    let yaw = Math.atan2(sight.aim.z, sight.aim.x) + (radarKeys.r - radarKeys.l) * rate * dt + sight.dragYaw;
    const pitch = clamp(Math.asin(clamp(sight.aim.y, -1, 1)) + (radarKeys.u - radarKeys.d) * rate * dt + sight.dragPitch, -0.25, 0.6);
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
// The shell goes where the crosshair is: the hull point the sight's ray meets (the fire control leads it), else the sea beside her.
function radarAimShell() {
  const p = sim.player;
  sight.zone = null;
  if (p.tSunk !== null || sim.enemy.tSunk !== null) { input.aim = null; return; }
  const g = ships[1].group;
  g.updateMatrixWorld(true);
  ships[0].group.localToWorld(_c.copy(BRIDGE_EYE));
  sightRay.origin.copy(_c);
  sightRay.direction.copy(sight.aim);
  const local = sightRay.clone().applyMatrix4(_sm.copy(g.matrixWorld).invert());
  const hit = local.intersectBox(hullBox, _a);
  let P;
  if (hit) { sight.zone = zoneAt(_a.x); P = g.localToWorld(_a.clone()); }
  else { // off her hull: the point on the vertical plane through her, square to the line of sight
    const d = _b.set(sim.enemy.x - _c.x, 0, sim.enemy.z - _c.z);
    const dist = d.length() || 1;
    const n = d.divideScalar(dist);
    const denom = sight.aim.dot(n);
    if (denom < 1e-4) { input.aim = null; return; }
    const tt = (new THREE.Vector3(sim.enemy.x, 0, sim.enemy.z).sub(_c).dot(n)) / denom;
    P = _c.clone().addScaledVector(sight.aim, tt);
    P.y = Math.max(0, P.y);
  }
  const sol = sim.solve(p, MAIN_MOUNT, MUZZLE_V, true, {}, { p: [P.x, P.y, P.z], v: [p.est[0], 0, p.est[1]] });
  input.aim = { yaw: sol.yaw, pitch: sol.pitch };
}
function updateRadarUi() {
  if (view !== 'radar') return;
  radarMode.textContent = sight.manual ? 'MANUAL' : 'AUTO';
  radarMode.classList.toggle('manual', sight.manual);
  const yaw = Math.atan2(sight.aim.z, sight.aim.x);
  const rel = Math.atan2(Math.sin(yaw - sim.player.psi), Math.cos(yaw - sim.player.psi));
  radarBrg.textContent = `${relName(rel)} · elv ${Math.round(THREE.MathUtils.radToDeg(Math.asin(sight.aim.y)))}° · lens ${camera.fov.toFixed(1)}°`;
  const g = sim.player.gun;
  sightEl.classList.toggle('lock', !!sight.zone);
  sightEl.classList.toggle('searching', !sight.zone);
  sightTxt.textContent = `${sight.zone ? `AIM: ${COMPARTMENTS[sight.zone].name.toUpperCase()}` : 'Off her hull'} · ${kmText(sim.range())} · ${AMMO_TYPES[g.type].name} ${g.stock[g.type]} · ${gunStatus(sim.player)}`;
  map.sight = { yaw, locked: !!sight.zone };
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
resize();
setView('behind');
startBanner();

let last = performance.now();
let frames = 0;
renderer.setAnimationLoop((now) => {
  const dt = Math.max(0, Math.min((now - last) / 1000, 0.1));
  last = now;
  frameDt = dt;
  updateAim();
  sim.advance(dt, input);
  handleEvents();
  env.ocean.material.uniforms.uTime.value = sim.t;
  poseShip(0, dt);
  poseShip(1, dt);
  updateWeapons(dt);
  updateCamera();
  env.follow(camera.position);
  env.setShadowFocus(_b.set((sim.player.x + sim.enemy.x) / 2, 0, (sim.player.z + sim.enemy.z) / 2), clamp(sim.range() * 0.5, 120, 600));
  fx.update(sim.t);
  audio.update(sim, camera);
  if (hudOn) {
    updateHud();
    const sh = shipHtml();
    if (sh !== lastShip) { shipEl.innerHTML = sh; lastShip = sh; }
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

window.__duel = { sim, camera, controls, scene, renderer, ships, setView, restart, fx, hooks: eventHooks, input };

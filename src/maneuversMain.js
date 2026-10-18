import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { createEnvironment } from './environment.js';
import { createShip } from './models/ship.js';
import { canvasTexture } from './models/kit.js';
import { CameraRig } from './cameraRig.js';
import { createTimeline } from './timeline.js';
import { createManeuverMap } from './maneuverMap.js';
import { toast } from './pathEditor.js';
import {
  exercise, shipState, relation, headingDeg, phaseAt, KT, YD, LIGHT, FLAGS,
} from './maneuvers.js';

// Entry point of the second mission, "Naval maneuvers" (see maneuvers.js). Two frigates, ALG and
// RUS, fly through the signalled maneuvers of the briefing deck. Like the intercept scene, every
// visual is a pure function of the clock, so the timeline scrubs both ways. start.js imports this
// instead of main.js when that mission is picked.

const COLORS = { alg: 0x3ddc84, rus: 0xff7a1a };
// The exercise starts near (-3200, -3400) so that the roughly 6 km it covers is centred on the origin.
const SHIFT = new THREE.Vector3(-3200, 0, -3400);

const canvas = document.querySelector('#scene');
const loadingEl = document.querySelector('#loading');
document.body.classList.add('mission-maneuvers');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.75;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, 1, 0.5, 40000);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.maxDistance = 9000;
controls.maxPolarAngle = Math.PI * 0.495;

// Idle rendering: draw only when the clock, the camera or the interface changed.
let invalidations = 0;
const invalidate = () => { invalidations++; };
for (const type of ['pointerdown', 'pointermove', 'pointerup', 'wheel', 'keydown', 'click', 'resize', 'visibilitychange']) {
  window.addEventListener(type, invalidate, { capture: true, passive: true });
}
canvas.addEventListener('webglcontextrestored', invalidate);

const env = createEnvironment(renderer, scene);
env.setShadowSize(1024);

// --- Ships -------------------------------------------------------------------------------------
const ships = {
  alg: { id: 'alg', ship: createShip({ ensign: 'alg' }), state: {} },
  rus: { id: 'rus', ship: createShip({ ensign: 'rus' }), state: {} },
};
for (const s of Object.values(ships)) scene.add(s.ship.group);

function placeShip(s, t) {
  shipState(s.id, t, s.state);
  s.ship.group.position.set(s.state.x, 0, s.state.z).add(SHIFT);
  s.ship.group.rotation.y = -s.state.heading; // the model's bow is +X; the compass heading runs clockwise from North
  // The launcher and catapult belong to the intercept mission: pass a time that finds them stowed.
  s.ship.update(1000 + t, Infinity);
}

// --- Wakes: a fading ribbon of foam along each ship's recent track -----------------------------------
const WAKE_STEPS = 48;
const WAKE_SPAN = 150; // s of track behind the ship
function createWake() {
  const pos = new Float32Array(WAKE_STEPS * 2 * 3);
  const col = new Float32Array(WAKE_STEPS * 2 * 4);
  const index = [];
  for (let i = 0; i < WAKE_STEPS - 1; i++) { const a = i * 2; index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 4));
  geo.setIndex(index);
  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
    vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: true,
  }));
  mesh.frustumCulled = false;
  mesh.renderOrder = 2;
  scene.add(mesh);
  return { pos, col, geo };
}
const wakes = { alg: createWake(), rus: createWake() };
const _w = {};
function updateWake(id, t) {
  const w = wakes[id];
  for (let i = 0; i < WAKE_STEPS; i++) {
    const age = (i / (WAKE_STEPS - 1)) * WAKE_SPAN;
    shipState(id, Math.max(t - age, 0), _w);
    const u = i / (WAKE_STEPS - 1);
    const half = 4 + 22 * u;
    // Sideways = to starboard of the heading (compass: East when heading North).
    const sx = -Math.sin(_w.heading);
    const sz = Math.cos(_w.heading);
    const bx = _w.x + SHIFT.x - Math.cos(_w.heading) * 55; // from the stern, at each moment
    const bz = _w.z + SHIFT.z - Math.sin(_w.heading) * 55;
    w.pos.set([bx + sx * half, 0.5, bz + sz * half, bx - sx * half, 0.5, bz - sz * half], i * 6);
    const a = (t - age < 0 ? 0 : 0.5) * (1 - u) ** 1.4;
    w.col.set([0.94, 0.97, 1, a, 0.94, 0.97, 1, a], i * 8);
  }
  w.geo.attributes.position.needsUpdate = true;
  w.geo.attributes.color.needsUpdate = true;
}

// --- Track lines (the whole planned track faint, the steamed part bright) -----------------------------
const resolution = new THREE.Vector2(window.innerWidth, window.innerHeight);
const lineMats = [];
function trackLine(id) {
  const pts = [];
  for (let t = 0; t <= exercise.tEnd; t += 3) { shipState(id, t, _w); pts.push(_w.x + SHIFT.x, 2, _w.z + SHIFT.z); }
  const flat = new Float32Array(pts);
  const mk = (geo, color, width, opacity, dashed) => {
    const m = new LineMaterial({
      color, linewidth: width, transparent: true, opacity, depthWrite: false, resolution, worldUnits: false,
      ...(dashed ? { dashed: true, dashSize: 30, gapSize: 30 } : {}),
    });
    lineMats.push(m);
    const l = new Line2(geo, m);
    l.frustumCulled = false;
    l.renderOrder = 4;
    scene.add(l);
    return l;
  };
  const plan = mk(new LineGeometry().setPositions(flat), COLORS[id], 1.1, 0.3, true);
  plan.computeLineDistances();
  const doneGeo = new LineGeometry().setPositions(flat);
  const spent = new THREE.Color(COLORS[id]).lerp(new THREE.Color(0x7d8791), 0.6);
  const done = mk(doneGeo, spent, 2, 0.9, false);
  const segs = flat.length / 3 - 1;
  return { plan, done, set(t) { doneGeo.instanceCount = Math.max(0, Math.min(segs, Math.ceil((t / exercise.tEnd) * segs))); } };
}
const tracks = { alg: trackLine('alg'), rus: trackLine('rus') };
const trackGroupVisible = (on) => { for (const k of Object.values(tracks)) k.plan.visible = k.done.visible = on; };

// --- Signals: the lamp's flashes and the flag hoist -----------------------------------------------------
const glowTex = canvasTexture(64, 64, (ctx, w, h) => {
  const g = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
  g.addColorStop(0, 'rgba(255,245,170,1)');
  g.addColorStop(0.3, 'rgba(255,225,80,0.55)');
  g.addColorStop(1, 'rgba(255,200,40,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
});
function createLamp(ship) {
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowTex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, fog: false,
  }));
  sprite.position.set(9.2, 29, 0);
  ship.group.add(sprite);
  // The beam: a long, thin yellow cone from the lamp toward the other ship.
  const beam = new THREE.Mesh(
    new THREE.ConeGeometry(1, 1, 24, 1, true),
    new THREE.MeshBasicMaterial({ color: 0xffd530, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide, fog: false }),
  );
  beam.frustumCulled = false;
  scene.add(beam);
  return { sprite, beam };
}
const lamps = { alg: createLamp(ships.alg.ship), rus: createLamp(ships.rus.ship) };
const _from = new THREE.Vector3();
const _to = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
function blink(t, phase) {
  // A signalling lamp: dots and dashes as a pure function of t.
  const u = (t * 2.2 + phase) % 8;
  return u < 0.6 || (u > 1.2 && u < 2.6) || (u > 3.2 && u < 3.8) || (u > 4.4 && u < 6) ? 1 : 0;
}
function updateLamps(t) {
  const span = LIGHT.t1 - LIGHT.t0;
  // RUS signals first, ALG answers in the second half.
  const turns = { rus: [LIGHT.t0, LIGHT.t0 + span / 2], alg: [LIGHT.t0 + span / 2, LIGHT.t1] };
  for (const id of ['rus', 'alg']) {
    const lamp = lamps[id];
    const [a, b] = turns[id];
    const on = t >= a && t < b ? blink(t - a, id === 'rus' ? 0 : 3) : 0;
    lamp.sprite.visible = on > 0;
    lamp.sprite.scale.setScalar(on ? 26 : 1);
    const beam = lamp.beam;
    beam.visible = on > 0;
    if (!on) continue;
    const other = id === 'rus' ? 'alg' : 'rus';
    ships[id].ship.group.localToWorld(_from.set(9.2, 29, 0));
    ships[other].ship.group.localToWorld(_to.set(9.2, 22, 0));
    _dir.subVectors(_to, _from);
    const len = _dir.length();
    beam.position.copy(_from).addScaledVector(_dir, 0.5);
    beam.quaternion.setFromUnitVectors(_up, _dir.normalize());
    // A cone's apex is at +Y: flip it so the apex sits at the lamp.
    beam.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI));
    beam.scale.set(len * 0.045, len, len * 0.045);
    beam.material.opacity = 0.3;
  }
}

const flagArt = {
  // Simple ICS-style signal flags: [draw instructions per flag].
  rus: [(c, w, h) => { c.fillStyle = '#d6155a'; c.fillRect(0, 0, w, h); c.fillStyle = '#f5d800'; c.beginPath(); c.moveTo(w, 0); c.lineTo(w, h); c.lineTo(0, h); c.closePath(); c.fill(); },
    (c, w, h) => { const cols = ['#0b3d91', '#fff', '#d52b1e', '#fff', '#0b3d91']; cols.forEach((k, i) => { c.fillStyle = k; c.fillRect(0, (i * h) / 5, w, h / 5 + 1); }); }],
  alg: [(c, w, h) => { c.fillStyle = '#d6155a'; c.fillRect(0, 0, w, h / 2); c.fillStyle = '#0b3d91'; c.fillRect(0, h / 2, w, h / 2); },
    (c, w, h) => { c.fillStyle = '#111'; c.fillRect(0, 0, w, h); c.fillStyle = '#f5d800'; c.beginPath(); c.moveTo(0, h); c.lineTo(w, h); c.lineTo(w, 0); c.closePath(); c.fill(); },
    (c, w, h) => { c.fillStyle = '#3a3aa8'; c.fillRect(0, 0, w, h / 2); c.fillStyle = '#f5d800'; c.fillRect(0, h / 2, w, h / 2); }],
};
function createFlags(ship, id) {
  const group = new THREE.Group();
  const pieces = flagArt[id].map((draw, i) => {
    const geo = new THREE.PlaneGeometry(3, 2, 8, 4);
    geo.translate(-1.5, 0, 0);
    const base = geo.attributes.position.array.slice();
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map: canvasTexture(96, 64, draw), side: THREE.DoubleSide, roughness: 0.85 }));
    mesh.position.set(8, 29 - i * 2.3, 0);
    group.add(mesh);
    return { mesh, base, i };
  });
  ship.group.add(group);
  return { group, pieces };
}
const flags = { alg: createFlags(ships.alg.ship, 'alg'), rus: createFlags(ships.rus.ship, 'rus') };
function updateFlags(t) {
  const up = THREE.MathUtils.smoothstep(t, FLAGS.t0, FLAGS.t0 + 8) * (1 - THREE.MathUtils.smoothstep(t, FLAGS.t1 - 6, FLAGS.t1));
  for (const f of Object.values(flags)) {
    f.group.visible = up > 0.001;
    f.group.position.y = -10 * (1 - up);
    for (const p of f.pieces) {
      const pos = p.mesh.geometry.attributes.position;
      for (let v = 0; v < pos.count; v++) {
        const x = p.base[v * 3];
        pos.setZ(v, 0.35 * (x / -3) * Math.sin(x * 2.6 - t * 8 + p.i));
      }
      pos.needsUpdate = true;
    }
  }
}

// --- Tags (ALG, RUS, and the station line) -----------------------------------------------------------
const labelRenderer = new CSS2DRenderer();
labelRenderer.domElement.className = 'labels-layer';
document.body.appendChild(labelRenderer.domElement);
const labelGroup = new THREE.Group();
scene.add(labelGroup);
function tag(kind, title, color) {
  const el = document.createElement('div');
  el.className = `tag tag-${kind}`;
  el.innerHTML = `<div class="tag-title">${title}</div><div class="tag-body"></div>`;
  el.style.pointerEvents = 'none';
  if (color) el.style.borderLeftColor = color;
  const obj = new CSS2DObject(el);
  obj.center.set(0.5, 1);
  labelGroup.add(obj);
  return { obj, body: el.querySelector('.tag-body') };
}
const tags = { alg: tag('ship', 'ALG', '#3ddc84'), rus: tag('ship', 'RUS', '#ff7a1a') };
const stationTag = tag('missile', 'STATION', '#ffffff');
const pad3 = (n) => String(Math.round(n)).padStart(3, '0');
const fmtTag = (s) => `${pad3(headingDeg(s.heading))}° · ${(s.speed / KT).toFixed(0)}<span> kn</span>`;
const _mid = new THREE.Vector3();
function updateTags(t) {
  for (const id of ['alg', 'rus']) {
    const s = ships[id];
    tags[id].obj.position.copy(s.ship.group.position).setY(40);
    tags[id].body.innerHTML = fmtTag(s.state);
  }
  const rel = relation(t, 'rus', 'alg');
  stationTag.obj.position.addVectors(ships.alg.ship.group.position, ships.rus.ship.group.position).multiplyScalar(0.5).setY(20);
  stationTag.body.innerHTML = `${Math.round(rel.range / YD)}<span> yd</span> · ${pad3(rel.bearing)}°`;
  stationTag.obj.visible = rel.range > 450; // close together, the two ship tags say enough
}
// The station line itself.
const stationGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
const stationLine = new THREE.Line(stationGeo, new THREE.LineDashedMaterial({ color: 0xffffff, dashSize: 25, gapSize: 25, transparent: true, opacity: 0.45, depthWrite: false }));
stationLine.frustumCulled = false;
scene.add(stationLine);
function updateStationLine() {
  const p = stationGeo.attributes.position;
  p.setXYZ(0, ships.alg.ship.group.position.x, 12, ships.alg.ship.group.position.z);
  p.setXYZ(1, ships.rus.ship.group.position.x, 12, ships.rus.ship.group.position.z);
  p.needsUpdate = true;
  stationLine.computeLineDistances();
}

// --- Camera focus --------------------------------------------------------------------------------------
const rig = new CameraRig(camera, controls);
const targets = {
  alg: { pos: (out) => out.copy(ships.alg.ship.group.position).setY(12), distance: 230, minDistance: 40 },
  rus: { pos: (out) => out.copy(ships.rus.ship.group.position).setY(12), distance: 230, minDistance: 40 },
  formation: {
    pos: (out) => out.addVectors(ships.alg.ship.group.position, ships.rus.ship.group.position).multiplyScalar(0.5).setY(0),
    distance: 1500, minDistance: 150,
  },
};
// The camera buttons of the bottom bar: Free, ALG, RUS, Formation.
const focusButtons = [...document.querySelectorAll('[data-focus]')];
const FOCUS_ALIAS = { plane: 'alg', missile: 'rus', ship: 'formation' };
const FOCUS_LABEL = { alg: 'ALG', rus: 'RUS', formation: 'Formation' };
for (const b of focusButtons) {
  const id = FOCUS_ALIAS[b.dataset.focus];
  if (id) { b.dataset.focus = id; b.textContent = FOCUS_LABEL[id]; b.disabled = false; b.title = `Look at ${FOCUS_LABEL[id]} (${{ alg: 1, rus: 2, formation: 3 }[id]})`; }
}
function setFocus(id, distance) {
  invalidate();
  if (id === 'free' || !targets[id]) {
    rig.free();
  } else {
    const t = targets[id];
    rig.focus(id, t.pos, distance ?? t.distance, t.minDistance);
  }
  focusButtons.forEach((b) => b.classList.toggle('active', b.dataset.focus === rig.id));
}
for (const b of focusButtons) b.addEventListener('click', () => setFocus(b.dataset.focus));

// --- Interface: readouts, serial box, toggles, menu --------------------------------------------------------
const hudRoot = document.querySelector('#hud');
const hudLive = hudRoot.querySelector('.hud-live');
const hudDebrief = hudRoot.querySelector('.hud-debrief');
hudDebrief.hidden = true;
const tile = (label, value, unit, cls = '') => `<div class="tile ${cls}"><span>${label}</span><b>${value}${unit ? `<small>${unit}</small>` : ''}</b></div>`;
const redTokens = (s) => s.replace(/\b(AS|AB|AC|ALG|RUS)\b/g, '<span class="red">$1</span>');
let lastPhase = null;
let lastLive = '';
hudLive.innerHTML = '<div class="hud-sec" data-live></div><div class="hud-sec serial" data-serial></div>';
const liveEl = hudLive.querySelector('[data-live]');
const serialEl = hudLive.querySelector('[data-serial]');
const serialHtml = (phase) => (phase.speeds ? `<div class="serial-speeds">${phase.speeds.map((s) => `<div>${s}</div>`).join('')}</div>` : '')
  + phase.serial.map((blk) => `<div class="serial-box">${blk.head ? `<div class="serial-head">${blk.head}</div>` : ''}${blk.lines.map((l) => `<div>${redTokens(l)}</div>`).join('')}</div>`).join('');
function updateReadout(t) {
  const phase = phaseAt(t);
  const a = ships.alg.state;
  const r = ships.rus.state;
  const rel = relation(t, 'rus', 'alg');
  const html = `<div class="hud-head"><b>${phase.title}</b><span class="chip live">${t >= exercise.tEnd ? 'Complete' : 'Under way'}</span></div>`
    + `<div class="tiles">${tile('ALG', `${pad3(headingDeg(a.heading))}°`, `${(a.speed / KT).toFixed(0)} kn`)}${tile('RUS', `${pad3(headingDeg(r.heading))}°`, `${(r.speed / KT).toFixed(0)} kn`)}`
    + `${tile('Station', `${Math.round(rel.range / YD)}`, `yd · ${pad3(rel.bearing)}°`, 'wide')}</div>`;
  if (html !== lastLive) { liveEl.innerHTML = html; lastLive = html; }
  if (phase !== lastPhase) {
    lastPhase = phase;
    serialEl.innerHTML = serialHtml(phase);
  }
}

let hudOn = true;
const hudButton = document.querySelector('#btn-hud');
function setHud(on) { hudOn = on; hudRoot.hidden = !on; hudButton.classList.toggle('active', on); hudButton.setAttribute('aria-pressed', String(on)); invalidate(); }
hudButton.addEventListener('click', () => setHud(!hudOn));

const labelsButton = document.querySelector('#btn-labels');
function setLabels(on) {
  labelGroup.visible = on;
  labelRenderer.domElement.style.display = on ? '' : 'none';
  labelsButton.classList.toggle('active', on);
  labelsButton.setAttribute('aria-pressed', String(on));
  try { localStorage.setItem('intercept.labels', on ? '1' : '0'); } catch { /* storage unavailable */ }
  invalidate();
}
let labelsPref = true;
try { labelsPref = localStorage.getItem('intercept.labels') !== '0'; } catch { /* storage unavailable */ }
setLabels(labelsPref);
labelsButton.addEventListener('click', () => setLabels(!labelGroup.visible));

const trailsButton = document.querySelector('#btn-trails');
function setTrails(on) {
  trackGroupVisible(on);
  trailsButton.classList.toggle('active', on);
  trailsButton.setAttribute('aria-pressed', String(on));
  try { localStorage.setItem('intercept.trails', on ? '1' : '0'); } catch { /* storage unavailable */ }
  invalidate();
}
let trailsPref = true;
try { trailsPref = localStorage.getItem('intercept.trails') !== '0'; } catch { /* storage unavailable */ }
setTrails(trailsPref);
trailsButton.addEventListener('click', () => setTrails(!tracks.alg.plan.visible));
const legendEl = document.querySelector('#trail-legend');
legendEl.hidden = true; // the map and the tags already name the ships

const map = createManeuverMap();
const mapButton = document.querySelector('#btn-map');
function setMap(on) {
  map.setEnabled(on);
  mapButton.classList.toggle('active', on);
  mapButton.setAttribute('aria-pressed', String(on));
  try { localStorage.setItem('intercept.map', on ? '1' : '0'); } catch { /* storage unavailable */ }
  invalidate();
}
let mapPref = true;
try { mapPref = localStorage.getItem('intercept.map') !== '0'; } catch { /* storage unavailable */ }
setMap(mapPref);
mapButton.addEventListener('click', () => setMap(!map.enabled));

// Hide / show the whole interface.
const FOLD_KEY = 'intercept.uiHidden';
const foldButton = document.querySelector('#btn-fold');
const unfoldButton = document.querySelector('#btn-unfold');
const menuButton = document.querySelector('#btn-menu');
const menuEl = document.querySelector('#menu');
const keysEl = document.querySelector('#keys');
function setMenu(open) { menuEl.hidden = !open; menuButton.setAttribute('aria-expanded', String(open)); invalidate(); }
function setKeys(open) { keysEl.hidden = !open; invalidate(); }
function closePopovers() { const was = !menuEl.hidden || !keysEl.hidden; setMenu(false); setKeys(false); return was; }
function setPanelFolded(on, save = true) {
  invalidate();
  if (on) closePopovers();
  document.body.classList.toggle('ui-hidden', on);
  unfoldButton.hidden = !on;
  foldButton.setAttribute('aria-expanded', String(!on));
  if (save) try { localStorage.setItem(FOLD_KEY, on ? '1' : '0'); } catch { /* storage unavailable */ }
}
foldButton.addEventListener('click', () => setPanelFolded(true));
unfoldButton.addEventListener('click', () => setPanelFolded(false));
menuButton.addEventListener('click', () => setMenu(menuEl.hidden));
menuEl.addEventListener('click', (e) => { if (e.target.closest('button, a')) setMenu(false); });
document.querySelector('#btn-keys').addEventListener('click', () => setKeys(true));
document.querySelector('#keys-close').addEventListener('click', () => setKeys(false));
window.addEventListener('pointerdown', (e) => {
  if (!menuEl.hidden && !e.target.closest('#menu, #btn-menu')) setMenu(false);
  if (!keysEl.hidden && !e.target.closest('#keys, #btn-keys')) setKeys(false);
}, true);
let panelFolded = false;
try { panelFolded = localStorage.getItem(FOLD_KEY) === '1'; } catch { /* storage unavailable */ }
setPanelFolded(panelFolded, false);
document.querySelector('#btn-ship').addEventListener('click', () => {
  try { sessionStorage.setItem('intercept.chooser', '1'); location.reload(); } catch { location.search = ''; }
});
document.querySelector('.brand b').textContent = 'Maneuvers';
document.querySelector('#mission-sub').textContent = 'ALG & RUS · signalled drill';

// --- Clock ------------------------------------------------------------------------------------------------
const clock = createTimeline(exercise, {
  onKey(key, e) {
    if (e.ctrlKey || e.metaKey) return;
    if (key === 'Escape' && closePopovers()) return;
    if (key === ',') { clock.prevEvent(); return; }
    if (key === '.') { clock.nextEvent(); return; }
    if (key === '[') { clock.slower(); return; }
    if (key === ']') { clock.faster(); return; }
    if (key === '?') { setKeys(keysEl.hidden); return; }
    if (key === 'Escape') setFocus('free');
    if (key === '1') setFocus('alg');
    if (key === '2') setFocus('rus');
    if (key === '3') setFocus('formation');
    if (key === 'l' || key === 'L') setLabels(!labelGroup.visible);
    if (key === 't' || key === 'T') setTrails(!tracks.alg.plan.visible);
    if (key === 'm' || key === 'M') setMap(!map.enabled);
    if (key === 'h' || key === 'H') setHud(!hudOn);
    if (key === 'c' || key === 'C') setPanelFolded(!document.body.classList.contains('ui-hidden'));
  },
});
clock.setSpeed(8); // 38 minutes of exercise: eight times real time by default
// Deep link: ?t= opens paused at that moment.
try {
  const t = parseFloat(new URLSearchParams(location.search).get('t'));
  if (Number.isFinite(t)) { clock.playing = false; clock.seek(t); }
} catch { /* no query string */ }

// Opening view: the whole formation from the east, slightly above.
placeShip(ships.alg, clock.t);
placeShip(ships.rus, clock.t);
{
  const mid = targets.formation.pos(new THREE.Vector3());
  controls.target.copy(mid);
  camera.position.copy(mid).add(new THREE.Vector3(-450, 560, 980));
}
setFocus('formation');

// --- Loop -------------------------------------------------------------------------------------------------
function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h, false);
  labelRenderer.setSize(w, h);
  resolution.set(w, h);
  for (const m of lineMats) m.resolution.copy(resolution);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  invalidate();
}
window.addEventListener('resize', resize);
resize();

const drawn = { t: NaN, inv: -1, mat: new Float64Array(16) };
function needsRender() {
  camera.updateMatrixWorld();
  const e = camera.matrixWorld.elements;
  let same = true;
  for (let i = 0; i < 16; i++) if (Math.abs(e[i] - drawn.mat[i]) > 1e-5) { same = false; break; }
  return !same || clock.t !== drawn.t || invalidations !== drawn.inv;
}
const shadowCenter = new THREE.Vector3();
let last = performance.now();
renderer.setAnimationLoop((now) => {
  const dt = Math.max(0, Math.min((now - last) / 1000, 0.1));
  last = now;
  clock.tick(dt);
  const t = clock.t;
  placeShip(ships.alg, t);
  placeShip(ships.rus, t);
  updateWake('alg', t);
  updateWake('rus', t);
  for (const k of Object.values(tracks)) k.set(t);
  updateLamps(t);
  updateFlags(t);
  updateTags(t);
  updateStationLine();
  const ou = env.ocean.material.uniforms;
  ou.uTime.value = t;
  ou.uShipX.value = 1e7; // no single-ship wake: each ship has its own ribbon
  rig.update();
  controls.update();
  if (camera.position.y < 1) camera.position.y = 1;
  const close = rig.id === 'alg' || rig.id === 'rus';
  env.setShadowFocus(close ? targets[rig.id].pos(shadowCenter) : targets.formation.pos(shadowCenter), close ? 150 : 1300);
  clock.renderUI();
  updateReadout(t);
  map.update(t);
  if (needsRender()) {
    renderer.render(scene, camera);
    labelRenderer.render(scene, camera);
    drawn.t = t; drawn.inv = invalidations; drawn.mat.set(camera.matrixWorld.elements);
    loadingEl?.remove();
  }
});

toast('Naval maneuvers: ALG and RUS run the briefing deck. Playing at 8×, use the speed button or [ ] to change it.', 6000);

// Debug / inspection handle (mirrors the intercept scene's).
window.__scene = { exercise, clock, rig, camera, controls, setFocus, ships, scene, renderer };

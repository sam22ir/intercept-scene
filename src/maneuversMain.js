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
import { createManeuverAudio } from './maneuverAudio.js';
import { toast } from './pathEditor.js';
import {
  exercise, shipState, headingDeg, phaseAt, orderStatus, PHASES, STANDBY, STANDBY_LIMITS, KT, YD, LIGHT, FLAGS, lampOn,
  stationAt, orderedAt, DEBRIEF, STATION_FLASH,
} from './maneuvers.js';
import { stripShareParams } from './share.js';
import { menuText } from './menu.js';

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

// --- Wakes: a narrow ribbon of foam along each ship's recent track ---------------------------------------
// Three vertices per step (port edge, centre, starboard edge): the edges are transparent, so the foam
// has soft sides, and it widens and fades with age.
const WAKE_STEPS = 40;
const WAKE_SPAN = 90; // s of track behind the ship
function createWake() {
  const pos = new Float32Array(WAKE_STEPS * 3 * 3);
  const col = new Float32Array(WAKE_STEPS * 3 * 4);
  const index = [];
  for (let i = 0; i < WAKE_STEPS - 1; i++) {
    const a = i * 3;
    const b = a + 3;
    index.push(a, a + 1, b, a + 1, b + 1, b, a + 1, a + 2, b + 1, a + 2, b + 2, b + 1);
  }
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
    const u = i / (WAKE_STEPS - 1);
    const age = u * WAKE_SPAN;
    shipState(id, Math.max(t - age, 0), _w);
    const half = 3 + 11 * Math.sqrt(u); // a few metres at the stern, spreading slowly
    const sx = -Math.sin(_w.heading); // to starboard of the heading
    const sz = Math.cos(_w.heading);
    const bx = _w.x + SHIFT.x - Math.cos(_w.heading) * 55; // from the stern, at each moment
    const bz = _w.z + SHIFT.z - Math.sin(_w.heading) * 55;
    w.pos.set([bx + sx * half, 0.5, bz + sz * half, bx, 0.5, bz, bx - sx * half, 0.5, bz - sz * half], i * 9);
    const a = t - age < 0 ? 0 : 0.5 * (1 - u) ** 2;
    w.col.set([0.95, 0.98, 1, 0, 0.95, 0.98, 1, a, 0.95, 0.98, 1, 0], i * 12);
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
const _flip = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI);
function updateLamps(t) {
  for (const id of ['rus', 'alg']) {
    const lamp = lamps[id];
    const on = lampOn(t, id);
    lamp.sprite.visible = on;
    lamp.sprite.scale.setScalar(on ? 26 : 1);
    const beam = lamp.beam;
    beam.visible = on;
    if (!on) continue;
    const other = id === 'rus' ? 'alg' : 'rus';
    ships[id].ship.group.localToWorld(_from.set(9.2, 29, 0));
    ships[other].ship.group.localToWorld(_to.set(9.2, 22, 0));
    _dir.subVectors(_to, _from);
    const len = _dir.length();
    beam.position.copy(_from).addScaledVector(_dir, 0.5);
    beam.quaternion.setFromUnitVectors(_up, _dir.normalize());
    // A cone's apex is at +Y: flip it so the apex sits at the lamp.
    beam.quaternion.multiply(_flip);
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

// --- Markers: a ring above each ship that keeps its size on screen, so they stay findable from far away ---
const ringTexture = (hex) => canvasTexture(64, 64, (c) => {
  c.lineWidth = 7; c.strokeStyle = 'rgba(8,12,18,0.9)';
  c.beginPath(); c.arc(32, 32, 20, 0, Math.PI * 2); c.stroke();
  c.lineWidth = 4; c.strokeStyle = hex; c.stroke();
  c.fillStyle = hex; c.beginPath(); c.arc(32, 32, 5, 0, Math.PI * 2); c.fill();
});
const markers = {};
for (const [id, hex] of [['alg', '#3ddc84'], ['rus', '#ff7a1a']]) {
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: ringTexture(hex), depthTest: false, transparent: true, sizeAttenuation: false, fog: false }));
  sprite.scale.setScalar(0.05);
  sprite.renderOrder = 20;
  scene.add(sprite);
  markers[id] = sprite;
}
function updateMarkers() {
  for (const id of ['alg', 'rus']) {
    const pos = ships[id].ship.group.position;
    const a = THREE.MathUtils.smoothstep(camera.position.distanceTo(pos), 350, 900); // fades in as you pull away
    markers[id].position.copy(pos).setY(22);
    markers[id].material.opacity = a;
    markers[id].visible = a > 0.01;
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
  return { obj, title: el.querySelector('.tag-title'), body: el.querySelector('.tag-body') };
}
const tags = { alg: tag('ship', 'ALG', '#3ddc84'), rus: tag('ship', 'RUS', '#ff7a1a') };
const stationTag = tag('missile', 'STATION', '#ffffff');
const pad3 = (n) => String(Math.round(n) % 360).padStart(3, '0');
const NAME = { alg: 'ALG', rus: 'RUS' };
const fmtTag = (s) => `${pad3(headingDeg(s.heading))}° · ${(s.speed / KT).toFixed(0)}<span> kn</span>`;
const _mid = new THREE.Vector3();
function updateTags(t) {
  for (const id of ['alg', 'rus']) {
    const s = ships[id];
    tags[id].obj.position.copy(s.ship.group.position).setY(40);
    tags[id].body.innerHTML = fmtTag(s.state);
  }
  const rel = stationAt(t);
  const stTitle = `${NAME[rel.other]} FROM ${NAME[rel.guide]}`;
  if (stationTag.title.textContent !== stTitle) stationTag.title.textContent = stTitle;
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
// The Formation view keeps both ships in frame: it pulls back as they part and in as they close, until you
// zoom yourself (the wheel) or pick Formation again.
let autoZoom = true;
function setFocus(id, distance) {
  invalidate();
  autoZoom = id === 'formation';
  if (id === 'free' || !targets[id]) {
    rig.free();
  } else {
    const t = targets[id];
    rig.focus(id, t.pos, distance ?? t.distance, t.minDistance);
  }
  focusButtons.forEach((b) => b.classList.toggle('active', b.dataset.focus === rig.id));
}
for (const b of focusButtons) b.addEventListener('click', () => setFocus(b.dataset.focus));
canvas.addEventListener('wheel', () => { autoZoom = false; }, { passive: true });
const _off = new THREE.Vector3();
function applyAutoZoom(dt) {
  if (!autoZoom || rig.id !== 'formation' || rig.transition) return;
  const range = ships.alg.ship.group.position.distanceTo(ships.rus.ship.group.position);
  const want = Math.min(Math.max(range * 1.45 + 300, 650), 3200);
  _off.subVectors(camera.position, controls.target);
  const len = _off.length();
  if (len < 1) return;
  const next = len + (want - len) * (1 - Math.exp(-dt * 1.2));
  camera.position.copy(controls.target).addScaledVector(_off, next / len);
}

// --- Interface: readouts, serial box, toggles, menu --------------------------------------------------------
const hudRoot = document.querySelector('#hud');
const hudLive = hudRoot.querySelector('.hud-live');
const hudDebrief = hudRoot.querySelector('.hud-debrief');
hudDebrief.hidden = true;
const tile = (label, value, unit, cls = '') => `<div class="tile ${cls}"><span>${label}</span><b>${value}${unit ? `<small>${unit}</small>` : ''}</b></div>`;
const redTokens = (s) => s.replace(/\b(AS|AB|AC|ALG|RUS)\b/g, '<span class="red">$1</span>');
let lastPhase = null;
let lastLive = '';
// Two small cards attached under the top bar: the order's state and the ships' readouts. The signal text is
// the Signal dropdown of the top bar.
hudLive.innerHTML = '<div class="mcard mcard-order"><div class="mh-bar"><div class="mh-title"><b data-title></b><div class="mh-sub"><small data-step></small><span class="chip" data-chip></span></div></div>'
  + '<div class="mh-btns"><button type="button" data-hide title="Hide these cards (H, or the Readouts button)" aria-label="Hide">×</button></div></div>'
  + '<div class="mh-progress" title="How far through this order"><i data-progress></i></div></div>'
  + '<div class="mcard mcard-ships mh-ships" data-live></div>';
const bar = {
  title: hudLive.querySelector('[data-title]'), step: hudLive.querySelector('[data-step]'), chip: hudLive.querySelector('[data-chip]'),
  progress: hudLive.querySelector('[data-progress]'),
};
const liveEl = hudLive.querySelector('[data-live]');
let serialEl = null; // inside the Signal dropdown
let signalTitle = null;
const serialHtml = (phase) => (phase.note ? `<div class="serial-note">${phase.note}</div>` : '') + (phase.speeds ? `<div class="serial-speeds">${phase.speeds.map((s) => `<div>${s}</div>`).join('')}</div>` : '')
  + phase.serial.map((blk) => `<div class="serial-box">${blk.head ? `<div class="serial-head">${blk.head}</div>` : ''}${blk.lines.map((l) => `<div>${redTokens(l)}</div>`).join('')}</div>`).join('');
// A countdown: seconds under a minute, m:ss above.
const fmtCount = (sec) => (sec >= 60 ? `${Math.floor(sec / 60)}:${String(Math.ceil(sec % 60) % 60).padStart(2, '0')}` : `${Math.ceil(sec)}`);
const banner = document.querySelector('#shot-caption');
banner.classList.add('call');
let lastBanner = '';
function updateBanner(order) {
  let text = '';
  let cls = '';
  // STANDBY counts down to EXECUTE (getting ready); EXECUTE starts the maneuver; A STATION when in position.
  if (order.state === 'standby') { text = `STANDBY · ${fmtCount(order.count)}`; cls = 'standby'; } else if (order.state === 'execute') { text = `EXECUTE · ${order.phase.title}`; cls = 'execute'; } else if (order.state === 'station') { text = 'A STATION'; cls = 'station'; }
  if (text + cls === lastBanner) return;
  lastBanner = text + cls;
  banner.hidden = !text;
  banner.textContent = text;
  banner.classList.remove('standby', 'execute', 'station');
  if (cls) banner.classList.add(cls);
}
// A ship's heading and speed, with the ordered ones after an arrow while she is still turning or working up.
const angGap = (a, b) => Math.abs(((a - b + 540) % 360) - 180);
function mhCell(id, s, t) {
  const o = orderedAt(id, t);
  const hdg = headingDeg(s.heading);
  const kn = s.speed / KT;
  const toHdg = angGap(hdg, o.course) > 0.5 ? `<i>→${pad3(o.course)}°</i>` : '';
  const toKn = Math.abs(kn - o.speed) > 0.3 ? `<i>→${o.speed}</i>` : '';
  return `<div class="mh-cell ${id}" title="${NAME[id]}: heading and speed${toHdg || toKn ? ', then the ordered ones' : ''}"><span>${NAME[id]}</span>`
    + `<b>${pad3(hdg)}°${toHdg}</b><em>${kn.toFixed(0)}${toKn} kn</em></div>`;
}
const fmtClock = (sec) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
const setText = (el, text) => { if (el.textContent !== text) el.textContent = text; };
function updateReadout(t) {
  const order = orderStatus(t);
  const phase = order.phase;
  const idx = PHASES.indexOf(phase);
  const chip = t >= exercise.tEnd ? ['Complete', 'ok']
    : order.state === 'standby' ? [`Standby ${fmtCount(order.count)}`, 'warn']
      : order.state === 'execute' ? ['Execute', 'ok']
        : order.state === 'underway' ? [`Under way · station in ${fmtCount(order.count)}`, 'live']
          : order.state === 'station' || order.state === 'onstation' ? ['A station', 'ok'] : ['Standing by', ''];
  setText(bar.title, phase.title);
  // The plain words under the signal's own shorthand (TURN STBD 9 is a turn of 90 degrees).
  const plain = phase.label.toUpperCase() !== phase.title.toUpperCase() ? ` · ${phase.label}` : '';
  setText(bar.step, `Order ${idx + 1} of ${PHASES.length}${plain}`);
  setText(bar.chip, chip[0]);
  // The banner carries standby, execute and A STATION; the rest of the time the chip says where the order stands.
  const shown = order.state === 'underway' || order.state === 'onstation' || order.state === 'idle' ? ' shown' : '';
  if (bar.chip.dataset.tone !== chip[1] + shown) { bar.chip.dataset.tone = chip[1] + shown; bar.chip.className = `chip ${chip[1]}${shown}`; }
  const end = PHASES[idx + 1]?.t ?? exercise.tEnd;
  bar.progress.style.width = `${(Math.min(Math.max((t - phase.t) / (end - phase.t), 0), 1) * 100).toFixed(1)}%`;
  const rel = stationAt(t);
  // Closest point of approach, through the skim: the range RUS will pass at and when.
  const pass = exercise.pass;
  const cpa = phase.id === 'skim' && t < pass.t + 60
    ? `<div class="mh-cell cpa" title="Closest point of approach of RUS to ALG"><span>CPA</span><b>${Math.round(pass.range / YD)}</b>`
      + `<em>yd · ${t < pass.t ? `in ${fmtClock(pass.t - t)}` : 'passed'}</em></div>`
    : '';
  const html = `<div class="mh-row">${mhCell('alg', ships.alg.state, t)}${mhCell('rus', ships.rus.state, t)}`
    + `<div class="mh-cell" title="Station: ${NAME[rel.other]}'s range and true bearing from the guide, ${NAME[rel.guide]}">`
    + `<span>${NAME[rel.other]} from ${NAME[rel.guide]}</span><b>${Math.round(rel.range / YD)}</b><em>yd · ${pad3(rel.bearing)}°</em></div>${cpa}</div>`;
  if (html !== lastLive) { liveEl.innerHTML = html; lastLive = html; }
  if (phase !== lastPhase) {
    lastPhase = phase;
    serialEl.innerHTML = serialHtml(phase);
    signalTitle.textContent = phase.title;
  }
  updateBanner(order);
  updateDebrief(t);
}

// Debrief, once the last order is done: how long each order took to arrive and how close it ended.
const debriefFrom = PHASES[PHASES.length - 1].ta + STATION_FLASH;
function debriefResult(r) {
  if (r.pass !== undefined) return `Passed at ${Math.round(r.pass / YD)} yd`;
  if (r.error) {
    const yd = Math.round(Math.abs(r.error.yd));
    return yd < 1 && Math.abs(r.error.deg) < 0.5 ? 'On station'
      : `${yd} yd ${r.error.yd < 0 ? 'inside' : 'outside'} · ${Math.abs(r.error.deg).toFixed(1)}°`;
  }
  return r.id === 'light' || r.id === 'flags' ? 'Serial done' : 'Steady';
}
const debriefHtml = '<div class="mcard mcard-deb"><div class="hud-head"><b>Debrief</b><span class="chip ok">Complete</span></div>'
  + `<div class="deb-head ok">Exercise complete · ${fmtClock(exercise.tEnd)}</div>`
  + '<div class="deb-rows" style="--cols:2"><em class="sub"></em><em class="sub">Arrived after</em><em class="sub">Result</em>'
  + DEBRIEF.map((r) => `<span>${r.label}</span><b>${fmtClock(r.settle)}</b><b>${debriefResult(r)}</b>`).join('') + '</div></div>';
let debriefShown = null;
function updateDebrief(t) {
  const on = t >= debriefFrom;
  if (on === debriefShown) return;
  debriefShown = on;
  hudDebrief.hidden = !on;
  if (on && !hudDebrief.firstChild) hudDebrief.innerHTML = debriefHtml;
}

let hudOn = true;
const hudButton = document.querySelector('#btn-hud');
let hudHint = false;
function setHud(on) {
  hudOn = on;
  hudRoot.hidden = !on;
  hudButton.classList.toggle('active', on);
  hudButton.setAttribute('aria-pressed', String(on));
  invalidate();
  if (!on && !hudHint) { hudHint = true; toast('Readouts hidden. The Readouts button or H brings them back.', 3800); }
}
hudButton.addEventListener('click', () => setHud(!hudOn));
hudLive.querySelector('[data-hide]').addEventListener('click', () => setHud(false));

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
// The Orders button and its dropdown (the list and the standby time) are built below, in the top bar.
let ordersEl = null;
let ordersButton = null;
let signalEl = null;
let signalButton = null;
let lastOrderIdx = -2;
function setOrders(open) {
  if (!ordersEl) return;
  ordersEl.hidden = !open;
  ordersButton.setAttribute('aria-expanded', String(open));
  if (open) { setMenu(false); setSignal(false); lastOrderIdx = -2; } // redraw once, scrolled to the current order
  invalidate();
}
function setSignal(open) {
  if (!signalEl) return;
  signalEl.hidden = !open;
  signalButton.setAttribute('aria-expanded', String(open));
  if (open) { setMenu(false); setOrders(false); }
  invalidate();
}
function setMenu(open) { menuEl.hidden = !open; menuButton.setAttribute('aria-expanded', String(open)); if (open) { setOrders(false); setSignal(false); } invalidate(); }
function setKeys(open) { keysEl.hidden = !open; invalidate(); }
function closePopovers() {
  const was = !menuEl.hidden || !keysEl.hidden || !!(ordersEl && !ordersEl.hidden) || !!(signalEl && !signalEl.hidden);
  setMenu(false); setKeys(false); setOrders(false); setSignal(false);
  return was;
}
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
  if (ordersEl && !ordersEl.hidden && !e.target.closest('#orders, #btn-orders')) setOrders(false);
  if (signalEl && !signalEl.hidden && !e.target.closest('#signal, #btn-signal')) setSignal(false);
}, true);
let panelFolded = false;
try { panelFolded = localStorage.getItem(FOLD_KEY) === '1'; } catch { /* storage unavailable */ }
setPanelFolded(panelFolded, false);
document.querySelector('#btn-ship').addEventListener('click', () => {
  try { sessionStorage.setItem('intercept.chooser', '1'); location.reload(); } catch { location.search = ''; }
});
// The cards hang just under the top bar, whatever its height is at this window width.
if (typeof ResizeObserver === 'function') {
  const topbar = document.querySelector('#topbar');
  new ResizeObserver(() => {
    document.documentElement.style.setProperty('--bar-h', `${topbar.offsetHeight}px`);
    document.documentElement.style.setProperty('--bar-w', `${topbar.offsetWidth}px`);
  }).observe(topbar);
}
{
  const t = menuText('maneuvers'); // the same words as the start screen (menu.js)
  document.querySelector('.brand b').textContent = t.brand;
  document.querySelector('#mission-sub').textContent = t.sub;
}

// --- Orders: the briefing's contents column, now a dropdown from the top bar ---------------------------------
// A tick on each finished order, the current one highlighted, click one to jump to it; the standby time is set at the foot.
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
ordersButton = document.createElement('button');
ordersButton.id = 'btn-orders';
ordersButton.className = 'icon';
ordersButton.setAttribute('aria-haspopup', 'true');
ordersButton.setAttribute('aria-expanded', 'false');
ordersButton.setAttribute('aria-controls', 'orders');
ordersButton.title = 'The orders of the drill: jump to one, set the standby time (O)';
ordersButton.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6h11M9 12h11M9 18h11"/><path d="M3.5 6l1.2 1.2L6.8 5M3.5 12l1.2 1.2L6.8 11M3.5 18l1.2 1.2L6.8 17"/></svg><span class="cap">Orders</span>';
menuButton.parentElement.insertBefore(ordersButton, menuButton);
ordersEl = document.createElement('div');
ordersEl.id = 'orders';
ordersEl.className = 'orders-menu';
ordersEl.hidden = true;
ordersEl.innerHTML = '<div class="orders-head"><b>Orders</b><small>Click one to jump to it</small></div>'
  + `<ol class="orders-list">${PHASES.map((p, i) => `<li><button type="button" class="order" data-i="${i}" title="Jump to just before this order is announced"><span class="chk"></span><span class="name">${p.label}</span><span class="when">${mmss(p.t)}</span></button></li>`).join('')}</ol>`
  + '<div class="mh-standby" title="The time to get ready between the announcement of an order and EXECUTE, when the ships start to maneuver. Changing it reloads the scene at this moment."><span>Standby time</span>'
  + '<div class="mh-step"><button type="button" data-sb="-1" aria-label="Shorter standby">–</button><b data-sb-val></b><button type="button" data-sb="1" aria-label="Longer standby">+</button></div></div>';
document.querySelector('#topbar').appendChild(ordersEl);
ordersButton.addEventListener('click', () => setOrders(ordersEl.hidden));

// The signal text of the current order: a dropdown from the top bar, beside Orders.
signalButton = document.createElement('button');
signalButton.id = 'btn-signal';
signalButton.className = 'icon';
signalButton.setAttribute('aria-haspopup', 'true');
signalButton.setAttribute('aria-expanded', 'false');
signalButton.setAttribute('aria-controls', 'signal');
signalButton.title = 'The signal text of the current order (I)';
signalButton.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v11H9l-5 4z"/><path d="M8 9.5h8M8 12.5h5"/></svg><span class="cap">Signal</span>';
ordersButton.parentElement.insertBefore(signalButton, ordersButton);
signalEl = document.createElement('div');
signalEl.id = 'signal';
signalEl.className = 'signal-menu';
signalEl.hidden = true;
signalEl.innerHTML = '<div class="orders-head"><b>Signal text</b><small data-signal-title></small></div><div data-serial></div>';
document.querySelector('#topbar').appendChild(signalEl);
serialEl = signalEl.querySelector('[data-serial]');
signalTitle = signalEl.querySelector('[data-signal-title]');
signalButton.addEventListener('click', () => setSignal(signalEl.hidden));
const orderButtons = [...ordersEl.querySelectorAll('.order')];
function updateOrders(t) {
  const idx = t >= exercise.tEnd ? PHASES.length : PHASES.indexOf(phaseAt(t));
  if (idx === lastOrderIdx) return;
  lastOrderIdx = idx;
  orderButtons.forEach((b, i) => {
    b.classList.toggle('done', i < idx);
    b.classList.toggle('current', i === idx);
    if (i === idx && !ordersEl.hidden) b.scrollIntoView({ block: 'nearest' });
  });
}

// --- Sound: horns on the orders and serials, a click per flash of the lamp -------------------------------
const audio = createManeuverAudio();
const soundButton = document.querySelector('#btn-sound');
function setSound(on) {
  audio.setEnabled(on);
  soundButton.classList.toggle('active', on);
  soundButton.setAttribute('aria-pressed', String(on));
  try { localStorage.setItem('intercept.sound', on ? '1' : '0'); } catch { /* storage unavailable */ }
  invalidate();
}
let soundPref = true;
try { soundPref = localStorage.getItem('intercept.sound') !== '0'; } catch { /* storage unavailable */ }
audio.setEnabled(soundPref);
soundButton.classList.toggle('active', soundPref);
soundButton.setAttribute('aria-pressed', String(soundPref));
if (!audio.supported) { soundButton.disabled = true; soundButton.title = 'Sound is not available in this browser'; }
soundButton.addEventListener('click', () => setSound(!audio.enabled));

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
    if (key === 's' || key === 'S') setSound(!audio.enabled);
    if (key === 'o' || key === 'O') setOrders(ordersEl.hidden);
    if (key === 'i' || key === 'I') setSignal(signalEl.hidden);
    if (key === 'c' || key === 'C') setPanelFolded(!document.body.classList.contains('ui-hidden'));
  },
});
// Standby time: the stepper at the foot of the Orders dropdown. The ships' orders execute at fixed times, so this only moves
// when each order is announced; it is applied by reloading the scene at this moment, a second after the last click.
const sbVal = ordersEl.querySelector('[data-sb-val]');
let sbPending = STANDBY;
let sbTimer = 0;
sbVal.textContent = `${STANDBY} s`;
for (const b of ordersEl.querySelectorAll('[data-sb]')) {
  b.addEventListener('click', () => {
    sbPending = Math.min(Math.max(sbPending + Number(b.dataset.sb), STANDBY_LIMITS[0]), STANDBY_LIMITS[1]);
    sbVal.textContent = `${sbPending} s`;
    sbVal.classList.toggle('pending', sbPending !== STANDBY);
    clearTimeout(sbTimer);
    if (sbPending === STANDBY) return;
    sbTimer = setTimeout(() => {
      try {
        localStorage.setItem('intercept.standby', String(sbPending));
        sessionStorage.setItem('intercept.skip', '1'); // straight back into the exercise
        sessionStorage.setItem('intercept.seek', String(clock.t));
      } catch { toast('Could not save the setting (browser storage is blocked).'); return; }
      stripShareParams();
      location.reload();
    }, 1000);
  });
}

// Clicking an order in the list jumps to just before it is announced.
orderButtons.forEach((b, i) => b.addEventListener('click', () => { clock.seek(Math.max(PHASES[i].t - 1, 0)); setOrders(false); invalidate(); }));
// About 52 minutes of exercise: sixteen times real time by default. Time never slows for an order: STANDBY
// counts down to EXECUTE, the ships maneuver, and A STATION is called when they are in position.
clock.setSpeed(16);
// Deep link: ?t= opens paused at that moment; the standby stepper reloads at the same moment, playing.
try {
  const t = parseFloat(new URLSearchParams(location.search).get('t'));
  const back = parseFloat(sessionStorage.getItem('intercept.seek'));
  sessionStorage.removeItem('intercept.seek');
  if (Number.isFinite(t)) { clock.playing = false; clock.seek(t); } else if (Number.isFinite(back)) clock.seek(back);
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
  applyAutoZoom(dt);
  controls.update();
  if (camera.position.y < 1) camera.position.y = 1;
  const close = rig.id === 'alg' || rig.id === 'rus';
  env.setShadowFocus(close ? targets[rig.id].pos(shadowCenter) : targets.formation.pos(shadowCenter), close ? 150 : 1300);
  clock.renderUI();
  updateReadout(t);
  updateOrders(t);
  updateMarkers();
  audio.update(t, camera, { alg: ships.alg.ship.group.position, rus: ships.rus.ship.group.position }, clock);
  map.update(t);
  if (needsRender()) {
    renderer.render(scene, camera);
    labelRenderer.render(scene, camera);
    drawn.t = t; drawn.inv = invalidations; drawn.mat.set(camera.matrixWorld.elements);
    loadingEl?.remove();
  }
});

toast('Plays at 16×. Each order: STANDBY, then EXECUTE (the ships start), then A STATION. Speed: the button or [ ].', 4500);

// Debug / inspection handle (mirrors the intercept scene's).
window.__scene = { exercise, clock, rig, camera, controls, setFocus, ships, scene, renderer };

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { createEnvironment } from './environment.js';
import { createShip } from './models/ship.js';
import { CameraRig } from './cameraRig.js';
import { createTimeline } from './timeline.js';
import { toast } from './pathEditor.js';
import { menuText } from './menu.js';
import {
  exercise, shipState, stationPoint, orderStatus, headingDeg, PHASES, SHIP_IDS, SHIP_NAMES, KT, ON_STATION, orderedYd,
} from './formations.js';

// Entry point of the "Four-ship formations" mission (see formations.js): SHIP1 to SHIP4 change formation and
// do nothing else. Every visual is a pure function of the clock, so the timeline scrubs both ways. start.js
// imports this instead of main.js when that mission is picked.

const COLORS = { ship1: 0x3ddc84, ship2: 0xff7a1a, ship3: 0x5ab4ff, ship4: 0xd27bff };
const CSS = Object.fromEntries(Object.entries(COLORS).map(([id, c]) => [id, `#${c.toString(16).padStart(6, '0')}`]));
const FLASH = 8; // s the station rings stay up after the formation arrives
const mmss = (s) => `${Math.floor(Math.max(s, 0) / 60)}:${String(Math.floor(Math.max(s, 0) % 60)).padStart(2, '0')}`;
const pad3 = (d) => String(Math.round(d) % 360).padStart(3, '0');
const $ = (s) => document.querySelector(s);
const readPref = (key, fallback) => { try { const v = localStorage.getItem(key); return v === null ? fallback : v === '1'; } catch { return fallback; } };
const writePref = (key, on) => { try { localStorage.setItem(key, on ? '1' : '0'); } catch { /* storage unavailable */ } };

const canvas = $('#scene');
const loadingEl = $('#loading');
// The drill's look and layout (body.mission-maneuvers in style.css), plus a few rules of its own.
document.body.classList.add('mission-maneuvers', 'mission-formations');
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

const env = createEnvironment(renderer, scene, { calm: true });
env.setShadowSize(1024);

// --- Ships ------------------------------------------------------------------------------------------------
const ships = Object.fromEntries(SHIP_IDS.map((id) => [id, { id, ship: createShip({ ensign: 'alg' }), state: {} }]));
for (const s of Object.values(ships)) scene.add(s.ship.group);
function placeShip(s, t) {
  shipState(s.id, t, s.state);
  s.ship.group.position.set(s.state.x, 0, s.state.z);
  s.ship.group.rotation.y = -s.state.heading; // the model's bow is +X; the compass heading runs clockwise from North
  s.ship.update(1000 + t, Infinity); // a time that finds the intercept mission's launcher and catapult stowed
}

// --- Wakes: a foam ribbon along each ship's recent track (as in the drill) ---------------------------------
const WAKE_STEPS = 40;
const WAKE_SPAN = 90;
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
  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: true }));
  mesh.frustumCulled = false;
  mesh.renderOrder = 2;
  scene.add(mesh);
  return { pos, col, geo };
}
const wakes = Object.fromEntries(SHIP_IDS.map((id) => [id, createWake()]));
const _w = {};
const _w2 = {};
function updateWake(id, t) {
  const w = wakes[id];
  for (let i = 0; i < WAKE_STEPS; i++) {
    const u = i / (WAKE_STEPS - 1);
    const tt = Math.max(t - u * WAKE_SPAN, 0);
    shipState(id, tt, _w);
    shipState(id, Math.max(tt - 2, 0), _w2);
    const dh = Math.atan2(Math.sin(_w.heading - _w2.heading), Math.cos(_w.heading - _w2.heading));
    const turn = Math.min(Math.abs(dh) * 90 / Math.PI / 1.5, 1.4);
    const half = (3 + 11 * Math.sqrt(u)) * (1 + 0.7 * turn);
    const sx = -Math.sin(_w.heading);
    const sz = Math.cos(_w.heading);
    const bx = _w.x - Math.cos(_w.heading) * 55;
    const bz = _w.z - Math.sin(_w.heading) * 55;
    w.pos.set([bx + sx * half, 0.5, bz + sz * half, bx, 0.5, bz, bx - sx * half, 0.5, bz - sz * half], i * 9);
    const a = t - u * WAKE_SPAN < 0 ? 0 : Math.min(0.5 * (1 - u) ** 2 * (1 + 0.5 * turn), 0.85);
    w.col.set([0.95, 0.98, 1, 0, 0.95, 0.98, 1, a, 0.95, 0.98, 1, 0], i * 12);
  }
  w.geo.attributes.position.needsUpdate = true;
  w.geo.attributes.color.needsUpdate = true;
}

// --- Tracks: the part already steamed, as dots in each ship's colour (T) -----------------------------------
const resolution = new THREE.Vector2(window.innerWidth, window.innerHeight);
const lineMats = [];
function trackLine(id) {
  const pts = [];
  for (let t = 0; t <= exercise.tEnd; t += 3) { shipState(id, t, _w); pts.push(_w.x, 2, _w.z); }
  const flat = new Float32Array(pts);
  const geo = new LineGeometry().setPositions(flat);
  const mat = new LineMaterial({ color: COLORS[id], linewidth: 3, transparent: true, opacity: 0.9, depthWrite: false, resolution, worldUnits: false, dashed: true, dashSize: 3, gapSize: 12 });
  lineMats.push(mat);
  const line = new Line2(geo, mat);
  line.computeLineDistances();
  line.frustumCulled = false;
  line.renderOrder = 4;
  scene.add(line);
  const segs = flat.length / 3 - 1;
  return { line, set(t) { geo.instanceCount = Math.max(0, Math.min(segs, Math.ceil((t / exercise.tEnd) * segs))); } };
}
const tracks = Object.fromEntries(SHIP_IDS.map((id) => [id, trackLine(id)]));

// --- Station rings: where each ship is to be under the order in progress ------------------------------------
// In the ship's colour while she works toward it; they fade out once the whole formation is on station.
const stationRings = {};
for (const id of SHIP_IDS.slice(1)) {
  const m = new THREE.Mesh(new THREE.RingGeometry(0.82, 1, 48).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: COLORS[id], transparent: true, opacity: 0.85, depthWrite: false, side: THREE.DoubleSide, fog: false }));
  m.renderOrder = 5;
  m.visible = false;
  scene.add(m);
  stationRings[id] = m;
}
const _sp = {};
function updateStationRings(t) {
  const o = orderStatus(t);
  const fade = o.idx === 0 ? 0 : o.state === 'underway' ? 0.85 : 0.85 * (1 - THREE.MathUtils.smoothstep(o.since, 0, FLASH));
  for (const id of SHIP_IDS.slice(1)) {
    const m = stationRings[id];
    m.visible = fade > 0.01;
    if (!m.visible) continue;
    stationPoint(id, t, _sp);
    m.position.set(_sp.x, 2.5, _sp.z);
    m.scale.setScalar(Math.min(Math.max(camera.position.distanceTo(m.position) / 30, 28), 90) * (1 + 0.05 * Math.sin(t * 2.4)));
    m.material.color.set(_sp.error <= ON_STATION ? 0x3ddc84 : COLORS[id]);
    m.material.opacity = fade;
  }
}

// --- Tags -----------------------------------------------------------------------------------------------------
const labelRenderer = new CSS2DRenderer();
labelRenderer.domElement.className = 'labels-layer';
document.body.appendChild(labelRenderer.domElement);
const labelGroup = new THREE.Group();
scene.add(labelGroup);
const tags = {};
for (const id of SHIP_IDS) {
  const el = document.createElement('div');
  el.className = 'tag tag-ship';
  el.style.borderLeftColor = CSS[id];
  el.style.pointerEvents = 'none';
  el.innerHTML = `<div class="tag-title">${SHIP_NAMES[id]}${id === 'ship1' ? ' · guide' : ''}</div><div class="tag-body"></div>`;
  const obj = new CSS2DObject(el);
  obj.center.set(0.5, 1);
  labelGroup.add(obj);
  tags[id] = { obj, el, lift: 0, body: el.querySelector('.tag-body') };
}
const _tp = new THREE.Vector3();
const TAG_GAP = 4; // px kept between two tags on screen
function updateTags() {
  for (const id of SHIP_IDS) {
    const s = ships[id];
    const dist = camera.position.distanceTo(s.ship.group.position);
    tags[id].obj.position.copy(s.ship.group.position).setY(Math.min(Math.max(dist * 0.05, 26), 60));
    const html = `${pad3(headingDeg(s.state.heading))}° · ${(s.state.speed / KT).toFixed(0)}<span> kn</span>`;
    if (tags[id].body.innerHTML !== html) tags[id].body.innerHTML = html;
  }
}
// The ships sail close together, so their tags would cover each other: on screen, a tag that would overlap one
// already placed is lifted above it, its stem stretched down to its ship. Nearest ships first (lowest on screen).
function declutterTags() {
  if (!labelsOn) return;
  const w = window.innerWidth;
  const h = window.innerHeight;
  const items = SHIP_IDS.map((id) => {
    const t = tags[id];
    _tp.copy(t.obj.position).project(camera);
    return { t, x: (_tp.x + 1) / 2 * w, y: (1 - _tp.y) / 2 * h, bw: t.el.offsetWidth, bh: t.el.offsetHeight, front: _tp.z < 1 };
  }).sort((a, b) => b.y - a.y);
  const placed = [];
  for (const it of items) {
    let bottom = it.y - 14; // the tag's bottom edge sits 14 px above its anchor (the stem)
    if (it.front) {
      for (let pass = 0; pass < 8; pass++) {
        const hit = placed.find((p) => Math.abs(p.x - it.x) < (p.bw + it.bw) / 2 + TAG_GAP && bottom > p.top - TAG_GAP && bottom - it.bh < p.bottom + TAG_GAP);
        if (!hit) break;
        bottom = hit.top - TAG_GAP;
      }
      placed.push({ x: it.x, bw: it.bw, top: bottom - it.bh, bottom });
    }
    const lift = Math.max(0, Math.round(it.y - 14 - bottom));
    if (it.t.lift !== lift) {
      it.t.lift = lift;
      it.t.obj.center.set(0.5, 1 + lift / Math.max(it.bh, 1));
      it.t.el.style.setProperty('--lift', `${lift}px`);
    }
  }
}

// --- Camera: free, one ship, or the whole formation ------------------------------------------------------------
const rig = new CameraRig(camera, controls);
const centroid = (t, out) => {
  out.set(0, 0, 0);
  for (const id of SHIP_IDS) { shipState(id, t, _w); out.x += _w.x / 4; out.z += _w.z / 4; }
  return out.setY(10);
};
const targets = {
  ...Object.fromEntries(SHIP_IDS.map((id) => [id, { pos: (out) => out.copy(ships[id].ship.group.position).setY(12), dist: 420, min: 60 }])),
  formation: { pos: (out) => centroid(clock.t, out), dist: 1500, min: 200 },
};
const camButtons = [...document.querySelectorAll('[data-focus]')];
function setFocus(id) {
  if (id === 'free' || !targets[id]) rig.free();
  else rig.focus(id, targets[id].pos, targets[id].dist, targets[id].min);
  for (const b of camButtons) b.classList.toggle('active', b.dataset.focus === (targets[id] ? id : 'free'));
  invalidate();
}
// The camera picker: Free, SHIP1 to SHIP4, Formation.
{
  const seg = $('.seg.cam');
  seg.innerHTML = [['free', 'Free', 'Esc'], ...SHIP_IDS.map((id, i) => [id, SHIP_NAMES[id], String(i + 1)]), ['formation', 'Formation', '5']]
    .map(([id, label, key]) => `<button data-focus="${id}" title="${label} (${key})">${label}</button>`).join('');
  camButtons.length = 0;
  camButtons.push(...seg.querySelectorAll('[data-focus]'));
  for (const b of camButtons) b.addEventListener('click', () => { setFocus(b.dataset.focus); b.blur(); });
  // On wide windows the camera buttons move to a strip at the top centre, as in the drill.
  const home = seg.parentElement;
  const strip = document.createElement('div');
  strip.id = 'camstrip';
  strip.className = 'camstrip';
  document.body.appendChild(strip);
  const wide = window.matchMedia('(min-width: 1100px)');
  const place = () => { if (wide.matches) strip.appendChild(seg); else home.prepend(seg); invalidate(); };
  place();
  wide.addEventListener?.('change', place);
}

// --- Readouts: the drill's two cards under the top bar: the order, then the four ships ---------------------------
const hud = $('#hud');
const hudLive = hud.querySelector('.hud-live');
hud.querySelector('.hud-spark').replaceChildren();
hud.querySelector('.hud-debrief').hidden = true;
hudLive.innerHTML = '<div class="mcard mcard-order"><div class="mh-bar"><div class="mh-title"><b data-title></b><div class="mh-sub"><small data-step></small><span class="chip" data-chip></span></div></div>'
  + '<div class="mh-btns"><button type="button" data-hide title="Hide these cards (H, or the Readouts button)" aria-label="Hide">×</button></div></div>'
  + '<div class="mh-progress" title="How far through this order"><i data-progress></i></div><div class="mh-next" data-next></div></div>'
  + '<div class="mcard mcard-ships mh-ships"><div class="mh-row" data-live></div></div>';
const bar = {
  title: hudLive.querySelector('[data-title]'), step: hudLive.querySelector('[data-step]'), chip: hudLive.querySelector('[data-chip]'),
  progress: hudLive.querySelector('[data-progress]'), next: hudLive.querySelector('[data-next]'),
};
const liveEl = hudLive.querySelector('[data-live]');
const setText = (el, text) => { if (el.textContent !== text) el.textContent = text; };
let liveKey = '';
function updateHud(t) {
  const o = orderStatus(t);
  const p = o.phase;
  const chip = o.idx === 0 ? ['Standing by', ''] : o.state === 'underway' ? [`Under way · ${mmss(o.count)}`, 'live'] : o.next === null ? ['Complete', 'ok'] : ['A station', 'ok'];
  setText(bar.title, p.title);
  setText(bar.step, `Order ${o.idx + 1} of ${PHASES.length} · ${p.name}`);
  setText(bar.chip, chip[0]);
  const cls = `chip ${chip[1]} shown`;
  if (bar.chip.className !== cls) bar.chip.className = cls;
  bar.chip.title = p.note;
  const end = PHASES[o.idx + 1]?.tx ?? exercise.tEnd;
  bar.progress.style.width = `${(Math.min(Math.max((t - p.tx) / (end - p.tx), 0), 1) * 100).toFixed(1)}%`;
  const next = PHASES[o.idx + 1];
  const nextText = next ? `Next: ${next.label} · ${next.name} in ${mmss(next.tx - t)}` : '';
  setText(bar.next, nextText);
  bar.next.hidden = !nextText;
  if (next) bar.next.title = next.note;
  // One row per ship: name, heading, then speed and how far she is off her station.
  const html = SHIP_IDS.map((id) => {
    const s = ships[id].state;
    const err = stationPoint(id, t, _sp).error;
    const st = id === 'ship1' ? 'guide' : err <= ON_STATION ? 'on stn' : `${Math.round(orderedYd(err))} yd`;
    return `<div class="mh-cell ${id}" title="${SHIP_NAMES[id]}: heading, speed and distance from the ordered station"><span>${SHIP_NAMES[id]}</span>`
      + `<b>${pad3(headingDeg(s.heading))}°</b><em>${(s.speed / KT).toFixed(0)} kn · ${st}</em></div>`;
  }).join('');
  if (html !== liveKey) { liveEl.innerHTML = html; liveKey = html; }
}

// The call, as in the drill: EXECUTE through the maneuver, then A STATION until the next order.
const banner = $('#shot-caption');
let bannerKey = '';
function updateBanner(t) {
  const o = orderStatus(t);
  let text = '';
  let cls = '';
  if (o.idx > 0 && o.state === 'underway') { text = `EXECUTE · ${o.phase.label}`; cls = 'execute'; } // short: the banner is the map's width
  else if (o.idx > 0) { text = 'A STATION'; cls = 'station'; }
  if (text + cls === bannerKey) return;
  bannerKey = text + cls;
  banner.hidden = !text;
  banner.textContent = text;
  banner.className = `shot-caption call ${cls}`;
}

// The timeline on end down the left (wide windows), as in the drill: the same line and chapters, time running
// down; drag the line or click a name. The horizontal bar is hidden then.
const vtrack = document.createElement('div');
vtrack.id = 'vtrack';
vtrack.className = 'vtrack';
vtrack.innerHTML = '<div class="vt-rail"><i class="vt-fill"></i><i class="vt-thumb"></i></div><svg class="vt-lead" aria-hidden="true"></svg><div class="vt-labels"></div>';
document.body.appendChild(vtrack);
const vtRail = vtrack.querySelector('.vt-rail');
const vtLead = vtrack.querySelector('.vt-lead');
const vtEvents = PHASES.map((p) => {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'vt-label';
  el.textContent = `${p.label} · ${p.name}`;
  el.title = `${p.title} · ${mmss(p.tx)}`;
  el.addEventListener('click', () => { clock.playing = false; clock.seek(p.tx); invalidate(); });
  vtrack.querySelector('.vt-labels').appendChild(el);
  return { t: p.tx, el };
});
let vtDone = -2;
function layoutVTrack() {
  const h = vtrack.clientHeight;
  if (h < 40) return;
  const GAP = 19;
  const ys = vtEvents.map((e) => (e.t / exercise.tEnd) * (h - 12) + 6);
  const ly = ys.slice();
  for (let i = 1; i < ly.length; i++) ly[i] = Math.max(ly[i], ly[i - 1] + GAP); // push down
  const over = ly[ly.length - 1] - (h - 8);
  if (over > 0) for (let i = ly.length - 1; i >= 0; i--) { ly[i] -= over; if (i < ly.length - 1) ly[i] = Math.min(ly[i], ly[i + 1] - GAP); } // pull back up
  let d = '';
  vtEvents.forEach((e, i) => {
    e.el.style.top = `${ly[i] - 9}px`;
    d += `<path d="M13 ${ys[i].toFixed(1)} H20 L28 ${ly[i].toFixed(1)}"/><circle cx="13" cy="${ys[i].toFixed(1)}" r="2.6"/>`;
  });
  vtLead.innerHTML = d;
  vtDone = -2;
}
function seekFromRail(e) {
  const r = vtRail.getBoundingClientRect();
  clock.playing = false;
  clock.seek(Math.min(Math.max((e.clientY - r.top) / r.height, 0), 1) * exercise.tEnd);
  invalidate();
}
let vtDrag = false;
vtRail.addEventListener('pointerdown', (e) => { vtDrag = true; vtRail.setPointerCapture?.(e.pointerId); seekFromRail(e); });
vtRail.addEventListener('pointermove', (e) => { if (vtDrag) seekFromRail(e); });
vtRail.addEventListener('pointerup', () => { vtDrag = false; });
vtRail.addEventListener('pointercancel', () => { vtDrag = false; });
function updateVTrack(t) {
  vtrack.style.setProperty('--p', Math.min(Math.max(t / exercise.tEnd, 0), 1).toFixed(4));
  let cur = -1;
  vtEvents.forEach((e, i) => { if (t >= e.t) cur = i; });
  if (cur === vtDone) return;
  vtDone = cur;
  vtEvents.forEach((e, i) => { e.el.classList.toggle('passed', i <= cur); e.el.classList.toggle('current', i === cur); });
}
// A frame later: changing layout inside a ResizeObserver callback is a loop error.
let vtPending = 0;
const relayoutVTrack = () => { if (!vtPending) vtPending = requestAnimationFrame(() => { vtPending = 0; layoutVTrack(); }); };
if (typeof ResizeObserver === 'function') new ResizeObserver(relayoutVTrack).observe(vtrack);
window.addEventListener('resize', relayoutVTrack);

// --- Map: north up, centred on the formation, with each ship and its station --------------------------------
const mapEl = $('#minimap');
const mapCanvas = mapEl.querySelector('canvas');
const mapScale = mapEl.querySelector('.mm-scale');
const mapCtx = mapCanvas.getContext('2d');
let mapOn = readPref('intercept.map', true);
let mapKey = '';
function setMap(on) {
  mapOn = on;
  mapEl.hidden = !on;
  document.body.classList.toggle('has-map', on);
  $('#btn-map').setAttribute('aria-pressed', String(on));
  writePref('intercept.map', on);
  mapKey = '';
  invalidate();
}
const _c = new THREE.Vector3();
function updateMap(t) {
  if (!mapOn) return;
  const d = Math.round(parseFloat(getComputedStyle(document.body).getPropertyValue('--map-d'))) || 150;
  const key = `${t}|${d}`;
  if (key === mapKey) return;
  mapKey = key;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  if (mapCanvas.width !== d * dpr) { mapCanvas.width = mapCanvas.height = d * dpr; mapCanvas.style.width = mapCanvas.style.height = `${d}px`; }
  const ctx = mapCtx;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, d, d);
  centroid(t, _c);
  const pts = SHIP_IDS.map((id) => ({ id, s: shipState(id, t), p: stationPoint(id, t) }));
  let span = 300;
  for (const q of pts) span = Math.max(span, Math.abs(q.s.x - _c.x), Math.abs(q.s.z - _c.z), Math.abs(q.p.x - _c.x), Math.abs(q.p.z - _c.z));
  const k = (d / 2 - 24) / (span * 1.1); // px per metre, clear of the rim and the scale line
  const X = (z) => d / 2 + (z - _c.z) * k; // east is right
  const Y = (x) => d / 2 - (x - _c.x) * k; // north is up
  ctx.strokeStyle = 'rgba(255,255,255,0.12)';
  ctx.lineWidth = 1;
  for (const r of [0.33, 0.66, 1]) { ctx.beginPath(); ctx.arc(d / 2, d / 2, (d / 2 - 6) * r, 0, Math.PI * 2); ctx.stroke(); }
  ctx.fillStyle = 'rgba(255,255,255,0.6)';
  ctx.font = '9px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('N', d / 2, 11);
  const o = orderStatus(t);
  const showStations = o.idx > 0 && (o.state === 'underway' || o.since < FLASH);
  for (const q of pts) {
    if (showStations && q.id !== 'ship1') {
      ctx.strokeStyle = CSS[q.id];
      ctx.globalAlpha = 0.8;
      ctx.beginPath(); ctx.arc(X(q.p.z), Y(q.p.x), 4, 0, Math.PI * 2); ctx.stroke();
      ctx.globalAlpha = 1;
    }
    const x = X(q.s.z);
    const y = Y(q.s.x);
    const h = q.s.heading;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(h);
    ctx.fillStyle = CSS[q.id];
    ctx.beginPath(); ctx.moveTo(0, -7); ctx.lineTo(4, 5); ctx.lineTo(0, 3); ctx.lineTo(-4, 5); ctx.closePath(); ctx.fill();
    ctx.restore();
    ctx.fillStyle = CSS[q.id];
    ctx.fillText(q.id.slice(-1), x + 9, y + 3);
  }
  const yards = Math.round(orderedYd(span * 1.1) / 100) * 100; // in ordered yards, like every other number
  mapScale.textContent = `${yards} yd to the rim`;
}

// --- Top bar and More menu: only what this mission uses ------------------------------------------------------
{
  const t = menuText('formations');
  $('.brand b').textContent = t.brand;
  $('#mission-sub').textContent = t.sub;
  for (const sel of ['#btn-director', '#btn-sound', '#btn-edit', '#btn-engage', '#btn-units', '#btn-record', '#btn-link', '#dl-offline', '#btn-grid']) {
    const el = $(sel);
    if (el) { el.hidden = true; el.style.display = 'none'; } // the bar's buttons are laid out as grids, which beat [hidden]
  }
}
let labelsOn = readPref('intercept.labels', true);
function setLabels(on) {
  labelsOn = on;
  labelGroup.visible = on;
  labelRenderer.domElement.style.display = on ? '' : 'none';
  $('#btn-labels').classList.toggle('active', on);
  $('#btn-labels').setAttribute('aria-pressed', String(on));
  writePref('intercept.labels', on);
  invalidate();
}
let trailsOn = readPref('intercept.trails', true);
function setTrails(on) {
  trailsOn = on;
  for (const k of Object.values(tracks)) k.line.visible = on;
  $('#btn-trails').classList.toggle('active', on);
  $('#btn-trails').setAttribute('aria-pressed', String(on));
  writePref('intercept.trails', on);
  invalidate();
}
let hudOn = readPref('intercept.hud', true);
function setHud(on) {
  hudOn = on;
  hud.hidden = !on;
  $('#btn-hud').classList.toggle('active', on);
  $('#btn-hud').setAttribute('aria-pressed', String(on));
  writePref('intercept.hud', on);
}
const menuEl = $('#menu');
const menuBtn = $('#btn-menu');
const keysEl = $('#keys');
function setMenu(open) { menuEl.hidden = !open; menuBtn.setAttribute('aria-expanded', String(open)); }
function setKeys(open) { keysEl.hidden = !open; if (open) setMenu(false); }
menuBtn.addEventListener('click', (e) => { e.stopPropagation(); setMenu(menuEl.hidden); });
document.addEventListener('pointerdown', (e) => {
  if (!menuEl.hidden && !e.target.closest('#menu, #btn-menu')) setMenu(false);
}, true);
$('#btn-labels').addEventListener('click', () => setLabels(!labelsOn));
$('#btn-trails').addEventListener('click', () => setTrails(!trailsOn));
$('#btn-hud').addEventListener('click', () => setHud(!hudOn));
$('#btn-map').addEventListener('click', () => { setMap(!mapOn); setMenu(false); });
$('#btn-keys').addEventListener('click', () => setKeys(true));
hudLive.querySelector('[data-hide]').addEventListener('click', () => setHud(false));
function toggleFullscreen() {
  try {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen?.();
  } catch { /* not allowed here */ }
}
{
  const fsBtn = $('#btn-fullscreen');
  if (!document.fullscreenEnabled) fsBtn.hidden = true;
  fsBtn.addEventListener('click', () => { toggleFullscreen(); setMenu(false); });
  document.addEventListener('fullscreenchange', invalidate);
}
$('#keys-close').addEventListener('click', () => setKeys(false));
$('#btn-ship').addEventListener('click', () => {
  try { sessionStorage.setItem('intercept.chooser', '1'); location.reload(); } catch { location.search = ''; }
});
function setFolded(on) {
  document.body.classList.toggle('ui-hidden', on);
  $('#btn-unfold').hidden = !on;
  invalidate();
}
$('#btn-fold').addEventListener('click', () => setFolded(true));
$('#btn-unfold').addEventListener('click', () => setFolded(false));
keysEl.querySelector('dl').innerHTML = [
  ['<kbd>Space</kbd>', 'Play / pause'], ['<kbd>R</kbd>', 'Play backwards'], ['<kbd>←</kbd> <kbd>→</kbd>', 'Step 0.1 s (Shift: 1 s)'],
  ['<kbd>Home</kbd> <kbd>End</kbd>', 'Start / end'], ['<kbd>,</kbd> <kbd>.</kbd>', 'Previous / next order'], ['<kbd>[</kbd> <kbd>]</kbd>', 'Slower / faster'],
  ['<kbd>1</kbd>–<kbd>4</kbd>', 'Follow SHIP1 to SHIP4'], ['<kbd>5</kbd>', 'The whole formation'], ['<kbd>Esc</kbd>', 'Free camera'],
  ['<kbd>L</kbd> <kbd>T</kbd> <kbd>H</kbd>', 'Labels, tracks, readouts'], ['<kbd>M</kbd>', 'Map'], ['<kbd>F</kbd>', 'Fullscreen'], ['<kbd>C</kbd>', 'Hide / show the interface'],
].map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');

// --- Clock ------------------------------------------------------------------------------------------------------
const clock = createTimeline(exercise, {
  onKey(key, e) {
    if (e.ctrlKey || e.metaKey) return;
    if (key === 'Escape') {
      if (!menuEl.hidden) { setMenu(false); return; }
      if (!keysEl.hidden) { setKeys(false); return; }
      setFocus('free');
      return;
    }
    if (key === ',') clock.prevEvent();
    if (key === '.') clock.nextEvent();
    if (key === '[') clock.slower();
    if (key === ']') clock.faster();
    if (key === '?') setKeys(keysEl.hidden);
    if (key === '1' || key === '2' || key === '3' || key === '4') setFocus(SHIP_IDS[Number(key) - 1]);
    if (key === '5') setFocus('formation');
    if (key === 'l' || key === 'L') setLabels(!labelsOn);
    if (key === 't' || key === 'T') setTrails(!trailsOn);
    if (key === 'h' || key === 'H') setHud(!hudOn);
    if (key === 'm' || key === 'M') setMap(!mapOn);
    if (key === 'f' || key === 'F') toggleFullscreen();
    if (key === 'c' || key === 'C') setFolded(!document.body.classList.contains('ui-hidden'));
  },
});
clock.fmt = mmss;
clock.setSpeed(8);
$('#time-end').textContent = mmss(exercise.tEnd);
$('#time-end').nextSibling.textContent = '';

// The drill's layout hangs some panels from the top bar's size.
if (typeof ResizeObserver === 'function') {
  const topbar = $('#topbar');
  new ResizeObserver(() => requestAnimationFrame(() => {
    document.documentElement.style.setProperty('--bar-h', `${topbar.offsetHeight}px`);
    document.documentElement.style.setProperty('--bar-w', `${topbar.offsetWidth}px`);
  })).observe(topbar);
}
setLabels(labelsOn);
setTrails(trailsOn);
setHud(hudOn);
setMap(mapOn);

// Open on the whole formation, from astern and above.
for (const s of Object.values(ships)) placeShip(s, 0);
centroid(0, _c);
camera.position.set(_c.x - 1100, 650, _c.z + 520);
controls.target.copy(_c);
setFocus('formation');

// --- Loop ---------------------------------------------------------------------------------------------------------
function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h, false);
  labelRenderer.setSize(w, h);
  resolution.set(w, h);
  for (const m of lineMats) m.resolution.copy(resolution);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  mapKey = '';
  invalidate();
}
window.addEventListener('resize', resize);
resize();

const drawn = { t: NaN, inv: -1, mat: new Float64Array(16) };
function needsRender() {
  camera.updateMatrixWorld();
  const e = camera.matrixWorld.elements;
  for (let i = 0; i < 16; i++) if (Math.abs(e[i] - drawn.mat[i]) > 1e-5) return true;
  return clock.t !== drawn.t || invalidations !== drawn.inv;
}
const shadowCenter = new THREE.Vector3();
let last = performance.now();
renderer.setAnimationLoop((now) => {
  const dt = Math.max(0, Math.min((now - last) / 1000, 0.1));
  last = now;
  clock.tick(dt);
  const t = clock.t;
  for (const s of Object.values(ships)) placeShip(s, t);
  for (const id of SHIP_IDS) { updateWake(id, t); tracks[id].set(t); }
  updateStationRings(t);
  updateTags();
  const ou = env.ocean.material.uniforms;
  ou.uTime.value = t;
  ou.uShipX.value = 1e7; // no single-ship wake: each ship has its own ribbon
  rig.update();
  controls.update();
  if (camera.position.y < 1) camera.position.y = 1;
  env.follow(camera.position);
  camera.updateMatrixWorld();
  declutterTags(); // after the camera has moved this frame, so the tags are pushed apart where they are drawn
  const close = SHIP_IDS.includes(rig.id);
  env.setShadowFocus(close ? targets[rig.id].pos(shadowCenter) : centroid(t, shadowCenter), close ? 150 : 1300);
  clock.renderUI();
  if (hudOn) updateHud(t);
  updateBanner(t);
  updateVTrack(t);
  updateMap(t);
  if (needsRender()) {
    renderer.render(scene, camera);
    labelRenderer.render(scene, camera);
    drawn.t = t; drawn.inv = invalidations; drawn.mat.set(camera.matrixWorld.elements);
    loadingEl?.remove();
  }
});

toast('SHIP1 to SHIP4 run five formations, with CORPEN wheels and TURNs together between them, at 8×. Rings mark the stations. Speed: the button or [ ].', 5000);

// Debug / inspection handle (mirrors the other scenes').
window.__scene = { exercise, clock, rig, camera, controls, setFocus, ships, scene, renderer };

import * as THREE from 'three';
import { createEnvironment } from './environment.js';
import { createShip } from './models/ship.js';
import { createLiveFx } from './fx/liveFx.js';
import { wireWeather } from './weatherButton.js';
import { createWake } from './fx/wake.js';
import { pointScale } from './fx/particles.js';
import { menuText } from './menu.js';
import { KT, HALF_LENGTH } from './hull.js';
import { sinkState } from './duel.js';
import { FleetSim, FLEET_LEVELS, LEVELS, GUN_RANGE, HULL_HP } from './fleet.js';
import './fleet.css';

// Entry point of "Fleet command", mission id `fleet` (see fleet.js for the model): a strategy game from above. You
// command a squadron of frigates with the mouse (left click or drag a box to select, right click the sea to move,
// right click an enemy to attack, Shift queues orders) against an enemy squadron that commands itself. Like Fly and the
// surface battle, nothing here is a function of a clock: the sim is live, the clock can only be paused and sped up.
// start.js imports this file when the mission is picked, with the enemy's level in globalThis.__DUEL_LEVEL.

const canvas = document.querySelector('#scene');
const loadingEl = document.querySelector('#loading');
document.body.classList.add('mission-fly', 'mission-fleet');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
// Drawn at 70 % of the usual resolution (the sea shader costs per pixel; the overlay's rings and bars stay sharp on their own canvas).
const RENDER_SCALE = 0.7;
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5) * RENDER_SCALE);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.75;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, 1, 20, 60000);
const env = createEnvironment(renderer, scene, { look: 'fly' });
env.setShadowSize(720); // 70 % of the usual 1024
// The sea's shader cost: its chop is five octaves of noise; this view keeps the three biggest (from this height the two
// finest are faded out by their pixel footprint anyway), so the sea costs about half of what it did.
{
  const m = env.ocean.material;
  m.fragmentShader = m.fragmentShader.replace('#define CHOP_OCTAVES 5', '#define CHOP_OCTAVES 3');
  m.needsUpdate = true;
}
env.ocean.material.uniforms.uShipX.value = 1e7; // the shader's straight wake: each ship has her own ribbon
wireWeather({ look: env.look });
const fx = createLiveFx(scene);
scene.traverse((o) => { if (o.isParticleField) o.setDensity(0.7); }); // 30 % fewer smoke and spray particles
// Where a ship is drawn this frame: her state carried forward by the part of a step the clock has not run yet, so motion
// is smooth at any frame rate (the sim itself steps at a fixed 1/60 s).
const view = [];
const P = (s) => view[s.id] ?? s;
function updateView() {
  const a = sim.acc;
  for (const s of sim.ships) {
    const v = (view[s.id] ??= {});
    v.x = s.x + Math.cos(s.psi) * s.u * a;
    v.z = s.z + Math.sin(s.psi) * s.u * a;
    v.psi = s.psi + s.r * a;
  }
}
const rad = THREE.MathUtils.degToRad;
const clamp = THREE.MathUtils.clamp;
const wrapPi = (a) => Math.atan2(Math.sin(a), Math.cos(a));

let level = 'normal';
try { level = globalThis.__DUEL_LEVEL ?? new URLSearchParams(location.search).get('level') ?? 'normal'; } catch { /* no address */ }
if (!FLEET_LEVELS.includes(level)) level = 'normal';
const sim = new FleetSim({ seed: (Date.now() % 100000) | 0, level });
const NAMES = ['Alpha', 'Bravo', 'Charlie', 'Delta'];
const nameOf = (s) => (s.team === 0 ? NAMES[s.id] : `Hostile ${s.id - 2}`);

// --- The ships ------------------------------------------------------------------------------------------------------
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
const visuals = [];
function syncShips() {
  while (visuals.length < sim.ships.length) {
    const s = sim.ships[visuals.length];
    const m = createShip({ ensign: s.team === 1 ? 'rus' : 'alg', crew: false });
    m.group.rotation.order = 'YXZ';
    scene.add(m.group);
    visuals.push({ ...m, wake: createWake(scene), smokeT: 0 });
  }
}
const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
function poseShip(i) {
  const s = sim.ships[i];
  const v = visuals[i];
  const sink = s.tSunk >= 0 ? sinkState(sim.t - s.tSunk, s.side) : null;
  v.group.visible = !sink?.gone;
  const q = P(s);
  v.group.position.set(q.x, sink ? sink.depth : 0, q.z);
  v.group.rotation.set(s.heel + (sink?.roll ?? 0), -q.psi, sink?.trim ?? 0);
  v.group.updateMatrixWorld(true);
  const tg = s.target >= 0 && s.hp > 0 ? sim.ships[s.target] : null;
  const rel = tg ? wrapPi(Math.atan2(tg.z - s.z, tg.x - s.x) - s.psi) : 0;
  v.mainGun.pose(-rel, tg ? 0.09 : 0.0); // yaw is + toward port; clockwise (starboard) is the sim's sign
  v.update(sim.t, Infinity, Infinity, { aim: { yaw: Math.PI, pitch: 0 }, cradleT: 0 }); // the radar turns; the launcher stays stowed
  v.wake.update({ t: sim.t, x: q.x, z: q.z, psi: q.psi, r: s.r, u: s.u });
  // Smoke from a hurt ship, thicker as she sinks.
  if (sim.t >= v.smokeT && (s.hp < 55 || sink) && !sink?.gone) {
    v.smokeT = sim.t + 0.12;
    _v.set(-14, 11, 0);
    fx.fireSmoke(v.group.localToWorld(_v), sim.t, sink ? 0.6 + 2 * sink.smoke : s.hp < 30 ? 1.6 : 0.8);
  }
}

// --- Shells and events ----------------------------------------------------------------------------------------------
const shellSprites = [];
for (let i = 0; i < 80; i++) {
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, blending: THREE.AdditiveBlending, depthWrite: false }));
  sp.visible = false;
  scene.add(sp);
  shellSprites.push(sp);
}
function drawShells(h) {
  let n = 0;
  for (const sh of sim.shells) {
    if (n >= shellSprites.length) break;
    const f = clamp((sim.t - sh.t0) / sh.tof, 0, 1);
    const sp = shellSprites[n++];
    const d = Math.hypot(sh.x1 - sh.x0, sh.z1 - sh.z0);
    sp.position.set(sh.x0 + (sh.x1 - sh.x0) * f, 10 + 4 * f * (1 - f) * Math.min(160, d * 0.08), sh.z0 + (sh.z1 - sh.z0) * f);
    sp.scale.setScalar(clamp(h * 0.006, 6, 40));
    sp.visible = true;
  }
  for (; n < shellSprites.length; n++) shellSprites[n].visible = false;
}
const banner = document.querySelector('#shot-caption');
banner.classList.add('call');
let bannerUntil = 0;
function say(text, tone = '', ms = 3000) {
  banner.textContent = text;
  banner.hidden = false;
  banner.classList.remove('standby', 'execute', 'station', 'danger');
  const cls = { ok: 'execute', warn: 'standby', bad: 'danger' }[tone];
  if (cls) banner.classList.add(cls);
  bannerUntil = performance.now() + ms;
}
function handleEvents() {
  for (const e of sim.takeEvents()) {
    if (e.type === 'fire') {
      const v = visuals[e.ship];
      for (let k = 0; k < 4; k++) fx.gunSmoke(v.group.localToWorld(_v.set(30, 9, 0)), _w.set(Math.cos(sim.ships[e.ship].psi) * 6, 3, Math.sin(sim.ships[e.ship].psi) * 6), sim.t);
    } else if (e.type === 'hit') {
      for (let k = 0; k < 3; k++) fx.shellBurst(_v.set(e.x + (Math.random() - 0.5) * 30, 8, e.z + (Math.random() - 0.5) * 30), sim.t);
    } else if (e.type === 'splash') {
      fx.splashAt(_v.set(e.x, 0, e.z), sim.t, 1.6);
    } else if (e.type === 'sunk') {
      for (let k = 0; k < 3; k++) fx.explosion(_v.set(e.x + (k - 1) * 20, 8, e.z), sim.t + k * 0.35);
      say(e.team === 1 ? `${nameOf(sim.ships[e.ship])} sunk` : `${nameOf(sim.ships[e.ship])} is lost`, e.team === 1 ? 'ok' : 'bad');
      selected.delete(e.ship);
    } else if (e.type === 'over') {
      showResult();
    }
  }
}

// --- The camera: straight down, north up (+x), east right (+z) -------------------------------------------------------
const cam = { x: 0, z: 0, h: 3800, hT: 3800 }; // h eases toward hT, so the wheel zooms smoothly
// Start high enough for both squadrons (6,200 m apart across the sea, side by side) to fit the width of the window.
const fitHeight = () => clamp(6400 / (2 * Math.tan(rad(camera.fov / 2)) * camera.aspect), 2600, 7000);
const H_MIN = 450;
const H_MAX = 9000;
function updateCamera() {
  camera.up.set(1, 0, 0);
  camera.position.set(cam.x - cam.h * 0.22, cam.h, cam.z);
  camera.lookAt(cam.x, 0, cam.z);
  camera.updateMatrixWorld(true);
}
const panKeys = new Set();
const EDGE = 24; // px from the screen's edge where the pointer scrolls the view
const mouse = { x: 0, y: 0, over: false }; // over: the pointer is on the sea itself, not on a panel or off the window
function movePan(dt) {
  const speed = cam.h * 0.9 * dt;
  let dx = 0, dz = 0;
  if (panKeys.has('up')) dx += 1;
  if (panKeys.has('down')) dx -= 1;
  if (panKeys.has('right')) dz += 1;
  if (panKeys.has('left')) dz -= 1;
  // The pointer at an edge of the screen scrolls that way; at a corner, diagonally (8 directions in all).
  if (mouse.over && !panning && !drag) {
    if (mouse.y < EDGE) dx += 1; else if (mouse.y > window.innerHeight - EDGE) dx -= 1;
    if (mouse.x < EDGE) dz -= 1; else if (mouse.x > window.innerWidth - EDGE) dz += 1;
  }
  if (dx && dz) { dx *= Math.SQRT1_2; dz *= Math.SQRT1_2; } // a corner is no faster than a side
  cam.x = clamp(cam.x + dx * speed, -6000, 6000);
  cam.z = clamp(cam.z + dz * speed, -6000, 6000);
}
// World point under a screen pixel (on the sea), and a world point's pixel.
const ray = new THREE.Raycaster();
const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const ndc = new THREE.Vector2();
function groundAt(px, py) {
  ndc.set((px / window.innerWidth) * 2 - 1, -(py / window.innerHeight) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  return ray.ray.intersectPlane(plane, _v) ? { x: _v.x, z: _v.z } : null;
}
function toScreen(x, z, y = 0) {
  _w.set(x, y, z).project(camera);
  return { x: (_w.x * 0.5 + 0.5) * window.innerWidth, y: (-_w.y * 0.5 + 0.5) * window.innerHeight, behind: _w.z > 1 };
}
const pxPerM = () => window.innerHeight / (2 * cam.h * Math.tan(rad(camera.fov / 2)));
const shipPx = (s) => Math.max(15, HALF_LENGTH * 1.3 * pxPerM());

// --- Selection and orders --------------------------------------------------------------------------------------------
const selected = new Set();
function shipAt(px, py, team) {
  let best = null, bd = Infinity;
  for (const s of sim.ships) {
    if (s.hp <= 0 || (team !== undefined && s.team !== team)) continue;
    const p = toScreen(P(s).x, P(s).z);
    const d = Math.hypot(p.x - px, p.y - py);
    if (d < Math.max(shipPx(s) * 1.3, 22) && d < bd) { bd = d; best = s; }
  }
  return best;
}
function issue(px, py, queue) {
  if (!selected.size) return;
  const ids = [...selected];
  const foe = shipAt(px, py, 1);
  if (foe) {
    sim.order(ids, { type: 'attack', target: foe.id }, queue);
    pulse(foe.x, foe.z, '#ff5d61');
  } else {
    const g = groundAt(px, py);
    if (g) { sim.order(ids, { type: 'move', x: g.x, z: g.z }, queue); pulse(g.x, g.z, '#9fe870'); }
  }
}
const pulses = [];
function pulse(x, z, color) { pulses.push({ x, z, color, t: performance.now() }); }

// --- The overlay: rings, health, orders, the selection box, the map -----------------------------------------------------
const overlay = document.createElement('canvas');
overlay.className = 'fleet-overlay';
document.body.append(overlay);
const ctx = overlay.getContext('2d');
const dragging = () => Math.hypot(drag.x1 - drag.x0, drag.y1 - drag.y0) > 5;
const inBox = (p, d) => p.x >= Math.min(d.x0, d.x1) && p.x <= Math.max(d.x0, d.x1) && p.y >= Math.min(d.y0, d.y1) && p.y <= Math.max(d.y0, d.y1);
// The selection rectangle is a DOM element moved on every pointer event (not on the next drawn frame), so it follows the
// mouse with no lag even when the scene is slow; the compositor does the rest.
const boxEl = document.createElement('div');
boxEl.className = 'fleet-box';
document.body.append(boxEl);
function moveBox() {
  if (!drag || !dragging()) { boxEl.classList.remove('on'); return; }
  boxEl.classList.add('on');
  boxEl.style.transform = `translate(${Math.min(drag.x0, drag.x1)}px, ${Math.min(drag.y0, drag.y1)}px)`;
  boxEl.style.width = `${Math.abs(drag.x1 - drag.x0)}px`;
  boxEl.style.height = `${Math.abs(drag.y1 - drag.y0)}px`;
}
let drag = null; // { x0, y0, x1, y1, shift }
const MAP = 190;
const MAP_EXTENT = 3600;
const mapRect = () => ({ x: window.innerWidth - MAP - 16, y: window.innerHeight - MAP - 16, w: MAP, h: MAP });
const mapPt = (r, x, z) => ({ x: r.x + r.w / 2 + (z / MAP_EXTENT) * (r.w / 2), y: r.y + r.h / 2 - (x / MAP_EXTENT) * (r.h / 2) });
const COL = { mine: '#9fe870', foe: '#ff5d61', sel: '#ffffff' };
function drawOverlay() {
  const W = window.innerWidth, H = window.innerHeight;
  ctx.clearRect(0, 0, W, H);
  ctx.lineWidth = 1.5;
  ctx.font = '600 11px system-ui, sans-serif';
  ctx.textAlign = 'center';
  const now = performance.now();
  // Gun range and orders of the selected ships.
  for (const id of selected) {
    const s = sim.ships[id];
    if (s.hp <= 0) continue;
    ctx.strokeStyle = 'rgba(159,232,112,0.3)';
    ctx.setLineDash([6, 6]);
    ctx.beginPath();
    for (let k = 0; k <= 48; k++) {
      const a = (k / 48) * Math.PI * 2;
      const p = toScreen(s.x + Math.cos(a) * GUN_RANGE, s.z + Math.sin(a) * GUN_RANGE);
      if (k) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y);
    }
    ctx.stroke();
    ctx.setLineDash([]);
    let from = toScreen(P(s).x, P(s).z);
    ctx.strokeStyle = 'rgba(159,232,112,0.55)';
    for (const o of s.orders) {
      if (o.type === 'move') {
        const p = toScreen(o.x, o.z);
        ctx.beginPath(); ctx.moveTo(from.x, from.y); ctx.lineTo(p.x, p.y); ctx.stroke();
        ctx.beginPath(); ctx.arc(p.x, p.y, 5, 0, 7); ctx.stroke();
        from = p;
      } else {
        const t = sim.ships[o.target];
        const p = toScreen(t.x, t.z);
        ctx.strokeStyle = 'rgba(255,93,97,0.7)';
        ctx.setLineDash([3, 5]);
        ctx.beginPath(); ctx.moveTo(from.x, from.y); ctx.lineTo(p.x, p.y); ctx.stroke();
        ctx.setLineDash([]);
        from = p;
      }
    }
  }
  // Ships.
  for (const s of sim.ships) {
    if (s.hp <= 0) continue;
    const p = toScreen(P(s).x, P(s).z);
    if (p.behind) continue;
    const r = shipPx(s);
    const mine = s.team === 0;
    ctx.strokeStyle = selected.has(s.id) ? COL.sel : mine ? COL.mine : COL.foe;
    ctx.lineWidth = selected.has(s.id) ? 2.5 : 1.5;
    ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, 7); ctx.stroke();
    // Heading tick.
    const hx = Math.sin(s.psi), hy = -Math.cos(s.psi);
    ctx.beginPath(); ctx.moveTo(p.x + hx * r, p.y + hy * r); ctx.lineTo(p.x + hx * (r + 8), p.y + hy * (r + 8)); ctx.stroke();
    // Health bar.
    const bw = Math.max(34, r * 2), by = p.y - r - 10;
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(p.x - bw / 2, by, bw, 5);
    ctx.fillStyle = s.hp > 55 ? '#9fe870' : s.hp > 30 ? '#ffc94d' : '#ff5d61';
    ctx.fillRect(p.x - bw / 2, by, (bw * s.hp) / HULL_HP, 5);
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.fillText(nameOf(s), p.x, by - 4);
    ctx.lineWidth = 1.5;
  }
  // Order pulses.
  for (let i = pulses.length - 1; i >= 0; i--) {
    const q = pulses[i];
    const a = (now - q.t) / 700;
    if (a >= 1) { pulses.splice(i, 1); continue; }
    const p = toScreen(q.x, q.z);
    ctx.strokeStyle = q.color; ctx.globalAlpha = 1 - a;
    ctx.beginPath(); ctx.arc(p.x, p.y, 8 + a * 26, 0, 7); ctx.stroke();
    ctx.globalAlpha = 1;
  }
  // Ships under the selection box so far get a soft ring (the box itself is a DOM element, see boxEl).
  if (drag && dragging()) {
    ctx.strokeStyle = 'rgba(255,255,255,0.65)';
    for (const s of sim.team(0)) {
      const p = toScreen(P(s).x, P(s).z);
      if (inBox(p, drag)) { ctx.beginPath(); ctx.arc(p.x, p.y, shipPx(s) + 5, 0, 7); ctx.stroke(); }
    }
  }
  drawMap();
}
function drawMap() {
  const r = mapRect();
  ctx.fillStyle = 'rgba(8,16,26,0.62)';
  ctx.fillRect(r.x, r.y, r.w, r.h);
  ctx.strokeStyle = 'rgba(255,255,255,0.25)';
  ctx.strokeRect(r.x, r.y, r.w, r.h);
  // What the camera sees.
  const c = toScreenFootprint();
  ctx.strokeStyle = 'rgba(255,255,255,0.5)';
  ctx.beginPath();
  c.forEach((q, i) => { const p = mapPt(r, q.x, q.z); if (i) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y); });
  ctx.closePath(); ctx.stroke();
  for (const s of sim.ships) {
    if (s.hp <= 0) continue;
    const p = mapPt(r, P(s).x, P(s).z);
    ctx.fillStyle = s.team === 0 ? COL.mine : COL.foe;
    const a = s.psi, dx = Math.sin(a), dy = -Math.cos(a);
    ctx.beginPath();
    ctx.moveTo(p.x + dx * 6, p.y + dy * 6);
    ctx.lineTo(p.x - dx * 4 - dy * 3.5, p.y - dy * 4 + dx * 3.5);
    ctx.lineTo(p.x - dx * 4 + dy * 3.5, p.y - dy * 4 - dx * 3.5);
    ctx.fill();
  }
}
function toScreenFootprint() {
  const W = window.innerWidth, H = window.innerHeight;
  return [[0, 0], [W, 0], [W, H], [0, H]].map(([x, y]) => groundAt(x, y) ?? { x: cam.x, z: cam.z }).map((g) => ({ x: g.x, z: g.z }));
}

// --- Mouse and keys ---------------------------------------------------------------------------------------------------
let paused = false;
let speed = 1;
const inMap = (px, py) => { const r = mapRect(); return px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h; };
function mapJump(px, py) {
  const r = mapRect();
  cam.z = clamp(((px - r.x - r.w / 2) / (r.w / 2)) * MAP_EXTENT, -6000, 6000);
  cam.x = clamp((-(py - r.y - r.h / 2) / (r.h / 2)) * MAP_EXTENT, -6000, 6000);
}
let panning = null;
let mapRight = null;
let seaRight = null;
const mapPoint = (px, py) => { const r = mapRect(); return { z: ((px - r.x - r.w / 2) / (r.w / 2)) * MAP_EXTENT, x: (-(py - r.y - r.h / 2) / (r.h / 2)) * MAP_EXTENT }; };
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
window.addEventListener('pointerdown', (e) => {
  if (e.target !== canvas) return;
  if (e.button === 1) { panning = { x: e.clientX, y: e.clientY }; e.preventDefault(); return; }
  if (inMap(e.clientX, e.clientY)) {
    if (e.button === 0) mapJump(e.clientX, e.clientY);
    else if (e.button === 2) mapRight = { x: e.clientX, y: e.clientY, moved: false, shift: e.shiftKey }; // click orders, drag pans (on release)
    return;
  }
  if (e.button === 0) drag = { x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY, shift: e.shiftKey };
  else if (e.button === 2) seaRight = { x0: e.clientX, y0: e.clientY, moved: false, shift: e.shiftKey }; // a click orders, a drag pans (on release / on the move)
});
window.addEventListener('pointermove', (e) => {
  mouse.x = e.clientX; mouse.y = e.clientY; mouse.over = e.target === canvas;
  if (drag) { drag.x1 = e.clientX; drag.y1 = e.clientY; moveBox(); }
  if (mapRight) { // right-drag on the map: the camera follows the cursor
    if (!mapRight.moved && Math.hypot(e.clientX - mapRight.x, e.clientY - mapRight.y) > 4) mapRight.moved = true;
    if (mapRight.moved) { const q = mapPoint(e.clientX, e.clientY); cam.x = clamp(q.x, -6000, 6000); cam.z = clamp(q.z, -6000, 6000); }
  }
  if (seaRight && !seaRight.moved && Math.hypot(e.clientX - seaRight.x0, e.clientY - seaRight.y0) > 4) {
    seaRight.moved = true;
    panning = { x: e.clientX, y: e.clientY }; // the sea follows the cursor from here
  }
  if (panning) {
    const k = 1 / pxPerM();
    cam.z = clamp(cam.z - (e.clientX - panning.x) * k, -6000, 6000);
    cam.x = clamp(cam.x + (e.clientY - panning.y) * k * 1.06, -6000, 6000);
    panning.x = e.clientX; panning.y = e.clientY;
  }
});
window.addEventListener('pointerup', (e) => {
  if (e.button === 1) panning = null;
  if (e.button === 2 && seaRight) { // a right-click on the sea (no drag) gives the order; a drag has panned the camera
    const m = seaRight;
    seaRight = null;
    if (m.moved) panning = null; else issue(m.x0, m.y0, m.shift);
  }
  if (e.button === 2 && mapRight) { // a right-click on the map (no drag) sends the selected ships there
    const m = mapRight;
    mapRight = null;
    if (!m.moved && selected.size) { const q = mapPoint(m.x, m.y); sim.order([...selected], { type: 'move', x: q.x, z: q.z }, m.shift); pulse(q.x, q.z, '#9fe870'); }
  }
  if (e.button !== 0 || !drag) return;
  const d = drag;
  drag = null;
  moveBox();
  if (Math.hypot(d.x1 - d.x0, d.y1 - d.y0) > 5) {
    const x0 = Math.min(d.x0, d.x1), x1 = Math.max(d.x0, d.x1), y0 = Math.min(d.y0, d.y1), y1 = Math.max(d.y0, d.y1);
    if (!d.shift) selected.clear();
    for (const s of sim.team(0)) {
      const p = toScreen(P(s).x, P(s).z);
      if (p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1) selected.add(s.id);
    }
  } else {
    const s = shipAt(d.x1, d.y1, 0);
    if (!d.shift) selected.clear();
    if (s) { if (d.shift && selected.has(s.id)) selected.delete(s.id); else selected.add(s.id); }
  }
});
window.addEventListener('dblclick', (e) => {
  if (e.target !== canvas || !shipAt(e.clientX, e.clientY, 0)) return;
  for (const s of sim.team(0)) selected.add(s.id);
});
window.addEventListener('wheel', (e) => {
  if (e.target !== canvas) return;
  e.preventDefault();
  const g = groundAt(e.clientX, e.clientY);
  const before = cam.hT;
  cam.hT = clamp(cam.hT * Math.exp(e.deltaY * 0.0012), H_MIN, H_MAX);
  if (g && e.deltaY < 0) { // zoom in toward the cursor
    const k = 1 - cam.hT / before;
    cam.x += (g.x - cam.x) * k * 0.6;
    cam.z += (g.z - cam.z) * k * 0.6;
  }
}, { passive: false });
const PAN = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', w: 'up', s: 'down', a: 'left', d: 'right' };
window.addEventListener('keydown', (e) => {
  if (e.target.closest?.('input, textarea')) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (PAN[k]) { panKeys.add(PAN[k]); e.preventDefault(); return; }
  if (k === ' ') { paused = !paused; say(paused ? 'Paused: orders still count' : 'Resumed', 'warn', 1200); e.preventDefault(); }
  else if (k === 'e') { for (const s of sim.team(0)) selected.add(s.id); } // everyone
  else if (k >= '1' && k <= '4') { const s = sim.ships[Number(k) - 1]; if (s && s.team === 0 && s.hp > 0) { if (!e.shiftKey) selected.clear(); selected.add(s.id); } }
  else if (k === 'x') { if (selected.size) sim.order([...selected], { type: 'stop' }); }
  else if (k === 'f') { frameSelection(); }
  else if (k === 'Escape') selected.clear();
  else if (k === '+' || k === '=') setSpeed(SPEEDS[Math.min(SPEEDS.length - 1, SPEEDS.indexOf(speed) + 1)]);
  else if (k === '-') setSpeed(SPEEDS[Math.max(0, SPEEDS.indexOf(speed) - 1)]);
  else if (k === 'r') restart();
  else if (k === 'Tab') { e.preventDefault(); cycleFoe(); }
});
window.addEventListener('keyup', (e) => {
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (PAN[k]) panKeys.delete(PAN[k]);
});
window.addEventListener('blur', () => { panKeys.clear(); mouse.over = false; });
document.documentElement.addEventListener('mouseleave', () => { mouse.over = false; });
const SPEEDS = [0.5, 1, 2, 4, 8, 16];
function setSpeed(v) { speed = v; paused = false; say(`Speed ${v}x`, 'warn', 1000); }
function frameSelection() {
  const list = selected.size ? [...selected].map((i) => sim.ships[i]) : sim.team(0);
  if (!list.length) return;
  cam.x = list.reduce((a, s) => a + s.x, 0) / list.length;
  cam.z = list.reduce((a, s) => a + s.z, 0) / list.length;
}
let foeIdx = 0;
function cycleFoe() {
  const foes = sim.team(1);
  if (!foes.length) return;
  foeIdx = (foeIdx + 1) % foes.length;
  cam.x = foes[foeIdx].x; cam.z = foes[foeIdx].z;
}

// --- The side panel and the result ---------------------------------------------------------------------------------
const ui = document.createElement('div');
ui.className = 'fleet-ui';
ui.innerHTML = '<div class="fl-ships"></div><div class="fl-help"></div><div class="fl-result" hidden></div>';
document.body.append(ui);
const shipsEl = ui.querySelector('.fl-ships');
const helpEl = ui.querySelector('.fl-help');
const resultEl = ui.querySelector('.fl-result');
helpEl.innerHTML = '<b>Left</b> select · drag a box · <b>Right</b> move or attack · <b>Shift</b> queue · <b>Space</b> pause · <b>+ -</b> speed · <b>E</b> all · <b>X</b> stop · <b>F</b> find · wheel zoom · <b>WASD</b> or the screen edge pan';
let lastShips = '';
function shipsHtml() {
  const rows = sim.team(0).concat(sim.ships.filter((s) => s.team === 0 && s.hp <= 0)).map((s) => {
    const o = s.orders[0];
    const state = s.hp <= 0 ? 'sunk' : o?.type === 'attack' ? `attacking ${nameOf(sim.ships[o.target])}` : o?.type === 'move' ? 'under way' : s.target >= 0 ? 'engaging' : 'holding';
    return `<button class="fl-row${selected.has(s.id) ? ' sel' : ''}${s.hp <= 0 ? ' dead' : ''}" data-id="${s.id}"><b>${s.id + 1}</b><span class="fl-n">${nameOf(s)}<small>${state} · ${(s.u / KT).toFixed(0)} kn</small></span><i><u style="width:${Math.max(0, s.hp)}%" class="${s.hp > 55 ? '' : s.hp > 30 ? 'mid' : 'low'}"></u></i></button>`;
  });
  const foes = sim.team(1).length;
  const bar = `<div class="fl-speed"><button data-pause class="${paused ? 'on' : ''}" title="Pause (Space)">${paused ? '▶' : '❚❚'}</button>${SPEEDS.filter((v) => v >= 1).map((v) => `<button data-speed="${v}" class="${!paused && speed === v ? 'on' : ''}" title="${v}x game speed (+ -)">${v}x</button>`).join('')}</div>`;
  return `${bar}<div class="fl-head">${LEVELS[level].name} · enemy ships: <b>${foes}</b>${paused ? ' · <em>paused</em>' : ''}${speed !== 1 ? ` · ${speed}x` : ''}</div>${rows.join('')}`;
}
shipsEl.addEventListener('click', (e) => {
  const sp = e.target.closest('[data-speed]');
  if (sp) { setSpeed(Number(sp.dataset.speed)); return; }
  if (e.target.closest('[data-pause]')) { paused = !paused; return; }
  const b = e.target.closest('.fl-row');
  if (!b) return;
  const s = sim.ships[Number(b.dataset.id)];
  if (s.hp <= 0) return;
  if (!e.shiftKey) selected.clear();
  selected.add(s.id);
});
function showResult() {
  const won = sim.winner === 0;
  const lost = sim.ships.filter((s) => s.team === 0 && s.hp <= 0).length;
  const sunk = sim.ships.filter((s) => s.team === 1 && s.hp <= 0).length;
  resultEl.hidden = false;
  resultEl.innerHTML = `<h2 class="${won ? 'win' : 'lose'}">${won ? 'Victory' : 'Defeat'}</h2><p>${sunk} enemy ships sunk · ${lost} of yours lost · ${Math.floor(sim.t / 60)}:${String(Math.floor(sim.t % 60)).padStart(2, '0')}</p><button class="fl-again">Fight again <kbd>R</kbd></button>`;
  resultEl.querySelector('.fl-again').addEventListener('click', restart);
}
function restart() {
  sim.seed = (Date.now() % 100000) | 0;
  sim.reset();
  selected.clear();
  fx.clear();
  pulses.length = 0;
  for (const v of visuals) v.smokeT = 0; // the clock starts again, so the smoke timers must too
  resultEl.hidden = true;
  cam.x = 0; cam.z = 0; cam.h = cam.hT = fitHeight();
  say('Fight!', 'ok', 1500);
}

// --- Interface: the top bar's More menu, the keys sheet, Hide ------------------------------------------------------------------
const FOLD_KEY = 'intercept.uiHidden';
const foldButton = document.querySelector('#btn-fold');
const unfoldButton = document.querySelector('#btn-unfold');
const menuButton = document.querySelector('#btn-menu');
const menuEl = document.querySelector('#menu');
const keysSheet = document.querySelector('#keys');
function setMenu(open) { menuEl.hidden = !open; menuButton.setAttribute('aria-expanded', String(open)); }
function setKeys(open) { keysSheet.hidden = !open; }
function setFolded(on, save = true) {
  if (on) { setMenu(false); setKeys(false); }
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
window.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === '?') setKeys(keysSheet.hidden);
  else if (e.key === 'h' || e.key === 'c') setFolded(!document.body.classList.contains('ui-hidden'));
  else if (e.key === 'Escape') { setMenu(false); setKeys(false); }
});
setFolded(false, false);
keysSheet.querySelector('dl').innerHTML = [
  ['<kbd>Click</kbd> · <kbd>drag</kbd>', 'Select a ship, or drag a box round several (Shift adds, double click takes them all)'],
  ['<kbd>Right-click</kbd>', 'On the sea: move there (a squadron sails in line abreast). On an enemy: attack her. Shift queues the order after the ones already given'],
  ['<kbd>E</kbd> <kbd>1</kbd> to <kbd>3</kbd>', 'Select every ship, or ship 1 to 3'],
  ['<kbd>X</kbd>', 'Stop: the selected ships drop their orders and hold (they still fire at what is in range)'],
  ['<kbd>Space</kbd>', 'Pause (orders can still be given) · <kbd>+</kbd> <kbd>-</kbd> change the game speed'],
  ['<kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> / wheel', 'Pan and zoom · middle-drag pans · <kbd>F</kbd> centres on the selected ships · <kbd>Tab</kbd> on the next enemy'],
  ['<kbd>R</kbd>', 'Fight again'],
  ['<kbd>H</kbd> <kbd>C</kbd>', 'Hide the interface'],
].map(([k, d]) => `<dt>${k}</dt><dd>${d}</dd>`).join('');
keysSheet.querySelector('.keys-note').textContent = 'Ships fire at the nearest enemy in range by themselves · a ship that turns hard aims worse';

document.querySelector('#btn-ship').addEventListener('click', () => {
  try { sessionStorage.setItem('intercept.chooser', '1'); location.reload(); } catch { location.search = ''; }
});
document.querySelector('#btn-home')?.addEventListener('click', () => document.querySelector('#btn-ship')?.click());
{
  const t = menuText('fleet');
  const b = document.querySelector('.brand b');
  if (b) b.textContent = t.brand;
  const sub = document.querySelector('#mission-sub');
  if (sub) sub.textContent = `${t.sub} · ${LEVELS[level].name}`;
}

function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  overlay.width = w * Math.min(window.devicePixelRatio, 2);
  overlay.height = h * Math.min(window.devicePixelRatio, 2);
  overlay.style.width = `${w}px`;
  overlay.style.height = `${h}px`;
  ctx.setTransform(overlay.width / w, 0, 0, overlay.height / h, 0, 0);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  pointScale.value = (h * renderer.getPixelRatio()) / (2 * Math.tan(rad(camera.fov / 2)));
}
window.addEventListener('resize', resize);
resize();
cam.h = cam.hT = fitHeight();
syncShips();
say('Select your ships and right-click the sea to move them', 'warn', 5000);

let last = performance.now();
let frames = 0;
renderer.setAnimationLoop((now) => {
  const dt = Math.max(0, Math.min((now - last) / 1000, 0.1));
  last = now;
  cam.h += (cam.hT - cam.h) * (1 - Math.exp(-dt * 10));
  movePan(dt);
  if (!paused) sim.advance(dt * speed);
  handleEvents();
  syncShips();
  updateView();
  env.ocean.material.uniforms.uTime.value = sim.t;
  for (let i = 0; i < visuals.length; i++) poseShip(i);
  updateCamera();
  drawShells(cam.h);
  env.follow(camera.position);
  env.setShadowFocus(_v.set(cam.x, 0, cam.z), clamp(cam.h * 0.35, 300, 1800));
  fx.update(sim.t);
  const html = shipsHtml();
  if (html !== lastShips) { shipsEl.innerHTML = html; lastShips = html; }
  drawOverlay();
  if (!banner.hidden && performance.now() > bannerUntil) banner.hidden = true;
  renderer.render(scene, camera);
  if (frames++ === 0) loadingEl?.remove();
});

window.__fleet = { sim, camera, cam, selected, scene, renderer, visuals, restart, fx };

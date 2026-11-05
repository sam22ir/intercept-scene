import * as THREE from 'three';
import {
  ACTIVE_KEYS, ACTIVE_LAUNCH_U, ACTIVE_PATH, DEFAULT_KEYS, DEFAULT_PATH, CUSTOM_PATH, SHARED_PATH, PATH_FIXED, PATH_STORAGE_KEY, MIN_ALT, CHUTE_MODE,
  ENGAGE_STORAGE_KEY, ROUTE_SPEEDS, SHIP_VARIANT, scenario, buildPathCurve, validatePath, shipPos, pathTiming, autoLaunchU, inboundU,
} from './scenario.js';
import { MAX_ALT, MAX_KEYS, clampKey, detectKeys, flyRoute, keyManoeuvre, setPlanDrawn } from './missionPlan.js';
import { stripShareParams } from './share.js';

// Path editor: the drone's flight as a few manoeuvre points in the ship frame. A point marks where a manoeuvre starts: the
// drone turns at 45 degrees of bank until it is heading for the next point, and climbs or descends at 20 degrees toward that
// point's altitude. flyRoute (missionPlan.js) flies the rest, so a point can only ever make a flight the drone can fly.
// Edits live in memory (preview only) until "Apply & play", which stores the points and the path flown from them in
// localStorage and reloads, because the whole scenario (missile guidance, debris, particles, events) is baked from the path
// at load. A point stays on the launcher's side of the ship (clampKey), and the missile still only leaves on the inbound run.

const CYAN = 0x35e0ff;
const AMBER = 0xffb347;
const ORANGE = 0xff7a1a;
const RED = 0xff3b30;
const LAUNCH_SAMPLES = 240; // along the inbound run, for dragging the red launch point
const MAX_SAMPLES = 1400;
const PICK_PX = 14;
const PICK_TOUCH_PX = 30; // a fingertip needs a bigger target than a mouse pointer
const COARSE = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
const HISTORY_MAX = 100;
const MAX_CHEVRONS = 90;
const RANGE = Math.round(scenario.launchRange);
const RINGS = [[150, '150 m'], [400, '400 m'], [RANGE, `${RANGE} m · ${CHUTE_MODE ? 'lock-on' : 'missile range'}`]];
const SHIP_CENTER_Y = 10;
const RULES = { variant: SHIP_VARIANT, mode: CHUTE_MODE ? 'chute' : 'intercept' };

let toastEl = null;
let toastTimer = 0;
export function toast(msg, ms = 5200) {
  if (!toastEl) {
    toastEl = Object.assign(document.body.appendChild(document.createElement('div')), { className: 'toast', title: 'Click to dismiss' });
    toastEl.addEventListener('click', () => toastEl.classList.remove('show'));
  }
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), ms);
}

// A shared link keeps its path in the hash (and the moment in ?t=): both go before reloading,
// otherwise the hash would beat the path saved here and the page would reopen paused.
// The reload after Apply / Restore goes straight back into the scene, not to the start screen.
function reloadIntoScene() {
  try { sessionStorage.setItem('intercept.skip', '1'); } catch { /* storage unavailable */ }
  location.reload();
}

function dropSharedHash() {
  stripShareParams();
  try { if (location.hash) location.hash = ''; } catch { /* ignore */ }
}

const fmtTime = (s) => { const r = Math.round(s); return `${Math.floor(r / 60)}:${String(r % 60).padStart(2, '0')}`; };
const startingKeys = () => (ACTIVE_KEYS ?? detectKeys(ACTIVE_PATH)).map((k) => [...k]);
const defaultKeys = () => (DEFAULT_KEYS ?? detectKeys(DEFAULT_PATH)).map((k) => [...k]);

function textTexture(text, { size = 64, fg = '#0b1118', bg = '#35e0ff', pill = false } = {}) {
  const c = document.createElement('canvas');
  const g = c.getContext('2d');
  if (pill) {
    c.width = 320; c.height = 64;
    g.font = '600 30px system-ui, sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillStyle = bg;
    g.fillText(text, 160, 34);
  } else {
    c.width = c.height = size;
    g.fillStyle = bg;
    g.beginPath(); g.arc(size / 2, size / 2, size / 2 - 3, 0, Math.PI * 2); g.fill();
    g.lineWidth = 3; g.strokeStyle = 'rgba(8,12,18,0.85)'; g.stroke();
    g.fillStyle = fg;
    g.font = `700 ${text.length > 2 ? 26 : 32}px system-ui, sans-serif`;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(text, size / 2, size / 2 + 2);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function createPathEditor({ scene, camera, controls, canvas, clock, onEnter, onExit }) {
  const $ = (s) => document.querySelector(s);
  const ui = {
    panel: $('#editor'), toggle: $('#btn-edit'),
    undo: $('#ed-undo'), redo: $('#ed-redo'),
    sLen: $('#ed-s-len'), sTime: $('#ed-s-time'), sAlt: $('#ed-s-alt'), sNear: $('#ed-s-near'),
    pointTitle: $('#ed-point-title'), prev: $('#ed-prev'), next: $('#ed-next'), fields: $('#ed-fields'),
    x: $('#ed-x'), z: $('#ed-z'), altN: $('#ed-altn'),
    alt: $('#ed-alt'), altOut: $('#ed-alt-out'), del: $('#ed-delete'), add: $('#ed-add'),
    reset: $('#ed-reset'), fold: $('#ed-fold'),
    apply: $('#ed-apply'), cancel: $('#ed-cancel'),
    restore: $('#ed-restore'), hint: $('#ed-hint'), warn: $('#ed-warn'),
    launch: $('#ed-launch'), launchTitle: $('#ed-launch-title'), launchTxt: $('#ed-launch-txt'), launchAuto: $('#ed-launch-auto'),
  };

  let active = false;
  let selected = -1;
  let drag = null; // { index, mode: 'move' | 'alt' | 'launch', ... }
  let keys = startingKeys(); // the manoeuvre points, [x, alt, z]: all an edit changes
  let edited = false; // until something changes, the path shown is the one being flown
  let route = flyRoute(keys, ROUTE_SPEEDS);
  let pts = ACTIVE_PATH.map((p) => [...p]); // the path flown from them
  let curve = buildPathCurve(pts);
  let saved = null; // camera state to restore on exit
  let timing = pathTiming(pts);
  const undoStack = [];
  const redoStack = [];
  let lastNear = Infinity; // closest approach to the ship, from the last rebuild
  // The red launch point (lock-on in a recovery): a fraction of the path's length, or null for
  // the automatic trigger. It can only sit on the inbound run (`inbound`, [u0, u1]),
  // where the drone flies toward the ship.
  let launchU = ACTIVE_LAUNCH_U;
  let inbound = null;
  let autoU = null;
  const launchName = CHUTE_MODE ? 'Lock-on' : 'Missile launch';
  const shownLaunchU = () => {
    if (!inbound) return null;
    const u = launchU ?? autoU ?? inbound[1];
    return THREE.MathUtils.clamp(u, inbound[0], inbound[1]);
  };
  // A handle sits where the drone really is at that point, which is its altitude unless the climb has not got there yet.
  const keyHeight = (i) => route.arrivals[i] ?? keys[i][1];
  const keyPos = (i) => [keys[i][0], keyHeight(i), keys[i][2]];

  // --- Scene objects (all in the ship frame, so the group rides with the ship)
  const root = new THREE.Group();
  root.name = 'path-editor';
  root.visible = false;
  scene.add(root);

  const linePos = new Float32Array(MAX_SAMPLES * 3);
  const lineCol = new Float32Array(MAX_SAMPLES * 3);
  const shadowPos = new Float32Array(MAX_SAMPLES * 3);
  const stemPos = new Float32Array(MAX_KEYS * 6);
  const mkLine = (arr, Kind, mat, colors) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(arr, 3));
    if (colors) g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const o = new Kind(g, mat);
    o.frustumCulled = false;
    o.renderOrder = 10;
    root.add(o);
    return o;
  };
  const lineMat = (color, opacity) => new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthTest: false });
  const pathLine = mkLine(linePos, THREE.Line,
    new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.98, depthTest: false }), lineCol);
  const shadowLine = mkLine(shadowPos, THREE.Line, lineMat(0xbfeeff, 0.3));
  const stems = mkLine(stemPos, THREE.LineSegments, lineMat(CYAN, 0.24));

  // Range rings on the sea around the ship: how far out each leg of the path runs.
  const rings = RINGS.map(([r, label], n) => {
    const ringPts = [];
    for (let i = 0; i < 160; i++) {
      const a = (i / 160) * Math.PI * 2;
      ringPts.push(new THREE.Vector3(Math.cos(a) * r, 0.5, Math.sin(a) * r));
    }
    const line = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(ringPts), lineMat(0xffffff, n === 2 ? 0.3 : 0.16));
    line.renderOrder = 9;
    line.frustumCulled = false;
    root.add(line);
    const tag = new THREE.Sprite(new THREE.SpriteMaterial({ map: textTexture(label, { pill: true, bg: 'rgba(235,245,255,0.8)' }), depthTest: false, transparent: true }));
    tag.renderOrder = 9;
    tag.position.set(0, 0.5, r);
    tag.userData.r = r;
    root.add(tag);
    return { line, tag };
  });

  const sphere = new THREE.SphereGeometry(1, 16, 12);
  const handleMat = new THREE.MeshBasicMaterial({ color: CYAN, depthTest: false, transparent: true, opacity: 0.95 });
  const selectedMat = new THREE.MeshBasicMaterial({ color: ORANGE, depthTest: false });
  const fixedMat = new THREE.MeshBasicMaterial({ color: 0x8a949c, depthTest: false, transparent: true, opacity: 0.8 });
  const handles = [];
  const badges = [];
  const badgeTex = new Map();
  const badgeFor = (n) => {
    if (!badgeTex.has(n)) badgeTex.set(n, textTexture(String(n)));
    return badgeTex.get(n);
  };
  const fixedMarks = PATH_FIXED.map((p) => {
    const m = new THREE.Mesh(sphere, fixedMat);
    m.position.set(...p);
    m.renderOrder = 11;
    root.add(m);
    return m;
  });

  // Direction chevrons along the path.
  const chevGeo = new THREE.ConeGeometry(0.5, 1.5, 6);
  const chevMat = new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true, opacity: 0.85 });
  const chevrons = new THREE.InstancedMesh(chevGeo, chevMat, MAX_CHEVRONS);
  chevrons.frustumCulled = false;
  chevrons.renderOrder = 11;
  chevrons.count = 0;
  root.add(chevrons);
  const chevPos = [];
  const chevQuat = [];

  // The red launch point, its tag, and the inbound run it slides along (a faint red line).
  const inboundPos = new Float32Array((LAUNCH_SAMPLES + 1) * 3);
  const inboundLine = mkLine(inboundPos, THREE.Line, lineMat(RED, 0.55));
  const launchMark = new THREE.Mesh(sphere, new THREE.MeshBasicMaterial({ color: RED, depthTest: false }));
  launchMark.renderOrder = 14;
  root.add(launchMark);
  const launchRing = new THREE.Mesh(new THREE.RingGeometry(1.5, 1.9, 32), new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true, opacity: 0.9, side: THREE.DoubleSide }));
  launchRing.renderOrder = 14;
  root.add(launchRing);
  const launchTag = new THREE.Sprite(new THREE.SpriteMaterial({
    map: textTexture(CHUTE_MODE ? 'LOCK-ON' : 'MISSILE LAUNCH', { pill: true, bg: '#ff5b52' }), depthTest: false, transparent: true,
  }));
  launchTag.renderOrder = 14;
  root.add(launchTag);
  const inboundSamples = []; // ship-frame points along the inbound run, with their u
  const launchAt = new THREE.Vector3();

  function updateLaunch() {
    const u = shownLaunchU();
    const on = u !== null;
    launchMark.visible = launchRing.visible = launchTag.visible = on;
    if (on) curve.getPointAt(u, launchAt);
    refreshLaunchUI(u);
  }

  const _col = new THREE.Color();
  const _c1 = new THREE.Color(CYAN);
  const _c2 = new THREE.Color(AMBER);
  const _qUp = new THREE.Vector3(0, 1, 0);
  const _mat = new THREE.Matrix4();
  const _unit = new THREE.Vector3();

  function rebuild() {
    route = flyRoute(keys, ROUTE_SPEEDS);
    pts = edited ? route.points : ACTIVE_PATH.map((p) => [...p]);
    curve = buildPathCurve(pts);
    timing = pathTiming(pts);
    const n = Math.min(MAX_SAMPLES - 1, (pts.length + 2) * 40);
    const v = new THREE.Vector3();
    let near = Infinity;
    const top = Math.max(120, ...keys.map((k) => k[1]));
    for (let i = 0; i <= n; i++) {
      curve.getPoint(i / n, v);
      linePos.set([v.x, Math.max(v.y, MIN_ALT * 0.5), v.z], i * 3);
      shadowPos.set([v.x, 0.4, v.z], i * 3);
      _col.copy(_c1).lerp(_c2, THREE.MathUtils.clamp((v.y - 20) / top, 0, 1));
      lineCol.set([_col.r, _col.g, _col.b], i * 3);
      near = Math.min(near, Math.hypot(v.x, v.y - SHIP_CENTER_Y, v.z));
    }
    pathLine.geometry.setDrawRange(0, n + 1);
    shadowLine.geometry.setDrawRange(0, n + 1);
    pathLine.geometry.attributes.position.needsUpdate = true;
    pathLine.geometry.attributes.color.needsUpdate = true;
    shadowLine.geometry.attributes.position.needsUpdate = true;

    while (handles.length < keys.length) {
      const m = new THREE.Mesh(sphere, handleMat);
      m.renderOrder = 12;
      root.add(m);
      handles.push(m);
      const b = new THREE.Sprite(new THREE.SpriteMaterial({ map: badgeFor(handles.length), depthTest: false, transparent: true }));
      b.renderOrder = 13;
      root.add(b);
      badges.push(b);
    }
    while (handles.length > keys.length) { root.remove(handles.pop()); root.remove(badges.pop()); }
    keys.forEach((k, i) => {
      const y = keyHeight(i);
      handles[i].position.set(k[0], y, k[2]);
      handles[i].material = i === selected ? selectedMat : handleMat;
      stemPos.set([k[0], y, k[2], k[0], 0.4, k[2]], i * 6);
    });
    stems.geometry.setDrawRange(0, keys.length * 2);
    stems.geometry.attributes.position.needsUpdate = true;

    // Chevrons evenly spaced by arc length.
    const len = curve.getLength();
    const count = Math.min(MAX_CHEVRONS, Math.max(6, Math.round(len / 160)));
    chevPos.length = chevQuat.length = 0;
    for (let i = 0; i < count; i++) {
      const u = (i + 0.5) / count;
      chevPos.push(curve.getPointAt(u, new THREE.Vector3()));
      chevQuat.push(new THREE.Quaternion().setFromUnitVectors(_qUp, curve.getTangentAt(u, _unit)));
    }
    chevrons.count = count;

    inbound = pts.length ? inboundU(pts) : null;
    autoU = pts.length ? autoLaunchU(pts, RANGE) : null;
    inboundSamples.length = 0;
    if (inbound) {
      for (let i = 0; i <= LAUNCH_SAMPLES; i++) {
        const u = inbound[0] + ((inbound[1] - inbound[0]) * i) / LAUNCH_SAMPLES;
        const p = curve.getPointAt(u, new THREE.Vector3());
        inboundSamples.push({ u, p });
        inboundPos.set([p.x, p.y, p.z], i * 3);
      }
    }
    inboundLine.geometry.setDrawRange(0, inbound ? LAUNCH_SAMPLES + 1 : 0);
    inboundLine.geometry.attributes.position.needsUpdate = true;

    lastNear = near;
    refreshUI(len, near);
    updateLaunch();
  }

  function refreshLaunchUI(u = shownLaunchU()) {
    ui.launchTitle.textContent = launchName;
    ui.launchAuto.disabled = launchU === null;
    ui.launchAuto.title = `Back to the automatic launch: when the inbound drone closes to ${RANGE} m`;
    ui.launch.classList.toggle('warn', u === null);
    if (u === null) {
      ui.launchTxt.textContent = CHUTE_MODE
        ? '· the path never flies back toward the ship, so the launcher never locks on'
        : '· the path never flies back toward the ship: the missile only leaves on the inbound run';
      return;
    }
    const len = curve.getLength();
    const p = curve.getPointAt(u, tmp);
    const range = Math.hypot(p.x, p.y - SHIP_CENTER_Y, p.z);
    const how = launchU === null ? `auto, ${RANGE} m` : 'red point';
    ui.launchTxt.textContent = `· ${how} · ${fmtTime(timing.at(u * len))} · ${Math.round(range)} m out · ${Math.round(p.y)} m up`;
  }

  // --- UI -------------------------------------------------------------------------
  function setField(input, value) {
    if (document.activeElement !== input) input.value = value;
  }

  const manoeuvreWords = (i) => {
    const m = keyManoeuvre(keys, route, i);
    if (m.last) return CHUTE_MODE ? 'the parachute opens' : 'the end of the path';
    const alt = m.alt === 'up' ? 'a climb' : m.alt === 'down' ? 'a descent' : '';
    if (m.turn && alt) return `starts a turn and ${alt}`;
    if (m.turn) return 'starts a turn';
    if (alt) return `starts ${alt}`;
    return 'straight on';
  };

  function refreshUI(len = curve.getLength(), near = lastNear) {
    const sel = keys[selected];
    const heights = [...pts.map((p) => p[1])];
    ui.sLen.textContent = `${(len / 1000).toFixed(2)} km`;
    ui.sTime.textContent = fmtTime(timing.flight);
    ui.sAlt.textContent = heights.length ? `${Math.min(...heights)}–${Math.max(...heights)} m` : '–';
    ui.sNear.textContent = Number.isFinite(near) ? `${Math.round(near)} m` : '–';

    ui.pointTitle.textContent = sel ? `Point ${selected + 1} of ${keys.length} · ${manoeuvreWords(selected)}` : `${keys.length} points · none selected`;
    ui.fields.classList.toggle('off', !sel);
    [ui.x, ui.z, ui.altN, ui.alt].forEach((i) => { i.disabled = !sel; });
    if (sel) { setField(ui.x, sel[0]); setField(ui.z, sel[2]); setField(ui.altN, sel[1]); } else { ui.x.value = ui.z.value = ui.altN.value = ''; }
    if (sel) ui.alt.value = sel[1];
    ui.altOut.textContent = sel ? `${Math.round(sel[1])} m` : '–';
    ui.del.disabled = !sel || keys.length <= 1;
    ui.add.disabled = !sel || keys.length >= MAX_KEYS;
    ui.prev.disabled = ui.next.disabled = keys.length < 2;
    ui.undo.disabled = !undoStack.length;
    ui.redo.disabled = !redoStack.length;
    ui.restore.hidden = !CUSTOM_PATH;
    // One text per sentence, so the French layer finds each in its dictionary.
    const sentences = (el, list) => {
      const key = list.join('|');
      if (el.dataset.key === key) return;
      el.dataset.key = key;
      el.replaceChildren(...list.map((text) => Object.assign(document.createElement('span'), { textContent: `${text} ` })));
    };
    sentences(ui.hint, [
      COARSE
        ? 'Each point is where the drone starts a manoeuvre. Tap one to select it, drag to move it. It turns at 45° of bank and climbs or descends at 20° by itself.'
        : 'Each point is where the drone starts a manoeuvre. Drag one to move it, Shift-drag to change its altitude, double-click the line to add one. It turns at 45° of bank and climbs or descends at 20° by itself.',
      CHUTE_MODE ? 'Drag the red dot along the red stretch (the inbound run) to choose where the launcher locks on.' : 'Drag the red dot along the red stretch (the inbound run) to choose where the missile launches.',
      ...(CHUTE_MODE ? ['The parachute opens at the last point.'] : []),
    ]);
    const warnings = edited ? route.notes.map((n) => (n.key === 'tight'
      ? `Point ${n.index + 1} is too close to the one before for a 45° turn: the drone flies straight at it.`
      : `Point ${n.index + 1}: at 20° the drone only gets to ${n.value} m by there.`)) : [];
    sentences(ui.warn, warnings);
    ui.warn.hidden = !warnings.length;
  }

  // --- History ----------------------------------------------------------------------
  const snapshot = () => JSON.stringify({ keys, selected, launchU, edited });
  function commit() {
    undoStack.push(snapshot());
    if (undoStack.length > HISTORY_MAX) undoStack.shift();
    redoStack.length = 0;
  }
  function restoreSnapshot(str) {
    const o = JSON.parse(str);
    keys = o.keys;
    edited = o.edited;
    launchU = o.launchU ?? null;
    selected = Math.min(o.selected, keys.length - 1);
    rebuild();
  }
  function undo() {
    if (!undoStack.length) return;
    redoStack.push(snapshot());
    restoreSnapshot(undoStack.pop());
  }
  function redo() {
    if (!redoStack.length) return;
    undoStack.push(snapshot());
    restoreSnapshot(redoStack.pop());
  }

  // A point within the rules: on the launcher's side, inside the world, a sane height.
  const within = (k, i, n = keys.length) => clampKey(k, i, n, RULES);
  function setKey(i, k) {
    keys[i] = within(k, i);
    edited = true;
    rebuild();
  }

  function setAltitude(v) {
    if (!keys[selected]) return;
    commitOnce('alt');
    setKey(selected, [keys[selected][0], v, keys[selected][2]]);
  }

  // Slider and field changes arrive as many events: one undo step per gesture.
  let gesture = null;
  function commitOnce(kind) {
    if (gesture === kind) return;
    commit();
    gesture = kind;
  }
  const endGestureHistory = () => { gesture = null; };

  // --- Picking --------------------------------------------------------------------
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const tmp = new THREE.Vector3();
  const hit = new THREE.Vector3();

  function setRay(e) {
    const r = canvas.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
  }
  const toPx = (world, e) => {
    const r = canvas.getBoundingClientRect();
    tmp.copy(world).project(camera);
    return tmp.z > 1 ? Infinity : Math.hypot(((tmp.x + 1) / 2) * r.width + r.left - e.clientX, ((1 - tmp.y) / 2) * r.height + r.top - e.clientY);
  };
  const world = (p) => new THREE.Vector3(p[0], p[1], p[2]).add(root.position);

  function pickLaunch(e) {
    if (!launchMark.visible) return false;
    return toPx(launchMark.position.clone().add(root.position), e) < (e.pointerType === 'touch' ? PICK_TOUCH_PX : PICK_PX) * 1.3;
  }

  function pickHandle(e) {
    let best = -1;
    let bestD = e.pointerType === 'touch' ? PICK_TOUCH_PX : PICK_PX;
    keys.forEach((_, i) => {
      const d = toPx(world(keyPos(i)), e);
      if (d < bestD) { bestD = d; best = i; }
    });
    return best;
  }

  // Intersect the pointer ray with the horizontal plane y = alt; returns a
  // ship-frame point or null.
  function groundPoint(e, alt) {
    setRay(e);
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -alt);
    if (!ray.ray.intersectPlane(plane, hit)) return null;
    return [Math.round(hit.x - root.position.x), alt, Math.round(hit.z - root.position.z)];
  }

  // Active touch pointers. With two or more fingers the gesture belongs to
  // OrbitControls (pinch zoom, two-finger pan), so any drag ends.
  const touchIds = new Set();

  // Registered on window in the capture phase, so a handle drag stops here and
  // never reaches the canvas (OrbitControls, main.js picking).
  function onPointerDown(e) {
    const touch = e.pointerType === 'touch';
    if (touch) touchIds.add(e.pointerId);
    if (!active || e.target !== canvas || e.button !== 0) return;
    if (touchIds.size > 1) { drag = null; controls.enabled = true; return; }
    const i = pickHandle(e);
    if (i < 0 && pickLaunch(e)) {
      commit();
      drag = { mode: 'launch', moved: false };
      controls.enabled = false;
      e.stopPropagation();
      return;
    }
    if (i >= 0) {
      selected = i;
      commit();
      if (e.shiftKey) {
        const dist = camera.position.distanceTo(world(keyPos(i)));
        const perPx = (2 * dist * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))) / canvas.getBoundingClientRect().height;
        drag = { index: i, mode: 'alt', y0: e.clientY, alt0: keys[i][1], perPx, moved: false };
      } else {
        drag = { index: i, mode: 'move', plane: keyHeight(i), moved: false };
      }
      controls.enabled = false;
      rebuild();
      e.stopPropagation();
    } else {
      selected = -1;
      rebuild();
    }
  }

  function onPointerMove(e) {
    if (!active || !drag) return;
    if (drag.mode === 'launch') {
      // Slide along the inbound run: the sample nearest the pointer on screen.
      let best = null;
      let bestD = Infinity;
      for (const s of inboundSamples) {
        const d = toPx(s.p.clone().add(root.position), e);
        if (d < bestD) { bestD = d; best = s.u; }
      }
      if (best !== null && best !== launchU) { launchU = best; drag.moved = true; updateLaunch(); }
    } else if (drag.mode === 'alt') {
      const k = keys[drag.index];
      const alt = Math.round(drag.alt0 + (drag.y0 - e.clientY) * drag.perPx);
      if (alt !== k[1]) { drag.moved = true; setKey(drag.index, [k[0], alt, k[2]]); }
    } else {
      const k = keys[drag.index];
      const p = groundPoint(e, drag.plane);
      if (p && (p[0] !== k[0] || p[2] !== k[2])) { drag.moved = true; setKey(drag.index, [p[0], k[1], p[2]]); }
    }
  }

  function onPointerUp(e) {
    if (e.pointerType === 'touch') touchIds.delete(e.pointerId);
    if (drag) {
      if (!drag.moved) undoStack.pop(); // a plain click selects; it is not an edit
      drag = null;
      controls.enabled = true;
      refreshUI();
    }
  }

  // Double-click on the line adds a point where the curve is, between the two points either side of it.
  function onDoubleClick(e) {
    if (!active || e.target !== canvas) return;
    const N = 400;
    let best = null;
    let bestD = PICK_PX;
    const v = new THREE.Vector3();
    for (let i = 0; i <= N; i++) {
      curve.getPointAt(i / N, v);
      const d = toPx(v.clone().add(root.position), e);
      if (d < bestD) { bestD = d; best = { u: i / N, p: v.clone() }; }
    }
    if (!best) return;
    if (keys.length >= MAX_KEYS) { toast(`At most ${MAX_KEYS} points`); return; }
    const after = route.keyS.findIndex((s) => s / route.length > best.u);
    const at = after < 0 ? keys.length : after;
    commit();
    keys.splice(at, 0, within([best.p.x, best.p.y, best.p.z], at, keys.length + 1));
    edited = true;
    selected = at;
    rebuild();
  }

  window.addEventListener('pointerdown', onPointerDown, true);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerUp);
  canvas.addEventListener('dblclick', onDoubleClick);

  // Touch alternatives to double-click (add), the Delete key and ↑/↓ (Alt ±).
  function addAfterSelected() {
    const a = keys[selected];
    if (!a) return;
    if (keys.length >= MAX_KEYS) { toast(`At most ${MAX_KEYS} points`); return; }
    const b = keys[selected + 1];
    let p;
    if (b) {
      p = [(a[0] + b[0]) / 2, a[1], (a[2] + b[2]) / 2];
    } else {
      // Last point: carry on the way it was going.
      const prev = keys[selected - 1] ?? PATH_FIXED[PATH_FIXED.length - 1];
      let dx = a[0] - prev[0];
      let dz = a[2] - prev[2];
      const len = Math.hypot(dx, dz);
      if (len < 1) { dx = 1; dz = 0; } else { dx /= len; dz /= len; }
      p = [a[0] + dx * 300, a[1], a[2] + dz * 300];
    }
    commit();
    keys.splice(selected + 1, 0, within(p, selected + 1, keys.length + 1));
    edited = true;
    selected += 1;
    rebuild();
  }
  function nudgeAltitude(d) {
    if (keys[selected]) { commit(); setKey(selected, [keys[selected][0], keys[selected][1] + d, keys[selected][2]]); }
  }
  function step(d) {
    if (!keys.length) return;
    selected = selected < 0 ? (d > 0 ? 0 : keys.length - 1) : (selected + d + keys.length) % keys.length;
    rebuild();
  }

  // --- Actions --------------------------------------------------------------------
  function apply() {
    if (!edited && launchU === ACTIVE_LAUNCH_U) { api.exit(); clock.play(1); return; } // nothing to save: it still plays, from the start
    const clean = validatePath(pts);
    if (!clean) { toast('This path is not valid.'); return; }
    try {
      const untouched = JSON.stringify(keys) === JSON.stringify(defaultKeys()) && launchU === null;
      if (untouched) localStorage.removeItem(PATH_STORAGE_KEY);
      else localStorage.setItem(PATH_STORAGE_KEY, JSON.stringify({ points: clean, keys, ...(launchU === null ? null : { launch: launchU }) }));
      setPlanDrawn(!untouched); // a mission plan now flies this path, not the one it generates
      // The red point is the launch moment: an engagement setting that picks its own time would
      // override it, so it goes back to automatic timing (burst distance and side are kept).
      if (launchU !== null && !CHUTE_MODE) {
        const raw = localStorage.getItem(ENGAGE_STORAGE_KEY);
        const o = raw ? JSON.parse(raw) : null;
        if (o && o.timing && o.timing !== 'auto') localStorage.setItem(ENGAGE_STORAGE_KEY, JSON.stringify({ ...o, timing: 'auto' }));
      }
    } catch {
      toast('Could not save the path (browser storage is blocked).');
      return;
    }
    dropSharedHash();
    try { sessionStorage.setItem('intercept.seek', '0'); } catch { /* storage unavailable */ } // Apply & play: it opens playing, from the start
    reloadIntoScene();
  }

  function restoreDefault() {
    // Viewing a shared path: "restore" only leaves the link; the viewer's own saved path stays.
    if (!SHARED_PATH) { try { localStorage.removeItem(PATH_STORAGE_KEY); } catch { /* storage unavailable */ } setPlanDrawn(false); }
    dropSharedHash();
    reloadIntoScene();
  }

  function deleteSelected() {
    if (!keys[selected] || keys.length <= 1) return;
    commit();
    keys.splice(selected, 1);
    edited = true;
    selected = Math.min(selected, keys.length - 1);
    rebuild();
  }

  // Exact numbers for the selected point.
  function fieldChanged(axis, input) {
    const sel = keys[selected];
    if (!sel) return;
    const v = parseFloat(input.value);
    if (!Number.isFinite(v)) { refreshUI(); return; }
    commitOnce(`field-${axis}`);
    const next = [...sel];
    next[axis] = v;
    setKey(selected, next);
  }

  ui.toggle.addEventListener('click', () => api.toggle());
  ui.undo.addEventListener('click', undo);
  ui.redo.addEventListener('click', redo);
  ui.prev.addEventListener('click', () => step(-1));
  ui.next.addEventListener('click', () => step(1));
  ui.alt.addEventListener('input', () => setAltitude(parseFloat(ui.alt.value)));
  ui.alt.addEventListener('change', endGestureHistory);
  [[ui.x, 0], [ui.z, 2], [ui.altN, 1]].forEach(([input, axis]) => {
    input.addEventListener('input', () => fieldChanged(axis, input));
    input.addEventListener('change', () => { endGestureHistory(); refreshUI(); });
  });
  ui.alt.max = String(MAX_ALT);
  ui.altN.max = String(MAX_ALT);
  ui.del.addEventListener('click', deleteSelected);
  ui.add.addEventListener('click', addAfterSelected);
  // Phones: collapse the controls so the sea (and the path) is visible.
  ui.fold.addEventListener('click', () => {
    const folded = ui.panel.classList.toggle('folded');
    ui.fold.textContent = folded ? 'Show controls' : 'Hide controls';
    ui.fold.setAttribute('aria-expanded', String(!folded));
  });
  ui.reset.addEventListener('click', () => { commit(); keys = defaultKeys(); launchU = null; selected = -1; edited = true; rebuild(); });
  ui.launchAuto.addEventListener('click', () => { if (launchU === null) return; commit(); launchU = null; updateLaunch(); refreshUI(); });
  ui.apply.addEventListener('click', apply);
  ui.cancel.addEventListener('click', () => api.exit());
  ui.restore.addEventListener('click', restoreDefault);

  // --- Mode ------------------------------------------------------------------------
  function frameCamera() {
    const all = [...PATH_FIXED, ...pts];
    const box = new THREE.Box3();
    for (const p of all) box.expandByPoint(tmp.set(p[0], 0, p[2]));
    box.expandByPoint(tmp.set(-80, 0, 0)).expandByPoint(tmp.set(80, 0, 0));
    const c = box.getCenter(new THREE.Vector3());
    // The panel stands over the left of the screen (not on a phone, where it folds): the path is framed in the room beside it.
    const W = canvas.getBoundingClientRect().width;
    const side = ui.panel.getBoundingClientRect().right;
    const free = side < W / 2 ? (W - side) / W : 1;
    const R = Math.max(150, box.getSize(new THREE.Vector3()).length() / 2) / free;
    const up = R * 1.7 + 60;
    const shift = ((1 - free) / 2) * 2 * Math.hypot(up, R * 0.55) * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * camera.aspect;
    controls.target.set(c.x + root.position.x - shift, 0, c.z);
    camera.position.set(c.x + root.position.x - shift, up, c.z + R * 0.55);
  }

  const api = {
    get active() { return active; },
    // For scripted checks: the manoeuvre points and what they make.
    get keys() { return keys.map((k) => [...k]); },
    get path() { return pts.map((p) => [...p]); },
    toggle() { active ? api.exit() : api.enter(); },
    enter() {
      if (active) return;
      active = true;
      saved = { pos: camera.position.clone(), target: controls.target.clone(), maxPolar: controls.maxPolarAngle };
      clock.playing = false;
      clock.seek(0);
      onEnter?.();
      keys = startingKeys();
      edited = false;
      launchU = ACTIVE_LAUNCH_U;
      selected = -1;
      undoStack.length = redoStack.length = 0;
      root.visible = true;
      ui.panel.hidden = false;
      ui.toggle.classList.add('active');
      document.body.classList.add('editing');
      controls.maxPolarAngle = Math.PI * 0.5;
      rebuild();
      frameCamera();
    },
    exit() {
      if (!active) return;
      active = false;
      drag = null;
      controls.enabled = true;
      root.visible = false;
      ui.panel.hidden = true;
      ui.toggle.classList.remove('active');
      document.body.classList.remove('editing');
      controls.maxPolarAngle = saved.maxPolar;
      camera.position.copy(saved.pos);
      controls.target.copy(saved.target);
      onExit?.();
    },
    update() {
      if (!active) return;
      clock.playing = false;
      shipPos(clock.t, root.position);
      const k = 0.0105;
      const cam = camera.position;
      handles.forEach((h, i) => {
        const p = keyPos(i);
        const s = Math.max(2, cam.distanceTo(world(p)) * k * (i === selected ? 1.25 : 1));
        h.scale.setScalar(s);
        badges[i].position.set(p[0], p[1] + s * 2.1, p[2]);
        badges[i].scale.setScalar(s * 2.1);
      });
      if (launchMark.visible) {
        launchMark.position.copy(launchAt);
        const ls = Math.max(2.4, cam.distanceTo(world(launchAt.toArray())) * k * 1.45);
        launchMark.scale.setScalar(ls);
        launchRing.position.copy(launchAt);
        launchRing.scale.setScalar(ls);
        launchRing.quaternion.copy(camera.quaternion);
        launchTag.position.set(launchAt.x, launchAt.y + ls * 3.2, launchAt.z);
        launchTag.scale.set(ls * 10, ls * 2, 1);
      }
      fixedMarks.forEach((m) => m.scale.setScalar(Math.max(1.2, cam.distanceTo(m.getWorldPosition(tmp)) * k * 0.6)));
      // Chevrons keep a constant look at any zoom.
      const center = tmp.set(0, 0, 0).add(root.position);
      const cs = Math.max(3, cam.distanceTo(center) * k * 0.55);
      for (let i = 0; i < chevPos.length; i++) {
        _mat.compose(chevPos[i], chevQuat[i], _unit.setScalar(cs));
        chevrons.setMatrixAt(i, _mat);
      }
      chevrons.instanceMatrix.needsUpdate = true;
      for (const { tag } of rings) {
        tag.scale.set(cam.distanceTo(world([0, 0, tag.userData.r])) * 0.11, cam.distanceTo(world([0, 0, tag.userData.r])) * 0.022, 1);
      }
    },
    onKey(key, e) {
      const big = e?.shiftKey ? 25 : 5;
      if ((e?.ctrlKey || e?.metaKey) && !e.altKey) {
        const k = key.toLowerCase();
        if (k === 'z') { e.shiftKey ? redo() : undo(); e.preventDefault(); } else if (k === 'y') { redo(); e.preventDefault(); }
        return;
      }
      switch (key) {
        case 'Escape': api.exit(); break;
        case 'Delete': case 'Backspace': deleteSelected(); break;
        case 'ArrowUp': nudgeAltitude(big); break;
        case 'ArrowDown': nudgeAltitude(-big); break;
        case '[': step(-1); break;
        case ']': step(1); break;
        case 'Enter': apply(); break;
        case 'e': case 'E': api.exit(); break;
        default: return;
      }
      e?.preventDefault?.();
    },
  };

  rebuild();
  return api;
}

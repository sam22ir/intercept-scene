import * as THREE from 'three';
import {
  ACTIVE_PATH, DEFAULT_PATH, CUSTOM_PATH, SHARED_PATH, PATH_FIXED, PATH_STORAGE_KEY, MIN_ALT, CHUTE_MODE,
  buildPathCurve, validatePath, shipPos, flightTimeForLength,
} from './scenario.js';
import { stripShareParams } from './share.js';

// Path editor: draw or adjust the drone's flight path in the ship frame.
// Edits live in memory (preview only) until "Apply & play", which stores the
// points in localStorage and reloads, because the whole scenario (missile
// guidance, debris, particles, events) is baked from the path at load.
//
// Beyond dragging dots: numbered handles, a path coloured by altitude with
// direction chevrons, range rings around the ship, exact X / Z / altitude fields,
// snap-to-grid, Shift-drag for altitude, undo / redo and whole-path tools.

const CYAN = 0x35e0ff;
const AMBER = 0xffb347;
const ORANGE = 0xff7a1a;
const MAX_SAMPLES = 1400;
const MAX_POINTS = 80;
const MAX_ALT = 600;
const SPACING = 60; // m between freehand points
const PICK_PX = 14;
const PICK_TOUCH_PX = 30; // a fingertip needs a bigger target than a mouse pointer
const COARSE = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
const HISTORY_MAX = 100;
const MAX_CHEVRONS = 90;
const RINGS = [[150, '150 m'], [400, '400 m'], [650, '650 m · missile range']];
const SHIP_CENTER_Y = 10;

let toastEl = null;
let toastTimer = 0;
export function toast(msg, ms = 5200) {
  toastEl ??= Object.assign(document.body.appendChild(document.createElement('div')), { className: 'toast' });
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), ms);
}

// A shared link keeps its path in the hash (and the moment in ?t=): both go before reloading,
// otherwise the hash would beat the path saved here and the page would reopen paused.
function dropSharedHash() {
  stripShareParams();
  try { if (location.hash) location.hash = ''; } catch { /* ignore */ }
}

const clampAlt = (v) => THREE.MathUtils.clamp(Math.round(v), MIN_ALT, MAX_ALT);
const fmtTime = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;

// Douglas-Peucker on 3D points: keeps the ones that bend the curve by more than `tol` metres.
function simplifyPoints(points, tol) {
  const keep = new Array(points.length).fill(false);
  keep[0] = keep[points.length - 1] = true;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const p = new THREE.Vector3();
  const line = new THREE.Line3();
  const q = new THREE.Vector3();
  const walk = (lo, hi) => {
    if (hi <= lo + 1) return;
    line.set(a.fromArray(points[lo]), b.fromArray(points[hi]));
    let worst = 0;
    let at = -1;
    for (let i = lo + 1; i < hi; i++) {
      line.closestPointToPoint(p.fromArray(points[i]), true, q);
      const d = q.distanceTo(p);
      if (d > worst) { worst = d; at = i; }
    }
    if (worst > tol) { keep[at] = true; walk(lo, at); walk(at, hi); }
  };
  walk(0, points.length - 1);
  return points.filter((_, i) => keep[i]);
}

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
    panel: $('#editor'), toggle: $('#btn-edit'), move: $('#ed-tool-move'), draw: $('#ed-tool-draw'),
    undo: $('#ed-undo'), redo: $('#ed-redo'),
    sLen: $('#ed-s-len'), sTime: $('#ed-s-time'), sAlt: $('#ed-s-alt'), sNear: $('#ed-s-near'),
    pointTitle: $('#ed-point-title'), prev: $('#ed-prev'), next: $('#ed-next'), fields: $('#ed-fields'),
    x: $('#ed-x'), z: $('#ed-z'), altN: $('#ed-altn'),
    alt: $('#ed-alt'), altOut: $('#ed-alt-out'), altLabel: $('#ed-alt-label'), del: $('#ed-delete'), add: $('#ed-add'),
    snap: $('#ed-snap'), smooth: $('#ed-smooth'), simplify: $('#ed-simplify'), mirror: $('#ed-mirror'),
    wider: $('#ed-wider'), tighter: $('#ed-tighter'), raise: $('#ed-raise'), lower: $('#ed-lower'),
    clear: $('#ed-clear'), reset: $('#ed-reset'), fold: $('#ed-fold'),
    apply: $('#ed-apply'), cancel: $('#ed-cancel'),
    copy: $('#ed-copy'), paste: $('#ed-import'), restore: $('#ed-restore'), hint: $('#ed-hint'),
  };

  let active = false;
  let tool = 'move';
  let selected = -1;
  let drawAlt = 40;
  let snap = 0; // grid in metres, 0 = off
  let drag = null; // { index, mode: 'move' | 'alt', ... }
  let stroking = false;
  let strokeCommitted = false;
  let pts = ACTIVE_PATH.map((p) => [...p]);
  let curve = buildPathCurve(pts);
  let saved = null; // camera state to restore on exit
  const undoStack = [];
  const redoStack = [];
  let lastNear = Infinity; // closest approach to the ship, from the last rebuild

  // --- Scene objects (all in the ship frame, so the group rides with the ship)
  const root = new THREE.Group();
  root.name = 'path-editor';
  root.visible = false;
  scene.add(root);

  const linePos = new Float32Array(MAX_SAMPLES * 3);
  const lineCol = new Float32Array(MAX_SAMPLES * 3);
  const shadowPos = new Float32Array(MAX_SAMPLES * 3);
  const stemPos = new Float32Array(MAX_POINTS * 6);
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
  const rings = RINGS.map(([r, label]) => {
    const ringPts = [];
    for (let i = 0; i < 160; i++) {
      const a = (i / 160) * Math.PI * 2;
      ringPts.push(new THREE.Vector3(Math.cos(a) * r, 0.5, Math.sin(a) * r));
    }
    const line = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(ringPts), lineMat(0xffffff, r === 650 ? 0.3 : 0.16));
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

  const _col = new THREE.Color();
  const _c1 = new THREE.Color(CYAN);
  const _c2 = new THREE.Color(AMBER);
  const _qUp = new THREE.Vector3(0, 1, 0);
  const _mat = new THREE.Matrix4();
  const _unit = new THREE.Vector3();

  function rebuild() {
    curve = buildPathCurve(pts);
    const n = Math.min(MAX_SAMPLES - 1, (pts.length + 2) * 40);
    const v = new THREE.Vector3();
    let near = Infinity;
    for (let i = 0; i <= n; i++) {
      curve.getPoint(i / n, v);
      linePos.set([v.x, Math.max(v.y, MIN_ALT * 0.5), v.z], i * 3);
      shadowPos.set([v.x, 0.4, v.z], i * 3);
      _col.copy(_c1).lerp(_c2, THREE.MathUtils.clamp((v.y - 20) / 110, 0, 1));
      lineCol.set([_col.r, _col.g, _col.b], i * 3);
      near = Math.min(near, Math.hypot(v.x, v.y - SHIP_CENTER_Y, v.z));
    }
    pathLine.geometry.setDrawRange(0, n + 1);
    shadowLine.geometry.setDrawRange(0, n + 1);
    pathLine.geometry.attributes.position.needsUpdate = true;
    pathLine.geometry.attributes.color.needsUpdate = true;
    shadowLine.geometry.attributes.position.needsUpdate = true;

    while (handles.length < pts.length) {
      const m = new THREE.Mesh(sphere, handleMat);
      m.renderOrder = 12;
      root.add(m);
      handles.push(m);
      const b = new THREE.Sprite(new THREE.SpriteMaterial({ map: badgeFor(handles.length), depthTest: false, transparent: true }));
      b.renderOrder = 13;
      root.add(b);
      badges.push(b);
    }
    while (handles.length > pts.length) { root.remove(handles.pop()); root.remove(badges.pop()); }
    pts.forEach((p, i) => {
      handles[i].position.set(...p);
      handles[i].material = i === selected ? selectedMat : handleMat;
      stemPos.set([p[0], p[1], p[2], p[0], 0.4, p[2]], i * 6);
    });
    stems.geometry.setDrawRange(0, pts.length * 2);
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

    lastNear = near;
    refreshUI(len, near);
  }

  // --- UI -------------------------------------------------------------------------
  function setField(input, value) {
    if (document.activeElement !== input) input.value = value;
  }

  function refreshUI(len = curve.getLength(), near = lastNear) {
    const sel = pts[selected];
    const alts = pts.map((p) => p[1]);
    ui.sLen.textContent = `${(len / 1000).toFixed(2)} km`;
    ui.sTime.textContent = fmtTime(flightTimeForLength(len, 0.1));
    ui.sAlt.textContent = alts.length ? `${Math.min(...alts)}–${Math.max(...alts)} m` : '–';
    ui.sNear.textContent = Number.isFinite(near) ? `${Math.round(near)} m` : '–';

    ui.pointTitle.textContent = sel ? `Point ${selected + 1} of ${pts.length}` : (pts.length ? `${pts.length} points · none selected` : 'No points yet');
    ui.altLabel.textContent = sel ? 'Altitude' : 'Draw altitude';
    ui.fields.classList.toggle('off', !sel);
    [ui.x, ui.z, ui.altN].forEach((i) => { i.disabled = !sel; });
    if (sel) { setField(ui.x, sel[0]); setField(ui.z, sel[2]); setField(ui.altN, sel[1]); } else { ui.x.value = ui.z.value = ui.altN.value = ''; }
    ui.alt.value = sel ? sel[1] : drawAlt;
    ui.altOut.textContent = `${Math.round(sel ? sel[1] : drawAlt)} m`;
    ui.del.disabled = !sel || pts.length <= 1;
    ui.add.disabled = !sel || pts.length >= MAX_POINTS;
    ui.prev.disabled = ui.next.disabled = pts.length < 2;
    ui.undo.disabled = !undoStack.length;
    ui.redo.disabled = !redoStack.length;
    ui.apply.disabled = pts.length < 1;
    ui.restore.hidden = !CUSTOM_PATH;
    ui.move.classList.toggle('active', tool === 'move');
    ui.draw.classList.toggle('active', tool === 'draw');
    ui.snap.querySelectorAll('button').forEach((b) => b.classList.toggle('active', Number(b.dataset.snap) === snap));
    const some = pts.length > 0;
    [ui.smooth, ui.simplify, ui.mirror, ui.wider, ui.tighter, ui.raise, ui.lower].forEach((b) => { b.disabled = !some; });
    ui.smooth.disabled = pts.length < 3;
    ui.simplify.disabled = pts.length < 3;
    if (tool === 'draw') {
      ui.hint.textContent = COARSE
        ? 'Drag one finger on the sea to draw, or tap to add a point. Two fingers orbit and zoom. Set the altitude first.'
        : 'Drag on the sea to draw (or click to add a point). Right-drag orbits, scroll zooms. Set the altitude first.';
    } else {
      ui.hint.textContent = COARSE
        ? 'Tap a dot to select it, drag to move it. Fields and Alt arrows change it exactly. Drag empty sea to orbit.'
        : 'Drag a dot to move it, Shift-drag to change its altitude. Double-click the line to add a point. [ and ] step through points; Ctrl+Z undoes.';
    }
    if (CHUTE_MODE) ui.hint.textContent += ' The parachute opens at the last point.';
    if (pts.length < 1) ui.hint.textContent = 'Draw at least one point.';
  }

  function setTool(next) {
    tool = next;
    controls.mouseButtons.LEFT = tool === 'draw' ? null : THREE.MOUSE.ROTATE;
    controls.mouseButtons.RIGHT = tool === 'draw' ? THREE.MOUSE.ROTATE : THREE.MOUSE.PAN;
    // Touch: one finger orbits in Move mode, but in Draw mode it draws, so
    // OrbitControls only gets the two-finger pinch and pan.
    controls.touches.ONE = tool === 'draw' ? null : THREE.TOUCH.ROTATE;
    canvas.style.cursor = tool === 'draw' ? 'crosshair' : '';
    refreshUI();
  }

  // --- History ----------------------------------------------------------------------
  const snapshot = () => JSON.stringify({ pts, selected });
  function commit() {
    undoStack.push(snapshot());
    if (undoStack.length > HISTORY_MAX) undoStack.shift();
    redoStack.length = 0;
  }
  function restoreSnapshot(str) {
    const o = JSON.parse(str);
    pts = o.pts;
    selected = Math.min(o.selected, pts.length - 1);
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

  const snapV = (v) => (snap ? Math.round(v / snap) * snap : Math.round(v));

  function setAltitude(v) {
    v = clampAlt(v);
    if (pts[selected]) { commitOnce('alt'); pts[selected][1] = v; rebuild(); } else { drawAlt = v; refreshUI(); }
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

  function pickHandle(e) {
    let best = -1;
    let bestD = e.pointerType === 'touch' ? PICK_TOUCH_PX : PICK_PX;
    pts.forEach((p, i) => {
      const d = toPx(world(p), e);
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
    if (Math.abs(hit.x) > 6000 || Math.abs(hit.z) > 6000) return null;
    return [snapV(hit.x - root.position.x), alt, snapV(hit.z - root.position.z)];
  }

  function append(p) {
    if (pts.length >= MAX_POINTS) { toast(`Maximum ${MAX_POINTS} points`); return false; }
    if (!strokeCommitted) { commit(); strokeCommitted = true; }
    pts.push(p);
    selected = pts.length - 1;
    rebuild();
    return true;
  }
  const lastPoint = () => pts[pts.length - 1] ?? PATH_FIXED[PATH_FIXED.length - 1];

  // Active touch pointers. With two or more fingers the gesture belongs to
  // OrbitControls (pinch zoom, two-finger pan), so any drag or stroke ends.
  const touchIds = new Set();
  let touchDraw = null; // { id, x, y, moved }: a single finger in Draw mode

  function endGesture() {
    drag = null;
    stroking = false;
    touchDraw = null;
    controls.enabled = true;
  }

  // Registered on window in the capture phase, so a handle drag stops here and
  // never reaches the canvas (OrbitControls, main.js picking).
  function onPointerDown(e) {
    const touch = e.pointerType === 'touch';
    if (touch) touchIds.add(e.pointerId);
    if (!active || e.target !== canvas || e.button !== 0) return;
    if (touchIds.size > 1) { endGesture(); return; }
    strokeCommitted = false;
    if (tool === 'move') {
      const i = pickHandle(e);
      if (i >= 0) {
        selected = i;
        commit();
        if (e.shiftKey) {
          const dist = camera.position.distanceTo(world(pts[i]));
          const perPx = (2 * dist * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))) / canvas.getBoundingClientRect().height;
          drag = { index: i, mode: 'alt', y0: e.clientY, alt0: pts[i][1], perPx, moved: false };
        } else {
          drag = { index: i, mode: 'move', moved: false };
        }
        controls.enabled = false;
        rebuild();
        e.stopPropagation();
      } else {
        selected = -1;
        rebuild();
      }
    } else if (touch) {
      // Single finger: drawn on move, or a tap adds a point on pointerup.
      touchDraw = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false };
    } else {
      const p = groundPoint(e, drawAlt);
      if (!p) return;
      stroking = true;
      append([p[0], drawAlt, p[2]]);
      e.stopPropagation();
    }
  }

  function onPointerMove(e) {
    if (!active) return;
    if (drag) {
      if (drag.mode === 'alt') {
        const alt = clampAlt(drag.alt0 + (drag.y0 - e.clientY) * drag.perPx);
        if (alt !== pts[drag.index][1]) { pts[drag.index][1] = alt; drag.moved = true; rebuild(); }
      } else {
        const p = groundPoint(e, pts[drag.index][1]);
        if (p && (p[0] !== pts[drag.index][0] || p[2] !== pts[drag.index][2])) {
          pts[drag.index][0] = p[0]; pts[drag.index][2] = p[2]; drag.moved = true; rebuild();
        }
      }
    } else if (touchDraw && e.pointerId === touchDraw.id) {
      if (touchIds.size !== 1) return;
      if (!touchDraw.moved) {
        if (Math.hypot(e.clientX - touchDraw.x, e.clientY - touchDraw.y) < 8) return;
        touchDraw.moved = true;
        stroking = true;
        const first = groundPoint({ clientX: touchDraw.x, clientY: touchDraw.y }, drawAlt);
        if (first) append([first[0], drawAlt, first[2]]);
      }
      const p = groundPoint(e, drawAlt);
      const last = lastPoint();
      if (p && Math.hypot(p[0] - last[0], p[2] - last[2]) >= SPACING) append([p[0], drawAlt, p[2]]);
    } else if (stroking && e.buttons & 1) {
      const p = groundPoint(e, drawAlt);
      const last = lastPoint();
      if (p && Math.hypot(p[0] - last[0], p[2] - last[2]) >= SPACING) append([p[0], drawAlt, p[2]]);
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
    if (touchDraw && e.pointerId === touchDraw.id) {
      // A tap (no drag, no second finger) adds a point, like a click does.
      if (e.type === 'pointerup' && !touchDraw.moved && touchIds.size === 0 && active) {
        const p = groundPoint(e, drawAlt);
        if (p) append([p[0], drawAlt, p[2]]);
      }
      touchDraw = null;
    }
    stroking = false;
  }

  // Double-click on the line inserts a point where the curve is.
  function onDoubleClick(e) {
    if (!active || tool !== 'move' || e.target !== canvas) return;
    const N = 400;
    let best = null;
    let bestD = PICK_PX;
    const v = new THREE.Vector3();
    for (let i = 0; i <= N; i++) {
      curve.getPoint(i / N, v);
      const d = toPx(v.clone().add(root.position), e);
      if (d < bestD) { bestD = d; best = { i, p: v.clone() }; }
    }
    if (!best || pts.length >= MAX_POINTS) return;
    const segments = pts.length + 1; // PATH_FIXED(2) + pts => pts.length + 1 segments
    const k = Math.min(segments - 1, Math.floor((best.i / N) * segments));
    const at = Math.max(0, k - 1);
    commit();
    pts.splice(at, 0, [snapV(best.p.x), clampAlt(best.p.y), snapV(best.p.z)]);
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
    const a = pts[selected];
    if (!a) return;
    if (pts.length >= MAX_POINTS) { toast(`Maximum ${MAX_POINTS} points`); return; }
    const b = pts[selected + 1];
    let p;
    if (b) {
      p = [Math.round((a[0] + b[0]) / 2), Math.round((a[1] + b[1]) / 2), Math.round((a[2] + b[2]) / 2)];
    } else {
      // Last point: continue in the direction of travel from the point before it.
      const prev = pts[selected - 1] ?? PATH_FIXED[PATH_FIXED.length - 1];
      let dx = a[0] - prev[0];
      let dz = a[2] - prev[2];
      const len = Math.hypot(dx, dz);
      if (len < 1) { dx = 1; dz = 0; } else { dx /= len; dz /= len; }
      p = [Math.round(a[0] + dx * 300), a[1], Math.round(a[2] + dz * 300)];
    }
    commit();
    pts.splice(selected + 1, 0, p);
    selected += 1;
    rebuild();
  }
  function nudgeAltitude(d) {
    if (pts[selected]) { commit(); pts[selected][1] = clampAlt(pts[selected][1] + d); rebuild(); }
  }
  function step(d) {
    if (!pts.length) return;
    selected = selected < 0 ? (d > 0 ? 0 : pts.length - 1) : (selected + d + pts.length) % pts.length;
    rebuild();
  }

  // --- Whole-path tools -----------------------------------------------------------
  const keepValid = (list) => validatePath(list) ?? list;
  function transform(fn, message) {
    if (!pts.length) return;
    commit();
    pts = keepValid(fn(pts.map((p) => [...p])));
    selected = Math.min(selected, pts.length - 1);
    rebuild();
    if (message) toast(message, 2600);
  }
  const tools = {
    smooth: () => transform((p) => p.map((q, i) => {
      if (i === 0 || i === p.length - 1) return q;
      const a = p[i - 1];
      const b = p[i + 1];
      return [0.25 * a[0] + 0.5 * q[0] + 0.25 * b[0], 0.25 * a[1] + 0.5 * q[1] + 0.25 * b[1], 0.25 * a[2] + 0.5 * q[2] + 0.25 * b[2]];
    })),
    simplify: () => {
      const before = pts.length;
      const out = simplifyPoints([PATH_FIXED[PATH_FIXED.length - 1], ...pts], 12).slice(1);
      if (out.length >= before) { toast('Nothing to simplify: every point shapes the curve.', 2600); return; }
      transform(() => out, `Removed ${before - out.length} point${before - out.length === 1 ? '' : 's'}.`);
    },
    mirror: () => transform((p) => p.map(([x, y, z]) => [x, y, -z])),
    wider: () => transform((p) => p.map(([x, y, z]) => [x * 1.15, y, z * 1.15])),
    tighter: () => transform((p) => p.map(([x, y, z]) => [x * 0.87, y, z * 0.87])),
    raise: () => transform((p) => p.map(([x, y, z]) => [x, y + 10, z])),
    lower: () => transform((p) => p.map(([x, y, z]) => [x, y - 10, z])),
  };

  // --- Actions --------------------------------------------------------------------
  function apply() {
    const clean = validatePath(pts);
    if (!clean) { toast('This path is not valid.'); return; }
    try {
      if (JSON.stringify(clean) === JSON.stringify(DEFAULT_PATH)) localStorage.removeItem(PATH_STORAGE_KEY);
      else localStorage.setItem(PATH_STORAGE_KEY, JSON.stringify({ points: clean }));
    } catch {
      toast('Could not save the path (browser storage is blocked).');
      return;
    }
    dropSharedHash();
    location.reload();
  }

  function restoreDefault() {
    // Viewing a shared path: "restore" only leaves the link; the viewer's own saved path stays.
    if (!SHARED_PATH) { try { localStorage.removeItem(PATH_STORAGE_KEY); } catch { /* storage unavailable */ } }
    dropSharedHash();
    location.reload();
  }

  function deleteSelected() {
    if (!pts[selected] || pts.length <= 1) return;
    commit();
    pts.splice(selected, 1);
    selected = Math.min(selected, pts.length - 1);
    rebuild();
  }

  // Exact numbers for the selected point.
  function fieldChanged(axis, input) {
    const sel = pts[selected];
    if (!sel) return;
    const v = parseFloat(input.value);
    if (!Number.isFinite(v)) { refreshUI(); return; }
    commitOnce(`field-${axis}`);
    if (axis === 1) sel[1] = clampAlt(v);
    else sel[axis] = THREE.MathUtils.clamp(Math.round(v), -6000, 6000);
    rebuild();
  }

  ui.toggle.addEventListener('click', () => api.toggle());
  ui.move.addEventListener('click', () => setTool('move'));
  ui.draw.addEventListener('click', () => setTool('draw'));
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
  ui.del.addEventListener('click', deleteSelected);
  ui.add.addEventListener('click', addAfterSelected);
  ui.snap.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-snap]');
    if (b) { snap = Number(b.dataset.snap); refreshUI(); }
  });
  Object.entries(tools).forEach(([name, fn]) => ui[name].addEventListener('click', fn));
  // Phones: collapse the controls so the sea (and the path) is visible to draw on.
  ui.fold.addEventListener('click', () => {
    const folded = ui.panel.classList.toggle('folded');
    ui.fold.textContent = folded ? 'Show controls' : 'Hide controls';
    ui.fold.setAttribute('aria-expanded', String(!folded));
  });
  ui.clear.addEventListener('click', () => { commit(); pts = []; selected = -1; setTool('draw'); rebuild(); });
  ui.reset.addEventListener('click', () => { commit(); pts = DEFAULT_PATH.map((p) => [...p]); selected = -1; rebuild(); });
  ui.apply.addEventListener('click', apply);
  ui.cancel.addEventListener('click', () => api.exit());
  ui.restore.addEventListener('click', restoreDefault);
  ui.copy.addEventListener('click', async () => {
    const text = JSON.stringify(validatePath(pts) ?? pts);
    try { await navigator.clipboard.writeText(text); toast('Path copied to the clipboard.'); } catch { window.prompt('Copy this path:', text); }
  });
  ui.paste.addEventListener('click', () => {
    const text = window.prompt('Paste a path (JSON list of [x, altitude, z] points):');
    if (!text) return;
    try {
      const clean = validatePath(JSON.parse(text));
      if (!clean) throw new Error('invalid');
      commit(); pts = clean; selected = -1; rebuild();
    } catch { toast('That is not a valid path.'); }
  });

  // --- Mode ------------------------------------------------------------------------
  function frameCamera() {
    const all = [...PATH_FIXED, ...pts];
    const box = new THREE.Box3();
    for (const p of all) box.expandByPoint(tmp.set(p[0], 0, p[2]));
    box.expandByPoint(tmp.set(-80, 0, 0)).expandByPoint(tmp.set(80, 0, 0));
    const c = box.getCenter(new THREE.Vector3());
    const R = Math.max(150, box.getSize(new THREE.Vector3()).length() / 2);
    controls.target.set(c.x + root.position.x, 0, c.z);
    camera.position.set(c.x + root.position.x, R * 1.7 + 60, c.z + R * 0.55);
  }

  const api = {
    get active() { return active; },
    toggle() { active ? api.exit() : api.enter(); },
    enter() {
      if (active) return;
      active = true;
      saved = { pos: camera.position.clone(), target: controls.target.clone(), maxPolar: controls.maxPolarAngle };
      clock.playing = false;
      clock.seek(0);
      onEnter?.();
      pts = ACTIVE_PATH.map((p) => [...p]);
      selected = -1;
      undoStack.length = redoStack.length = 0;
      root.visible = true;
      ui.panel.hidden = false;
      ui.toggle.classList.add('active');
      document.body.classList.add('editing');
      controls.maxPolarAngle = Math.PI * 0.5;
      setTool('move');
      rebuild();
      frameCamera();
    },
    exit() {
      if (!active) return;
      active = false;
      drag = null; stroking = false; touchDraw = null;
      controls.enabled = true;
      setTool('move');
      canvas.style.cursor = '';
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
        const wp = world(pts[i]);
        const s = Math.max(2, cam.distanceTo(wp) * k * (i === selected ? 1.25 : 1));
        h.scale.setScalar(s);
        const b = badges[i];
        const show = pts.length <= 40 || i % 5 === 0 || i === selected;
        b.visible = show;
        if (show) {
          b.position.set(pts[i][0], pts[i][1] + s * 2.1, pts[i][2]);
          b.scale.setScalar(s * 2.1);
        }
      });
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
        case 'ArrowUp': if (pts[selected]) nudgeAltitude(big); else setAltitude(drawAlt + big); break;
        case 'ArrowDown': if (pts[selected]) nudgeAltitude(-big); else setAltitude(drawAlt - big); break;
        case '[': step(-1); break;
        case ']': step(1); break;
        case 'm': case 'M': setTool('move'); break;
        case 'd': case 'D': setTool('draw'); break;
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

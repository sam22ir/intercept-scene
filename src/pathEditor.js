import * as THREE from 'three';
import {
  ACTIVE_PATH, DEFAULT_PATH, CUSTOM_PATH, PATH_FIXED, PATH_STORAGE_KEY, MIN_ALT, CHUTE_MODE,
  buildPathCurve, validatePath, shipPos,
} from './scenario.js';

// Path editor: draw or adjust the drone's flight path in the ship frame.
// Edits live in memory (preview only) until "Apply & play", which stores the
// points in localStorage and reloads, because the whole scenario (missile
// guidance, debris, particles, events) is baked from the path at load.

const CYAN = 0x35e0ff;
const ORANGE = 0xff7a1a;
const MAX_SAMPLES = 1400;
const MAX_POINTS = 80;
const SPACING = 60; // m between freehand points
const PICK_PX = 14;

let toastEl = null;
let toastTimer = 0;
export function toast(msg, ms = 5200) {
  toastEl ??= Object.assign(document.body.appendChild(document.createElement('div')), { className: 'toast' });
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), ms);
}

export function createPathEditor({ scene, camera, controls, canvas, clock, onEnter, onExit }) {
  const $ = (s) => document.querySelector(s);
  const ui = {
    panel: $('#editor'), toggle: $('#btn-edit'), move: $('#ed-tool-move'), draw: $('#ed-tool-draw'),
    alt: $('#ed-alt'), altOut: $('#ed-alt-out'), altLabel: $('#ed-alt-label'), del: $('#ed-delete'),
    clear: $('#ed-clear'), reset: $('#ed-reset'), apply: $('#ed-apply'), cancel: $('#ed-cancel'),
    info: $('#ed-info'), copy: $('#ed-copy'), paste: $('#ed-import'), restore: $('#ed-restore'), hint: $('#ed-hint'),
  };

  let active = false;
  let tool = 'move';
  let selected = -1;
  let drawAlt = 40;
  let drag = null; // { index, plane }
  let stroking = false;
  let pts = ACTIVE_PATH.map((p) => [...p]);
  let curve = buildPathCurve(pts);
  let saved = null; // camera state to restore on exit

  // --- Scene objects (all in the ship frame, so the group rides with the ship)
  const root = new THREE.Group();
  root.name = 'path-editor';
  root.visible = false;
  scene.add(root);

  const linePos = new Float32Array(MAX_SAMPLES * 3);
  const shadowPos = new Float32Array(MAX_SAMPLES * 3);
  const stemPos = new Float32Array(MAX_POINTS * 6);
  const mkLine = (arr, Kind, mat) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(arr, 3));
    const o = new Kind(g, mat);
    o.frustumCulled = false;
    o.renderOrder = 10;
    root.add(o);
    return o;
  };
  const lineMat = (color, opacity) => new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthTest: false });
  const pathLine = mkLine(linePos, THREE.Line, lineMat(CYAN, 0.95));
  const shadowLine = mkLine(shadowPos, THREE.Line, lineMat(0xbfeeff, 0.35));
  const stems = mkLine(stemPos, THREE.LineSegments, lineMat(CYAN, 0.28));

  const sphere = new THREE.SphereGeometry(1, 16, 12);
  const handleMat = new THREE.MeshBasicMaterial({ color: CYAN, depthTest: false, transparent: true, opacity: 0.95 });
  const selectedMat = new THREE.MeshBasicMaterial({ color: ORANGE, depthTest: false });
  const fixedMat = new THREE.MeshBasicMaterial({ color: 0x8a949c, depthTest: false, transparent: true, opacity: 0.8 });
  const handles = [];
  const fixedMarks = PATH_FIXED.map((p) => {
    const m = new THREE.Mesh(sphere, fixedMat);
    m.position.set(...p);
    m.renderOrder = 11;
    root.add(m);
    return m;
  });

  function rebuild() {
    curve = buildPathCurve(pts);
    const n = Math.min(MAX_SAMPLES - 1, (pts.length + 2) * 40);
    const v = new THREE.Vector3();
    for (let i = 0; i <= n; i++) {
      curve.getPoint(i / n, v);
      linePos.set([v.x, Math.max(v.y, MIN_ALT * 0.5), v.z], i * 3);
      shadowPos.set([v.x, 0.4, v.z], i * 3);
    }
    pathLine.geometry.setDrawRange(0, n + 1);
    shadowLine.geometry.setDrawRange(0, n + 1);
    pathLine.geometry.attributes.position.needsUpdate = true;
    shadowLine.geometry.attributes.position.needsUpdate = true;

    while (handles.length < pts.length) {
      const m = new THREE.Mesh(sphere, handleMat);
      m.renderOrder = 12;
      root.add(m);
      handles.push(m);
    }
    while (handles.length > pts.length) root.remove(handles.pop());
    pts.forEach((p, i) => {
      handles[i].position.set(...p);
      handles[i].material = i === selected ? selectedMat : handleMat;
      stemPos.set([p[0], p[1], p[2], p[0], 0.4, p[2]], i * 6);
    });
    stems.geometry.setDrawRange(0, pts.length * 2);
    stems.geometry.attributes.position.needsUpdate = true;
    refreshUI();
  }

  // --- UI -------------------------------------------------------------------------
  function refreshUI() {
    const km = curve.getLength() / 1000;
    const sel = pts[selected];
    ui.altLabel.textContent = sel ? `Point ${selected + 1} altitude` : 'Draw altitude';
    ui.alt.value = sel ? sel[1] : drawAlt;
    ui.altOut.textContent = `${Math.round(sel ? sel[1] : drawAlt)} m`;
    ui.del.disabled = !sel || pts.length <= 1;
    ui.apply.disabled = pts.length < 1;
    ui.restore.hidden = !CUSTOM_PATH;
    ui.move.classList.toggle('active', tool === 'move');
    ui.draw.classList.toggle('active', tool === 'draw');
    ui.info.textContent = `${pts.length} point${pts.length === 1 ? '' : 's'} · ${km.toFixed(2)} km`
      + (sel ? ` · #${selected + 1}: ${Math.round(Math.hypot(sel[0], sel[2]))} m from ship` : '')
      + (CUSTOM_PATH ? ' · custom path active' : '')
      + (pts.length < 1 ? ' · draw at least one point' : '');
    ui.hint.textContent = tool === 'draw'
      ? 'Drag on the sea to draw (or click to add a point). Right-drag orbits, scroll zooms. Set the altitude below first.'
      : 'Drag a dot to move it. Double-click the line to add a point. Delete removes the selected one. ↑/↓ change altitude.';
    if (CHUTE_MODE) ui.hint.textContent += ' The parachute opens at the last point.';
  }

  function setTool(next) {
    tool = next;
    controls.mouseButtons.LEFT = tool === 'draw' ? null : THREE.MOUSE.ROTATE;
    controls.mouseButtons.RIGHT = tool === 'draw' ? THREE.MOUSE.ROTATE : THREE.MOUSE.PAN;
    canvas.style.cursor = tool === 'draw' ? 'crosshair' : '';
    refreshUI();
  }

  function setAltitude(v) {
    v = THREE.MathUtils.clamp(Math.round(v), MIN_ALT, 600);
    if (pts[selected]) { pts[selected][1] = v; rebuild(); } else { drawAlt = v; refreshUI(); }
  }

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
    let bestD = PICK_PX;
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
    return [Math.round(hit.x - root.position.x), alt, Math.round(hit.z - root.position.z)];
  }

  function append(p) {
    if (pts.length >= MAX_POINTS) { toast(`Maximum ${MAX_POINTS} points`); return false; }
    pts.push(p);
    selected = pts.length - 1;
    rebuild();
    return true;
  }
  const lastPoint = () => pts[pts.length - 1] ?? PATH_FIXED[PATH_FIXED.length - 1];

  function onPointerDown(e) {
    if (!active || e.target !== canvas || e.button !== 0) return;
    if (tool === 'move') {
      const i = pickHandle(e);
      if (i >= 0) {
        selected = i;
        drag = { index: i };
        controls.enabled = false;
        rebuild();
        e.stopPropagation();
      } else {
        selected = -1;
        refreshUI();
        rebuild();
      }
    } else {
      const p = groundPoint(e, pts[selected] ? pts[selected][1] : drawAlt);
      if (!p) return;
      stroking = true;
      append([p[0], drawAlt, p[2]]);
      e.stopPropagation();
    }
  }

  function onPointerMove(e) {
    if (!active) return;
    if (drag) {
      const p = groundPoint(e, pts[drag.index][1]);
      if (p) { pts[drag.index][0] = p[0]; pts[drag.index][2] = p[2]; rebuild(); }
    } else if (stroking && e.buttons & 1) {
      const p = groundPoint(e, drawAlt);
      const last = lastPoint();
      if (p && Math.hypot(p[0] - last[0], p[2] - last[2]) >= SPACING) append([p[0], drawAlt, p[2]]);
    }
  }

  function onPointerUp() {
    if (drag) { drag = null; controls.enabled = true; }
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
    pts.splice(at, 0, [Math.round(best.p.x), Math.round(Math.max(best.p.y, MIN_ALT)), Math.round(best.p.z)]);
    selected = at;
    rebuild();
  }

  window.addEventListener('pointerdown', onPointerDown, true);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('dblclick', onDoubleClick);

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
    location.reload();
  }

  function restoreDefault() {
    try { localStorage.removeItem(PATH_STORAGE_KEY); } catch { /* storage unavailable */ }
    location.reload();
  }

  function deleteSelected() {
    if (!pts[selected] || pts.length <= 1) return;
    pts.splice(selected, 1);
    selected = Math.min(selected, pts.length - 1);
    rebuild();
  }

  ui.toggle.addEventListener('click', () => api.toggle());
  ui.move.addEventListener('click', () => setTool('move'));
  ui.draw.addEventListener('click', () => setTool('draw'));
  ui.alt.addEventListener('input', () => setAltitude(parseFloat(ui.alt.value)));
  ui.del.addEventListener('click', deleteSelected);
  ui.clear.addEventListener('click', () => { pts = []; selected = -1; setTool('draw'); rebuild(); });
  ui.reset.addEventListener('click', () => { pts = DEFAULT_PATH.map((p) => [...p]); selected = -1; rebuild(); });
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
      pts = clean; selected = -1; rebuild();
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
      drag = null; stroking = false;
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
      handles.forEach((h, i) => h.scale.setScalar(Math.max(2, camera.position.distanceTo(world(pts[i])) * k)));
      fixedMarks.forEach((m) => m.scale.setScalar(Math.max(1.2, camera.position.distanceTo(m.getWorldPosition(tmp)) * k * 0.6)));
    },
    onKey(key, e) {
      const big = e?.shiftKey ? 25 : 5;
      switch (key) {
        case 'Escape': api.exit(); break;
        case 'Delete': case 'Backspace': deleteSelected(); break;
        case 'ArrowUp': setAltitude((pts[selected]?.[1] ?? drawAlt) + big); break;
        case 'ArrowDown': setAltitude((pts[selected]?.[1] ?? drawAlt) - big); break;
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

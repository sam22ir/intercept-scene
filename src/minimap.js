import * as THREE from 'three';
import { scenario, shipPos, planePos, planeVel, missilePos, missileTrailPoints } from './scenario.js';
import { TRAIL_COLORS } from './trails.js';
import {
  autoRadius, loadMapView, pointerAngle, radiusAtAngle, radiusLabel, ringAngle, ringStep, saveMapView, wheelRadius,
} from './mapView.js';

// Mini map: a small translucent round radar at the bottom of the screen, beside the timeline, with the bow pointing up
// (so ahead is up, starboard is right). It is centred on the ship or the drone (the small buttons at its corner) and shows
// the ship, each drone and each missile with the way they are heading, plus their paths in the ship's frame (the part
// already flown is bright, the rest faint). Everything is a pure function of t and the view, so it scrubs both ways. The wheel
// over it or the ring round its rim zooms, Auto goes back to following everything, and M hides it. The view is remembered.

const PATH_DT = 0.5; // s between path samples

const hex = (c) => `#${c.toString(16).padStart(6, '0')}`;

const ICON_SHIP = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5l4 6.5v12.5H8V9z"/></svg>';
const ICON_DRONE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5c1 1.4 1.3 3.2 1.3 5.5v2l8.2 3v2.2l-8.2-1.6v3.6l2.7 2v1.6L12 19.7l-4 1.1v-1.6l2.7-2v-3.6l-8.2 1.6V13l8.2-3V8c0-2.3.3-4.1 1.3-5.5z"/></svg>';
const ICON_RINGS = '<svg class="line" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4"/></svg>';

// dronePosAt(t, out, k): the drone's world position, resolving to its wreck after the hit.
export function createMinimap({ dronePosAt }) {
  const root = document.querySelector('#minimap');
  const canvas = root.querySelector('canvas');
  const label = root.querySelector('.mm-scale');
  const ctx = canvas.getContext('2d');
  const dpr = Math.min(globalThis.devicePixelRatio || 1, 2);

  const _s = new THREE.Vector3();
  const _a = new THREE.Vector3();
  const _b = new THREE.Vector3();
  const _v = new THREE.Vector3();

  // Per drone and missile: paths in the ship frame (x ahead, z starboard), sampled once.
  const engagements = scenario.hasMissile ? scenario.engagements : [null];
  const sets = engagements.map((e, k) => {
    const dr = scenario.drones[k];
    const t0 = dr.tLoad;
    const t1 = e ? e.tHit : scenario.tSplash;
    const drone = [];
    for (let t = t0; t < t1; t += PATH_DT) {
      planePos(t, _a, k).sub(shipPos(t, _s));
      drone.push({ t, x: _a.x, z: _a.z });
    }
    let missile = [];
    if (e) {
      missile = missileTrailPoints(25, k).map((p) => {
        shipPos(p.t, _s);
        return { t: p.t, x: p.pos.x - _s.x, z: p.pos.z - _s.z };
      });
    }
    return { e, k, t0, t1, drone, missile };
  });

  let enabled = true;
  const view = loadMapView();
  let lastKey = '';

  // The controls: the centre at the disc's lower left, Auto at its lower right, the ring round its rim.
  root.title = 'Mini map, bow up. Scroll over it or drag the ring to zoom, M to hide it.';
  root.classList.add('map-tools');
  const ctl = document.createElement('div');
  ctl.className = 'map-center';
  ctl.setAttribute('role', 'group');
  ctl.setAttribute('aria-label', 'Map centre');
  ctl.innerHTML = `<button type="button" data-center="ship" title="Centre the map on the ship" aria-label="Centre the map on the ship">${ICON_SHIP}</button>`
    + `<button type="button" data-center="drone" title="Centre the map on the drone" aria-label="Centre the map on the drone">${ICON_DRONE}</button>`
    + `<button type="button" data-rings title="Show or hide the range rings" aria-label="Show or hide the range rings">${ICON_RINGS}</button>`;
  const auto = document.createElement('button');
  auto.type = 'button';
  auto.className = 'map-auto';
  auto.textContent = 'Auto';
  auto.title = 'Zoom by itself to keep everything on the map';
  const ring = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  ring.setAttribute('class', 'map-ring');
  ring.setAttribute('viewBox', '0 0 100 100');
  ring.setAttribute('aria-hidden', 'true');
  const arc = (r, deg) => [50 + r * Math.sin((deg * Math.PI) / 180), 50 - r * Math.cos((deg * Math.PI) / 180)].map((v) => v.toFixed(2)).join(' ');
  const RING_R = 47.5;
  const trackPath = `M${arc(RING_R, -140)} A${RING_R} ${RING_R} 0 1 1 ${arc(RING_R, 140)}`;
  ring.innerHTML = `<path class="map-ring-hit" d="${trackPath}"/><path class="map-ring-track" d="${trackPath}"/><circle class="map-ring-knob" r="3"/>`;
  const knob = ring.querySelector('circle');
  root.append(ring, ctl, auto);

  function setView(change) {
    Object.assign(view, change);
    saveMapView(view);
    lastKey = '';
    showView();
  }
  function showView() {
    ctl.querySelectorAll('button').forEach((b) => {
      const on = 'rings' in b.dataset ? view.rings === true : b.dataset.center === view.center;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
    });
    auto.classList.toggle('active', view.radius === null);
    auto.setAttribute('aria-pressed', String(view.radius === null));
  }
  showView();
  ctl.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-center]');
    if (b) setView({ center: b.dataset.center });
    if (e.target.closest('button[data-rings]')) setView({ rings: !view.rings });
  });
  auto.addEventListener('click', () => setView({ radius: null }));
  root.addEventListener('wheel', (e) => {
    e.preventDefault();
    e.stopPropagation();
    setView({ radius: wheelRadius(shown, e.deltaY) });
  }, { passive: false });
  const ringTo = (e) => {
    const r = canvas.getBoundingClientRect();
    setView({ radius: radiusAtAngle(pointerAngle(e.clientX - r.left - r.width / 2, e.clientY - r.top - r.height / 2)) });
  };
  const hit = ring.querySelector('.map-ring-hit');
  hit.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    hit.setPointerCapture(e.pointerId);
    ringTo(e);
  });
  hit.addEventListener('pointermove', (e) => { if (hit.hasPointerCapture(e.pointerId)) ringTo(e); });

  // The disc's size comes from the CSS (--map-d: larger on desktop, 150 px on phones), so it is
  // measured again when the window changes size.
  let SIZE = 0;
  function size() {
    const d = Math.round(parseFloat(getComputedStyle(document.body).getPropertyValue('--map-d'))) || 150;
    if (d === SIZE) return;
    SIZE = d;
    canvas.width = SIZE * dpr;
    canvas.height = SIZE * dpr;
    canvas.style.width = canvas.style.height = `${SIZE}px`;
    lastKey = '';
  }
  size();
  window.addEventListener('resize', size);

  // Where the map is centred at t, in the ship's frame: the ship herself, or the drone (its wreck after the hit).
  function centreAt(t, out) {
    if (view.center !== 'drone') return out.set(0, 0, 0);
    dronePosAt(t, out, 0);
    return out.setX(out.x - shipPos(t, _s).x);
  }

  const _c = new THREE.Vector3();
  // The largest distance from the centre of anything the map is following at t.
  function reach(t) {
    centreAt(t, _c);
    let far = Math.hypot(_c.x, _c.z); // the ship
    shipPos(t, _s);
    for (const s of sets) {
      if (t >= s.t0 && (!s.e || t < s.e.tHit + 2)) {
        dronePosAt(t, _a, s.k);
        far = Math.max(far, Math.hypot(_a.x - _s.x - _c.x, _a.z - _c.z));
      }
      if (s.e && t > s.e.tLaunch && t < s.e.tHit) {
        missilePos(t, _b, s.k);
        far = Math.max(far, Math.hypot(_b.x - _s.x - _c.x, _b.z - _c.z));
      }
    }
    return far;
  }

  let shown = 1000; // the radius last drawn: where the wheel starts from
  const radiusAt = (t) => view.radius ?? autoRadius(reach(t));

  function draw(t) {
    const R = radiusAt(t);
    shown = R;
    const half = SIZE / 2;
    const rim = half - 6;
    const k = rim / R;
    centreAt(t, _c);
    const cx = _c.x;
    const cz = _c.z;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, SIZE, SIZE);
    // Map frame: the origin at the centre chosen, x ahead is up the screen, z starboard is right.
    const px = (z) => half + (z - cz) * k;
    const py = (x) => half - (x - cx) * k;
    const clampTo = (x, y) => { // keep a marker on the disc
      const dx = x - half;
      const dy = y - half;
      const d = Math.hypot(dx, dy);
      return d > rim ? [half + (dx / d) * rim, half + (dy / d) * rim, true] : [x, y, false];
    };

    // Range rings round the ship and the cross (only when asked for), and the bow tick.
    ctx.lineWidth = 1;
    ctx.font = '9px system-ui, sans-serif';
    ctx.textAlign = 'left';
    const shipX = px(0);
    const shipY = py(0);
    if (view.rings) {
      ctx.strokeStyle = 'rgba(255,255,255,0.16)';
      const step = ringStep(R);
      const off = Math.hypot(cx, cz);
      for (let r = step; r <= off + R + 1e-6; r += step) {
        if (r < off - R) continue;
        ctx.beginPath();
        ctx.arc(shipX, shipY, r * k, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.strokeStyle = 'rgba(255,255,255,0.1)';
      ctx.beginPath();
      ctx.moveTo(half, half - rim); ctx.lineTo(half, half + rim);
      ctx.moveTo(half - rim, half); ctx.lineTo(half + rim, half);
      ctx.stroke();
    }
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.beginPath();
    ctx.moveTo(half, 3); ctx.lineTo(half - 3.5, 10); ctx.lineTo(half + 3.5, 10); ctx.closePath();
    ctx.fill();

    // Paths: faint for what is ahead, bright for what has been flown.
    const trace = (pts, color, upTo, width) => {
      if (pts.length < 2) return;
      ctx.lineWidth = width;
      ctx.strokeStyle = color;
      ctx.beginPath();
      let started = false;
      for (const p of pts) {
        if (p.t > upTo) break;
        const [x, y] = [px(p.z), py(p.x)];
        if (started) ctx.lineTo(x, y); else { ctx.moveTo(x, y); started = true; }
      }
      ctx.stroke();
    };
    for (const s of sets) {
      const dc = hex(s.k ? TRAIL_COLORS.drone2 : TRAIL_COLORS.drone);
      ctx.globalAlpha = 0.28;
      trace(s.drone, dc, Infinity, 1.4);
      ctx.globalAlpha = 0.85;
      trace(s.drone, dc, t, 1.6);
      if (s.e && t > s.e.tLaunch - 1) {
        const mc = hex(s.k ? TRAIL_COLORS.missile2 : TRAIL_COLORS.missile);
        ctx.globalAlpha = 0.3;
        trace(s.missile, mc, Infinity, 1.2);
        ctx.globalAlpha = 0.95;
        trace(s.missile, mc, t, 1.6);
      }
      ctx.globalAlpha = 1;
    }

    // An arrow: a triangle at (x, y) pointing along (dx, dy) in map space.
    const arrow = (x, y, dx, dy, len, color, edge) => {
      const d = Math.hypot(dx, dy) || 1;
      const ux = dx / d;
      const uy = dy / d;
      ctx.fillStyle = color;
      ctx.strokeStyle = 'rgba(8,12,18,0.85)';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(x + ux * len, y + uy * len);
      ctx.lineTo(x - ux * len * 0.7 - uy * len * 0.62, y - uy * len * 0.7 + ux * len * 0.62);
      ctx.lineTo(x - ux * len * 0.35, y - uy * len * 0.35);
      ctx.lineTo(x - ux * len * 0.7 + uy * len * 0.62, y - uy * len * 0.7 - ux * len * 0.62);
      ctx.closePath();
      ctx.globalAlpha = edge ? 0.55 : 1;
      ctx.fill();
      ctx.stroke();
      ctx.globalAlpha = 1;
    };

    // The ship, pointing up: on the rim, fainter, when she is off the map.
    const [hx, hy, hEdge] = clampTo(shipX, shipY);
    ctx.fillStyle = hex(TRAIL_COLORS.ship);
    ctx.strokeStyle = 'rgba(8,12,18,0.85)';
    ctx.lineWidth = 1.2;
    ctx.globalAlpha = hEdge ? 0.55 : 1;
    ctx.beginPath();
    ctx.moveTo(hx, hy - 9);
    ctx.lineTo(hx + 4, hy - 3); ctx.lineTo(hx + 3.5, hy + 8); ctx.lineTo(hx - 3.5, hy + 8); ctx.lineTo(hx - 4, hy - 3);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.globalAlpha = 1;

    shipPos(t, _s);
    for (const s of sets) {
      // Drone: an arrow along its heading while it flies, a cross once it is down.
      if (t >= s.t0) {
        dronePosAt(t, _a, s.k);
        const [x0, y0] = [px(_a.z), py(_a.x - _s.x)];
        const [x, y, edge] = clampTo(x0, y0);
        const color = hex(s.k ? TRAIL_COLORS.drone2 : TRAIL_COLORS.drone);
        const down = s.e ? t >= s.e.tHit : t >= scenario.tSplash;
        if (down) {
          ctx.strokeStyle = color;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(x - 4, y - 4); ctx.lineTo(x + 4, y + 4);
          ctx.moveTo(x + 4, y - 4); ctx.lineTo(x - 4, y + 4);
          ctx.stroke();
        } else {
          planeVel(t, _v, s.k); // world velocity; the map is the ship's frame, which only translates
          arrow(x, y, _v.z, -_v.x, 7.5, color, edge);
        }
      }
      // Missile: a small arrow while it flies; a ring where it burst.
      if (s.e) {
        if (t > s.e.tLaunch && t < s.e.tHit) {
          missilePos(t - 0.02, _a, s.k);
          missilePos(t + 0.02, _b, s.k);
          const d = _b.sub(_a);
          missilePos(t, _a, s.k);
          const [x, y, edge] = clampTo(px(_a.z - _s.z), py(_a.x - _s.x));
          arrow(x, y, d.z, -d.x, 5.5, hex(s.k ? TRAIL_COLORS.missile2 : TRAIL_COLORS.missile), edge);
        } else if (t >= s.e.tHit && t < s.e.tHit + 2.5) {
          const u = (t - s.e.tHit) / 2.5;
          const [x, y] = clampTo(px(s.e.hitPos.z - shipPos(s.e.tHit, _b).z), py(s.e.hitPos.x - shipPos(s.e.tHit, _b).x));
          ctx.strokeStyle = `rgba(255,170,60,${1 - u})`;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(x, y, 3 + 11 * u, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
    }

    label.textContent = `${view.radius === null ? 'AUTO · ' : ''}${radiusLabel(R)}`;
    const deg = ringAngle(R);
    knob.setAttribute('cx', (50 + RING_R * Math.sin((deg * Math.PI) / 180)).toFixed(2));
    knob.setAttribute('cy', (50 - RING_R * Math.cos((deg * Math.PI) / 180)).toFixed(2));
  }

  const api = {
    get enabled() { return enabled; },
    get view() { return { ...view, shown }; },
    setEnabled(on) { enabled = on; root.hidden = !on; document.body.classList.toggle('has-map', on); lastKey = ''; },
    // Redraws only when the moment or the view changed.
    update(t) {
      if (!enabled) return;
      const key = `${t}|${view.center}|${view.radius}`;
      if (key === lastKey) return;
      lastKey = key;
      draw(t);
    },
  };
  // Sit just above the timeline, whatever height it has on this screen.
  const tl = document.querySelector('.timeline');
  if (tl && typeof ResizeObserver === 'function') {
    new ResizeObserver(() => document.documentElement.style.setProperty('--tl-h', `${tl.offsetHeight}px`)).observe(tl);
  }
  return api;
}

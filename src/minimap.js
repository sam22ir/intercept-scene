import * as THREE from 'three';
import { scenario, shipPos, planePos, planeVel, missilePos, missileTrailPoints } from './scenario.js';
import { TRAIL_COLORS } from './trails.js';

// Mini map: a small translucent round radar at the bottom of the screen, beside the timeline. It is centred on
// the ship with the bow pointing up (so ahead is up, starboard is right) and shows the
// ship, each drone and each missile with the way they are heading, plus their paths in the
// ship's frame (the part already flown is bright, the rest faint). Everything is a pure
// function of t, so it scrubs both ways. Click it to change the zoom; M hides it.

const SIZE = 124; // CSS px: fits beside the timeline panel
const SCALES = [300, 500, 750, 1000, 1500, 2000, 3000]; // auto-zoom steps: metres to the rim
const ZOOMS = ['auto', 500, 1000, 2000]; // what a click cycles through
const PATH_DT = 0.5; // s between path samples

const hex = (c) => `#${c.toString(16).padStart(6, '0')}`;

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

  // Per drone / missile pair: paths in the ship frame (x ahead, z starboard), sampled once.
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
  let zoom = 0; // index into ZOOMS
  let lastKey = '';

  function size() {
    canvas.width = SIZE * dpr;
    canvas.height = SIZE * dpr;
    canvas.style.width = canvas.style.height = `${SIZE}px`;
    lastKey = '';
  }
  size();

  // The largest distance from the ship of anything the map is following at t.
  function reach(t) {
    let far = 0;
    for (const s of sets) {
      if (t >= s.t0 && (!s.e || t < s.e.tHit + 2)) {
        dronePosAt(t, _a, s.k);
        far = Math.max(far, Math.hypot(_a.x - shipPos(t, _s).x, _a.z));
      }
      if (s.e && t > s.e.tLaunch && t < s.e.tHit) {
        missilePos(t, _b, s.k);
        far = Math.max(far, Math.hypot(_b.x - shipPos(t, _s).x, _b.z));
      }
    }
    return far;
  }

  function radiusAt(t) {
    const z = ZOOMS[zoom];
    if (z !== 'auto') return z;
    const want = Math.max(reach(t) * 1.15, 250);
    return SCALES.find((r) => r >= want) ?? SCALES[SCALES.length - 1];
  }

  const niceStep = (R) => (R >= 2000 ? 500 : R >= 1000 ? 250 : R >= 500 ? 100 : 50);

  function draw(t) {
    const R = radiusAt(t);
    const half = SIZE / 2;
    const rim = half - 6;
    const k = rim / R;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, SIZE, SIZE);
    // Map frame: origin at the ship, x ahead is up the screen, z starboard is right.
    const px = (z) => half + z * k;
    const py = (x) => half - x * k;
    const clampTo = (x, y) => { // keep a marker on the disc
      const dx = x - half;
      const dy = y - half;
      const d = Math.hypot(dx, dy);
      return d > rim ? [half + (dx / d) * rim, half + (dy / d) * rim, true] : [x, y, false];
    };

    // Range rings and the bow tick.
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(255,255,255,0.16)';
    ctx.fillStyle = 'rgba(255,255,255,0.4)';
    ctx.font = '9px system-ui, sans-serif';
    ctx.textAlign = 'left';
    const step = niceStep(R);
    for (let r = step; r <= R + 1e-6; r += step) {
      ctx.beginPath();
      ctx.arc(half, half, r * k, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.1)';
    ctx.beginPath();
    ctx.moveTo(half, half - rim); ctx.lineTo(half, half + rim);
    ctx.moveTo(half - rim, half); ctx.lineTo(half + rim, half);
    ctx.stroke();
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

    // Ship at the centre, pointing up.
    ctx.fillStyle = hex(TRAIL_COLORS.ship);
    ctx.strokeStyle = 'rgba(8,12,18,0.85)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(half, half - 9);
    ctx.lineTo(half + 4, half - 3); ctx.lineTo(half + 3.5, half + 8); ctx.lineTo(half - 3.5, half + 8); ctx.lineTo(half - 4, half - 3);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

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

    label.textContent = `${ZOOMS[zoom] === 'auto' ? 'AUTO · ' : ''}${R >= 1000 ? `${R / 1000} km` : `${R} m`}`;
  }

  const api = {
    get enabled() { return enabled; },
    setEnabled(on) { enabled = on; root.hidden = !on; document.body.classList.toggle('has-map', on); lastKey = ''; },
    cycleZoom() { zoom = (zoom + 1) % ZOOMS.length; lastKey = ''; },
    // Redraws only when the moment or the zoom changed.
    update(t) {
      if (!enabled) return;
      const key = `${t}|${zoom}`;
      if (key === lastKey) return;
      lastKey = key;
      draw(t);
    },
  };
  root.addEventListener('click', () => api.cycleZoom());
  // Sit just above the timeline, whatever height it has on this screen.
  const tl = document.querySelector('.timeline');
  if (tl && typeof ResizeObserver === 'function') {
    new ResizeObserver(() => document.documentElement.style.setProperty('--tl-h', `${tl.offsetHeight}px`)).observe(tl);
  }
  return api;
}

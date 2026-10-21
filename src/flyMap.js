import { shipPos } from './scenario.js';

// The map of the manual-flight mission: the same round translucent disc as the other missions' maps,
// bow up (screen up = +X, screen right = +Z, the ship's frame unrotated), but centred on the DRONE, because
// the drone is what travels. The ship is always findable: the scale zooms out to keep it in the disc
// (auto), or, at a fixed zoom, a small marker on the rim points to it. It shows the drone as an arrow
// along its heading with its track behind it, the ship, the missile, and a cross where the wreck went down.
// Click it to change the zoom; M hides it.

const SCALES = [600, 1000, 2000, 4000, 8000, 16000, 32000]; // auto-zoom steps: metres to the rim
const ZOOMS = ['auto', 1000, 4000, 16000];
const TRACK_STEP = 0.5; // s between track samples
const TRACK_MAX = 240; // samples kept (two minutes)
const GREEN = '#3ddc84';
const ORANGE = '#ff7a1a';
const CYAN = '#35c8ff';
const RED = '#ff5d61';

export function createFlyMap() {
  const root = document.querySelector('#minimap');
  const canvas = root.querySelector('canvas');
  const label = root.querySelector('.mm-scale');
  const ctx = canvas.getContext('2d');
  const dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
  // The disc's size comes from the CSS (--map-d), measured again when the window changes size.
  let SIZE = 0;
  function measure() {
    const d = Math.round(parseFloat(getComputedStyle(document.body).getPropertyValue('--map-d'))) || 150;
    if (d === SIZE) return;
    SIZE = d;
    canvas.width = SIZE * dpr;
    canvas.height = SIZE * dpr;
    canvas.style.width = canvas.style.height = `${SIZE}px`;
  }
  measure();
  window.addEventListener('resize', measure);

  let enabled = true;
  let zoom = 0;
  const track = []; // { x, z } of the drone, oldest first
  let trackT = -Infinity;
  const ship = { x: 0, y: 0, z: 0 };
  const _s = { set(x, y, z) { ship.x = x; ship.y = y; ship.z = z; return ship; } };

  function sample(sim) {
    if (sim.t < trackT) { track.length = 0; trackT = -Infinity; } // the sim was reset
    if (sim.t - trackT >= TRACK_STEP && (sim.phase !== 'deck')) {
      track.push({ x: sim.pos.x, z: sim.pos.z });
      if (track.length > TRACK_MAX) track.shift();
      trackT = sim.t;
    }
  }

  // An arrow at (x, y) pointing along heading `psi` (0 = up the screen = +X, increasing toward +Z = right).
  function arrow(x, y, psi, color, len = 8) {
    const ux = Math.sin(psi);
    const uy = -Math.cos(psi);
    ctx.fillStyle = color;
    ctx.strokeStyle = 'rgba(8,12,18,0.9)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(x + ux * len, y + uy * len);
    ctx.lineTo(x - ux * len * 0.7 - uy * len * 0.55, y - uy * len * 0.7 + ux * len * 0.55);
    ctx.lineTo(x - ux * len * 0.25, y - uy * len * 0.25);
    ctx.lineTo(x - ux * len * 0.7 + uy * len * 0.55, y - uy * len * 0.7 - ux * len * 0.55);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }

  function draw(sim) {
    shipPos(sim.t, _s);
    const dx = sim.pos.x;
    const dz = sim.pos.z;
    const half = SIZE / 2;
    const rim = half - 7;
    const range = Math.hypot(ship.x - dx, ship.z - dz);
    const R = ZOOMS[zoom] === 'auto' ? (SCALES.find((s) => s >= range * 1.25) ?? SCALES[SCALES.length - 1]) : ZOOMS[zoom];
    const k = rim / R;
    const sx = (z) => half + (z - dz) * k;
    const sy = (x) => half - (x - dx) * k;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, SIZE, SIZE);

    // Range rings and the cross; the bow is up.
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(255,255,255,0.16)';
    const step = R >= 16000 ? 8000 : R >= 8000 ? 4000 : R >= 4000 ? 2000 : R >= 2000 ? 1000 : R >= 1000 ? 500 : 250;
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
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.font = '600 10px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('BOW', half, 12);

    // The drone's track.
    if (track.length > 1) {
      ctx.strokeStyle = ORANGE;
      ctx.lineWidth = 1.4;
      ctx.globalAlpha = 0.5;
      ctx.beginPath();
      track.forEach((p, i) => { if (i) ctx.lineTo(sx(p.z), sy(p.x)); else ctx.moveTo(sx(p.z), sy(p.x)); });
      ctx.lineTo(half, half);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // The ship: an arrow along its heading (+X, up), or, off the disc, a marker on the rim pointing to it.
    const shx = sx(ship.z);
    const shy = sy(ship.x);
    const off = Math.hypot(shx - half, shy - half);
    if (off <= rim - 6) {
      arrow(shx, shy, 0, GREEN, 9);
      ctx.fillStyle = 'rgba(61,220,132,0.9)';
      ctx.font = '9px system-ui, sans-serif';
      ctx.fillText('SHIP', shx, shy + 19);
    } else {
      const a = Math.atan2(shy - half, shx - half);
      const mx = half + Math.cos(a) * (rim - 2);
      const my = half + Math.sin(a) * (rim - 2);
      ctx.fillStyle = GREEN;
      ctx.beginPath();
      ctx.moveTo(mx + Math.cos(a) * 5, my + Math.sin(a) * 5);
      ctx.lineTo(mx - Math.cos(a) * 5 - Math.sin(a) * 5, my - Math.sin(a) * 5 + Math.cos(a) * 5);
      ctx.lineTo(mx - Math.cos(a) * 5 + Math.sin(a) * 5, my - Math.sin(a) * 5 - Math.cos(a) * 5);
      ctx.closePath();
      ctx.fill();
    }

    // The missile: a dot with a short tail along its heading.
    const m = sim.missile;
    if (m) {
      const mx = sx(m.pos.z);
      const my = sy(m.pos.x);
      ctx.strokeStyle = CYAN;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(mx, my);
      ctx.lineTo(mx - m.dir.z * 7, my + m.dir.x * 7);
      ctx.stroke();
      ctx.fillStyle = CYAN;
      ctx.beginPath(); ctx.arc(mx, my, 2.6, 0, Math.PI * 2); ctx.fill();
    }

    // The drone at the centre: an arrow along its heading, or a cross once it is down.
    if (sim.phase === 'destroyed' || sim.phase === 'crashed') {
      ctx.strokeStyle = RED;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(half - 6, half - 6); ctx.lineTo(half + 6, half + 6);
      ctx.moveTo(half + 6, half - 6); ctx.lineTo(half - 6, half + 6);
      ctx.stroke();
    } else {
      const psi = sim.phase === 'chute' || sim.phase === 'splashed' ? (sim.headingDeg * Math.PI) / 180 : sim.alpha;
      arrow(half, half, sim.phase === 'deck' || sim.phase === 'cat' ? 0 : psi, ORANGE, 9);
    }

    label.textContent = `${ZOOMS[zoom] === 'auto' ? 'AUTO · ' : ''}${R >= 1000 ? `${R / 1000} km` : `${R} m`}`;
  }

  const api = {
    get enabled() { return enabled; },
    setEnabled(on) { enabled = on; root.hidden = !on; },
    cycleZoom() { zoom = (zoom + 1) % ZOOMS.length; },
    update(sim) {
      sample(sim);
      if (enabled) draw(sim);
    },
  };
  root.addEventListener('click', () => api.cycleZoom());
  return api;
}

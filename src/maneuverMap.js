import { shipState, relation, headingDeg, YD } from './maneuvers.js';

// Exercise map for the naval maneuvers mission: the same round translucent disc as the intercept
// minimap, but north up (like the briefing diagrams) and centred between the two ships, with
// both ships as arrows along their heading, their recent tracks, and the station line with its
// range in yards. Everything is a pure function of t. Click it to change the zoom; M hides it.

const SIZE = 150; // CSS px
const SCALES = [600, 1000, 1500, 2500, 4000]; // auto-zoom steps: metres to the rim
const ZOOMS = ['auto', 1000, 2500];
const TRACK_SECONDS = 300;
const TRACK_STEP = 6;
const COLORS = { alg: '#3ddc84', rus: '#ff7a1a' };

export function createManeuverMap() {
  const root = document.querySelector('#minimap');
  const canvas = root.querySelector('canvas');
  const label = root.querySelector('.mm-scale');
  const ctx = canvas.getContext('2d');
  const dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
  canvas.width = SIZE * dpr;
  canvas.height = SIZE * dpr;
  canvas.style.width = canvas.style.height = `${SIZE}px`;

  let enabled = true;
  let zoom = 0;
  let lastKey = '';
  const a = {};
  const b = {};
  const p = {};

  function draw(t) {
    shipState('alg', t, a);
    shipState('rus', t, b);
    const cx = (a.x + b.x) / 2; // map centre, metres North
    const cz = (a.z + b.z) / 2; // metres East
    const half = SIZE / 2;
    const rim = half - 7;
    const span = Math.hypot(a.x - b.x, a.z - b.z) / 2;
    const R = ZOOMS[zoom] === 'auto' ? (SCALES.find((s) => s >= span * 1.45) ?? SCALES[SCALES.length - 1]) : ZOOMS[zoom];
    const k = rim / R;
    const sx = (z) => half + (z - cz) * k;
    const sy = (x) => half - (x - cx) * k;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, SIZE, SIZE);

    // Rings and the compass cross.
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(255,255,255,0.16)';
    const step = R >= 2500 ? 1000 : R >= 1000 ? 500 : 250;
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
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.font = '600 10px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('N', half, 12);
    ctx.fillStyle = 'rgba(255,255,255,0.4)';
    ctx.fillText('E', SIZE - 8, half + 3);
    ctx.fillText('S', half, SIZE - 5);
    ctx.fillText('W', 8, half + 3);

    // Recent tracks (the part already steamed).
    for (const id of ['alg', 'rus']) {
      ctx.strokeStyle = COLORS[id];
      ctx.lineWidth = 1.4;
      ctx.globalAlpha = 0.5;
      ctx.beginPath();
      let started = false;
      for (let s = Math.min(TRACK_SECONDS, t); s >= 0; s -= TRACK_STEP) {
        shipState(id, t - s, p);
        const x = sx(p.z);
        const y = sy(p.x);
        if (started) ctx.lineTo(x, y); else { ctx.moveTo(x, y); started = true; }
      }
      shipState(id, t, p);
      ctx.lineTo(sx(p.z), sy(p.x));
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // The station line with its range, between the two ships.
    const ax = sx(a.z); const ay = sy(a.x);
    const bx = sx(b.z); const by = sy(b.x);
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
    ctx.setLineDash([]);
    const rel = relation(t);
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.font = '9px system-ui, sans-serif';
    ctx.fillText(`${Math.round(rel.range / YD)} yd`, (ax + bx) / 2 + 14, (ay + by) / 2 + 3);

    // The ships: arrows along their heading, a ring around each (the hull is tiny at this scale).
    const arrow = (x, y, psi, color) => {
      const ux = Math.sin(psi); // East component -> screen x
      const uy = -Math.cos(psi); // North component -> screen -y
      const len = 8;
      ctx.fillStyle = color;
      ctx.strokeStyle = 'rgba(8,12,18,0.9)';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(x + ux * len, y + uy * len);
      ctx.lineTo(x - ux * len * 0.7 - uy * len * 0.6, y - uy * len * 0.7 + ux * len * 0.6);
      ctx.lineTo(x - ux * len * 0.35, y - uy * len * 0.35);
      ctx.lineTo(x - ux * len * 0.7 + uy * len * 0.6, y - uy * len * 0.7 - ux * len * 0.6);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    };
    arrow(ax, ay, a.heading, COLORS.alg);
    arrow(bx, by, b.heading, COLORS.rus);
    ctx.font = '600 9px system-ui, sans-serif';
    ctx.fillStyle = COLORS.alg;
    ctx.fillText('ALG', ax, ay - 10);
    ctx.fillStyle = COLORS.rus;
    ctx.fillText('RUS', bx, by - 10);

    label.textContent = `${ZOOMS[zoom] === 'auto' ? 'AUTO · ' : ''}${R >= 1000 ? `${R / 1000} km` : `${R} m`} · ${Math.round(headingDeg(a.heading)).toString().padStart(3, '0')}°`;
  }

  const api = {
    get enabled() { return enabled; },
    setEnabled(on) { enabled = on; root.hidden = !on; document.body.classList.toggle('has-map', on); lastKey = ''; },
    cycleZoom() { zoom = (zoom + 1) % ZOOMS.length; lastKey = ''; },
    update(t) {
      if (!enabled) return;
      const key = `${t}|${zoom}`;
      if (key === lastKey) return;
      lastKey = key;
      draw(t);
    },
  };
  root.addEventListener('click', () => api.cycleZoom());
  return api;
}

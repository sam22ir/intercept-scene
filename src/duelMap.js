import { MAIN_ARC, MAIN_RANGE, GUN_RANGE } from './duel.js';
import { gunBlind, kmText } from './hull.js';

// The Ship duel's radar, on the shared #minimap disc (the same one Solo Air Defense uses): centred on your ship,
// heading up, with range rings, a turning sweep, the north mark on the rim, the 76 mm's arc, and the aft 30 mm guns'
// clear sectors (where they can bear), and the enemy contact. Click it to change the range; N hides it.

const SCALES = [2000, 4000, 8000, 16000]; // metres to the rim
const ZOOMS = ['auto', 2000, 6000, 12000]; // what a click cycles through
const SWEEP = 3; // s per turn of the aerial
const TRACK_STEP = 1; // s between own-track samples
const TRACK_MAX = 240;
const GREEN = '#3ddc84';
const AMBER = '#ffb340';
const RED = '#ff5d61';
const CYAN = '#35c8ff';
const ORANGE = '#ff7a1a';

export function createDuelMap() {
  const root = document.querySelector('#minimap');
  const canvas = root.querySelector('canvas');
  const label = root.querySelector('.mm-scale');
  const ctx = canvas.getContext('2d');
  const dpr = Math.min(globalThis.devicePixelRatio || 1, 2);

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
  const track = [];
  let lastTrack = -Infinity;
  let lastKey = '';
  root.addEventListener('click', () => { zoom = (zoom + 1) % ZOOMS.length; lastKey = ''; });
  root.title = 'Radar, heading up: 76 mm arc and aft-gun sectors. Click to change the range (N hides it)';
  root.setAttribute('aria-label', 'Ship duel radar: enemy and gun arcs, bow up');

  function draw(sim) {
    measure();
    const R = SIZE / 2;
    // Range: the smallest scale that holds the enemy and every round in the air (auto), or the one picked.
    let scale = ZOOMS[zoom];
    if (scale === 'auto') {
      let far = sim.range();
      scale = SCALES.find((s) => s >= Math.max(far * 1.12, GUN_RANGE * 1.1)) ?? SCALES[SCALES.length - 1];
    }
    const k = (R - 6) / scale;
    // World point -> screen, heading up: your bow is screen up, starboard is right.
    const c = Math.cos(sim.player.psi);
    const s = Math.sin(sim.player.psi);
    const xy = (px, pz) => {
      const dx = px - sim.player.x;
      const dz = pz - sim.player.z;
      const ahead = dx * c + dz * s;
      const stbd = -dx * s + dz * c;
      return [R + stbd * k, R - ahead * k];
    };
    const aOf = (th) => -Math.PI / 2 + th; // bearing off the bow, + to starboard, -> canvas angle
    const clampTo = (x, y) => {
      const dx = x - R, dy = y - R;
      const d = Math.hypot(dx, dy);
      return d > R - 8 ? [R + (dx / d) * (R - 8), R + (dy / d) * (R - 8), true] : [x, y, false];
    };
    const arrow = (x, y, dx, dy, len, color, edge) => {
      const d = Math.hypot(dx, dy) || 1;
      const ux = dx / d, uy = dy / d;
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

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, SIZE, SIZE);
    ctx.save();
    ctx.beginPath();
    ctx.arc(R, R, R - 1, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = 'rgba(6, 18, 16, 0.72)';
    ctx.fillRect(0, 0, SIZE, SIZE);

    // The 76 mm's arc (orange): either side of the bow to the main range.
    ctx.beginPath();
    ctx.moveTo(R, R);
    ctx.arc(R, R, Math.min(MAIN_RANGE * k, R - 4), aOf(-MAIN_ARC), aOf(MAIN_ARC));
    ctx.closePath();
    ctx.fillStyle = 'rgba(255, 122, 26, 0.07)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 122, 26, 0.45)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // The aft 30 mm guns' clear sectors (amber): wherever either gun can bear, out to its range. The shaded
    // gaps are the dead zones to keep an enemy in.
    const rg = GUN_RANGE * k;
    const covered = (th) => !gunBlind(0, -th) || !gunBlind(1, -th);
    const STEP = Math.PI / 90;
    ctx.fillStyle = 'rgba(255, 179, 64, 0.055)';
    ctx.strokeStyle = 'rgba(255, 179, 64, 0.45)';
    for (let th = -Math.PI; th < Math.PI; th += STEP) {
      if (!covered(th + STEP / 2) || (covered(th - STEP / 2) && th > -Math.PI)) continue;
      let end = th;
      while (end < Math.PI && covered(end + STEP / 2)) end += STEP;
      ctx.beginPath();
      ctx.moveTo(R, R);
      ctx.arc(R, R, rg, aOf(th), aOf(end));
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }

    // Range rings every quarter of the scale, and the heading line.
    ctx.strokeStyle = 'rgba(61, 220, 132, 0.2)';
    ctx.lineWidth = 1;
    for (let i = 1; i <= 4; i++) {
      ctx.beginPath();
      ctx.arc(R, R, (R - 6) * (i / 4), 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.32)';
    ctx.beginPath();
    ctx.moveTo(R, R);
    ctx.lineTo(R, 0);
    ctx.stroke();

    // The sweep, with a fading afterglow.
    const a = ((sim.t / SWEEP) % 1) * Math.PI * 2 - Math.PI / 2;
    for (let i = 0; i < 18; i++) {
      ctx.fillStyle = `rgba(61, 220, 132, ${0.1 * (1 - i / 18)})`;
      ctx.beginPath();
      ctx.moveTo(R, R);
      ctx.arc(R, R, R, a - (i + 1) * 0.035, a - i * 0.035);
      ctx.closePath();
      ctx.fill();
    }

    // Own track.
    if (sim.t - lastTrack >= TRACK_STEP || sim.t < lastTrack) {
      if (sim.t < lastTrack) track.length = 0;
      track.push({ x: sim.player.x, z: sim.player.z });
      if (track.length > TRACK_MAX) track.shift();
      lastTrack = sim.t;
    }
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.24)';
    ctx.beginPath();
    track.forEach((p, i) => { const [x, y] = xy(p.x, p.z); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
    ctx.stroke();

    // The enemy: an arrow along her heading, her range, or a cross once she is down.
    const foe = sim.enemy;
    if (foe.tSunk === null) {
      const [x, y] = xy(foe.x, foe.z);
      const [x2, y2] = xy(foe.x + Math.cos(foe.psi) * 200, foe.z + Math.sin(foe.psi) * 200);
      arrow(x, y, x2 - x, y2 - y, 7, RED, false);
      ctx.fillStyle = 'rgba(255, 138, 141, 0.9)';
      ctx.font = '600 9px system-ui, sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      const tx = x + 7, ty = y - 7;
      if (Math.hypot(tx - R, ty - R) < R - 34) ctx.fillText(kmText(sim.range()), tx, ty);
    } else {
      const [x, y] = xy(foe.x, foe.z);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
      ctx.beginPath();
      ctx.moveTo(x - 3, y - 3); ctx.lineTo(x + 3, y + 3);
      ctx.moveTo(x + 3, y - 3); ctx.lineTo(x - 3, y + 3);
      ctx.stroke();
    }

    // The ship at the centre, pointing up.
    ctx.fillStyle = GREEN;
    ctx.strokeStyle = 'rgba(8,12,18,0.85)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(R, R - 9);
    ctx.lineTo(R + 4, R - 3); ctx.lineTo(R + 3.5, R + 8); ctx.lineTo(R - 3.5, R + 8); ctx.lineTo(R - 4, R - 3);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    // The rim: north mark, turning as the ship turns.
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)';
    ctx.beginPath();
    ctx.arc(R, R, R - 1, 0, Math.PI * 2);
    ctx.stroke();
    const nb = -sim.player.psi - Math.PI / 2;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
    ctx.font = '700 9px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('N', R + Math.cos(nb) * (R - 9), R + Math.sin(nb) * (R - 9));

    label.textContent = `${zoom === 0 ? 'AUTO · ' : ''}${kmText(scale)}`;
  }

  return {
    get enabled() { return enabled; },
    setEnabled(on) {
      enabled = on;
      root.hidden = !on;
      document.body.classList.toggle('has-map', on);
      if (on) lastKey = '';
    },
    update(sim) {
      if (!enabled) return;
      const key = `${sim.t.toFixed(2)}|${zoom}`;
      if (key === lastKey) return;
      lastKey = key;
      draw(sim);
    },
  };
}

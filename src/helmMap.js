import { landHeightAt, townSpots } from './environment.js';
import { RADAR_RANGE, ARC, MIN_RANGE, MISSILE_RANGE, GUN_RANGE, gunBlind, kmText } from './helm.js';

// The Solo Air Defense mission's radar: the same round translucent disc as the other maps, but a ship's radar display:
// centred on the ship and heading-up (her bow is screen up), with range rings, a rotating sweep, the north mark
// on the rim, the launcher's arc (the box only engages inside it), the ship's own wake track, drone contacts
// (a diamond with a speed leader and its name; red once it is closing, the selected target boxed), the
// missiles in flight and the crosses where drones went down. Click it to change the range; M hides it.

const SCALES = [1000, 2000, 3000, 6000]; // metres to the rim
const ZOOMS = ['auto', 2000, 6000, 12000, 20000]; // the last two show the land (a backdrop: it keeps its bearing and distance however far she sails)
const SWEEP = 2.5; // s per turn of the aerial
const TRACK_STEP = 1; // s between own-track samples
const TRACK_MAX = 180;
const GREEN = '#3ddc84';
const AMBER = '#ffb340';
const RED = '#ff5d61';
const CYAN = '#35c8ff';

// The land, drawn once into an image (north up, 100 m a pixel, 18 km each way of the ship): the land is a backdrop that keeps its bearing
// and distance from the ship, so every frame the image is only turned to her heading and scaled. Colour by height, shaded by the slope
// (the sun from the west), the shore picked out.
const LAND_M = 100;
const LAND_PX = 360;
let landImage = null;
function buildLand() {
  const c = document.createElement('canvas');
  c.width = c.height = LAND_PX;
  const g = c.getContext('2d');
  const img = g.createImageData(LAND_PX, LAND_PX);
  const H = new Float32Array(LAND_PX * LAND_PX);
  for (let py = 0; py < LAND_PX; py++) {
    for (let px = 0; px < LAND_PX; px++) H[py * LAND_PX + px] = landHeightAt(-(py - LAND_PX / 2 + 0.5) * LAND_M, (px - LAND_PX / 2 + 0.5) * LAND_M);
  }
  const stops = [[0, 96, 118, 70], [250, 122, 128, 76], [700, 150, 132, 92], [1200, 150, 140, 124], [1800, 196, 190, 178]];
  for (let py = 0; py < LAND_PX; py++) {
    for (let px = 0; px < LAND_PX; px++) {
      const h = H[py * LAND_PX + px];
      const o = (py * LAND_PX + px) * 4;
      if (h <= 0) continue;
      let k = 0;
      while (k < stops.length - 2 && h > stops[k + 1][0]) k++;
      const t = Math.min(1, Math.max(0, (h - stops[k][0]) / (stops[k + 1][0] - stops[k][0])));
      const hw = px > 0 ? H[py * LAND_PX + px - 1] : h;
      const hn = py > 0 ? H[(py - 1) * LAND_PX + px] : h;
      const shade = Math.min(1.45, Math.max(0.55, 1 + (hw - h) / 160 + (hn - h) / 220));
      const edge = h < 40 ? 1.25 : 1; // a lighter rim along the shore
      for (let ch = 0; ch < 3; ch++) img.data[o + ch] = Math.min(255, (stops[k][ch + 1] + (stops[k + 1][ch + 1] - stops[k][ch + 1]) * t) * shade * edge);
      img.data[o + 3] = 235;
    }
  }
  g.putImageData(img, 0, 0);
  g.fillStyle = 'rgba(240, 230, 205, 0.95)'; // the towns, a pale mark for each building
  for (const [x, z, size] of townSpots()) {
    const px = LAND_PX / 2 + z / LAND_M;
    const py = LAND_PX / 2 - x / LAND_M;
    const w = Math.max(1, size / LAND_M);
    g.fillRect(px - w / 2, py - w / 2, w, w);
  }
  return c;
}

export function createHelmMap() {
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
  let sightView = null; // in the radar view: { yaw (world, radians from north), half (the lens's half-width), locked }
  root.addEventListener('click', () => { zoom = (zoom + 1) % ZOOMS.length; });
  root.title = 'Radar, heading up: click to change the range (M hides it)';

  function draw(sim) {
    measure();
    const R = SIZE / 2;
    const live = sim.detected;
    // Range: the smallest scale that holds every contact (auto), or the one picked.
    let scale = ZOOMS[zoom];
    if (scale === 'auto') {
      const far = live.reduce((m, d) => Math.max(m, sim.rangeTo(d.pos)), 0);
      scale = SCALES.find((s) => s >= Math.max(far * 1.12, GUN_RANGE * 1.1)) ?? SCALES[SCALES.length - 1];
    }
    const k = (R - 6) / scale;
    // World point -> screen, heading up.
    const c = Math.cos(sim.psi);
    const s = Math.sin(sim.psi);
    const xy = (px, pz) => {
      const dx = px - sim.x;
      const dz = pz - sim.z;
      const ahead = dx * c + dz * s;
      const stbd = -dx * s + dz * c;
      return [R + stbd * k, R - ahead * k];
    };

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, SIZE, SIZE);
    ctx.save();
    ctx.beginPath();
    ctx.arc(R, R, R - 1, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = 'rgba(6, 22, 18, 0.72)';
    ctx.fillRect(0, 0, SIZE, SIZE);
    // The land, turned to the ship's heading (the map is heading up) and scaled to the range.
    landImage ??= buildLand();
    {
      const m = k * LAND_M;
      const cs = Math.cos(sim.psi);
      const sn = Math.sin(sim.psi);
      ctx.save();
      ctx.globalAlpha = 0.8;
      ctx.imageSmoothingEnabled = true;
      ctx.transform(m * cs, -m * sn, m * sn, m * cs, R, R);
      ctx.drawImage(landImage, -LAND_PX / 2, -LAND_PX / 2);
      ctx.restore();
    }

    // The fire zones, clear on the disc. Missiles (green): the launcher's arc either side of the bow, between the minimum and
    // the maximum range. Guns (amber): out to the gun range wherever a gun can bear (the superstructure blocks the sector ahead).
    const aOf = (th) => -Math.PI / 2 + th; // bearing off the bow (+ to starboard) -> canvas angle
    const rIn = MIN_RANGE * k;
    const rOut = MISSILE_RANGE * k;
    ctx.beginPath();
    ctx.arc(R, R, rOut, aOf(-ARC), aOf(ARC));
    ctx.arc(R, R, rIn, aOf(ARC), aOf(-ARC), true);
    ctx.closePath();
    ctx.fillStyle = 'rgba(61, 220, 132, 0.05)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(61, 220, 132, 0.55)';
    ctx.lineWidth = 1;
    ctx.stroke();
    const rg = GUN_RANGE * k;
    const covered = (th) => !gunBlind(0, -th) || !gunBlind(1, -th);
    const STEP = Math.PI / 90;
    ctx.fillStyle = 'rgba(255, 179, 64, 0.05)';
    ctx.strokeStyle = 'rgba(255, 179, 64, 0.55)';
    ctx.lineWidth = 1;
    for (let th = -Math.PI; th < Math.PI; th += STEP) {
      if (!covered(th + STEP / 2) || (covered(th - STEP / 2) && th > -Math.PI)) continue; // start of a covered run
      let end = th;
      while (end < Math.PI && covered(end + STEP / 2)) end += STEP;
      ctx.beginPath();
      ctx.moveTo(R, R);
      ctx.arc(R, R, rg, aOf(th), aOf(end));
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
    ctx.lineWidth = 1;

    // Range rings, every quarter of the scale; the radar's own reach dashed.
    ctx.strokeStyle = 'rgba(61, 220, 132, 0.22)';
    ctx.lineWidth = 1;
    for (let i = 1; i <= 4; i++) {
      ctx.beginPath();
      ctx.arc(R, R, (R - 6) * (i / 4), 0, Math.PI * 2);
      ctx.stroke();
    }
    if (RADAR_RANGE < scale) {
      ctx.setLineDash([3, 4]);
      ctx.beginPath();
      ctx.arc(R, R, RADAR_RANGE * k, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    // Where the radar view is looking: a wedge as wide as the lens out to the rim, a bright centre line, and the true bearing at the rim.
    if (sightView) {
      const rel = sightView.yaw - sim.psi;
      const col = sightView.locked ? '61, 220, 132' : '255, 196, 84';
      const a0 = rel - Math.PI / 2;
      const half = Math.max(sightView.half, 0.035);
      ctx.fillStyle = `rgba(${col}, 0.2)`;
      ctx.strokeStyle = `rgba(${col}, 0.95)`;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(R, R);
      ctx.arc(R, R, R - 2, a0 - half, a0 + half);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(R, R);
      ctx.lineTo(R + Math.cos(a0) * (R - 2), R + Math.sin(a0) * (R - 2));
      ctx.stroke();
      ctx.lineWidth = 1;
      const brg = ((Math.round((sightView.yaw * 180) / Math.PI) % 360) + 360) % 360;
      ctx.font = '700 9px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const tx = R + Math.cos(a0) * (R - 17);
      const ty = R + Math.sin(a0) * (R - 17);
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.8)';
      ctx.lineWidth = 3;
      ctx.strokeText(`${String(brg).padStart(3, '0')}°`, tx, ty);
      ctx.fillStyle = `rgb(${col})`;
      ctx.fillText(`${String(brg).padStart(3, '0')}°`, tx, ty);
      ctx.lineWidth = 1;
    }
    // The scale: a bar of a round length stands low on the disc (no numbers on the rings or the bar; the corner label gives the range).
    const nice = [200, 500, 1000, 2000, 5000, 10000].reduce((best, m) => (Math.abs(m * k - R * 0.5) < Math.abs(best * k - R * 0.5) ? m : best), 1000);
    const bw = nice * k;
    const by = R + R * 0.56;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(R - bw / 2, by - 3); ctx.lineTo(R - bw / 2, by); ctx.lineTo(R + bw / 2, by); ctx.lineTo(R + bw / 2, by - 3);
    ctx.stroke();
    ctx.lineWidth = 1;
    // The heading line.
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
    ctx.beginPath();
    ctx.moveTo(R, R);
    ctx.lineTo(R, 0);
    ctx.stroke();

    // The sweep, with a fading afterglow.
    const a = ((sim.t / SWEEP) % 1) * Math.PI * 2 - Math.PI / 2;
    for (let i = 0; i < 18; i++) {
      ctx.fillStyle = `rgba(61, 220, 132, ${0.11 * (1 - i / 18)})`;
      ctx.beginPath();
      ctx.moveTo(R, R);
      ctx.arc(R, R, R, a - (i + 1) * 0.035, a - i * 0.035);
      ctx.closePath();
      ctx.fill();
    }

    // Own track.
    if (sim.t - lastTrack >= TRACK_STEP || sim.t < lastTrack) {
      if (sim.t < lastTrack) track.length = 0;
      track.push({ x: sim.x, z: sim.z });
      if (track.length > TRACK_MAX) track.shift();
      lastTrack = sim.t;
    }
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.28)';
    ctx.beginPath();
    track.forEach((p, i) => { const [x, y] = xy(p.x, p.z); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
    ctx.stroke();

    // Wrecks.
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
    for (const d of sim.drones) {
      if (d.alive || d.phase === 'struck') continue;
      const [x, y] = xy(d.pos.x, d.pos.z);
      ctx.beginPath();
      ctx.moveTo(x - 3, y - 3); ctx.lineTo(x + 3, y + 3);
      ctx.moveTo(x + 3, y - 3); ctx.lineTo(x - 3, y + 3);
      ctx.stroke();
    }

    // Missiles.
    ctx.fillStyle = CYAN;
    for (const m of sim.missiles) {
      const [x, y] = xy(m.pos.x, m.pos.z);
      ctx.beginPath();
      ctx.arc(x, y, 2.4, 0, Math.PI * 2);
      ctx.fill();
    }

    // Contacts: a diamond, a leader 20 s long along the track, the name.
    ctx.font = '600 9px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    for (const d of live) {
      const [x, y] = xy(d.pos.x, d.pos.z);
      const [x2, y2] = xy(d.pos.x + d.vel.x * 20, d.pos.z + d.vel.z * 20);
      const hot = d.phase === 'attack' || d.phase === 'pass' || sim.rangeTo(d.pos) < 2000;
      const col = d.phase === 'attack' ? RED : hot ? RED : AMBER;
      ctx.strokeStyle = col;
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x2, y2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x, y - 4); ctx.lineTo(x + 4, y); ctx.lineTo(x, y + 4); ctx.lineTo(x - 4, y);
      ctx.closePath();
      ctx.fill();
      if (d.id === sim.targetId) {
        ctx.strokeStyle = '#fff';
        ctx.strokeRect(x - 7, y - 7, 14, 14);
      }
    }

    // The ship's own helicopter, a friendly (cyan) contact while its rotor turns: a ring with a rotor cross (a symbol, no label).
    const hs = sim.heli.state;
    if (hs.rpm > 0) {
      const hx = R + hs.z * k;
      const hy = R - hs.x * k;
      ctx.strokeStyle = CYAN;
      ctx.fillStyle = CYAN;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(hx, hy, 4, 0, Math.PI * 2);
      ctx.moveTo(hx - 3, hy - 3); ctx.lineTo(hx + 3, hy + 3);
      ctx.moveTo(hx + 3, hy - 3); ctx.lineTo(hx - 3, hy + 3);
      ctx.stroke();
    }

    // The ship at the centre.
    ctx.fillStyle = GREEN;
    ctx.beginPath();
    ctx.moveTo(R, R - 7); ctx.lineTo(R + 3.5, R + 5); ctx.lineTo(R - 3.5, R + 5);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // The rim: north mark, turning as the ship turns.
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)';
    ctx.beginPath();
    ctx.arc(R, R, R - 1, 0, Math.PI * 2);
    ctx.stroke();
    const nb = -sim.psi - Math.PI / 2;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
    ctx.font = '700 9px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('N', R + Math.cos(nb) * (R - 9), R + Math.sin(nb) * (R - 9));

    label.textContent = `${zoom === 0 ? 'AUTO · ' : ''}${kmText(scale)}`;
  }

  return {
    get enabled() { return enabled; },
    setEnabled(on) { enabled = on; root.hidden = !on; },
    set sight(v) { sightView = v; },
    update(sim) { if (enabled) draw(sim); },
  };
}

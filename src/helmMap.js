import { RADAR_RANGE, ARC, MIN_RANGE, MISSILE_RANGE, GUN_RANGE, gunBlind, kmText } from './helm.js';

// The Solo Air Defense mission's radar: the same round translucent disc as the other maps, but a ship's radar display:
// centred on the ship and heading-up (her bow is screen up), with range rings, a rotating sweep, the north mark
// on the rim, the launcher's arc (the box only engages inside it), the ship's own wake track, drone contacts
// (a diamond with a speed leader and its name; red once it is closing, the selected target boxed), the
// missiles in flight and the crosses where drones went down. Click it to change the range; M hides it.

const SCALES = [1000, 2000, 3000, 6000]; // metres to the rim
const ZOOMS = ['auto', 2000, 6000];
const SWEEP = 2.5; // s per turn of the aerial
const TRACK_STEP = 1; // s between own-track samples
const TRACK_MAX = 180;
const GREEN = '#3ddc84';
const AMBER = '#ffb340';
const RED = '#ff5d61';
const CYAN = '#35c8ff';

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

    // The ship's own helicopter, a friendly (cyan) contact while its rotor turns: a ring with a rotor cross, and HELO once it is airborne.
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
      if (hs.flying) { ctx.font = '700 8px system-ui, sans-serif'; ctx.textAlign = 'left'; ctx.fillText('HELO', hx + 7, hy + 1); }
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
    update(sim) { if (enabled) draw(sim); },
  };
}

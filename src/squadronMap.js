import { SCENARIOS } from './squadronScoring.js';
import { leadOf } from './squadronOrders.js';
import { RADAR_RANGE } from './squadronInfo.js';
import { contactLabel, hullFrac } from './squadronControls.js';

// Squadron orders's tactical radar, on the shared #minimap element: north up (screen up is +X, screen right is +Z, so a bearing is the
// compass bearing), centred on the squadron. It is the main view of the mission. The squadron is drawn from the simulation (numbered,
// coloured by role, with formation stations, sector wedges, destinations and the track steamed); everything else only as the sensors
// give it (sim.contacts(): a vague '?' when merely detected, the class and course once tracked, a fading mark when lost).
// Click a ship to pick her, click the sea to send the ships picked there (shift: just steer for it). The wheel zooms, a drag pans,
// a double click returns to following the squadron.

export const ROLE_COLOUR = { picket: '#35c8ff', gun: '#ff9f43', escort: '#3ddc84' };
const RED = '#ff5d61';
const GREY = '#9aa4ad';
const AMBER = '#ffb340';
const SCALES = [1500, 3000, 6000, 12000, 24000]; // metres from the centre to the nearer edge
const TRACK_STEP = 3; // s between track samples
const TRACK_MAX = 50;
const PICK_PX = 24;

export function createSquadronMap({ onPick, onGround }) {
  const root = document.querySelector('#minimap');
  const canvas = root.querySelector('canvas');
  const label = root.querySelector('.mm-scale');
  const ctx = canvas.getContext('2d');
  const dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
  let W = 0, H = 0;
  let enabled = true;
  let big = true;
  let zoom = 'auto'; // 'auto' or an index into SCALES
  let pan = null; // { x, z } world offset of the view centre while the player has dragged it; null follows the squadron
  const centre = { x: 0, z: 0, set: false };
  let scaleNow = 3000;
  const tracks = new Map();
  let lastT = -Infinity;
  let lastTrack = -Infinity;
  let view = { cx: 0, cz: 0, k: 1 }; // what the last draw used, to turn a click back into the sea

  function measure() {
    const w = Math.round(root.clientWidth), h = Math.round(root.clientHeight);
    if (!w || !h || (w === W && h === H)) return;
    W = w; H = h;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
  }
  let pending = 0;
  const remeasure = () => { if (pending) return; pending = requestAnimationFrame(() => { pending = 0; measure(); }); }; // never in the observer itself: it would report a loop
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(remeasure).observe(root);
  window.addEventListener('resize', remeasure);

  // --- the buttons in the corner of the map ---------------------------------------------------------------------------------
  const tools = document.createElement('div');
  tools.className = 'fm-tools';
  const mk = (txt, title, fn) => {
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = txt; b.title = title;
    b.addEventListener('click', (e) => { e.stopPropagation(); fn(); b.blur(); });
    b.addEventListener('pointerdown', (e) => e.stopPropagation());
    tools.append(b);
    return b;
  };
  const stepZoom = (d) => {
    const cur = zoom === 'auto' ? SCALES.findIndex((s) => s >= scaleNow - 1) : zoom;
    zoom = Math.min(SCALES.length - 1, Math.max(0, (cur < 0 ? SCALES.length - 1 : cur) + d));
  };
  mk('+', 'Zoom in (wheel)', () => stepZoom(-1));
  mk('−', 'Zoom out (wheel)', () => stepZoom(1));
  mk('A', 'Follow the squadron and fit everything in', () => { zoom = 'auto'; pan = null; });
  root.append(tools);
  root.title = 'Tactical radar, north up. Click a frigate to pick her, click the sea to send her there (shift: steer for it). Wheel zooms, drag pans, double click follows the squadron';
  root.setAttribute('aria-label', 'Squadron orders tactical radar, north up');

  // --- clicks -----------------------------------------------------------------------------------------------------------------
  let down = null;
  let ships = []; // [idx, sx, sy] of the squadron as last drawn
  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    down = { x: e.clientX, y: e.clientY, moved: false, px: e.clientX, py: e.clientY };
    canvas.setPointerCapture?.(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!down) return;
    if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) down.moved = true;
    if (down.moved) {
      const dx = e.clientX - down.px, dy = e.clientY - down.py;
      down.px = e.clientX; down.py = e.clientY;
      pan = pan ?? { x: centre.x, z: centre.z };
      pan.z -= dx / view.k;
      pan.x += dy / view.k;
    }
  });
  canvas.addEventListener('pointerup', (e) => {
    const d = down;
    down = null;
    if (!d || d.moved || e.button !== 0) return;
    const r = canvas.getBoundingClientRect();
    const sx = e.clientX - r.left, sy = e.clientY - r.top;
    let best = null, bd = PICK_PX;
    for (const [idx, x, y] of ships) { const dd = Math.hypot(x - sx, y - sy); if (dd < bd) { bd = dd; best = idx; } }
    if (best !== null) { onPick(best); return; }
    onGround(view.cx + (H / 2 - sy) / view.k, view.cz + (sx - W / 2) / view.k, e.shiftKey);
  });
  canvas.addEventListener('pointercancel', () => { down = null; });
  canvas.addEventListener('dblclick', () => { pan = null; zoom = 'auto'; });
  canvas.addEventListener('wheel', (e) => { e.preventDefault(); stepZoom(e.deltaY > 0 ? 1 : -1); }, { passive: false });

  // --- the picture --------------------------------------------------------------------------------------------------------------
  function arrow(x, y, ux, uy, len, fill, stroke, lw = 1.2) {
    ctx.fillStyle = fill;
    ctx.strokeStyle = stroke;
    ctx.lineWidth = lw;
    ctx.beginPath();
    ctx.moveTo(x + ux * len, y + uy * len);
    ctx.lineTo(x - ux * len * 0.7 - uy * len * 0.62, y - uy * len * 0.7 + ux * len * 0.62);
    ctx.lineTo(x - ux * len * 0.3, y - uy * len * 0.3);
    ctx.lineTo(x - ux * len * 0.7 + uy * len * 0.62, y - uy * len * 0.7 - ux * len * 0.62);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }
  const kmLabel = (m) => (m >= 1000 ? `${Number((m / 1000).toFixed(1))} km` : `${Math.round(m)} m`);

  function draw(sim, ui) {
    if (!enabled) return;
    measure();
    if (W < 60 || H < 60) return; // squeezed away (a tiny window): nothing to draw, and the radii below would go negative
    // The tracks restart with a rewind or a restart.
    if (sim.t < lastT - 0.5) { tracks.clear(); lastTrack = -Infinity; }
    lastT = sim.t;
    if (sim.t - lastTrack >= TRACK_STEP) {
      lastTrack = sim.t;
      for (const s of sim.squad) {
        if (s.tSunk !== null) continue;
        const a = tracks.get(s.idx) ?? [];
        a.push([s.x, s.z]);
        if (a.length > TRACK_MAX) a.shift();
        tracks.set(s.idx, a);
      }
    }
    const live = sim.squad.filter((s) => s.tSunk === null);
    const contacts = ui.contacts ?? [];
    // The centre follows the squadron smoothly; the scale fits the squadron and what the sensors hold.
    const cen = live.length ? sim.centroid() : { x: sim.squad[0].x, z: sim.squad[0].z };
    if (!centre.set) { centre.x = cen.x; centre.z = cen.z; centre.set = true; } else { centre.x += (cen.x - centre.x) * 0.08; centre.z += (cen.z - centre.z) * 0.08; }
    const cx = pan ? pan.x : centre.x, cz = pan ? pan.z : centre.z;
    let far = 0;
    for (const s of live) far = Math.max(far, Math.hypot(s.x - cx, s.z - cz));
    for (const c of contacts) if (c.state === 'tracked') far = Math.max(far, Math.hypot(c.x - cx, c.z - cz)); // a vague contact does not move the picture
    const edge = Math.min(W, H) / 2;
    const fit = Math.min(SCALES[SCALES.length - 1], Math.max(1500, far * 1.25));
    scaleNow = scaleNow > 0 && Number.isFinite(scaleNow) ? scaleNow + (fit - scaleNow) * 0.06 : fit; // eased: the view never jumps
    const scale = zoom === 'auto' ? scaleNow : SCALES[zoom];
    const k = Math.max(0.0005, (edge - 8) / scale);
    view = { cx, cz, k };
    const sx = (z) => W / 2 + (z - cz) * k;
    const sy = (x) => H / 2 - (x - cx) * k;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = big ? 'rgba(6, 16, 20, 0.9)' : 'rgba(6, 18, 16, 0.78)';
    ctx.fillRect(0, 0, W, H);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, W, H);
    ctx.clip();

    // Sensor cover of every living ship, very faint, then a grid with its spacing picked from the scale.
    for (const s of live) {
      ctx.beginPath();
      ctx.arc(sx(s.z), sy(s.x), RADAR_RANGE * (s.radar ?? 1) * k, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(61, 220, 132, 0.025)';
      ctx.fill();
    }
    const grid = scale <= 3200 ? 500 : scale <= 6500 ? 1000 : scale <= 13000 ? 2000 : 5000;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.07)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    const x0 = Math.floor((cx - H / 2 / k) / grid) * grid, x1 = cx + H / 2 / k;
    for (let x = x0; x <= x1; x += grid) { ctx.moveTo(0, sy(x)); ctx.lineTo(W, sy(x)); }
    const z0 = Math.floor((cz - W / 2 / k) / grid) * grid, z1 = cz + W / 2 / k;
    for (let z = z0; z <= z1; z += grid) { ctx.moveTo(sx(z), 0); ctx.lineTo(sx(z), H); }
    ctx.stroke();

    // The scenario: the defended zone, or the gate the merchants must pass.
    const sc = SCENARIOS[sim.scenario];
    ctx.font = '600 10px system-ui, sans-serif';
    if (sc?.zone) {
      ctx.beginPath();
      ctx.arc(sx(sc.zone.z), sy(sc.zone.x), sc.zone.r * k, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255, 179, 64, 0.05)';
      ctx.fill();
      ctx.setLineDash([6, 5]);
      ctx.strokeStyle = 'rgba(255, 179, 64, 0.7)';
      ctx.lineWidth = 1.4;
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = AMBER;
      ctx.fillText('ZONE', sx(sc.zone.z) + 6, sy(sc.zone.x) - sc.zone.r * k + 14);
    } else if (sc?.gate !== undefined) {
      const gy = sy(sc.gate);
      ctx.setLineDash([10, 6]);
      ctx.strokeStyle = 'rgba(255, 179, 64, 0.8)';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(W, gy); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = AMBER;
      ctx.fillText('GATE: merchants must cross', 8, gy - 6);
    }

    // Sector wedges of the ships on patrol, laid off from the lead.
    const lead = leadOf(sim);
    for (const s of live) {
      if (!s.sector) continue;
      const ref = sim.ships[s.sector.ref ?? lead.idx] ?? lead;
      const a0 = (s.sector.from * Math.PI) / 180 - Math.PI / 2;
      let span = (((s.sector.to - s.sector.from) % 360) + 360) % 360 || 360;
      const a1 = a0 + (span * Math.PI) / 180;
      const col = ROLE_COLOUR[s.role] ?? '#fff';
      ctx.beginPath();
      ctx.arc(sx(ref.z), sy(ref.x), s.sector.outer * k, a0, a1);
      ctx.arc(sx(ref.z), sy(ref.x), s.sector.inner * k, a1, a0, true);
      ctx.closePath();
      ctx.globalAlpha = 0.13;
      ctx.fillStyle = col;
      ctx.fill();
      ctx.globalAlpha = 0.65;
      ctx.strokeStyle = col;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // Tracks steamed.
    for (const [idx, pts] of tracks) {
      const s = sim.ships[idx];
      if (!s || pts.length < 2) continue;
      ctx.strokeStyle = ROLE_COLOUR[s.role] ?? '#fff';
      ctx.lineWidth = 1.4;
      for (let i = 1; i < pts.length; i++) {
        ctx.globalAlpha = 0.08 + 0.4 * (i / pts.length);
        ctx.beginPath(); ctx.moveTo(sx(pts[i - 1][1]), sy(pts[i - 1][0])); ctx.lineTo(sx(pts[i][1]), sy(pts[i][0])); ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }

    // Where each ship is ordered to: a destination, a station in the formation, or just the course.
    const sel = ui.sel;
    for (const s of live) {
      const col = ROLE_COLOUR[s.role] ?? '#fff';
      const px = sx(s.z), py = sy(s.x);
      const picked = sel === 'all' || sel === s.idx;
      ctx.globalAlpha = picked ? 0.9 : 0.4;
      ctx.strokeStyle = col;
      ctx.lineWidth = 1.2;
      const st = s.form && sim.stationOf ? sim.stationOf(s) : null;
      if (st) {
        ctx.setLineDash([4, 4]);
        ctx.beginPath(); ctx.arc(sx(st.z), sy(st.x), Math.max(5, st.tol * k), 0, Math.PI * 2); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(sx(st.z), sy(st.x)); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = col;
        ctx.fillText(String(s.idx + 1), sx(st.z) - 3, sy(st.x) + 3);
      } else if (s.goal.to) {
        const tx = sx(s.goal.to[1]), ty = sy(s.goal.to[0]);
        ctx.setLineDash([3, 5]);
        ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(tx, ty); ctx.stroke();
        ctx.setLineDash([]);
        ctx.beginPath(); ctx.moveTo(tx, ty - 6); ctx.lineTo(tx + 6, ty); ctx.lineTo(tx, ty + 6); ctx.lineTo(tx - 6, ty); ctx.closePath(); ctx.stroke();
      } else if (!s.sector) {
        const a = (s.goal.course * Math.PI) / 180;
        ctx.setLineDash([3, 5]);
        ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(px + Math.sin(a) * 28, py - Math.cos(a) * 28); ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.globalAlpha = 1;
    }

    // What the sensors hold.
    ctx.font = '700 10px system-ui, sans-serif';
    for (const c of contacts) {
      let x = sx(c.z), y = sy(c.x);
      const lab = contactLabel(sim, c);
      const col = c.team === 1 ? RED : GREY;
      ctx.globalAlpha = c.state === 'lost' ? Math.max(0.15, c.conf) * 0.8 : 1;
      const pad = 12;
      if (x < pad || x > W - pad || y < pad || y > H - pad) { // off the picture: a pointer on the edge, toward it
        const dx = x - W / 2, dy = y - H / 2;
        const m = Math.min((W / 2 - pad) / Math.abs(dx || 1e-6), (H / 2 - pad) / Math.abs(dy || 1e-6));
        const ex = W / 2 + dx * m, ey = H / 2 + dy * m;
        const d = Math.hypot(dx, dy) || 1;
        arrow(ex, ey, dx / d, dy / d, 7, col, 'rgba(8, 12, 18, 0.9)', 1);
        ctx.fillStyle = col;
        ctx.textAlign = ex > W / 2 ? 'right' : 'left';
        ctx.fillText(`${lab.code}${c.range ? ` ${(c.range / 1000).toFixed(1)} km` : ''}`, ex + (ex > W / 2 ? -11 : 11), ey + 3.5);
        ctx.textAlign = 'start';
        ctx.globalAlpha = 1;
        continue;
      }
      if (c.state === 'detected') {
        ctx.setLineDash([3, 3]);
        ctx.strokeStyle = col;
        ctx.lineWidth = 1.4;
        ctx.beginPath(); ctx.arc(x, y, Math.max(7, 250 * k), 0, Math.PI * 2); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = col;
        ctx.textAlign = 'center';
        ctx.fillText('?', x, y + 3.5);
        ctx.textAlign = 'start';
      } else {
        const ux = c.psi === null ? 0 : Math.sin(c.psi), uy = c.psi === null ? -1 : -Math.cos(c.psi);
        const hollow = c.state === 'lost';
        if (c.kind === 'drone') {
          arrow(x, y, ux, uy, 7, hollow ? 'rgba(0,0,0,0)' : col, col, 1.5);
        } else if (c.kind === 'merchant') {
          ctx.save();
          ctx.translate(x, y); ctx.rotate((c.psi ?? 0) - Math.PI / 2);
          ctx.fillStyle = hollow ? 'rgba(0,0,0,0)' : GREY; ctx.strokeStyle = GREY; ctx.lineWidth = 1.4;
          ctx.beginPath(); ctx.rect(-6, -3.5, 12, 7); ctx.fill(); ctx.stroke();
          ctx.restore();
        } else {
          arrow(x, y, ux, uy, 9, hollow ? 'rgba(0,0,0,0)' : 'rgba(255, 93, 97, 0.85)', col, 1.6);
        }
        if (c.u && !hollow) {
          ctx.strokeStyle = col; ctx.lineWidth = 1; ctx.setLineDash([2, 3]);
          const len = Math.min(90, c.u * 60 * k); // where she is in a minute
          ctx.beginPath(); ctx.moveTo(x + ux * 10, y + uy * 10); ctx.lineTo(x + ux * (10 + len), y + uy * (10 + len)); ctx.stroke();
          ctx.setLineDash([]);
        }
        ctx.fillStyle = col;
        ctx.fillText(hollow ? `${lab.code} lost` : lab.code, x + 10, y - 8);
      }
      ctx.globalAlpha = 1;
    }

    // The squadron, on top.
    ships = [];
    ctx.font = '800 11px system-ui, sans-serif';
    for (const s of sim.squad) {
      const x = sx(s.z), y = sy(s.x);
      const col = ROLE_COLOUR[s.role] ?? '#fff';
      if (s.tSunk !== null) {
        ctx.strokeStyle = GREY; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(x - 5, y - 5); ctx.lineTo(x + 5, y + 5); ctx.moveTo(x + 5, y - 5); ctx.lineTo(x - 5, y + 5); ctx.stroke();
        continue;
      }
      ships.push([s.idx, x, y]);
      const ux = Math.sin(s.psi), uy = -Math.cos(s.psi);
      const picked = sel === 'all' || sel === s.idx;
      if (picked) {
        ctx.strokeStyle = sel === s.idx ? '#fff' : 'rgba(255,255,255,0.45)';
        ctx.lineWidth = sel === s.idx ? 2 : 1.2;
        ctx.beginPath(); ctx.arc(x, y, 14, 0, Math.PI * 2); ctx.stroke();
      }
      // hull health as a ring segment
      const f = hullFrac(s);
      ctx.strokeStyle = f < 0.35 ? RED : f < 0.7 ? '#f2c94c' : 'rgba(255,255,255,0.35)';
      ctx.lineWidth = 2.2;
      ctx.beginPath(); ctx.arc(x, y, 11, -Math.PI / 2, -Math.PI / 2 + f * Math.PI * 2); ctx.stroke();
      arrow(x, y, ux, uy, 9, col, 'rgba(8, 12, 18, 0.9)', 1.4);
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'center';
      ctx.fillText(String(s.idx + 1), x, y - 19);
      if (s.stance === 'hold') { ctx.fillStyle = AMBER; ctx.font = '800 9px system-ui, sans-serif'; ctx.fillText('HOLD', x, y + 27); ctx.font = '800 11px system-ui, sans-serif'; }
      ctx.textAlign = 'start';
      if (hasFire(s)) { ctx.fillStyle = '#ff7a1a'; ctx.fillText('▲', x + 15, y - 10); }
    }
    ctx.restore();

    // North mark and the scale.
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.font = '700 11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('N', W - 16, 22);
    ctx.beginPath(); ctx.moveTo(W - 16, 6); ctx.lineTo(W - 20, 15); ctx.lineTo(W - 12, 15); ctx.closePath(); ctx.fill();
    ctx.textAlign = 'start';
    if (label) label.textContent = `${kmLabel(Math.round(scale / 100) * 100)} to the edge${pan ? ' · panned' : ''}${zoom === 'auto' ? ' · auto' : ''}`;
    root.dataset.scale = String(scale);
  }
  const hasFire = (s) => Object.values(s.fire).some((f) => f > 0);

  return {
    update: draw,
    setEnabled(on) { enabled = on; root.hidden = !on; if (on) remeasure(); },
    setBig(b) { big = b; root.classList.toggle('squadron-map-big', b); remeasure(); },
    get zoom() { return zoom; },
  };
}

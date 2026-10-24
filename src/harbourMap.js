import { LAND, BREAKWATER, ROCKS, MOORED, BUOYS, GATE, FAIRWAY, TARGET_BERTH, HULL_OUTLINE, LIGHTS } from './harbour.js';

// The harbour mission's chart: north up, the port as the images show it (land, breakwaters, the ships alongside, berth 7 in
// green, the buoys and the pier-head lights), her own outline to scale with a line to the next mark, her track, and where she
// will be in 30 and 60 seconds if nothing changes (a dotted curve). Click it to change the scale (follow her, the whole
// harbour, the approaches); N hides it. `drawChart` is also what the bridge's chart screen and the paper chart on the chart
// table draw (harbourCrew.js).

const ZOOMS = [{ name: 'Close', half: 260 }, { name: 'Harbour', half: 700 }, { name: 'Approaches', half: 1500 }];
const SCREEN = { sea: '#0f3550', land: '#c9bd9c', bw: '#b7b3aa', ship: '#5b6670', edge: 'rgba(255,255,255,0.35)', line: 'rgba(255,255,255,0.35)', own: '#ffd166', track: 'rgba(255,214,102,0.55)', ahead: 'rgba(255,255,255,0.8)', text: 'rgba(255,255,255,0.85)' };
const PAPER = { sea: '#dfe9ee', land: '#efe0b4', bw: '#cfc6b0', ship: '#8b8f93', edge: 'rgba(60,50,30,0.7)', line: 'rgba(40,40,40,0.55)', own: '#c0392b', track: 'rgba(30,30,30,0.55)', ahead: 'rgba(30,30,30,0.7)', text: 'rgba(30,30,30,0.9)' };

// Draw the chart into a 2D context W x H pixels: `half` metres from the centre (cx, cz) to the nearer edge; `paper` for the
// chart table's printed colours (with soundings and a pencilled route), `headingUp` turns it to her heading (the bridge screen).
export function drawChart(g, W, H, sim, { half = 700, cx = sim.x, cz = sim.z, dpr = 1, paper = false, headingUp = false } = {}) {
  const C = paper ? PAPER : SCREEN;
  const k = Math.min(W, H) / (2 * half);
  const rot = headingUp ? -sim.psi : 0, cr = Math.cos(rot), sr = Math.sin(rot);
  const P = (x, z) => {
    const dx = (z - cz) * k, dy = -(x - cx) * k;
    return [W / 2 + dx * cr - dy * sr, H / 2 + dx * sr + dy * cr];
  };
  g.fillStyle = C.sea;
  g.fillRect(0, 0, W, H);
  const poly = (pts, fill, stroke) => {
    g.beginPath();
    pts.forEach((p, i) => { const [a, b] = P(p.x, p.z); i ? g.lineTo(a, b) : g.moveTo(a, b); });
    g.closePath();
    if (fill) { g.fillStyle = fill; g.fill(); }
    if (stroke) { g.strokeStyle = stroke; g.lineWidth = dpr; g.stroke(); }
  };
  if (paper) { // soundings: a scatter of depths, deeper away from the coast
    g.fillStyle = 'rgba(40,60,90,0.6)';
    g.font = `${Math.round(9 * dpr)}px serif`;
    for (let i = 0; i < 90; i++) {
      const x = cx + (((i * 7919) % 1000) / 500 - 1) * half, z = cz + (((i * 104729) % 1000) / 500 - 1) * half;
      const [a, b] = P(x, z);
      g.fillText(String(8 + ((i * 37) % 23)), a, b);
    }
  }
  poly(LAND.pts, C.land, C.edge);
  poly(BREAKWATER.pts, C.bw, C.edge);
  for (const r of ROCKS) poly(r.pts, paper ? '#b8a27a' : '#8c7c64');
  for (const m of MOORED) poly(m.pts, C.ship, C.edge);
  const [ga, gb] = [P(GATE.a.x, GATE.a.z), P(GATE.b.x, GATE.b.z)];
  g.setLineDash([4 * dpr, 4 * dpr]);
  g.strokeStyle = C.line;
  g.lineWidth = dpr;
  g.beginPath(); g.moveTo(...ga); g.lineTo(...gb); g.stroke();
  const [fx, fy] = P(FAIRWAY.x, FAIRWAY.z);
  g.beginPath(); g.arc(fx, fy, FAIRWAY.r * k, 0, Math.PI * 2); g.stroke();
  g.setLineDash([]);
  const B = TARGET_BERTH;
  const hull = (x, z, psi) => HULL_OUTLINE.map(([a, b]) => ({ x: x + a * Math.cos(psi) - b * Math.sin(psi), z: z + a * Math.sin(psi) + b * Math.cos(psi) }));
  const hot = sim.stage === 'berth' || sim.stage === 'done';
  poly(hull(B.x, B.z, B.psi), hot ? 'rgba(61,220,132,0.28)' : 'rgba(61,220,132,0.12)', '#3ddc84');
  for (const b of BUOYS) {
    const [x, y] = P(b.x, b.z);
    g.fillStyle = b.kind === 'stbd' ? '#2fd673' : b.kind === 'port' ? '#ff4d4d' : '#ffffff';
    g.beginPath(); g.arc(x, y, 3.2 * dpr, 0, Math.PI * 2); g.fill();
    if (b.kind === 'fairway') { g.strokeStyle = '#ff4d4d'; g.lineWidth = 1.5 * dpr; g.stroke(); }
  }
  for (const L of LIGHTS) {
    const [x, y] = P(L.x, L.z);
    g.fillStyle = L.color === 'red' ? '#ff4d4d' : '#2fd673';
    g.beginPath(); g.moveTo(x, y - 5 * dpr); g.lineTo(x + 3.5 * dpr, y + 3 * dpr); g.lineTo(x - 3.5 * dpr, y + 3 * dpr); g.fill();
  }
  if (paper) return k; // the paper chart is printed once: no ship on it
  g.fillStyle = C.track;
  for (let i = 0; i < sim.track.length; i += 2) { const [x, y] = P(sim.track[i].x, sim.track[i].z); g.fillRect(x - dpr, y - dpr, 2 * dpr, 2 * dpr); }
  const m = sim.mark;
  if (m) {
    const [a, b] = P(sim.x, sim.z), [c, d] = P(m.x, m.z);
    g.strokeStyle = 'rgba(61,220,132,0.75)';
    g.setLineDash([2 * dpr, 3 * dpr]);
    g.beginPath(); g.moveTo(a, b); g.lineTo(c, d); g.stroke();
    g.setLineDash([]);
  }
  { // where she will be: her present speeds held for a minute
    let x = sim.x, z = sim.z, psi = sim.psi;
    g.fillStyle = C.ahead;
    for (let i = 1; i <= 60; i++) {
      const c = Math.cos(psi), s = Math.sin(psi);
      x += c * sim.u - s * sim.v; z += s * sim.u + c * sim.v; psi += sim.r;
      if (i % 5 === 0) { const [a, b] = P(x, z); g.beginPath(); g.arc(a, b, (i === 30 || i === 60 ? 2.4 : 1.2) * dpr, 0, Math.PI * 2); g.fill(); }
    }
  }
  if (2 * 58 * k > 14 * dpr) poly(hull(sim.x, sim.z, sim.psi), C.own, '#1a1205');
  else {
    const [x, y] = P(sim.x, sim.z);
    g.save(); g.translate(x, y); g.rotate(sim.psi + rot);
    g.fillStyle = C.own; g.beginPath(); g.moveTo(0, -8 * dpr); g.lineTo(4 * dpr, 6 * dpr); g.lineTo(-4 * dpr, 6 * dpr); g.closePath(); g.fill();
    g.restore();
  }
  return k;
}

export function createHarbourMap() {
  const el = document.createElement('div');
  el.className = 'hb-map';
  el.title = 'Chart, north up. Click to change the scale, N to hide it.';
  el.innerHTML = '<canvas></canvas><div class="hb-map-scale"></div><div class="hb-map-n">N</div>';
  document.body.appendChild(el);
  const canvas = el.querySelector('canvas'), scaleEl = el.querySelector('.hb-map-scale');
  const g = canvas.getContext('2d');
  let zoom = 1, enabled = true, W = 0, H = 0, dpr = 1;
  el.addEventListener('click', () => { zoom = (zoom + 1) % ZOOMS.length; });

  function size() {
    const r = el.getBoundingClientRect();
    dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
    if (Math.round(r.width * dpr) !== W || Math.round(r.height * dpr) !== H) {
      W = Math.round(r.width * dpr); H = Math.round(r.height * dpr);
      canvas.width = W; canvas.height = H;
    }
  }

  function draw(sim) {
    if (!enabled) return;
    size();
    if (!W || !H) return;
    const half = ZOOMS[zoom].half;
    // the centre: on her when following, else the harbour
    const cx = zoom === 0 ? sim.x : zoom === 1 ? 20 : -150, cz = zoom === 0 ? sim.z : zoom === 1 ? -250 : 150;
    const k = drawChart(g, W, H, sim, { half, cx, cz, dpr });
    const bar = half > 1000 ? 500 : half > 400 ? 200 : 100;
    g.strokeStyle = SCREEN.text; g.lineWidth = 1.5 * dpr;
    const x0 = 10 * dpr, y0 = H - 10 * dpr;
    g.beginPath(); g.moveTo(x0, y0 - 4 * dpr); g.lineTo(x0, y0); g.lineTo(x0 + bar * k, y0); g.lineTo(x0 + bar * k, y0 - 4 * dpr); g.stroke();
    scaleEl.textContent = `${bar} m · ${ZOOMS[zoom].name}`;
  }

  return {
    el,
    get enabled() { return enabled; },
    setEnabled(on) { enabled = on; el.hidden = !on; },
    update: draw,
  };
}

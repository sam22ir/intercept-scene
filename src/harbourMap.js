import {
  LAND, BREAKWATERS, MOLES, BOAT_ROWS, BUOYS, LIGHTS, ROUTES, TURN_CIRCLE, PILOT_ZONE, ANCHORAGE, CROSSING, CHANNEL, BERTH_LABELS, WRECK, ROCKS,
  samplePath, toChart, mooredFor, boxCorners, lightOn,
} from './harbour.js';

// The harbour mission's chart, drawn as the chart port-zabana.svg is: the depth bands and their contours, the soundings, the dredged
// channel, the land and the town, the breakwaters and piers, the leading line 000°, the turning circle, the pilot station P, the
// anchorage, the submarine cable, the crossing zone, the fishing pass's waiting point, the lights, the buoys, the berth numbers, and
// this manoeuvre's route (its colour from the chart, astern dashed). Over it, live: the ships alongside and the traffic, the lock's
// gates, the entrance lights, her track, her outline to scale and where she will be in 30 and 60 s. Click it to change the scale;
// N hides it. `drawChart` is also what the bridge's chart screen (heading up) and the paper chart on the chart table draw.

const ZOOMS = [{ name: 'Proche', half: 300 }, { name: 'Port', half: 700 }, { name: 'Baie', half: 1500 }];
const SCREEN = {
  bands: ['#0c2f47', '#0f3a57', '#124666', '#155274', '#185d80'], land: '#c9bd9c', town: 'rgba(120,96,60,0.35)', dike: '#b9a97f', ship: '#5b6670', edge: 'rgba(255,255,255,0.35)',
  line: 'rgba(255,255,255,0.35)', magenta: '#e05bb0', text: 'rgba(255,255,255,0.8)', sound: 'rgba(190,220,240,0.55)', own: '#ffd166', track: 'rgba(255,214,102,0.55)', ahead: 'rgba(255,255,255,0.8)',
};
const PAPER = {
  bands: ['#fbfdfe', '#e6f2f7', '#cfe6f0', '#aed5e6', '#86bfd8'], land: '#f2e7bd', town: 'rgba(220,191,146,0.6)', dike: '#cdbd8b', ship: '#8b8f93', edge: 'rgba(79,65,40,0.8)',
  line: 'rgba(40,40,40,0.55)', magenta: '#b0207a', text: 'rgba(29,43,54,0.9)', sound: 'rgba(29,43,54,0.75)', own: '#c0392b', track: 'rgba(30,30,30,0.55)', ahead: 'rgba(30,30,30,0.7)',
};
// The depth bands of the chart (deepest first): the open water, then the regions above each contour.
const BANDS = [
  'M60,650 C250,690 400,730 560,740 C720,745 880,700 1060,670',
  'M60,520 C200,540 320,590 440,620 C520,640 600,650 700,630 C800,610 900,570 1060,560',
  'M60,430 C160,440 260,470 360,490 C440,510 470,545 540,560 C620,570 700,540 780,510 C860,480 960,470 1060,460',
  'M60,372 C150,372 240,395 330,425 C400,455 450,478 520,500 C560,510 600,510 640,505 C720,495 760,440 840,420 C920,400 1000,405 1060,395',
].map((d) => samplePath(d, 20));
const SOUNDINGS = [
  [120, 358, '1,1'], [250, 366, '1,4'], [425, 432, '1,2'], [860, 372, '1,0'], [980, 372, '1,6'], [1035, 362, '1,3'], [100, 400, '3,2'], [170, 420, '4,1'], [260, 430, '3,7'],
  [350, 450, '3,9'], [800, 462, '3,6'], [900, 448, '2,8'], [1000, 430, '3,3'], [1040, 432, '4,0'], [110, 480, '6,3'], [210, 510, '8,1'], [300, 548, '7,4'], [390, 575, '9,2'],
  [500, 590, '8,6'], [680, 585, '7,9'], [790, 555, '8,8'], [900, 522, '6,7'], [980, 540, '7,2'], [100, 590, '12'], [180, 625, '14'], [300, 672, '16'], [450, 695, '17'],
  [650, 702, '18'], [760, 700, '15'], [960, 640, '13'], [1030, 620, '12'], [90, 740, '24'], [150, 722, '21'], [290, 790, '27'], [400, 820, '31'], [700, 800, '29'],
  [850, 780, '26'], [950, 790, '25'], [1000, 745, '22'], [800, 880, '33'], [780, 915, '38'], [260, 915, '36'], [430, 905, '35'],
  [495, 362, '5,5'], [563, 306, '6,8'], [628, 324, '9,0'], [700, 306, '8,4'], [560, 440, '7,5'], [668, 402, '8,2'], [530, 408, '6,8'], [590, 520, '9,2'], [590, 610, '9,0'],
  [385, 321, '3,5'], [422, 320, '3,8'], [456, 313, '4,0'], [790, 296, '2,8'], [825, 296, '2,6'], [560, 150, '9,2'], [665, 156, '9,0'], [690, 125, '8,8'],
];
const LABELS = [
  ['ZABANA', 415, 150, 15, 'bold'], ['Baie de Zabana', 780, 745, 12, 'italic'], ['OCÉAN ATLANTIQUE', 360, 872, 11, 'italic'], ['Mont Breiz', 200, 108, 9, ''],
  ['Plage de Kerlann', 150, 326, 9, 'italic'], ['Bassin à flot', 625, 140, 9, 'italic'], ['Les Corbeaux', 256, 480, 8, 'italic'], ['Zone de mouillage', 850, 662, 9, 'italic'],
];
const CABLE_PATH = samplePath('M880,336 C900,420 1000,500 1060,540 L1400,760', 10);

// The chart's static part, drawn once in chart pixels (X -500 to 1600, Y -200 to 1400) at S canvas pixels each, for each colour set
// and manoeuvre (the ships alongside and the route differ).
const X0 = -500, Y0 = -200, CW = 2100, CH = 1600;
const bases = new Map();
function chartBase(C, sim) {
  const key = `${C === PAPER ? 'p' : 's'}/${sim.route?.id ?? 'mob'}`;
  if (bases.has(key)) return bases.get(key);
  const S = 1.2;
  const c = document.createElement('canvas');
  c.width = Math.round(CW * S); c.height = Math.round(CH * S);
  const g = c.getContext('2d');
  g.setTransform(S, 0, 0, S, -X0 * S, -Y0 * S);
  const fillPts = (pts, close = true) => { g.beginPath(); pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); if (close) g.closePath(); };
  const fromScene = (pts) => pts.map((p) => toChart(p.x, p.z));
  // the sea, deepest first, then each band above its contour (to the land, far north)
  g.fillStyle = C.bands[0]; g.fillRect(X0, Y0, CW, CH);
  BANDS.forEach((b, i) => {
    g.fillStyle = C.bands[i + 1];
    const pts = [[X0, b[0][1]], ...b, [X0 + CW, b[b.length - 1][1]], [X0 + CW, Y0], [X0, Y0]];
    fillPts(pts); g.fill();
    g.strokeStyle = C === PAPER ? 'rgba(79,134,166,0.8)' : 'rgba(140,190,220,0.35)'; g.lineWidth = 0.8;
    fillPts(b, false); g.stroke();
  });
  // the dredged channel and the port's waters
  g.fillStyle = C.bands[2];
  g.fillRect(548, 472, 54, 183);
  g.strokeStyle = C.magenta; g.setLineDash([5, 3]); g.lineWidth = 1.1;
  g.beginPath(); g.moveTo(548, 478); g.lineTo(548, 655); g.moveTo(602, 486); g.lineTo(602, 655); g.stroke(); g.setLineDash([]);
  // the land, the town's hatch, the breakwaters and piers, the fishing basin's boats
  g.fillStyle = C.land; fillPts(fromScene(LAND.pts)); g.fill();
  g.strokeStyle = C.edge; g.lineWidth = 1; g.stroke();
  g.save(); fillPts(fromScene(LAND.pts)); g.clip();
  g.fillStyle = C.town;
  for (let y = 110; y < 365; y += 9) for (let x = 330; x < 875; x += 9) if (!(x > 465 && x < 745 && y > 236) && !(x > 526 && x < 724 && y > 94 && y < 176)) g.fillRect(x + 1.5, y + 1.5, 5.5, 4.5);
  g.restore();
  for (const B of BREAKWATERS) { g.fillStyle = C.dike; fillPts(fromScene(B.pts)); g.fill(); g.strokeStyle = C.edge; g.stroke(); }
  for (const M of [...MOLES, ...BOAT_ROWS]) { g.fillStyle = C.land; fillPts(fromScene(M.pts)); g.fill(); g.strokeStyle = C.edge; g.stroke(); }
  // Mont Breiz's contours
  g.strokeStyle = C === PAPER ? '#b98f55' : 'rgba(120,90,50,0.6)'; g.lineWidth = 0.8;
  for (const [rx, ry] of [[120, 70], [88, 50], [56, 31], [26, 14]]) { g.beginPath(); g.ellipse(200, 165, rx, ry, 0, 0, Math.PI * 2); g.stroke(); }
  // the soundings
  g.fillStyle = C.sound; g.font = 'italic 9px serif'; g.textAlign = 'center';
  for (const [x, y, t] of SOUNDINGS) g.fillText(t, x, y);
  // the magenta: leading line, turning circle, pilot station, anchorage, cable, crossing zone, waiting point, the wreck and Les Corbeaux
  g.strokeStyle = C.magenta; g.fillStyle = C.magenta; g.lineWidth = 1;
  g.setLineDash([10, 4]); g.beginPath(); g.moveTo(575, 84); g.lineTo(575, 872); g.stroke();
  g.setLineDash([4, 3]); g.beginPath(); g.arc(600, 395, 48, 0, Math.PI * 2); g.stroke();
  g.setLineDash([7, 4]); g.beginPath(); g.arc(575, 815, 30, 0, Math.PI * 2); g.stroke();
  g.beginPath(); g.ellipse(850, 640, 85, 38, 0, 0, Math.PI * 2); g.stroke();
  g.setLineDash([9, 4]); g.lineWidth = 1.2; fillPts(CABLE_PATH, false); g.stroke();
  g.strokeStyle = '#9b4dca'; g.setLineDash([6, 3]); g.lineWidth = 1.3; g.strokeRect(530, 560, 92, 104);
  g.lineWidth = 2.6; g.setLineDash([4, 2.5]); g.beginPath(); g.moveTo(481, 284); g.lineTo(481, 324); g.stroke();
  g.setLineDash([]); g.lineWidth = 1;
  g.font = 'bold 14px sans-serif'; g.fillStyle = C.magenta; g.fillText('P', 575, 820);
  g.font = 'italic 8px sans-serif'; g.fillText('Ø 290 m', 600, 400);
  g.strokeStyle = C.magenta; g.setLineDash([1.5, 2.5]); g.beginPath(); g.arc(850, 520, 13, 0, Math.PI * 2); g.stroke(); g.setLineDash([]);
  g.fillStyle = C.text; g.font = 'italic 8px sans-serif'; g.fillText(`Épave ${String(WRECK.depth).replace('.', ',')} m`, 850, 543);
  for (const R of ROCKS) { const [x, y] = toChart(R.x, R.z); g.strokeStyle = C.text; for (const [dx, dy] of [[-8, 0], [4, 6], [-2, -8], [8, -2]]) { g.beginPath(); g.moveTo(x + dx - 3, y + dy); g.lineTo(x + dx + 3, y + dy); g.moveTo(x + dx, y + dy - 3); g.lineTo(x + dx, y + dy + 3); g.stroke(); } }
  // the berth numbers
  g.font = 'bold 7px sans-serif';
  for (const L of BERTH_LABELS) {
    const [x, y] = toChart(L.x, L.z);
    g.fillStyle = C === PAPER ? '#fff' : 'rgba(10,20,30,0.85)'; g.beginPath(); g.arc(x, y, 6, 0, Math.PI * 2); g.fill();
    g.strokeStyle = C.text; g.stroke();
    g.fillStyle = C.text; g.fillText(L.no, x, y + 2.5);
  }
  // the ships alongside (fixed for the manoeuvre)
  for (const m of sim.moored ?? mooredFor('A')) { g.fillStyle = C.ship; fillPts(fromScene(m.pts)); g.fill(); g.strokeStyle = C.edge; g.stroke(); }
  // the names
  for (const [t, x, y, size, style] of LABELS) { g.fillStyle = C.text; g.font = `${style} ${size}px sans-serif`; g.fillText(t, x, y); }
  // this manoeuvre's route, as the chart draws it
  if (sim.route) {
    const R = sim.route;
    g.strokeStyle = R.color; g.lineWidth = 2.4;
    R.paths.forEach((d, i) => { g.setLineDash(R.astern?.includes(i) ? [3, 3.5] : []); fillPts(samplePath(d), false); g.stroke(); });
    g.setLineDash([]);
  }
  g.textAlign = 'left';
  const out = { c, S };
  bases.set(key, out);
  return out;
}

// Draw the chart into a 2D context W x H pixels: `half` metres from the centre (cx, cz) to the nearer edge; `paper` for the chart
// table's printed colours (no ship on it), `headingUp` turns it to her heading (the bridge screen).
export function drawChart(g, W, H, sim, { half = 700, cx = sim.x, cz = sim.z, dpr = 1, paper = false, headingUp = false, t = sim.t } = {}) {
  const C = paper ? PAPER : SCREEN;
  const k = Math.min(W, H) / (2 * half);
  const rot = headingUp ? -sim.psi : 0, cr = Math.cos(rot), sr = Math.sin(rot);
  const P = (x, z) => {
    const dx = (z - cz) * k, dy = -(x - cx) * k;
    return [W / 2 + dx * cr - dy * sr, H / 2 + dx * sr + dy * cr];
  };
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.fillStyle = C.bands[4]; g.fillRect(0, 0, W, H);
  const base = chartBase(C, sim);
  const [Xc, Yc] = toChart(cx, cz);
  g.save();
  g.translate(W / 2, H / 2); g.rotate(rot); g.scale((3 * k) / base.S, (3 * k) / base.S);
  g.translate(-(Xc - X0) * base.S, -(Yc - Y0) * base.S);
  g.imageSmoothingEnabled = true;
  g.drawImage(base.c, 0, 0);
  g.restore();
  const poly = (pts, fill, stroke) => {
    g.beginPath();
    pts.forEach((p, i) => { const [a, b] = P(p.x, p.z); i ? g.lineTo(a, b) : g.moveTo(a, b); });
    g.closePath();
    if (fill) { g.fillStyle = fill; g.fill(); }
    if (stroke) { g.strokeStyle = stroke; g.lineWidth = dpr; g.stroke(); }
  };
  // the lights and the buoys, lit in their rhythm
  for (const L of LIGHTS) {
    const [x, y] = P(L.x, L.z);
    const on = lightOn(L.char, t);
    g.fillStyle = L.color === 'red' ? '#ff4d4d' : L.color === 'green' ? '#2fd673' : '#fff4c8';
    g.globalAlpha = on ? 1 : 0.35;
    g.beginPath(); g.moveTo(x, y - 5 * dpr); g.lineTo(x + 3.5 * dpr, y + 3 * dpr); g.lineTo(x - 3.5 * dpr, y + 3 * dpr); g.fill();
    g.globalAlpha = 1;
  }
  for (const b of BUOYS) {
    const [x, y] = P(b.x, b.z);
    g.fillStyle = { stbd: '#2fd673', port: '#ff4d4d', north: '#e8b81c', south: '#e8b81c', safe: '#ffffff' }[b.kind];
    g.beginPath(); g.arc(x, y, 3 * dpr, 0, Math.PI * 2); g.fill();
    if (b.kind === 'safe' || b.kind === 'north' || b.kind === 'south') { g.strokeStyle = b.kind === 'safe' ? '#ff4d4d' : '#111'; g.lineWidth = 1.2 * dpr; g.stroke(); }
  }
  if (paper) return k; // the paper chart is printed once: no ships on it
  // the traffic
  if (sim.traffic) {
    for (const v of sim.traffic.vessels) {
      if (!sim.traffic.visible(v)) continue;
      const pts = boxCorners({ x: v.x, z: v.z, psi: v.psi, len: Math.max(v.L, 8 / k), beam: Math.max(v.B, 4 / k) });
      poly(pts, v.role === 'tug' ? '#ff8a5a' : v.role === 'pilot' ? '#ffb347' : v.outbound ? '#ff9ec8' : '#cfd8de', '#0b1218');
    }
  }
  // the lock's gates, and the entrance lights on the Digue Est
  if (sim.lock) {
    for (const [Y, open] of [[232, sim.lock.south], [172, sim.lock.north]]) {
      if (open > 0.95) continue;
      const a = P(...toScene(568, Y)), b = P(...toScene(582, Y));
      g.strokeStyle = '#e8e2d0'; g.lineWidth = 2.5 * dpr; g.beginPath(); g.moveTo(...a); g.lineTo(...b); g.stroke();
    }
  }
  if (sim.route) {
    const [ex, ey] = P(...toScene(712, 446));
    g.fillStyle = sim.entryLight === 'red' ? '#ff4d4d' : '#2fd673';
    g.beginPath(); g.arc(ex, ey, 4 * dpr, 0, Math.PI * 2); g.fill();
    g.strokeStyle = '#000'; g.lineWidth = dpr; g.stroke();
  }
  // the man overboard drill: where he went in (a small circle), the lifebuoy (orange) and him (a red cross)
  if (sim.casualty) {
    const [dx, dy] = P(sim.casualty.x, sim.casualty.z);
    g.strokeStyle = 'rgba(255,255,255,0.6)'; g.lineWidth = dpr; g.beginPath(); g.arc(dx, dy, 4 * dpr, 0, Math.PI * 2); g.stroke();
    const b = sim.buoyPos();
    if (b) { const [bx, by] = P(b.x, b.z); g.fillStyle = '#ff8a2a'; g.beginPath(); g.arc(bx, by, 2.6 * dpr, 0, Math.PI * 2); g.fill(); }
    const c = sim.casualtyPos();
    const [cx2, cy2] = P(c.x, c.z), q = 5 * dpr;
    g.strokeStyle = '#ff4d4d'; g.lineWidth = 2.2 * dpr;
    g.beginPath(); g.moveTo(cx2 - q, cy2 - q); g.lineTo(cx2 + q, cy2 + q); g.moveTo(cx2 + q, cy2 - q); g.lineTo(cx2 - q, cy2 + q); g.stroke();
  }
  // her berth, her track, the line to the next mark, where she will be
  const hull = (x, z, psi) => sim.ship.outline.map(([a, b]) => ({ x: x + a * Math.cos(psi) - b * Math.sin(psi), z: z + a * Math.sin(psi) + b * Math.cos(psi) }));
  if (sim.target) poly(hull(sim.target.x, sim.target.z, sim.target.psi), sim.stage === 'berth' ? 'rgba(61,220,132,0.3)' : 'rgba(61,220,132,0.12)', '#3ddc84');
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
  { // her present speeds (and the stream) held for a minute
    let x = sim.x, z = sim.z, psi = sim.psi;
    g.fillStyle = C.ahead;
    for (let i = 1; i <= 60; i++) {
      const c = Math.cos(psi), s = Math.sin(psi);
      x += c * sim.u - s * sim.v + (sim.stream?.x ?? 0); z += s * sim.u + c * sim.v + (sim.stream?.z ?? 0); psi += sim.r;
      if (i % 5 === 0) { const [a, b] = P(x, z); g.beginPath(); g.arc(a, b, (i === 30 || i === 60 ? 2.4 : 1.2) * dpr, 0, Math.PI * 2); g.fill(); }
    }
  }
  if (sim.ship.L * k > 14 * dpr) poly(hull(sim.x, sim.z, sim.psi), C.own, '#1a1205');
  else {
    const [x, y] = P(sim.x, sim.z);
    g.save(); g.translate(x, y); g.rotate(sim.psi + rot);
    g.fillStyle = C.own; g.beginPath(); g.moveTo(0, -8 * dpr); g.lineTo(4 * dpr, 6 * dpr); g.lineTo(-4 * dpr, 6 * dpr); g.closePath(); g.fill();
    g.restore();
  }
  return k;
}
const toScene = (X, Y) => [(482 - Y) * 3, (X - 575) * 3];

export function createHarbourMap() {
  const el = document.createElement('div');
  el.className = 'hb-map';
  el.title = 'Carte, nord en haut. Cliquez pour changer l\'échelle, N pour la masquer.';
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
    // the centre: on her when close, else the port, or the bay
    const cx = zoom === 0 ? sim.x : zoom === 1 ? 60 : -500, cz = zoom === 0 ? sim.z : zoom === 1 ? 120 : 200;
    const k = drawChart(g, W, H, sim, { half, cx, cz, dpr });
    const bar = half > 1000 ? 600 : half > 400 ? 300 : 100;
    g.setTransform(1, 0, 0, 1, 0, 0);
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

void [ROUTES, TURN_CIRCLE, PILOT_ZONE, ANCHORAGE, CROSSING, CHANNEL];

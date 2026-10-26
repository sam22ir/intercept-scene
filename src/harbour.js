// "Harbour pilot": the port of ZABANA, an imaginary port for teaching (Atlantique Nord-Est, 47°52' N 4°19' O), drawn on the chart
// port-zabana.svg (the source of truth: its legend, its berths, its traffic rules, its standard manoeuvres A to H and its port-call
// checklist). Like the manual flight and Solo Air Defense this is a small real-time simulation stepped at a fixed rate, pure so
// Node can test it (test/harbour.test.mjs); the traffic is harbourTraffic.js (pure too).
//
// The port
//   Every outline below is written in the chart's own pixels (the SVG's 1960 x 1000 frame; 3 m a pixel: the lock is 14 x 60 px for
//   42 x 180 m, the turning circle 96 px across for 290 m, 0.2' of latitude is 123.5 px) and converted once by `px`. North is up.
//   The town and the land lie north; two breakwaters (Digue Ouest, Digue Est) close the avant-port, whose entrance faces south onto a
//   dredged channel (9.0 m) on the leading line 000°. Inside: three piers (berths 1-2, 3-5 and 6-8 with the Ro-Ro ramp), the oil jetty
//   (berth 9), the Quai Est (berth 10), the fishing basin behind its 90 m pass, the marina, and the lock (42 x 180 m, swing bridge) into
//   the bassin à flot (Q1 to Q5).
//
// Coordinates are the scene's: metres, x north, z east (y up); a heading `psi` is measured from +x toward +z (clockwise from north,
// as a compass). In a ship's frame her bow is +x and her starboard side +z.
//
// The ship (one per manoeuvre, `SHIPS`)
//   ← →     the wheel: held keys put the rudder over, let go and it comes back amidships.
//   ↑ ↓     the engine telegraph, one step at a time, from full astern to full ahead (her own `tel`).
//   Q E     bow and stern thrusters (and the tugs, once they are fast) against each other: she turns on the spot.
//   A D     both together: she moves sideways, to port or starboard. Thrusters only work at a crawl; tugs up to about 6 knots.
//   L       the lines: let go, or make fast once she lies still alongside her berth.
//   T       the tugs: call them (they come from berth 2 and make fast at her bow and stern), or let them go.
//   K       VHF channel 12: announce the arrival (or the departure), ask for the lock.
//   M       the anchor: let go, or weigh it.
//
// The rules of the chart's "Consignes de circulation" are all kept and scored: 8 knots in the avant-port, 5 in the basins, 2 in the
// lock; tugs compulsory over 120 m; no stopping in the turning circle; pilot compulsory over 80 m (boarded off the pilot station P,
// VHF 12); priority to outbound ships (the entrance lights on the Digue Est show red while one is in the passage); no anchoring in the
// channel or near the submarine cable; the lock works from two hours before high water to two hours after; no crossing in the fishing
// pass. The tide (springs or neaps) changes the depth over every sounding, and the stream sets across the entrance.

import { Traffic } from './harbourTraffic.js';

const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const wrapPi = (a) => Math.atan2(Math.sin(a), Math.cos(a));

export const DT = 1 / 120;
export const KT = 0.514444; // m/s per knot

// --- The chart, and the port drawn on it -------------------------------------------------------------------------------------
export const MPX = 3; // metres per chart pixel
const ORIGIN = [575, 482]; // the chart pixel at the world origin: the middle of the entrance, on the leading line
export const px = (X, Y) => ({ x: (ORIGIN[1] - Y) * MPX, z: (X - ORIGIN[0]) * MPX });
export const toChart = (x, z) => [z / MPX + ORIGIN[0], ORIGIN[1] - x / MPX]; // back to the chart's pixels

// The interior points of a cubic Bézier (the chart's coast is drawn with them).
function bez(a, b, c, d, kind, n = 7) {
  const out = [];
  for (let i = 1; i < n; i++) {
    const t = i / n, u = 1 - t;
    out.push([u * u * u * a[0] + 3 * u * u * t * b[0] + 3 * u * t * t * c[0] + t * t * t * d[0], u * u * u * a[1] + 3 * u * u * t * b[1] + 3 * u * t * t * c[1] + t * t * t * d[1], kind]);
  }
  return out;
}
// A chart path (M, L and C commands, absolute) as a list of chart points.
export function samplePath(d, n = 8) {
  const tok = d.match(/[MLC]|-?\d+(\.\d+)?/g);
  const out = [];
  let cmd = 'M', i = 0, cur = null;
  const num = () => Number(tok[i++]);
  while (i < tok.length) {
    if (/[MLC]/.test(tok[i])) cmd = tok[i++];
    if (cmd === 'M' || cmd === 'L') { cur = [num(), num()]; out.push(cur); } else {
      const b = [num(), num()], c = [num(), num()], e = [num(), num()];
      for (const [x, y] of bez(cur, b, c, e, '')) out.push([x, y]);
      out.push(e); cur = e;
    }
  }
  return out;
}

// Each vertex is [X, Y, kind], the kind for the edge from it to the next one:
//   q a quay wall (vertical concrete), r rock armour, b sand beach, c a natural rocky coast, x hidden (inland, or shared).
// The coast is the chart's land outline; beyond the chart's frame it runs on west and east, and the land rises inland.
const LAND_PX = [
  [-2600, -2600, 'x'], [3700, -2600, 'x'], [3700, 405, 'c'], [2700, 425, 'c'], [1900, 398, 'c'], [1400, 386, 'c'],
  [1060, 372, 'c'], ...bez([1060, 372], [1000, 350], [950, 322], [890, 330], 'c'), [890, 330, 'c'], ...bez([890, 330], [840, 338], [810, 372], [760, 382], 'c'),
  [760, 382, 'r'], [735, 382, 'q'], [735, 306, 'q'], [770, 306, 'q'], [770, 322, 'q'], [840, 322, 'q'], [840, 252, 'q'], [770, 252, 'q'], [770, 288, 'q'], [735, 288, 'q'], // Quai Est (berth 10), the marina
  [735, 232, 'q'], [582, 232, 'q'], [582, 172, 'q'], [720, 172, 'q'], [720, 98, 'q'], [530, 98, 'q'], [530, 172, 'q'], [568, 172, 'q'], [568, 232, 'q'], // Quai du Commerce, the lock, the bassin à flot
  [470, 232, 'q'], [470, 288, 'q'], [440, 288, 'q'], [440, 262, 'q'], [360, 262, 'q'], [360, 340, 'q'], [440, 340, 'q'], [440, 318, 'q'], [470, 318, 'q'], // the fishing basin and its pass
  [470, 382, 'c'], ...bez([470, 382], [440, 384], [410, 402], [365, 398], 'c'), // Cap de l'Ouest
  [365, 398, 'b'], ...bez([365, 398], [320, 394], [300, 352], [230, 350], 'b'), [230, 350, 'b'], ...bez([230, 350], [160, 348], [110, 330], [60, 338], 'b'), // Plage de Kerlann
  [60, 338, 'b'], [-300, 336, 'c'], [-900, 350, 'c'], [-1700, 332, 'c'], [-2600, 305, 'x'],
];

// The avant-port's water (for the breakwaters' inner faces and the speed limit).
const AVANT_PORT_PX = [[470, 232], [735, 232], [735, 382], [720, 440], [610, 486], [545, 478], [490, 440], [470, 382]];

// A breakwater: the chart draws it as a 14 px stroke along a polyline (42 m wide) with a round head; the root is buried in the land.
function dike(line, hw = 7) {
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1]], nrm = (a) => { const l = Math.hypot(a[0], a[1]); return [a[0] / l, a[1] / l]; };
  const L = [], R = [];
  for (let i = 0; i < line.length; i++) {
    const p = line[i];
    const d0 = i > 0 ? nrm(sub(p, line[i - 1])) : null, d1 = i < line.length - 1 ? nrm(sub(line[i + 1], p)) : null;
    const d = d0 && d1 ? nrm([d0[0] + d1[0], d0[1] + d1[1]]) : (d0 ?? d1);
    const n = [-d[1], d[0]];
    const k = d0 && d1 ? 1 / Math.max(0.5, n[0] * -d1[1] + n[1] * d1[0]) : 1;
    L.push([p[0] + n[0] * hw * k, p[1] + n[1] * hw * k]);
    R.push([p[0] - n[0] * hw * k, p[1] - n[1] * hw * k]);
  }
  const head = line[line.length - 1], a0 = Math.atan2(L[L.length - 1][1] - head[1], L[L.length - 1][0] - head[0]);
  const cap = [];
  for (let j = 1; j < 6; j++) { const a = a0 - (j * Math.PI) / 6; cap.push([head[0] + Math.cos(a) * hw, head[1] + Math.sin(a) * hw]); }
  const pts = [...L, ...cap, ...R.reverse()];
  // the inner face (toward the avant-port) is a wall, the rest rock armour; the root edge is inland
  const kinds = pts.map((p, i) => {
    if (i === pts.length - 1) return 'x';
    const q = pts[(i + 1) % pts.length], mx = (p[0] + q[0]) / 2, my = (p[1] + q[1]) / 2;
    const ex = q[0] - p[0], ey = q[1] - p[1], l = Math.hypot(ex, ey) || 1;
    for (const s of [1, -1]) {
      const tx = mx + (-ey / l) * s * 9, ty = my + (ex / l) * s * 9;
      if (!inPolyPx(pts, tx, ty) && inPolyPx(AVANT_PORT_PX, tx, ty)) return 'q';
    }
    return 'r';
  });
  return pts.map((p, i) => [p[0], p[1], kinds[i]]);
}
function inPolyPx(p, x, y) {
  let inside = false;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    if ((p[i][1] > y) !== (p[j][1] > y) && x < ((p[j][0] - p[i][0]) * (y - p[i][1])) / (p[j][1] - p[i][1]) + p[i][0]) inside = !inside;
  }
  return inside;
}
const rect = (x0, y0, x1, y1, kind = 'q') => [[x0, y0, kind], [x1, y0, kind], [x1, y1, kind], [x0, y1, kind]];

const toPoly = (list, name) => {
  const pts = list.map(([x, y]) => px(x, y));
  const kinds = list.map((v) => v[2] ?? 'q');
  return { pts, kinds, box: bbox(pts), name };
};
function bbox(pts) {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const p of pts) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); z0 = Math.min(z0, p.z); z1 = Math.max(z1, p.z); }
  return { x0, x1, z0, z1 };
}
export const LAND = toPoly(LAND_PX, 'land');
export const DIGUE_OUEST = toPoly(dike([[471, 364], [475, 378], [490, 440], [545, 478]]), 'Digue Ouest');
export const DIGUE_EST = toPoly(dike([[742, 372], [735, 380], [720, 440], [610, 486]]), 'Digue Est');
export const BREAKWATERS = [DIGUE_OUEST, DIGUE_EST];
// The piers inside the avant-port (as the chart draws them), the oil jetty, and the rows of fishing boats on the fishing basin's pontoons.
export const MOLES = [
  toPoly(rect(520, 226, 542, 318), 'Môle 1-2'),
  toPoly(rect(585, 226, 607, 335), 'Môle Commercial (3-5)'),
  toPoly([[650, 226], [672, 226], [672, 300], [670, 300], [670, 313], [652, 313], [652, 300], [650, 300]].map((p) => [...p, 'q']), 'Môle 6-8'),
  toPoly([[738, 255], [713, 255], [713, 242], [704, 242], [704, 274], [713, 274], [713, 261], [738, 261]].map((p) => [...p, 'q']), 'Appontement pétrolier'),
];
export const BOAT_ROWS = [toPoly(rect(364, 263, 438, 275), 'pontons Nord'), toPoly(rect(371, 328, 436, 339), 'pontons Sud')];

// --- Faces, berths and the ships alongside ----------------------------------------------------------------------------------
// A face is a quay wall from a to b; `n` is its unit normal toward the water (the chart point w lies in the water).
function face(ax, ay, bx, by, wx, wy, name) {
  const a = px(ax, ay), b = px(bx, by), w = px(wx, wy);
  const len = Math.hypot(b.x - a.x, b.z - a.z);
  const dir = { x: (b.x - a.x) / len, z: (b.z - a.z) / len };
  let n = { x: -dir.z, z: dir.x };
  if ((w.x - a.x) * n.x + (w.z - a.z) * n.z < 0) n = { x: -n.x, z: -n.z };
  return { a, b, len, dir, n, psi: Math.atan2(dir.z, dir.x), name };
}
export const FACES = {
  b1: face(520, 232, 520, 318, 500, 275, 'Poste 1 · pêche, criée'),
  b2: face(542, 232, 542, 318, 560, 275, 'Poste 2 · remorqueurs'),
  b35: face(607, 232, 607, 335, 625, 283, 'Postes 3-4-5 · Môle Commercial'),
  b35w: face(585, 232, 585, 335, 565, 283, 'Môle Commercial, face Ouest'),
  b6: face(650, 232, 650, 300, 630, 266, 'Poste 6 · vrac, cargo'),
  b7: face(672, 232, 672, 300, 690, 266, 'Poste 7 · cabotage, croisière'),
  b9: face(704, 242, 704, 274, 690, 258, 'Poste 9 · appontement pétrolier'),
  b10: face(735, 306, 735, 382, 715, 344, 'Poste 10 · Quai Est'),
  fish: face(360, 276, 360, 328, 380, 302, 'Bassin de pêche, quai Ouest'),
  q13: face(530, 98, 720, 98, 625, 130, 'Q1-Q3 · bassin à flot, quai Nord'),
  q4: face(720, 100, 720, 170, 700, 135, 'Q4 · bassin à flot, quai Est'),
  q5: face(530, 100, 530, 170, 560, 135, 'Q5 · bassin à flot, quai Ouest'),
};
// The Ro-Ro ramp at the head of pier 6-8 (berth 8): she lies stern to it, bow south.
export const RAMP = { ...px(661, 313), n: { x: -1, z: 0 }, half: 9 * MPX / 2, name: 'Poste 8 · rampe Ro-Ro' };
export const FENDER = 1.5; // m between the quay and her side when she lies alongside
// A spot alongside a face: `t` along it (0 at a, 1 at b), `off` the distance of her centreline from the wall.
export function alongside(f, t, off) {
  return { x: f.a.x + f.dir.x * f.len * t + f.n.x * off, z: f.a.z + f.dir.z * f.len * t + f.n.z * off };
}
// The berths of the chart's table (POSTES À QUAI): length and depth.
export const BERTHS = [
  { no: '1', use: 'Pêche · criée', len: 90, depth: 5.5, face: FACES.b1 },
  { no: '2', use: 'Remorqueurs · attente écluse', len: 90, depth: 6.5, face: FACES.b2 },
  { no: '3-5', use: 'Cargo général (grues)', len: 300, depth: 9.0, face: FACES.b35 },
  { no: '6', use: 'Vrac / cargo', len: 180, depth: 8.5, face: FACES.b6 },
  { no: '7', use: 'Cabotage · croisière', len: 150, depth: 7.5, face: FACES.b7 },
  { no: '8', use: 'Ro-Ro / ferry (rampe)', len: 200, depth: 7.0, ramp: RAMP },
  { no: '9', use: 'Appontement pétrolier', len: 220, depth: 9.5, face: FACES.b9 },
  { no: '10', use: 'Quai Est · vrac liquide', len: 190, depth: 9.0, face: FACES.b10 },
  { no: 'Q1-Q3', use: 'Bassin à flot, quai Nord', len: 270, depth: 7.5, face: FACES.q13 },
  { no: 'Q4-Q5', use: 'Bassin à flot, quais E/O', len: 120, depth: 7.5, face: FACES.q5 },
  { no: 'M', use: 'Port de plaisance (≈ 80 pl.)', len: 0, depth: 2.8 },
];
// Where each number is printed on the chart (the scene and the map put their boards there).
export const BERTH_LABELS = [
  ['1', 531, 252], ['2', 531, 292], ['3', 596, 256], ['4', 596, 286], ['5', 596, 316], ['6', 661, 252], ['7', 661, 280], ['8', 661, 306], ['9', 708, 258], ['10', 728, 326],
  ['Q1', 600, 90], ['Q2', 650, 90], ['Q3', 700, 90], ['Q4', 730, 135], ['Q5', 522, 135],
].map(([no, X, Y]) => ({ no, ...px(X, Y) }));

// The ships that stay alongside whatever the manoeuvre (obstacles; the scene draws a model for each `type`). The ships that may
// move (the coaster at berth 3, the cargo at berth 6, the tugs) are harbourTraffic.js's.
const moored = (type, f, t, len, beam, psi) => {
  const c = alongside(f, t, beam / 2 + FENDER);
  return { type, x: c.x, z: c.z, psi: rad(psi), len, beam };
};
export function mooredFor(route) {
  const list = [
    moored('trawler', FACES.b1, 0.28, 26, 7, 0),
    moored('tanker', FACES.b9, 0.5, 140, 22, 0),
    moored('cargo', FACES.q13, 0.526, 168, 26, 90),
    moored('general', FACES.q4, 0.54, 126, 20, 0),
  ];
  if (route !== 'G') list.push(moored('coaster', FACES.b7, 0.5, 120, 19, 0));
  for (const m of list) { m.pts = boxCorners(m); m.kinds = m.pts.map(() => 'q'); m.box = bbox(m.pts); }
  return list;
}
export function boxCorners(m) {
  const c = Math.cos(m.psi), s = Math.sin(m.psi), L = m.len / 2, B = m.beam / 2;
  // a pointed bow, so a ship coming along her bow slides off it
  return [[L, 0], [L * 0.8, B], [-L, B], [-L, -B], [L * 0.8, -B]].map(([a, b]) => ({ x: m.x + a * c - b * s, z: m.z + a * s + b * c }));
}

// Everything fixed she can hit (the lock's gates and bridge, the ships alongside and the traffic are added by the sim).
export const STATIC_SOLIDS = [LAND, ...BREAKWATERS, ...MOLES, ...BOAT_ROWS];

// --- Zones, marks and lights ----------------------------------------------------------------------------------------------------
const zone = (list) => toPoly(list.map((p) => [p[0], p[1], 'x']));
const rectZ = (x0, y0, x1, y1) => zone([[x0, y0], [x1, y0], [x1, y1], [x0, y1]]);
export const AVANT_PORT = zone(AVANT_PORT_PX);
export const BASINS = [rectZ(470, 226, 738, 320), rectZ(355, 258, 470, 344), rectZ(526, 94, 724, 172), rectZ(735, 248, 844, 326)]; // the docks, fishing basin, bassin à flot, marina
export const LOCK = { chamber: rectZ(568, 172, 582, 232), south: px(575, 232), north: px(575, 172), stopLine: px(575, 248).x, name: 'Écluse 42 × 180 m' };
export const CHANNEL = rectZ(548, 472, 602, 655); // the dredged channel, 9.0 m
export const CROSSING = rectZ(530, 560, 622, 664); // the crossing zone, between G3-R4 and G1-R2
export const PASS = rectZ(440, 288, 470, 318); // the fishing basin's pass, 90 m
export const PASS_AREA = rectZ(430, 284, 480, 322);
export const WAIT_POINT = { a: px(481, 284), b: px(481, 324), name: 'Point d\'attente (passe)' };
export const TURN_CIRCLE = { ...px(600, 395), r: 48 * MPX, name: 'Cercle d\'évitage Ø 290 m' };
export const PILOT_ZONE = { ...px(575, 815), r: 30 * MPX, name: 'Zone d\'embarquement du pilote (VHF 12)' };
export const ANCHORAGE = { ...px(850, 640), rx: 38 * MPX, rz: 85 * MPX, name: 'Zone de mouillage' }; // rx along north, rz along east
export const CABLE = samplePath('M880,336 C900,420 1000,500 1060,540 L1400,760').map(([X, Y]) => px(X, Y));
export const GATE = { a: px(545, 478), b: px(610, 486) }; // west jetty head → east jetty head
export const ALIGNMENT = { front: px(575, 84), rear: px(575, 70), z: 0, psi: 0 }; // leading line 000°
export const LANDING_BUOY = px(575, 894);
export const PASSAGE = rectZ(500, 380, 680, 600); // outbound ships here have priority (the entrance lights show red)
// The lights, with their characteristics as the chart lists them (CARACTÉRISTIQUES DES FEUX) and the buoys' (IALA region A).
export const LIGHTS = [
  { id: 'pointeEst', name: 'Phare de la Pointe Est', ...px(890, 324), char: 'Fl(2) W 10s', color: 'white', height: 42, range: 18 },
  { id: 'capOuest', name: 'Feu du Cap de l\'Ouest', ...px(363, 392), char: 'Fl(3) WR 12s', color: 'white', red: [200, 240], height: 18, range: 11 },
  { id: 'jeteeOuest', name: 'Jetée Ouest', ...px(545, 478), char: 'Fl R 4s', color: 'red', height: 9, range: 6 },
  { id: 'jeteeEst', name: 'Jetée Est', ...px(610, 486), char: 'Fl G 4s', color: 'green', height: 9, range: 6 },
  { id: 'alignAv', name: 'Alignement 000° (antérieur)', ...px(575, 84), char: 'Iso W 2s', color: 'white', height: 14, range: 11 },
  { id: 'alignAr', name: 'Alignement 000° (postérieur)', ...px(575, 70), char: 'Iso W 2s', color: 'white', height: 28, range: 11 },
];
export const BUOYS = [
  { id: 'R2', kind: 'port', ...px(536, 650), char: 'Fl R 3s' },
  { id: 'R4', kind: 'port', ...px(536, 570), char: 'Fl R 3s' },
  { id: 'G1', kind: 'stbd', ...px(614, 660), char: 'Fl G 3s' },
  { id: 'G3', kind: 'stbd', ...px(614, 580), char: 'Fl G 3s' },
  { id: 'N', kind: 'north', ...px(300, 438), char: 'Q' },
  { id: 'S', kind: 'south', ...px(300, 512), char: 'Q(6)+LFl 15s' },
  { id: 'LB', kind: 'safe', ...LANDING_BUOY, char: 'Iso W 8s' },
];
export const ROCKS = [{ name: 'Les Corbeaux', ...px(301, 467), r: 12 * MPX, dries: 0.5 }];
export const WRECK = { name: 'Épave', ...px(850, 520), depth: 7.6 };
// The entrance lights (feux de passe) on the Digue Est and the lock's light, where the scene puts them.
export const ENTRY_SIGNAL = px(712, 446);
export const LOCK_SIGNAL = px(565, 238);

// Is a light lit at time t (s)? The rhythms of the chart: Fl(n) period, Iso period, Q, Q(6)+LFl.
export function lightOn(char, t) {
  let m;
  if ((m = /^Fl\((\d)\).*?(\d+)s/.exec(char))) { // n flashes of 0.5 s, 1.5 s apart, every period
    const n = Number(m[1]), T = Number(m[2]), u = ((t % T) + T) % T;
    return u < n * 1.5 && u % 1.5 < 0.5;
  }
  if ((m = /^Fl .*?(\d+)s/.exec(char))) { const T = Number(m[1]); return ((t % T) + T) % T < 0.6; }
  if ((m = /^Iso .*?(\d+)s/.exec(char))) { const T = Number(m[1]); return ((t % T) + T) % T < T / 2; }
  if (/^Q\(6\)/.test(char)) { const u = ((t % 15) + 15) % 15; return u < 6 ? u % 1 < 0.5 : u >= 6 && u < 8; }
  if (/^Q/.test(char)) return t % 1 < 0.5;
  return true;
}

// --- Depths and the tide -----------------------------------------------------------------------------------------------------------
// The chart's depth contours (2, 5, 10 and 20 m, Bézier curves across the bay), read as a depth along each chart column.
const CONTOURS = [
  [2, 'M60,372 C150,372 240,395 330,425 C400,455 450,478 520,500 C560,510 600,510 640,505 C720,495 760,440 840,420 C920,400 1000,405 1060,395'],
  [5, 'M60,430 C160,440 260,470 360,490 C440,510 470,545 540,560 C620,570 700,540 780,510 C860,480 960,470 1060,460'],
  [10, 'M60,520 C200,540 320,590 440,620 C520,640 600,650 700,630 C800,610 900,570 1060,560'],
  [20, 'M60,650 C250,690 400,730 560,740 C720,745 880,700 1060,670'],
].map(([d, path]) => {
  const pts = samplePath(path, 24);
  return { d, at: (X) => { // its chart Y at column X (flat beyond the chart's edges)
    if (X <= pts[0][0]) return pts[0][1];
    for (let i = 1; i < pts.length; i++) if (X <= pts[i][0]) { const [x0, y0] = pts[i - 1], [x1, y1] = pts[i]; return y0 + ((y1 - y0) * (X - x0)) / (x1 - x0 || 1); }
    return pts[pts.length - 1][1];
  } };
});
// Soundings inside the port (metres below chart datum), interpolated by inverse distance within each basin.
const SOUND = {
  avant: [[495, 362, 5.5], [563, 306, 6.8], [628, 324, 9.0], [700, 306, 8.4], [560, 440, 7.5], [668, 402, 8.2], [530, 408, 6.8], [720, 350, 9.0], [610, 250, 9.0], [700, 250, 9.5]],
  baf: [[560, 150, 9.2], [665, 156, 9.0], [690, 125, 8.8]],
  fish: [[385, 321, 3.5], [422, 320, 3.8], [456, 313, 4.0]],
  marina: [[790, 296, 2.8], [825, 296, 2.6]],
};
const idw = (list, X, Y) => {
  let s = 0, w = 0;
  for (const [x, y, d] of list) { const k = 1 / (1e-3 + (x - X) ** 2 + (y - Y) ** 2); s += k * d; w += k; }
  return s / w;
};
const lerp = (a, b, k) => a + (b - a) * k;
// The charted depth (below chart datum; negative dries) at scene (x, z).
export function chartDepth(x, z) {
  const [X, Y] = toChart(x, z);
  if (inPoly(LOCK.chamber, x, z)) return 7.0;
  if (inPoly(BASINS[2], x, z)) return idw(SOUND.baf, X, Y);
  if (inPoly(BASINS[1], x, z)) return idw(SOUND.fish, X, Y);
  if (inPoly(BASINS[3], x, z)) return idw(SOUND.marina, X, Y);
  if (inPoly(CHANNEL, x, z)) return X > 590 || X < 560 ? 9.0 : 9.2;
  if (inPoly(AVANT_PORT, x, z) || inPoly(BASINS[0], x, z)) return idw(SOUND.avant, X, Y);
  // the open bay, from the contours
  const ys = CONTOURS.map((c) => c.at(X));
  let d;
  if (Y < ys[0]) d = Math.max(0.2, 2 - (ys[0] - Y) * 0.03);
  else if (Y < ys[1]) d = lerp(2, 5, (Y - ys[0]) / (ys[1] - ys[0]));
  else if (Y < ys[2]) d = lerp(5, 10, (Y - ys[1]) / (ys[2] - ys[1]));
  else if (Y < ys[3]) d = lerp(10, 20, (Y - ys[2]) / (ys[3] - ys[2]));
  else d = Math.min(45, 20 + (Y - ys[3]) * 0.08);
  // Les Corbeaux (drying 0.5 m) and the wreck (7.6 m)
  for (const R of ROCKS) { const r = Math.hypot(x - R.x, z - R.z); if (r < R.r * 2.5) d = Math.min(d, lerp(-R.dries, d, clamp((r - R.r) / (R.r * 1.5), 0, 1))); }
  { const r = Math.hypot(x - WRECK.x, z - WRECK.z); if (r < 45) d = Math.min(d, lerp(WRECK.depth, d, clamp((r - 18) / 27, 0, 1))); }
  // the dredged channel's sides slope over 6 px (18 m) down to its 9 m
  const out = Math.max(548 - X, X - 602, 0) + Math.max(472 - Y, Y - 655, 0);
  if (out > 0 && out < 6 && Y > 466 && Y < 661) d = Math.max(d, lerp(9.0, d, out / 6));
  return d;
}
// The tide (MARÉES ET COURANTS): springs high water +6.20 m, low +0.80 m; neaps +4.90 / +2.10; mean level +3.50 m; a semi-diurnal
// tide of 12 h 25 min. `hour` is the time from high water (negative before it: the flood).
export const TIDE_PERIOD = 12.42; // hours
export const TIDES = { spring: { name: 'Vive-eau', hw: 6.2, lw: 0.8, flood: 1.5, ebb: 1.8 }, neap: { name: 'Morte-eau', hw: 4.9, lw: 2.1, flood: 0.8, ebb: 1.0 } };
export function tideHeight(spring, hour) {
  const T = spring ? TIDES.spring : TIDES.neap;
  return (T.hw + T.lw) / 2 + ((T.hw - T.lw) / 2) * Math.cos((2 * Math.PI * hour) / TIDE_PERIOD);
}
// The stream in the entrance ("courant dans la passe"): the flood sets 090° at up to 1.5 kn, the ebb 270° at up to 1.8 kn (springs),
// strongest at mid-tide; it is felt across the passage outside the jetty heads and fades inside them and out in the bay.
export function tidalStream(spring, hour, x, z) {
  const T = spring ? TIDES.spring : TIDES.neap;
  const ph = -Math.sin((2 * Math.PI * hour) / TIDE_PERIOD); // > 0 rising (before high water): the flood
  const kn = ph > 0 ? T.flood * ph : T.ebb * ph;
  const [X, Y] = toChart(x, z);
  const along = clamp((Y - 460) / 25, 0, 1) * clamp((720 - Y) / 120, 0, 1);
  const across = clamp((260 - Math.abs(X - 578)) / 120, 0, 1);
  return { x: 0, z: kn * KT * along * across, kn: kn * along * across };
}
// Seconds of game time are seconds of tide time.
const H = 3600;

// --- Geometry helpers ------------------------------------------------------------------------------------------------------------
export function inPoly(poly, x, z) {
  const b = poly.box;
  if (x < b.x0 || x > b.x1 || z < b.z0 || z > b.z1) return false;
  const p = poly.pts;
  let inside = false;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    if ((p[i].z > z) !== (p[j].z > z) && x < ((p[j].x - p[i].x) * (z - p[i].z)) / (p[j].z - p[i].z) + p[i].x) inside = !inside;
  }
  return inside;
}
// The nearest point on a polygon's outline: distance, and the unit normal from that point toward (x, z).
export function nearestEdge(poly, x, z) {
  const p = poly.pts;
  let best = Infinity, nx = 0, nz = 0, kind = 'x';
  for (let i = 0; i < p.length; i++) {
    const a = p[i], b = p[(i + 1) % p.length];
    const ex = b.x - a.x, ez = b.z - a.z;
    const l2 = ex * ex + ez * ez || 1;
    const t = clamp(((x - a.x) * ex + (z - a.z) * ez) / l2, 0, 1);
    const qx = a.x + ex * t, qz = a.z + ez * t;
    const d = Math.hypot(x - qx, z - qz);
    if (d < best) { best = d; nx = (x - qx) / (d || 1); nz = (z - qz) / (d || 1); kind = poly.kinds[i]; }
  }
  return { d: best, nx, nz, kind };
}
// The distance from (x, z) to the nearest of `solids` (0 inside one).
export function clearance(x, z, solids = STATIC_SOLIDS) {
  let best = Infinity;
  for (const s of solids) {
    if (inPoly(s, x, z)) return 0;
    const b = s.box;
    const dx = Math.max(b.x0 - x, 0, x - b.x1), dz = Math.max(b.z0 - z, 0, z - b.z1);
    if (Math.hypot(dx, dz) > best) continue;
    best = Math.min(best, nearestEdge(s, x, z).d);
  }
  return best;
}
const GATE_LEN = Math.hypot(GATE.b.x - GATE.a.x, GATE.b.z - GATE.a.z);
// Which side of the entrance line a point is, in metres: > 0 inside the avant-port.
const gateRaw = (x, z) => ((GATE.b.z - GATE.a.z) * (x - GATE.a.x) - (GATE.b.x - GATE.a.x) * (z - GATE.a.z)) / GATE_LEN;
const GATE_SIGN = gateRaw(px(578, 440).x, px(578, 440).z) > 0 ? 1 : -1;
export const gateSide = (x, z) => gateRaw(x, z) * GATE_SIGN;
export const inHarbour = (x, z) => inPoly(AVANT_PORT, x, z) || BASINS.some((b) => inPoly(b, x, z)) || inPoly(LOCK.chamber, x, z);
// The speed limit where she is (VITESSE: 8 kn avant-port · 5 kn bassins · 2 kn écluse), the leading line's 8 kn in the channel
// (check-list item 2), or Infinity at sea.
export function speedZone(x, z) {
  if (inPoly(LOCK.chamber, x, z)) return { kn: 2, name: 'écluse' };
  if (BASINS.some((b) => inPoly(b, x, z))) return { kn: 5, name: 'bassins' };
  if (inPoly(AVANT_PORT, x, z)) return { kn: 8, name: 'avant-port' };
  if (inPoly(CHANNEL, x, z)) return { kn: 8, name: 'chenal (alignement)' };
  return { kn: Infinity, name: 'large' };
}
const inEllipse = (E, x, z) => ((x - E.x) / E.rx) ** 2 + ((z - E.z) / E.rz) ** 2 < 1;
const distToPolyline = (pts, x, z) => {
  let best = Infinity;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i], ex = b.x - a.x, ez = b.z - a.z, l2 = ex * ex + ez * ez || 1;
    const t = clamp(((x - a.x) * ex + (z - a.z) * ez) / l2, 0, 1);
    best = Math.min(best, Math.hypot(x - a.x - ex * t, z - a.z - ez * t));
  }
  return best;
};
export const inAnchorage = (x, z) => inEllipse(ANCHORAGE, x, z);
export const nearCable = (x, z) => distToPolyline(CABLE, x, z) < 150;
// The channel and its approach on the leading line out to the pilot station: no anchoring there.
export const inFairway = (x, z) => { const [X, Y] = toChart(x, z); return inPoly(CHANNEL, x, z) || (Y > 640 && Y < 880 && Math.abs(X - 575) < 35); };

// --- The ships ----------------------------------------------------------------------------------------------------------------
// The frigate's telegraph (the man overboard drill), and the merchant ships': dead slow is the lock's 2 knots, slow the basins' 5,
// half the avant-port's 8.
export const TELEGRAPH = [
  { name: 'Full astern', kn: -10 }, { name: 'Half astern', kn: -6 }, { name: 'Slow astern', kn: -3 }, { name: 'Stop', kn: 0 },
  { name: 'Dead slow', kn: 3 }, { name: 'Slow', kn: 6 }, { name: 'Half', kn: 10 }, { name: 'Full', kn: 16 },
];
const NAMES_FR = ['Arrière toute', 'Demi arrière', 'Arrière lente', 'Stop', 'Avant très lente', 'Avant lente', 'Demi avant', 'Avant toute'];
const tel = (kns) => kns.map((kn, i) => ({ name: NAMES_FR[i], kn }));
export const TEL_BIG = tel([-8, -5, -2, 0, 2, 5, 8, 14]);
export const TEL_SMALL = tel([-5, -3, -1.5, 0, 2, 4, 6, 9]);
export const STOP_ORDER = 3;
export const RUDDER_MAX = rad(35);
const RUDDER_RATE = rad(9); // per second, the key held
const RUDDER_BACK = rad(12); // per second back to amidships, the key let go
const TURN_LOSS = 0.2; // the share of her speed lost at full rudder
const HEEL = 0.06;
const SWAY_T = 7; // s
// The tugs, once fast: they turn her and push her sideways up to about 6 knots (full effect at 3 kn and below).
export const TUGS = { yaw: rad(1.0), sway: 0.4, full: 3, none: 7, part: 8 };
export const tugFactor = (u) => clamp((TUGS.none - Math.abs(u) / KT) / (TUGS.none - TUGS.full), 0, 1);

// Her waterline in her own frame (bow +x, starboard +z), as points for the contacts.
export const HULL_PTS = [[58, 0], [50, -2.8], [50, 2.8], [38, -5.4], [38, 5.4], [22, -7.1], [22, 7.1], [0, -7.5], [0, 7.5], [-25, -7.5], [-25, 7.5], [-45, -7.4], [-45, 7.4], [-57, -6.6], [-57, 6.6], [-57.5, 0]];
// The same waterline as one closed outline (starboard side forward to aft, then the port side back), for drawing.
export const outlineOf = (pts) => [...pts.filter(([, b]) => b >= 0).sort((p, q) => q[0] - p[0]), ...pts.filter(([, b]) => b < 0).sort((p, q) => p[0] - q[0])];
export const HULL_OUTLINE = outlineOf(HULL_PTS);
const SHAPES = {
  merchant: [[1, 0], [0.93, 0.42], [0.8, 0.83], [0.64, 1], [0.3, 1], [-0.2, 1], [-0.62, 1], [-0.88, 1], [-0.98, 0.88], [-1, 0.55], [-1, 0]],
  small: [[1, 0], [0.82, 0.62], [0.45, 1], [-0.1, 1], [-0.7, 1], [-1, 0.82], [-1, 0]],
};
function hullPts(kind, L, B) {
  if (kind === 'frigate') return HULL_PTS;
  const out = [];
  for (const [a, b] of SHAPES[kind]) { out.push([a * L / 2, b * B / 2]); if (b > 0) out.push([a * L / 2, -b * B / 2]); }
  return out;
}
// turnR: m at full rudder at speed; turnT, speedT, coastT: s; accel: m/s²; thrYaw deg/s and thrSway m/s at full thrust stopped,
// none from thrFade knots; T: draught (m). (Her model, harbourShips.js, gives the wheelhouse eye.)
export const SHIPS = {
  frigate: { id: 'frigate', name: 'Frégate', L: 116, B: 15, T: 4.5, tel: TELEGRAPH, turnR: 90, turnT: 6, speedT: 16, coastT: 60, accel: 0.16, accelAst: 0.2, thrYaw: 1.7, thrSway: 0.55, thrFade: 5, hull: 'frigate' },
  cargo: { id: 'cargo', name: 'Cargo', L: 180, B: 28, T: 8.0, tel: TEL_BIG, turnR: 230, turnT: 13, speedT: 30, coastT: 120, accel: 0.06, accelAst: 0.075, thrYaw: 0.45, thrSway: 0.16, thrFade: 4, hull: 'merchant' },
  ferry: { id: 'ferry', name: 'Ferry roulier', L: 200, B: 30, T: 6.5, tel: TEL_BIG, turnR: 250, turnT: 12, speedT: 26, coastT: 110, accel: 0.07, accelAst: 0.085, thrYaw: 1.0, thrSway: 0.34, thrFade: 5, hull: 'merchant' },
  trawler: { id: 'trawler', name: 'Chalutier', L: 25, B: 7.5, T: 3.5, tel: TEL_SMALL, turnR: 38, turnT: 3, speedT: 8, coastT: 25, accel: 0.25, accelAst: 0.3, thrYaw: 2.5, thrSway: 0.2, thrFade: 4, hull: 'small' },
  general: { id: 'general', name: 'Cargo général', L: 120, B: 18, T: 6.5, tel: TEL_BIG, turnR: 165, turnT: 10, speedT: 22, coastT: 90, accel: 0.09, accelAst: 0.1, thrYaw: 0.7, thrSway: 0.22, thrFade: 4, hull: 'merchant' },
  tanker: { id: 'tanker', name: 'Pétrolier', L: 190, B: 32, T: 8.5, tel: TEL_BIG, turnR: 270, turnT: 15, speedT: 34, coastT: 140, accel: 0.05, accelAst: 0.065, thrYaw: 0.35, thrSway: 0.12, thrFade: 4, hull: 'merchant' },
  coaster: { id: 'coaster', name: 'Caboteur', L: 150, B: 23, T: 6.8, tel: TEL_BIG, turnR: 200, turnT: 12, speedT: 26, coastT: 100, accel: 0.08, accelAst: 0.09, thrYaw: 0.6, thrSway: 0.2, thrFade: 4, hull: 'merchant' },
};
for (const s of Object.values(SHIPS)) { s.pts = hullPts(s.hull, s.L, s.B); s.outline = outlineOf(s.pts); }
export const HALF_LENGTH = 58; // the frigate's (the man overboard drill)
export const HALF_BEAM = 7.5;
export const thrusterFactor = (u, fade = 5) => clamp(1 - Math.abs(u) / (fade * KT), 0, 1);

// Contacts: closing speeds (m/s) above which a contact is hard, and a collision.
export const TOUCH = 0.12;
export const HARD = 0.5;
export const CRASH = 1.2;
const DAMAGE_PER = 22; // % of her hull for each m/s above HARD
export const BERTH_CONTACT = 0.3 * KT; // check-list item 5: 0.3 kn at most against the quay
// Berthing: how still and how close she has to lie before the lines can go on.
export const BERTH_TOL = { along: 22, gap: 6, heading: rad(7), speed: 0.3 * KT, sway: 0.25, rate: rad(0.4), hold: 3 };

// --- The standard manoeuvres (MANŒUVRES TYPES, routes A to H) ------------------------------------------------------------------------
// Each: the ship, the chart's route (its colour and path, for the chart), where she starts, her berth, the tide, and the order of
// her stages. `text` is the chart's own two lines.
export const ROUTES = {
  A: {
    id: 'A', color: '#1f5fa8', ship: 'cargo', title: 'Cargo 180 m → postes 3-4-5', where: 'Môle Commercial', kind: 'in',
    text: ['Alignement 000°, 5 nd, puis 3 nd au bassin.', 'Remonter le bassin, accoster bâbord à quai.'],
    paths: ['M578,700 L578,500 C582,450 618,430 618,385 L618,330 L617,278'],
    start: { at: [580, 928], hdg: 0, kn: 8 }, target: { face: 'b35', t: 0.5, side: 'port', name: 'Postes 3-4-5' },
    tide: { spring: true, hour: 1 }, stages: ['approach', 'channel', 'berth'],
  },
  B: {
    id: 'B', color: '#e07b00', ship: 'ferry', title: 'Ferry 200 m → poste 8 (rampe Ro-Ro)', where: 'Môle 6-8', kind: 'in',
    text: ['Évitage 180° à tribord dans le cercle,', 'puis marche arrière jusqu\'à la rampe.'],
    paths: ['M586,700 L586,445 C586,385 650,385 650,445', 'M650,445 C650,415 661,405 661,372 L661,318'], astern: [1],
    start: { at: [586, 928], hdg: 0, kn: 8 }, target: { ramp: true, name: 'Poste 8 · rampe Ro-Ro' }, evitage: { speed: 3 },
    tide: { spring: false, hour: -3 }, stages: ['approach', 'channel', 'evitage', 'berth'],
  },
  C: {
    id: 'C', color: '#00838f', ship: 'trawler', title: 'Chalutier 25 m → bassin de pêche (poste 1)', where: 'Bassin de pêche', kind: 'in',
    text: ['Longer la digue Ouest, passe de 90 m de large.', 'Priorité aux sortants. Pas d\'évitage.'],
    paths: ['M562,700 L562,500 C562,470 540,450 515,415 C500,395 498,360 490,322 C484,306 470,304 440,303 L405,300'],
    start: { at: [562, 772], hdg: 0, kn: 6 }, target: { face: 'fish', t: 0.5, name: 'Bassin de pêche, quai Ouest' },
    tide: { spring: true, hour: 5.5 }, stages: ['approach', 'channel', 'pass', 'berth'],
  },
  D: {
    id: 'D', color: '#b71c1c', ship: 'general', title: 'Navire 120 m → écluse → bassin à flot', where: 'Q5, bassin à flot', kind: 'in',
    text: ['Attente poste 2, pont tournant ouvert, feu vert.', 'Entrer sur l\'alignement à 2 nd, 2 remorqueurs.'],
    paths: ['M570,700 L570,500 L575,450 L575,172 L575,130'],
    start: { at: [572, 928], hdg: 0, kn: 8 }, target: { face: 'q5', t: 0.5, name: 'Q5 · bassin à flot' }, tugs: true, lock: true,
    tide: { spring: true, hour: -0.6 }, stages: ['approach', 'channel', 'lock', 'berth'],
  },
  E: {
    id: 'E', color: '#6d4c41', ship: 'tanker', title: 'Pétrolier 190 m → poste 10 (quai Est)', where: 'Quai Est', kind: 'in',
    text: ['Arrivée par le Sud-Est, 2 remorqueurs obligatoires.', 'Accoster bâbord à quai, coupe-feu en place.'],
    paths: ['M594,700 L594,500 C602,470 650,440 700,405 C714,392 722,380 722,360'],
    start: { at: [760, 962], hdg: 308, kn: 8 }, target: { face: 'b10', t: 0.42, name: 'Poste 10 · Quai Est', firewire: true }, tugs: true,
    tide: { spring: true, hour: -1.5 }, stages: ['approach', 'channel', 'berth'],
  },
  F: {
    id: 'F', color: '#558b2f', ship: 'cargo', title: 'Appareillage : cargo du poste 6 → mer', where: 'Poste 6 → mer', kind: 'out',
    text: ['Remorqueurs AV/AR, larguer, sortir bout au Sud;', 'tenir la droite (côté Ouest) dans le chenal.'],
    paths: ['M645,312 C645,350 640,380 626,412 C612,440 585,455 566,478 L556,500 L556,760'],
    start: { berth: 'b6', t: 0.5, hdg: 180 }, tide: { spring: false, hour: 0 }, stages: ['alongside', 'leave', 'outchannel', 'dropPilot'],
  },
  G: {
    id: 'G', color: '#7b1fa2', ship: 'coaster', title: 'Croisement entrant × sortant (chenal)', where: 'Caboteur 150 m → poste 7', kind: 'in',
    text: ['Entre G3-R4 et G1-R2, bâbord sur bâbord, ≤ 6 nd.', 'Passe de pêche : attendre au point d\'attente.'],
    paths: ['M588,700 L588,500 C592,460 690,425 690,380 L690,268'],
    start: { at: [588, 928], hdg: 0, kn: 8 }, target: { face: 'b7', t: 0.5, name: 'Poste 7 · cabotage' }, crossing: true,
    tide: { spring: true, hour: -3 }, stages: ['approach', 'channel', 'berth'],
  },
  H: {
    id: 'H', color: '#455a64', ship: 'cargo', title: 'Évitage assisté par remorqueurs', where: 'Cercle d\'évitage → mer', kind: 'turn',
    text: ['Remorqueur AV tire, AR pousse; pivot à tribord', 'dans le cercle Ø 290 m, ≤ 1 nd (inset en mer).'],
    paths: ['M600,368 L600,422', 'M600,422 C600,450 572,462 566,480 L560,560'],
    start: { at: [600, 395], hdg: 0, kn: 0 }, evitage: { speed: 1 }, tide: { spring: true, hour: 3 }, stages: ['evitage', 'resume'],
  },
};
for (const R of Object.values(ROUTES)) R.chart = R.paths.map((d) => samplePath(d).map(([X, Y]) => px(X, Y)));

// The port-call checklist (CHECK-LIST D'UNE ESCALE), and which items each manoeuvre is judged on.
export const CHECKLIST = [
  'VHF 12 : arrivée annoncée, pilote à bord (zone P).',
  'Alignement 000° : 8 nd jusqu\'aux digues.',
  'Remorqueurs pris dès la passe (navire > 120 m).',
  'Évitage dans le cercle si poste à culer.',
  'Accostage : 0,3 nd maxi au contact du quai.',
  'Amarres : 2 pointes, 2 traversiers, 2 gardes.',
  'Appareillage : prévenir VHF 12, sortant prioritaire.',
  'Quitter le chenal avant la zone de pilotage.',
];
// The check-list items each manoeuvre is judged on (1-based).
function itemsFor(R, ship) {
  if (R.kind === 'out') return [3, 7, 8];
  if (R.kind === 'turn') return [3, 4, 7];
  const it = [1, 2, 5, 6];
  if (ship.L > 120 || R.tugs) it.push(3);
  if (R.evitage) it.push(4);
  return it.sort((a, b) => a - b);
}

export const STAGE_TEXT = {
  approach: (s) => ({ title: 'Approche', task: s.needsPilot ? 'Annoncez l\'arrivée sur VHF 12 (K), puis prenez le pilote en zone P, 8 nd au plus.' : 'Annoncez-vous sur VHF 12 (K) et rejoignez le chenal dragué par le Sud.' }),
  channel: (s) => ({ title: 'Chenal d\'accès', task: `Alignement 000° (feux Iso W 2s), 8 nd au plus jusqu'aux digues. Feux de passe : rouge = entrée interdite.${s.needsTugs && s.tugs !== 'fast' ? ' Prenez les remorqueurs (T) pour la passe.' : ''}` }),
  evitage: (s) => (s.route.kind === 'turn'
    ? { title: 'Évitage assisté', task: 'Remorqueurs AV et AR en place : pivotez de 180° sur tribord dans le cercle, à 1 nd au plus (Q E, A D).' }
    : { title: 'Évitage', task: 'Dans le cercle d\'évitage (Ø 290 m), virez de 180° sur tribord, puis culez vers la rampe.' }),
  pass: () => ({ title: 'Passe du bassin de pêche', task: 'Longez la digue Ouest. Passe de 90 m : croisement interdit, attendez au point d\'attente si elle est occupée.' }),
  lock: (s) => ({ title: 'Écluse', task: s.lock.state === 'open' || s.lock.state === 'out' ? 'Feu vert : entrez dans le sas à 2 nd au plus et stoppez-y.' : s.lock.state === 'filling' ? 'Éclusage : restez stoppé dans le sas.' : 'Attendez au poste 2 : pont tournant ouvert, feu vert.' }),
  berth: (s) => ({ title: 'Accostage', task: s.route.target.ramp ? 'Culez jusqu\'à la rampe, arrière au quai, à 0,3 nd au plus, puis L.' : `${s.route.target.name} : accostez ${s.route.target.side === 'port' ? 'bâbord à quai' : 'le long du quai'}, 0,3 nd au plus au contact, stoppez, puis L.` }),
  alongside: () => ({ title: 'À quai, poste 6', task: 'Prévenez VHF 12 (K), remorqueurs AV/AR en place, puis larguez (L).' }),
  leave: () => ({ title: 'Appareillage', task: 'Sortez bout au Sud par la passe : vous êtes prioritaire.' }),
  outchannel: () => ({ title: 'Chenal', task: 'Tenez la droite (côté Ouest) et quittez le chenal avant la zone de pilotage.' }),
  dropPilot: () => ({ title: 'Débarquement du pilote', task: 'En zone P, 8 nd au plus : la pilotine reprend le pilote.' }),
  resume: (s) => ({ title: 'Reprise de route', task: s.tugs === 'fast' ? 'Larguez les remorqueurs (T), puis sortez par la passe.' : 'Remorqueurs largués : sortez par la passe.' }),
  done: () => ({ title: 'Terminé', task: 'Manœuvre terminée. Fini avec la machine.' }),
  wrecked: () => ({ title: 'Avarie', task: 'Le navire a heurté trop fort. Le pilote est relevé : R pour recommencer.' }),
};

// Violations of the chart's rules: each costs points (and some fail a check-list item).
export const PENALTY = { touch: 2, hard: 10, crash: 25, ground: 15, graze: 5, rule: 10, item: 5, speedPer: 5 };

const mid = (a, b) => ({ x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 });
const msg = (fr, en, s) => (s.fr ? fr : en);

export class HarbourSim {
  // opts: { route: 'A'..'H', spring: bool (springs, else neaps; default the route's), traffic: bool }
  constructor(opts = {}) { this.opts = opts; this.reset(); }

  reset() {
    const o = this.opts ?? {};
    this.fr = !o.mob;
    this.route = o.mob ? null : ROUTES[o.route ?? 'A'];
    this.ship = SHIPS[o.mob ? 'frigate' : this.route.ship];
    this.tel = this.ship.tel;
    this.hullPts = this.ship.pts;
    this.t = 0;
    this.u = 0; this.v = 0; this.r = 0; this.rudder = 0; this.heel = 0;
    this.order = STOP_ORDER;
    this.lines = false;
    this.damage = 0;
    this.contacts = { touch: 0, hard: 0, crash: 0 };
    this.groundings = 0;
    this.aground = false;
    this.contactAt = -Infinity;
    this.inContact = false;
    this.maxInside = 0;
    this.overLimit = 0; // s over the speed limit
    this.warned = false;
    this.berthHold = 0;
    this.result = null;
    this.events = [];
    this.thr = { yaw: 0, sway: 0 }; // what the thrusters (and tugs) are doing (-1 to 1), for the readouts
    this.track = [];
    this.tStart = null; // when the lines went
    this.tFast = null; // when they went on again
    this.acc = 0;
    this.anchor = null; // { x, z, r, weighing }
    this.violations = [];
    this.cool = {};
    this.score = 100;
    this.stream = { x: 0, z: 0, kn: 0 };
    this.x = 0; this.z = 0; this.psi = 0;
    if (!this.route) { this.stage = 'underway'; this.solids = STATIC_SOLIDS; this.traffic = null; return; }
    const R = this.route;
    this.spring = o.spring ?? R.tide.spring;
    this.hour0 = R.tide.hour;
    this.needsPilot = this.ship.L > 80;
    this.needsTugs = this.ship.L > 120 || !!R.tugs;
    this.items = Object.fromEntries(CHECKLIST.map((_, i) => [i + 1, itemsFor(R, this.ship).includes(i + 1) ? 'todo' : 'na']));
    this.stages = R.stages;
    this.stageIdx = 0;
    this.stage = this.stages[0];
    this.vhf = false; // arrival (or departure) announced on VHF 12
    this.pilotAboard = R.kind !== 'in';
    this.tugs = R.kind === 'in' ? 'none' : 'fast';
    this.outbound = false;
    this.evit = { turned: 0, outside: 0, fast: false };
    this.crossing = R.crossing ? { done: false, ok: null, why: '' } : null;
    this.passing = new Map(); // AI vessel → which side of her it was on, along her course
    this.circleStop = 0;
    this.maxQuayHit = 0;
    this.lineN = 0;
    this.moored = mooredFor(R.id);
    this.lock = { state: 'closed', t: 0, bridge: 0, south: 0, north: 0 };
    this.lockSolids = [];
    this.target = this.makeTarget(R);
    this.tugSide = this.target && !this.target.ramp ? -this.target.wallSide : 1;
    // where she starts
    if (R.start.berth) {
      const f = FACES[R.start.berth];
      Object.assign(this, alongside(f, R.start.t, this.ship.B / 2 + FENDER));
      this.psi = rad(R.start.hdg);
      this.lines = true;
      this.tugSide = 1;
    } else {
      Object.assign(this, px(R.start.at[0], R.start.at[1]));
      this.psi = rad(R.start.hdg);
      this.u = R.start.kn * KT;
      this.order = this.tel.findIndex((t) => t.kn === R.start.kn);
      if (this.order < 0) this.order = STOP_ORDER;
    }
    const world = {
      px, gateSideOf: gateSide,
      speedLimitAt: (x, z) => speedZone(x, z).kn,
      inPassage: (x, z) => inPoly(PASSAGE, x, z),
      inHarbour,
      inPassArea: (x, z) => inPoly(PASS_AREA, x, z),
    };
    this.traffic = new Traffic(world, R.id, { enabled: o.traffic !== false });
    if (this.needsPilot && (R.kind === 'in' || R.kind === 'out')) this.traffic.sendPilotOut();
    if (this.tugs === 'fast') this.traffic.attachTugs(this);
    this.side = gateSide(this.x, this.z);
    this.updateSolids();
  }

  // The berth she is to lie at: a quay face with a spot along it, or the ramp.
  makeTarget(R) {
    if (!R.target) return null;
    if (R.target.ramp) {
      const L = this.ship.L;
      return { ramp: true, name: R.target.name, x: RAMP.x + RAMP.n.x * (L / 2 + 1.5), z: RAMP.z + RAMP.n.z * (L / 2 + 1.5), psi: Math.atan2(RAMP.n.z, RAMP.n.x) };
    }
    const f = FACES[R.target.face];
    const c = alongside(f, R.target.t, this.ship.B / 2 + FENDER);
    // the heading she lies on: along the face, either way (the port side to the quay when the chart says so)
    let psi = f.psi;
    const portTo = (p) => (-Math.sin(p) * -f.n.x + Math.cos(p) * -f.n.z) < 0; // her starboard side faces away from the wall
    if (R.target.side === 'port' && !portTo(psi)) psi = wrapPi(psi + Math.PI);
    if (!R.target.side && Math.cos(psi) < 0) psi = wrapPi(psi + Math.PI); // the one nearer north, for the ghost outline
    const wallSide = (-Math.sin(psi) * -f.n.x + Math.cos(psi) * -f.n.z) > 0 ? 1 : -1; // +1: starboard to the wall
    return { ...c, psi, face: f, t: R.target.t, side: R.target.side ?? null, name: R.target.name, wallSide, len: this.ship.L + 14 };
  }

  get kind() { return 'harbour'; }
  get stageText() { return (STAGE_TEXT[this.stage] ?? STAGE_TEXT.done)(this); }
  get speedKn() { return this.u / KT; }
  get ordered() { return this.tel[this.order].kn; }
  get orderName() { return this.tel[this.order].name; }
  get inside() { return inHarbour(this.x, this.z); }
  get zone() { return speedZone(this.x, this.z); }
  get hour() { return this.hour0 + this.t / H; }
  get tide() { return this.route ? tideHeight(this.spring, this.hour) : 3.5; }
  // the depth under her keel (the shallowest of her bow, middle and stern)
  get ukc() { return this.depthUnder() - this.ship.T; }
  get entryLight() { return this.traffic && this.traffic.outboundInPassage(this, 'player') ? 'red' : 'green'; }
  get lockLight() { return this.lock.state === 'open' || this.lock.state === 'out' ? 'green' : 'red'; }
  get lockWindow() { return Math.abs(this.hour) <= 2; }
  say(text, tone = '', sound = null) { this.events.push({ type: 'say', text, tone, sound }); }
  radio(from, text) { this.events.push({ type: 'vhf', from, text }); }
  takeEvents() { const e = this.events; this.events = []; return e; }
  depthAt(x, z) {
    const d = chartDepth(x, z);
    if (BASINS[2] && inPoly(BASINS[2], x, z)) return d + 5.5; // the bassin à flot is kept at high water by the lock
    return d + this.tide;
  }
  depthUnder() {
    const c = Math.cos(this.psi), s = Math.sin(this.psi), h = this.ship.L / 2 - 4;
    return Math.min(this.depthAt(this.x, this.z), this.depthAt(this.x + c * h, this.z + s * h), this.depthAt(this.x - c * h, this.z - s * h));
  }

  telegraph(step) {
    if (this.over) return;
    const o = clamp(this.order + step, 0, this.tel.length - 1);
    if (o === this.order) return;
    this.order = o;
    this.events.push({ type: 'telegraph', order: o });
  }

  // A rule broken: once per `key` and cooldown; it costs points and is listed at the end.
  violate(key, text, item = null, cool = 30) {
    if (this.over) return;
    if (this.t - (this.cool[key] ?? -Infinity) < cool) return;
    this.cool[key] = this.t;
    this.violations.push({ t: this.t, key, text });
    this.score -= PENALTY.rule;
    if (item && this.items[item] === 'todo') this.items[item] = 'fail';
    this.say(text, 'danger', 'warn');
  }
  tick(item, ok = true) { if (this.items && this.items[item] === 'todo') this.items[item] = ok ? 'ok' : 'fail'; }

  // L: let go (alongside at the start) or make fast (alongside her berth, lying still).
  lineKey() {
    if (this.stage === 'alongside') {
      if (!this.vhf) this.violate('vhfOut', 'Appareillage sans avoir prévenu VHF 12', 7);
      else this.tick(7);
      if (this.tugs === 'fast') this.tick(3);
      this.lines = false;
      this.outbound = true;
      this.tStart = this.t;
      this.nextStage();
      this.say('Larguez tout ! Sortez bout au Sud', '', 'lines');
      return;
    }
    if (this.stage === 'berth') {
      const b = this.berthState();
      if (b.ok) this.makeFast();
      else this.say(b.why, 'warn');
      return;
    }
    if (!this.over) this.say(this.stage === 'alongside' ? 'Les amarres sont tournées' : 'Les amarres se tournent seulement à poste', 'warn');
  }

  // T: call the tugs, or let them go.
  tugKey() {
    if (this.over || !this.traffic) return;
    if (this.ship.id === 'trawler') { this.say('Pas de remorquage pour un chalutier', 'warn'); return; }
    if (this.tugs === 'fast') {
      this.tugs = 'released';
      this.traffic.releaseTugs();
      this.say('Remorqueurs largués', '', 'lines');
      return;
    }
    if (this.tugs === 'called') { this.say('Les remorqueurs arrivent', 'warn'); return; }
    this.tugs = 'called';
    this.traffic.callTugs(this);
    this.radio('Remorqueurs', 'Bien reçu, deux remorqueurs font route vers vous depuis le poste 2.');
  }

  // K: VHF channel 12.
  vhfKey() {
    if (this.over || !this.route) return;
    const R = this.route, name = this.ship.name;
    if (R.kind === 'in' && !this.vhf) {
      this.vhf = true;
      this.radio(name, 'Zabana Port, Zabana Port, ici ' + name.toLowerCase() + ', arrivée sur rade, demandons le pilote.');
      const out = this.traffic.vessels.filter((v) => v.outbound && v.L >= 50).length;
      this.radio('Zabana Port', `Bien reçu. ${this.needsPilot ? 'Pilote en zone P. ' : ''}Entrez sur l'alignement 000°, 8 nœuds au plus.${out ? ' Navire sortant dans la passe : attendez le feu vert.' : ''}`);
      return;
    }
    if (R.kind !== 'in' && !this.vhf) {
      this.vhf = true;
      this.radio(name, 'Zabana Port, ici ' + name.toLowerCase() + (R.kind === 'out' ? ', prêt à appareiller du poste 6.' : ', pour évitage et sortie.'));
      this.radio('Zabana Port', 'Bien reçu, vous êtes prioritaire. Tenez la droite dans le chenal.');
      return;
    }
    if (R.lock && this.stage === 'lock') {
      this.radio(name, 'Écluse de Zabana, demandons l\'éclusage pour le bassin à flot.');
      this.radio('Écluse', this.lockWindow ? 'Bien reçu, préparation du sas. Attendez le feu vert.' : 'Négatif : éclusage de PM-2 h à PM+2 h seulement.');
      if (this.lockWindow && this.lock.state === 'closed') this.startLock();
      return;
    }
    const tide = this.tide.toFixed(1).replace('.', ',');
    this.radio('Zabana Port', `Hauteur d'eau ${tide} m, ${this.hour < 0 ? 'flot' : 'jusant'}. Feux de passe ${this.entryLight === 'red' ? 'rouges' : 'verts'}.`);
  }

  // M: let go the anchor, or weigh it.
  anchorKey() {
    if (this.over || !this.route) return;
    if (this.anchor) {
      if (this.anchor.weighing === null) { this.anchor.weighing = this.t; this.say('On vire l\'ancre', ''); }
      return;
    }
    if (Math.abs(this.u) > 2.5 * KT) { this.say('Trop vite pour mouiller : 2,5 nd au plus', 'warn'); return; }
    if (this.inside) { this.violate('anchorPort', 'Mouillage interdit dans le port'); }
    else if (inFairway(this.x, this.z)) this.violate('anchorChannel', 'Mouillage interdit dans le chenal d\'accès');
    else if (nearCable(this.x, this.z)) this.violate('anchorCable', 'Mouillage interdit : câble sous-marin');
    this.anchor = { x: this.x, z: this.z, r: 30 + 3 * this.depthAt(this.x, this.z), weighing: null };
    this.say(inAnchorage(this.x, this.z) ? 'Mouillé en zone de mouillage' : 'Mouillé', inAnchorage(this.x, this.z) ? 'good' : '', 'lines');
  }

  makeFast() {
    this.lines = true;
    this.tFast = this.t;
    this.u = this.v = this.r = 0;
    this.tick(5, this.maxQuayHit <= BERTH_CONTACT);
    this.tick(6); // the lines: two head and stern lines, two breast lines, two springs (harbourDetails.js puts them on in turn)
    if (this.route.target.firewire) this.say('Coupe-feu en place', 'good');
    this.finish('Amarré : 2 pointes, 2 traversiers, 2 gardes. Fini avec la machine');
  }

  finish(text) {
    const b = this.target ? this.berthState() : null;
    this.stage = 'done';
    for (const k of Object.keys(this.items)) if (this.items[k] === 'todo') this.items[k] = 'fail';
    const fails = Object.values(this.items).filter((s) => s === 'fail').length;
    const over = Math.min(20, Math.floor(this.overLimit / PENALTY.speedPer));
    this.score = Math.max(0, Math.round(this.score - fails * PENALTY.item - over));
    const stars = this.score >= 85 ? 3 : this.score >= 60 ? 2 : 1;
    this.result = {
      route: this.route.id, time: this.t - (this.tStart ?? 0), maxInside: this.maxInside, overLimit: this.overLimit, contacts: { ...this.contacts }, damage: this.damage,
      groundings: this.groundings, violations: [...this.violations], items: { ...this.items }, score: this.score, stars,
      along: b?.along ?? 0, gapFwd: b?.gapFwd ?? 0, gapAft: b?.gapAft ?? 0, crossing: this.crossing ? { ...this.crossing } : null,
    };
    this.say(text, 'good', 'done');
  }

  // Where she lies against her berth, and whether the lines could go on now.
  berthState() {
    const B = this.target, c = Math.cos(this.psi), s = Math.sin(this.psi), T = BERTH_TOL, L = this.ship.L, half = this.ship.B / 2;
    const vx = c * this.u - s * this.v, vz = s * this.u + c * this.v;
    let why = null, along, off, gapFwd, gapAft, head, closing;
    if (B.ramp) {
      // stern to the ramp: her stern's distance from it, how far off its middle, her heading
      const sx = this.x - c * L / 2, sz = this.z - s * L / 2;
      const rx = sx - RAMP.x, rz = sz - RAMP.z;
      const gap = rx * RAMP.n.x + rz * RAMP.n.z;
      along = -rx * RAMP.n.z + rz * RAMP.n.x;
      head = Math.abs(wrapPi(this.psi - B.psi));
      closing = -(vx * RAMP.n.x + vz * RAMP.n.z);
      gapFwd = gapAft = gap; off = gap;
      if (Math.hypot(rx, rz) > 60) why = `Pas encore à la rampe : ${Math.round(Math.hypot(rx, rz))} m`;
      else if (head > T.heading) why = `Arrière dans l'axe de la rampe : ${Math.round(deg(head))}°`;
      else if (Math.abs(along) > RAMP.half + 2) why = `Décalé de ${Math.abs(along).toFixed(0)} m sur la rampe`;
      else if (gap > 4) why = `Culez encore : ${gap.toFixed(1)} m de la rampe`;
    } else {
      const f = B.face;
      const rx = this.x - (f.a.x + f.dir.x * f.len * B.t), rz = this.z - (f.a.z + f.dir.z * f.len * B.t);
      along = rx * f.dir.x + rz * f.dir.z; // her centre along the face from the berth's middle
      off = rx * f.n.x + rz * f.n.z; // her centreline's distance from the wall
      const offAt = (ax) => (this.x + c * ax - f.a.x) * f.n.x + (this.z + s * ax - f.a.z) * f.n.z;
      const hd = Math.abs(wrapPi(this.psi - f.psi));
      head = Math.min(hd, Math.PI - hd);
      gapFwd = offAt(L / 2 - L * 0.12) - half; gapAft = offAt(-(L / 2 - L * 0.12)) - half;
      closing = -(vx * f.n.x + vz * f.n.z);
      const wallSide = (-s * -f.n.x + c * -f.n.z) > 0 ? 1 : -1;
      if (Math.abs(along) > T.along + L * 0.05 || off > 80) why = `Pas encore à poste : ${Math.round(Math.hypot(along, off))} m`;
      else if (B.side === 'port' && wallSide > 0) why = 'Bâbord à quai : elle est tribord à quai';
      else if (head > T.heading) why = `Parallèle au quai : ${Math.round(deg(head))}° d'écart`;
      else if (Math.max(gapFwd, gapAft) > T.gap) why = `Plus près : ${Math.max(gapFwd, gapAft).toFixed(1)} m du quai`;
    }
    if (!why && (Math.abs(this.u) > T.speed || Math.abs(this.v) > T.sway || Math.abs(this.r) > T.rate)) why = 'Stoppez d\'abord : elle bouge encore';
    return { ok: !why, why, along, off, head, gapFwd, gapAft, closing, dist: B.ramp ? Math.hypot(along, off) : Math.hypot(along, off - half - FENDER) };
  }

  get over() { return this.stage === 'done' || this.stage === 'wrecked'; }

  advance(dt, input = {}) {
    this.acc += Math.min(dt, 0.25);
    while (this.acc >= DT) { this.acc -= DT; this.step(DT, input); }
  }
  nextStage() {
    this.stageIdx++;
    if (this.stageIdx >= this.stages.length) { this.finish(this.route.kind === 'out' ? 'Pilote débarqué. Bonne route !' : 'Manœuvre terminée'); return; }
    this.stage = this.stages[this.stageIdx];
    this.events.push({ type: 'stage', stage: this.stage });
  }

  step(dt, input) {
    this.t += dt;
    if (this.traffic) this.traffic.step(dt, this);
    if (this.lines) { // fast alongside: she does not move, whatever the engine does
      this.u = this.v = this.r = 0;
      this.rudder += clamp((input.wheel ?? 0) * RUDDER_MAX - this.rudder, -RUDDER_RATE * dt, RUDDER_RATE * dt);
      if (this.route) this.rules(dt);
      return;
    }
    this.hull(dt, input);
    this.ground(dt);
    this.updateSolids();
    this.collide();
    this.rules(dt);
    if (this.track.length === 0 || this.t - this.track[this.track.length - 1].t > 1) {
      this.track.push({ t: this.t, x: this.x, z: this.z });
      if (this.track.length > 1200) this.track.shift();
    }
  }

  hull(dt, input) {
    const S = this.ship;
    const want = this.over ? 0 : (input.wheel ?? 0);
    const goal = want * RUDDER_MAX;
    const rate = want === 0 ? RUDDER_BACK : RUDDER_RATE;
    this.rudder += clamp(goal - this.rudder, -rate * dt, rate * dt);
    const kn = this.over ? 0 : this.tel[this.order].kn;
    const ordered = kn * KT * (1 - TURN_LOSS * Math.abs(this.rudder) / RUDDER_MAX);
    const dv = ordered - this.u;
    // Ahead or astern the screw drives her toward the ordered speed; eased (a lower order ahead, or stop) she coasts down on her drag.
    const coasting = dv * Math.sign(this.u) < 0 && kn * Math.sign(this.u) >= 0 && kn * this.u >= 0;
    this.u += (coasting ? dv / S.coastT : clamp(dv / S.speedT, -(kn < 0 ? S.accelAst : S.accel), S.accel)) * dt;
    // The turn: the rudder's (by the water past it), the thrusters' (at low speed) and the tugs' (up to 6 kn), on the hull's time.
    const f = thrusterFactor(this.u, S.thrFade), g = this.tugs === 'fast' ? tugFactor(this.u) : 0;
    const iy = this.over ? 0 : clamp(input.turn ?? 0, -1, 1), is = this.over ? 0 : clamp(input.slide ?? 0, -1, 1);
    const yaw = rad(S.thrYaw) * f + TUGS.yaw * g, sway = S.thrSway * f + TUGS.sway * g;
    this.thr.yaw = iy * Math.min(1, f + g); this.thr.sway = is * Math.min(1, f + g);
    const rRudder = (this.u / S.turnR) * (this.rudder / RUDDER_MAX) * (this.u < 0 ? 0.5 : 1);
    this.r += ((rRudder + yaw * iy - this.r) / S.turnT) * dt;
    this.v += ((sway * is - this.v) / SWAY_T) * dt;
    if (this.anchor) this.anchored(dt);
    this.psi = wrapPi(this.psi + this.r * dt);
    const c = Math.cos(this.psi), s = Math.sin(this.psi);
    this.stream = this.route ? tidalStream(this.spring, this.hour, this.x, this.z) : { x: 0, z: 0, kn: 0 };
    this.x += (c * this.u - s * this.v + this.stream.x) * dt;
    this.z += (s * this.u + c * this.v + this.stream.z) * dt;
    this.heel += ((-HEEL * this.r * this.u - this.heel) / 3) * dt;
  }

  // At anchor: the cable holds her within its scope and her way dies; weighing takes 20 s.
  anchored(dt) {
    const A = this.anchor;
    if (A.weighing !== null && this.t - A.weighing > 20) { this.anchor = null; this.say('Ancre haute et claire', 'good'); return; }
    const k = Math.exp(-dt / 5);
    this.u *= k; this.v *= k; this.r *= Math.exp(-dt / 8);
    const d = Math.hypot(this.x - A.x, this.z - A.z);
    if (d > A.r) { const p = (d - A.r) * 0.02 * dt; this.x -= ((this.x - A.x) / d) * p; this.z -= ((this.z - A.z) / d) * p; }
  }

  // The sea bed: with less water than her draught under her, she is aground (slowed hard, damaged if she hit it fast).
  ground(dt) {
    if (!this.route) return;
    const ukc = this.ukc;
    if (ukc < 0) {
      const k = Math.exp(-dt * 1.4);
      this.u *= k; this.v *= k; this.r *= k;
      if (!this.aground) {
        this.aground = true;
        this.groundings++;
        const kn = Math.abs(this.u) / KT;
        if (kn > 2) { this.damage += 8 + kn * 3; this.score -= PENALTY.ground; this.say(`Échouée à ${kn.toFixed(1)} nd : ${(-ukc).toFixed(1)} m de trop`, 'danger', 'hard'); }
        else { this.score -= PENALTY.graze; this.say('Elle touche le fond : reculez vers l\'eau profonde', 'danger', 'hard'); }
        this.events.push({ type: 'contact', hit: 0.4 });
        if (this.damage >= 100) this.wreck();
      }
    } else if (ukc > 0.3) this.aground = false;
  }

  // The solids of the moment: the fixed port, the ships alongside, the lock's closed gates and bridge, and the traffic.
  updateSolids() {
    if (!this.route) { this.solids = STATIC_SOLIDS; return; }
    const L = this.lock, list = [...STATIC_SOLIDS, ...this.moored];
    if (L.south < 1) list.push(toPoly(rect(568, 230.5, 582, 233.5)));
    if (L.north < 1) list.push(toPoly(rect(568, 170.5, 582, 173.5)));
    if (L.bridge < 1) list.push(toPoly(rect(568, 219, 582, 225)));
    for (const v of this.traffic.solids()) {
      const m = { x: v.x, z: v.z, psi: v.psi, len: v.L, beam: v.B };
      const pts = boxCorners(m);
      list.push({ pts, kinds: pts.map(() => 'q'), box: bbox(pts), vessel: v });
    }
    this.solids = list;
  }

  // Push her out of anything she has run into, take the closing speed off, and score the contact.
  collide() {
    const c = Math.cos(this.psi), s = Math.sin(this.psi);
    let depth = 0, nx = 0, nz = 0, ox = 0, oz = 0, hitV = null;
    for (const [a, b] of this.hullPts) {
      const wx = this.x + a * c - b * s, wz = this.z + a * s + b * c;
      for (const so of this.solids) {
        if (!inPoly(so, wx, wz)) continue;
        const e = nearestEdge(so, wx, wz); // inside: the normal points inward, so flip it
        if (e.d > depth) { depth = e.d; nx = -e.nx; nz = -e.nz; ox = a * c - b * s; oz = a * s + b * c; hitV = so.vessel ?? null; }
      }
    }
    if (depth <= 0) { if (this.t - this.contactAt > 0.6) this.inContact = false; return; }
    this.x += nx * (depth + 0.01);
    this.z += nz * (depth + 0.01);
    // her velocity at the point of contact (relative to the other ship when it moves)
    let vx = c * this.u - s * this.v, vz = s * this.u + c * this.v;
    const px0 = vx - this.r * oz - (hitV?.vx ?? 0), pz0 = vz + this.r * ox - (hitV?.vz ?? 0);
    const vn = px0 * nx + pz0 * nz;
    if (vn < 0) {
      vx -= nx * vn * 1.05; vz -= nz * vn * 1.05;
      this.r *= 0.7;
      this.u = vx * c + vz * s;
      this.v = -vx * s + vz * c;
      this.u *= 0.995; // a little friction along the wall
      const hit = -vn;
      if (this.stage === 'berth' && !hitV) this.maxQuayHit = Math.max(this.maxQuayHit, hit);
      if (hit > TOUCH && (!this.inContact || hit > HARD)) this.contact(hit, hitV);
      if (hitV && hit > TOUCH) hitV.stoppedFor = 20;
    }
    this.contactAt = this.t;
    this.inContact = true;
  }

  contact(hit, vessel = null) {
    if (this.over) return;
    const what = vessel ? msg(`Abordage avec le ${vessel.name.toLowerCase()}`, 'Collision with a ship', this) : null;
    const k = vessel ? clamp(vessel.L / this.ship.L, 0.15, 1) : 1; // a small craft dents her less than a quay or a ship her size
    if (hit >= CRASH) {
      this.contacts.crash++;
      this.damage += (hit - HARD) * DAMAGE_PER * 1.5 * k;
      this.score -= PENALTY.crash;
      this.say(what ? `${what} à ${(hit / KT).toFixed(1)} nd` : msg(`Collision à ${(hit / KT).toFixed(1)} nd : coque endommagée`, `Collision at ${(hit / KT).toFixed(1)} kn: damage to the hull`, this), 'danger', 'crash');
    } else if (hit >= HARD) {
      this.contacts.hard++;
      this.damage += ((hit - HARD) * DAMAGE_PER + 4) * k;
      this.score -= PENALTY.hard;
      this.say(what ? `${what} à ${(hit / KT).toFixed(1)} nd` : msg(`Contact dur à ${(hit / KT).toFixed(1)} nd`, `Hard contact at ${(hit / KT).toFixed(1)} kn`, this), 'danger', 'hard');
    } else {
      this.contacts.touch++;
      this.score -= PENALTY.touch;
      this.events.push({ type: 'touch', hit });
      if (vessel) this.say(what, 'warn');
    }
    this.events.push({ type: 'contact', hit });
    if (this.damage >= 100) this.wreck();
  }
  wreck() {
    this.damage = 100;
    this.stage = 'wrecked';
    this.order = STOP_ORDER;
    if (this.route) this.result = { route: this.route.id, wrecked: true, contacts: { ...this.contacts }, groundings: this.groundings, violations: [...this.violations], score: 0, stars: 0 };
    this.say(msg('Coque percée : le pilote est relevé', 'She is holed. The pilot is relieved', this), 'danger', 'crash');
  }

  // The rules of the port, and the stages of the manoeuvre.
  rules(dt) {
    if (this.over) return;
    const R = this.route;
    const kn = Math.abs(this.u) / KT;
    // speed limits
    const z = this.zone;
    if (z.kn < Infinity && !this.lines) {
      if (this.inside) this.maxInside = Math.max(this.maxInside, kn);
      if (kn > z.kn + 0.2) {
        this.overLimit += dt;
        if (!this.warned) { this.warned = true; this.say(`Vitesse limitée à ${z.kn} nd (${z.name})`, 'warn', 'warn'); }
        if (z.name.startsWith('chenal')) this.tick(2, false);
      } else if (kn < z.kn - 1) this.warned = false;
    }
    if (this.lines) { if (this.stage === 'alongside') this.stageRules(dt, kn); return; }
    // the entrance line
    const side = gateSide(this.x, this.z);
    const ex = GATE.b.x - GATE.a.x, ez = GATE.b.z - GATE.a.z;
    const tg = ((this.x - GATE.a.x) * ex + (this.z - GATE.a.z) * ez) / (ex * ex + ez * ez);
    const crossed = Math.sign(side) !== Math.sign(this.side) && tg > -0.3 && tg < 1.3;
    this.crossIn = crossed && side > 0; this.crossOut = crossed && side < 0;
    this.side = side;
    if (this.crossIn && this.entryLight === 'red') this.violate('redEntry', 'Entrée sur feux de passe rouges : priorité au navire sortant');
    // the pilot (over 80 m), the tugs (over 120 m)
    const [X, Y] = toChart(this.x, this.z);
    if (R.kind === 'in' && this.needsPilot && !this.pilotAboard && Y < 655 && X > 520 && X < 630) this.violate('noPilot', 'Pilote obligatoire au-delà de 80 m : prenez-le en zone P', 1, 600);
    if (R.kind === 'in' && Y < 655 && X > 520 && X < 630 && !this.vhf) this.violate('noVhf', 'Arrivée non annoncée sur VHF 12', 1, 600);
    if (this.needsTugs && R.kind === 'in' && this.tugs !== 'fast' && side > 150 && this.stage !== 'done') this.violate('noTugs', `Remorquage obligatoire au-delà de 120 m${R.tugs ? ' (2 remorqueurs pour cette manœuvre)' : ''}`, 3, 120);
    if (this.tugs === 'fast' && kn > TUGS.part) { this.violate('towline', 'Remorque cassée : trop vite avec les remorqueurs'); this.tugs = 'released'; this.traffic.releaseTugs(); }
    if (this.tugs === 'called' && this.traffic.tugsReady) {
      this.tugs = 'fast';
      this.traffic.attachTugs(this);
      this.say('Remorqueurs pris : AV tire, AR pousse', 'good', 'lines');
      if (side < 120) this.tick(3);
    }
    // the pilot boat
    const pb = this.traffic.get('pilot');
    const inP = Math.hypot(this.x - PILOT_ZONE.x, this.z - PILOT_ZONE.z) < PILOT_ZONE.r * 1.6;
    if (pb && this.needsPilot) {
      if (R.kind === 'in' && !this.pilotAboard && inP && kn <= 8.2 && this.vhf && pb.mode === 'loiter') this.traffic.pilotTo();
      if (R.kind === 'in' && !this.pilotAboard && inP && !this.vhf && !this.cool.hintVhf) { this.cool.hintVhf = this.t; this.say('La pilotine attend votre appel VHF 12 (K)', 'warn'); }
      if (pb.done) {
        pb.done = false;
        if (R.kind === 'in') { this.pilotAboard = true; this.say('Pilote à bord', 'good', 'stage'); }
        else { this.pilotAboard = false; this.say('Pilote débarqué', 'good', 'stage'); }
      }
    }
    // the turning circle: no stopping there
    const inCircle = Math.hypot(this.x - TURN_CIRCLE.x, this.z - TURN_CIRCLE.z) < TURN_CIRCLE.r;
    this.circleStop = inCircle && kn < 0.3 && Math.abs(this.r) < rad(0.1) ? this.circleStop + dt : 0;
    if (this.circleStop > 60) { this.violate('circle', 'Ne pas stationner dans le cercle d\'évitage', null, 120); this.circleStop = 0; }
    // the fishing pass: no crossing
    if (inPoly(PASS_AREA, this.x, this.z) && this.traffic.vessels.some((v) => this.traffic.visible(v) && v.state === 'run' && inPoly(PASS_AREA, v.x, v.z))) this.violate('pass', 'Croisement interdit dans la passe du bassin de pêche');
    // an outbound ship that had to stop for her
    for (const v of this.traffic.vessels) if (v.outbound && v.L >= 50 && v.blockedBy === 'player' && R.kind === 'in' && inPoly(PASSAGE, v.x, v.z)) this.violate('priority', 'Priorité aux navires sortants : dégagez sa route', null, 60);
    this.passings(kn);
    if (R.lock) this.lockRules(dt, kn);
    this.stageRules(dt, kn);
  }

  // Meeting another ship on a near-reciprocal course: where (the crossing zone), which sides (port to port), how fast (6 kn).
  passings(kn) {
    const c = Math.cos(this.psi), s = Math.sin(this.psi);
    for (const v of this.traffic.vessels) {
      if (!this.traffic.visible(v) || v.L < 50 || v.state !== 'run' || Math.abs(v.u) < 0.5) { this.passing.delete(v); continue; }
      const dx = v.x - this.x, dz = v.z - this.z, ax = dx * c + dz * s, az = -dx * s + dz * c;
      const opposite = Math.cos(v.psi - this.psi) < -0.6;
      if (!opposite || Math.abs(az) > 300) { this.passing.delete(v); continue; }
      const was = this.passing.get(v);
      this.passing.set(v, ax);
      if (was === undefined || Math.sign(was) === Math.sign(ax) || Math.abs(was) > 200) continue;
      // abeam now
      const inChannel = inPoly(CHANNEL, this.x, this.z) || inPoly(CHANNEL, v.x, v.z);
      if (!inChannel && !this.crossing) continue;
      const inZone = inPoly(CROSSING, this.x, this.z) || inPoly(CROSSING, v.x, v.z);
      if (kn <= 1 && !this.crossing) continue; // stopped, waiting for her to pass: that is what the rule asks
      const why = az > 0 ? 'tribord sur tribord (bâbord sur bâbord exigé)' : !inZone ? 'hors de la zone de croisement (entre G3-R4 et G1-R2)' : kn > 6.2 ? `à ${kn.toFixed(1)} nd (6 nd au plus)` : '';
      if (this.crossing && !this.crossing.done) Object.assign(this.crossing, { done: true, ok: !why, why });
      if (why) this.violate('cross', `Croisement ${why}`);
      else this.say(`Croisement bâbord sur bâbord avec le ${v.name.toLowerCase()}`, 'good');
    }
  }

  // The lock (route D): it opens inside the tide window when she comes near (or asks on VHF 12), takes her up into the bassin à flot.
  startLock() { this.lock.state = 'opening'; this.lock.t = this.t; this.radio('Écluse', 'Préparation du sas : pont tournant en ouverture.'); }
  lockRules(dt, kn) {
    const L = this.lock, R = this.route;
    const toGate = Math.hypot(this.x - LOCK.south.x, this.z - LOCK.south.z);
    const go = (k, v, rate) => { L[k] = clamp(L[k] + Math.sign(v - L[k]) * rate * dt, 0, 1); return L[k] === v; };
    const c = Math.cos(this.psi), s = Math.sin(this.psi);
    const ends = [this.ship.L / 2, -this.ship.L / 2].map((a) => ({ x: this.x + c * a, z: this.z + s * a }));
    const inChamber = ends.every((p) => inPoly(LOCK.chamber, p.x, p.z));
    if (L.state === 'closed' && this.stage === 'lock' && toGate < 330) {
      if (this.lockWindow) this.startLock();
      else if (!this.cool.lockShut) { this.cool.lockShut = this.t; this.say('Écluse fermée : éclusage de PM-2 h à PM+2 h', 'warn'); }
    }
    if (L.state === 'opening') { // the bridge swings (25 s), then the sea gates open (20 s)
      if (go('bridge', 1, 1 / 25) && go('south', 1, 1 / 20)) { L.state = 'open'; this.say('Feu vert : entrez dans le sas', 'good', 'stage'); }
    } else if (L.state === 'open' && inChamber && kn < 0.4) {
      L.state = 'filling'; L.t = this.t; this.say('Dans le sas : éclusage', '', 'stage');
    } else if (L.state === 'filling') {
      if (go('south', 0, 1 / 20) && this.t - L.t > 60 && go('north', 1, 1 / 20)) { L.state = 'out'; this.say('Feu vert : sortez vers le bassin à flot', 'good', 'stage'); }
    } else if (L.state === 'out' && ends.every((p) => toChart(p.x, p.z)[1] < 168)) {
      L.state = 'done';
    } else if (L.state === 'done') { go('north', 0, 1 / 20); go('bridge', 0, 1 / 25); }
    // the stop line: red light, no further
    const bow = ends[0];
    if (this.lockLight === 'red' && L.state !== 'filling' && L.state !== 'done' && bow.x > LOCK.stopLine && toChart(bow.x, bow.z)[1] > 172 && Math.abs(toChart(bow.x, bow.z)[0] - 575) < 20) this.violate('lockRed', 'Feu rouge de l\'écluse : n\'avancez pas', null, 60);
    void R;
  }

  stageRules(dt, kn) {
    const R = this.route, st = this.stage;
    const [X, Y] = toChart(this.x, this.z);
    if (st === 'approach') {
      if (this.needsPilot ? this.pilotAboard : Y < 700) { if (this.needsPilot) this.tick(1, this.vhf); this.nextStage(); }
    } else if (st === 'channel') {
      if (this.pilotAboard || !this.needsPilot) this.tick(1, this.vhf);
      if (this.crossIn) {
        this.tick(2, this.overLimit < 5);
        if (this.tugs === 'fast') this.tick(3);
        this.nextStage();
        this.say(R.lock ? 'Dans l\'avant-port : attendez le feu vert de l\'écluse au poste 2' : R.evitage ? 'Dans l\'avant-port : évitage dans le cercle' : R.id === 'C' ? 'Dans l\'avant-port : longez la digue Ouest jusqu\'à la passe' : 'Dans l\'avant-port : vers le poste', 'good', 'stage');
      }
    } else if (st === 'evitage') {
      const inCircle = Math.hypot(this.x - TURN_CIRCLE.x, this.z - TURN_CIRCLE.z) < TURN_CIRCLE.r;
      const dpsi = wrapPi(this.psi - (this.prevPsi ?? this.psi));
      if (Math.abs(this.r) > rad(0.15) && inCircle) this.evit.turned += dpsi;
      // once the turn is really under way (15° of it), turning outside the circle or too fast spoils it
      if (Math.abs(this.evit.turned) > rad(15) && Math.abs(this.r) > rad(0.4)) {
        if (!inCircle) this.evit.outside += dt;
        if (kn > R.evitage.speed + 0.3) this.evit.fast = true;
      }
      const done = R.kind === 'turn' ? this.evit.turned > rad(170) : this.evit.turned > rad(150) && Math.abs(wrapPi(this.psi - Math.PI)) < rad(20);
      if (done) {
        const ok = this.evit.outside < 10 && !this.evit.fast;
        this.tick(4, ok);
        this.say(ok ? 'Évitage réussi dans le cercle' : `Évitage fait, mais ${this.evit.fast ? `à plus de ${R.evitage.speed} nd` : 'hors du cercle'}`, ok ? 'good' : 'warn', 'stage');
        if (R.kind === 'turn' && !this.vhf) this.violate('vhfOut', 'Reprise de route sans avoir prévenu VHF 12', 7, 600);
        else if (R.kind === 'turn') this.tick(7);
        if (R.kind === 'turn') this.outbound = true;
        this.nextStage();
      }
    } else if (st === 'pass') {
      if (X < 438) this.nextStage();
    } else if (st === 'lock') {
      if (Y < 160 && this.lock.state !== 'closed') this.nextStage();
    } else if (st === 'berth') {
      const b = this.berthState();
      this.berthHold = b.ok ? this.berthHold + dt : 0;
      if (this.berthHold >= BERTH_TOL.hold) this.makeFast();
    } else if (st === 'alongside') {
      // waiting for L
    } else if (st === 'leave') {
      if (this.crossOut) { this.nextStage(); this.say('Hors des digues : tenez la droite dans le chenal', 'good', 'stage'); }
    } else if (st === 'outchannel') {
      if (!inPoly(CHANNEL, this.x, this.z) && Y > 600) { this.outbound = false; this.nextStage(); this.say('Hors du chenal : vers la zone P pour débarquer le pilote', 'good', 'stage'); }
    } else if (st === 'dropPilot') {
      const inP = Math.hypot(this.x - PILOT_ZONE.x, this.z - PILOT_ZONE.z) < PILOT_ZONE.r * 1.6;
      const pb = this.traffic.get('pilot');
      if (inP && kn <= 8.2 && this.pilotAboard && pb && pb.mode === 'loiter') this.traffic.pilotTo();
      if (!this.pilotAboard) { this.tick(8, kn <= 8.2); this.nextStage(); }
    } else if (st === 'resume') {
      if (this.crossOut && this.tugs === 'fast') this.say('Larguez les remorqueurs avant de sortir (T)', 'warn');
      if (this.tugs !== 'fast' && this.side < -20) { this.tick(3); this.nextStage(); }
    }
    this.prevPsi = this.psi;
  }

  // The next mark to steer for, for the readouts and the map.
  get mark() {
    if (!this.route) return null;
    const st = this.stage;
    if (st === 'approach') return this.needsPilot ? { x: PILOT_ZONE.x, z: PILOT_ZONE.z, name: 'Zone P (pilote)' } : { ...px(575, 655), name: 'Entrée du chenal' };
    if (st === 'channel' || st === 'leave' || st === 'resume') return { ...mid(GATE.a, GATE.b), name: 'Passe (jetées)' };
    if (st === 'evitage') return { x: TURN_CIRCLE.x, z: TURN_CIRCLE.z, name: 'Cercle d\'évitage' };
    if (st === 'pass') return { ...px(455, 303), name: 'Passe du bassin de pêche' };
    if (st === 'lock') return { ...px(575, 236), name: 'Écluse' };
    if (st === 'berth') return { x: this.target.x, z: this.target.z, name: this.target.name };
    if (st === 'outchannel') return { ...px(556, 690), name: 'Sortie du chenal' };
    if (st === 'dropPilot') return { x: PILOT_ZONE.x, z: PILOT_ZONE.z, name: 'Zone P (pilote)' };
    return null;
  }
}

// --- The man overboard drill (mission `mob`) -------------------------------------------------------------------------------------
// She is at sea in the Baie de Zabana at 10 knots when someone goes over the side. The drill, as a bridge watchkeeper is taught it:
//   1. at once, the rudder hard over to the side he fell (the stern, and the screws, swing away from him);
//   2. the Williamson turn: hold it until she is 60 degrees off the original course, then hard over the other way, until she is
//      steady on the reciprocal course: she comes back down her own wake, to where he went in;
//   3. slow down early, and stop with him abeam, close to her side but clear of it, and hold her there while he is recovered.
// He drifts with the wind and sea (`MOB_DRIFT`), the lifebuoy with its smoke float a little faster. Running him down, or drawing him
// into the screws while they turn, ends the drill. Any way of getting back counts; the Williamson turn is scored.
// Her waterline half-beam at x metres from her middle (the outline of HULL_PTS, straight between its points).
export function waterlineHalf(x) {
  const side = HULL_OUTLINE.slice(0, HULL_OUTLINE.findIndex(([, b], i) => i > 0 && b === 0) + 1); // the starboard half, bow to stern
  if (x > side[0][0] || x < side[side.length - 1][0]) return -1;
  for (let i = 1; i < side.length; i++) {
    const [x0, z0] = side[i - 1], [x1, z1] = side[i];
    if (x <= x0 && x >= x1) return x0 === x1 ? Math.max(z0, z1) : z0 + ((z1 - z0) * (x - x0)) / (x1 - x0);
  }
  return -1;
}
export const MOB_START = { ...px(700, 1160), psi: rad(25), kn: 10 }; // out in the bay, 2 km south of the coast
export const MOB_DRIFT = { x: -0.05, z: 0.11 }; // m/s: the casualty, set to the south-east
export const BUOY_DRIFT = { x: -0.08, z: 0.17 }; // m/s: the lifebuoy and smoke float, with more windage
export const MOB_ZONE = { aft: -28, fwd: 16, near: HALF_BEAM + 2, far: HALF_BEAM + 20, speed: 1.0 * KT, hold: 5 };
export const MOB_STAGES = {
  underway: { title: 'On passage', task: 'Steady on 025 at 10 knots in the Baie de Zabana. Keep a good lookout.' },
  mob: { title: 'Man overboard!', task: 'Rudder hard over toward the side he fell. Then the Williamson turn: at 60° off, hard over the other way, onto the reciprocal course.' },
  recover: { title: 'Recovering him', task: 'Hold her there, stopped, with him abeam: the crew have a line on him.' },
  done: { title: 'Casualty recovered', task: 'He is aboard and in the sick bay. Well handled.' },
  wrecked: { title: 'Holed', task: 'She hit too hard to go on: R to try again.' },
  lost: { title: 'Casualty lost', task: 'He went under her. R to try again.' },
};
export const MOB_STEPS = ['underway', 'mob', 'recover'];

export class MobSim extends HarbourSim {
  constructor(opts = {}) { super({ ...opts, mob: true }); }

  reset() {
    super.reset();
    const o = this.opts ?? {};
    this.x = MOB_START.x; this.z = MOB_START.z; this.psi = MOB_START.psi;
    this.lines = false;
    this.stage = 'underway';
    this.order = TELEGRAPH.findIndex((x) => x.kn === MOB_START.kn);
    this.u = MOB_START.kn * KT;
    this.alarmAt = o.alarmAt ?? 10 + Math.random() * 15;
    this.side = o.side ?? (Math.random() < 0.5 ? 1 : -1); // +1 he fell from the starboard side
    this.casualty = null; // { x, z, t0 } once he is in the water
    this.tAlarm = null;
    this.h0 = null; // her heading when he went
    this.wt = { phase: 0, hard: false, offAt: null, maxDev: 0, reversedAt: null, recipAt: null, firstRudder: null, immediate: false };
    this.recoverHold = 0;
    this.closest = Infinity;
  }

  get kind() { return 'mob'; }
  get over() { return this.stage === 'done' || this.stage === 'wrecked' || this.stage === 'lost'; }
  get stageText() { return MOB_STAGES[this.stage]; }
  get tide() { return 3.5; }
  // Where he is, and the lifebuoy, now.
  casualtyPos(t = this.t) {
    const c = this.casualty;
    if (!c) return null;
    const dt = t - c.t0;
    return { x: c.x + MOB_DRIFT.x * dt, z: c.z + MOB_DRIFT.z * dt };
  }
  buoyPos(t = this.t) {
    const c = this.casualty;
    if (!c || t < c.t0 + 2) return null; // thrown from the bridge wing two seconds after the shout
    const dt = t - c.t0 - 2;
    return { x: c.bx + BUOY_DRIFT.x * dt, z: c.bz + BUOY_DRIFT.z * dt };
  }
  // Him in her own frame: ahead (+) of her middle, and out from her centreline (+ starboard).
  rel(p = this.casualtyPos()) {
    if (!p) return null;
    const c = Math.cos(this.psi), s = Math.sin(this.psi), dx = p.x - this.x, dz = p.z - this.z;
    return { ax: dx * c + dz * s, az: -dx * s + dz * c, d: Math.hypot(dx, dz) };
  }
  // How far she has come round from her course when he went, toward the side he fell (degrees).
  get deviation() { return this.h0 === null ? 0 : deg(wrapPi(this.psi - this.h0)) * this.side; }
  get mark() { const p = this.casualtyPos(); return p ? { ...p, name: 'Casualty' } : null; }

  lineKey() { if (!this.over) this.say(this.casualty ? 'No lines to handle: get back to him' : 'No lines at sea', 'warn'); }
  tugKey() {}
  vhfKey() {}
  anchorKey() {}

  rules(dt) {
    if (this.over) return;
    if (this.stage === 'underway') {
      if (this.t < this.alarmAt) return;
      const c = Math.cos(this.psi), s = Math.sin(this.psi), ax = -6, az = this.side * (HALF_BEAM + 2); // over the side abaft the bridge
      this.casualty = { x: this.x + ax * c - az * s, z: this.z + ax * s + az * c, t0: this.t };
      const bz = this.side * (HALF_BEAM + 7); // where the lifebuoy lands, a little out from him
      this.casualty.bx = this.x + 8 * c - bz * s - this.u * 2 * c; this.casualty.bz = this.z + 8 * s + bz * c - this.u * 2 * s;
      this.tAlarm = this.t;
      this.h0 = this.psi;
      this.stage = 'mob';
      this.events.push({ type: 'alarm', side: this.side });
      this.say(`Man overboard, ${this.side > 0 ? 'starboard' : 'port'} side!`, 'danger', 'alarm');
      return;
    }
    const tt = this.t - this.tAlarm;
    // the first rudder order after the shout: toward his side is right (it swings the stern and the screws away from him)
    const rFrac = this.rudder / RUDDER_MAX;
    if (this.wt.firstRudder === null && Math.abs(rFrac) > 0.4) {
      this.wt.firstRudder = Math.sign(rFrac) === this.side ? 'right' : 'wrong';
      this.wt.immediate = this.wt.firstRudder === 'right' && tt < 6;
      if (this.wt.firstRudder === 'wrong') this.say('Wrong way: the stern swings toward him', 'danger', 'warn');
    }
    // the Williamson turn, followed as she goes round
    const dev = this.deviation;
    if (this.wt.phase === 0) {
      this.wt.maxDev = Math.max(this.wt.maxDev, dev);
      // the reversal is when the wheel comes off hard over toward him (the rudder then swings across on its own)
      // (the angle is taken when the wheel comes off hard over; it counts once the rudder is really over to the other side)
      // (a rudder that rests amidships for more than two seconds was eased, not reversed: the reversal is taken again when it moves on)
      const rs = rFrac * this.side;
      if (rs > 0.9) { this.wt.hard = true; this.wt.offAt = null; }
      this.wt.mid = Math.abs(rs) < 0.1 ? (this.wt.mid ?? 0) + dt : 0;
      if (this.wt.mid > 2) this.wt.offAt = null;
      else if (this.wt.hard && this.wt.offAt === null && rs < 0.8 && (rs > 0.1 || rs < -0.1)) this.wt.offAt = dev;
      if (this.wt.hard && dev > 20 && rFrac * this.side < -0.3) {
        const at = this.wt.offAt ?? dev;
        this.wt.phase = 1; this.wt.reversedAt = at;
        this.say(`Rudder reversed at ${Math.round(at)}° off`, at >= 50 && at <= 75 ? 'good' : 'warn');
      }
    } else if (this.wt.phase === 1 && Math.abs(deg(wrapPi(this.psi - this.h0 - Math.PI))) < 12) {
      this.wt.phase = 2; this.wt.recipAt = tt;
      this.say('On the reciprocal course: back down the wake', 'good', 'stage');
    }
    // him and her
    const r = this.rel();
    this.closest = Math.min(this.closest, r.d);
    const screws = r.ax < -48 && r.ax > -68 && Math.abs(r.az) < 6 && this.ordered !== 0;
    // she runs him down if her hull goes over him (he is inside her waterline), at any speed through the water
    const under = Math.abs(r.az) < waterlineHalf(r.ax) && Math.hypot(this.u, this.v) > 0.3;
    if (screws || under) {
      this.stage = 'lost';
      this.order = STOP_ORDER;
      this.result = { kind: 'mob', lost: screws ? 'screws' : 'struck' };
      this.say(screws ? 'He was drawn into the screws' : 'She ran him down', 'danger', 'crash');
      return;
    }
    const Z = MOB_ZONE;
    const inZone = r.ax > Z.aft && r.ax < Z.fwd && Math.abs(r.az) > Z.near && Math.abs(r.az) < Z.far && Math.hypot(this.u, this.v) < Z.speed && Math.abs(this.r) < rad(1);
    if (inZone) {
      if (this.stage === 'mob') { this.stage = 'recover'; this.say('Line on him: hold her there', 'good', 'stage'); }
      this.recoverHold += dt;
      if (this.recoverHold >= Z.hold) this.recovered(tt);
    } else if (this.stage === 'recover') {
      this.stage = 'mob'; this.recoverHold = 0;
      this.say('She has moved off him: bring her back', 'warn');
    }
  }

  recovered(tt) {
    this.stage = 'done';
    this.order = STOP_ORDER;
    const w = this.wt;
    const williamson = w.reversedAt !== null && w.reversedAt >= 50 && w.reversedAt <= 75 && w.recipAt !== null;
    this.result = {
      kind: 'mob', time: tt, immediate: w.immediate, firstRudder: w.firstRudder, reversedAt: w.reversedAt, recip: w.recipAt !== null, williamson,
      contacts: { ...this.contacts }, damage: this.damage, stars: 1 + (tt < 300 ? 1 : 0) + (williamson && w.immediate ? 1 : 0),
    };
    this.tFast = null;
    this.say('Casualty recovered', 'good', 'done');
  }
}

export const compass = (r) => ((deg(r) % 360) + 360) % 360;

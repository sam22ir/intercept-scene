// "Harbour pilot": you take the frigate out of the naval port of Jijel (Algeria) and bring her back in. Like the
// manual flight and Solo Air Defense this is a small real-time simulation stepped at a fixed rate, pure and
// import-free so Node can test it (test/harbour.test.mjs).
//
// The port
//   Traced from Google Earth images of Jijel (31/03/2025, the north-up one at 1,107 m per 1,000 px: `IMG`), so
//   every outline below is written in that image's pixels and converted once (`px`). The north breakwater runs
//   east from the root by the town and turns south (the east arm); the south mole runs north-east to meet it,
//   leaving the entrance, about 190 m wide, facing east-south-east. Inside: the main basin along the north
//   breakwater, the central pier, the south basin, the finger pier and the old quays to the west. South of the
//   south mole the marina breakwater runs south-south-east to the fishing harbour, then the beach.
//
// Coordinates are the scene's: metres, x north, z east (y up); a heading `psi` is measured from +x toward +z
// (clockwise from north, as a compass). In the ship's frame her bow is +x and her starboard side +z.
//
// The ship
//   ← →     the wheel: held keys put the rudder over, let go and it comes back amidships.
//   ↑ ↓     the engine telegraph, one step at a time, from full astern to full ahead (`TELEGRAPH`).
//   Q E     bow and stern thrusters against each other: she turns on the spot (only at low speed).
//   A D     both thrusters together: she moves sideways, to port or starboard (only at low speed).
//   L       the lines: let go at the start; make fast once she lies still alongside her berth.
//   She is heavy: the speed comes and goes slowly and she carries her way, the turn builds up and lasts, and
//   going astern the rudder bites half as well.
//
// The mission (`stage`): alongside the central pier with the lines fast → let go and leave by the entrance →
// round the fairway buoy → come back in → berth alongside the north breakwater (berth 7) and make fast. Inside
// the harbour the speed limit is 6 knots. A contact with a quay, a breakwater or a moored ship is a touch at a
// crawl, worse above it, and enough hard contacts hole her: the mission is lost.

const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const wrapPi = (a) => Math.atan2(Math.sin(a), Math.cos(a));

export const DT = 1 / 120;
export const KT = 0.514444; // m/s per knot

// --- The image, and the port traced on it ------------------------------------------------------------------------
export const IMG = 1.107; // metres per pixel
const ORIGIN = [1020, 475]; // the pixel at the world origin: the middle of the entrance
export const px = (x, y) => ({ x: (ORIGIN[1] - y) * IMG, z: (x - ORIGIN[0]) * IMG });

// Each vertex is [px, py, kind], the kind for the edge from it to the next one:
//   q a quay wall (vertical concrete), r rock armour, b sand beach, c a natural rocky coast, x hidden (inland, or shared).
const LAND_PX = [
  [-9000, -40, 'c'], [-4000, -80, 'c'], [-1500, -130, 'c'], [-600, -150, 'c'], [-300, -120, 'c'], [-125, -108, 'c'], [60, -55, 'c'], [200, -10, 'c'],
  [340, 35, 'r'], [560, 68, 'x'], // the breakwater's root (the breakwater itself is its own outline)
  [560, 150, 'q'], [557, 160, 'q'], [391, 231, 'q'], [308, 166, 'q'], // the warehouse platform
  [258, 166, 'q'], [281, 306, 'q'], [249, 308, 'q'], [225, 170, 'q'], // the finger pier
  [41, 202, 'q'], [41, 285, 'q'], [142, 285, 'q'], [142, 326, 'q'], [110, 340, 'q'], // the old quays at the west end
  [185, 445, 'q'], [270, 412, 'q'], [575, 358, 'q'], [630, 410, 'q'], // the central pier, its north face and its head
  [253, 616, 'q'], [310, 740, 'q'], [568, 612, 'q'], // the south basin
  [606, 673, 'q'], [922, 498, 'r'], [940, 497, 'r'], [951, 510, 'r'], [944, 524, 'r'], [618, 700, 'r'], // the south mole and its head
  [545, 747, 'r'], [704, 1192, 'r'], [700, 1206, 'r'], [684, 1209, 'r'], [676, 1200, 'q'], // the marina breakwater
  [522, 765, 'q'], [330, 790, 'q'], [318, 810, 'q'], [303, 1189, 'r'], [584, 1135, 'r'], [592, 1150, 'r'], [420, 1205, 'r'], // the fishing harbour
  [430, 1240, 'b'], [560, 1420, 'b'], [704, 1657, 'b'], [918, 1897, 'b'], [1300, 2400, 'b'], [2200, 3000, 'b'], // the beach
  [4500, 3500, 'x'], [4500, 12000, 'x'], [-9000, 12000, 'x'], // far inland: the mountains
];
// The north breakwater with its east arm.
const BREAKWATER_PX = [
  [560, 68, 'r'], [700, 85, 'r'], [1000, 133, 'r'], [1063, 160, 'r'], [1104, 180, 'r'], [1122, 300, 'r'], [1130, 425, 'r'], [1118, 452, 'r'],
  [1095, 450, 'q'], [1018, 200, 'q'], [605, 142, 'q'], [560, 150, 'x'],
];
// Rocks awash off the breakwater's elbow (the surf in the images) and off the headland.
const ROCKS_PX = [[1215, 105, 15], [1236, 200, 12], [1162, 92, 7], [-250, -170, 16], [-60, -120, 9]];
const ring = (cx, cy, r, n = 9) => Array.from({ length: n }, (_, i) => {
  const a = (i / n) * Math.PI * 2;
  const k = 1 + 0.22 * Math.sin(i * 2.7 + cx);
  return [cx + Math.cos(a) * r * k, cy + Math.sin(a) * r * k, 'c'];
});

const toPoly = (list) => {
  const pts = list.map(([x, y]) => px(x, y));
  const kinds = list.map((v) => v[2]);
  return { pts, kinds, box: bbox(pts) };
};
function bbox(pts) {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const p of pts) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); z0 = Math.min(z0, p.z); z1 = Math.max(z1, p.z); }
  return { x0, x1, z0, z1 };
}
export const LAND = toPoly(LAND_PX);
export const BREAKWATER = toPoly(BREAKWATER_PX);
export const ROCKS = ROCKS_PX.map(([x, y, r]) => ({ ...toPoly(ring(x, y, r)), c: px(x, y), r: r * IMG }));

// --- Faces, berths and the ships alongside ----------------------------------------------------------------------
// A face is a quay wall from a to b; `water` is +1 when the water lies to starboard of a walk from a to b, -1 to port.
const face = (ax, ay, bx, by, water, name) => {
  const a = px(ax, ay), b = px(bx, by);
  const len = Math.hypot(b.x - a.x, b.z - a.z);
  const dir = { x: (b.x - a.x) / len, z: (b.z - a.z) / len };
  const n = { x: -dir.z * water, z: dir.x * water }; // toward the water
  return { a, b, len, dir, n, psi: Math.atan2(dir.z, dir.x), name };
};
export const FACES = {
  pier: face(270, 412, 575, 358, -1, 'Central pier'),
  north: face(605, 142, 1018, 200, 1, 'North breakwater'),
  arm: face(1018, 200, 1095, 450, 1, 'East arm'),
  mole: face(606, 673, 922, 498, -1, 'South mole'),
  pierSouth: face(630, 410, 253, 616, -1, 'Central pier, south side'),
};
export const HALF_LENGTH = 58; // m
export const HALF_BEAM = 7.5;
export const FENDER = 1.5; // m between the quay and her side when she lies alongside
// A spot alongside a face: `t` along it (0 at a, 1 at b), `off` the distance of her centreline from the wall.
export function alongside(f, t, off = HALF_BEAM + FENDER) {
  return { x: f.a.x + f.dir.x * f.len * t + f.n.x * off, z: f.a.z + f.dir.z * f.len * t + f.n.z * off };
}

// Where she starts (berth 3, starboard side to the central pier, bow toward its head) and where she ends (berth 7 on the north breakwater,
// either side to).
export const START_BERTH = { name: 'Berth 3', face: FACES.pier, t: 0.36, ...alongside(FACES.pier, 0.36), psi: FACES.pier.psi };
export const TARGET_BERTH = { name: 'Berth 7', face: FACES.north, t: 0.55, ...alongside(FACES.north, 0.55), psi: FACES.north.psi, len: 2 * HALF_LENGTH + 14 };

// The ships alongside (obstacles; the scene draws a model for each `type`), and the berth each lies at.
const moored = (type, f, t, len, beam, flip = false, off = beam / 2 + FENDER) => {
  const c = alongside(f, t, off);
  return { type, x: c.x, z: c.z, psi: wrapPi(f.psi + (flip ? Math.PI : 0)), len, beam };
};
export const MOORED = [
  moored('corvette', FACES.north, 0.2, 90, 12),
  moored('corvette', FACES.north, 0.88, 80, 11, true),
  moored('frigate', FACES.pier, 0.82, 116, 15),
  moored('ferry', FACES.arm, 0.42, 120, 20, true),
  moored('submarine', FACES.mole, 0.44, 72, 10),
  moored('submarine', FACES.mole, 0.66, 72, 10, true),
  moored('tug', FACES.pierSouth, 0.35, 30, 9),
  { type: 'barge', ...px(320, 228), psi: rad(146), len: 60, beam: 13 },
];
for (const m of MOORED) { m.pts = boxCorners(m); m.kinds = m.pts.map(() => 'q'); m.box = bbox(m.pts); }
function boxCorners(m) {
  const c = Math.cos(m.psi), s = Math.sin(m.psi), L = m.len / 2, B = m.beam / 2;
  // a pointed bow, so a ship coming along her bow slides off it
  return [[L, 0], [L * 0.7, B], [-L, B], [-L, -B], [L * 0.7, -B]].map(([a, b]) => ({ x: m.x + a * c - b * s, z: m.z + a * s + b * c }));
}

// Everything she can hit.
export const SOLIDS = [LAND, BREAKWATER, ...ROCKS, ...MOORED];

// Inside the harbour (the speed limit holds there), the entrance between the two heads, the fairway buoy and the channel buoys.
export const INSIDE = toPoly([[41, 202], [600, 140], [1018, 200], [1100, 452], [935, 505], [606, 673], [253, 616], [110, 340]].map((p) => [...p, 'x']));
export const GATE = { a: px(940, 503), b: px(1110, 450) }; // south mole head → east arm head
export const FAIRWAY = { ...px(1720, 560), r: 220, name: 'Fairway buoy' }; // r: how close counts as rounding it
export const BUOYS = [
  { ...px(1720, 560), kind: 'fairway' },
  { ...px(1350, 575), kind: 'port' }, // red, left hand coming in
  { ...px(1360, 420), kind: 'stbd' }, // green, right hand coming in
];
// The two pier-head lights (IALA A: red on the left hand coming in, green on the right).
export const LIGHTS = [{ ...px(940, 509), color: 'red' }, { ...px(1112, 446), color: 'green' }];
export const SPEED_LIMIT = 6; // knots inside

// --- Geometry helpers ----------------------------------------------------------------------------------------------
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
// The distance from (x, z) to the nearest solid (0 inside one).
export function clearance(x, z) {
  let best = Infinity;
  for (const s of SOLIDS) {
    if (inPoly(s, x, z)) return 0;
    const b = s.box;
    const dx = Math.max(b.x0 - x, 0, x - b.x1), dz = Math.max(b.z0 - z, 0, z - b.z1);
    if (Math.hypot(dx, dz) > best) continue;
    best = Math.min(best, nearestEdge(s, x, z).d);
  }
  return best;
}
// Which side of the entrance line a point is: > 0 inside the harbour.
export const gateSide = (x, z) => (GATE.b.z - GATE.a.z) * (x - GATE.a.x) - (GATE.b.x - GATE.a.x) * (z - GATE.a.z);

// Her waterline, as points in her own frame (bow +x, starboard +z), for the contacts.
export const HULL_PTS = [[58, 0], [50, -2.8], [50, 2.8], [38, -5.4], [38, 5.4], [22, -7.1], [22, 7.1], [0, -7.5], [0, 7.5], [-25, -7.5], [-25, 7.5], [-45, -7.4], [-45, 7.4], [-57, -6.6], [-57, 6.6], [-57.5, 0]];

// The same waterline as one closed outline (starboard side forward to aft, then the port side back), for drawing.
export const HULL_OUTLINE = [...HULL_PTS.filter(([, b]) => b >= 0).sort((p, q) => q[0] - p[0]), ...HULL_PTS.filter(([, b]) => b < 0).sort((p, q) => p[0] - q[0])];

// --- The ship ---------------------------------------------------------------------------------------------------
export const TELEGRAPH = [
  { name: 'Full astern', kn: -10 },
  { name: 'Half astern', kn: -6 },
  { name: 'Slow astern', kn: -3 },
  { name: 'Stop', kn: 0 },
  { name: 'Dead slow', kn: 3 },
  { name: 'Slow', kn: 6 },
  { name: 'Half', kn: 10 },
  { name: 'Full', kn: 16 },
];
export const STOP_ORDER = 3;
export const RUDDER_MAX = rad(35);
const RUDDER_RATE = rad(9); // per second, the key held
const RUDDER_BACK = rad(12); // per second back to amidships, the key let go
const TURN_RADIUS = 90; // m at full rudder, at speed
const TURN_T = 6; // s: the swing builds up and dies away on this time
const SPEED_T = 16; // s
const COAST_T = 60; // s: with the engine eased or stopped she only slows on her own drag
const ACCEL = 0.16; // m/s² at most, ahead
const ACCEL_ASTERN = 0.2; // the screw bites harder going astern
const TURN_LOSS = 0.2; // the share of her speed lost at full rudder
const HEEL = 0.06;
// The thrusters: full effect stopped, none from THRUSTER_FADE knots.
const THRUSTER_FADE = 5;
const THR_YAW = rad(1.7); // deg/s she turns on the spot at full thrust (steady)
const THR_SWAY = 0.55; // m/s she moves sideways at full thrust (steady)
const SWAY_T = 7; // s
export const thrusterFactor = (u) => clamp(1 - Math.abs(u) / (THRUSTER_FADE * KT), 0, 1);

// Contacts: closing speeds (m/s) above which a contact is hard, and a collision.
export const TOUCH = 0.12;
export const HARD = 0.5;
export const CRASH = 1.2;
const DAMAGE_PER = 22; // % of her hull for each m/s above HARD
// Berthing: how still and how close she has to lie before the lines can go on.
export const BERTH_TOL = { along: 22, offMin: HALF_BEAM, offMax: HALF_BEAM + 6, heading: rad(7), speed: 0.3 * KT, sway: 0.25, rate: rad(0.4), hold: 3 };

export const STAGES = {
  alongside: { title: 'Alongside berth 3', task: 'Lines fast on the central pier. Press L to let go fore and aft.' },
  depart: { title: 'Leave harbour', task: 'Take her out between the pier heads, 6 knots at most inside.' },
  sea: { title: 'Fairway buoy', task: 'Round the fairway buoy east of the entrance.' },
  return: { title: 'Come back in', task: 'Bring her back in between the pier heads: red to port, green to starboard.' },
  berth: { title: 'Berth 7', task: 'Lay her alongside berth 7 on the north breakwater (green), stop her, then L to make fast.' },
  done: { title: 'All fast', task: 'Alongside berth 7. Finished with engines.' },
  wrecked: { title: 'Holed', task: 'She has hit too hard. The pilot is relieved: R to sail again.' },
};

export class HarbourSim {
  constructor() { this.reset(); }

  reset() {
    this.t = 0;
    this.x = START_BERTH.x; this.z = START_BERTH.z; this.psi = START_BERTH.psi;
    this.u = 0; this.v = 0; this.r = 0; this.rudder = 0; this.heel = 0;
    this.order = STOP_ORDER;
    this.lines = true;
    this.stage = 'alongside';
    this.damage = 0;
    this.contacts = { touch: 0, hard: 0, crash: 0 };
    this.contactAt = -Infinity;
    this.inContact = false;
    this.maxInside = 0;
    this.overLimit = 0; // s over the speed limit inside
    this.warned = false;
    this.side = gateSide(this.x, this.z);
    this.berthHold = 0;
    this.result = null;
    this.events = [];
    this.thr = { yaw: 0, sway: 0 }; // what the thrusters are doing (-1 to 1), for the readouts
    this.track = [];
    this.tStart = null; // when the lines went
    this.tFast = null; // when they went on again, at berth 7
    this.acc = 0;
  }

  get speedKn() { return this.u / KT; }
  get ordered() { return TELEGRAPH[this.order].kn; }
  get inside() { return inPoly(INSIDE, this.x, this.z); }
  get orderName() { return TELEGRAPH[this.order].name; }
  say(text, tone = '', sound = null) { this.events.push({ type: 'say', text, tone, sound }); }
  takeEvents() { const e = this.events; this.events = []; return e; }

  telegraph(step) {
    if (this.over) return;
    const o = clamp(this.order + step, 0, TELEGRAPH.length - 1);
    if (o === this.order) return;
    this.order = o;
    this.events.push({ type: 'telegraph', order: o });
  }

  // L: let go (at the start) or make fast (alongside berth 7, lying still).
  lineKey() {
    if (this.stage === 'alongside') {
      this.lines = false;
      this.stage = 'depart';
      this.tStart = this.t;
      this.say('Let go fore and aft. Take her out', '', 'lines');
      return;
    }
    if (this.stage === 'berth') {
      const b = this.berthState();
      if (b.ok) this.makeFast();
      else this.say(b.why, 'warn');
      return;
    }
    if (!this.over) this.say(this.stage === 'depart' ? 'The lines are already let go' : 'Lines go on only alongside berth 7', 'warn');
  }

  makeFast() {
    this.lines = true;
    this.tFast = this.t;
    this.stage = 'done';
    this.u = this.v = this.r = 0;
    const b = this.berthState();
    this.result = {
      time: this.t - (this.tStart ?? 0), maxInside: this.maxInside, overLimit: this.overLimit, contacts: { ...this.contacts }, damage: this.damage,
      along: b.along, gapFwd: b.gapFwd, gapAft: b.gapAft, stars: 0,
    };
    const r = this.result;
    r.stars = 1 + (r.contacts.hard + r.contacts.crash === 0 ? 1 : 0) + (r.overLimit < 5 && Math.abs(r.along) < 10 && r.contacts.touch <= 2 ? 1 : 0);
    this.say('All fast. Finished with engines', 'good', 'done');
  }

  // Berth 7: where she lies against it, and whether the lines could go on now.
  berthState() {
    const B = TARGET_BERTH, f = B.face;
    const rx = this.x - (f.a.x + f.dir.x * f.len * B.t), rz = this.z - (f.a.z + f.dir.z * f.len * B.t);
    const along = rx * f.dir.x + rz * f.dir.z; // her centre ahead (+) or astern of the berth's middle, along the face
    const off = rx * f.n.x + rz * f.n.z; // her centreline's distance from the wall
    const c = Math.cos(this.psi), s = Math.sin(this.psi);
    const offAt = (ax) => (this.x + c * ax - f.a.x) * f.n.x + (this.z + s * ax - f.a.z) * f.n.z;
    const hd = Math.abs(wrapPi(this.psi - f.psi));
    const head = Math.min(hd, Math.PI - hd); // either side to
    const gapFwd = offAt(HALF_LENGTH - 10) - HALF_BEAM, gapAft = offAt(-(HALF_LENGTH - 10)) - HALF_BEAM;
    // her speed toward the wall (+ closing)
    const vx = c * this.u - s * this.v, vz = s * this.u + c * this.v;
    const closing = -(vx * f.n.x + vz * f.n.z);
    const T = BERTH_TOL;
    let why = null;
    if (Math.abs(along) > T.along || off > 60) why = `Not at berth 7 yet: ${Math.round(Math.hypot(along, off))} m to go`;
    else if (head > T.heading) why = `Lay her parallel to the quay: ${Math.round(deg(head))}° off`;
    else if (off > T.offMax || Math.max(gapFwd, gapAft) > T.offMax - HALF_BEAM + 1.5) why = `Closer in: ${Math.max(gapFwd, gapAft).toFixed(1)} m off the quay`;
    else if (Math.abs(this.u) > T.speed || Math.abs(this.v) > T.sway || Math.abs(this.r) > T.rate) why = 'Stop her first: she is still moving';
    return { ok: !why, why, along, off, head, gapFwd, gapAft, closing, dist: Math.hypot(along, off - HALF_BEAM - FENDER) };
  }

  get over() { return this.stage === 'done' || this.stage === 'wrecked'; }

  advance(dt, input = {}) {
    this.acc += Math.min(dt, 0.25);
    while (this.acc >= DT) { this.acc -= DT; this.step(DT, input); }
  }

  step(dt, input) {
    this.t += dt;
    if (this.lines) { // fast alongside: she does not move, whatever the engine does
      this.u = this.v = this.r = 0;
      this.rudder += clamp((input.wheel ?? 0) * RUDDER_MAX - this.rudder, -RUDDER_RATE * dt, RUDDER_RATE * dt);
      return;
    }
    this.hull(dt, input);
    this.collide();
    this.rules(dt);
    if (this.track.length === 0 || this.t - this.track[this.track.length - 1].t > 1) {
      this.track.push({ t: this.t, x: this.x, z: this.z });
      if (this.track.length > 900) this.track.shift();
    }
  }

  hull(dt, input) {
    const want = this.over ? 0 : (input.wheel ?? 0);
    const goal = want * RUDDER_MAX;
    const rate = want === 0 ? RUDDER_BACK : RUDDER_RATE;
    this.rudder += clamp(goal - this.rudder, -rate * dt, rate * dt);
    const kn = this.over ? 0 : TELEGRAPH[this.order].kn;
    const ordered = kn * KT * (1 - TURN_LOSS * Math.abs(this.rudder) / RUDDER_MAX);
    const dv = ordered - this.u;
    // Ahead or astern the screw drives her toward the ordered speed; eased (a lower order ahead, or stop) she coasts down on her drag.
    const coasting = dv * Math.sign(this.u) < 0 && kn * Math.sign(this.u) >= 0 && kn * this.u >= 0;
    this.u += (coasting ? dv / COAST_T : clamp(dv / SPEED_T, -(kn < 0 ? ACCEL_ASTERN : ACCEL), kn < 0 ? ACCEL : ACCEL)) * dt;
    // The turn: the rudder's (by the water past it) and the thrusters' (at low speed) together, on the hull's time.
    const f = thrusterFactor(this.u);
    const ty = this.over ? 0 : clamp(input.turn ?? 0, -1, 1) * f;
    const ts = this.over ? 0 : clamp(input.slide ?? 0, -1, 1) * f;
    this.thr.yaw = ty; this.thr.sway = ts;
    const rRudder = (this.u / TURN_RADIUS) * (this.rudder / RUDDER_MAX) * (this.u < 0 ? 0.5 : 1);
    this.r += ((rRudder + THR_YAW * ty - this.r) / TURN_T) * dt;
    this.v += ((THR_SWAY * ts - this.v) / SWAY_T) * dt;
    this.psi = wrapPi(this.psi + this.r * dt);
    const c = Math.cos(this.psi), s = Math.sin(this.psi);
    this.x += (c * this.u - s * this.v) * dt;
    this.z += (s * this.u + c * this.v) * dt;
    this.heel += ((-HEEL * this.r * this.u - this.heel) / 3) * dt;
  }

  // Push her out of anything she has run into, take the closing speed off, and score the contact.
  collide() {
    const c = Math.cos(this.psi), s = Math.sin(this.psi);
    let depth = 0, nx = 0, nz = 0, ox = 0, oz = 0;
    for (const [a, b] of HULL_PTS) {
      const wx = this.x + a * c - b * s, wz = this.z + a * s + b * c;
      for (const so of SOLIDS) {
        if (!inPoly(so, wx, wz)) continue;
        const e = nearestEdge(so, wx, wz); // inside: the normal points inward, so flip it
        if (e.d > depth) { depth = e.d; nx = -e.nx; nz = -e.nz; ox = a * c - b * s; oz = a * s + b * c; }
      }
    }
    if (depth <= 0) { if (this.t - this.contactAt > 0.6) this.inContact = false; return; }
    this.x += nx * (depth + 0.01);
    this.z += nz * (depth + 0.01);
    // her velocity at the point of contact
    let vx = c * this.u - s * this.v, vz = s * this.u + c * this.v;
    const px0 = vx - this.r * oz, pz0 = vz + this.r * ox;
    const vn = px0 * nx + pz0 * nz;
    if (vn < 0) {
      vx -= nx * vn * 1.05; vz -= nz * vn * 1.05;
      this.r *= 0.7;
      this.u = vx * c + vz * s;
      this.v = -vx * s + vz * c;
      // a little friction along the wall
      this.u *= 0.995;
      const hit = -vn;
      if (hit > TOUCH && (!this.inContact || hit > HARD)) this.contact(hit);
    }
    this.contactAt = this.t;
    this.inContact = true;
  }

  contact(hit) {
    if (this.over) return;
    if (hit >= CRASH) {
      this.contacts.crash++;
      this.damage += (hit - HARD) * DAMAGE_PER * 1.5;
      this.say(`Collision at ${(hit / KT).toFixed(1)} kn: damage to the hull`, 'danger', 'crash');
    } else if (hit >= HARD) {
      this.contacts.hard++;
      this.damage += (hit - HARD) * DAMAGE_PER + 4;
      this.say(`Hard contact at ${(hit / KT).toFixed(1)} kn`, 'danger', 'hard');
    } else {
      this.contacts.touch++;
      this.events.push({ type: 'touch', hit });
    }
    this.events.push({ type: 'contact', hit });
    if (this.damage >= 100) {
      this.damage = 100;
      this.stage = 'wrecked';
      this.order = STOP_ORDER;
      this.say('She is holed. The pilot is relieved', 'danger', 'crash');
    }
  }

  rules(dt) {
    if (this.over) return;
    const inside = this.inside;
    const kn = Math.abs(this.u) / KT;
    if (inside) {
      this.maxInside = Math.max(this.maxInside, kn);
      if (kn > SPEED_LIMIT + 0.2) {
        this.overLimit += dt;
        if (!this.warned) { this.warned = true; this.say(`Speed limit in the harbour: ${SPEED_LIMIT} knots`, 'warn', 'warn'); }
      } else if (kn < SPEED_LIMIT - 1) this.warned = false;
    }
    const side = gateSide(this.x, this.z);
    const crossed = Math.sign(side) !== Math.sign(this.side) && this.betweenHeads();
    this.side = side;
    if (this.stage === 'depart' && crossed && side < 0) {
      this.stage = 'sea';
      this.say('Clear of the pier heads. Round the fairway buoy', 'good', 'stage');
    } else if (this.stage === 'sea' && Math.hypot(this.x - FAIRWAY.x, this.z - FAIRWAY.z) < FAIRWAY.r) {
      this.stage = 'return';
      this.say('Fairway buoy rounded. Bring her back in', 'good', 'stage');
    } else if (this.stage === 'return' && crossed && side > 0) {
      this.stage = 'berth';
      this.say('Inside. Berth 7 is on the north breakwater, marked in green', 'good', 'stage');
    } else if (this.stage === 'berth') {
      const b = this.berthState();
      this.berthHold = b.ok ? this.berthHold + dt : 0;
      if (this.berthHold >= BERTH_TOL.hold) this.makeFast();
    }
  }

  // Is she (her centre) between the two heads, along the entrance line?
  betweenHeads() {
    const ex = GATE.b.x - GATE.a.x, ez = GATE.b.z - GATE.a.z;
    const t = ((this.x - GATE.a.x) * ex + (this.z - GATE.a.z) * ez) / (ex * ex + ez * ez);
    return t > -0.1 && t < 1.1;
  }

  // The next mark to steer for, for the readouts and the map.
  get mark() {
    if (this.stage === 'depart') return { ...mid(GATE.a, GATE.b), name: 'Entrance' };
    if (this.stage === 'sea') return { x: FAIRWAY.x, z: FAIRWAY.z, name: FAIRWAY.name };
    if (this.stage === 'return') return { ...mid(GATE.a, GATE.b), name: 'Entrance' };
    if (this.stage === 'berth') return { x: TARGET_BERTH.x, z: TARGET_BERTH.z, name: TARGET_BERTH.name };
    return null;
  }
}
const mid = (a, b) => ({ x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 });

export const compass = (r) => ((deg(r) % 360) + 360) % 360;

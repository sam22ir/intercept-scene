// Naval maneuvers: the second mission, after the "Tactical maneuvers" briefing deck. Two frigates,
// ALG and RUS, start in FORM 1 (a column, 1000 yards apart, heading 000) and run through a series
// of signalled maneuvers: turn together, change station, flashing-light and flag-hoist serials,
// and a final skim past on reciprocal courses. No drone and no missile.
//
// Like scenario.js this is a pure function of the sim time t: the tables below are baked once at
// import and everything is looked up (and interpolated) from them, so the timeline scrubs both ways.
// The module imports nothing, so geometry can be checked in Node.
//
// Coordinates are metres on the sea: x points North, z points East (so a ship heading 000 has its bow
// on +x and its starboard side on +z). A heading is in radians clockwise from North; the compass
// functions below speak degrees.

export const YD = 0.9144; // metres per yard
export const KT = 0.514444; // metres per second per knot
export const FORMATION_RANGE = 1000 * YD; // the 1000 YDS of the diagrams

const DT = 0.25; // s between table entries
const TURN_RATE = 1.2; // deg/s: a standard 300 m radius turn at 12 knots
const ACCEL = 0.08; // m/s^2

const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;
const norm = (a) => ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
const smooth = (u) => { const k = Math.min(Math.max(u, 0), 1); return k * k * (3 - 2 * k); }; // smoothstep

// --- Phases ---------------------------------------------------------------------------------
// One entry per slide. `serial` is the signal text shown during the phase (SERIAL blocks mirror the
// START / END SERIAL boxes of the deck). `t` is when the order is executed.
const START_STBY = 'AS this is AB STANDBY STANDBY EXECUTE';
const GO = 'AS this is AB EXECUTE TO FOLLOW';
export const PHASES = [
  { id: 'form1', t: 0, label: 'Initial formation', title: 'INITIAL FORMATION : FORM 1',
    speeds: ['NORMAL: 12 KNOTS', 'SIERRA: 15 KNOTS'],
    serial: [{ head: 'START SERIAL:', lines: [GO, 'EX3 – 9 DESIG 12010 –', 'G SPEED 12'] }] },
  { id: 'station', t: 30, label: 'Form 1', title: 'INITIAL FORMATION : FORM 1',
    serial: [{ lines: [GO, 'FORM 1- STATION 1 DESIG ALG –', 'STATION 2 DESIG RUS – S SPEED 16', 'B CORPEN 360 – B SPEED 12 –', 'G FORM ALG -TA12-1-10', START_STBY] }] },
  { id: 'stbd', t: 60, label: 'Turn stbd 90°', title: 'TURN STBD 9',
    serial: [{ lines: [GO, 'TURN STBD 9 .', START_STBY] }] },
  { id: 'port', t: 170, label: 'Turn port 90°', title: 'TURN PORT 9',
    serial: [{ lines: ['AS this is AC EXECUTE TO FOLLOW', 'TURN PORT 9 .', START_STBY] }] },
  { id: 'gform', t: 280, label: 'G form RUS', title: 'G FORM',
    serial: [{ lines: [GO, 'B CORPEN 360 – B SPEED 12 –', 'G FORM RUS – TA12-1- 10', START_STBY] }] },
  { id: 'turn045', t: 860, label: 'Turn 045', title: 'TURN 045',
    serial: [{ lines: [GO, 'TURN 045 – B SPEED 12 –', 'TA 12-1- 10', START_STBY] }] },
  { id: 'form120', t: 940, label: 'Form 120', title: 'FORM 120',
    serial: [{ lines: [GO, 'FORM 120 – B SPEED 10 –', 'TA 12-1- 10', START_STBY] }] },
  { id: 'light', t: 1200, label: 'Flashing light', title: 'FLASHING LIGHT',
    serial: [{ head: 'START SERIAL:', lines: [GO, 'EX3 – 9 desig 12030–', 'G SPEED 6'] }, { head: 'END SERIAL :', lines: [GO, 'EX3 – 4 desig 12030'] }] },
  { id: 'corpen', t: 1310, label: 'Corpen stbd 045', title: 'CORPEN STBD 045',
    serial: [{ lines: [GO, 'CORPEN STBD 045 – B SPEED 12–', 'G FORM ALG – TA 12-1- 10', START_STBY] }] },
  { id: 'flags', t: 1570, label: 'Flag hoist', title: 'FLAG HOIST',
    serial: [{ head: 'START SERIAL:', lines: [GO, 'EX3 – 9 desig 12040 –', 'G SPEED 6'] }, { head: 'END SERIAL :', lines: [GO, 'EX3 – 4 desig 12040'] }] },
  { id: 'skim', t: 1690, label: 'Skimming past', title: 'SKIMMING PAST',
    serial: [{ head: 'START SERIAL:', lines: [GO, 'EX3 – 9 desig 12050'] }, { head: 'END SERIAL :', lines: ['EX3 – 4 desig 12050'] }] },
];
const T = Object.fromEntries(PHASES.map((p) => [p.id, p.t]));

// --- ALG, the guide: courses and speeds under rate-limited steering -------------------------------
// {t, course (deg), speed (kn), dir: 'stbd' | 'port' | undefined (shortest way)}
const ALG_ORDERS = [
  { t: 0, course: 0, speed: 12 },
  { t: T.stbd, course: 90, dir: 'stbd' }, // TURN STBD 9
  { t: T.port, course: 0, dir: 'port' }, // TURN PORT 9
  { t: T.turn045, course: 45, dir: 'stbd' }, // TURN 045
  { t: T.form120, speed: 10 }, // B SPEED 10
  { t: T.light, speed: 6 }, // G SPEED 6
  { t: T.corpen, course: 90, dir: 'stbd', speed: 12 }, // CORPEN STBD 045, B SPEED 12
  { t: T.flags, speed: 6 }, // G SPEED 6
];

function integrate(orders, until, start) {
  let { x, z, psi, v } = start;
  let target = { course: deg(psi), dir: undefined };
  let speedTarget = v / KT;
  let i = 0;
  const rows = [];
  const n = Math.ceil(until / DT);
  const t0 = start.t ?? 0;
  for (let k = 0; k <= n; k++) {
    const t = t0 + k * DT;
    while (i < orders.length && orders[i].t <= t + 1e-9) {
      const o = orders[i++];
      if (o.course !== undefined) target = { course: o.course, dir: o.dir, rate: o.rate };
      if (o.speed !== undefined) speedTarget = o.speed;
    }
    rows.push({ t, x, z, psi, v });
    // Steering: turn toward the ordered course, the ordered way round, at the turn rate.
    let diff = norm(rad(target.course) - psi);
    if (target.dir === 'stbd') { /* clockwise: diff already measured clockwise */ } else if (target.dir === 'port') diff -= 2 * Math.PI;
    else if (diff > Math.PI) diff -= 2 * Math.PI;
    const rate = rad(target.rate ?? TURN_RATE) * DT;
    const dpsi = Math.abs(diff) <= rate ? diff : Math.sign(diff) * rate;
    const vt = speedTarget * KT;
    const dv = Math.abs(vt - v) <= ACCEL * DT ? vt - v : Math.sign(vt - v) * ACCEL * DT;
    const mid = psi + dpsi / 2;
    const vm = v + dv / 2;
    x += Math.cos(mid) * vm * DT;
    z += Math.sin(mid) * vm * DT;
    psi += dpsi;
    v += dv;
    if (target.dir && Math.abs(diff) <= rate) target.dir = undefined; // arrived: later turns choose their own way
  }
  return rows;
}

// --- RUS: a station on ALG, then its own dynamic skim -----------------------------------------------
// RUS keeps an offset from ALG in world coordinates (North, East), eased between keyframes. The
// G FORM RUS change (from astern to ahead, passing to port) is a curved path through abeam at 520 m.
const R_ = FORMATION_RANGE;
const polar = (bearingDeg, range) => [Math.cos(rad(bearingDeg)) * range, Math.sin(rad(bearingDeg)) * range];
const STATION = {
  column: [-R_, 0], // FORM 1: RUS astern of ALG
  ahead: [R_, 0], // RUS ahead of ALG
  f120: polar(300, R_), // FORM 120: ALG lies on bearing 120 from RUS
};
const TRANSITIONS = [
  { t: T.gform, dur: 540, from: STATION.column, to: STATION.ahead, via: [0, -520] },
  { t: T.form120, dur: 240, from: STATION.ahead, to: STATION.f120 },
  { t: T.corpen, dur: 240, from: STATION.f120, to: STATION.ahead },
];
function offsetAt(t) {
  let off = STATION.column;
  for (const tr of TRANSITIONS) {
    if (t < tr.t) return off;
    const u = smooth((t - tr.t) / tr.dur);
    if (tr.via) {
      // Quadratic Bezier whose midpoint passes through `via`.
      const c = [2 * tr.via[0] - (tr.from[0] + tr.to[0]) / 2, 2 * tr.via[1] - (tr.from[1] + tr.to[1]) / 2];
      const a = (1 - u) * (1 - u);
      const b = 2 * (1 - u) * u;
      const d = u * u;
      off = [a * tr.from[0] + b * c[0] + d * tr.to[0], a * tr.from[1] + b * c[1] + d * tr.to[1]];
    } else {
      off = [tr.from[0] + (tr.to[0] - tr.from[0]) * u, tr.from[1] + (tr.to[1] - tr.from[1]) * u];
    }
    if (u < 1) return off;
    off = tr.to;
  }
  return off;
}

// ALG's table runs for the whole exercise (the end time is fixed below, once RUS has passed it).
const SKIM_SPEED = 15; // kn
const SKIM_RADIUS = 507; // m: a U-turn whose diameter takes RUS from 1000 yds north to 100 m south of ALG
const SKIM_RUN = 250; // s eastward before the U-turn, so the two meet on the way back
const SKIM_END_PAD = 100; // s after the pass

const algStart = { t: 0, x: 0, z: 0, psi: 0, v: 12 * KT };
const ALG_FULL = integrate(ALG_ORDERS, 3600, algStart);

function lookup(rows, t) {
  const f = Math.min(Math.max(t / DT, 0), rows.length - 1);
  const i = Math.min(Math.floor(f), rows.length - 2);
  const u = f - i;
  const a = rows[i];
  const b = rows[i + 1];
  // headings interpolate the short way
  let dp = b.psi - a.psi;
  if (dp > Math.PI) dp -= 2 * Math.PI; else if (dp < -Math.PI) dp += 2 * Math.PI;
  return { x: a.x + (b.x - a.x) * u, z: a.z + (b.z - a.z) * u, psi: a.psi + dp * u, v: a.v + (b.v - a.v) * u };
}

const stationPos = (t) => {
  const g = lookup(ALG_FULL, t);
  const o = offsetAt(t);
  return [g.x + o[0], g.z + o[1]];
};
function stationState(t) {
  const h = 2;
  const [x0, z0] = stationPos(Math.max(t - h, 0));
  const [x1, z1] = stationPos(t + h);
  const vx = (x1 - x0) / (t - Math.max(t - h, 0) + h);
  const vz = (z1 - z0) / (t - Math.max(t - h, 0) + h);
  const [x, z] = stationPos(t);
  return { x, z, psi: Math.atan2(vz, vx), v: Math.hypot(vx, vz) };
}

// RUS's own dynamic leg: from its station state at the skim order, east at SKIM_SPEED, then a wide right turn.
const s0 = stationState(T.skim);
const RUS_ORDERS = [
  { t: T.skim, course: deg(norm(s0.psi)), speed: SKIM_SPEED },
  { t: T.skim + SKIM_RUN, course: 270, dir: 'stbd', rate: deg((SKIM_SPEED * KT) / SKIM_RADIUS) },
];
const RUS_SKIM = integrate(RUS_ORDERS.map((o) => ({ ...o, t: o.t - T.skim })), 1200, { t: 0, x: s0.x, z: s0.z, psi: norm(s0.psi), v: s0.v })
  .map((r) => ({ ...r, t: r.t + T.skim }));
const RUS_SKIM_ROWS = RUS_SKIM.map((r) => ({ ...r, t: r.t - T.skim }));
const skimAt = (t) => lookup(RUS_SKIM_ROWS, t - T.skim);

// Closest approach of RUS to ALG after the skim order.
let tPass = T.skim;
let dMin = Infinity;
for (let t = T.skim + SKIM_RUN; t < T.skim + 1100; t += DT) {
  const g = lookup(ALG_FULL, t);
  const r = skimAt(t);
  const d = Math.hypot(r.x - g.x, r.z - g.z);
  if (d < dMin) { dMin = d; tPass = t; }
}
export const PASS = { t: tPass, range: dMin };

export const tEnd = Math.ceil((tPass + SKIM_END_PAD) / 5) * 5;

// Bake RUS over the whole exercise.
const RUS_ROWS = [];
for (let k = 0; k * DT <= tEnd; k++) {
  const t = k * DT;
  const st = t < T.skim ? stationState(t) : skimAt(t);
  RUS_ROWS.push({ t, x: st.x, z: st.z, psi: st.psi, v: st.v });
}
// Make the heading continuous (unwrap) so interpolation never spins the long way round.
for (let i = 1; i < RUS_ROWS.length; i++) {
  let d = RUS_ROWS[i].psi - RUS_ROWS[i - 1].psi;
  while (d > Math.PI) { RUS_ROWS[i].psi -= 2 * Math.PI; d -= 2 * Math.PI; }
  while (d < -Math.PI) { RUS_ROWS[i].psi += 2 * Math.PI; d += 2 * Math.PI; }
}

// --- Public API -------------------------------------------------------------------------------
// A ship's state at time t: x (North, m), z (East, m), heading (rad, clockwise from North), speed (m/s).
export function shipState(id, t, out = {}) {
  const s = id === 'rus' ? lookup(RUS_ROWS, t) : lookup(ALG_FULL, t);
  out.x = s.x; out.z = s.z; out.heading = s.psi; out.speed = s.v;
  return out;
}

// Compass helpers (degrees, 0 to 360).
export const headingDeg = (rad_) => ((deg(rad_) % 360) + 360) % 360;
// Range (m) and the bearing (deg) from `from` to `to`.
export function relation(t, from = 'rus', to = 'alg') {
  const a = shipState(from, t);
  const b = shipState(to, t);
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  return { range: Math.hypot(dx, dz), bearing: ((deg(Math.atan2(dz, dx)) % 360) + 360) % 360 };
}

export const phaseAt = (t) => PHASES.reduce((cur, p) => (t >= p.t ? p : cur), PHASES[0]);

// Flashing light (EX3 serial 12030): a signal lamp blinking from RUS to ALG, and back, between these times.
export const LIGHT = { t0: T.light + 10, t1: T.light + 90 };
// Flag hoist (serial 12040): the flags are up between these times.
export const FLAGS = { t0: T.flags + 10, t1: T.flags + 90 };

export const exercise = {
  tEnd,
  phases: PHASES,
  light: LIGHT,
  flags: FLAGS,
  pass: PASS,
  events: [
    ...PHASES.map((p) => ({ t: p.t, label: p.label })),
    { t: PASS.t, label: 'Closest pass' },
  ].sort((a, b) => a.t - b.t),
};

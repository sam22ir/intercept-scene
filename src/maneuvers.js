// Naval maneuvers: the second mission, after the "Tactical maneuvers" briefing deck. Two frigates,
// ALG and RUS, start in FORM 1 (a column, 500 yards apart, heading 000) and run through a series
// of signalled maneuvers: turn together, change station, flashing-light and flag-hoist serials,
// and a final skim past on reciprocal courses. No drone and no missile.
//
// Both ships steer by real orders: a course and a speed (the deck's 6, 10, 12 and 15 knots) with a
// limited turn rate and acceleration, integrated once at import into tables. Every station change is
// a turn-and-run: RUS holds a course and speed for a time, then falls in. The courses and times
// below were solved offline (a search over the same integrator) so that each change ends within a
// few metres of the deck's station; test/maneuvers.test.mjs checks the geometry.
//
// Like scenario.js this is a pure function of the sim time t (the tables are looked up and
// interpolated), so the timeline scrubs both ways. The module imports nothing, so it runs in Node.
//
// Coordinates are metres on the sea: x points North, z points East (so a ship heading 000 has its bow
// on +x and its starboard side on +z). A heading is in radians clockwise from North; the compass
// functions below speak degrees.

export const YD = 0.9144; // metres per yard
export const KT = 0.514444; // metres per second per knot
export const STATION_YD = 500; // the ships' station range (the deck says 1000 YDS; the scene keeps them closer so both read on screen)
export const FORMATION_RANGE = STATION_YD * YD;

const DT = 0.25; // s between table entries
const TURN_RATE = 1.2; // deg/s: a standard turn at 12 knots
const ACCEL = 0.08; // m/s^2

const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;
const norm = (a) => ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);

// --- Phases ---------------------------------------------------------------------------------
// One entry per slide. An order is announced ("AS this is AB ... STANDBY STANDBY") at `t`, stands by,
// and is executed at `tx`, when the ships start to obey it. The standby time is a setting
// (STANDBY, 3 to 25 s, default 10, remembered in localStorage['intercept.standby'] and read once
// at import): the execution times, and so every trajectory, are fixed, and the setting only moves the
// announcements earlier or later. (The `t` written in the entries below are the announcement times for
// the default 10 s; they are turned into the real ones just after the array.)
// `serial` is the signal text of the deck's boxes; `note` says how the ships do it.
export const STANDBY_LIMITS = [3, 25];
export const STANDBY_DEFAULT = 10;
export const STANDBY = (() => {
  try {
    const raw = globalThis.__STANDBY ?? globalThis.localStorage?.getItem('intercept.standby');
    const v = Math.round(Number(raw));
    return raw !== null && raw !== undefined && Number.isFinite(v) ? Math.min(Math.max(v, STANDBY_LIMITS[0]), STANDBY_LIMITS[1]) : STANDBY_DEFAULT;
  } catch {
    return STANDBY_DEFAULT;
  }
})();
export const EXEC_DELAY = STANDBY; // (the old name)
const LEAD = 15; // s before the first order executes, so even the longest standby fits after the start
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
  { id: 'port', t: 180, label: 'Turn port 90°', title: 'TURN PORT 9',
    serial: [{ lines: ['AS this is AC EXECUTE TO FOLLOW', 'TURN PORT 9 .', START_STBY] }] },
  { id: 'gform', t: 290, label: 'G form RUS', title: 'G FORM', note: 'ALG slows to 6 kn; RUS runs at sierra, 15 kn, out to port and in again.',
    serial: [{ lines: [GO, 'B CORPEN 360 – B SPEED 12 –', 'G FORM RUS – TA12-1- 10', START_STBY] }] },
  { id: 'turn045', t: 800, label: 'Turn 045', title: 'TURN 045',
    serial: [{ lines: [GO, 'TURN 045 – B SPEED 12 –', 'TA 12-1- 10', START_STBY] }] },
  { id: 'form120', t: 900, label: 'Form 120', title: 'FORM 120', note: 'ALG makes 10 kn; RUS drops back at 6 kn.',
    serial: [{ lines: [GO, 'FORM 120 – B SPEED 10 –', 'TA 12-1- 10', START_STBY] }] },
  { id: 'light', t: 1500, label: 'Flashing light', title: 'FLASHING LIGHT',
    serial: [{ head: 'START SERIAL:', lines: [GO, 'EX3 – 9 desig 12030–', 'G SPEED 6'] }, { head: 'END SERIAL :', lines: [GO, 'EX3 – 4 desig 12030'] }] },
  { id: 'corpen', t: 1620, label: 'Corpen stbd 045', title: 'CORPEN STBD 045', note: 'Both make 12 kn; RUS runs at sierra, 15 kn, to its new station.',
    serial: [{ lines: [GO, 'CORPEN STBD 045 – B SPEED 12–', 'G FORM ALG – TA 12-1- 10', START_STBY] }] },
  { id: 'flags', t: 2370, label: 'Flag hoist', title: 'FLAG HOIST',
    serial: [{ head: 'START SERIAL:', lines: [GO, 'EX3 – 9 desig 12040 –', 'G SPEED 6'] }, { head: 'END SERIAL :', lines: [GO, 'EX3 – 4 desig 12040'] }] },
  { id: 'skim', t: 2490, label: 'Skimming past', title: 'SKIMMING PAST', note: 'RUS makes sierra, turns away to starboard and comes back past ALG.',
    serial: [{ head: 'START SERIAL:', lines: [GO, 'EX3 – 9 desig 12050'] }, { head: 'END SERIAL :', lines: ['EX3 – 4 desig 12050'] }] },
];
for (const p of PHASES) { p.tx = p.t + STANDBY_DEFAULT + LEAD; p.t = p.tx - STANDBY; }
const X = Object.fromEntries(PHASES.map((p) => [p.id, p.tx]));

// --- The orders ---------------------------------------------------------------------------------
// {t, course (deg), speed (kn), dir: 'stbd' | 'port' | undefined (the shorter way), rate (deg/s)}
// G FORM RUS: ALG slows to 6 kn, RUS runs course 340 then 020 at 15 kn (to abeam of ALG well out to
// port, then in again) and falls in 500 yds ahead; ALG makes 12 knots again once RUS is there.
const G1 = 89.9;
const G2 = 106.3;
const G_RESUME = G1 + G2 + 30;
// FORM 120: RUS drops back at 6 kn on course 035 while ALG makes 10 kn.
const F_C = 35.8;
const F_T = 222.6;
// CORPEN STBD 045: RUS runs course 083.6 at sierra to catch up to ALG's new bearing-000 station.
const C_C = 83.6;
const C_T = 303.2;
// SKIMMING PAST: RUS makes 15 kn east, then a wide right turn (a U-turn whose diameter takes it from
// 500 yds north of ALG to 100 m south of it) and runs back west past ALG.
const SKIM_SPEED = 15; // kn
const SKIM_RADIUS = (FORMATION_RANGE + 100) / 2; // m: a U-turn from the station to 100 m past ALG
const SKIM_RUN = 250; // s eastward before the U-turn, so the two meet on the way back

const COMMON = [
  { t: 0, course: 0, speed: 12 },
  { t: X.stbd, course: 90, dir: 'stbd' }, // TURN STBD 9
  { t: X.port, course: 0, dir: 'port' }, // TURN PORT 9
];
const ALG_ORDERS = [
  ...COMMON,
  { t: X.gform, speed: 6 },
  { t: X.gform + G_RESUME, speed: 12 },
  { t: X.turn045, course: 45, dir: 'stbd' }, // TURN 045
  { t: X.form120, speed: 10 }, // B SPEED 10
  { t: X.light, speed: 6 }, // G SPEED 6
  { t: X.corpen, course: 90, dir: 'stbd', speed: 12 }, // CORPEN STBD 045, B SPEED 12
  { t: X.flags, speed: 6 }, // G SPEED 6
];
const RUS_ORDERS = [
  ...COMMON,
  { t: X.gform, course: 340, speed: 15 },
  { t: X.gform + G1, course: 20 },
  { t: X.gform + G1 + G2, course: 0, speed: 6 },
  { t: X.gform + G_RESUME, speed: 12 },
  { t: X.turn045, course: 45, dir: 'stbd' },
  { t: X.form120, course: F_C, speed: 6 },
  { t: X.form120 + F_T, course: 45, speed: 10 },
  { t: X.light, speed: 6 },
  { t: X.corpen, course: C_C, speed: 15 },
  { t: X.corpen + C_T, course: 90, speed: 12 },
  { t: X.flags, speed: 6 },
  { t: X.skim, course: 90, speed: SKIM_SPEED },
  { t: X.skim + SKIM_RUN, course: 270, dir: 'stbd', rate: deg((SKIM_SPEED * KT) / SKIM_RADIUS) },
];

function integrate(orders, until, start) {
  let { x, z, psi, v } = start;
  let target = { course: deg(psi), dir: undefined };
  let speedTarget = v / KT;
  let i = 0;
  const rows = [];
  const n = Math.ceil(until / DT);
  for (let k = 0; k <= n; k++) {
    const t = k * DT;
    while (i < orders.length && orders[i].t <= t + 1e-9) {
      const o = orders[i++];
      if (o.course !== undefined) target = { course: o.course, dir: o.dir, rate: o.rate };
      if (o.speed !== undefined) speedTarget = o.speed;
    }
    rows.push({ t, x, z, psi, v });
    // Steering: turn toward the ordered course, the ordered way round, at the turn rate.
    let diff = norm(rad(target.course) - psi);
    if (target.dir === 'stbd') { /* clockwise: diff is already measured clockwise */ } else if (target.dir === 'port') diff -= 2 * Math.PI;
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

const FULL = 3800; // s baked; the exercise ends well before
const ALG_FULL = integrate(ALG_ORDERS, FULL, { x: 0, z: 0, psi: 0, v: 12 * KT });
const RUS_FULL = integrate(RUS_ORDERS, FULL, { x: -FORMATION_RANGE, z: 0, psi: 0, v: 12 * KT });

function lookup(rows, t) {
  const f = Math.min(Math.max(t / DT, 0), rows.length - 1);
  const i = Math.min(Math.floor(f), rows.length - 2);
  const u = f - i;
  const a = rows[i];
  const b = rows[i + 1];
  let dp = b.psi - a.psi; // headings interpolate the short way
  if (dp > Math.PI) dp -= 2 * Math.PI; else if (dp < -Math.PI) dp += 2 * Math.PI;
  return { x: a.x + (b.x - a.x) * u, z: a.z + (b.z - a.z) * u, psi: a.psi + dp * u, v: a.v + (b.v - a.v) * u };
}

// Closest approach of RUS to ALG after the skim order.
let tPass = X.skim;
let dMin = Infinity;
for (let t = X.skim + SKIM_RUN; t < X.skim + 1100; t += DT) {
  const g = lookup(ALG_FULL, t);
  const r = lookup(RUS_FULL, t);
  const d = Math.hypot(r.x - g.x, r.z - g.z);
  if (d < dMin) { dMin = d; tPass = t; }
}
export const PASS = { t: tPass, range: dMin };
export const tEnd = Math.ceil((tPass + 100) / 5) * 5;

// Unwrap each heading so interpolation never spins the long way round.
for (const rows of [ALG_FULL, RUS_FULL]) {
  for (let i = 1; i < rows.length; i++) {
    let d = rows[i].psi - rows[i - 1].psi;
    while (d > Math.PI) { rows[i].psi -= 2 * Math.PI; d -= 2 * Math.PI; }
    while (d < -Math.PI) { rows[i].psi += 2 * Math.PI; d += 2 * Math.PI; }
  }
}

// --- Public API -------------------------------------------------------------------------------
// A ship's state at time t: x (North, m), z (East, m), heading (rad, clockwise from North), speed (m/s).
export function shipState(id, t, out = {}) {
  const s = lookup(id === 'rus' ? RUS_FULL : ALG_FULL, t);
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

// Where an order is in its life at time t:
//  'idle'     before the first announcement;
//  'standby'  from the announcement to `tx`: only getting ready, the ships do not move yet (`count` = s to EXECUTE);
//  'execute'  for EXECUTE_FLASH s from `tx`: the EXECUTE call; the ships start the maneuver at `tx`;
//  'underway' while they maneuver, until they are in position at `ta` (`count` = s to `ta`);
//  'station'  for STATION_FLASH s from `ta`: the "A STATION" call;
//  'onstation' after that, until the next order.
// Orders that only signal (the start and the FORM 1 stations) arrive as they execute, so they have no
// under-way or A STATION part (`p.hasStation` is false).
export const EXECUTE_FLASH = 4; // s the EXECUTE call stays up
export const STATION_FLASH = 5; // s the A STATION call stays up
export function orderStatus(t) {
  const phase = phaseAt(t);
  if (t < phase.t) return { phase, state: 'idle' };
  if (t < phase.tx) return { phase, state: 'standby', count: phase.tx - t };
  if (t < phase.tx + EXECUTE_FLASH) return { phase, state: 'execute', since: t - phase.tx };
  if (!phase.hasStation) return { phase, state: 'onstation' };
  if (t < phase.ta) return { phase, state: 'underway', count: phase.ta - t };
  if (t < phase.ta + STATION_FLASH) return { phase, state: 'station', since: t - phase.ta };
  return { phase, state: 'onstation' };
}

// Flashing light (EX3 serial 12030): a signal lamp blinking from RUS to ALG, and back, between these times.
export const LIGHT = { t0: X.light + 10, t1: X.light + 90 };
// Flag hoist (serial 12040): the flags are up between these times.
export const FLAGS = { t0: X.flags + 10, t1: X.flags + 90 };
// --- Arrival: the deck's TA, time of arrival --------------------------------------------------------------
// An order's countdown runs on until the ships are in position, so zero is arrival. `ta` is found from the
// ships' own motion: the first moment after which they stay on the ordered course (and station, for a
// station change) for ARRIVAL_HOLD seconds. Orders that only signal (the start, the form 1 stations) arrive as
// the ships start to obey; a serial arrives when it ends and the skim when RUS passes ALG.
const ARRIVAL_HOLD = 10;
const angDiff = (a, b) => Math.abs(((a - b + 540) % 360) - 180);
const headingOf = (id, t) => headingDeg(shipState(id, t).heading);
const both = (t, course, tol) => angDiff(headingOf('alg', t), course) <= tol && angDiff(headingOf('rus', t), course) <= tol;
const onStation = (t, bearing, yd, tolYd, tolDeg) => {
  const r = relation(t);
  return Math.abs(r.range / YD - yd) <= tolYd && angDiff(r.bearing, bearing) <= tolDeg;
};
const settledAfter = (t0, ok) => {
  let since = null;
  for (let t = t0; t < FULL; t += 0.5) {
    if (ok(t)) { since ??= t; if (t - since >= ARRIVAL_HOLD) return since; } else since = null;
  }
  return t0;
};
const ARRIVAL = {
  form1: (p) => p.tx,
  station: (p) => p.tx,
  stbd: (p) => settledAfter(p.tx, (t) => both(t, 90, 0.6)),
  port: (p) => settledAfter(p.tx, (t) => both(t, 0, 0.6)),
  gform: (p) => settledAfter(p.tx, (t) => both(t, 0, 1) && onStation(t, 180, STATION_YD, 4, 0.8)),
  turn045: (p) => settledAfter(p.tx, (t) => both(t, 45, 0.6)),
  form120: (p) => settledAfter(p.tx, (t) => both(t, 45, 1) && onStation(t, 120, STATION_YD, 5, 1.2)),
  light: () => LIGHT.t1,
  corpen: (p) => settledAfter(p.tx, (t) => both(t, 90, 1) && onStation(t, 180, STATION_YD, 8, 1.5)),
  flags: () => FLAGS.t1,
  skim: () => PASS.t,
};
for (const p of PHASES) {
  p.ta = ARRIVAL[p.id](p);
  p.hasStation = p.ta - p.tx > EXECUTE_FLASH;
}

// The signal lamp: RUS flashes in the first half of the light window, ALG answers in the second half.
// The pattern is dots and dashes, a pure function of t (units of the 8-unit pattern run at 2.2 per second).
const LAMP_PATTERN = [[0, 0.6], [1.2, 2.6], [3.2, 3.8], [4.4, 6]];
const LAMP_PHASE = { rus: 0, alg: 3 };
const LAMP_WINDOW = (() => {
  const mid = (LIGHT.t0 + LIGHT.t1) / 2;
  return { rus: [LIGHT.t0, mid], alg: [mid, LIGHT.t1] };
})();
export function lampOn(t, id) {
  const [a, b] = LAMP_WINDOW[id];
  if (t < a || t >= b) return false;
  const u = ((t - a) * 2.2 + LAMP_PHASE[id]) % 8;
  return LAMP_PATTERN.some(([from, to]) => u >= from && u < to);
}

// Sound cues the scene plays, in time order: one long blast of ALG's horn at each EXECUTE (the ships start
// the maneuver), and a click at the start of every flash of the lamp.
// {t, kind: 'horn' | 'click', ship, len (s, horns)}
export const CUES = (() => {
  const cues = [];
  for (const p of PHASES) cues.push({ t: p.tx, kind: 'horn', ship: 'alg', len: 2.2 });
  for (const id of ['rus', 'alg']) {
    let on = false;
    for (let t = LAMP_WINDOW[id][0]; t < LAMP_WINDOW[id][1]; t += 0.05) {
      const now = lampOn(t, id);
      if (now && !on) cues.push({ t, kind: 'click', ship: id });
      on = now;
    }
  }
  return cues.sort((x, y) => x.t - y.t);
})();

// --- Guide, ordered course and station ---------------------------------------------------------
// The guide is the ship the other keeps station on: ALG from the start (G FORM ALG), RUS once G FORM RUS
// executes, ALG again from CORPEN (G FORM ALG). A station is the other ship's range and bearing from it.
const GUIDES = { form1: 'alg', gform: 'rus', corpen: 'alg' };
export function guideAt(t) {
  let g = 'alg';
  for (const p of PHASES) if (GUIDES[p.id] && t >= p.tx) g = GUIDES[p.id];
  return g;
}
export function stationAt(t) {
  const guide = guideAt(t);
  const other = guide === 'alg' ? 'rus' : 'alg';
  return { guide, other, ...relation(t, guide, other) };
}
// The course (deg) and speed (kn) a ship has been ordered to at time t; she may still be turning or
// working up to them.
export function orderedAt(id, t) {
  let course = 0;
  let speed = 12;
  for (const o of id === 'rus' ? RUS_ORDERS : ALG_ORDERS) {
    if (o.t > t) break;
    if (o.course !== undefined) course = o.course;
    if (o.speed !== undefined) speed = o.speed;
  }
  return { course, speed };
}

// --- Debrief: how each order went, measured once at import ---------------------------------------
// `settle` is the time from execution to arrival; for a station change, `error` is how far the other
// ship was from the ordered station (yards, degrees) at arrival.
const STATIONS = { gform: [180, STATION_YD], form120: [120, STATION_YD], corpen: [0, STATION_YD] }; // other ship from the guide
export const DEBRIEF = PHASES.filter((p) => p.id !== 'form1' && p.id !== 'station').map((p) => {
  const row = { id: p.id, label: p.label, settle: p.ta - p.tx };
  if (STATIONS[p.id]) {
    const [brg, yd] = STATIONS[p.id];
    const st = stationAt(p.ta);
    row.error = { yd: st.range / YD - yd, deg: ((st.bearing - brg + 540) % 360) - 180 };
  }
  if (p.id === 'skim') row.pass = PASS.range;
  return row;
});

export const exercise = {
  tEnd,
  phases: PHASES,
  light: LIGHT,
  flags: FLAGS,
  pass: PASS,
  events: [
    ...PHASES.map((p, i) => ({ t: i === 0 ? 0 : p.t, label: p.label })), // the first is the start of the exercise
    { t: PASS.t, label: 'Closest pass' },
  ].sort((a, b) => a.t - b.t),
};

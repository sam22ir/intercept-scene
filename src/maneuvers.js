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
  { id: 'station', t: 30, label: 'Form 1', title: 'INITIAL FORMATION : FORM 1', note: 'The unit sails alongside ALG: 1,000 yds ahead and 500 yds to starboard, on her course and speed.',
    serial: [{ lines: [GO, 'FORM 1- STATION 1 DESIG ALG –', 'STATION 2 DESIG RUS – S SPEED 16', 'B CORPEN 360 – B SPEED 12 –', 'G FORM ALG -TA12-1-10', START_STBY] }] },
  { id: 'stbd', t: 60, label: 'Turn stbd 90°', title: 'TURN STBD 9', note: 'A turn together: both ships put the rudder over at the same moment and come to 090; the true bearing between them stays the same.',
    serial: [{ lines: [GO, 'TURN STBD 9 .', START_STBY] }] },
  { id: 'port', t: 180, label: 'Turn port 90°', title: 'TURN PORT 9',
    serial: [{ lines: ['AS this is AC EXECUTE TO FOLLOW', 'TURN PORT 9 .', START_STBY] }] },
  { id: 'gform', t: 290, label: 'G form RUS', title: 'G FORM', note: 'ALG slows to 6 kn; RUS runs at sierra, 15 kn, out to port and in again.',
    serial: [{ lines: [GO, 'B CORPEN 360 – B SPEED 12 –', 'G FORM RUS – TA12-1- 10', START_STBY] }] },
  { id: 'turn045', t: 596, label: 'Turn stbd 045', title: 'TURN STBD 045', note: 'Both ships turn together to starboard to course 045 and keep their station.',
    serial: [{ lines: [GO, 'TURN STBD 045 – B SPEED 12 –', 'TA 12-1- 10', START_STBY] }] },
  { id: 'form120', t: 683, label: 'Form 120', title: 'FORM 120', note: 'ALG makes 10 kn; RUS drops back at 6 kn.',
    serial: [{ lines: [GO, 'FORM 120 – B SPEED 10 –', 'TA 12-1- 10', START_STBY] }] },
  { id: 'corpen', t: 966, label: 'Corpen stbd 45°', title: 'CORPEN STBD 4 ANS', note: 'A wheel of 45 degrees to starboard: the formation turns as one block. ALG, the guide again, wheels to course 090 at 12 kn; RUS, on the outside of the turn, makes 15 kn and keeps her gisement and distance the whole way, so the two stay parallel and end on 090, RUS 345 from ALG. (MTP 1(D) Vol. II 701 does not allow a wheel on a line of bearing; the deck orders it here.)',
    serial: [{ lines: [GO, 'CORPEN STBD 4 ANS – B SPEED 12–', 'G FORM ALG – TA 12-1- 10', START_STBY] }] },
  { id: 'fcol', t: 1227, label: 'Form 1', title: 'FORM 1', note: 'Column in order of sequence numbers on the unit: the unit leads, ALG 500 yds astern of her and RUS 500 yds astern of ALG.',
    serial: [{ lines: [GO, 'FORM 1 – STATION 1 DESIG UNIT –', 'STATION 2 DESIG ALG – STATION 3 DESIG RUS –', 'G FORM UNIT – TA 12-1- 10', START_STBY] }] },
  { id: 'fdia', t: 1472, label: 'Form D', title: 'FORM D', note: 'Diamond, formed from the column: the unit leads and is the guide, ALG forms on her port quarter and RUS on her starboard quarter.',
    serial: [{ lines: [GO, 'FORM D –', 'G FORM UNIT – TA 12-1- 10', START_STBY] }] },
  { id: 'fline3', t: 1690, label: 'Form 3', title: 'FORM 3', note: 'Line abreast to starboard in order of sequence numbers: the unit on the left, ALG 500 yds to starboard of her and RUS 500 yds beyond.',
    serial: [{ lines: [GO, 'FORM 3 – STATION 1 DESIG UNIT –', 'STATION 2 DESIG ALG – STATION 3 DESIG RUS –', 'G FORM UNIT – TA 12-1- 10', START_STBY] }] },
  { id: 'fcol2', t: 1942, label: 'Form 2', title: 'FORM 2', note: 'Column in the reverse order of sequence numbers: RUS leads, ALG follows and the unit, the guide, is last.',
    serial: [{ lines: [GO, 'FORM 2 –', 'G FORM UNIT – TA 12-1- 10', START_STBY] }] },
  { id: 'screenk', t: 2279, label: 'Screen K', title: 'SCREEN K', note: 'The unit holds course 090 at 6 kn as the screen centre. ALG takes the sector 330 to 030 and RUS the sector 150 to 210, each 1,500 to 3,500 yards out, and patrol them.',
    serial: [{ lines: [GO, 'SCREEN K–ZZ–3303–01 ANS 03 ANS  ALG', 'SCREEN K–ZZ–1521–01 ANS 03 ANS  RUS', 'G CORPEN 090 – G SPEED 6 –', START_STBY] }] },
  { id: 'screenm', t: 2578, label: 'Screen M', title: 'SCREEN M', note: 'Take station within your sector: ALG the clockwise half (000 to 030), RUS the counterclockwise half (150 to 180).',
    serial: [{ lines: [GO, 'ALG  SCREEN M 3', 'RUS  SCREEN M 4', START_STBY] }] },
  { id: 'form345', t: 2795, label: 'Form 345', title: 'FORM 345', note: 'Form on true bearing 345 from the guide ALG: ALG holds 500 yds ahead of the unit and RUS comes to 500 yds north-northwest of her, ready for the serials and the skim.',
    serial: [{ lines: [GO, 'FORM 345 – B SPEED 6 –', 'G FORM ALG – TA 12-1- 10', START_STBY] }] },
  { id: 'light', t: 3475, label: 'Flashing light', title: 'FLASHING LIGHT',
    serial: [{ head: 'START SERIAL:', lines: [GO, 'EX3 – 9 desig 12030–', 'G SPEED 6'] }, { head: 'END SERIAL :', lines: [GO, 'EX3 – 4 desig 12030'] }] },
  { id: 'flags', t: 3615, label: 'Flag hoist', title: 'FLAG HOIST',
    serial: [{ head: 'START SERIAL:', lines: [GO, 'EX3 – 9 desig 12040 –', 'G SPEED 6'] }, { head: 'END SERIAL :', lines: [GO, 'EX3 – 4 desig 12040'] }] },
  { id: 'skim', t: 3755, label: 'Skimming past', title: 'SKIMMING PAST', note: 'RUS makes sierra, turns away to starboard and comes back past ALG.',
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
// CORPEN STBD 4 ANS (a wheel of 45 degrees): the formation turns as one rigid block. ALG, the guide, wheels to 090 at
// 12 kn on a wide circle; RUS, on the outside of the turn, keeps her gisement (her bearing relative to the heading) and
// her distance the whole way, so both ships are parallel at every moment and RUS ends 345 from ALG (the 300 she had,
// turned by 45). The wheel rate is the one that puts RUS at sierra, 15 kn, on her larger circle.
const WHEEL_KN = 12;
const WHEEL_OUTER_KN = 15;
// SKIMMING PAST: RUS makes 15 kn east, then a wide right turn (a U-turn whose diameter takes it from
// 500 yds north of ALG to 100 m south of it) and runs back west past ALG.
const SKIM_SPEED = 15; // kn
const SKIM_RADIUS = (FORMATION_RANGE * Math.cos(rad(15)) + 100) / 2; // m: a U-turn from the station (RUS 15 degrees off ALG's beam) to 100 m past ALG
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

const FULL = 6400; // s baked; the exercise ends well before
const ALG_START = { x: 0, z: 0, psi: 0, v: 12 * KT };
const RUS_START = { x: -FORMATION_RANGE, z: 0, psi: 0, v: 12 * KT };
// The wheel: RUS's place in ALG's frame (ahead, to starboard) when CORPEN executes, and the turn rate that makes the
// circle through RUS (centred on ALG's starboard side) run at WHEEL_OUTER_KN while ALG runs at WHEEL_KN.
const K_WHEEL = Math.round(X.corpen / DT);
const WHEEL_REL = (() => {
  const g = integrate(ALG_ORDERS, X.corpen, ALG_START)[K_WHEEL];
  const r = integrate(RUS_ORDERS, X.corpen, RUS_START)[K_WHEEL];
  const dx = r.x - g.x;
  const dz = r.z - g.z;
  return { fwd: dx * Math.cos(g.psi) + dz * Math.sin(g.psi), stb: -dx * Math.sin(g.psi) + dz * Math.cos(g.psi) };
})();
const WHEEL_R = (() => { // radius of ALG's circle: |RUS - centre| = (outer / guide) * R, the centre R to starboard of ALG
  const q = (WHEEL_OUTER_KN / WHEEL_KN) ** 2 - 1;
  const b = 2 * WHEEL_REL.stb;
  const c = WHEEL_REL.fwd ** 2 + WHEEL_REL.stb ** 2;
  return (-b + Math.sqrt(b * b + 4 * q * c)) / (2 * q);
})();
ALG_ORDERS.push({ t: X.corpen, course: 90, dir: 'stbd', speed: WHEEL_KN, rate: deg((WHEEL_KN * KT) / WHEEL_R) }); // CORPEN STBD 4 ANS, B SPEED 12
RUS_ORDERS.splice(RUS_ORDERS.findIndex((o) => o.t >= X.corpen), 0, { t: X.corpen, course: 90, dir: 'stbd', speed: WHEEL_KN });
const ALG_FULL = integrate(ALG_ORDERS, FULL, ALG_START);
const RUS_FULL = integrate(RUS_ORDERS, FULL, RUS_START);
// The third ship, the unit the others work around: it keeps ALG's course and speed, one station (500 yds) to
// starboard of her and two stations (1,000 yds) ahead, so it sails straight alongside whatever ALG does and is
// clear of every lane the other two use (RUS passes it no closer than about 470 m). From the screens on it holds
// course 090 at 6 kn as the screen centre.
// The first order that steers the screen ships (FORM 1, FORM 2, FORM 3, FORM D, SCREEN K, SCREEN M or FORM 345, whichever comes first).
const X_STEER = Math.min(X.fcol, X.fdia, X.fline3, X.fcol2, X.screenk, X.screenm, X.form345);
// From CORPEN to the formations on the unit RUS is held rigidly in ALG's frame: through the wheel and after it she keeps
// the same place relative to ALG's heading, her speed being whatever that takes.
for (let k = K_WHEEL, kEnd = Math.round(X_STEER / DT); k <= kEnd; k++) {
  const g = ALG_FULL[k];
  const c = Math.cos(g.psi);
  const sn = Math.sin(g.psi);
  RUS_FULL[k] = { t: k * DT, x: g.x + c * WHEEL_REL.fwd - sn * WHEEL_REL.stb, z: g.z + sn * WHEEL_REL.fwd + c * WHEEL_REL.stb, psi: g.psi, v: g.v };
}
for (let k = K_WHEEL + 1, kEnd = Math.round(X_STEER / DT); k <= kEnd; k++) {
  const a = RUS_FULL[k - 1];
  const b = RUS_FULL[k];
  b.v = Math.hypot(b.x - a.x, b.z - a.z) / DT;
}
const UNIT_ORDERS = [...ALG_ORDERS, { t: X_STEER, speed: 6 }]; // it slows to 6 kn as the formations begin
const UNIT_FULL = integrate(UNIT_ORDERS, FULL, { x: 2 * FORMATION_RANGE, z: FORMATION_RANGE, psi: 0, v: 12 * KT });
export const SHIP_IDS = ['alg', 'rus', 'unit'];

// --- Sector screens (MTP 1(D) Vol. II: SCREEN K forms a sector screen, SCREEN M takes a station within the sector) --
// Each screen ship is given a sector round the screen centre (here the unit, which sails straight on at 6 kn): two
// true bearings (left, then right, clockwise) and an inner and an outer depth. It patrols widely inside it, and
// never closer than 500 yards to a boundary. SCREEN M then narrows the sector to its clockwise or counterclockwise
// half. The patrol is a slow smooth sweep, a pure function of t, and the ship steers for it (turn rate, speed and
// acceleration as for the other orders); everything is baked once with the rest.
export const SECTOR_MARGIN = 500 * YD;
const D1 = 1500 * YD;
const D2 = 3500 * YD;
export const SECTORS = {
  screenk: { alg: { b1: 330, b2: 30, d1: D1, d2: D2 }, rus: { b1: 150, b2: 210, d1: D1, d2: D2 } },
  screenm: { alg: { b1: 0, b2: 30, d1: D1, d2: D2 }, rus: { b1: 150, b2: 180, d1: D1, d2: D2 } },
};
const sectorSpan = (sec) => (sec.b2 - sec.b1 + 360) % 360;
function sectorAt(id, t) {
  return (t >= X.screenm ? SECTORS.screenm : SECTORS.screenk)[id];
}
// --- Formations on the unit (FORM 1, FORM D, FORM 3, FORM 2, the screens, FORM 345): each ship steers for her station,
// given in station lengths (500 yds) ahead and to starboard of the unit, on the unit's course. ---
export const FORMS = {
  fcol: { alg: [-1, 0], rus: [-2, 0] }, // column in order: unit, ALG, RUS
  fdia: { alg: [-Math.SQRT1_2, -Math.SQRT1_2], rus: [-Math.SQRT1_2, Math.SQRT1_2] }, // diamond: port and starboard quarters
  fline3: { alg: [0, 1], rus: [0, 2] }, // line abreast to starboard
  fcol2: { alg: [1, 0], rus: [2, 0] }, // column in reverse order: RUS, ALG, unit
  // FORM 345: form on true bearing 345 from the guide ALG, one station off: RUS runs to 500 yds north-northwest of her,
  // which is where the skim starts from. (ALG goes 2,000 yds ahead of the unit, where she is clear of everything.)
  form345: { alg: [4, 0], rus: [4 - Math.sin(rad(15)), -Math.cos(rad(15))] },
};
const STEERED = ['fcol', 'fdia', 'fline3', 'fcol2', 'screenk', 'screenm', 'form345']; // the orders that steer the screen ships
function steeredPhase(t) {
  let cur = null;
  for (const p of PHASES) if (STEERED.includes(p.id) && t >= p.tx) cur = p.id;
  return cur;
}
export function formationKey(t) {
  const k = steeredPhase(t);
  return k && FORMS[k] ? k : null;
}
export function stationPoint(id, key, t) {
  const u = lookup(UNIT_FULL, t);
  const [fwd, stb] = FORMS[key][id];
  const fx = Math.cos(u.psi);
  const fz = Math.sin(u.psi); // the unit's heading (x North, z East)
  return { x: u.x + (fx * fwd - fz * stb) * FORMATION_RANGE, z: u.z + (fz * fwd + fx * stb) * FORMATION_RANGE };
}
function targetPoint(id, t) {
  const key = formationKey(t);
  return key ? stationPoint(id, key, t) : patrolPoint(id, t);
}
function patrolPoint(id, t) {
  const sec = sectorAt(id, t);
  const span = sectorSpan(sec);
  const centre = sec.b1 + span / 2;
  const dm = (sec.d1 + sec.d2) / 2;
  const margin = deg(SECTOR_MARGIN / dm); // 500 yards, in degrees at the middle depth
  const ampB = Math.max(0, Math.min(span / 2 - margin, 12));
  const ampD = Math.min((sec.d2 - sec.d1) / 2 - SECTOR_MARGIN * 0.5, 350);
  const ph = id === 'alg' ? 0.7 : 2.4;
  const bearing = centre + ampB * Math.sin((2 * Math.PI * t) / 900 + ph);
  const depth = dm + ampD * Math.sin((2 * Math.PI * t) / 620 + ph * 1.7);
  const u = lookup(UNIT_FULL, t);
  return { x: u.x + depth * Math.cos(rad(bearing)), z: u.z + depth * Math.sin(rad(bearing)) };
}
// From the first of these orders (FORM 1, on the unit) to the start of the skim, ALG and RUS no longer follow order
// lists: each steers for her station or patrol point, both together so that each gives way to the other and to the
// unit (a ship that would pass within 300 m ahead of an obstacle bends away to starboard). From the skim on the
// orders take over again from wherever the ships are.
const AVOID = 0; // no avoidance field: the stations and the order of the formations keep the ships apart (a test checks the gaps)
function steerStations() {
  const kA = Math.round(X_STEER / DT);
  const kB = Math.round(X.skim / DT);
  const rows = { alg: ALG_FULL, rus: RUS_FULL };
  let st = { alg: { ...ALG_FULL[kA] }, rus: { ...RUS_FULL[kA] } };
  for (let k = kA; k < kB; k++) {
    const t = k * DT;
    const u = lookup(UNIT_FULL, t);
    const unitKn = u.v / KT;
    const forming = formationKey(t) !== null;
    const next = {};
    for (const id of ['alg', 'rus']) {
      let { x, z, psi, v } = st[id];
      const other = st[id === 'alg' ? 'rus' : 'alg'];
      const P = targetPoint(id, t);
      let ux = P.x - x;
      let uz = P.z - z;
      const dist = Math.hypot(ux, uz) || 1;
      ux /= dist;
      uz /= dist;
      for (const ob of [u, other]) {
        const qx = ob.x - x;
        const qz = ob.z - z;
        const d = Math.hypot(qx, qz);
        if (dist > 150 && d > 1 && d < AVOID && qx * ux + qz * uz > 0) { // only in transit, never while keeping station
          const w = (AVOID - d) / AVOID;
          ux += -(qx / d) * w * 2 - Math.sin(psi) * w * 1.5;
          uz += -(qz / d) * w * 2 + Math.cos(psi) * w * 1.5;
        }
      }
      // Far from her station she steers straight for it (and slows to turn inside it when it is off her beam). Near it
      // she keeps station like a ship in formation: the unit's course, with the speed and the heading eased by how far
      // ahead and abeam of her the station is. The two are blended between 150 and 250 m.
      const wrap = (q) => ((((q + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) - Math.PI;
      const minKn = forming ? 2 : 5;
      const farDiff = wrap(Math.atan2(uz, ux) - psi);
      const aim = Math.min(Math.max(1 - Math.abs(farDiff) / rad(60), 0), 1);
      const farKn = Math.min(15, Math.max(minKn, unitKn + dist / (forming ? 22 : 80)));
      const farKnSlow = minKn + (farKn - minKn) * aim;
      const fx = Math.cos(u.psi);
      const fz = Math.sin(u.psi);
      const ef = (P.x - x) * fx + (P.z - z) * fz; // station ahead of the ship (m)
      const es = (P.x - x) * -fz + (P.z - z) * fx; // station to starboard of the ship (m)
      const nearKn = Math.min(15, Math.max(minKn, unitKn + ef / 20));
      const nearDiff = wrap(u.psi + Math.max(-1, Math.min(1, es / 90)) * rad(45) - psi);
      const w = Math.min(Math.max((dist - 150) / 100, 0), 1);
      const diff = wrap(nearDiff + w * wrap(farDiff - nearDiff));
      const rate = rad(TURN_RATE) * DT;
      const dpsi = Math.abs(diff) <= rate ? diff : Math.sign(diff) * rate;
      const vt = (nearKn + w * (farKnSlow - nearKn)) * KT;
      const dv = Math.abs(vt - v) <= ACCEL * DT ? vt - v : Math.sign(vt - v) * ACCEL * DT;
      const mid = psi + dpsi / 2;
      const vm = v + dv / 2;
      x += Math.cos(mid) * vm * DT;
      z += Math.sin(mid) * vm * DT;
      psi += dpsi;
      v += dv;
      next[id] = { x, z, psi, v };
      rows[id][k + 1] = { t: (k + 1) * DT, x, z, psi, v };
    }
    st = next;
  }
  // The orders take over again at the skim, from where the ships are.
  for (const [id, orders] of [['alg', ALG_ORDERS], ['rus', RUS_ORDERS]]) {
    let { x, z, psi, v } = st[id];
    const target = { course: deg(psi), dir: undefined, rate: undefined };
    let speedTarget = v / KT;
    let i = orders.findIndex((o) => o.t >= kB * DT - 1e-9);
    if (i < 0) i = orders.length;
    for (let k = kB; k < rows[id].length - 1; k++) {
      const t = k * DT;
      while (i < orders.length && orders[i].t <= t + 1e-9) {
        const o = orders[i++];
        if (o.course !== undefined) { target.course = o.course; target.dir = o.dir; target.rate = o.rate; }
        if (o.speed !== undefined) speedTarget = o.speed;
      }
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
      rows[id][k + 1] = { t: (k + 1) * DT, x, z, psi, v };
    }
  }
}
steerStations();
// The bearing (deg) and range (m) of a ship from the screen centre (the unit), and whether she is inside her sector.
export function screenRel(id, t) {
  const a = shipState(id, t);
  const u = shipState('unit', t);
  const dx = a.x - u.x;
  const dz = a.z - u.z;
  return { range: Math.hypot(dx, dz), bearing: ((deg(Math.atan2(dz, dx)) % 360) + 360) % 360 };
}
export function inSector(id, t, key) {
  const sec = SECTORS[key][id];
  const r = screenRel(id, t);
  const off = (r.bearing - sec.b1 + 360) % 360;
  return off <= sectorSpan(sec) && r.range >= sec.d1 && r.range <= sec.d2;
}

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
export const tEnd = Math.ceil(Math.max(tPass + 100, X.screenm + 420) / 5) * 5;

// Unwrap each heading so interpolation never spins the long way round.
for (const rows of [ALG_FULL, RUS_FULL, UNIT_FULL]) {
  for (let i = 1; i < rows.length; i++) {
    let d = rows[i].psi - rows[i - 1].psi;
    while (d > Math.PI) { rows[i].psi -= 2 * Math.PI; d -= 2 * Math.PI; }
    while (d < -Math.PI) { rows[i].psi += 2 * Math.PI; d += 2 * Math.PI; }
  }
}

// --- Public API -------------------------------------------------------------------------------
// A ship's state at time t: x (North, m), z (East, m), heading (rad, clockwise from North), speed (m/s).
export function shipState(id, t, out = {}) {
  const s = lookup(id === 'rus' ? RUS_FULL : id === 'unit' ? UNIT_FULL : ALG_FULL, t);
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
// Both screen ships within 70 m of their stations on the unit.
const atStation = (t, key) => ['alg', 'rus'].every((id) => {
  const a = shipState(id, t);
  const P = stationPoint(id, key, t);
  return Math.hypot(a.x - P.x, a.z - P.z) < 70;
});
const ARRIVAL = {
  form1: (p) => p.tx,
  station: (p) => p.tx,
  stbd: (p) => settledAfter(p.tx, (t) => both(t, 90, 0.6)),
  port: (p) => settledAfter(p.tx, (t) => both(t, 0, 0.6)),
  gform: (p) => settledAfter(p.tx, (t) => both(t, 0, 1) && onStation(t, 180, STATION_YD, 4, 0.8)),
  turn045: (p) => settledAfter(p.tx, (t) => both(t, 45, 0.6)),
  form120: (p) => settledAfter(p.tx, (t) => both(t, 45, 1) && onStation(t, 120, STATION_YD, 5, 1.2)),
  light: () => LIGHT.t1,
  corpen: (p) => settledAfter(p.tx, (t) => both(t, 90, 1) && onStation(t, 165, STATION_YD, 8, 1.5)),
  flags: () => FLAGS.t1,
  skim: () => PASS.t,
  screenk: (p) => settledAfter(p.tx, (t) => inSector('alg', t, 'screenk') && inSector('rus', t, 'screenk')),
  screenm: (p) => settledAfter(p.tx, (t) => inSector('alg', t, 'screenm') && inSector('rus', t, 'screenm')),
  fcol: (p) => settledAfter(p.tx, (t) => atStation(t, 'fcol')),
  fdia: (p) => settledAfter(p.tx, (t) => atStation(t, 'fdia')),
  fline3: (p) => settledAfter(p.tx, (t) => atStation(t, 'fline3')),
  fcol2: (p) => settledAfter(p.tx, (t) => atStation(t, 'fcol2')),
  form345: (p) => settledAfter(p.tx, (t) => atStation(t, 'form345')),
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
// the maneuver), a blast from RUS and an answer from ALG at the close pass, and a click at the start of every flash of the lamp.
// {t, kind: 'horn' | 'click', ship, len (s, horns)}
export const CUES = (() => {
  const cues = [];
  for (const p of PHASES) cues.push({ t: p.tx, kind: 'horn', ship: 'alg', len: 2.2 });
  // The close pass: RUS sounds her horn as she comes up to ALG and ALG answers just after the pass.
  cues.push({ t: PASS.t - 2, kind: 'horn', ship: 'rus', len: 2.4 });
  cues.push({ t: PASS.t + 1, kind: 'horn', ship: 'alg', len: 2.4 });
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
export const STATIONS = { gform: [180, STATION_YD], form120: [120, STATION_YD], corpen: [345, STATION_YD] }; // other ship from the guide
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

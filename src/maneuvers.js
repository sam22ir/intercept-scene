// Naval maneuvers: the second mission, after the "Tactical maneuvers" briefing deck. Two frigates,
// ALG and RUS, start in FORM 1 (a column, 500 yards apart, heading 000) and run through a series
// of signalled maneuvers: turn together, change station, flashing-light and flag-hoist serials,
// and a final skim past on reciprocal courses. No drone and no missile.
//
// It comes in two sizes (`DRILL_SHIPS`, read once at import from globalThis.__DRILL_SHIPS, set by the start
// screen's "2 ships" / "3 ships" tiles): with 3 ships a larger unit follows the column and the middle of the
// exercise is the formations on her and the sector screens; with 2 ships (the briefing deck alone) there is no
// unit, and FORM 120 is followed by FORM 345 (RUS on true bearing 345 from ALG, both 090 at 6 kn), which puts the
// ships where the serials and the skim start from.
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
export const DRILL_SHIPS = (() => {
  try { return Number(globalThis.__DRILL_SHIPS) === 2 ? 2 : 3; } catch { return 3; }
})();
const THREE = DRILL_SHIPS === 3;

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
  { id: 'station', t: 30, label: 'Form 1', title: 'INITIAL FORMATION : FORM 1', note: THREE ? 'The unit follows from behind: she is station 3 of the column, 500 yds astern of RUS, on the same course and speed.' : 'ALG leads the column and is the guide; RUS is station 2, 500 yds astern of her.',
    serial: [{ lines: [GO, 'FORM 1- STATION 1 DESIG ALG –', 'STATION 2 DESIG RUS – S SPEED 16', 'B CORPEN 315 – B SPEED 12 –', 'G FORM ALG -TA12-1-10', START_STBY] }] },
  { id: 'corpen', t: 60, label: 'Corpen stbd 45°', title: 'CORPEN STBD 4 ANS', note: 'A wheel of 45 degrees to starboard in single column: ALG, the leading ship and the guide, wheels to course 000; RUS holds on and turns in her wake at the same point, so the column ends on 000 with RUS 500 yds astern of ALG.',
    serial: [{ lines: [GO, 'CORPEN STBD 4 ANS – B SPEED 12 –', 'G FORM ALG – TA 12-1- 10', START_STBY] }] },
  { id: 'stbd', t: 286, label: 'Turn stbd 90°', title: 'TURN STBD 9', note: 'A turn together: both ships put the rudder over at the same moment and come to 090; the true bearing between them stays the same.',
    serial: [{ lines: [GO, 'TURN STBD 9 .', START_STBY] }] },
  { id: 'port', t: 401, label: 'Turn port 90°', title: 'TURN PORT 9',
    serial: [{ lines: ['AS this is AC EXECUTE TO FOLLOW', 'TURN PORT 9 .', START_STBY] }] },
  { id: 'gform', t: 516, label: 'G form RUS', title: 'G FORM', note: 'ALG slows to 6 kn; RUS runs at sierra, 15 kn, out to port and in again.',
    serial: [{ lines: [GO, 'B CORPEN 360 – B SPEED 12 –', 'G FORM RUS – TA12-1- 10', START_STBY] }] },
  { id: 'turn045', t: 812, label: 'Turn stbd 045', title: 'TURN STBD 045', note: 'Both ships turn together to starboard to course 045 and keep their station.',
    serial: [{ lines: [GO, 'TURN STBD 045 – B SPEED 12 –', 'TA 12-1- 10', START_STBY] }] },
  { id: 'form120', t: 890, label: 'Form 120', title: 'FORM 120', note: 'ALG makes 10 kn; RUS drops back at 6 kn.',
    serial: [{ lines: [GO, 'FORM 120 – B SPEED 10 –', 'TA 12-1- 10', START_STBY] }] },
  { ships: 3, id: 'fcol', t: 1162, label: 'Form 1', title: 'FORM 1', note: 'Column in order of sequence numbers on the unit: the unit leads, ALG 500 yds astern of her and RUS 500 yds astern of ALG.',
    serial: [{ lines: [GO, 'FORM 1 – STATION 1 DESIG UNIT –', 'STATION 2 DESIG ALG – STATION 3 DESIG RUS –', 'G FORM UNIT – G CORPEN 090 – G SPEED 6 –', 'TA 12-1- 10', START_STBY] }] },
  { ships: 3, id: 'fdia', t: 1476, label: 'Form D', title: 'FORM D', note: 'Diamond, formed from the column: the unit leads and is the guide, ALG forms on her port quarter and RUS on her starboard quarter.',
    serial: [{ lines: [GO, 'FORM D –', 'G FORM UNIT – TA 12-1- 10', START_STBY] }] },
  { ships: 3, id: 'fline3', t: 1684, label: 'Form 3', title: 'FORM 3', note: 'Line abreast to starboard in order of sequence numbers: the unit on the left, ALG 500 yds to starboard of her and RUS 500 yds beyond.',
    serial: [{ lines: [GO, 'FORM 3 – STATION 1 DESIG UNIT –', 'STATION 2 DESIG ALG – STATION 3 DESIG RUS –', 'G FORM UNIT – TA 12-1- 10', START_STBY] }] },
  { ships: 3, id: 'fcol2', t: 1936, label: 'Form 2', title: 'FORM 2', note: 'Column in the reverse order of sequence numbers: RUS leads, ALG follows and the unit, the guide, is last.',
    serial: [{ lines: [GO, 'FORM 2 –', 'G FORM UNIT – TA 12-1- 10', START_STBY] }] },
  { ships: 3, id: 'screenk', t: 2264, label: 'Screen K', title: 'SCREEN K', note: 'The unit holds course 090 at 6 kn as the screen centre. RUS takes the sector 330 to 030 (to the north, on the side she will need for the skim) and ALG the sector 150 to 210, each 1,500 to 3,500 yards out, and patrol them.',
    serial: [{ lines: [GO, 'SCREEN K–ZZ–3303–01 ANS 03 ANS  RUS', 'SCREEN K–ZZ–1521–01 ANS 03 ANS  ALG', 'G CORPEN 090 – G SPEED 6 –', START_STBY] }] },
  { ships: 3, id: 'screenm', t: 2540, label: 'Screen M', title: 'SCREEN M', note: 'Take station within your sector: RUS the counterclockwise half (330 to 000), ALG the clockwise half (180 to 210).',
    serial: [{ lines: [GO, 'RUS  SCREEN M 4', 'ALG  SCREEN M 3', START_STBY] }] },
  { ships: 3, id: 'form345', t: 2640, label: 'Final form 1', title: 'FORM 1', note: 'The final column: ALG leads and is the guide, the unit 500 yds astern of her, both on 090 at 6 kn. RUS takes station on true bearing 345 from ALG, 500 yds, ready for the serials and for the skim past both ships.',
    serial: [{ lines: [GO, 'FORM 1 – STATION 1 DESIG ALG –', 'STATION 2 DESIG UNIT –', 'RUS FORM 345 – B SPEED 6 –', 'G FORM ALG – TA 12-1- 10', START_STBY] }] },
  // Two ships: no unit, so FORM 120 is followed straight away by FORM 345 (a FORM on a true bearing from the guide).
  { ships: 2, id: 'form345', t: 1162, label: 'Form 345', title: 'FORM 345', note: 'ALG, the guide, comes to 090 at 6 kn. RUS takes station on true bearing 345 from ALG, 500 yds, ready for the serials and for the skim.',
    serial: [{ lines: [GO, 'RUS FORM 345 –', 'G CORPEN 090 – G SPEED 6 –', 'G FORM ALG – TA 12-1- 10', START_STBY] }] },
  { id: 'light', t: 3378, t2: 1369, label: 'Flashing light', title: 'FLASHING LIGHT',
    serial: [{ head: 'START SERIAL:', lines: [GO, 'EX3 – 9 desig 12030–', 'G SPEED 6'] }, { head: 'END SERIAL :', lines: [GO, 'EX3 – 4 desig 12030'] }] },
  { id: 'flags', t: 3508, t2: 1499, label: 'Flag hoist', title: 'FLAG HOIST',
    serial: [{ head: 'START SERIAL:', lines: [GO, 'EX3 – 9 desig 12040 –', 'G SPEED 6'] }, { head: 'END SERIAL :', lines: [GO, 'EX3 – 4 desig 12040'] }] },
  { id: 'skim', t: 3638, t2: 1629, label: 'Skimming past', title: 'SKIMMING PAST', note: 'RUS makes sierra, turns away to starboard and comes back past ALG.',
    serial: [{ head: 'START SERIAL:', lines: [GO, 'EX3 – 9 desig 12050'] }, { head: 'END SERIAL :', lines: ['EX3 – 4 desig 12050'] }] },
].filter((p) => !p.ships || p.ships === DRILL_SHIPS);
// `t2` is an announcement time for the two-ship drill, where the orders after FORM 120 come sooner.
for (const p of PHASES) { if (!THREE && p.t2 !== undefined) p.t = p.t2; delete p.t2; delete p.ships; p.tx = p.t + STANDBY_DEFAULT + LEAD; p.t = p.tx - STANDBY; }
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
// CORPEN STBD 4 ANS, a wheel in single column (MTP 1(D) Vol. II 700a(1)): the leading ship, ALG, alters to the new
// course and is the guide; the ships astern follow round in her wake, so RUS holds on and puts her rudder over when
// she reaches the point where ALG turned, one station (500 yds) later at 12 kn. The column starts on 315 so that it
// wheels to 000, the deck's base course for everything after.
const START_COURSE = 315;
const WAKE_DELAY = FORMATION_RANGE / (12 * KT); // s for RUS to reach ALG's turning point
// SKIMMING PAST: RUS makes 15 kn east, then a wide right turn (a U-turn whose diameter takes it from
// 500 yds north of ALG to 100 m south of it) and runs back west past ALG.
const SKIM_SPEED = 15; // kn
const SKIM_RADIUS = (FORMATION_RANGE * Math.cos(rad(15)) + 100) / 2; // m: a U-turn from the station (RUS 15 degrees off ALG's beam) to 100 m past ALG
const SKIM_RUN = 250; // s eastward before the U-turn, so the two meet on the way back

const COMMON = [
  { t: X.stbd, course: 90, dir: 'stbd' }, // TURN STBD 9
  { t: X.port, course: 0, dir: 'port' }, // TURN PORT 9
];
const ALG_ORDERS = [
  { t: 0, course: START_COURSE, speed: 12 },
  { t: X.corpen, course: 0, dir: 'stbd' }, // CORPEN STBD 4 ANS: the leader wheels
  ...COMMON,
  { t: X.gform, speed: 6 },
  { t: X.gform + G_RESUME, speed: 12 },
  { t: X.turn045, course: 45, dir: 'stbd' }, // TURN 045
  { t: X.form120, speed: 10 }, // B SPEED 10
  ...(THREE ? [] : [{ t: X.form345, course: 90, speed: 6 }]), // two ships: G CORPEN 090, G SPEED 6 (RUS is steered to her station)
];
const RUS_ORDERS = [
  { t: 0, course: START_COURSE, speed: 12 },
  { t: X.corpen + WAKE_DELAY, course: 0, dir: 'stbd' }, // and RUS follows round in her wake
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
const ALG_START = { x: 0, z: 0, psi: rad(START_COURSE), v: 12 * KT };
const RUS_START = { x: -FORMATION_RANGE * Math.cos(rad(START_COURSE)), z: -FORMATION_RANGE * Math.sin(rad(START_COURSE)), psi: rad(START_COURSE), v: 12 * KT }; // 500 yds astern
const ALG_FULL = integrate(ALG_ORDERS, FULL, ALG_START);
const RUS_FULL = integrate(RUS_ORDERS, FULL, RUS_START);
// The third ship, the unit the others work around: it follows from behind, 1,000 yds (two stations) astern of ALG,
// the last ship of the column. It obeys ALG's orders: in the CORPEN wheel it turns in the wake like RUS, and in the
// turns together it keeps its true bearing from ALG. From the formations on it holds course 090 at 6 kn as the
// guide and screen centre.
// The first order that steers the screen ships (FORM 1, FORM 2, FORM 3, FORM D, SCREEN K, SCREEN M or FORM 345, whichever comes first).
const X_STEER = THREE ? Math.min(X.fcol, X.fdia, X.fline3, X.fcol2, X.screenk, X.screenm, X.form345) : X.form345;
const UNIT_ORDERS = THREE && [
  ALG_ORDERS[0],
  { t: X.corpen + 2 * WAKE_DELAY, course: 0, dir: 'stbd' }, // round in the wake, two stations astern of ALG
  ...ALG_ORDERS.slice(2),
  { t: X_STEER, course: 90, speed: 6 }, // G CORPEN 090, G SPEED 6 as the formations begin
];
const UNIT_FULL = THREE && integrate(UNIT_ORDERS, FULL, { x: -2 * FORMATION_RANGE * Math.cos(rad(START_COURSE)), z: -2 * FORMATION_RANGE * Math.sin(rad(START_COURSE)), psi: rad(START_COURSE), v: 12 * KT });
export const SHIP_IDS = THREE ? ['alg', 'rus', 'unit'] : ['alg', 'rus'];
// The ship the steered stations are laid off from (the unit; ALG, the guide, with two ships), and the ships steered.
const REF_FULL = THREE ? UNIT_FULL : ALG_FULL;
const STEER_IDS = THREE ? ['alg', 'rus'] : ['rus'];

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
  // RUS to the north and ALG to the south: FORM 345 then brings each in from her own side (RUS north of ALG for the skim) without crossing.
  screenk: { rus: { b1: 330, b2: 30, d1: D1, d2: D2 }, alg: { b1: 150, b2: 210, d1: D1, d2: D2 } },
  screenm: { rus: { b1: 330, b2: 0, d1: D1, d2: D2 }, alg: { b1: 180, b2: 210, d1: D1, d2: D2 } },
};
const sectorSpan = (sec) => (sec.b2 - sec.b1 + 360) % 360;
function sectorAt(id, t) {
  return (t >= X.screenm ? SECTORS.screenm : SECTORS.screenk)[id];
}
// --- Formations on the unit (FORM 1, FORM D, FORM 3, FORM 2, the screens, FORM 345): each ship steers for her station,
// given in station lengths (500 yds) ahead and to starboard of the unit, on the unit's course. ---
const FORM_STATIONS = THREE ? {
  fcol: { alg: [-1, 0], rus: [-2, 0] }, // column in order: unit, ALG, RUS
  fdia: { alg: [-Math.SQRT1_2, -Math.SQRT1_2], rus: [-Math.SQRT1_2, Math.SQRT1_2] }, // diamond: port and starboard quarters
  fline3: { alg: [0, 1], rus: [0, 2] }, // line abreast to starboard
  fcol2: { alg: [1, 0], rus: [2, 0] }, // column in reverse order: RUS, ALG, unit
  // The final FORM 1: ALG leads the unit by one station (500 yds), and RUS forms on true bearing 345 from ALG, one station
  // off, which is where the skim starts from; she then skims past ALG and on past the unit.
  form345: { alg: [1, 0], rus: [1 - Math.sin(rad(15)), -Math.cos(rad(15))] },
} : {
  // Two ships: the station is laid off from ALG herself, so RUS on true bearing 345 from her (ALG on 090) is 105
  // degrees to port of her bow, one station off: the same place as in the three-ship final FORM 1.
  form345: { rus: [-Math.sin(rad(15)), -Math.cos(rad(15))] },
};
// The formations the scene draws as stations on the unit; with two ships FORM 345 is shown as an ordinary station
// from the guide (STATIONS) instead.
export const FORMS = THREE ? FORM_STATIONS : {};
const STEERED = THREE ? ['fcol', 'fdia', 'fline3', 'fcol2', 'screenk', 'screenm', 'form345'] : ['form345']; // the orders that steer the screen ships
function steeredPhase(t) {
  let cur = null;
  for (const p of PHASES) if (STEERED.includes(p.id) && t >= p.tx) cur = p.id;
  return cur;
}
export function formationKey(t) {
  const k = steeredPhase(t);
  return k && FORM_STATIONS[k] ? k : null;
}
export function stationPoint(id, key, t) {
  const u = lookup(REF_FULL, t);
  const [fwd, stb] = FORM_STATIONS[key][id];
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
  const u = lookup(REF_FULL, t);
  return { x: u.x + depth * Math.cos(rad(bearing)), z: u.z + depth * Math.sin(rad(bearing)) };
}
// From the first of these orders (FORM 1, on the unit) to the start of the skim, ALG and RUS no longer follow order
// lists: each steers for her station or patrol point, both together so that each gives way to the other and to the
// unit (a ship that would pass within AVOID ahead of an obstacle bends away to starboard). From the skim on the
// orders take over again from wherever the ships are.
const AVOID = 450; // m: in transit a ship bends away (to starboard) from the unit or the other ship ahead of her inside this range
function steerStations() {
  const kA = Math.round(X_STEER / DT);
  const kB = Math.round(X.skim / DT);
  const rows = { alg: ALG_FULL, rus: RUS_FULL };
  let st = Object.fromEntries(STEER_IDS.map((id) => [id, { ...rows[id][kA] }]));
  for (let k = kA; k < kB; k++) {
    const t = k * DT;
    const u = lookup(REF_FULL, t);
    const unitKn = u.v / KT;
    const forming = formationKey(t) !== null;
    const next = {};
    for (const id of STEER_IDS) {
      let { x, z, psi, v } = st[id];
      const P = targetPoint(id, t);
      let ux = P.x - x;
      let uz = P.z - z;
      const dist = Math.hypot(ux, uz) || 1;
      ux /= dist;
      uz /= dist;
      for (const ob of THREE ? [u, st[id === 'alg' ? 'rus' : 'alg']] : [u]) { // with two ships the other ship is the reference
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
  for (const [id, orders] of [['alg', ALG_ORDERS], ['rus', RUS_ORDERS]].filter(([id]) => STEER_IDS.includes(id))) {
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
// ... and then past the unit, 500 yds astern of ALG in the final column (three ships only).
let tPassU = tPass;
let dMinU = Infinity;
for (let t = tPass; THREE && t < tPass + 400; t += DT) {
  const g = lookup(UNIT_FULL, t);
  const r = lookup(RUS_FULL, t);
  const d = Math.hypot(r.x - g.x, r.z - g.z);
  if (d < dMinU) { dMinU = d; tPassU = t; }
}
export const PASS_UNIT = THREE ? { t: tPassU, range: dMinU } : null;
export const tEnd = Math.ceil((THREE ? Math.max(tPassU + 100, X.screenm + 420) : tPass + 100) / 5) * 5;

// Unwrap each heading so interpolation never spins the long way round.
for (const rows of THREE ? [ALG_FULL, RUS_FULL, UNIT_FULL] : [ALG_FULL, RUS_FULL]) {
  for (let i = 1; i < rows.length; i++) {
    let d = rows[i].psi - rows[i - 1].psi;
    while (d > Math.PI) { rows[i].psi -= 2 * Math.PI; d -= 2 * Math.PI; }
    while (d < -Math.PI) { rows[i].psi += 2 * Math.PI; d += 2 * Math.PI; }
  }
}

// --- Public API -------------------------------------------------------------------------------
// A ship's state at time t: x (North, m), z (East, m), heading (rad, clockwise from North), speed (m/s).
export function shipState(id, t, out = {}) {
  const s = lookup(id === 'rus' ? RUS_FULL : id === 'unit' && THREE ? UNIT_FULL : ALG_FULL, t);
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
// Both screen ships within 70 m of their stations on the unit (25 m, and on the unit's course, for the final column,
// which the serials and the skim start from).
const atStation = (t, key, tol = 70) => STEER_IDS.every((id) => {
  const a = shipState(id, t);
  const P = stationPoint(id, key, t);
  return Math.hypot(a.x - P.x, a.z - P.z) < tol && (tol >= 70 || angDiff(headingDeg(a.heading), headingDeg(shipState(THREE ? 'unit' : 'alg', t).heading)) < 3);
});
const ARRIVAL = {
  form1: (p) => p.tx,
  station: (p) => p.tx,
  corpen: (p) => settledAfter(p.tx, (t) => both(t, 0, 0.6) && (!THREE || angDiff(headingOf('unit', t), 0) <= 0.6) && onStation(t, 0, STATION_YD, 3, 0.8)), // the whole column round, the unit last
  stbd: (p) => settledAfter(p.tx, (t) => both(t, 90, 0.6)),
  port: (p) => settledAfter(p.tx, (t) => both(t, 0, 0.6)),
  gform: (p) => settledAfter(p.tx, (t) => both(t, 0, 1) && onStation(t, 180, STATION_YD, 4, 0.8)),
  turn045: (p) => settledAfter(p.tx, (t) => both(t, 45, 0.6)),
  form120: (p) => settledAfter(p.tx, (t) => both(t, 45, 1) && onStation(t, 120, STATION_YD, 5, 1.2)),
  light: () => LIGHT.t1,
  flags: () => FLAGS.t1,
  skim: () => PASS.t,
  screenk: (p) => settledAfter(p.tx, (t) => inSector('alg', t, 'screenk') && inSector('rus', t, 'screenk')),
  screenm: (p) => settledAfter(p.tx, (t) => inSector('alg', t, 'screenm') && inSector('rus', t, 'screenm')),
  fcol: (p) => settledAfter(p.tx, (t) => atStation(t, 'fcol')),
  fdia: (p) => settledAfter(p.tx, (t) => atStation(t, 'fdia')),
  fline3: (p) => settledAfter(p.tx, (t) => atStation(t, 'fline3')),
  fcol2: (p) => settledAfter(p.tx, (t) => atStation(t, 'fcol2')),
  form345: (p) => settledAfter(p.tx, THREE ? (t) => atStation(t, 'form345', 25) : (t) => both(t, 90, 1) && onStation(t, 165, STATION_YD, 5, 1.2)), // (onStation measures from RUS: 345 from ALG)
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
  if (PASS_UNIT) {
    cues.push({ t: PASS_UNIT.t - 2, kind: 'horn', ship: 'rus', len: 2.4 }); // and again past the unit, which answers
    cues.push({ t: PASS_UNIT.t + 1, kind: 'horn', ship: 'unit', len: 2.6 });
  }
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
// executes, ALG again from FORM 345 (G FORM ALG). A station is the other ship's range and bearing from it.
const GUIDES = { form1: 'alg', gform: 'rus', form345: 'alg' };
export function guideAt(t) {
  let g = 'alg';
  for (const p of PHASES) if (GUIDES[p.id] && t >= p.tx) g = GUIDES[p.id];
  return g;
}
// The ship the formation is steered on, for the map and the Formation view: the guide of the signals, except that
// through the formations on the unit and the screens it is the unit (G FORM UNIT, the screen centre).
const GUIDE_ON_UNIT = new Set(['fcol', 'fdia', 'fline3', 'fcol2', 'screenk', 'screenm']);
export function guideShipAt(t) {
  return GUIDE_ON_UNIT.has(phaseAt(t)?.id) ? 'unit' : guideAt(t);
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
export const STATIONS = { gform: [180, STATION_YD], form120: [120, STATION_YD], corpen: [180, STATION_YD], ...(THREE ? {} : { form345: [345, STATION_YD] }) }; // other ship from the guide
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
  passUnit: PASS_UNIT,
  events: [
    ...PHASES.map((p, i) => ({ t: i === 0 ? 0 : p.t, label: p.label })), // the first is the start of the exercise
    { t: PASS.t, label: 'Closest pass' },
    ...(PASS_UNIT ? [{ t: PASS_UNIT.t, label: 'Pass the unit' }] : []),
  ].sort((a, b) => a.t - b.t),
};

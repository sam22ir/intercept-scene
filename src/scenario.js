import * as THREE from 'three';

// The whole story is a pure function of time t (seconds). Nothing here keeps
// per-frame state, which is what lets the timeline scrub in both directions.
// Units are metres; the ship's bow points along +X, +Y is up, starboard is +Z.
//
// The frigate steams ahead at constant speed. Everything mounted on it (the
// launch rail, the missile launcher) and the drone's flight path are defined
// in the ship's frame — a pure translation of the world frame — and offset by
// shipPos(t). The missile and the debris are simulated in the world frame.

export const G = 9.81;
export const MAX_BANK = THREE.MathUtils.degToRad(50); // the drone never rolls past this
export const MAX_PITCH = THREE.MathUtils.degToRad(20); // nor pitches past this on the default path

// Two frigate fits, chosen on the start screen (URL ?ship=aft reloads into it):
//   'fwd' — pennant 920, 8-cell launcher on the forward deckhouse;
//   'aft' — pennant 921, launcher on the hangar roof at the stern.
// Each box only engages a drone in its own half (forward: ahead of or abeam its
// pivot; aft: astern of or abeam it), so a missile never crosses the ship. That is
// why 921's default path ends in an inbound run from astern.
export const SHIP_VARIANT = (() => {
  const chosen = globalThis.__SHIP_VARIANT; // set by the start screen, no reload needed
  if (chosen === 'aft' || chosen === 'fwd') return chosen;
  try {
    return new URLSearchParams(globalThis.location?.search ?? '').get('ship') === 'aft' ? 'aft' : 'fwd';
  } catch {
    return 'fwd';
  }
})();
export const PENNANT = SHIP_VARIANT === 'aft' ? '921' : '920';

// Two missions, chosen on the start screen:
//   'intercept' — the missile shoots the drone down on its inbound run;
//   'chute'     — recovery: no missile is ever fired; at the end of its path
//                 the drone cuts its engine, opens an orange parachute and
//                 settles into the sea.
const MODES = ['intercept', 'chute'];
export const MODE = (() => {
  const chosen = globalThis.__SCENARIO;
  if (MODES.includes(chosen)) return chosen;
  try {
    const m = new URLSearchParams(globalThis.location?.search ?? '').get('mode');
    return MODES.includes(m) ? m : 'intercept';
  } catch {
    return 'intercept';
  }
})();
export const CHUTE_MODE = MODE === 'chute';
export const SHIP_SPEED = 7; // m/s (~14 kn)

export function shipPos(t, out) {
  return out.set(SHIP_SPEED * t, 0, 0);
}

// Main-deck height along the hull: level aft, sheer rising to the bow.
export function deckHeight(x) {
  return x < 12 ? 5.6 : 5.6 + 2.3 * ((x - 12) / 50) ** 1.6;
}

// --- Drone catapult --------------------------------------------------------
// Steel truss rail on the port side of the helideck, angled out over the side.
const RAIL_YAW = THREE.MathUtils.degToRad(50); // from the bow toward port
const RAIL_PITCH = THREE.MathUtils.degToRad(18); // nose-up launch rail (with the spline blend after release the drone stays under 20 degrees of pitch)
export const RAIL = {
  start: new THREE.Vector3(-52, deckHeight(-52) + 1.35, -1.2),
  length: 3.6, // the stroke: a compact launcher, about the length of the drone's own body (as in the launch photos)
  dir: new THREE.Vector3(
    Math.cos(RAIL_PITCH) * Math.cos(RAIL_YAW), Math.sin(RAIL_PITCH), -Math.cos(RAIL_PITCH) * Math.sin(RAIL_YAW),
  ),
  up: new THREE.Vector3(
    -Math.sin(RAIL_PITCH) * Math.cos(RAIL_YAW), Math.cos(RAIL_PITCH), Math.sin(RAIL_PITCH) * Math.sin(RAIL_YAW),
  ),
  yaw: RAIL_YAW,
  pitch: RAIL_PITCH,
  ride: 0.87, // drone origin above the rail top (belly rests on the cradle pad)
};

const T_SPOOL = 3.0; // engine run-up on the cradle
const CAT_ACCEL = 94; // m/s² (~9.6 g): the booster ignites with the stroke, so the short rail is a kick, not a long pull
const T_RELEASE = T_SPOOL + Math.sqrt((2 * RAIL.length) / CAT_ACCEL); // ~0.28 s of stroke
const V_RELEASE = CAT_ACCEL * (T_RELEASE - T_SPOOL); // ~26 m/s relative to the ship

function railStroke(t) {
  if (t <= T_SPOOL) return 0;
  const dt = Math.min(t, T_RELEASE) - T_SPOOL;
  return 0.5 * CAT_ACCEL * dt * dt;
}

// Cradle travel: strokes with the drone, sits on the buffers, then winches back.
export function shuttleStroke(t) {
  if (t <= T_RELEASE + 1.5) return railStroke(t);
  return RAIL.length * (1 - THREE.MathUtils.smoothstep(t, T_RELEASE + 1.5, T_RELEASE + 6));
}

const RELEASE_POINT = RAIL.start.clone()
  .addScaledVector(RAIL.dir, RAIL.length)
  .addScaledVector(RAIL.up, RAIL.ride);

// --- Flight path, ship frame -------------------------------------------------
// Off the rail, out along (fwd) or against (aft) the ship's heading on her port side in a
// gradual climb, a turn-around 1.6 km out, then an inbound run at the ship: the leg on which
// it is shot down (Intercept) or turns off for the recovery point (Recovery).
// The first two waypoints are fixed by the catapult (so the release is
// continuous); everything after them is the editable path (path editor).
export const PATH_FIXED = [
  RELEASE_POINT.toArray(),
  RELEASE_POINT.clone().addScaledVector(RAIL.dir, 20).toArray(),
];
// The two Intercept paths were generated from straights and R = 190 m arcs (15 degree steps).
// Altitude climbs gradually along the outbound leg, 1 - (1 - u)^2 of the way from the rail
// to INTERCEPT_ALT by the turn-around (steepest just off the rail, under 15 degrees), then
// stays level, so the drone is near INTERCEPT_ALT when it is shot down.
export const INTERCEPT_ALT = 250;
// The aft launcher (921) fires astern: off the rail it turns left round to the reciprocal of
// the ship's heading, flies out astern on the port side to 1.6 km, turns left again and runs
// in from astern at the ship. Any missile from the stern box leaves away from the ship.
const INTERCEPT_PATH_AFT = [
  [1, 29, -64], [27, 40, -104], [42, 51, -150], [45, 62, -197],
  [36, 72, -244], [16, 82, -288], [-14, 91, -324], [-53, 101, -353],
  [-97, 110, -370], [-145, 119, -376], [-257, 138, -376], [-369, 156, -376],
  [-481, 172, -376], [-593, 187, -376], [-704, 200, -376], [-816, 212, -376],
  [-928, 222, -376], [-1040, 231, -376], [-1152, 238, -376], [-1264, 243, -376],
  [-1376, 247, -376], [-1488, 249, -376], [-1600, 250, -376], [-1649, 250, -370],
  [-1695, 250, -351], [-1734, 250, -321], [-1765, 250, -281], [-1784, 250, -235],
  [-1790, 250, -186], [-1784, 250, -137], [-1765, 250, -91], [-1734, 250, -52],
  [-1695, 250, -22], [-1649, 250, -3], [-1531, 250, -2], [-1412, 250, -1],
  [-1294, 250, -1], [-1176, 250, 0], [-1057, 250, 1], [-939, 250, 1],
  [-820, 250, 2], [-702, 250, 3], [-584, 250, 3], [-465, 250, 4],
  [-347, 250, 5], [-228, 250, 5], [-110, 250, 6],
];
// The forward launcher (920): off the rail it turns right onto the ship's heading, flies out
// ahead on the port side to 1.6 km, turns right round and runs in from ahead at the bow.
const INTERCEPT_PATH_FWD = [
  [1, 32, -64], [42, 46, -101], [92, 60, -124], [146, 74, -132],
  [258, 100, -132], [370, 124, -132], [482, 146, -132], [594, 166, -132],
  [705, 183, -132], [817, 199, -132], [929, 213, -132], [1041, 224, -132],
  [1153, 233, -132], [1265, 241, -132], [1376, 246, -132], [1488, 249, -132],
  [1600, 250, -132], [1649, 250, -126], [1695, 250, -107], [1734, 250, -76],
  [1765, 250, -37], [1784, 250, 9], [1790, 250, 58], [1784, 250, 107],
  [1765, 250, 153], [1734, 250, 192], [1695, 250, 223], [1649, 250, 242],
  [1600, 250, 248], [1484, 250, 229], [1368, 250, 211], [1252, 250, 192],
  [1135, 250, 174], [1019, 250, 155], [903, 250, 136], [787, 250, 118],
  [671, 250, 99], [555, 250, 80], [438, 250, 62], [322, 250, 43],
  [206, 250, 25], [90, 250, 6],
];
const INTERCEPT_PATH = SHIP_VARIANT === 'aft' ? INTERCEPT_PATH_AFT : INTERCEPT_PATH_FWD;
// Recovery flies the same path as Intercept up to a point on the inbound run (about 800 m
// out for fwd, 1.3 km for aft), where the launcher has locked on but never fires; then the
// drone turns off a little to port and comes down on a straight leg (smoothstep descent)
// to RECOVERY_POINT, 300 m off the port quarter at 90 m, where the parachute opens.
export const RECOVERY_POINT = [-212, 90, -212];
const RECOVERY_PATH_FWD = [
  ...INTERCEPT_PATH_FWD.slice(0, 36),
  [676, 245, 81], [565, 230, 45], [454, 209, 8], [343, 183, -29], [232, 157, -65],
  [121, 131, -102], [10, 110, -139], [-101, 95, -175], RECOVERY_POINT,
];
const RECOVERY_PATH_AFT = [
  ...INTERCEPT_PATH_AFT.slice(0, 37),
  [-1186, 246, -22], [-1078, 233, -43], [-969, 215, -64], [-861, 194, -85], [-753, 170, -106],
  [-645, 146, -128], [-537, 125, -149], [-428, 107, -170], [-320, 94, -191], RECOVERY_POINT,
];
const CHUTE_PATH = SHIP_VARIANT === 'aft' ? RECOVERY_PATH_AFT : RECOVERY_PATH_FWD;
export const DEFAULT_PATH = (CHUTE_MODE ? CHUTE_PATH : INTERCEPT_PATH).map((p) => [...p]);

// A custom path drawn in the editor is stored per browser and applied on load.
// The aft ship flies a different default path, so its drawn paths are stored apart.
// v2: the default paths changed (out and back, 250 m), so paths drawn on the old ones are dropped.
export const PATH_STORAGE_KEY = `intercept.path.${CHUTE_MODE ? 'chute.' : ''}${SHIP_VARIANT === 'aft' ? 'aft.' : ''}v2`;
export const MIN_ALT = 8; // never let a drawn path touch the sea

// Returns a cleaned copy of editable points, or null if they are unusable.
export function validatePath(pts) {
  if (!Array.isArray(pts) || pts.length < 1 || pts.length > 80) return null;
  const out = [];
  for (const p of pts) {
    if (!Array.isArray(p) || p.length !== 3 || !p.every(Number.isFinite)) return null;
    if (Math.abs(p[0]) > 6000 || Math.abs(p[2]) > 6000 || p[1] > 2000) return null;
    out.push([Math.round(p[0]), Math.round(Math.max(p[1], MIN_ALT)), Math.round(p[2])]);
  }
  return out;
}

// The red launch point drawn in the editor: a fraction of the path's length (release to
// end) at which the missile leaves (Intercept) or the launcher locks on (Recovery).
// null leaves it to the automatic 650 m trigger.
export function validateLaunchU(u) {
  const v = Number(u);
  return u === null || u === undefined || !Number.isFinite(v) ? null : Math.round(Math.min(Math.max(v, 0), 1) * 10000) / 10000;
}

function loadCustomPath() {
  try {
    const raw = globalThis.localStorage?.getItem(PATH_STORAGE_KEY);
    if (!raw) return null;
    const o = JSON.parse(raw);
    const points = validatePath(o.points);
    return points ? { points, launch: validateLaunchU(o.launch) } : null;
  } catch {
    return null;
  }
}

// A shared link carries its path in the URL hash (#path=<base64url of {"points":[[x,alt,z],...]}>).
// It wins over the stored path for this page view only: nothing is written to storage.
function loadSharedPath() {
  try {
    const m = /(?:^#|&)path=([A-Za-z0-9_-]+)/.exec(globalThis.location?.hash ?? '');
    if (!m) return null;
    const b64 = m[1].replace(/-/g, '+').replace(/_/g, '/');
    const o = JSON.parse(globalThis.atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)));
    const points = validatePath(o.points);
    return points ? { points, launch: validateLaunchU(o.launch) } : null;
  } catch {
    return null;
  }
}

const SHARED = loadSharedPath();
const CUSTOM = SHARED ?? loadCustomPath();
export const SHARED_PATH = SHARED !== null;
export const CUSTOM_PATH = CUSTOM !== null;
export const ACTIVE_PATH = CUSTOM?.points ?? DEFAULT_PATH.map((p) => [...p]);
export const ACTIVE_LAUNCH_U = CUSTOM?.launch ?? null;

// Same spline the drone flies, for the editor's live preview.
export function buildPathCurve(editablePts) {
  const c = new THREE.CatmullRomCurve3([...PATH_FIXED, ...editablePts].map((p) => new THREE.Vector3(...p)), false, 'centripetal');
  c.arcLengthDivisions = 4000;
  return c;
}

const WAYPOINTS = [...PATH_FIXED, ...ACTIVE_PATH];

// --- Engagement settings (the engagement panel) ---------------------------------
// When the missile leaves, when it hits, and how close it gets before it bursts.
// Like the path they are read once at import and applied by reloading, because the
// guidance run is baked at load.
//   timing: 'auto'   the launch moment is derived from the path (default);
//           'launch' the missile leaves at `time` seconds;
//           'impact' the missile is launched so that it bursts at `time` seconds;
//           'range'  the missile leaves when the drone, coming back at the ship, closes to
//                    `range` metres of it (only one trigger applies at a time).
//   dist:   metres from the drone at which the warhead goes off. 0 is a direct hit.
//   side:   where the burst sits relative to the drone's path: 'auto' (wherever the
//           missile first comes within `dist`), or 'above' | 'below' | 'left' | 'right'.
export const ENGAGE_STORAGE_KEY = 'intercept.engage.v1';
export const BURST_SIDES = ['auto', 'above', 'below', 'left', 'right'];
export const ENGAGE_TIMINGS = ['auto', 'launch', 'impact', 'range'];
export const RANGE_LIMITS = [100, 1500]; // m, drone distance from the ship
export const MAX_BURST = 60;
export const ENGAGE_DEFAULTS = { timing: 'auto', time: 0, range: 650, dist: 0, side: 'auto' };

export function validateEngage(o) {
  if (!o || typeof o !== 'object') return null;
  const timing = ENGAGE_TIMINGS.includes(o.timing) ? o.timing : 'auto';
  const side = BURST_SIDES.includes(o.side) ? o.side : 'auto';
  const time = Number(o.time);
  const dist = Number(o.dist);
  const range = o.range === undefined ? ENGAGE_DEFAULTS.range : Number(o.range);
  if (!Number.isFinite(time) || !Number.isFinite(dist) || !Number.isFinite(range)) return null;
  return {
    timing,
    time: Math.round(Math.min(Math.max(time, 0), 3600) * 10) / 10,
    range: Math.round(Math.min(Math.max(range, RANGE_LIMITS[0]), RANGE_LIMITS[1])),
    dist: Math.round(Math.min(Math.max(dist, 0), MAX_BURST)),
    side,
  };
}

function loadEngage() {
  try {
    if (globalThis.__ENGAGE) return validateEngage(globalThis.__ENGAGE); // tests and embedders
    const raw = globalThis.localStorage?.getItem(ENGAGE_STORAGE_KEY);
    return raw ? validateEngage(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}
const LOADED_ENGAGE = loadEngage();
export const CUSTOM_ENGAGE = LOADED_ENGAGE !== null && JSON.stringify(LOADED_ENGAGE) !== JSON.stringify(ENGAGE_DEFAULTS);
export const ENGAGE = LOADED_ENGAGE ?? { ...ENGAGE_DEFAULTS };


// Airspeed relative to the ship (m/s), keyed by seconds after release.
// Kept low enough that the default path's turns (R = 190 m) stay under 50 degrees of bank.
const SPEED_KEYS = [
  [0, V_RELEASE],
  [1.3, 36], // the booster takes it from the rail speed up to cruise (it burns for 1.2 s)
  [3, 36],
  [10, 38],
  [25, 40],
  [33, 42],
  [40, 41],
  [80, 40],
];

// A flight: one drone's spline in the ship frame, its arc-length table, and the
// time its catapult stroke starts (`shift`, 0 for the first drone).
function makeFlight(editablePts, shift) {
  const curve = buildPathCurve(editablePts);
  const length = curve.getLength();
  // Arc length flown since release, tabulated once (trapezoid rule).
  const arcTable = [0];
  for (let tau = 0; arcTable[arcTable.length - 1] < length; tau += ARC_DT) {
    const s = arcTable[arcTable.length - 1];
    arcTable.push(s + 0.5 * (speedAt(tau) + speedAt(tau + ARC_DT)) * ARC_DT);
  }
  const tauMax = (arcTable.length - 1) * ARC_DT;
  return {
    shift, curve, length, arcTable, tauMax,
    end: curve.getPointAt(1),
    endDir: curve.getTangentAt(1),
    tRelease: T_RELEASE + shift,
    tPathEnd: shift + T_RELEASE + tauMax,
  };
}

function speedAt(tau) {
  if (tau <= SPEED_KEYS[0][0]) return SPEED_KEYS[0][1];
  for (let i = 1; i < SPEED_KEYS.length; i++) {
    const [t1, v1] = SPEED_KEYS[i];
    const [t0, v0] = SPEED_KEYS[i - 1];
    if (tau <= t1) return v0 + ((v1 - v0) * (tau - t0)) / (t1 - t0);
  }
  return SPEED_KEYS[SPEED_KEYS.length - 1][1];
}

// Seconds from release to the end of a path (editor stat): the speed profile
// integrated until it has covered the spline's length.
export function pathFlightTime(editablePts, dt = 0.05) {
  return flightTimeForLength(buildPathCurve(editablePts).getLength(), dt);
}
// Where the 650 m trigger falls on an editable path, as a fraction of its length: the same
// search as launchAtRange, by arc length instead of time (the path is in the ship frame, so
// time only scales it). null when the path never goes out and comes back inside the arc.
export function autoLaunchU(editablePts, range = LAUNCH_RANGE) {
  const c = buildPathCurve(editablePts);
  const N = 2000;
  const p = new THREE.Vector3();
  const rng = [];
  for (let i = 0; i <= N; i++) rng.push(c.getPointAt(i / N, p).distanceTo(SHIP_CENTER));
  const out = rng.findIndex((r) => r > range);
  if (out < 0) return null;
  for (let i = out + 1; i <= N; i++) {
    if (rng[i] <= range && rng[i] < rng[i - 1] && inArcX(c.getPointAt(i / N, p).x)) return i / N;
  }
  return null;
}
// The inbound run of an editable path as [u0, u1] fractions of its length (the same rule as
// inboundWindow, by arc length): the only stretch the editor's red launch point may sit on.
export function inboundU(editablePts) {
  const c = buildPathCurve(editablePts);
  const N = 2000;
  const p = new THREE.Vector3();
  const rng = [];
  const ok = [];
  for (let i = 0; i <= N; i++) {
    c.getPointAt(i / N, p);
    rng.push(p.distanceTo(SHIP_CENTER));
    ok.push(inArcX(p.x));
  }
  const closing = (i) => i > 0 && rng[i] < rng[i - 1] && ok[i];
  let i = N;
  while (i > 0 && !closing(i)) i--;
  const i1 = i;
  while (i > 0 && closing(i)) i--;
  return i1 - i > 2 ? [(i + 1) / N, i1 / N] : null;
}
// Seconds after t = 0 at which a drone reaches `s` metres along its path (editor readout).
export const timeForLength = (s) => T_RELEASE + flightTimeForLength(s);
export function flightTimeForLength(len, dt = 0.05) {
  let s = 0;
  let tau = 0;
  while (s < len && tau < 3600) { s += speedAt(tau + dt / 2) * dt; tau += dt; }
  return tau;
}

const ARC_DT = 0.01;
const FLIGHTS = [makeFlight(ACTIVE_PATH, 0)];
const ARC_TAU_MAX = FLIGHTS[0].tauMax;
// Recovery: the parachute opens when the planned path ends.
const T_CHUTE = CHUTE_MODE ? T_RELEASE + ARC_TAU_MAX : Infinity;

function arcAt(tau, f) {
  const { arcTable, tauMax } = f;
  if (tau <= 0) return 0;
  if (tau >= tauMax) return arcTable[arcTable.length - 1] + speedAt(tau) * (tau - tauMax);
  const x = tau / ARC_DT;
  const i = Math.floor(x);
  return arcTable[i] + (arcTable[i + 1] - arcTable[i]) * (x - i);
}

// Time at which drone f has flown s metres of its path (inverse of arcAt, on the path).
function timeAtArc(s, f = FLIGHTS[0]) {
  const { arcTable } = f;
  let lo = 0;
  let hi = arcTable.length - 1;
  if (s >= arcTable[hi]) return f.tPathEnd;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (arcTable[mid] < s) lo = mid; else hi = mid;
  }
  const k = (s - arcTable[lo]) / Math.max(1e-9, arcTable[hi] - arcTable[lo]);
  return f.tRelease + (lo + k) * ARC_DT;
}

// Drone position in the ship frame along the planned path (before any parachute).
function pathRelPos(t, out, f = FLIGHTS[0]) {
  t -= f.shift;
  if (t < T_RELEASE) {
    return out.copy(RAIL.start).addScaledVector(RAIL.dir, railStroke(t)).addScaledVector(RAIL.up, RAIL.ride);
  }
  const s = arcAt(t - T_RELEASE, f);
  if (s <= f.length) return f.curve.getPointAt(s / f.length, out);
  return out.copy(f.end).addScaledVector(f.endDir, s - f.length);
}

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _d = new THREE.Vector3();

// Drone position in the ship frame (under canopy it follows the world-frame descent).
// `k` picks the drone (always 0: one drone per mission).
export function planeRelPos(t, out, k = 0) {
  if (t >= T_CHUTE) return descentWorld(t, out).sub(shipPos(t, _d));
  return pathRelPos(t, out, FLIGHTS[k]);
}

export function planePos(t, out, k = 0) {
  planeRelPos(t, out, k);
  return out.add(shipPos(t, _d));
}

export function planeVel(t, out, k = 0) {
  const h = 0.05;
  planePos(t - h, _a, k);
  planePos(t + h, _b, k);
  return out.subVectors(_b, _a).divideScalar(2 * h);
}

const _m = new THREE.Matrix4();
const _x = new THREE.Vector3();
const _y = new THREE.Vector3();
const _rel = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _zAxis = new THREE.Vector3(0, 0, 1);
const _qRoll = new THREE.Quaternion();

// World position + attitude. Nose is local +Z, left wing local +X. Attitude
// follows the ship-relative path (continuous off the rail); bank comes from
// the turn rate (coordinated turn: tan(bank) = v·ω / g). Returns airspeed.
function pathPose(t, pos, quat, f = FLIGHTS[0]) {
  pathRelPos(t, _rel, f);
  pos.copy(_rel).add(shipPos(t, _d));
  const h = 0.15;
  let speed = 0;
  let bank = 0;
  const fwd = _c;
  const tf = t - f.shift; // time since this drone's own stroke began
  if (tf < T_RELEASE) {
    fwd.copy(RAIL.dir);
    speed = CAT_ACCEL * Math.max(0, tf - T_SPOOL);
  } else {
    pathRelPos(t - h, _a, f);
    pathRelPos(t + h, _b, f);
    fwd.subVectors(_b, _a);
    speed = fwd.length() / (2 * h);
    fwd.normalize();
    pathRelPos(t - 2 * h, _d, f);
    const v1x = _rel.x - _d.x, v1z = _rel.z - _d.z;
    pathRelPos(t + 2 * h, _d, f);
    const v2x = _d.x - _rel.x, v2z = _d.z - _rel.z;
    const turn = Math.atan2(v1z * v2x - v1x * v2z, v1x * v2x + v1z * v2z) / (2 * h);
    // Ease bank in over the first second so it doesn't snap at release.
    const ease = THREE.MathUtils.smoothstep(tf, T_RELEASE, T_RELEASE + 1);
    bank = ease * THREE.MathUtils.clamp(Math.atan((speed * turn) / G), -MAX_BANK, MAX_BANK);
  }
  _x.crossVectors(_up, fwd).normalize();
  _y.crossVectors(fwd, _x);
  _m.makeBasis(_x, _y, fwd);
  quat.setFromRotationMatrix(_m);
  quat.multiply(_qRoll.setFromAxisAngle(_zAxis, -bank));
  return speed;
}


// --- Recovery: engine cut, parachute, splashdown --------------------------------
// After T_CHUTE the drone follows a closed-form descent in the world frame:
// the horizontal speed bleeds off into a light breeze, the vertical speed
// settles to the canopy's sink rate, and the drone swings gently below it.
const CHUTE = { sink: 5.4, tauH: 2.2, tauV: 1.0, wind: new THREE.Vector3(2.2, 0, 0.9), yFloat: 0.18 };
const W0 = new THREE.Vector3();
const V0 = new THREE.Vector3();
const Q0 = new THREE.Quaternion();
let PSI0 = 0;
let T_SPLASH = Infinity;

function descentRaw(tau, out) {
  const kh = CHUTE.tauH * (1 - Math.exp(-tau / CHUTE.tauH));
  const kv = CHUTE.tauV * (1 - Math.exp(-tau / CHUTE.tauV));
  return out.set(
    W0.x + CHUTE.wind.x * tau + (V0.x - CHUTE.wind.x) * kh,
    W0.y - CHUTE.sink * tau + (V0.y + CHUTE.sink) * kv,
    W0.z + CHUTE.wind.z * tau + (V0.z - CHUTE.wind.z) * kh,
  );
}

if (CHUTE_MODE) {
  const worldAt = (t, out) => pathRelPos(t, out).add(shipPos(t, new THREE.Vector3()));
  worldAt(T_CHUTE, W0);
  V0.subVectors(W0, worldAt(T_CHUTE - 0.05, new THREE.Vector3())).divideScalar(0.05);
  pathPose(T_CHUTE - 0.001, new THREE.Vector3(), Q0);
  PSI0 = Math.atan2(V0.x, V0.z);
  const probe = new THREE.Vector3();
  let lo = 0;
  let hi = 600;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (descentRaw(mid, probe).y > CHUTE.yFloat) lo = mid; else hi = mid;
  }
  T_SPLASH = T_CHUTE + hi;
}

function descentWorld(t, out) {
  if (t <= T_SPLASH) return descentRaw(t - T_CHUTE, out);
  descentRaw(T_SPLASH - T_CHUTE, out);
  const ta = t - T_SPLASH;
  out.x += CHUTE.wind.x * 0.25 * ta;
  out.z += CHUTE.wind.z * 0.25 * ta;
  // Floating: a small dip at touchdown, then riding the swell.
  out.y = CHUTE.yFloat + 0.035 * Math.sin(2.0 * t) - 0.18 * Math.exp(-ta / 0.45) * Math.sin(6 * ta);
  return out;
}

const _qHang = new THREE.Quaternion();
const _qA = new THREE.Quaternion();
const _qB = new THREE.Quaternion();
const _qC = new THREE.Quaternion();
const _xAxis = new THREE.Vector3(1, 0, 0);

// Hanging attitude (nose +Z): swinging below the canopy, then floating with a
// nose-down list. `pitchUp` is positive nose-up.
function hangAttitude(tau, ta, t, out) {
  const fade = Math.exp(-tau / 14);
  let pitchUp = -0.1 + 0.16 * Math.sin(1.25 * tau) * fade;
  let roll = 0.13 * Math.sin(0.95 * tau + 1) * fade;
  const psi = PSI0 + 0.3 * (1 - Math.exp(-tau / 6)) * Math.sin(0.4 * tau);
  if (ta > 0) {
    const k = THREE.MathUtils.smoothstep(ta, 0, 0.8);
    pitchUp = THREE.MathUtils.lerp(pitchUp, -0.07 + 0.045 * Math.sin(1.7 * t), k);
    roll = THREE.MathUtils.lerp(roll, 0.08 + 0.05 * Math.sin(1.3 * t + 1), k);
  }
  _qA.setFromAxisAngle(_up, psi);
  _qB.setFromAxisAngle(_xAxis, -pitchUp);
  _qC.setFromAxisAngle(_zAxis, roll);
  return out.copy(_qA).multiply(_qB).multiply(_qC);
}

function descentPose(t, pos, quat) {
  descentWorld(t, pos);
  const tau = t - T_CHUTE;
  const ta = t - T_SPLASH;
  hangAttitude(tau, ta, t, _qHang);
  quat.copy(Q0).slerp(_qHang, THREE.MathUtils.smoothstep(tau, 0, 0.9));
  if (ta >= 0) return 0;
  const vh = Math.exp(-tau / CHUTE.tauH);
  const vv = -CHUTE.sink + (V0.y + CHUTE.sink) * Math.exp(-tau / CHUTE.tauV);
  return Math.hypot(CHUTE.wind.x + (V0.x - CHUTE.wind.x) * vh, vv, CHUTE.wind.z + (V0.z - CHUTE.wind.z) * vh);
}

// World position + attitude of the drone at time t. Returns speed (m/s).
export function planePose(t, pos, quat, k = 0) {
  return t >= T_CHUTE ? descentPose(t, pos, quat) : pathPose(t, pos, quat, FLIGHTS[k]);
}

// Propeller angle in closed form: linear run-up over T_SPOOL, then constant.
const PROP_OMEGA = 560; // rad/s (~5300 rpm)
function runUpAngle(t) {
  if (t <= 0) return 0;
  if (t < T_SPOOL) return (PROP_OMEGA * t * t) / (2 * T_SPOOL);
  return PROP_OMEGA * (t - T_SPOOL / 2);
}
const T_COAST = 1.4; // recovery: engine cut, prop winds down over this time constant
export function propAngle(t, k = 0) {
  if (k) return runUpAngle(t - FLIGHTS[k].shift);
  if (t < T_CHUTE) return runUpAngle(t);
  return runUpAngle(T_CHUTE) + PROP_OMEGA * T_COAST * (1 - Math.exp(-(t - T_CHUTE) / T_COAST));
}
export const propSpin01 = (t, k = 0) => (t < T_CHUTE
  ? THREE.MathUtils.clamp((t - (k ? FLIGHTS[k].shift : 0)) / T_SPOOL, 0, 1)
  : Math.exp(-(t - T_CHUTE) / T_COAST));

// --- Key moments, measured in the ship frame --------------------------------

const SHIP_CENTER = new THREE.Vector3(0, 10, 0);
const tmp = new THREE.Vector3();

const rangeAt = (t, k = 0) => planeRelPos(t, tmp, k).distanceTo(SHIP_CENTER);

// Fire once the drone, having been out of range, closes back inside this range
// of the ship. If a drawn path never leaves the range, fire at the first
// closing moment after a short delay; if it never closes, fire near the end.
const LAUNCH_RANGE = 650;
// Firing arc: the forward box only engages a drone ahead of or abeam its pivot,
// the aft box one astern of or abeam its pivot, so a missile never has to cross
// the ship. (Same pivot x as LAUNCHER_PIVOT below.)
const PIVOT_X = SHIP_VARIANT === 'aft' ? -33.8 : 24;
export const inArcX = (x) => (SHIP_VARIANT === 'aft' ? x <= PIVOT_X : x >= PIVOT_X);
const inArc = (t, k) => inArcX(planeRelPos(t, tmp, k).x);
// Distance from the ship at time t, as the drone-range trigger measures it.
export function droneRange(t, k = 0) {
  return rangeAt(t, k);
}
// Launch time of the missile for drone k, searched from that drone's own release: the
// first moment, after the drone has been farther than `range`, that it closes back inside.
// `ok` is false when the path never gets that far out, or never comes back (a fallback time).
function launchAtRange(k, range) {
  const f = FLIGHTS[k];
  let tExit = null;
  for (let t = f.tRelease; t < f.tPathEnd; t += 0.05) {
    if (rangeAt(t, k) > range) { tExit = t; break; }
  }
  const from = tExit ?? f.tRelease + 8;
  for (let t = from; t < f.tPathEnd; t += 0.01) {
    const r = rangeAt(t, k);
    if (r <= range && r < rangeAt(t - 0.2, k) && inArc(t, k)) return { t, ok: tExit !== null };
  }
  return { t: Math.max(f.tRelease + 4, Math.min(from, f.tPathEnd - 4)), ok: false };
}
// The missile only ever leaves on the inbound run, the drone flying toward the ship: the last
// stretch of the path on which it closes on the ship inside the launcher's arc (recovery: the
// last one before it passes abeam). null if the path has none.
function inboundWindow(k = 0) {
  const f = FLIGHTS[k];
  const dt = 0.05;
  const closing = (t) => rangeAt(t, k) < rangeAt(t - dt, k) && inArc(t, k);
  let t = f.tPathEnd;
  while (t > f.tRelease && !closing(t)) t -= dt;
  const t1 = t;
  while (t > f.tRelease && closing(t)) t -= dt;
  return t1 - t > 1 ? [t + dt, t1] : null;
}
const INBOUND = inboundWindow(0);
// Any launch time, from any setting, is held inside the inbound run.
const clampInbound = (tl) => (INBOUND ? Math.min(Math.max(tl, INBOUND[0]), INBOUND[1]) : tl);
// The red launch point from the editor, when one was placed, wins over the 650 m trigger.
const pointLaunch = (k) => {
  const f = FLIGHTS[k];
  return clampInbound(Math.min(Math.max(timeAtArc(ACTIVE_LAUNCH_U * f.length, f), f.tRelease + 1), f.tPathEnd - 1));
};
const deriveLaunch = (k) => (ACTIVE_LAUNCH_U !== null && k === 0 ? pointLaunch(k) : clampInbound(launchAtRange(k, LAUNCH_RANGE).t));
// Recovery: the launcher locks on where Intercept would fire, tracks the drone and never fires.
const T_LOCK = CHUTE_MODE ? Math.min(deriveLaunch(0), T_CHUTE - 1) : Infinity;
// Two shots must leave the launcher at least this far apart (slew and reload).
const MIN_LAUNCH_GAP = 2.5;
// Launch moments derived from the path alone. The engagement settings may move the
// first of them (see resolveLaunches below, once the guidance run is defined).
const AUTO_LAUNCHES = [];
if (CHUTE_MODE) {
  AUTO_LAUNCHES.push(Infinity); // recovery: the missile is never fired
} else {
  for (let k = 0; k < FLIGHTS.length; k++) {
    let tl = deriveLaunch(k);
    if (k > 0) tl = Math.max(tl, AUTO_LAUNCHES[k - 1] + MIN_LAUNCH_GAP);
    AUTO_LAUNCHES.push(tl);
  }
}

const STORY_END = CHUTE_MODE ? T_CHUTE : AUTO_LAUNCHES[0]; // markers are looked for up to here

// Timeline markers from the shape of the path: prominent local maxima/minima
// of the range to the ship (turn-backs and passes), found on a 0.1 s grid.
const pathMarkers = [];
{
  const dt = 0.1;
  const W = 50; // ±5 s window
  const PROMINENCE = 40; // m
  const t0 = T_RELEASE + 2;
  const n = Math.max(0, Math.floor((STORY_END + 5 - t0) / dt));
  const r = Array.from({ length: n }, (_, i) => rangeAt(t0 + i * dt));
  const maxima = [];
  for (let i = 1; i < n - 1; i++) {
    const lo = Math.max(0, i - W);
    const hi = Math.min(n - 1, i + W);
    let mx = -Infinity, mn = Infinity;
    for (let k = lo; k <= hi; k++) { mx = Math.max(mx, r[k]); mn = Math.min(mn, r[k]); }
    const t = t0 + i * dt;
    if (t > STORY_END - 0.5) break;
    const prev = pathMarkers[pathMarkers.length - 1];
    if (r[i] >= mx && mx - mn > PROMINENCE && r[i] > r[i - 1] && !(prev?.kind === 'max' && t - prev.t < 3)) {
      pathMarkers.push({ t, kind: 'max' }); maxima.push(pathMarkers.length - 1);
    } else if (r[i] <= mn && mx - mn > PROMINENCE && r[i] < r[i - 1] && !(prev?.kind === 'min' && t - prev.t < 3)) {
      pathMarkers.push({ t, kind: 'min' });
    }
  }
  // The final turn-back before the shot is where the inbound run begins.
  const last = maxima.length ? pathMarkers[maxima[maxima.length - 1]] : null;
  // Only a pass within CLOSE_PASS_RANGE is a "Close pass" (the Director frames those);
  // a far abeam passage, such as 921's run astern, is just a fly-by.
  const CLOSE_PASS_RANGE = 150;
  for (const m of pathMarkers) {
    m.label = m.kind === 'min' ? (rangeAt(m.t) < CLOSE_PASS_RANGE ? 'Close pass' : 'Fly-by') : (m === last ? 'Inbound run' : 'Turn back');
  }
}

// --- Missile launcher (8-cell trainable box) --------------------------------
// Forward fit sits on the deckhouse roof; aft fit on the aft end of the hangar
// roof, in place of the CIWS. Either pivot is high enough for the box to clear
// what's under it at full elevation.
const AFT = SHIP_VARIANT === 'aft';
export const FWD_ROOF_Y = deckHeight(24) + 2.2;
export const HANGAR_ROOF_Y = 12.0;
export const LAUNCHER_PIVOT = AFT
  ? new THREE.Vector3(PIVOT_X, HANGAR_ROOF_Y + 2.1, 0)
  : new THREE.Vector3(PIVOT_X, FWD_ROOF_Y + 1.9, 0);
// Stowed: forward fit faces the bow, aft fit faces the stern.
const STOW_YAW = AFT ? Math.PI : 0;
// Top-port tube mouth, in the launcher's own frame (+X along the tubes).
export const TUBE_MOUTH = new THREE.Vector3(1.75, 0.3, -0.93);
// Pair mode fires the second round from the next cell along the top row.
export const TUBE_MOUTHS = [TUBE_MOUTH, new THREE.Vector3(1.75, 0.3, -0.31)];

const _qYaw = new THREE.Quaternion();
const _qPitch = new THREE.Quaternion();
const _yAxis = new THREE.Vector3(0, 1, 0);
export function launcherQuat(yaw, pitch, out) {
  _qYaw.setFromAxisAngle(_yAxis, yaw);
  _qPitch.setFromAxisAngle(_zAxis, pitch);
  return out.copy(_qYaw).multiply(_qPitch);
}

// --- Missile: proportional navigation, simulated once at load ---------------
// One engagement per drone. Stored as a fixed-rate sample table; the last
// sample is snapped onto the drone so the hit is exact by construction.

const MISSILE_DT = 1 / 500;

// Where the launcher must point for a shot at drone k leaving at tLaunch.
function aimFor(k, tLaunch) {
  const aimTarget = new THREE.Vector3();
  if (CHUTE_MODE) aimTarget.set(1, 0, 0); // never aimed
  else planePos(tLaunch + 1.2, aimTarget, k).sub(shipPos(tLaunch, tmp)).sub(LAUNCHER_PIVOT);
  const yaw = Math.atan2(-aimTarget.z, aimTarget.x);
  // Both boxes fire away from the ship (see inArc), so nothing is in the way.
  const pitch = THREE.MathUtils.clamp(
    Math.atan2(aimTarget.y, Math.hypot(aimTarget.x, aimTarget.z)),
    THREE.MathUtils.degToRad(25), THREE.MathUtils.degToRad(70),
  );
  return { yaw, pitch };
}

// Unit direction of an explicit burst point from the drone: `fwd` is its velocity, and
// right is starboard when it flies level (fwd x up).
const _bf = new THREE.Vector3();
const _br = new THREE.Vector3();
const _bu = new THREE.Vector3();
const _bo = new THREE.Vector3();
function burstOffset(side, dist, targetVel, out) {
  _bf.copy(targetVel);
  if (_bf.lengthSq() < 1e-6) _bf.set(1, 0, 0);
  _bf.normalize();
  _br.crossVectors(_bf, _up);
  if (_br.lengthSq() < 1e-6) _br.set(0, 0, 1);
  _br.normalize();
  _bu.crossVectors(_br, _bf);
  const dir = side === 'above' ? _bu : side === 'below' ? _bu.negate() : side === 'right' ? _br : _br.negate();
  return out.copy(dir).multiplyScalar(dist);
}

// `opts` (dist, side) is the warhead setting: a direct hit snaps the last sample onto
// the drone; a burst `dist` metres away either homes on a point beside it (explicit
// side) or fuzes when the missile first comes within that range (side 'auto').
function engage(k, tLaunch, opts = ENGAGE) {
  const { yaw: aimYaw, pitch: aimPitch } = aimFor(k, tLaunch);
  const launchQuat = launcherQuat(aimYaw, aimPitch, new THREE.Quaternion());
  const start = TUBE_MOUTHS[k].clone().applyQuaternion(launchQuat)
    .add(LAUNCHER_PIVOT).add(shipPos(CHUTE_MODE ? 0 : tLaunch, new THREE.Vector3()));
  const launchDir = new THREE.Vector3(1, 0, 0).applyQuaternion(launchQuat);
  const samples = []; // flat xyz
  let tHit;
  let miss = 0; // metres the missile was short of its burst point when the run timed out (0 = reached)
  if (CHUTE_MODE) {
    tHit = Infinity; // no hit in a recovery
    samples.push(...start.toArray(), ...start.toArray());
  } else {
    const burst = opts.dist ?? 0;
    const explicit = burst > 0 && opts.side !== 'auto';
    const fuzeRange = Math.max(2.5, explicit ? 0 : burst);
    const pos = start.clone();
    const vel = launchDir.clone().multiplyScalar(40);
    const droneAt = new THREE.Vector3();
    const target = new THREE.Vector3();
    const targetVel = new THREE.Vector3();
    const r = new THREE.Vector3();
    const vr = new THREE.Vector3();
    const omega = new THREE.Vector3();
    const acc = new THREE.Vector3();
    const axis = new THREE.Vector3();
    const N = 5;
    const MAX_ACC = 60 * G;
    let t = tLaunch;
    samples.push(pos.x, pos.y, pos.z);
    for (;;) {
      const age = t - tLaunch;
      const speed = age < 0.5 ? 40 + age * 360 : Math.min(420, 220 + (age - 0.5) * 160);
      planePos(t, droneAt, k);
      planeVel(t, targetVel, k);
      target.copy(droneAt);
      if (explicit) target.add(burstOffset(opts.side, burst, targetVel, _bo));
      r.subVectors(target, pos);
      const closest = explicit ? r.length() : pos.distanceTo(droneAt);
      if (closest < fuzeRange) break;
      if (age > 12) { miss = r.length(); break; }
      if (age > 0.3) {
        const off = vel.angleTo(r);
        if (off > 0.6) {
          // Large heading error (e.g. after the aft fit's steep loft): PN can't
          // recover from that, so pitch over toward the target at the g limit.
          const turn = Math.min((MAX_ACC / vel.length()) * MISSILE_DT, off);
          axis.crossVectors(vel, r).normalize();
          vel.applyAxisAngle(axis, turn);
        } else {
          vr.subVectors(targetVel, vel);
          omega.crossVectors(r, vr).divideScalar(r.lengthSq());
          acc.crossVectors(omega, vel).multiplyScalar(N);
          if (acc.length() > MAX_ACC) acc.setLength(MAX_ACC);
          vel.addScaledVector(acc, MISSILE_DT);
        }
      }
      vel.setLength(speed);
      pos.addScaledVector(vel, MISSILE_DT);
      t += MISSILE_DT;
      samples.push(pos.x, pos.y, pos.z);
    }
    tHit = t;
    if (explicit || fuzeRange <= 2.5 || miss > 0) {
      // Direct hit, the explicit burst point itself, or a timed-out run (forced hit):
      // land the last sample exactly on the point it was homing on.
      const n = samples.length;
      samples[n - 3] = target.x;
      samples[n - 2] = target.y;
      samples[n - 1] = target.z;
    }
  }
  const n = samples.length / 3;
  const hitPos = new THREE.Vector3(samples[(n - 1) * 3], samples[(n - 1) * 3 + 1], samples[(n - 1) * 3 + 2]);
  // How far from the drone the warhead actually went off.
  const burstDist = Number.isFinite(tHit) ? hitPos.distanceTo(planePos(tHit, new THREE.Vector3(), k)) : 0;
  return {
    k, tLaunch, tHit, interceptMiss: miss, burstDist, hitPos, missileStart: start, launchDir,
    aimYaw, aimPitch, samples, n,
  };
}

// --- Launch and impact timing from the engagement settings ----------------------
const launchLimits = (k) => [FLIGHTS[k].tRelease + 1, FLIGHTS[k].tPathEnd - 1];
const clampLaunch = (tl, k) => {
  const [lo, hi] = launchLimits(k);
  return clampInbound(Math.min(Math.max(tl, lo), hi));
};

// Launch time that makes the burst land at tImpact: flight time barely depends on the
// launch moment, so stepping by the remaining error converges in a few runs.
function solveLaunchForImpact(k, tImpact, opts) {
  let tl = clampLaunch(tImpact - 6, k);
  for (let i = 0; i < 14; i++) {
    const err = tImpact - engage(k, tl, opts).tHit;
    if (Math.abs(err) < 0.02) break;
    tl = clampLaunch(tl + err, k);
  }
  return tl;
}

function resolveLaunch(autoLaunch, opts) {
  if (CHUTE_MODE || opts.timing === 'auto') return autoLaunch;
  if (opts.timing === 'launch') return clampLaunch(opts.time, 0);
  if (opts.timing === 'range') return clampInbound(launchAtRange(0, opts.range).t);
  return solveLaunchForImpact(0, opts.time, opts);
}

// What a setting would do, without applying it: the engagement panel's live readout.
export function previewEngagement(opts) {
  if (CHUTE_MODE) return null;
  const o = validateEngage(opts) ?? ENGAGE_DEFAULTS;
  const tl = resolveLaunch(AUTO_LAUNCHES[0], o);
  const e = engage(0, tl, o);
  const [tMin, tMax] = launchLimits(0);
  return {
    tLaunch: tl, tHit: e.tHit, burstDist: e.burstDist, reached: e.interceptMiss === 0,
    rangeOk: o.timing !== 'range' || launchAtRange(0, o.range).ok,
    launchRange: rangeAt(tl, 0),
    autoLaunch: AUTO_LAUNCHES[0], tMin, tMax,
  };
}

// All launch times are known, so every shot can be aimed before any is flown.
const T_LAUNCHES = [];
AUTO_LAUNCHES.forEach((auto, k) => {
  let tl = k === 0 ? resolveLaunch(auto, ENGAGE) : auto;
  if (k > 0) tl = Math.max(tl, T_LAUNCHES[k - 1] + MIN_LAUNCH_GAP);
  T_LAUNCHES.push(tl);
});
const T_LAUNCH = T_LAUNCHES[0];
const ENGS = T_LAUNCHES.map((tl, k) => engage(k, tl));
const E0 = ENGS[0];

// Launcher slew: stowed -> aim at shot 1 -> (aim at shot 2) -> stowed. Each slew
// into a shot finishes 0.3 s before it leaves and starts no earlier than 0.8 s
// after the previous one, so closely spaced shots get a quicker slew.
const SLEWS = [];
for (const e0 of ENGS) {
  if (!Number.isFinite(e0.tLaunch)) continue;
  const prev = SLEWS[SLEWS.length - 1];
  // Take the short way round from the previous heading (the stern box rests at
  // yaw π, where atan2 can jump to -π): the slew is a lerp, so unwrap the target.
  const e = { ...e0 };
  const from = prev ? prev.aimYaw : STOW_YAW;
  e.aimYaw = from + Math.atan2(Math.sin(e0.aimYaw - from), Math.cos(e0.aimYaw - from));
  const start = prev ? Math.max(e.tLaunch - 4, prev.tLaunch + 0.8) : e.tLaunch - 4;
  SLEWS.push({ ...e, slewStart: start, slewDur: Math.max(0.2, Math.min(3, e.tLaunch - 0.3 - start)) });
}
const T_LAST_LAUNCH = SLEWS.length ? SLEWS[SLEWS.length - 1].tLaunch : Infinity;

// Recovery lock-on: the box slews onto the drone over LOCK_SLEW s ending at T_LOCK, follows
// it (within its own half plus a little: it never swings over the superstructure) until the
// parachute opens, then stows.
const LOCK_SLEW = 1.6;
const TRACK_YAW = THREE.MathUtils.degToRad(100); // either way from the stowed heading
const _ta = new THREE.Vector3();
function trackAim(t) {
  planeRelPos(t, _ta).sub(LAUNCHER_PIVOT);
  const raw = Math.atan2(-_ta.z, _ta.x);
  const off = THREE.MathUtils.clamp(Math.atan2(Math.sin(raw - STOW_YAW), Math.cos(raw - STOW_YAW)), -TRACK_YAW, TRACK_YAW);
  const pitch = THREE.MathUtils.clamp(Math.atan2(_ta.y, Math.hypot(_ta.x, _ta.z)), THREE.MathUtils.degToRad(20), THREE.MathUtils.degToRad(70));
  return { yaw: STOW_YAW + off, pitch };
}
function lockAim(t) {
  const w = THREE.MathUtils.smoothstep(t, T_LOCK - LOCK_SLEW, T_LOCK);
  const back = THREE.MathUtils.smoothstep(t, T_CHUTE + 2, T_CHUTE + 5);
  if (w === 0 || back === 1) return { yaw: STOW_YAW, pitch: 0 };
  const a = trackAim(Math.min(Math.max(t, T_LOCK), T_CHUTE + 2));
  const k = w * (1 - back);
  return { yaw: THREE.MathUtils.lerp(STOW_YAW, a.yaw, k), pitch: THREE.MathUtils.lerp(0, a.pitch, k) };
}

export function launcherAim(t) {
  if (CHUTE_MODE) return lockAim(t);
  let yaw = STOW_YAW;
  let pitch = 0;
  for (const e of SLEWS) {
    const w = THREE.MathUtils.smoothstep(t, e.slewStart, e.slewStart + e.slewDur);
    yaw = THREE.MathUtils.lerp(yaw, e.aimYaw, w);
    pitch = THREE.MathUtils.lerp(pitch, e.aimPitch, w);
  }
  const back = THREE.MathUtils.smoothstep(t, T_LAST_LAUNCH + 3, T_LAST_LAUNCH + 6);
  return { yaw: THREE.MathUtils.lerp(yaw, STOW_YAW, back), pitch: THREE.MathUtils.lerp(pitch, 0, back) };
}

function missileSample(i, out, e = E0) {
  i = THREE.MathUtils.clamp(i, 0, e.n - 1);
  return out.set(e.samples[i * 3], e.samples[i * 3 + 1], e.samples[i * 3 + 2]);
}

export function missilePos(t, out, k = 0) {
  const e = ENGS[k];
  if (t <= e.tLaunch) return out.copy(e.missileStart);
  const f = (t - e.tLaunch) / MISSILE_DT;
  const i = Math.floor(f);
  if (i >= e.n - 1) return missileSample(e.n - 1, out, e);
  missileSample(i, _a, e);
  missileSample(i + 1, _b, e);
  return out.lerpVectors(_a, _b, f - i);
}

const _fwd = new THREE.Vector3();
// Missile nose is local +Z. Returns speed in m/s.
export function missilePose(t, pos, quat, k = 0) {
  const e = ENGS[k];
  missilePos(t, pos, k);
  const i = Math.min(Math.floor(Math.max(t - e.tLaunch, 0) / MISSILE_DT), e.n - 2);
  missileSample(i, _a, e);
  missileSample(i + 1, _b, e);
  _fwd.subVectors(_b, _a);
  const speed = _fwd.length() / MISSILE_DT;
  if (speed < 1e-3) _fwd.copy(e.launchDir);
  quat.setFromUnitVectors(_zAxis, _fwd.normalize());
  return speed;
}

// Every n-th sample as {t, pos}, used to lay the smoke trail.
export function missileTrailPoints(step, k = 0) {
  const e = ENGS[k];
  const pts = [];
  for (let i = 0; i < e.n; i += step) {
    pts.push({ t: e.tLaunch + i * MISSILE_DT, pos: missileSample(i, new THREE.Vector3(), e) });
  }
  return pts;
}

const tHit = E0.tHit;

export const scenario = {
  tSpool: T_SPOOL,
  tRelease: T_RELEASE,
  tBoost0: T_SPOOL, // booster ignites with the stroke
  tBoost1: T_RELEASE + 1.2,
  tLaunch: T_LAUNCH,
  interceptMiss: E0.interceptMiss,
  burstDist: E0.burstDist, // metres from the drone at which the warhead goes off (0 = direct hit)
  engage: { ...ENGAGE },
  customEngage: CUSTOM_ENGAGE,
  autoLaunch: AUTO_LAUNCHES[0],
  // Range (m) inside which an inbound drone is a threat the box will fire at (the HUD colours it).
  launchRange: ENGAGE.timing === 'range' ? ENGAGE.range : LAUNCH_RANGE,
  // True if a (custom) path forced a launch while the drone was on the wrong side of the box.
  outOfArc: !CHUTE_MODE && ENGS.some((e) => !inArc(e.tLaunch, e.k ?? ENGS.indexOf(e))),
  customPath: CUSTOM_PATH,
  sharedPath: SHARED_PATH,
  activePath: ACTIVE_PATH,
  tHit,
  hitPos: E0.hitPos,
  missileStart: E0.missileStart,
  launchDir: E0.launchDir,
  releasePoint: RELEASE_POINT,
  mode: MODE,
  hasMissile: !CHUTE_MODE,
  tChute: T_CHUTE,
  tSplash: T_SPLASH,
  tLock: T_LOCK, // recovery: the launcher has locked on the drone (Infinity in an intercept)
  inbound: INBOUND, // [t0, t1]: the inbound run, the only stretch a launch (or lock-on) may fall in
  launchU: ACTIVE_LAUNCH_U, // the editor's red launch point (fraction of the path), or null
  // One entry per engagement: none in a recovery, one in an intercept.
  // tLaunch/tHit above are always the first engagement.
  engagements: CHUTE_MODE ? [] : ENGS.map((e) => ({
    tLaunch: e.tLaunch, tHit: e.tHit, interceptMiss: e.interceptMiss, burstDist: e.burstDist, hitPos: e.hitPos,
    missileStart: e.missileStart, launchDir: e.launchDir,
  })),
  // Per drone: when its catapult stroke starts and its booster burns (drone 0 is the first).
  drones: FLIGHTS.map((f) => ({
    tShift: f.shift, tLoad: 0, tSpool: T_SPOOL + f.shift, tRelease: f.tRelease,
    tBoost0: T_SPOOL + f.shift, tBoost1: T_RELEASE + 1.2 + f.shift,
  })),
  // Intercept: main raises tEnd once the debris knows how long it takes to fall.
  tEnd: CHUTE_MODE ? T_SPLASH + 14 : ENGS[ENGS.length - 1].tHit + 15,
  events: [
    { t: 0, label: 'Engine run-up' },
    { t: T_RELEASE, label: 'Catapult launch' },
    ...pathMarkers.map(({ t, label }) => ({ t, label })),
    ...(CHUTE_MODE
      ? [{ t: T_LOCK, label: 'Launcher lock-on' }, { t: T_CHUTE, label: 'Parachute opens' }, { t: T_SPLASH, label: 'Splashdown' }]
      : [{ t: T_LAUNCH, label: 'Missile launch' }, { t: tHit, label: 'Impact' }]),
  ].sort((a, b) => a.t - b.t),
};

// Firing tube mouth in world space at time t (follows the launcher's slew).
const _tq = new THREE.Quaternion();
export function tubeMouth(t, out, k = 0) {
  const { yaw, pitch } = launcherAim(t);
  return out.copy(TUBE_MOUTHS[k]).applyQuaternion(launcherQuat(yaw, pitch, _tq))
    .add(LAUNCHER_PIVOT).add(shipPos(t, _d));
}

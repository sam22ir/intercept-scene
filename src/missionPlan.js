// The mission plan of the Watch missions (Missile intercept, Parachute recovery): the settings of the window that opens
// when you press Start, and the drone's path and speed generated from them. Pure: it imports nothing, so the main menu
// can draw the path without loading the scene, and test/missionPlan.test.mjs checks it in Node. Storage is only read
// and written inside try. Scenario.js reads the plan once at import, from globalThis.__PLAN (set by start.js).
//
// The path, in the ship's frame (bow +X, starboard +Z): off the catapult, out ahead of the ship (forward launcher) or
// astern of her (aft launcher) on her port side while climbing; at the turn-back distance a turn at the radius this speed
// allows; then a straight run in at the ship, along her centre line, on which the missile is fired at the engagement
// distance (Recovery: the launcher locks on there, and the drone later leaves for the recovery point).

const G = 9.81;
const DEG = Math.PI / 180;
const KN = 0.514444; // m/s
const CLIMB_SLOPE = Math.tan(13 * DEG); // steepest climb
const DESCENT_LENGTH = 7; // metres flown per metre of height lost: a smoothstep at this length peaks at 12 degrees

// The release point of the catapult (the second of scenario.js's PATH_FIXED; a test keeps them equal) and the rail's yaw.
export const RAIL_END = [-37.75, 15.07, -18.19];
const RAIL_YAW = 50;
export const RECOVERY_AT = [-212, 90, -212];
const RUN_END = 100; // the run in ends here, before the ship: the missile has long hit (Recovery leaves it earlier)

export const PLAN_KEY = 'intercept.plan.v1';
export const PLAN_MODES = ['intercept', 'chute'];
export const WEATHER_CHOICES = ['auto', 'clear', 'haze', 'squalls', 'overcast'];
export const TOD_CHOICES = ['auto', 'dawn', 'noon', 'dusk'];

//                 name:        min, max, step, default
export const PLAN_RANGES = {
  alt: [60, 1000, 10, 250], // the highest the drone flies, m
  runAlt: [40, 1000, 10, 250], // its height on the run in, m (at most alt)
  turnBack: [800, 5000, 50, 1600], // distance from the ship at which it starts to turn back, m
  engage: [200, 1500, 50, 650], // distance at which the missile leaves (Recovery: the lock-on), m
  droneSpeed: [45, 100, 1, 75], // level flight, m/s
  shipKn: [5, 30, 1, 14], // knots
  heading: [0, 359, 5, 0], // degrees
  burst: [0, 60, 5, 0], // how far from the drone the warhead goes off, m (0: a direct hit)
};
export const PLAN_DEFAULTS = {
  ...Object.fromEntries(Object.entries(PLAN_RANGES).map(([k, r]) => [k, r[3]])),
  weather: 'auto',
  tod: 'auto',
  drawn: false, // fly the path drawn in the editor instead of generating one
};

export function validatePlan(o) {
  if (!o || typeof o !== 'object') return null;
  const out = { ...PLAN_DEFAULTS };
  for (const [k, [lo, hi]] of Object.entries(PLAN_RANGES)) {
    const v = Number(o[k]);
    if (o[k] !== undefined && o[k] !== null && Number.isFinite(v)) out[k] = Math.min(Math.max(Math.round(v), lo), hi);
  }
  out.runAlt = Math.min(out.runAlt, out.alt);
  if (WEATHER_CHOICES.includes(o.weather)) out.weather = o.weather;
  if (TOD_CHOICES.includes(o.tod)) out.tod = o.tod;
  out.drawn = o.drawn === true;
  return out;
}

export function loadPlan() {
  try {
    const raw = globalThis.localStorage?.getItem(PLAN_KEY);
    return raw ? validatePlan(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}
export function savePlan(plan) {
  try { globalThis.localStorage?.setItem(PLAN_KEY, JSON.stringify(plan)); } catch { /* storage unavailable */ }
}
// The path editor's Apply and Restore: whether the plan flies the drawn path from now on.
export function setPlanDrawn(drawn) {
  const plan = loadPlan();
  if (plan) savePlan({ ...plan, drawn });
}

export const shipSpeedOf = (plan) => plan.shipKn * KN;

// Speed over the sea at a given slope (the sine of the flight path angle): the cruise speed in level flight, slower going
// up, faster coming down, as far as 30 percent either way.
export function speedAtSlope(cruise, sinSlope) {
  return cruise * Math.min(1.3, Math.max(0.7, 1 - sinSlope));
}
// The speed along the path in the ship's frame that gives `v` over the sea, `dx` being the path's direction along the bow.
export function relSpeed(v, ship, dx) {
  return -ship * dx + Math.sqrt(Math.max(1, v * v - ship * ship * (1 - dx * dx)));
}
// The turn: 45 degrees of bank at the fastest the path is flown relative to the ship (the limit is 50).
export function turnRadius(plan) {
  return (plan.droneSpeed * 1.05 + shipSpeedOf(plan)) ** 2 / G;
}

// The sun for a heading and a time of day: elev and az in the terms of looks.js. The bow is the scene's +X, so a sun at
// compass bearing B stands at azimuth 90 - (B - heading) there; `Auto` keeps the mission's own sun, turned by the heading.
const TOD_SUN = { dawn: { elev: 7, bearing: 90 }, noon: { elev: 60, bearing: 180 }, dusk: { elev: 8, bearing: 270 } };
export function planSky(plan) {
  if (!plan) return null;
  const sun = TOD_SUN[plan.tod];
  return sun ? { elev: sun.elev, az: 90 - sun.bearing + plan.heading } : { azAdd: plan.heading };
}

// A stored engagement setting that says the same as the plan (the engagement panel then opens on these values).
export const planEngage = (plan) => ({ timing: 'range', time: 0, range: plan.engage, dist: plan.burst, side: 'auto' });

const smooth = (u) => { const x = Math.min(1, Math.max(0, u)); return x * x * (3 - 2 * x); };

// The shape on the sea for an outbound heading `a` (degrees off the bow or the stern), or null if it cannot be flown.
function outline(a, R, aft) {
  const [x0, , z0] = RAIL_END;
  const th = aft ? 180 - a : a; // heading: degrees from the bow toward port
  const left = th > RAIL_YAW;
  const c = (d) => Math.cos(d * DEG);
  const s = (d) => Math.sin(d * DEG);
  // The first arc, from the rail's heading onto the outbound one.
  const qx = x0 + (left ? R * (s(th) - s(RAIL_YAW)) : R * (s(RAIL_YAW) - s(th)));
  const qz = z0 + (left ? R * (c(th) - c(RAIL_YAW)) : R * (c(RAIL_YAW) - c(th)));
  // The outbound leg ends where the turn back brings the drone out on the ship's centre line.
  const pz = -R * (1 + c(a));
  const L = (qz - pz) / s(a);
  if (L < 0) return null;
  const px = qx + L * c(th);
  const ex = px + (aft ? -1 : 1) * R * s(a);
  const ahead = aft ? -1 : 1;
  if (px * ahead < 100 || ex * ahead < 200) return null;
  return { a, th, left, qx, qz, L, px, pz, ex, turnBack: Math.hypot(px, pz), far: Math.abs(ex) + R };
}

// The shape nearest to a turn-back distance; also the shortest one this speed can fly.
function solveOutline(target, R, aft) {
  let best = null;
  let shortest = Infinity;
  for (let a = 1; a <= 85; a += 0.25) {
    const o = outline(a, R, aft);
    if (!o) continue;
    shortest = Math.min(shortest, o.turnBack);
    if (!best || Math.abs(o.turnBack - target) < Math.abs(best.turnBack - target)) best = o;
  }
  return { best, shortest };
}

// The drone's path from a plan, as editable points [x, alt, z] after the catapult's own. Also says what it really came to,
// since a fast drone needs room: `notes` lists each setting that had to give way, as { key, value }.
export function generatePath(plan, { variant = 'fwd', mode = 'intercept' } = {}) {
  const aft = variant === 'aft';
  const R = turnRadius(plan);
  const { best: o, shortest } = solveOutline(plan.turnBack, R, aft);
  const notes = [];
  if (Math.abs(o.turnBack - plan.turnBack) > 50) notes.push({ key: 'turnBack', value: Math.round(o.turnBack) });
  const dirX = aft ? -1 : 1;
  const exitRange = Math.abs(o.ex);
  const engage = Math.min(plan.engage, Math.round(exitRange - 150));
  if (engage < plan.engage) notes.push({ key: 'engage', value: engage });

  // The ground track, as points with the distance flown along it.
  const track = [];
  let [x, , z] = RAIL_END;
  let s = 0;
  const push = (nx, nz) => { s += Math.hypot(nx - x, nz - z); x = nx; z = nz; track.push({ x, z, s }); };
  const arc = (from, to, left) => {
    const step = (to - from) / Math.max(1, Math.ceil(Math.abs(to - from) / 15));
    for (let d = from + step; left ? d <= to + 1e-6 : d >= to - 1e-6; d += step) {
      const a = d - step;
      const c0 = Math.cos(a * DEG), c1 = Math.cos(d * DEG), s0 = Math.sin(a * DEG), s1 = Math.sin(d * DEG);
      push(x + (left ? R * (s1 - s0) : R * (s0 - s1)), z + (left ? R * (c1 - c0) : R * (c0 - c1)));
    }
  };
  if (Math.abs(o.th - RAIL_YAW) > 0.5) arc(RAIL_YAW, o.th, o.left);
  const legs = Math.max(1, Math.ceil(o.L / Math.max(160, o.L / 18)));
  const qx = x, qz = z;
  for (let i = 1; i <= legs; i++) push(qx + ((o.px - qx) * i) / legs, qz + ((o.pz - qz) * i) / legs);
  const sTurn = s;
  arc(o.th, aft ? 360 : -180, aft);
  const sExit = s;

  // Recovery leaves the run in early enough to come down to the recovery point.
  const chute = mode === 'chute';
  const runAltWanted = Math.min(plan.runAlt, plan.alt);
  const leave = chute ? Math.min(exitRange - 100, Math.max(engage * 0.85, 500)) : RUN_END;
  const runLen = exitRange - leave;
  const runLegs = Math.max(1, Math.min(22, Math.ceil(runLen / 150)));
  const ex = x;
  for (let i = 1; i <= runLegs; i++) push(ex - dirX * (runLen * i) / runLegs, z + ((0 - z) * i) / runLegs);
  const sLeave = s;
  if (chute) {
    const lx = x, lz = z;
    const n = 9;
    for (let i = 1; i <= n; i++) push(lx + ((RECOVERY_AT[0] - lx) * i) / n, lz + ((RECOVERY_AT[2] - lz) * i) / n);
  }
  const sEnd = s;

  // The height along it: the climb eases off as it reaches the top, and any descent is over before the engagement.
  const y0 = RAIL_END[1];
  const sEngage = sExit + Math.max(0, exitRange - engage - 150);
  const chuteAt = Math.min(RECOVERY_AT[1], plan.alt);
  let alt = plan.alt;
  // Recovery has to fit the way down as well as the way up: 2 / slope metres flown per metre climbed, then DESCENT_LENGTH per metre down.
  const room = chute ? Math.floor((sEnd + (2 * y0) / CLIMB_SLOPE + DESCENT_LENGTH * chuteAt) / (2 / CLIMB_SLOPE + DESCENT_LENGTH)) : Infinity;
  const reach = Math.floor(y0 + (sEngage * CLIMB_SLOPE) / 2);
  if (alt > Math.min(room, reach)) {
    alt = Math.min(room, reach);
    notes.push({ key: 'alt', value: alt });
  }
  const climb = Math.min(sEngage, Math.max(sTurn, (2 * (alt - y0)) / CLIMB_SLOPE));
  let runAlt = Math.min(runAltWanted, alt);
  let dropFrom = sEngage - DESCENT_LENGTH * (alt - runAlt);
  if (dropFrom < climb) {
    dropFrom = climb;
    runAlt = Math.ceil(alt - (sEngage - climb) / DESCENT_LENGTH);
  }
  if (runAlt > runAltWanted && runAltWanted < alt) notes.push({ key: 'runAlt', value: runAlt });
  const sDown = Math.max(climb, Math.min(sLeave, sEnd - DESCENT_LENGTH * (alt - chuteAt)));
  const heightAt = (d) => {
    if (d <= climb) { const u = d / climb; return y0 + (alt - y0) * (1 - (1 - u) * (1 - u)); }
    let h = alt;
    if (runAlt < alt && d > dropFrom) h = alt + (runAlt - alt) * smooth((d - dropFrom) / Math.max(1, sEngage - dropFrom));
    if (chute && d > sDown) h += (chuteAt - h) * smooth((d - sDown) / (sEnd - sDown));
    return h;
  };
  const points = track.map((p) => [Math.round(p.x), Math.round(Math.max(8, heightAt(p.s))), Math.round(p.z)]);

  return {
    points, radius: R, turnBack: o.turnBack, shortestTurnBack: shortest, exitRange, far: o.far, engage, alt, runAlt, notes,
    sTurn, sExit, length: sEnd, turnPoint: [o.px, o.pz],
  };
}

// What the path comes to, for the window's readouts: the speeds over the sea and the time from release to the engagement.
export function planStats(plan, path) {
  const ship = shipSpeedOf(plan);
  const pts = [[RAIL_END[0], RAIL_END[1], RAIL_END[2]], ...path.points];
  let t = 0;
  let vMin = Infinity;
  let vMax = 0;
  let tEngage = null;
  let wasOut = false;
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay, az] = pts[i - 1];
    const [bx, by, bz] = pts[i];
    const d = Math.hypot(bx - ax, by - ay, bz - az);
    if (d < 1) continue;
    const v = speedAtSlope(plan.droneSpeed, (by - ay) / d);
    vMin = Math.min(vMin, v);
    vMax = Math.max(vMax, v);
    t += d / relSpeed(v, ship, (bx - ax) / d);
    const range = Math.hypot(bx, bz);
    if (range > path.engage) wasOut = true;
    if (wasOut && tEngage === null && range <= path.engage && i > 3) tEngage = t;
  }
  return { vMin, vMax, tFlight: t, tEngage: tEngage ?? t };
}

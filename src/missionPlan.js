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
const SLOPE = Math.tan(20 * DEG); // climbs and descents over the sea, the owner's figure
const EASE = 150; // metres over which the drone eases into and out of that slope
const TURN_BANK = 45; // degrees, the owner's figure: the radius follows from the speed

// The release point of the catapult (the second of scenario.js's PATH_FIXED; a test keeps them equal) and the rail's yaw.
export const RAIL_END = [-37.75, 15.07, -18.19];
const RAIL_YAW = 50;
export const RECOVERY_AT = [-212, 90, -212];
const RUN_END = 100; // the run in ends here, before the ship: the missile has long hit (Recovery leaves it earlier)
export const PATH_LIMIT = 20000; // m from the ship, ahead or abeam: room for the longest turn back and its turn
export const MAX_KEYS = 12; // manoeuvre points in the path editor
export const MAX_ALT = 1000;
const SIDE_MARGIN = 100; // the launcher's side begins this far ahead of (or astern of) the ship's centre
const WRONG_SIDE = 300; // m a generated path may go the other way along the ship: the rail, and the recovery point's quarter

export const PLAN_KEY = 'intercept.plan.v1';
export const PLAN_MODES = ['intercept', 'chute'];
export const WEATHER_CHOICES = ['auto', 'clear', 'haze', 'squalls', 'overcast'];
export const TOD_CHOICES = ['auto', 'dawn', 'noon', 'dusk', 'night'];

//                 name:        min, max, step, default
export const PLAN_RANGES = {
  alt: [60, 1000, 10, 250], // the highest the drone flies, m
  runAlt: [40, 1000, 10, 250], // its height on the run in, m (at most alt)
  turnBack: [800, 15000, 100, 1600], // distance from the ship at which it starts to turn back, m
  engage: [200, 5500, 50, 650], // distance at which the missile leaves (Recovery: the lock-on), m
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
// The radius of the turns: 45 degrees of bank at the cruise speed, so v^2 / (g tan 45): 573 m at 75 m/s.
export function turnRadius(plan) {
  return plan.droneSpeed ** 2 / (G * Math.tan(TURN_BANK * DEG));
}

// The sun for a heading and a time of day: elev and az in the terms of looks.js. The bow is the scene's +X, so a sun at
// compass bearing B stands at azimuth 90 - (B - heading) there; `Auto` keeps the mission's own sun, turned by the heading.
// At night the light comes from the moon, which is placed the same way. Noon wears Solo Air Defense's daylight (`day`, looks.js).
const TOD_SUN = { dawn: { elev: 7, bearing: 90 }, noon: { elev: 45, bearing: 180, day: true }, dusk: { elev: 8, bearing: 270 }, night: { elev: 40, bearing: 200, night: true } };
export function planSky(plan) {
  if (!plan) return null;
  const sun = TOD_SUN[plan.tod];
  if (!sun) return { azAdd: plan.heading };
  const { bearing, ...sky } = sun;
  return { ...sky, az: 90 - bearing + plan.heading };
}

// A stored engagement setting that says the same as the plan (the engagement panel then opens on these values).
export const planEngage = (plan) => ({ timing: 'range', time: 0, range: plan.engage, dist: plan.burst, side: 'auto' });

// --- The flight between manoeuvre points --------------------------------------------------------------------------
// A route is a short list of manoeuvre points [x, alt, z] in the ship's frame, after the catapult. At each point the drone
// starts whatever comes next: it turns at 45 degrees of bank until it is heading for the next point, and it starts to
// climb or descend at 20 degrees toward that point's altitude, then holds it. So a point marks where a manoeuvre starts,
// and everything between the points follows from the owner's figures. flyRoute flies that once, stepping time, and returns
// the points of the spline scenario.js flies. The generated path and the path editor both come from here.
const ROUTE_DT = 0.1;
const SPACINGS = [160, 250, 400, 700, 1200, 2500]; // m between points on the straights: the first that fits the editor's 80
const wrap180 = (d) => ((((d + 180) % 360) + 360) % 360) - 180;

function simulateRoute(keys, V, ship, spacing) {
  const slow = 0.7 * V;
  const sinFull = Math.sin(20 * DEG);
  let [x, h, z] = RAIL_END;
  let th = Math.atan2(slow * Math.sin(RAIL_YAW * DEG), slow * Math.cos(RAIL_YAW * DEG) + ship) / DEG; // heading over the sea: degrees from the bow toward port
  let lag = Math.sin(18 * DEG); // the slope the speed is following (the rail's, to begin with)
  let s = 0;
  const marks = [];
  const keyS = [];
  const alignedS = [];
  const arrivals = [];
  const notes = [];
  let top = h;
  let turnedSince = 0;
  let flownSince = 0;
  let markedSin = sinFull;
  let lastSin = sinFull;
  const mark = (must) => {
    const last = marks[marks.length - 1];
    if (last && s - last.s < 40) { if (!must) return; if (!last.must) marks.pop(); else if (s - last.s < 5) return; }
    marks.push({ x, h, z, s, must });
    turnedSince = 0;
    flownSince = 0;
  };
  keys.forEach(([kx, kAlt, kz], i) => {
    let side = null;
    let aligned = false;
    let turned = 0;
    let triedOther = false;
    // Off the rail the climb starts from the rail's own slope, and one still under way simply carries on past a point.
    let sinceStart = i === 0 || (lastSin !== 0 && Math.sign(lastSin) === Math.sign(kAlt - h)) ? Infinity : 0;
    const saved = () => ({ x, h, z, th, lag, s, turnedSince, flownSince, markedSin, marks: marks.length, sinceStart });
    let start = saved();
    const moved = Math.hypot(kx - x, kz - z);
    for (let step = 0; step < 60000 && moved > 0.5; step++) {
      const rem = kAlt - h;
      const ease = Math.min(1, Math.sqrt((2 * Math.abs(rem)) / (SLOPE * EASE)), (sinceStart + 10) / EASE);
      const sinG = Math.abs(rem) > 0.05 ? Math.sign(rem) * sinFull * ease : 0;
      lastSin = sinG;
      lag += ((sinG - lag) * ROUTE_DT) / 2;
      const v = speedAtSlope(V, lag);
      const hv = v * Math.sqrt(1 - sinG * sinG);
      const rate = ((G * Math.tan(TURN_BANK * DEG)) / v) * (ROUTE_DT / DEG); // degrees this step, at 45 degrees of bank
      const dx = kx - x;
      const dz = kz - z;
      const err = wrap180(Math.atan2(-dz, dx) / DEG - Math.atan2(hv * Math.sin(th * DEG), hv * Math.cos(th * DEG) - ship) / DEG);
      if (side === null) side = Math.abs(err) < 1 ? 0 : Math.sign(err);
      if (!aligned && (side === 0 || Math.abs(err) <= rate * 1.2)) { aligned = true; alignedS[i] = s; }
      const dth = aligned ? Math.min(rate, Math.max(-rate, err)) : side * rate;
      th += dth;
      turned += Math.abs(dth);
      turnedSince += Math.abs(dth);
      if (!aligned && turned > 400) {
        // The next point lies inside this turning circle: the other way round, or, if neither reaches it, straight at it.
        if (!triedOther) {
          triedOther = true;
          const tried = side;
          ({ x, h, z, th, lag, s, turnedSince, flownSince, markedSin, sinceStart } = start);
          marks.length = start.marks;
          side = -tried;
          turned = 0;
          continue;
        }
        notes.push({ key: 'tight', index: i });
        ({ x, h, z, th, lag, s, turnedSince, flownSince, markedSin, sinceStart } = start);
        marks.length = start.marks;
        th = Math.atan2(-dz, dx) / DEG;
        side = 0;
        aligned = true;
        alignedS[i] = s;
        start = saved();
        continue;
      }
      const ux = hv * Math.cos(th * DEG) - ship;
      const uz = -hv * Math.sin(th * DEG);
      const ds = Math.hypot(ux, uz) * ROUTE_DT;
      x += ux * ROUTE_DT;
      z += uz * ROUTE_DT;
      const climbed = v * sinG * ROUTE_DT;
      h = Math.max(8, Math.abs(climbed) > Math.abs(rem) ? kAlt : h + climbed);
      top = Math.max(top, h);
      s += ds;
      flownSince += ds;
      sinceStart += ds;
      if (aligned && ((kx - x) * dx + (kz - z) * dz < 0 || Math.hypot(kx - x, kz - z) < ds * 0.6)) break;
      if (turnedSince >= 15 || flownSince >= spacing || Math.abs(sinG - markedSin) > 0.12) {
        markedSin = sinG;
        mark(false);
      }
    }
    x = kx;
    z = kz;
    keyS[i] = s;
    arrivals[i] = h;
    mark(true);
    const next = keys[i + 1];
    if (Math.abs(h - kAlt) > 3 && (!next || next[1] !== kAlt)) notes.push({ key: 'steep', index: i, value: Math.round(h) });
  });
  return { marks, keyS, alignedS, arrivals, notes, top, length: s };
}

// `opts`: { droneSpeed, ship } (m/s). Returns { points, keyS, alignedS, arrivals, notes, top, length }.
export function flyRoute(keys, { droneSpeed, ship }) {
  let run = null;
  for (const spacing of SPACINGS) {
    run = simulateRoute(keys, droneSpeed, ship, spacing);
    if (run.marks.length <= 78) break;
  }
  const last = keys[keys.length - 1];
  const points = run.marks.map((m) => [Math.round(m.x), Math.round(m.h), Math.round(m.z)]);
  if (last && points.length) points[points.length - 1][1] = Math.round(last[1]);
  return { ...run, points };
}

// What the drone starts at manoeuvre point i of a flown route: { turn, alt: 'up' | 'down' | null, last }.
export function keyManoeuvre(keys, route, i) {
  if (i >= keys.length - 1) return { turn: false, alt: null, last: true };
  const here = route.arrivals[i] ?? keys[i][1];
  const to = keys[i + 1][1];
  const turning = (route.alignedS[i + 1] ?? route.keyS[i]) - route.keyS[i] > 20;
  return { turn: turning, alt: Math.abs(to - here) <= 3 ? null : to > here ? 'up' : 'down', last: false };
}

// Keeps a manoeuvre point within the rules: on the launcher's side of the ship (the forward launcher's drone flies ahead of
// her, the aft launcher's astern), except the recovery's last point, where the parachute opens beside her.
export function clampKey([x, alt, z], index, count, { variant = 'fwd', mode = 'intercept' } = {}) {
  const lim = (v) => Math.round(Math.min(PATH_LIMIT, Math.max(-PATH_LIMIT, v)));
  let nx = lim(x);
  if (!(mode === 'chute' && index === count - 1)) nx = variant === 'aft' ? Math.min(nx, -SIDE_MARGIN) : Math.max(nx, SIDE_MARGIN);
  return [nx, Math.round(Math.min(MAX_ALT, Math.max(8, alt))), lim(z)];
}

// A cleaned copy of a stored list of manoeuvre points, or null if it is unusable.
export function validateKeys(list) {
  if (!Array.isArray(list) || list.length < 1 || list.length > MAX_KEYS) return null;
  for (const k of list) {
    if (!Array.isArray(k) || k.length !== 3 || !k.every(Number.isFinite)) return null;
    if (Math.abs(k[0]) > PATH_LIMIT || Math.abs(k[2]) > PATH_LIMIT || k[1] > MAX_ALT) return null;
  }
  return list.map(([x, alt, z]) => [Math.round(x), Math.round(Math.max(8, alt)), Math.round(z)]);
}

// The manoeuvre points of a path that has none stored (one drawn before them, or a shared link): where it really bends.
export function detectKeys(points) {
  const all = [RAIL_END, ...points];
  const off = (p, a, b) => {
    const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const l2 = ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2 || 1;
    const u = Math.max(0, Math.min(1, ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1] + (p[2] - a[2]) * ab[2]) / l2));
    return Math.hypot(p[0] - a[0] - ab[0] * u, p[1] - a[1] - ab[1] * u, p[2] - a[2] - ab[2] * u);
  };
  let kept = [];
  for (let tol = 30; ; tol *= 1.5) {
    const keep = new Set([0, all.length - 1]);
    const walk = (lo, hi) => {
      let worst = 0;
      let at = -1;
      for (let i = lo + 1; i < hi; i++) {
        const d = off(all[i], all[lo], all[hi]);
        if (d > worst) { worst = d; at = i; }
      }
      if (worst > tol) { keep.add(at); walk(lo, at); walk(at, hi); }
    };
    walk(0, all.length - 1);
    kept = [...keep].sort((a, b) => a - b).slice(1).map((i) => all[i]);
    if (kept.length <= MAX_KEYS) break;
  }
  return kept.map((p) => p.map(Math.round));
}

// The shape for an outbound heading `a` (degrees off the bow or the stern), or null if it cannot be flown. A steady bank is a
// steady turn over the sea, so headings here are over the sea and each turn is a true circle there: in the ship's frame it
// is that circle less the ship's own run while it is flown (across her, z, the two are the same).
function outline(a, plan, aft) {
  const [x0, , z0] = RAIL_END;
  const R = turnRadius(plan);
  const V = plan.droneSpeed;
  const ship = shipSpeedOf(plan);
  const th = aft ? 180 - a : a; // heading: degrees from the bow toward port
  const c = (d) => Math.cos(d * DEG);
  const s = (d) => Math.sin(d * DEG);
  // The first turn, from the rail onto the outbound heading, flown step by step at the speed the drone has: the climb's
  // while it climbs, then picking up to the cruise speed. At the same bank, slower means tighter.
  const slow = 0.7 * V;
  const th0 = Math.atan2(slow * s(RAIL_YAW), slow * c(RAIL_YAW) + ship) / DEG;
  const left = th > th0;
  const first = [];
  let qx = x0;
  let qz = z0;
  let h = RAIL_END[1];
  let v = slow;
  let heading = th0;
  let sinceMark = 0;
  while (Math.abs(th - heading) > 1e-6) {
    const dt = 0.1;
    const turn = Math.min(Math.abs(th - heading), ((G * Math.tan(TURN_BANK * DEG)) / v) * dt / DEG);
    const mid = heading + ((left ? 1 : -1) * turn) / 2;
    const climbing = h < plan.alt;
    if (climbing) h += v * Math.sin(20 * DEG) * dt; else v += ((V - v) * dt) / 2;
    const hv = climbing ? v * Math.cos(20 * DEG) : v;
    qx += (hv * c(mid) - ship) * dt;
    qz -= hv * s(mid) * dt;
    heading += (left ? 1 : -1) * turn;
    sinceMark += turn;
    if (sinceMark >= 15) { first.push([qx, qz]); sinceMark = 0; }
  }
  // The last piece: a very short leg would kink the spline, so a small one replaces the mark before it.
  if (sinceMark > 0) { if (sinceMark < 7 && first.length) first.pop(); first.push([qx, qz]); }
  // The outbound leg ends where the turn back brings the drone out on the ship's centre line.
  const pz = -R * (1 + c(a));
  const L = (qz - pz) / s(a);
  if (L < 0) return null;
  const px = qx + L * (c(th) - ship / V);
  const ex = px + (aft ? -1 : 1) * R * s(a) - (ship * (a + 180) * DEG * R) / V;
  const ahead = aft ? -1 : 1;
  if (px * ahead < 100 || ex * ahead < 200) return null;
  return { a, th, first, L, px, pz, ex, turnBack: Math.hypot(px, pz), far: Math.abs(ex) + R };
}

// The shape nearest to a turn-back distance; also the shortest one this speed can fly.
function solveOutline(target, plan, aft) {
  let best = null;
  let shortest = Infinity;
  for (let a = 1; a <= 85; a += a < 12 ? 0.02 : 0.25) { // a long outbound leg is very sensitive to it
    const o = outline(a, plan, aft);
    if (!o) continue;
    shortest = Math.min(shortest, o.turnBack);
    if (!best || Math.abs(o.turnBack - target) < Math.abs(best.turnBack - target)) best = o;
  }
  // Very long legs: a hundredth of a degree there is tens of metres, so a finer look round the best.
  if (best && best.a < 12) {
    const around = best.a;
    for (let a = around - 0.02; a <= around + 0.02; a += 0.002) {
      const o = a > 0.2 ? outline(a, plan, aft) : null;
      if (o && Math.abs(o.turnBack - target) < Math.abs(best.turnBack - target)) best = o;
    }
  }
  return { best, shortest };
}

// The drone's path from a plan, as editable points [x, alt, z] after the catapult's own. Also says what it really came to,
// since a fast drone needs room: `notes` lists each setting that had to give way, as { key, value }. The turn back flown can
// come out a little off the drawn one, and when the next point then lies inside its circle the drone goes round the other
// way, far past the ship. Too short a turn back for this ship's speed, then: it gives way, further out, until it holds.
export function generatePath(plan, opts = {}) {
  const ahead = opts.variant === 'aft' ? -1 : 1;
  let path = null;
  for (let target = plan.turnBack; target <= plan.turnBack + 5000; target += 100) {
    path = pathFor(plan, target, opts);
    const out = Math.max(...path.points.map((q) => q[0] * ahead));
    const back = Math.max(...path.points.map((q) => -q[0] * ahead));
    if (back <= WRONG_SIDE && out > back + 300) break;
  }
  return path;
}

// The window's turn-back and engagement sliders move each other, as its two altitudes do. The engagement has to fit on the
// run in, so asking for more of it takes the turn back further out, and a shorter turn back brings the engagement in.
export function linkRanges(plan, key, opts = {}) {
  const next = { ...plan };
  if (key === 'engage') {
    const [, hi, step] = PLAN_RANGES.turnBack;
    for (let tries = 0; tries < 12 && next.turnBack < hi; tries++) {
      const short = next.engage - generatePath(next, opts).engage;
      if (short <= 0) break;
      next.turnBack = Math.min(hi, next.turnBack + Math.ceil(short / step) * step);
    }
  } else if (key === 'turnBack') {
    const [lo, , step] = PLAN_RANGES.engage;
    const held = generatePath(next, opts).engage;
    if (held < next.engage) next.engage = Math.max(lo, Math.floor(held / step) * step);
  }
  return next;
}

function pathFor(plan, target, { variant = 'fwd', mode = 'intercept' }) {
  const aft = variant === 'aft';
  const R = turnRadius(plan);
  const { best: o, shortest } = solveOutline(target, plan, aft);
  const notes = [];
  if (Math.abs(o.turnBack - plan.turnBack) > 50) notes.push({ key: 'turnBack', value: Math.round(o.turnBack) });
  const dirX = aft ? -1 : 1;
  const exitRange = Math.abs(o.ex);
  const engage = Math.min(plan.engage, Math.round(exitRange - 150));
  if (engage < plan.engage) notes.push({ key: 'engage', value: engage });

  // The manoeuvre points: the turn back, where the run in starts down to its own height (level again before the engagement)
  // and the end of the run; in Recovery also where it leaves the run for the recovery point. Everything else is flown.
  const chute = mode === 'chute';
  const ship = shipSpeedOf(plan);
  const chuteAt = Math.min(RECOVERY_AT[1], plan.alt);
  const onLine = (r) => [Math.round(dirX * r), 0];
  // Metres along the ship's frame per metre of height lost at 20 degrees, for a leg flown `along` the bow (+1) or against it.
  const perMetre = (along) => { const hv = plan.droneSpeed * 1.3 * Math.cos(20 * DEG); return ((hv - ship * along) / hv) / SLOPE; };
  const downRun = perMetre(aft ? 1 : -1);
  const room = exitRange - 50 - engage - 150 - EASE;
  const build = (top, runWanted) => {
    let run = Math.min(runWanted, top);
    if (chute) {
      // The way down to the parachute has to fit between leaving the run and the recovery point.
      const leaveMin = Math.max(engage * 0.85, 500);
      const leaveMax = Math.max(leaveMin, exitRange - 100);
      const legFrom = (r) => Math.hypot(dirX * r - RECOVERY_AT[0], RECOVERY_AT[2]);
      const needed = (from) => EASE + Math.abs(from - chuteAt) * 1.25 / SLOPE;
      let leave = leaveMin;
      while (leave < leaveMax && legFrom(leave) < needed(run)) leave += 50;
      leave = Math.min(leave, leaveMax);
      if (legFrom(leave) < needed(run)) run = Math.max(chuteAt, Math.floor(chuteAt + ((legFrom(leave) - EASE) * SLOPE) / 1.25));
      const keys = [[Math.round(o.px), top, Math.round(o.pz)]];
      const dropLen = (top - run) * downRun + EASE;
      if (top > run) {
        const from = Math.min(exitRange - 50, leave + dropLen);
        if (from - leave < dropLen) run = Math.ceil(top - Math.max(0, from - leave - EASE) / downRun);
        if (top > run) keys.push([onLine(from)[0], top, 0]);
      }
      keys.push([onLine(leave)[0], run, 0], [RECOVERY_AT[0], chuteAt, RECOVERY_AT[2]]);
      return { keys, run };
    }
    const keys = [[Math.round(o.px), top, Math.round(o.pz)]];
    if (top > run) {
      if ((top - run) * downRun > room) run = Math.ceil(top - Math.max(0, room) / downRun);
      const dropLen = (top - run) * downRun + EASE;
      if (top > run) keys.push([onLine(engage + 150 + dropLen)[0], top, 0]);
    }
    keys.push([onLine(RUN_END)[0], run, 0]);
    return { keys, run };
  };
  const runAltWanted = Math.min(plan.runAlt, plan.alt);
  // How high it gets before it has to be at its own height: a climb still under way there means the top was too high.
  const heightBy = (route, keys) => {
    if (chute || keys.length > 2) return route.arrivals[1];
    const m =route.marks.find((p) => p.s > route.keyS[0] && Math.abs(p.z) < 2 && Math.abs(p.x) <= engage + 150);
    return m ? m.h : route.top;
  };
  let alt = plan.alt;
  let { keys, run: runAlt } = build(alt, runAltWanted);
  let route = flyRoute(keys, { droneSpeed: plan.droneSpeed, ship });
  for (let tries = 0; tries < 8; tries++) {
    const reached = heightBy(route, keys);
    // Recovery: still too high at the recovery point means the way down did not fit, so the top comes down by as much.
    const over = chute ? route.arrivals[route.arrivals.length - 1] - chuteAt : 0;
    if (reached >= alt - 2 && over <= 3) break;
    alt = Math.max(chuteAt, Math.floor(over > 3 ? Math.min(reached, alt - over) : reached));
    ({ keys, run: runAlt } = build(alt, Math.min(runAltWanted, alt)));
    route = flyRoute(keys, { droneSpeed: plan.droneSpeed, ship });
  }
  if (alt < plan.alt) notes.push({ key: 'alt', value: alt });
  if (runAlt > runAltWanted) notes.push({ key: 'runAlt', value: runAlt });

  return {
    points: route.points, keys, radius: R, turnBack: o.turnBack, shortestTurnBack: shortest, exitRange, far: o.far, engage, alt, runAlt, notes,
    sTurn: route.keyS[0], sExit: route.alignedS[1] ?? route.keyS[1], length: route.length, turnPoint: [o.px, o.pz],
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

// Fleet command, hook 1: what an order does, and where a squadron ship steers. Pure and deterministic: imports nothing,
// no randomness, and steerGoal never changes the ship.
//   applyOrder(sim, order)  -> void   apply one logged order (format in the header of fleet.js) to the ships it names.
//   steerGoal(sim, ship)    -> { course (deg true, 0 = +X, clockwise), kn }   what FleetSim.think steers for, every 0.5 s.
//
// The lead (the first living squadron ship, the guide) always steers her own goal: `course`, `goto` and `speed` orders
// set it. The others steer by what they were ordered, in this priority:
// - form:   each ship holds a station in a formation laid off from the lead, on her present heading (FORM 1 column astern,
//           FORM 3 line abreast to starboard, BOX, FORM D diamond; neighbours FORM_SPACING m apart, the same spacing as
//           the fleet's columns). The station is moving with the lead, so the steering feeds forward her velocity and adds
//           a proportional pull back to the station (time constant K_STATION s).
// - sector: a screen patrol. The ship is laid off from a reference ship (the lead unless `sector.ref` names one) inside
//           true bearings from..to and ranges inner..outer (m). The point she holds sweeps slowly across the sector
//           (bearing period PATROL_BRG_T s, range period PATROL_RANGE_T s), kept 20 % inside the edges, so it is always
//           a point she can reach and she never leaves the sector.
// - goto:   steer for a point; slow to 2 to 5 kn inside GOTO_SLOW m and stop inside GOTO_ARRIVE m.
// - otherwise her own course and speed.
// Orders: a course, goto, form or sector order replaces the others (form and sector are exclusive, and course and goto
// clear both); speed sets the ship's own goal speed (the lead's speed is what the formation feeds forward, so a speed
// order to the lead sets the whole formation's speed); stance hold stops the guns at once (think() would do it in 0.5 s).

const KT = 1852 / 3600; // m/s per knot
const MAX_KN = 22; // the telegraph's Full
const FORM_SPACING = 400; // m between neighbouring stations (the fleet's COLUMN_GAP)
const K_STATION = 45; // s: a station error closes at about this time constant
const PATROL_BRG_T = 900; // s for a full swing of the patrol bearing
const PATROL_RANGE_T = 700; // s for a full swing of the patrol range
const GOTO_SLOW = 150; // m: inside this a goto ship slows
const GOTO_ARRIVE = 40; // m: inside this a goto ship stops

// Stations in units of FORM_SPACING: [ahead, starboard] for the rank of each ship behind the lead (rank 0 = SHIP2).
export const FORMATIONS = {
  'FORM 1': [[-1, 0], [-2, 0], [-3, 0]], // column astern of the lead
  'FORM 3': [[0, 1], [0, 2], [0, 3]], // line abreast to starboard
  BOX: [[0, 1], [-1, 1], [-1, 0]], // a square with the lead at one corner
  'FORM D': [[-1, -1], [-1, 1], [-2, 0]], // diamond: second on the port quarter, third on the starboard, fourth astern
};
const FORM_ALIASES = { COLUMN: 'FORM 1', LINE: 'FORM 3', 'LINE ABREAST': 'FORM 3', DIAMOND: 'FORM D' };

const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;
const wrapDeg = (a) => ((a % 360) + 360) % 360;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// The name a form is known by, or null.
export function canonicalForm(name) {
  if (typeof name !== 'string') return null;
  const k = name.trim().toUpperCase().replace(/\s+/g, ' ');
  if (FORMATIONS[k]) return k;
  return FORM_ALIASES[k] ?? null;
}

// The guide: the first living squadron ship (squad[0] if all are sunk).
export function leadOf(sim) {
  return sim.squad.find((s) => s.tSunk === null) ?? sim.squad[0];
}

// A sector with its numbers checked: null when it cannot be patrolled.
function normaliseSector(sec) {
  if (!sec || typeof sec !== 'object') return null;
  const { from, to, inner, outer } = sec;
  if (![from, to, inner, outer].every(Number.isFinite)) return null;
  const i = Math.max(0, inner), o = Math.max(0, outer);
  if (!(o > i)) return null;
  return { ref: Number.isInteger(sec.ref) ? sec.ref : null, from: wrapDeg(from), to: wrapDeg(to), inner: i, outer: o };
}

export function applyOrder(sim, order) {
  for (const s of sim.targetsOf(order.to)) {
    switch (order.type) {
      case 'course':
        if (!Number.isFinite(order.course)) break;
        s.goal = { ...s.goal, course: wrapDeg(order.course), to: null };
        s.form = null;
        s.sector = null;
        break;
      case 'speed':
        if (!Number.isFinite(order.kn)) break;
        s.goal = { ...s.goal, kn: order.kn };
        break;
      case 'form':
        s.form = canonicalForm(order.form);
        s.sector = null;
        break;
      case 'sector':
        s.sector = normaliseSector(order.sector);
        s.form = null;
        break;
      case 'stance': {
        const engage = order.stance !== 'hold';
        s.stance = engage ? 'engage' : 'hold';
        s.cmd.fire = engage;
        s.cmd.gat = engage;
        s.auto = engage;
        break;
      }
      case 'goto':
        if (!Number.isFinite(order.x) || !Number.isFinite(order.z)) break;
        s.goal = { ...s.goal, to: [order.x, order.z] };
        s.form = null;
        s.sector = null;
        break;
      default: break;
    }
  }
}

// A station's position and velocity for a ship in the ordered formation, from the lead's present pose.
export function formationStation(sim, ship) {
  const lead = leadOf(sim);
  const slots = FORMATIONS[ship.form];
  const rank = clamp(ship.idx - 1, 0, slots.length - 1);
  const [ahead, stbd] = slots[rank];
  const c = Math.cos(lead.psi), sn = Math.sin(lead.psi);
  const d = FORM_SPACING * ahead, e = FORM_SPACING * stbd;
  return {
    x: lead.x + d * c - e * sn,
    z: lead.z + d * sn + e * c,
    vx: lead.u * c,
    vz: lead.u * sn,
  };
}

// The patrol point of a sector, as an offset (m) from the reference ship. A pure function of t.
export function patrolOffset(sec, t) {
  const span = wrapDeg(sec.to - sec.from) || 360;
  const brg = sec.from + span / 2 + 0.8 * (span / 2) * Math.sin((2 * Math.PI * t) / PATROL_BRG_T);
  const rm = (sec.inner + sec.outer) / 2, rh = 0.8 * ((sec.outer - sec.inner) / 2);
  const r = rm + rh * Math.sin((2 * Math.PI * t) / PATROL_RANGE_T + 1.3);
  const b = rad(brg);
  return { x: r * Math.cos(b), z: r * Math.sin(b) };
}

// Steer for a point with a velocity feed-forward: the course of the desired velocity, the speed it needs.
function homeTo(ship, tx, tz, vx, vz) {
  const vdx = vx + (tx - ship.x) / K_STATION, vdz = vz + (tz - ship.z) / K_STATION;
  const sp = Math.hypot(vdx, vdz);
  const course = sp < 0.3 ? deg(ship.psi) : deg(Math.atan2(vdz, vdx));
  return { course: wrapDeg(course), kn: clamp(sp / KT, 0, MAX_KN) };
}

function steerSector(sim, ship, sec) {
  const ref = sim.ships[sec.ref ?? leadOf(sim).idx];
  if (!ref || ref === ship || ref.tSunk !== null) return null;
  const t = sim.t;
  const p = patrolOffset(sec, t);
  const a = patrolOffset(sec, t - 0.5), b = patrolOffset(sec, t + 0.5);
  const ovx = (b.x - a.x) / 1, ovz = (b.z - a.z) / 1; // the point's own velocity, m/s
  return homeTo(
    ship,
    ref.x + p.x, ref.z + p.z,
    ref.u * Math.cos(ref.psi) + ovx, ref.u * Math.sin(ref.psi) + ovz,
  );
}

export function steerGoal(sim, ship) {
  const g = ship.goal;
  const lead = leadOf(sim);
  if (ship !== lead) {
    if (ship.form && FORMATIONS[ship.form]) {
      const st = formationStation(sim, ship);
      return homeTo(ship, st.x, st.z, st.vx, st.vz);
    }
    if (ship.sector) {
      const r = steerSector(sim, ship, ship.sector);
      if (r) return r;
    }
  }
  if (g.to) {
    const dx = g.to[0] - ship.x, dz = g.to[1] - ship.z;
    const d = Math.hypot(dx, dz);
    const course = wrapDeg(deg(Math.atan2(dz, dx)));
    if (d < GOTO_ARRIVE) return { course: g.course, kn: 0 };
    const kn = d < GOTO_SLOW ? Math.min(g.kn, Math.max(2, d / 60 / KT)) : g.kn;
    return { course, kn };
  }
  return { course: g.course, kn: g.kn };
}

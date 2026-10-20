// The "Four-ship formations" mission: SHIP1 to SHIP4 run through the basic tactical formations and nothing
// else (no drone, no missile, no signals serials). Pure model: it imports nothing, so test/formations.test.mjs
// checks it in Node.
//
// Coordinates as in maneuvers.js: x North, z East, heading in radians clockwise from North (a ship's group is
// `rotation.y = -heading`). SHIP1 is the guide: it holds course 000 at 12 kn the whole time. Each order gives
// every ship a station (yards ahead and to starboard of the guide); SHIP2 to SHIP4 steer for theirs with a
// rate-limited turn and a limited acceleration, baked once into 0.25 s tables, so shipState(id, t) is a pure
// function of t. An order is executed once the previous one has arrived and the ships have held station for
// HOLD seconds, so the schedule follows the ships' own motion.
//
// Designators follow the project's notes from MTP 1(D) Vol. II (CLAUDE.md): FORM 1 = column in order of
// sequence numbers, FORM 3 = line abreast to starboard, FORM D = diamond formed from a column (leader the
// guide, the second on the port quarter, the third on the starboard quarter), FORM 000-359 = line of bearing on
// a true bearing from the guide. The box has no designator there, so it is just called BOX.

export const YD = 0.9144;
export const KT = 1852 / 3600;
export const SHIP_IDS = ['ship1', 'ship2', 'ship3', 'ship4'];
export const SHIP_NAMES = { ship1: 'SHIP1', ship2: 'SHIP2', ship3: 'SHIP3', ship4: 'SHIP4' };
export const GUIDE = 'ship1';
export const SPACING = 500; // yd between neighbouring ships
export const GUIDE_COURSE = 0; // deg
export const GUIDE_SPEED = 12; // kn
export const MAX_SPEED = 20; // kn, for a ship catching up
export const MIN_SPEED = 5; // kn, for a ship dropping back
export const TURN_RATE = 1.5; // deg/s
export const ACCEL = 0.12; // m/s^2
export const ON_STATION = 40; // m: counts as on station
export const ARRIVAL = 10; // s every ship stays on station before the order counts as arrived
export const HOLD = 60; // s the formation is held after arriving, before the next order
const LEAD = 30; // s from the start to the first change of formation
const DT = 0.25;
const T_CROSS = 45; // s: the steering closes a station error at about this time constant
const MAX_OFFSET = 50 * Math.PI / 180; // largest angle off the guide's course while closing a station
const KEEP_CLEAR = 450; // m: inside this a ship steers away from any other ship (the guide never gives way)
const CLEAR_SPEED = 6; // m/s of sideways push at contact, fading to 0 at KEEP_CLEAR

const s45 = SPACING * Math.SQRT1_2;
// Stations in yards: [ahead, starboard] of the guide, for SHIP1..SHIP4.
export const FORMS = {
  column: [[0, 0], [-SPACING, 0], [-2 * SPACING, 0], [-3 * SPACING, 0]],
  bearing: [[0, 0], [-s45, s45], [-2 * s45, 2 * s45], [-3 * s45, 3 * s45]],
  abreast: [[0, 0], [0, SPACING], [0, 2 * SPACING], [0, 3 * SPACING]],
  box: [[0, 0], [0, SPACING], [-SPACING, 0], [-SPACING, SPACING]],
  diamond: [[0, 0], [-s45, -s45], [-s45, s45], [-2 * s45, 0]],
};

export const PHASES = [
  { id: 'start', form: 'column', label: 'FORM 1', title: 'FORM 1 · LINE AHEAD', name: 'Line ahead (column)',
    note: 'The column the exercise starts in: SHIP1 leads and is the guide, on course 000 at 12 kn; SHIP2, SHIP3 and SHIP4 follow 500 yds apart.' },
  { id: 'bearing', form: 'bearing', label: 'FORM 135', title: 'FORM 135 · LINE OF BEARING', name: 'Line of bearing',
    note: 'A line of bearing 135 from the guide: each ship 500 yds on SHIP1\'s starboard quarter of the ship ahead, so none masks another\'s arcs.' },
  { id: 'abreast', form: 'abreast', label: 'FORM 3', title: 'FORM 3 · LINE ABREAST', name: 'Line abreast',
    note: 'Line abreast to starboard: SHIP1 on the left, SHIP2, SHIP3 and SHIP4 500 yds apart to starboard of her, the widest front.' },
  { id: 'box', form: 'box', label: 'BOX', title: 'BOX', name: 'Two columns',
    note: 'Two columns side by side: SHIP1 and SHIP2 ahead, SHIP3 astern of SHIP1 and SHIP4 astern of SHIP2, 500 yds apart.' },
  { id: 'column', form: 'column', label: 'FORM 1', title: 'FORM 1 · LINE AHEAD', name: 'Line ahead (column)',
    note: 'Back into the column in order of sequence numbers, ready to form the diamond.' },
  { id: 'diamond', form: 'diamond', label: 'FORM D', title: 'FORM D · DIAMOND', name: 'Diamond',
    note: 'The diamond, formed from the column: SHIP1 leads and is the guide, SHIP2 on her port quarter, SHIP3 on her starboard quarter and SHIP4 astern, 500 yds sides.' },
];

const rad = (d) => d * Math.PI / 180;
const wrapPi = (a) => Math.atan2(Math.sin(a), Math.cos(a));

function guideAt(t, out = {}) {
  const v = GUIDE_SPEED * KT;
  const c = rad(GUIDE_COURSE);
  out.x = Math.cos(c) * v * t;
  out.z = Math.sin(c) * v * t;
  out.psi = c;
  out.v = v;
  return out;
}

// Where ship i is to be at time t under formation `form` (metres, world frame).
function stationXZ(form, i, t, out = {}) {
  const g = guideAt(t);
  const [a, s] = FORMS[form][i];
  const c = Math.cos(g.psi);
  const sn = Math.sin(g.psi);
  out.x = g.x + (a * c - s * sn) * YD;
  out.z = g.z + (a * sn + s * c) * YD;
  return out;
}

// --- The bake: all four ships stepped together, the orders executing as the ships arrive ------------------------
const MAX_T = 4 * 3600;
const tables = SHIP_IDS.map(() => []);
{
  const g0 = guideAt(0);
  const st = SHIP_IDS.map((_, i) => {
    const p = stationXZ('column', i, 0);
    return { x: p.x, z: p.z, psi: g0.psi, v: g0.v };
  });
  let k = 0;
  let phase = 0;
  PHASES[0].tx = 0;
  PHASES[0].ta = 0;
  let onSince = null;
  let nextAt = LEAD;
  const maxRate = rad(TURN_RATE) * DT;
  const p = {};
  for (;;) {
    const t = k * DT;
    for (let i = 0; i < 4; i++) tables[i].push({ x: st[i].x, z: st[i].z, psi: st[i].psi, v: st[i].v });
    // Order bookkeeping: execute the next order once due; mark arrival once everyone held station ARRIVAL s.
    const ph = PHASES[phase];
    if (ph.ta === undefined) {
      const all = st.every((s, i) => Math.hypot(s.x - stationXZ(ph.form, i, t, p).x, s.z - p.z) <= ON_STATION);
      if (!all) onSince = null;
      else if (onSince === null) onSince = t;
      else if (t - onSince >= ARRIVAL) { ph.ta = t; nextAt = t + HOLD; }
    } else if (t >= nextAt) {
      if (phase === PHASES.length - 1) break;
      phase++;
      PHASES[phase].tx = t;
      onSince = null;
    }
    if (t > MAX_T) throw new Error(`formations: ${PHASES[phase].id} never arrives`);
    // Steering: the guide holds course and speed; the others close their station error.
    const g = guideAt(t);
    const form = PHASES[phase].form;
    for (let i = 0; i < 4; i++) {
      const s = st[i];
      let psiD = g.psi;
      let vD = g.v;
      if (i > 0) {
        stationXZ(form, i, t, p);
        const ex = p.x - s.x;
        const ez = p.z - s.z;
        const c = Math.cos(g.psi);
        const sn = Math.sin(g.psi);
        const along = ex * c + ez * sn; // error ahead of the ship, along the guide's course
        const cross = -ex * sn + ez * c; // error to starboard
        // Keep clear: a push away from every ship closer than KEEP_CLEAR, in the guide's frame.
        let pa = 0;
        let pc = 0;
        for (let j = 0; j < 4; j++) {
          if (j === i) continue;
          const dx = s.x - st[j].x;
          const dz = s.z - st[j].z;
          const d = Math.hypot(dx, dz);
          if (d >= KEEP_CLEAR || d < 1e-6) continue;
          const w = CLEAR_SPEED * (1 - d / KEEP_CLEAR) / d;
          pa += (dx * c + dz * sn) * w;
          pc += (-dx * sn + dz * c) * w;
        }
        const va = Math.min(Math.max(g.v + along / T_CROSS + pa, MIN_SPEED * KT), MAX_SPEED * KT);
        const vc = Math.min(Math.max(cross / T_CROSS + pc, -va * Math.tan(MAX_OFFSET)), va * Math.tan(MAX_OFFSET));
        psiD = g.psi + Math.atan2(vc, va);
        vD = Math.min(Math.hypot(va, vc), MAX_SPEED * KT);
      }
      const dpsi = wrapPi(psiD - s.psi);
      s.psi = wrapPi(s.psi + Math.min(Math.max(dpsi, -maxRate), maxRate));
      s.v += Math.min(Math.max(vD - s.v, -ACCEL * DT), ACCEL * DT);
      s.x += Math.cos(s.psi) * s.v * DT;
      s.z += Math.sin(s.psi) * s.v * DT;
    }
    k++;
  }
}
const N = tables[0].length;
export const tEnd = (N - 1) * DT;
for (const ph of PHASES) ph.t = ph.tx;

// Pose of a ship at time t: { x, z, heading, speed } (m, rad, m/s), interpolated from the bake.
export function shipState(id, t, out = {}) {
  const tab = tables[SHIP_IDS.indexOf(id)];
  const f = Math.min(Math.max(t / DT, 0), N - 1);
  const k = Math.min(Math.floor(f), N - 2);
  const u = f - k;
  const a = tab[k];
  const b = tab[k + 1];
  out.x = a.x + (b.x - a.x) * u;
  out.z = a.z + (b.z - a.z) * u;
  out.heading = a.psi + wrapPi(b.psi - a.psi) * u;
  out.speed = a.v + (b.v - a.v) * u;
  return out;
}

export const headingDeg = (psi) => ((psi * 180 / Math.PI) % 360 + 360) % 360;

// The order in force at t (the last one executed).
export function phaseAt(t) {
  let cur = PHASES[0];
  for (const p of PHASES) if (t >= p.tx) cur = p;
  return cur;
}

// The order's stage at t: 'underway' (ships moving to their new stations) or 'station' (all arrived).
export function orderStatus(t) {
  const phase = phaseAt(t);
  const idx = PHASES.indexOf(phase);
  if (t < phase.ta) return { phase, idx, state: 'underway', count: phase.ta - t };
  const next = PHASES[idx + 1];
  return { phase, idx, state: 'station', since: t - phase.ta, next: next ? next.tx - t : null };
}

// Where ship `id` is to be under the order in force at t, and how far it is from it.
export function stationPoint(id, t, out = {}) {
  const i = SHIP_IDS.indexOf(id);
  stationXZ(phaseAt(t).form, i, t, out);
  const s = shipState(id, t);
  out.error = Math.hypot(s.x - out.x, s.z - out.z);
  return out;
}

// Range (m) and true bearing (deg) from ship a to ship b.
export function relation(t, a, b) {
  const p = shipState(a, t);
  const q = shipState(b, t);
  const dx = q.x - p.x;
  const dz = q.z - p.z;
  return { range: Math.hypot(dx, dz), bearing: headingDeg(Math.atan2(dz, dx)) };
}

// The closest any two ships come over the whole exercise (sampled each second): { range, t, a, b }.
export function closestApproach() {
  let best = { range: Infinity };
  for (let t = 0; t <= tEnd; t += 1) {
    for (let i = 0; i < 4; i++) {
      for (let j = i + 1; j < 4; j++) {
        const r = relation(t, SHIP_IDS[i], SHIP_IDS[j]).range;
        if (r < best.range) best = { range: r, t, a: SHIP_IDS[i], b: SHIP_IDS[j] };
      }
    }
  }
  return best;
}

export const exercise = {
  tEnd,
  phases: PHASES,
  events: PHASES.map((p) => ({ t: p.tx, label: p.label })),
};

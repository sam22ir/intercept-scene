// The "Four-ship formations" mission: SHIP1 to SHIP4 run through the basic tactical formations, with wheels
// (CORPEN) and turns together (TURN) between them, and nothing else (no drone, no missile, no signal serials).
// Pure model: it imports nothing, so test/formations.test.mjs checks it in Node.
//
// Coordinates as in maneuvers.js: x North, z East, heading in radians clockwise from North (a ship's group is
// `rotation.y = -heading`). SHIP1 is the guide, always at 12 kn; she steers the ordered course. Each FORM order
// gives every ship a station (yards ahead and to starboard of the guide, on the formation axis, which is the
// course the formation is formed on); SHIP2 to SHIP4 steer for theirs with a rate-limited turn and a limited
// acceleration, baked once into 0.25 s tables, so shipState(id, t) is a pure function of t. An order executes
// once the previous one has arrived and the ships have held station for HOLD seconds, so the schedule follows
// the ships' own motion.
//
// The two kinds of turn (MTP 1(D) Vol. II, as noted in CLAUDE.md):
// - CORPEN, a wheel: the guide alters to the new course and the formation turns with her as one block. Stations
//   are laid off from the guide's own track: a ship `a` yards astern of her steers for the point the guide passed
//   `a` yards ago, so in a column the ships follow round in her wake; a ship abeam is laid off square to the track,
//   so on the outside of the wheel she runs faster and on the inside slower. The wheel rate is chosen so no ship
//   needs more than MAX_SPEED or less than MIN_SPEED.
// - TURN, a turn together: every ship puts her rudder over at the same moment and turns at the same rate, so the
//   true bearings between them are unchanged and the formation's shape changes relative to the new course (a line
//   abreast turned together through 90 degrees is a column). The stations stay on the old axis until the next order.
//
// A one- or two-numeral amount is tens of degrees (CORPEN STBD 9 = a 90 degree wheel to starboard). Designators:
// FORM 1 = column in order of sequence numbers, FORM 3 = line abreast to starboard, FORM D = diamond formed from a
// column (leader the guide, the second on the port quarter, the third on the starboard quarter), FORM 000-359 =
// line of bearing on a true bearing from the guide. The box has no designator there, so it is just called BOX.

export const YD = 0.9144;
export const KT = 1852 / 3600;
export const SHIP_IDS = ['ship1', 'ship2', 'ship3', 'ship4'];
export const SHIP_NAMES = { ship1: 'SHIP1', ship2: 'SHIP2', ship3: 'SHIP3', ship4: 'SHIP4' };
export const GUIDE = 'ship1';
export const SPACING = 500; // yd between neighbouring ships, as ordered and as every readout shows it
// The scene sails the ships closer than the ordered distances so a whole formation reads on screen (as the drill
// does): one ordered yard is SCALE yards on the sea. Every number shown is in ordered yards (`orderedYd`).
export const SCALE = 0.5;
const SYD = YD * SCALE; // metres on the sea per ordered yard
export const orderedYd = (m) => m / SYD;
export const GUIDE_SPEED = 12; // kn
export const MAX_SPEED = 20; // kn, for a ship catching up
export const MIN_SPEED = 5; // kn, for a ship dropping back
export const TURN_RATE = 1.5; // deg/s, a ship's own rate of turn (and the rate of a turn together)
export const ACCEL = 0.12; // m/s^2
export const ON_STATION = 40 * SCALE; // m on the sea: counts as on station
export const ON_COURSE = 2; // deg: counts as on the ordered course
export const ARRIVAL = 10; // s every ship stays on station and course before the order counts as arrived
export const HOLD = 60; // s the formation is held after arriving, before the next order
const LEAD = 30; // s from the start to the first order
const DT = 0.25;
const T_CROSS = 45 * SCALE; // s: the steering closes a station error at about this time constant
const MAX_OFFSET = 50 * Math.PI / 180; // largest angle off the station's own heading while closing it
const KEEP_CLEAR = 450 * SCALE; // m: inside this a ship steers away from any other ship (the guide never gives way)
const CLEAR_SPEED = 6; // m/s of sideways push at contact, fading to 0 at KEEP_CLEAR
const STAND_ON = 50 * SCALE; // m: a ship whose new station is this close to her own line only changes speed
const STAND_ON_GIVE = 3; // the keep-clear push from a stand-on ship is this much stronger, since she does not move aside
const WHEEL_MARGIN = 0.8; // a wheel uses at most this share of the speed range of its outer and inner ships

const s45 = SPACING * Math.SQRT1_2;
// Stations in yards: [ahead, starboard] of the guide on the formation axis, for SHIP1..SHIP4.
export const FORMS = {
  column: [[0, 0], [-SPACING, 0], [-2 * SPACING, 0], [-3 * SPACING, 0]],
  bearing: [[0, 0], [-s45, s45], [-2 * s45, 2 * s45], [-3 * s45, 3 * s45]],
  abreast: [[0, 0], [0, SPACING], [0, 2 * SPACING], [0, 3 * SPACING]],
  box: [[0, 0], [0, SPACING], [-SPACING, 0], [-SPACING, SPACING]],
  diamond: [[0, 0], [-s45, -s45], [-s45, s45], [-2 * s45, 0]],
};

// The orders, in sequence. `kind`: form (take up `form` on the present course), corpen (wheel to `course`) or
// turn (turn together to `course`).
export const PHASES = [
  { id: 'start', kind: 'form', form: 'column', course: 0, label: 'FORM 1', title: 'FORM 1 · LINE AHEAD', name: 'Line ahead (column)',
    note: 'The column the exercise starts in: SHIP1 leads and is the guide, on course 000 at 12 kn; SHIP2, SHIP3 and SHIP4 follow 500 yds apart.' },
  { id: 'corpen1', kind: 'corpen', course: 90, dir: 'stbd', label: 'CORPEN STBD 9', title: 'CORPEN STBD 9', name: 'Wheel to 090',
    note: 'A wheel of 90 degrees to starboard in column: SHIP1 alters to 090 and the others hold on and turn in her wake, each at the point where she turned.' },
  { id: 'bearing', kind: 'form', form: 'bearing', label: 'FORM 225', title: 'FORM 225 · LINE OF BEARING', name: 'Line of bearing',
    note: 'A line of bearing 225 from the guide (her starboard quarter on course 090): each ship 500 yds on the quarter of the ship ahead, so none masks another\'s arcs.' },
  { id: 'abreast', kind: 'form', form: 'abreast', label: 'FORM 3', title: 'FORM 3 · LINE ABREAST', name: 'Line abreast',
    note: 'Line abreast to starboard on course 090: SHIP1 on the left, SHIP2, SHIP3 and SHIP4 500 yds apart to starboard of her, the widest front.' },
  { id: 'turnport', kind: 'turn', course: 0, dir: 'port', label: 'TURN PORT 9', title: 'TURN PORT 9', name: 'Turn together to 000',
    note: 'A turn together: all four put the rudder over at once and come to 000. The true bearings between them do not change, so the line abreast becomes a column with SHIP1 leading.' },
  { id: 'turnstbd', kind: 'turn', course: 90, dir: 'stbd', label: 'TURN STBD 9', title: 'TURN STBD 9', name: 'Turn together to 090',
    note: 'Turn together back to 090: the column becomes the line abreast again.' },
  { id: 'box', kind: 'form', form: 'box', label: 'BOX', title: 'BOX', name: 'Two columns',
    note: 'Two columns side by side on course 090: SHIP1 and SHIP2 ahead, SHIP3 astern of SHIP1 and SHIP4 astern of SHIP2, 500 yds apart.' },
  { id: 'corpen2', kind: 'corpen', course: 0, dir: 'port', label: 'CORPEN PORT 9', title: 'CORPEN PORT 9', name: 'Wheel to 000',
    note: 'A wheel of 90 degrees to port in the box: SHIP1 alters to 000 slowly enough that SHIP2 and SHIP4, on the outside of the turn, keep their places without passing 20 kn; SHIP3 follows in SHIP1\'s wake.' },
  { id: 'column', kind: 'form', form: 'column', label: 'FORM 1', title: 'FORM 1 · LINE AHEAD', name: 'Line ahead (column)',
    note: 'Back into the column in order of sequence numbers on course 000, ready to form the diamond.' },
  { id: 'diamond', kind: 'form', form: 'diamond', label: 'FORM D', title: 'FORM D · DIAMOND', name: 'Diamond',
    note: 'The diamond, formed from the column: SHIP1 leads and is the guide, SHIP2 on her port quarter, SHIP3 on her starboard quarter and SHIP4 astern, 500 yds sides.' },
  { id: 'corpen3', kind: 'corpen', course: 90, dir: 'stbd', label: 'CORPEN STBD 9', title: 'CORPEN STBD 9', name: 'Wheel to 090',
    note: 'The diamond wheels 90 degrees to starboard as one block: SHIP2 on the outside speeds up, SHIP3 on the inside slows down, and SHIP4 follows in SHIP1\'s wake.' },
];

const rad = (d) => d * Math.PI / 180;
const wrapPi = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const V = GUIDE_SPEED * KT;

// --- The guide's track, and the stations laid off from it -------------------------------------------------------
const guideTab = []; // the guide's state every DT, filled by the bake
function guideAt(t, out = {}) {
  if (t <= 0) { // before the start: straight back along the first course
    const g = guideTab[0];
    out.x = g.x + Math.cos(g.psi) * V * t;
    out.z = g.z + Math.sin(g.psi) * V * t;
    out.psi = g.psi;
    return out;
  }
  const f = Math.min(t / DT, guideTab.length - 1);
  const k = Math.min(Math.floor(f), guideTab.length - 2);
  const u = f - k;
  const a = guideTab[k];
  const b = guideTab[k + 1];
  out.x = a.x + (b.x - a.x) * u;
  out.z = a.z + (b.z - a.z) * u;
  out.psi = a.psi + wrapPi(b.psi - a.psi) * u;
  return out;
}

// Where ship i is to be at time t under the station plan S = { form, mode, axis } (metres, world frame).
// mode 'track': laid off from the guide's own track (follows her round a wheel); 'fixed': on the axis, rigid.
const _g = {};
function stationOf(S, i, t, out = {}) {
  const [a, s] = FORMS[S.form][i];
  if (S.mode === 'fixed') {
    guideAt(t, _g);
    const c = Math.cos(rad(S.axis));
    const sn = Math.sin(rad(S.axis));
    out.x = _g.x + (a * c - s * sn) * SYD;
    out.z = _g.z + (a * sn + s * c) * SYD;
  } else {
    guideAt(t + (a * SYD) / V, _g); // where the guide was `a` (ordered) yards ago
    out.x = _g.x - Math.sin(_g.psi) * s * SYD;
    out.z = _g.z + Math.cos(_g.psi) * s * SYD;
  }
  return out;
}

// --- The bake: all four ships stepped together, the orders executing as the ships arrive ------------------------
const MAX_T = 4 * 3600;
const tables = SHIP_IDS.map(() => []);
{
  const st = SHIP_IDS.map((_, i) => ({ x: FORMS.column[i][0] * SYD, z: 0, psi: 0, v: V })); // the column, heading 000
  guideTab.push({ x: 0, z: 0, psi: 0 });
  st.forEach((s, i) => tables[i].push({ ...s }));
  let phase = 0;
  let S = { form: 'column', mode: 'track', axis: 0 };
  let course = 0;
  let rate = rad(TURN_RATE);
  let standOn = [true, false, false, false];
  Object.assign(PHASES[0], { tx: 0, ta: 0, S, standOn: [] });
  let onSince = null;
  let nextAt = LEAD;
  let guideOnCourse = 0; // since when the guide has been on the ordered course
  const p = {};
  const q = {};
  for (let k = 0; ; k++) {
    const t = k * DT;
    // Orders: execute the next one once due; it arrives once every ship has held station and course ARRIVAL s.
    const ph = PHASES[phase];
    if (ph.ta === undefined) {
      // In track mode the ships astern turn where the guide turned, so the order is done only once the rearmost
      // ship's point on the guide's track is past the turn too, and she has had ARRIVAL s to settle from it.
      const lag = S.mode === 'track' ? Math.max(...FORMS[S.form].map(([a]) => -a * SYD / V)) + ARRIVAL : 0;
      const ok = t - guideOnCourse >= lag && st.every((s, i) => Math.abs(wrapPi(s.psi - rad(course))) <= rad(ON_COURSE)
        && Math.hypot(s.x - stationOf(S, i, t, p).x, s.z - p.z) <= ON_STATION);
      if (!ok) onSince = null;
      else if (onSince === null) onSince = t;
      else if (t - onSince >= ARRIVAL) { ph.ta = t; nextAt = t + HOLD; }
    } else if (t >= nextAt) {
      if (phase === PHASES.length - 1) break;
      const nx = PHASES[++phase];
      nx.tx = t;
      onSince = null;
      rate = rad(TURN_RATE);
      standOn = [true, false, false, false];
      if (nx.kind === 'form') {
        nx.course = course; // formed on the present course, which becomes the axis
        S = { form: nx.form, mode: 'track', axis: course };
        // Stand-on ships: those whose new station lies on their own line (ahead or astern on the course).
        const c = Math.cos(rad(course));
        const sn = Math.sin(rad(course));
        standOn = st.map((s, i) => {
          if (i === 0) return true;
          const rx = (s.x - st[0].x) / SYD;
          const rz = (s.z - st[0].z) / SYD;
          const stbdNow = -rx * sn + rz * c;
          return Math.abs(stbdNow - FORMS[nx.form][i][1]) * SYD <= STAND_ON;
        });
      } else if (nx.kind === 'corpen') {
        course = nx.course;
        S = { form: S.form, mode: 'track', axis: course };
        // The wheel rate: no ship laid off abeam may need more than MAX_SPEED outside or less than MIN_SPEED inside.
        for (let i = 1; i < 4; i++) {
          const off = FORMS[S.form][i][1] * SYD;
          if (!off) continue;
          const outside = nx.dir === 'stbd' ? off < 0 : off > 0;
          const lim = outside ? (MAX_SPEED * KT - V) / Math.abs(off) : (V - MIN_SPEED * KT) / Math.abs(off);
          rate = Math.min(rate, WHEEL_MARGIN * lim);
        }
      } else { // turn together: the stations stay on the old axis
        course = nx.course;
        S = { form: S.form, mode: 'fixed', axis: S.axis };
      }
      nx.S = S;
      nx.rate = rate * 180 / Math.PI;
      nx.standOn = SHIP_IDS.filter((_, i) => i > 0 && standOn[i]);
    }
    if (t > MAX_T) throw new Error(`formations: ${PHASES[phase].id} never arrives`);
    const turning = PHASES[phase].kind === 'turn';
    // The guide steers the ordered course at the order's rate of turn.
    const g = st[0];
    const dg = wrapPi(rad(course) - g.psi);
    g.psi = wrapPi(g.psi + Math.min(Math.max(dg, -rate * DT), rate * DT));
    if (Math.abs(wrapPi(rad(course) - g.psi)) > 1e-6) guideOnCourse = t + DT;
    g.x += Math.cos(g.psi) * V * DT;
    g.z += Math.sin(g.psi) * V * DT;
    guideTab.push({ x: g.x, z: g.z, psi: g.psi });
    // The others: in a turn together they simply turn with the guide; otherwise they close their station error.
    const maxRate = rad(TURN_RATE) * DT;
    for (let i = 1; i < 4; i++) {
      const s = st[i];
      let psiD = rad(course);
      let vD = V;
      if (!turning) {
        stationOf(S, i, t, p);
        stationOf(S, i, t + DT, q);
        const vx = (q.x - p.x) / DT; // the station's own velocity
        const vz = (q.z - p.z) / DT;
        const ref = Math.atan2(vz, vx);
        const c = Math.cos(ref);
        const sn = Math.sin(ref);
        const ex = p.x - s.x;
        const ez = p.z - s.z;
        const along = ex * c + ez * sn; // error ahead of the ship, along the station's heading
        const cross = -ex * sn + ez * c; // error to starboard
        // Keep clear: a push away from every ship closer than KEEP_CLEAR. A stand-on ship is never pushed.
        let pa = 0;
        let pc = 0;
        for (let j = 0; j < 4; j++) {
          if (j === i || standOn[i]) continue;
          const dx = s.x - st[j].x;
          const dz = s.z - st[j].z;
          const d = Math.hypot(dx, dz);
          if (d >= KEEP_CLEAR || d < 1e-6) continue;
          const w = CLEAR_SPEED * (standOn[j] && j > 0 ? STAND_ON_GIVE : 1) * (1 - d / KEEP_CLEAR) / d; // keep further clear of a stand-on ship
          pa += (dx * c + dz * sn) * w;
          pc += (-dx * sn + dz * c) * w;
        }
        const va = Math.min(Math.max(Math.hypot(vx, vz) + along / T_CROSS + pa, MIN_SPEED * KT), MAX_SPEED * KT);
        const vc = standOn[i] ? 0 : Math.min(Math.max(cross / T_CROSS + pc, -va * Math.tan(MAX_OFFSET)), va * Math.tan(MAX_OFFSET));
        psiD = ref + Math.atan2(vc, va);
        vD = Math.min(Math.hypot(va, vc), MAX_SPEED * KT);
      }
      const dpsi = wrapPi(psiD - s.psi);
      s.psi = wrapPi(s.psi + Math.min(Math.max(dpsi, -maxRate), maxRate));
      s.v += Math.min(Math.max(vD - s.v, -ACCEL * DT), ACCEL * DT);
      s.x += Math.cos(s.psi) * s.v * DT;
      s.z += Math.sin(s.psi) * s.v * DT;
    }
    st.forEach((s, i) => tables[i].push({ x: s.x, z: s.z, psi: s.psi, v: s.v }));
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

// The order's stage at t: 'underway' (ships maneuvering) or 'station' (all arrived).
export function orderStatus(t) {
  const phase = phaseAt(t);
  const idx = PHASES.indexOf(phase);
  if (t < phase.ta) return { phase, idx, state: 'underway', count: phase.ta - t };
  const next = PHASES[idx + 1];
  return { phase, idx, state: 'station', since: t - phase.ta, next: next ? next.tx - t : null };
}

// Where ship `id` is to be under the order in force at t, and how far it is from it.
export function stationPoint(id, t, out = {}) {
  stationOf(phaseAt(t).S, SHIP_IDS.indexOf(id), t, out);
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

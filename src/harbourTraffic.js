// Harbour pilot: the traffic in and around the port of Zabana (the model is harbour.js, which steps it and gives it the port's
// geometry through `world`). Pure and import-free like harbour.js, so Node can test it (test/harbourTraffic.test.mjs).
//
// Every vessel follows a plan written in the chart's pixels (port-zabana.svg, 3 m a pixel, converted by world.px): go to a point
// at a speed (ahead, or astern / sideways with `crab`, her heading held), pivot on the spot (`turn`, tugs and thrusters), wait,
// hold until a condition, then moor, anchor or leave the chart. They keep the port's rules as the player must:
//   - the speed limits of the zone they are in (world.speedLimitAt: 8 kn avant-port, 5 kn bassins, 2 kn écluse);
//   - priority to outbound ships: an inbound ship holds before the entrance while an outbound one is in the passage;
//   - no crossing in the fishing pass: a boat waits at the waiting point while another is in the pass;
//   - keep to the right in the channel (inbound on the east side, outbound on the west);
//   - and they stop for anything ahead of them, the player's ship included.
// Two tugs (berth 2) answer the player's call and make fast at her bow and stern; the pilot boat waits off the pilot station (P)
// and comes alongside to put the pilot aboard or take him off.
// Coordinates: metres, x north, z east; a heading is clockwise from north (as harbour.js).

const KT = 0.514444;
const rad = (d) => (d * Math.PI) / 180;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const wrapPi = (a) => Math.atan2(Math.sin(a), Math.cos(a));

// rate: deg/s she can pivot at a standstill (tugs, thrusters); acc: m/s².
export const VESSEL_TYPES = {
  tug: { L: 30, B: 10, T: 4.5, rate: 7, acc: 0.3, name: 'Remorqueur' },
  pilot: { L: 18, B: 5.5, T: 1.5, rate: 9, acc: 0.5, name: 'Pilotine' },
  trawler: { L: 24, B: 7, T: 3.5, rate: 6, acc: 0.25, name: 'Chalutier' },
  yacht: { L: 12, B: 4, T: 1.8, rate: 9, acc: 0.4, name: 'Plaisancier' },
  coaster: { L: 100, B: 16, T: 6, rate: 1.5, acc: 0.07, name: 'Caboteur' },
  cargo: { L: 180, B: 28, T: 8, rate: 0.7, acc: 0.05, name: 'Cargo' },
  tanker: { L: 160, B: 26, T: 8.5, rate: 0.5, acc: 0.05, name: 'Pétrolier' },
};

// The plans. `at` is [X, Y, heading in degrees] in the chart's pixels; `start` the time she sets off (s); `show` 'always' (she is
// there from the start: moored, at anchor or waiting) or 'start' (she comes in from the edge of the chart at `start`).
function plans(route) {
  const P = [];
  // The two tugs at berth 2 and the pilot boat (special: harbour.js calls them).
  P.push({ id: 'tugA', type: 'tug', at: [544.3, 263, 0], role: 'tug', end: 'bow' });
  P.push({ id: 'tugB', type: 'tug', at: [544.3, 291, 0], role: 'tug', end: 'stern' });
  P.push({ id: 'pilot', type: 'pilot', at: [544.3, 312, 0], role: 'pilot' });
  // A trawler leaves berth 1, fishes off Les Corbeaux, comes back and lies at the fishing basin's west quay.
  const inbound = (moorY) => [
    { in: true }, { to: [592, 660], kn: 7 }, { to: [592, 565], kn: 6 }, { hold: 'priority' }, { to: [586, 482], kn: 5 },
    { to: [560, 442], kn: 5 }, { to: [516, 420], kn: 5 }, { to: [500, 330], kn: 4 }, { to: [492, 303], kn: 3 }, { hold: 'pass' },
    { to: [452, 303], kn: 3 }, { to: [404, 298], kn: 3 }, { to: [374, moorY + 4], kn: 2 }, { to: [362.5, moorY], kn: 1, r: 4 }, { turn: 0 }, { moor: true },
  ];
  P.push({
    id: 'trawler1', type: 'trawler', at: [518.3, 296, 180], start: 40, show: 'always',
    plan: [
      { to: [511, 296], kn: 1.5, crab: 180 }, { to: [506, 330], kn: 4 }, { to: [503, 395], kn: 5 }, { to: [526, 440], kn: 6 }, { out: true }, { to: [560, 470], kn: 6 },
      { to: [558, 560], kn: 7 }, { to: [552, 650], kn: 8 }, { out: false }, { to: [470, 740], kn: 8 }, { to: [270, 850], kn: 8 }, { wait: 150 },
      { to: [430, 760], kn: 8 }, ...inbound(282),
    ],
  });
  P.push({ id: 'trawler2', type: 'trawler', at: [230, 900, 50], start: 160, show: 'start', plan: [{ to: [430, 760], kn: 8 }, ...inbound(318)] });
  // Yachts out of the marina and back.
  const marinaOut = [
    { to: [760, 297], kn: 4 }, { to: [740, 297], kn: 4 }, { to: [726, 300], kn: 4 }, { to: [714, 332], kn: 5 }, { to: [690, 380], kn: 6 }, { to: [640, 432], kn: 6 },
    { out: true }, { to: [590, 452], kn: 5 }, { to: [564, 480], kn: 5 }, { to: [560, 560], kn: 7 }, { out: false }, { to: [548, 650], kn: 8 },
    { to: [600, 760], kn: 10 }, { to: [730, 800], kn: 10 }, { to: [860, 790], kn: 10 },
  ];
  const marinaIn = [
    { to: [700, 620], kn: 8 }, { in: true }, { to: [597, 562], kn: 6 }, { hold: 'priority' }, { to: [598, 478], kn: 5 }, { to: [650, 426], kn: 6 },
    { to: [700, 376], kn: 5 }, { to: [718, 322], kn: 4 }, { to: [727, 298], kn: 3 }, { to: [745, 297], kn: 3 }, { to: [800, 297], kn: 3 }, { to: [806, 289], kn: 1, r: 3 }, { turn: 270 }, { moor: true },
  ];
  P.push({ id: 'yacht1', type: 'yacht', at: [806, 289, 270], start: 25, show: 'always', plan: [...marinaOut, { wait: 120 }, ...marinaIn, { wait: 240 }, { goto: 0 }] });
  P.push({ id: 'yacht2', type: 'yacht', at: [1020, 820, 290], start: 300, show: 'start', plan: [{ to: [860, 790], kn: 10 }, ...marinaIn] });
  // Two ships at anchor in the anchorage.
  P.push({ id: 'anchor1', type: 'tanker', at: [818, 628, 75], show: 'always', plan: [{ anchor: true }] });
  P.push({ id: 'anchor2', type: 'cargo', at: [888, 652, 80], show: 'always', plan: [{ anchor: true }] });
  // The coaster at berth 3 (pier 3-5, east face): she backs down the Bassin, pivots in the turning circle and goes to sea.
  // Absent when the player berths there (A); she stays alongside while the player sails out (F, H) or crosses the outbound cargo (G).
  if (route !== 'A') {
    const leaves = ['B', 'C', 'D', 'E'].includes(route);
    P.push({
      id: 'coaster3', type: 'coaster', at: [610.2, 251, 0], start: { B: 0, C: 120, D: 60, E: 60 }[route] ?? 180, show: 'always',
      plan: leaves ? [
        { out: true }, { to: [610.6, 330], kn: -4, crab: 0 }, { to: [611, 372], kn: -2.5, crab: 0 }, { turn: 180 }, { to: [584, 440], kn: 5 },
        { to: [563, 480], kn: 5 }, { to: [562, 560], kn: 7 }, { to: [561, 690], kn: 8 }, { out: false }, { to: [520, 880], kn: 10 }, { to: [420, 1120], kn: 10 }, { gone: true },
      ] : [{ moor: true }],
    });
  }
  // The cargo at berth 6 (pier 6-8, west face, bow south). In G she has let go already and waits inside the entrance until the
  // player is past the pilot station, so that the two meet in the crossing zone; in F the player is her.
  if (route === 'G') {
    P.push({
      id: 'cargoOut', type: 'cargo', at: [567, 428, 180], start: 0, show: 'always',
      plan: [
        { out: true }, { hold: 'playerIn' }, { to: [562, 500], kn: 6 }, { to: [561, 600], kn: 6 }, { to: [560, 690], kn: 7 }, { out: false },
        { to: [540, 820], kn: 9 }, { to: [440, 1060], kn: 10 }, { gone: true },
      ],
    });
  } else if (route !== 'F') {
    P.push({ id: 'cargo6', type: 'cargo', at: [645.2, 267, 180], show: 'always', plan: [{ moor: true }] });
  }
  // When the player sails out (F, H), a coaster comes in from sea: she holds outside the entrance for the outbound player, then
  // lies at the free west face of pier 3-5.
  if (route === 'F' || route === 'H') {
    P.push({
      id: 'inbound', type: 'coaster', at: [700, 1000, 330], start: 30, show: 'start',
      plan: [
        { in: true }, { to: [600, 800], kn: 9 }, { to: [592, 660], kn: 7 }, { to: [592, 568], kn: 6 }, { hold: 'priority' }, { to: [587, 482], kn: 5 },
        { to: [575, 420], kn: 4 }, { to: [579, 360], kn: 3 }, { to: [581.6, 300], kn: 2 }, { to: [581.6, 283], kn: 0.8, r: 4 }, { moor: true },
      ],
    });
  }
  return P;
}

export class Traffic {
  // world: { px(X, Y), gateSideOf(x, z), speedLimitAt(x, z), inPassage(x, z), inHarbour(x, z), inPassArea(x, z) }
  constructor(world, route, { enabled = true } = {}) {
    this.world = world;
    this.t = 0;
    this.vessels = [];
    for (const p of plans(route)) {
      if (!enabled && !p.role) continue; // without traffic the tugs and the pilot boat still answer
      const T = VESSEL_TYPES[p.type];
      const at = world.px(p.at[0], p.at[1]);
      const v = {
        id: p.id, type: p.type, name: T.name, L: T.L, B: T.B, T: T.T, role: p.role ?? null, end: p.end ?? null,
        x: at.x, z: at.z, psi: rad(p.at[2]), u: 0, vx: 0, vz: 0,
        home: { x: at.x, z: at.z, psi: rad(p.at[2]) },
        start: p.start ?? 0, show: p.show ?? 'always', i: 0,
        plan: (p.plan ?? []).map((w) => (w.to ? { ...w, P: world.px(w.to[0], w.to[1]) } : { ...w })),
        state: p.role ? 'moored' : 'pending', outbound: false, waitT: null, blockedBy: null, stoppedFor: 0, mode: 'moored',
      };
      if (p.role === 'pilot') v.mode = 'home';
      while (v.plan[v.i] && v.plan[v.i].out !== undefined) v.outbound = v.plan[v.i++].out; // she is outbound from the start
      this.vessels.push(v);
    }
  }

  get(id) { return this.vessels.find((v) => v.id === id); }
  visible(v) { return v.state !== 'gone' && !(v.state === 'pending' && v.show === 'start'); }
  // The vessels the player's ship can touch (the tugs and the pilot boat look after themselves, except moored at their berth).
  solids() {
    return this.vessels.filter((v) => this.visible(v) && (!v.role || v.mode === 'moored'));
  }
  // An outbound ship of 50 m or more in the passage, or under way out of the port (the entrance lights on the Digue Est then show red).
  outboundInPassage(sim, except = null) {
    const w = this.world;
    const leaving = (x, z, u) => w.inPassage(x, z) || (w.inHarbour(x, z) && Math.abs(u) > 0.2);
    if (sim && sim.outbound && except !== 'player' && leaving(sim.x, sim.z, Math.max(Math.abs(sim.u), 0.3))) return true;
    return this.vessels.some((v) => v !== except && v.outbound && v.L >= 50 && this.visible(v) && leaving(v.x, v.z, v.u));
  }

  // Everything that can be in a vessel's way: the other vessels and the player's ship.
  bodies(sim) {
    const out = [];
    for (const v of this.vessels) {
      if (!this.visible(v) || v.mode === 'fast' || v.mode === 'alongside') continue;
      out.push({ ref: v, x: v.x, z: v.z, psi: v.psi, L: v.L, B: v.B });
    }
    if (sim) out.push({ ref: 'player', x: sim.x, z: sim.z, psi: sim.psi, L: sim.ship.L, B: sim.ship.B });
    return out;
  }
  // The first body in the box ahead of her (astern when she goes astern), or null.
  blocked(v, bodies, astern = false) {
    const c = Math.cos(v.psi), s = Math.sin(v.psi), dir = astern ? -1 : 1;
    const reach = v.L / 2 + Math.max(40, Math.abs(v.u) * 45);
    for (const b of bodies) {
      if (b.ref === v || (v.role && b.ref !== 'player' && b.ref.role)) continue;
      const dx = b.x - v.x, dz = b.z - v.z;
      const ax = (dx * c + dz * s) * dir, az = -dx * s + dz * c;
      if (ax <= 0 || ax > reach + b.L / 2) continue;
      // her box against the other's half-width seen from her (its length counts when it lies across her course)
      const across = Math.abs(Math.sin(b.psi - v.psi)) * b.L / 2 + Math.abs(Math.cos(b.psi - v.psi)) * b.B / 2;
      if (Math.abs(az) < v.B / 2 + across + 12) return b;
    }
    return null;
  }

  step(dt, sim) {
    this.t = sim ? sim.t : this.t + dt;
    const bodies = this.bodies(sim);
    for (const v of this.vessels) {
      const x0 = v.x, z0 = v.z;
      if (v.role === 'tug') this.stepTug(v, dt, sim, bodies);
      else if (v.role === 'pilot') this.stepPilot(v, dt, sim, bodies);
      else this.stepPlan(v, dt, sim, bodies);
      // her velocity (for the contacts), no faster than she really goes (a tug snapping to its station does not count)
      const lim = Math.abs(v.u) + 0.3, vx = (v.x - x0) / dt, vz = (v.z - z0) / dt, sp = Math.hypot(vx, vz);
      v.vx = sp > lim ? (vx * lim) / sp : vx; v.vz = sp > lim ? (vz * lim) / sp : vz;
    }
  }

  stepPlan(v, dt, sim, bodies) {
    if (v.state === 'gone') return;
    if (v.state === 'pending') { if (this.t < v.start) return; v.state = 'run'; }
    if (v.state === 'moored') { v.u = 0; return; }
    if (v.state === 'anchored') { // she swings slowly to the tide
      v.u = 0;
      v.psi = v.home.psi + rad(8) * Math.sin(this.t / 300 + v.home.x);
      return;
    }
    if (v.stoppedFor > 0) { v.stoppedFor -= dt; this.brake(v, dt); return; } // after a contact she stops a while
    const w = v.plan[v.i];
    if (!w) { v.state = 'moored'; v.u = 0; return; }
    if (w.goto !== undefined) { v.i = w.goto; return; }
    if (w.out !== undefined) { v.outbound = w.out; v.i++; return; }
    if (w.in !== undefined) { v.inbound = w.in; v.i++; return; }
    if (w.moor) { v.state = 'moored'; v.u = 0; v.outbound = false; v.i++; return; }
    if (w.anchor) { v.state = 'anchored'; v.u = 0; v.i++; return; }
    if (w.gone) { v.state = 'gone'; v.u = 0; v.outbound = false; return; }
    if (w.wait !== undefined) {
      v.waitT ??= this.t;
      this.brake(v, dt);
      if (this.t - v.waitT >= w.wait) { v.waitT = null; v.i++; }
      return;
    }
    if (w.hold) {
      v.holding = !this.holdOver(v, w, sim);
      if (v.holding) { this.brake(v, dt); return; }
      v.i++;
      return;
    }
    if (w.turn !== undefined) {
      this.brake(v, dt);
      const err = wrapPi(rad(w.turn) - v.psi);
      if (Math.abs(v.u) < 0.3) v.psi = wrapPi(v.psi + clamp(err, -rad(VESSEL_TYPES[v.type].rate) * dt, rad(VESSEL_TYPES[v.type].rate) * dt));
      if (Math.abs(err) < rad(0.5)) { v.psi = rad(w.turn); v.i++; }
      return;
    }
    this.move(v, w, dt, bodies);
  }

  holdOver(v, w, sim) {
    if (w.hold === 'priority') return !this.outboundInPassage(sim, v);
    if (w.hold === 'pass') return !this.passBusy(v, sim);
    if (w.hold === 'playerIn') return !sim || sim.x > -660; // the player is north of chart Y 700 (past the pilot station)
    return true;
  }
  // Is someone else in the fishing pass (or about to enter it)?
  passBusy(v, sim) {
    const w = this.world;
    if (sim && w.inPassArea(sim.x, sim.z)) return true;
    return this.vessels.some((o) => o !== v && this.visible(o) && o.state === 'run' && w.inPassArea(o.x, o.z));
  }

  brake(v, dt) {
    const a = VESSEL_TYPES[v.type].acc * 1.5;
    v.u += clamp(-v.u, -a * dt, a * dt);
    const c = Math.cos(v.psi), s = Math.sin(v.psi);
    v.x += c * v.u * dt; v.z += s * v.u * dt;
  }

  move(v, w, dt, bodies) {
    const T = VESSEL_TYPES[v.type];
    const dx = w.P.x - v.x, dz = w.P.z - v.z, dist = Math.hypot(dx, dz);
    const astern = w.kn < 0;
    let want = Math.abs(w.kn) * KT;
    const lim = this.world.speedLimitAt(v.x, v.z);
    if (lim < Infinity) want = Math.min(want, (lim - 0.4) * KT);
    const next = v.plan[v.i + 1];
    if (!next || !next.to) want = Math.min(want, Math.sqrt(2 * T.acc * 0.5 * dist) + 0.12);
    const blk = this.blocked(v, bodies, astern);
    v.blockedBy = blk ? blk.ref : null;
    if (blk) want = 0;
    const target = (astern ? -1 : 1) * want;
    v.u += clamp(target - v.u, -T.acc * dt, T.acc * dt);
    const brg = Math.atan2(dz, dx);
    const crab = w.crab !== undefined;
    const desired = crab ? rad(w.crab) : astern ? brg + Math.PI : brg;
    const rmax = Math.max(rad(T.rate), Math.abs(v.u) / (1.4 * v.L));
    v.psi = wrapPi(v.psi + clamp(wrapPi(desired - v.psi), -rmax * dt, rmax * dt));
    if (crab) {
      const sp = Math.abs(v.u);
      v.x += Math.cos(brg) * Math.min(sp * dt, dist); v.z += Math.sin(brg) * Math.min(sp * dt, dist);
    } else {
      v.x += Math.cos(v.psi) * v.u * dt; v.z += Math.sin(v.psi) * v.u * dt;
    }
    // arrived: close enough, or the point has fallen abeam inside her turning circle (she would only circle it)
    const r = w.r ?? Math.max(6, Math.min(40, v.L * 0.25));
    const off = Math.abs(wrapPi(brg - (astern ? v.psi + Math.PI : v.psi)));
    if (dist < r || (!crab && off > rad(100) && dist < Math.abs(v.u) / Math.max(rmax, 1e-3) * 1.2)) v.i++;
  }

  // --- The tugs ----------------------------------------------------------------------------------------------------------------
  // Where each tug lies on her while fast: the bow tug ahead on its towline (it pulls), the stern tug against her quarter (it pushes).
  station(v, sim) {
    const c = Math.cos(sim.psi), s = Math.sin(sim.psi), L = sim.ship.L, B = sim.ship.B;
    const [ax, az] = v.end === 'bow' ? [L / 2 + 24, 0] : [-L / 2 + 16, (sim.tugSide ?? 1) * (B / 2 + 5.5)];
    return { x: sim.x + ax * c - az * s, z: sim.z + ax * s + az * c, psi: sim.psi };
  }
  callTugs(sim) {
    // out of berth 2, across the avant-port and (when she is still outside) out by the east side of the entrance
    const gate = this.world.px(590, 474), mid = this.world.px(580, 400), out = this.world.px(553, 330);
    const outside = this.world.gateSideOf(sim.x, sim.z) < 0;
    for (const v of this.vessels) {
      if (v.role !== 'tug') continue;
      const near = Math.hypot(sim.x - v.x, sim.z - v.z) < 250, wasMoored = v.mode === 'moored';
      v.mode = 'toShip';
      v.route = near ? [] : wasMoored ? [out, mid, ...(outside ? [gate, this.world.px(596, 530)] : [])] : [mid, ...(outside ? [gate] : [])];
      v.ri = 0;
      v.ready = false;
    }
  }
  releaseTugs() {
    const gate = this.world.px(580, 470), mid = this.world.px(575, 400), out = this.world.px(553, 330);
    for (const v of this.vessels) {
      if (v.role !== 'tug') continue;
      const outside = this.world.gateSideOf(v.x, v.z) < 0;
      v.mode = 'home';
      v.route = [...(outside ? [this.world.px(590, 520), gate] : []), mid, out, { x: v.home.x - 30, z: v.home.z }];
      v.ri = 0;
      v.ready = false;
    }
  }
  attachTugs(sim) { for (const v of this.vessels) if (v.role === 'tug') { v.mode = 'fast'; v.ready = true; Object.assign(v, this.station(v, sim)); v.u = sim.u; } }
  get tugsReady() { return this.vessels.filter((v) => v.role === 'tug').every((v) => v.ready); }
  stepTug(v, dt, sim, bodies) {
    if (v.mode === 'moored') { v.u = 0; return; }
    if (v.mode === 'fast') { Object.assign(v, this.station(v, sim)); v.u = sim.u; return; }
    const kn = 9;
    if (v.ri < v.route.length) {
      const P = v.route[v.ri];
      this.steerTo(v, P, kn, dt, bodies.filter((b) => b.ref !== 'player')); // a tug works close to her: it keeps out of her way itself
      if (Math.hypot(P.x - v.x, P.z - v.z) < 22) v.ri++;
      return;
    }
    if (v.mode === 'home') { // the last few metres to her berth
      const d = Math.hypot(v.home.x - v.x, v.home.z - v.z);
      this.steerTo(v, v.home, Math.min(3, 0.5 + d * 0.05), dt, []);
      if (d < 3) { Object.assign(v, v.home); v.u = 0; v.mode = 'moored'; }
      return;
    }
    // to her station on the ship: come up fast, then match her speed
    const st = this.station(v, sim);
    const d = Math.hypot(st.x - v.x, st.z - v.z);
    const own = Math.max(0, sim.u) / KT;
    this.steerTo(v, st, Math.min(kn, own + 1 + d * 0.06), dt, [], Math.max(0, sim.u));
    if (d < 6) { v.psi += wrapPi(st.psi - v.psi) * Math.min(1, dt * 2); }
    v.ready = d < 18 && Math.abs(sim.u) / KT <= 6;
  }
  // Steer straight for a point at up to `kn` (the zone's limit holds), stopping for anything in the way.
  // `base`: the speed of the point she is closing (a ship under way), which she must keep up with as she brakes.
  steerTo(v, P, kn, dt, bodies, base = 0) {
    const T = VESSEL_TYPES[v.type];
    const dx = P.x - v.x, dz = P.z - v.z, dist = Math.hypot(dx, dz);
    let want = kn * KT;
    const lim = this.world.speedLimitAt(v.x, v.z);
    if (lim < Infinity) want = Math.min(want, Math.max(lim - 0.4, base / KT + 0.5) * KT);
    want = Math.min(want, base + Math.sqrt(2 * T.acc * dist) + 0.1);
    if (bodies.length && this.blocked(v, bodies)) want = 0;
    v.u += clamp(want - v.u, -T.acc * 2 * dt, T.acc * dt);
    const rmax = rad(T.rate) + Math.abs(v.u) / (1.2 * v.L);
    v.psi = wrapPi(v.psi + clamp(wrapPi(Math.atan2(dz, dx) - v.psi), -rmax * dt, rmax * dt));
    const step = Math.min(v.u * dt, dist);
    v.x += Math.cos(v.psi) * step; v.z += Math.sin(v.psi) * step;
  }

  // --- The pilot boat ----------------------------------------------------------------------------------------------------------
  // `home`: alongside her berth in the port (no pilot wanted); `loiter`: circling off the pilot station; `toShip` then `alongside`
  // for six seconds (the pilot climbs the ladder); then back to loitering off the station.
  stationPilot(v, sim) {
    const c = Math.cos(sim.psi), s = Math.sin(sim.psi), az = -(sim.ship.B / 2 + 4); // her port side
    return { x: sim.x - az * s, z: sim.z + az * c, psi: sim.psi };
  }
  sendPilotOut() { const v = this.get('pilot'); if (v) { v.mode = 'loiter'; Object.assign(v, this.world.px(600, 812)); v.psi = rad(270); } }
  pilotTo() { const v = this.get('pilot'); if (v && v.mode !== 'alongside') { v.mode = 'toShip'; v.tAlong = null; } }
  stepPilot(v, dt, sim, bodies) {
    if (v.mode === 'home') { v.u = 0; return; }
    const P0 = this.world.px(575, 815);
    if (v.mode === 'loiter') { // a slow circle round the pilot station
      const a = this.t * 0.06;
      this.steerTo(v, { x: P0.x + Math.cos(a) * 70, z: P0.z + Math.sin(a) * 70 }, 6, dt, []);
      return;
    }
    if (v.mode === 'toShip') {
      const st = this.stationPilot(v, sim);
      const d = Math.hypot(st.x - v.x, st.z - v.z);
      this.steerTo(v, st, Math.min(14, Math.max(0, sim.u) / KT + 1 + d * 0.08), dt, [], Math.max(0, sim.u));
      if (d < 6) { v.mode = 'alongside'; v.tAlong = this.t; }
      return;
    }
    if (v.mode === 'alongside') {
      const st = this.stationPilot(v, sim);
      Object.assign(v, st);
      v.u = sim.u;
      if (this.t - v.tAlong > 6) { v.mode = 'away'; v.tAway = this.t; v.done = true; }
      return;
    }
    if (v.mode === 'away') { // sheer off, then back to the station
      const c = Math.cos(sim.psi), s = Math.sin(sim.psi);
      this.steerTo(v, { x: sim.x - 80 * c + 60 * s, z: sim.z - 80 * s - 60 * c }, 10, dt, []);
      if (this.t - v.tAway > 12) v.mode = 'loiter';
    }
  }
}

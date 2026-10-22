// Squadron orders, hook 5: what the player is told. Reads the sim; its only write is its own memory on the sim (`sim._info`),
// which never enters the digest, so the info layer cannot change a run.
//   contactsFor(sim, t) -> [{ idx, team, kind, state, conf, x, z, psi, u, bearing, range }]
//     A hostile or neutral ship appears gradually. Inside the radar range of any living squadron ship (9 km times that
//     ship's `radar`, from its role) it is 'detected': bearing and a vague position (range rounded to 500 m), no class or
//     course, conf 0.4. After TRACK_AFTER seconds in range it is 'tracked': exact position, course, speed and class, conf 1.
//     When it leaves range it is 'lost' for LOST_FADE seconds (last known position, conf fading to 0), then it is gone.
//     A detected contact that leaves range is dropped at once (it was never held).
//   alertsOf(sim) -> [{ type, ship, t, severity, text, active }]   every alert that has fired, each once, in firing order.
//     'missile' / 'drone' (a launch seen, once per track), 'inbound' (one within INBOUND_RANGE of a squadron ship), 'flooding',
//     'fire' (compartment named), 'formation' (more than 2x tolerance off station, only when the sim gives stationOf(ship)
//     -> { x, z, tol? }), 'fuel', 'ammo'. A condition alert fires when it first holds and again only after it has cleared.
//   Calls are the clock: call at least every few seconds (the scene calls every frame). A call with an earlier t than
//   before, or a new `sim.ships` array (a reset or rewind), starts the memory afresh.
import { COMPARTMENTS, COMP_IDS } from './duel.js';

export const RADAR_RANGE = 9000; // m, the base detection range of a squadron ship (times its role's `radar`)
export const TRACK_AFTER = 4; // s in range before a contact is tracked
export const LOST_FADE = 20; // s a lost contact is still shown before it drops
export const DETECT_GRID = 500; // m, the range of a detected contact is rounded to this
export const INBOUND_RANGE = 2500; // m, a missile or drone this close to the squadron is 'inbound'
export const FORMATION_TOL = 70; // m, the default station tolerance
const LOW_FUEL = 0.2;
const LOW_MAIN_AMMO = 15; // 76 mm rounds
const LOW_GUN_AMMO = 250; // 30 mm rounds, all mounts together
const FLOOD_ALERT = 0.05;

const dist = (a, b) => Math.hypot(b.x - a.x, b.z - a.z);
const deg = (r) => ((r * 180) / Math.PI + 360) % 360;

// The memory lives on the sim, keyed to its current ships array: a reset() builds a new array, so it starts afresh.
function memOf(sim) {
  if (!sim._info || sim._info.arr !== sim.ships) {
    sim._info = { arr: sim.ships, byIdx: {}, lastT: -Infinity, alerts: [], active: new Set(), seen: new Set() };
  }
  const m = sim._info;
  if (sim.t < m.lastT) { m.byIdx = {}; m.alerts = []; m.active = new Set(); m.seen = new Set(); }
  m.lastT = sim.t;
  return m;
}

const squadLive = (sim) => sim.squad.filter((s) => s.tSunk === null);

// The squadron ship that sees `o` best (the nearest of those whose radar reaches it), or null.
function observer(sim, o) {
  let best = null, bestD = Infinity;
  for (const s of squadLive(sim)) {
    const d = dist(s, o);
    if (d <= RADAR_RANGE * (s.radar ?? 1) && d < bestD) { best = s; bestD = d; }
  }
  return best ? { ship: best, d: bestD } : null;
}

export function contactsFor(sim, t = sim.t) {
  const m = memOf(sim);
  const out = [];
  for (const o of sim.ships) {
    if (o.team === 0) continue;
    const e = (m.byIdx[o.idx] ??= { inSince: null, tracked: false, outAt: null, last: null });
    const seen = o.tSunk === null ? observer(sim, o) : null;
    if (seen) {
      if (e.inSince === null) { e.inSince = t; e.outAt = null; }
      if (!e.tracked && t - e.inSince >= TRACK_AFTER) e.tracked = true;
      const brg = Math.atan2(o.z - seen.ship.z, o.x - seen.ship.x);
      if (e.tracked) {
        e.last = { x: o.x, z: o.z, psi: o.psi, u: o.u, kind: o.kind };
        out.push({ idx: o.idx, team: o.team, kind: o.kind, state: 'tracked', conf: 1, x: o.x, z: o.z, psi: o.psi, u: o.u, bearing: deg(brg), range: seen.d });
      } else {
        const rq = Math.round(seen.d / DETECT_GRID) * DETECT_GRID;
        const x = seen.ship.x + Math.cos(brg) * rq, z = seen.ship.z + Math.sin(brg) * rq;
        out.push({ idx: o.idx, team: o.team, kind: null, state: 'detected', conf: 0.4, x, z, psi: null, u: null, bearing: deg(brg), range: rq });
      }
    } else {
      if (e.inSince !== null) { e.inSince = null; e.outAt = t; }
      if (!e.tracked) continue;
      if (e.outAt !== null && t - e.outAt < LOST_FADE && e.last) {
        const fade = 1 - (t - e.outAt) / LOST_FADE;
        out.push({ idx: o.idx, team: o.team, kind: e.last.kind, state: 'lost', conf: fade, x: e.last.x, z: e.last.z, psi: e.last.psi, u: e.last.u, bearing: null, range: null });
      } else if (e.outAt !== null) {
        e.tracked = false; e.outAt = null; e.last = null; // faded out: the contact is gone
      }
    }
  }
  return out;
}

export function alertsOf(sim) {
  const m = memOf(sim);
  const t = sim.t;
  // A condition alert: fires the first time it holds, and again only after it has cleared (an episode).
  const cond = (key, holds, make) => {
    if (holds && !m.active.has(key)) { m.active.add(key); m.alerts.push({ key, t, ...make() }); }
    else if (!holds) m.active.delete(key);
  };
  const live = squadLive(sim);
  const name = (id) => COMPARTMENTS[id]?.name ?? id;
  for (const s of sim.squad) {
    if (s.tSunk !== null) continue;
    cond(`flooding:${s.idx}`, s.flood > FLOOD_ALERT, () => ({ type: 'flooding', ship: s.idx, severity: 'warn', text: `Ship ${s.idx + 1} flooding` }));
    const burning = COMP_IDS.filter((id) => s.fire[id] > 0);
    cond(`fire:${s.idx}`, burning.length > 0, () => ({ type: 'fire', ship: s.idx, severity: 'danger', text: `Ship ${s.idx + 1} fire in ${burning.map(name).join(', ')}` }));
    const st = typeof sim.stationOf === 'function' && s.form ? sim.stationOf(s) : null;
    cond(`formation:${s.idx}`, !!st && dist(s, st) > 2 * (st.tol ?? FORMATION_TOL), () => ({ type: 'formation', ship: s.idx, severity: 'warn', text: `Ship ${s.idx + 1} out of formation` }));
    cond(`fuel:${s.idx}`, (s.fuel ?? 1) < LOW_FUEL, () => ({ type: 'fuel', ship: s.idx, severity: 'warn', text: `Ship ${s.idx + 1} low on fuel` }));
    const gats = s.gats.reduce((n, g) => n + g.ammo, 0);
    cond(`ammo:${s.idx}`, s.gun.ammo < LOW_MAIN_AMMO || gats < LOW_GUN_AMMO, () => ({ type: 'ammo', ship: s.idx, severity: 'warn', text: `Ship ${s.idx + 1} low on ammunition` }));
  }
  // Raiders by kind: a launch is seen once per track; an inbound one fires once when it closes inside INBOUND_RANGE.
  const once = (key, make) => {
    if (m.seen.has(key)) return;
    m.seen.add(key);
    m.active.add(key); // events stay active: they are not cleared
    m.alerts.push({ key, t, ...make() });
  };
  for (const o of sim.ships) {
    if (o.team !== 1 || (o.kind !== 'missile' && o.kind !== 'drone') || o.tSunk !== null || !live.length) continue;
    const word = o.kind === 'missile' ? 'Missile' : 'Drone';
    once(`launch:${o.idx}`, () => ({ type: o.kind, ship: o.idx, severity: 'warn', text: `${word} launched` }));
    const d = Math.min(...live.map((s) => dist(s, o)));
    if (d < INBOUND_RANGE) once(`inbound:${o.idx}`, () => ({ type: 'inbound', ship: o.idx, severity: 'danger', text: `${word} inbound, ${Math.round(d)} m` }));
  }
  return m.alerts.map(({ key, ...a }) => ({ ...a, active: m.active.has(key) }));
}

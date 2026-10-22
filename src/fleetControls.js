// Fleet command's controls, as pure functions: what a key or a click means as an order, for the ships selected. The scene (fleetMain.js)
// only reads keys and clicks and calls these; test/fleetControls.test.mjs drives them against a FleetSim.
//
// A selection is 'all' or one squadron index. A formation or a sector patrol is laid off from the lead (the guide), so while one is ordered
// a course, speed or goto meant for everybody goes to the lead alone: the others follow her. (Sent to every ship, a course or goto would
// also clear their formation and send them all to the same point.) A single follower given a course or goto leaves her station.
import { FORMATIONS, leadOf } from './fleetOrders.js';
import { ROLES } from './fleetRoles.js';
import { HULL_HP, DT } from './duel.js';

export const FORM_CYCLE = Object.keys(FORMATIONS); // FORM 1, FORM 3, BOX, FORM D
export const FORM_LABEL = { 'FORM 1': 'Column', 'FORM 3': 'Line abreast', BOX: 'Box', 'FORM D': 'Diamond' };
export const SPEEDS = [0, 5, 10, 16, 22, 28]; // kn: stop, dead slow, slow, half, full, flank
export const TURN_STEP = 10; // degrees an arrow key turns the goal course
export const PATROL_INNER = 700; // m, the sector patrol's inner and outer range from the lead
export const PATROL_OUTER = 2200;
export const ROLE_NAME = { picket: 'Picket', gun: 'Gun ship', escort: 'Escort' };

const wrapDeg = (a) => ((a % 360) + 360) % 360;
const deg = (r) => (r * 180) / Math.PI;
const alive = (s) => s && s.tSunk === null;

export const headingDeg = (s) => wrapDeg(deg(s.psi));
export const pad3 = (d) => String(Math.round(wrapDeg(d)) % 360).padStart(3, '0');
export const shipName = (s) => `Ship ${s.idx + 1}`;

// The hull points a squadron ship was built with (her role scales the duel's HULL_HP), so a percentage is of her own full hull.
export function hullMax(s) {
  return (s.roleBase?.hp ?? HULL_HP) * (ROLES[s.role]?.hp ?? 1);
}
export const hullFrac = (s) => Math.min(1, Math.max(0, s.hp / hullMax(s)));

// Squadron ships a selection names, living only.
export function targets(sim, sel) {
  return sim.targetsOf(sel === 'all' ? 'all' : sel);
}
const followers = (sim) => sim.squad.filter((s) => alive(s) && s !== leadOf(sim));
const bound = (sim) => followers(sim).some((s) => s.form || s.sector);

// Who a course, speed or goto order goes to.
export function scopeFor(sim, sel) {
  if (sel === 'all') return bound(sim) ? leadOf(sim).idx : 'all';
  return sel;
}
const firstOf = (sim, to) => targets(sim, to)[0] ?? leadOf(sim);

// The course the next arrow press starts from: the ship's ordered course, or the way she is heading if she is in a formation, patrol or goto.
export function baseCourse(s) {
  return s.form || s.sector || s.goal.to ? Math.round(headingDeg(s)) : s.goal.course;
}
export function courseOrder(sim, sel, delta) {
  const to = scopeFor(sim, sel);
  const base = baseCourse(firstOf(sim, to));
  return { to, type: 'course', course: wrapDeg(Math.round((base + delta) / TURN_STEP) * TURN_STEP) };
}
// One step along SPEEDS from the ship's ordered speed.
export function speedOrder(sim, sel, dir) {
  const to = scopeFor(sim, sel);
  const cur = firstOf(sim, to).goal.kn;
  let k = SPEEDS.reduce((best, v, i) => (Math.abs(v - cur) < Math.abs(SPEEDS[best] - cur) ? i : best), 0);
  k = Math.min(SPEEDS.length - 1, Math.max(0, k + dir));
  return { to, type: 'speed', kn: SPEEDS[k] };
}
// Formations are laid off from the lead: they go to the followers (the lead, selected alone, orders them all).
export function formOrder(sim, sel) {
  const sel2 = sel === 'all' || sel === leadOf(sim).idx ? followers(sim).map((s) => s.idx) : [sel];
  const cur = sim.squad.find((s) => sel2.includes(s.idx))?.form ?? null;
  const next = FORM_CYCLE[(FORM_CYCLE.indexOf(cur) + 1) % FORM_CYCLE.length];
  return sel2.length ? { to: sel2, type: 'form', form: next } : null;
}
// A sector patrol: the followers split the circle round the lead into equal slices, the first one centred on her bow. A second press
// (every one of them already on patrol) ends it and they steer the way they are heading.
export function sectorOrders(sim, sel) {
  const lead = leadOf(sim);
  const f = (sel === 'all' || sel === lead.idx ? followers(sim) : followers(sim).filter((s) => s.idx === sel));
  if (!f.length) return [];
  if (f.every((s) => s.sector)) return f.map((s) => ({ to: s.idx, type: 'course', course: Math.round(headingDeg(s)) % 360 }));
  const all = followers(sim);
  const width = 360 / all.length;
  const h = Math.round(headingDeg(lead));
  return f.map((s) => {
    const k = all.indexOf(s);
    const from = wrapDeg(h - width / 2 + k * width);
    return { to: s.idx, type: 'sector', sector: { from: Math.round(from), to: Math.round(wrapDeg(from + width)), inner: PATROL_INNER, outer: PATROL_OUTER } };
  });
}
// Hold fire, or engage again if every ship selected is already holding.
export function stanceOrder(sim, sel) {
  const t = targets(sim, sel);
  if (!t.length) return null;
  return { to: sel === 'all' ? 'all' : sel, type: 'stance', stance: t.every((s) => s.stance === 'hold') ? 'engage' : 'hold' };
}
export function gotoOrder(sim, sel, x, z) {
  return { to: scopeFor(sim, sel), type: 'goto', x: Math.round(x), z: Math.round(z) };
}
// Shift-click: steer for the bearing of a point (no destination).
export function courseToOrder(sim, sel, x, z) {
  const to = scopeFor(sim, sel);
  const s = firstOf(sim, to);
  return { to, type: 'course', course: Math.round(wrapDeg(deg(Math.atan2(z - s.z, x - s.x)))) };
}

// The squadron ship after `fromIdx` in order (living, not herself), preferring those within `range` metres; null if she is alone.
export function crewTarget(sim, fromIdx, range = Infinity) {
  const live = sim.squad.filter((s) => alive(s));
  const from = sim.ships[fromIdx];
  if (live.length < 2 || !alive(from)) return null;
  const after = [...live.filter((s) => s.idx > fromIdx), ...live.filter((s) => s.idx < fromIdx)];
  return after.find((s) => Math.hypot(s.x - from.x, s.z - from.z) <= range) ?? after[0];
}

// Z: the moment to rewind to. Normally the moment of the last order (the state just after it, paused, ready to be changed). When the
// simulation is already standing at that moment (the order was just given, or several while paused), Z takes them back: one step
// before. A press after that goes to the order before it, and so on.
export function rewindTarget(sim) {
  const last = sim.log[sim.log.length - 1];
  if (!last) return null;
  return last.n < sim.steps ? last.t : Math.max(0, last.t - DT);
}

// A readable line for the order log.
export function describeOrder(e) {
  const who = e.to === 'all' ? 'All ships' : Array.isArray(e.to) ? `Ships ${e.to.map((i) => i + 1).join(', ')}` : `Ship ${e.to + 1}`;
  switch (e.type) {
    case 'course': return `${who}: course ${pad3(e.course)}`;
    case 'speed': return `${who}: speed ${e.kn} kn`;
    case 'form': return `${who}: ${FORM_LABEL[e.form] ?? e.form}`;
    case 'sector': return `${who}: patrol ${pad3(e.sector.from)}-${pad3(e.sector.to)}`;
    case 'stance': return `${who}: ${e.stance === 'hold' ? 'hold fire' : 'engage'}`;
    case 'goto': return `${who}: go to ${Math.round(e.x)}, ${Math.round(e.z)}`;
    case 'crew': return `Ship ${e.from + 1}: crew to ship ${e.dest + 1}`;
    default: return `${who}: ${e.type}`;
  }
}

// Issue orders and return the stamped entries (an array may contain nulls and false from refused orders).
export function issue(sim, orders) {
  const list = Array.isArray(orders) ? orders : [orders];
  return list.filter(Boolean).map((o) => sim.order(o)).filter(Boolean);
}

// An action put in the log so a rewind replays it: a crew moved between ships. FleetSim.order refuses unknown types,
// so the entry is stamped here exactly as order() does and applied through applyLogged; the sim needs the hook wrapper below.
export function logCrew(sim, from, dest) {
  const e = { to: 'all', type: 'crew', from, dest, t: sim.t, n: sim.steps };
  sim.log.push(e);
  sim.applyLogged(e);
  return e;
}
// Wraps the order hook so a logged crew move is carried out by transferCrew (and replayed by a rewind). `base` is fleetOrders.applyOrder.
export function withCrewHook(base, transferCrew, results = null) {
  return (sim, order) => {
    if (order.type === 'crew') {
      const ok = transferCrew(sim, order.from, order.dest);
      if (results) results.last = ok;
      return;
    }
    base(sim, order);
  };
}

// New alerts since the last call. The sim's list only grows; it starts afresh on a reset or a rewind (fewer alerts, or an earlier time).
export class AlertFeed {
  constructor() { this.seen = 0; this.lastT = 0; }
  take(sim) {
    const list = sim.alerts();
    if (sim.t < this.lastT - 0.5 || list.length < this.seen) this.seen = 0;
    this.lastT = sim.t;
    const fresh = list.slice(this.seen);
    this.seen = list.length;
    return fresh;
  }
  reset() { this.seen = 0; this.lastT = 0; }
  // After a restart or a rewind: what the sim says now is not news.
  sync(sim) { this.seen = sim.alerts().length; this.lastT = sim.t; }
}

// How a contact is named on the radar and in the list: a code for the map (R2) and a name for the list (Raider 2). Raiders, drones and
// merchants are numbered in the order they came, among the ships of their own kind; a vague contact (no class yet) is just a '?'.
export function contactLabel(sim, c) {
  if (c.kind === null || c.kind === undefined) return { code: '?', name: c.team === 2 ? 'Unknown (neutral)' : 'Unknown contact', rank: 0, hostile: c.team === 1 };
  const kindOf = (s) => (s.merchant ? 'merchant' : s.kind === 'drone' ? 'drone' : 'frigate');
  const k = c.kind === 'merchant' ? 'merchant' : c.kind === 'drone' ? 'drone' : 'frigate';
  let rank = 0;
  for (const s of sim.ships) {
    if (s.idx >= sim.n && kindOf(s) === k && s.team === c.team) rank += 1;
    if (s.idx === c.idx) break;
  }
  const word = k === 'merchant' ? 'Merchant' : k === 'drone' ? 'Drone' : 'Raider';
  return { code: `${word[0]}${rank}`, name: `${word} ${rank}`, rank, hostile: c.team === 1 };
}

// "Fleet command": you command a squadron of 3 or 4 frigates; the hulls steer and fight themselves and you give orders.
// A pure, seeded, deterministic real-time simulation on top of the ship duel (duel.js): same physics, same guns, same
// damage. Imports only duel.js and the hook modules; tested in Node by test/fleet.test.mjs.
//
// ===== FROZEN CONTRACTS (other modules and the scene build on these) ================================================
// Ships: squadron = ships idx 0..N-1 (team 0, N = 3..4, default 4), always first in sim.ships; later indexes are threats
//   (team 1 enemy, 2 neutral merchants, 0 allies). Every squadron ship runs on the AI helmsman (s.ai set); the player never
//   steers a hull. Extras on a DuelSim ship:
//     role    'picket' | 'gun' | 'escort'          (fleetRoles.applyRole sets it and its stat tweaks; also s.radar)
//     goal    { course (deg true, 0 = +X, cw), kn, to: [x, z] | null }   what the helmsman steers for (via hooks.steerGoal)
//     stance  'engage' | 'hold'                    hold = 76 mm and 30 mm do not fire (s.cmd.fire/gat false, s.auto false)
//     form    string | null                        the formation ordered (meaning belongs to fleetOrders)
//     sector  object | null                        the screen sector ordered (fleetOrders)
//     fuel    0..1                                 (fleetResources)
// Orders: { t, to: 'all' | idx | [idx], type: 'course'|'speed'|'form'|'sector'|'stance'|'goto', ...args }
//     args: course {course: deg}, speed {kn}, form {form}, sector {sector}, stance {stance: 'engage'|'hold'}, goto {x, z}.
//   sim.order(o) stamps it (t = sim.t, n = sim.steps; any t in `o` is ignored), appends it to sim.log, applies it through
//   hooks.applyOrder, and returns the stamped entry (false for an unknown type). Orders act between two fixed steps.
// Rewind: sim.rewindTo(t) = reset() + replay of the log entries with t <= target through step(), then the log is cut there
//   (a rewind is a branch point). Same seed + same log => identical state, bit for bit (sim.digest() compares).
// Hooks (one object, assembled below; FleetSim reads this.hooks, `new FleetSim({ hooks: {...} })` overrides single entries):
//   fleetOrders     applyOrder(sim, order) -> void            steerGoal(sim, ship) -> { course, kn }
//   fleetThreats    planThreats(sim, rng) -> [{t, kind, ...}]  spawnThreat(sim, w) -> void   (pending list like DuelSim.pending)
//   fleetResources  stepResources(sim, dt) -> void             (after every physics step)
//   fleetRoles      ROLES table, applyRole(ship, role) -> void
//   fleetInfo       contactsFor(sim, t) -> [contact]           alertsOf(sim) -> [alert]
//   fleetScoring    SCENARIOS {escort, defend}, LEVELS, scoreOf(sim) -> {status:'running'|'won'|'lost', reason},
//                   debriefOf(sim) -> {...}
//   Hook modules import only pure code (duel.js, hull.js, formations.js) and reach everything else through the sim object:
//   sim.squad, sim.targetsOf(to), sim.centroid(), sim.newShip(x, z, psi, team, kind), sim.rngW, sim.makeAi(level), sim.events.
// Judging: FleetSim.judge() loses when one of ours sinks a merchant ('merchant') or every squadron ship is sunk ('sunk'),
//   otherwise asks hooks.scoreOf. winner is 0 (won) or 1 (lost), over is the reason, as in DuelSim.
// ====================================================================================================================
import { DuelSim, DT, LEVELS, TELEGRAPH, KT, makeShip, mulberry32 } from './duel.js';
import { applyOrder, steerGoal } from './fleetOrders.js';
import { planThreats, spawnThreat } from './fleetThreats.js';
import { stepResources } from './fleetResources.js';
import { applyRole } from './fleetRoles.js';
import { contactsFor, alertsOf } from './fleetInfo.js';
import { scoreOf, debriefOf, SCENARIOS } from './fleetScoring.js';

export { DT };
export const hooks = { applyOrder, steerGoal, planThreats, spawnThreat, stepResources, applyRole, contactsFor, alertsOf, scoreOf, debriefOf };
export const ORDER_TYPES = ['course', 'speed', 'form', 'sector', 'stance', 'goto'];
export const ROLE_PLAN = { 3: ['picket', 'gun', 'escort'], 4: ['picket', 'gun', 'gun', 'escort'] };
export const COLUMN_GAP = 400; // m between ships at the start
export const THINK = 0.5; // s between a squadron helmsman's looks

const rad = (d) => (d * Math.PI) / 180;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const wrapPi = (a) => Math.atan2(Math.sin(a), Math.cos(a));
// The helmsman's profile: the duel's Normal fire-control, tuned like the player's own (aim factor 1, 3 s tracker).
const SQUAD_AI = { ...LEVELS.normal, aim: 1.0, track: 3, think: THINK, crews: 2 };

export class FleetSim extends DuelSim {
  constructor({ seed = 11, level = 'normal', n = 4, scenario = 'defend', hooks: over = null } = {}) {
    super({ seed, level, waves: false });
    this.n = clamp(Math.round(n) || 4, 3, 4);
    this.scenario = SCENARIOS[scenario] ? scenario : 'defend';
    this.hooks = { ...hooks, ...(over ?? {}) };
    this.log = [];
    this._ready = true; // DuelSim's constructor calls reset() before this class has its settings: that first call does nothing
    this.reset();
  }

  reset() {
    if (!this._ready) return;
    this.ghost = makeShip(-1, 0, 0, 0, 1); // "no target": a sunk ship, so a guns-idle ship never aims at a friend
    this.ghost.tSunk = 0;
    super.reset();
    this.rng = mulberry32(this.seed);
    this.steps = 0;
    this.ships = [];
    for (let i = 0; i < this.n; i++) {
      const s = makeShip(i, -i * COLUMN_GAP, 0, 0, 0);
      s.u = TELEGRAPH[4].kn * KT;
      s.ai = { level: 'squad', p: SQUAD_AI, next: 0, side: 1, jink: 0, nextJink: Infinity };
      s.goal = { course: 0, kn: TELEGRAPH[4].kn, to: null };
      s.stance = 'engage';
      s.form = null;
      s.sector = null;
      s.fuel = 1;
      this.hooks.applyRole(s, ROLE_PLAN[this.n][i]);
      this.ships.push(s);
    }
    this.squad = this.ships.slice(0, this.n);
    this.shells = [];
    this.events = [];
    this.winner = null;
    this.over = null;
    this.collided = {};
    this.merchantsLost = 0; // any merchant sunk, by anyone
    this.merchantsKilledByUs = 0; // ... by a squadron ship's guns
    this._counted = new Set();
    this.pickTargets();
    this.pending = this.hooks.planThreats(this, mulberry32((this.seed ^ 0xf1ee7) >>> 0)).slice().sort((a, b) => a.t - b.t);
  }

  // --- the outside world -----------------------------------------------------------------------------------------------
  // The player gives no steering input: `input` is ignored, the whole state is a function of the seed and the order log.
  step(dt) {
    super.step(dt, {});
    this.steps += 1;
    this.hooks.stepResources(this, dt);
  }

  // Squadron ships a selector names (living only): 'all', one index, or a list of indexes.
  targetsOf(to) {
    const ids = to === 'all' || to === undefined ? this.squad.map((s) => s.idx) : Array.isArray(to) ? to : [to];
    return this.squad.filter((s) => ids.includes(s.idx) && s.tSunk === null);
  }
  centroid() {
    const live = this.squad.filter((s) => s.tSunk === null);
    const l = live.length ? live : this.squad;
    return { x: l.reduce((a, s) => a + s.x, 0) / l.length, z: l.reduce((a, s) => a + s.z, 0) / l.length };
  }
  // A new ship for the threat hooks: gets the next index, joins the target picking.
  newShip(x, z, psi, team, kind = 'frigate') {
    const s = makeShip(this.ships.length, x, z, psi, team, kind);
    if (kind === 'merchant') { s.order = 3; s.u = 12 * KT; } else s.u = TELEGRAPH[4].kn * KT;
    this.ships.push(s);
    this.pickTargets();
    return s;
  }
  spawn(w) { this.hooks.spawnThreat(this, w); }
  contacts(t = this.t) { return this.hooks.contactsFor(this, t); }
  alerts() { return this.hooks.alertsOf(this); }
  debrief() { return this.hooks.debriefOf(this); }

  // --- orders, the log, rewind -------------------------------------------------------------------------------------
  order(o) {
    if (!o || !ORDER_TYPES.includes(o.type)) return false;
    const entry = structuredClone({ ...o, to: o.to ?? 'all' });
    entry.t = this.t;
    entry.n = this.steps;
    this.log.push(entry);
    this.applyLogged(entry);
    return entry;
  }
  applyLogged(entry) {
    this.hooks.applyOrder(this, structuredClone(entry));
    this.events.push({ type: 'order', order: entry });
  }
  // Back to time t (rounded to a fixed step) as it really was: reset, then replay the log up to and including t.
  rewindTo(t) {
    const target = Math.max(0, Math.round(t / DT));
    const keep = this.log.filter((e) => e.n <= target);
    this.reset();
    this.log = keep;
    for (const e of keep) {
      while (this.steps < e.n) this.step(DT);
      this.applyLogged(e);
    }
    while (this.steps < target) this.step(DT);
    this.acc = 0;
    return this;
  }
  // Everything that matters, exactly (no rounding), for the determinism tests.
  digest() {
    return JSON.stringify({
      t: this.t, steps: this.steps, winner: this.winner, over: this.over, shells: this.shells.length, pend: this.pending.length,
      ships: this.ships.map((s) => [s.idx, s.team, s.x, s.z, s.psi, s.u, s.hp, s.tSunk, s.order, s.comp, s.gun.ammo, s.stance, s.goal, s.stats]),
    });
  }

  // --- ships[0] is not special here ---------------------------------------------------------------------------------
  get lead() { return this.squad.find((s) => s.tSunk === null) ?? this.squad[0]; }
  get enemy() { return this.foe(this.lead); }
  range() { const a = this.lead, b = this.enemy; return Math.hypot(b.x - a.x, b.z - a.z); }
  foe(s) { return this.ships[s.target] ?? this.ghost; }
  // On Easy every squadron ship is tough (the duel gives that to ships[0] only).
  easyShield(from, tgt) { return this.level === 'easy' && tgt.team === 0 && tgt.idx < this.n && this.hostile(from, tgt); }

  // --- judging ----------------------------------------------------------------------------------------------------------
  judge() {
    if (this.winner !== null) return;
    for (const s of this.ships) {
      if (!s.merchant || s.tSunk === null || this._counted.has(s.idx)) continue;
      this._counted.add(s.idx);
      this.merchantsLost += 1;
      if (s.lastHitBy !== undefined && s.lastHitBy >= 0 && s.lastHitBy < this.n) this.merchantsKilledByUs += 1;
    }
    if (this.merchantsKilledByUs > 0) { this.finish(1, 'merchant'); return; }
    if (this.squad.every((s) => s.tSunk !== null)) { this.finish(1, 'sunk'); return; }
    const r = this.hooks.scoreOf(this);
    if (r.status === 'won') this.finish(0, r.reason || 'won');
    else if (r.status === 'lost') this.finish(1, r.reason || 'lost');
  }

  // --- a squadron helmsman ------------------------------------------------------------------------------------------
  // Every THINK seconds: steer for the goal the order hooks give, set the guns by stance. Enemies keep the duel's own helmsman.
  think(s) {
    if (s.team !== 0 || s.idx >= this.n) { super.think(s); return; }
    const ai = s.ai;
    ai.next = this.t + THINK;
    if (s.tSunk !== null) return;
    const g = this.hooks.steerGoal(this, s) ?? s.goal;
    const err = wrapPi(rad(g.course) - s.psi);
    s.cmd.want = Math.abs(err) < rad(0.5) ? 0 : clamp(err / rad(8), -1, 1);
    let best = 0;
    for (let i = 1; i < TELEGRAPH.length; i++) if (Math.abs(TELEGRAPH[i].kn - g.kn) < Math.abs(TELEGRAPH[best].kn - g.kn)) best = i;
    if (s.order < best) s.order += 1; else if (s.order > best) s.order -= 1;
    const engage = s.stance === 'engage';
    s.cmd.fire = engage;
    s.cmd.gat = engage;
    s.auto = engage;
    const o = this.foe(s);
    if (o !== this.ghost) this.chooseAmmo(s, o);
    this.dispatchCrews(s);
  }
}

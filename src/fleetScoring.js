// Fleet command, hook 6: scenarios and how a run is judged. Reads the sim; its memory (`sim._score`, keyed to the ships
// array like fleetInfo's) only remembers which merchants have crossed and how long the lead has been out of the zone.
//   SCENARIOS            { escort, defend } -> { name, duration (s), text, ... }
//                        escort: `gate` (m ahead of the start, along +X): merchants must get past it.
//                        defend: `zone` { x, z, r }: the lead ship must stay inside it.
//   LEVELS               the duel's levels, reused (the enemy's decisions and aim)
//   LEVEL_RULES          per level: `allowed` merchants that may be lost (escort; 0 means any loss loses), `outLimit` s the lead
//                        may be out of the zone (defend)
//   scoreOf(sim)         -> { status: 'running' | 'won' | 'lost', reason }. Also calls the next raider wave in once the last
//                        one is down (as DuelSim.judge does), so FleetSim.judge's call is the only one that moves the waves.
//   debriefOf(sim)       -> { scenario, status, reason, verdict, time, losses [idx], shots, hits, merchantsSaved, merchantsCrossed,
//                        merchantsLost, enemiesSunk, score }. Reads only; never moves a wave or changes the sim.
import { LEVELS } from './duel.js';

export { LEVELS };
export const SCENARIOS = {
  escort: { name: 'Escort', duration: 300, gate: 2000, text: 'Bring the merchants past the gate, two kilometres ahead.' },
  defend: { name: 'Defend', duration: 240, zone: { x: 0, z: 0, r: 2500 }, text: 'Hold the zone against every raider; keep the lead in it.' },
};
export const LEVEL_RULES = {
  easy: { allowed: 1, outLimit: 90 },
  normal: { allowed: 0, outLimit: 60 },
  hard: { allowed: 0, outLimit: 40 },
};
// The pending kinds fleetThreats plans: raiders come in waves; drones and merchants are not raiders.
const RAIDER_KINDS = ['raider', 'wave', 'enemy'];
const GRACE = 120; // s past the duration after which a defence is decided by who is left
const CALL_IN = 12; // s before the next raider wave arrives once the last is down (as DuelSim.judge)

const VERDICT = {
  escorted: 'Every merchant that counted got through',
  merchant: 'A merchant was lost',
  stranded: 'Too few merchants can still get through',
  late: 'The merchants did not get through in time',
  zone: 'The lead ship left the zone for too long',
  held: 'The zone held',
  sunk: 'The squadron was sunk',
  cleared: 'Every raider was beaten off',
  time: 'Time ran out with the squadron afloat',
};

function memOf(sim) {
  if (!sim._score || sim._score.arr !== sim.ships) sim._score = { arr: sim.ships, crossed: new Set(), outSince: null, lastT: -Infinity };
  const m = sim._score;
  if (sim.t < m.lastT) { m.crossed = new Set(); m.outSince = null; }
  m.lastT = sim.t;
  return m;
}

const rules = (sim) => LEVEL_RULES[sim.level] ?? LEVEL_RULES.normal;
const inZone = (s, z) => Math.hypot(s.x - z.x, s.z - z.z) <= z.r;

// The verdict, and whether to call the next raider in (`mutate`). Both scenarios and the squadron's own losses.
function evaluate(sim, mutate) {
  const sc = SCENARIOS[sim.scenario] ?? SCENARIOS.defend;
  const m = memOf(sim);
  const live = sim.squad.filter((s) => s.tSunk === null);
  if (!live.length) return { status: 'lost', reason: 'sunk' };
  const foes = sim.ships.filter((s) => s.team === 1 && s.tSunk === null);
  const raiderWaves = sim.pending.filter((w) => RAIDER_KINDS.includes(w.kind));

  if (sim.scenario === 'escort') {
    const merchants = sim.ships.filter((s) => s.merchant);
    for (const s of merchants) if (s.tSunk === null && s.x >= sc.gate) m.crossed.add(s.idx);
    const lost = merchants.filter((s) => s.tSunk !== null).length;
    if (lost > rules(sim).allowed) return { status: 'lost', reason: 'merchant' };
    const total = merchants.length + sim.pending.filter((w) => w.kind === 'merchant').length;
    const need = Math.max(1, total - rules(sim).allowed);
    if (total > 0) {
      const crossed = merchants.filter((s) => m.crossed.has(s.idx)).length;
      if (crossed >= need) return { status: 'won', reason: 'escorted' };
      const still = merchants.filter((s) => s.tSunk === null && !m.crossed.has(s.idx)).length;
      const pendingM = sim.pending.filter((w) => w.kind === 'merchant').length;
      if (crossed + still + pendingM < need) return { status: 'lost', reason: 'stranded' };
    }
    if (sim.t >= sc.duration) return { status: 'lost', reason: 'late' };
    return { status: 'running', reason: '' };
  }

  // defend: the lead ship must stay in the zone; the next raider is called in when the last one is down.
  const z = sc.zone;
  const lead = sim.lead;
  if (lead && !inZone(lead, z)) {
    if (m.outSince === null) m.outSince = sim.t;
    if (sim.t - m.outSince >= rules(sim).outLimit) return { status: 'lost', reason: 'zone' };
  } else m.outSince = null;
  if (!foes.length && raiderWaves.length && mutate) {
    const coming = raiderWaves[0];
    coming.t = Math.min(coming.t, sim.t + CALL_IN);
    sim.pending.sort((a, b) => a.t - b.t);
  }
  const cleared = !foes.length && !sim.pending.some((w) => RAIDER_KINDS.includes(w.kind) || w.kind === 'drone');
  if (sim.t >= sc.duration && cleared) return { status: 'won', reason: 'held' };
  if (sim.t >= sc.duration + GRACE) return { status: 'won', reason: 'time' };
  return { status: 'running', reason: '' };
}

export function scoreOf(sim) {
  return evaluate(sim, true);
}

export function debriefOf(sim) {
  const r = evaluate(sim, false);
  const m = memOf(sim);
  const merchants = sim.ships.filter((s) => s.merchant);
  const status = sim.winner === null ? r.status : sim.winner === 0 ? 'won' : 'lost';
  const reason = sim.over ?? r.reason;
  const losses = sim.squad.filter((s) => s.tSunk !== null).map((s) => s.idx);
  const hits = sim.squad.reduce((n, s) => n + s.stats.hits, 0);
  const merchantsSaved = merchants.filter((s) => s.tSunk === null).length;
  const enemiesSunk = sim.ships.filter((s) => s.team === 1 && s.tSunk !== null).length;
  const score = Math.max(0, Math.round(
    enemiesSunk * 100 + merchantsSaved * 150 - losses.length * 200 - sim.merchantsLost * 150 + hits * 5 + (status === 'won' ? 300 : 0) - sim.t / 10,
  ));
  const win = status === 'won';
  const text = VERDICT[reason] ?? reason;
  return {
    scenario: sim.scenario,
    status,
    reason,
    verdict: status === 'running' ? 'In progress.' : `${win ? 'Won' : 'Lost'}: ${text}.`,
    time: sim.t,
    losses,
    shots: sim.squad.reduce((n, s) => n + s.stats.shells, 0),
    hits,
    merchantsSaved,
    merchantsCrossed: merchants.filter((s) => m.crossed.has(s.idx)).length,
    merchantsLost: sim.merchantsLost,
    enemiesSunk,
    score,
  };
}

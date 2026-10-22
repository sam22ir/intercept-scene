// Fleet command, hook 6: scenarios and how a run is judged. Pure.
//   SCENARIOS            { escort, defend } -> { name, duration (s), text }
//   LEVELS               the duel's levels, reused (the enemy's decisions and aim)
//   scoreOf(sim)         -> { status: 'running' | 'won' | 'lost', reason }   called every step after FleetSim's own lose rules
//                        (a merchant sunk by us, every squadron ship sunk) have been checked.
//   debriefOf(sim)       -> { status, reason, time, losses [idx], shots, hits, merchantsSaved, merchantsLost, enemiesSunk }
import { LEVELS } from './duel.js';

export { LEVELS };
export const SCENARIOS = {
  escort: { name: 'Escort', duration: 300, text: 'Bring the merchants through; none may be lost.' },
  defend: { name: 'Defend', duration: 240, text: 'Beat off every raider and keep the squadron afloat.' },
};
const GRACE = 120; // s past the duration after which the run is decided by who is left

export function scoreOf(sim) {
  const sc = SCENARIOS[sim.scenario] ?? SCENARIOS.defend;
  const liveFoes = sim.ships.filter((s) => s.team === 1 && s.tSunk === null);
  const planned = sim.pending.some((w) => w.kind === 'enemy');
  if (sim.scenario === 'escort') {
    if (sim.merchantsLost > 0) return { status: 'lost', reason: 'merchant' };
    if (sim.t >= sc.duration && !liveFoes.length && !sim.pending.length) return { status: 'won', reason: 'escorted' };
  } else if (!liveFoes.length && !planned && sim.t > 5) return { status: 'won', reason: 'cleared' };
  if (sim.t >= sc.duration + GRACE) return { status: sim.squad.some((s) => s.tSunk === null) ? 'won' : 'lost', reason: 'time' };
  return { status: 'running', reason: '' };
}

export function debriefOf(sim) {
  const r = scoreOf(sim);
  const merchants = sim.ships.filter((s) => s.merchant);
  return {
    status: sim.winner === null ? r.status : sim.winner === 0 ? 'won' : 'lost',
    reason: sim.over ?? r.reason,
    time: sim.t,
    losses: sim.squad.filter((s) => s.tSunk !== null).map((s) => s.idx),
    shots: sim.squad.reduce((n, s) => n + s.stats.shells, 0),
    hits: sim.squad.reduce((n, s) => n + s.stats.hits, 0),
    merchantsSaved: merchants.filter((s) => s.tSunk === null).length,
    merchantsLost: sim.merchantsLost,
    enemiesSunk: sim.ships.filter((s) => s.team === 1 && s.tSunk !== null).length,
  };
}

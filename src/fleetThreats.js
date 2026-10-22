// Fleet command, hook 2: what comes at the squadron. Pure.
//   planThreats(sim, rng) -> [{ t, kind, ... }]   sorted by t, like DuelSim.pending (kind 'enemy' | 'merchant' | 'ally' | your own).
//   spawnThreat(sim, w)   -> void   called when sim.t reaches w.t: add the ship(s) with sim.newShip(...) and push an 'arrive' event.
// `rng` is a stream of its own (the gunnery draws are never shifted); in spawnThreat use sim.rngW. The stub plans a few raiders
// (and, in the escort scenario, two merchants) from bearings off the squadron's centroid.
const rad = (d) => (d * Math.PI) / 180;
const LEVEL_RAIDERS = { easy: 1, normal: 2, hard: 3 };

export function planThreats(sim, rng) {
  const list = [];
  const raiders = LEVEL_RAIDERS[sim.level] ?? 2;
  for (let i = 0; i < raiders; i++) list.push({ t: 25 + i * 60 + Math.floor(rng() * 10), kind: 'enemy', brg: rad(-60 + rng() * 120) });
  if (sim.scenario === 'escort') for (let i = 0; i < 2; i++) list.push({ t: 10 + i * 40, kind: 'merchant', brg: rad(90) * (i ? -1 : 1) });
  return list.sort((a, b) => a.t - b.t);
}

export function spawnThreat(sim, w) {
  const c = sim.centroid(), r = sim.rngW;
  const brg = (w.brg ?? 0) + (r() - 0.5) * 0.1;
  const range = 4800;
  const x = c.x + Math.cos(brg) * range, z = c.z + Math.sin(brg) * range;
  const back = Math.atan2(c.z - z, c.x - x);
  let s;
  if (w.kind === 'merchant') s = sim.newShip(x, z, back, 2, 'merchant');
  else {
    s = sim.newShip(x, z, back + (r() - 0.5) * 0.2, 1, 'frigate');
    s.ai = sim.makeAi(sim.level);
  }
  sim.events.push({ type: 'arrive', ship: s.idx, kind: w.kind, range });
}

// Fleet command, hook 5: what the player is told. Pure and read-only (never mutates the sim).
//   contactsFor(sim, t) -> [{ idx, team, kind, x, z, psi, u, conf }]   radar contacts at time t; conf 0..1 grows as a contact closes
//                          or is held (a real version fades them in by range and time). The stub shows every living hostile or
//                          neutral ship at once with conf 1.
//   alertsOf(sim)       -> [{ ship, type, text }]   standing alerts: 'missile' (launch), 'flooding', 'fire', 'formation' (out of station).
export function contactsFor(sim, t) {
  return sim.ships
    .filter((s) => s.team !== 0 && s.tSunk === null)
    .map((s) => ({ idx: s.idx, team: s.team, kind: s.kind, x: s.x, z: s.z, psi: s.psi, u: s.u, conf: 1 }));
}

export function alertsOf(sim) {
  const out = [];
  for (const s of sim.squad) {
    if (s.tSunk !== null) continue;
    if (s.flood > 0.05) out.push({ ship: s.idx, type: 'flooding', text: `Ship ${s.idx + 1} flooding` });
    if (Object.values(s.fire).some((f) => f > 0)) out.push({ ship: s.idx, type: 'fire', text: `Ship ${s.idx + 1} on fire` });
  }
  return out;
}

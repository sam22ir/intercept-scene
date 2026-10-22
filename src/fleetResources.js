// Fleet command, hook 3: the things a ship runs out of. Pure.
//   stepResources(sim, dt) -> void   called once per fixed step after the physics: per-ship ammo and missile stocks, crew transfer
//   between ships, fuel (ship.fuel, 0..1). Mutate ships through the sim; never read a clock other than sim.t.
// The stub burns no fuel and moves no crews: every ship keeps what it was built with.
export function stepResources(sim, dt) {
  for (const s of sim.ships) if (s.fuel === undefined) s.fuel = 1;
}

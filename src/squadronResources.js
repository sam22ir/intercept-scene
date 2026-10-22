// Squadron orders, hook 3: the things a ship runs out of. Pure.
//   stepResources(sim, dt) -> void   called once per fixed step after the physics: fuel (squadron ships, 0..1), the speed
//   cap and drift that go with it, and the arrival of crews transferred between ships.
//   transferCrew(sim, fromIdx, toIdx) -> bool   a free repair crew leaves one squadron ship for another (within CREW_RANGE, takes TRANSIT_S)
//   resupply(sim, idx) -> bool                 a squadron ship within RESUPPLY_RANGE of a supply ship refills its guns (to its role's
//                                              full stock, as applyRole sets it) and fuel
//   stocksOf(ship) -> { he, ap, missiles, crews, fuel }   what the UI shows
// Ammo lives on the duel's own ship (s.gun.stock, AMMO_STOCK); this module only refills it. Transit is kept on the receiving
// ship (`inbound`, the seconds left per crew), so a rewind (a fresh ship set) clears it with the rest of the state.
// Deterministic: no clock other than the step's dt, no randomness.
import { AMMO_STOCK, TELEGRAPH, KT } from './duel.js';
import { ROLES } from './squadronRoles.js';

export const FUEL_KN = 12; // the speed the endurance is quoted at
export const FUEL_ENDURANCE = 40 * 60; // s at FUEL_KN from full to empty
export const LOW_FUEL = 0.15; // below this fuel the engine room is limited
export const DRIFT_TAU = 60; // s for the way to fall to a tenth of itself once the tanks are dry
export const CREW_RANGE = 600; // m between the two ships of a crew transfer
export const TRANSIT_S = 20; // s a transferred crew takes to come aboard
export const RESUPPLY_RANGE = 300; // m from a supply ship

const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const alive = (s) => s && s.tSunk === null;
// The stock a ship was built with: the duel's AMMO_STOCK scaled by its role (applyRole rounds the same way).
const fullStock = (s) => {
  const f = ROLES[s.role]?.stock ?? 1;
  return { he: Math.round(AMMO_STOCK.he * f), ap: Math.round(AMMO_STOCK.ap * f) };
};

export function stepResources(sim, dt) {
  for (const s of sim.ships) if (s.fuel === undefined) s.fuel = 1;
  for (const s of sim.squad) {
    if (!alive(s)) continue;
    // Crews in transit come aboard once their time is up.
    if (s.inbound?.length) {
      for (const e of s.inbound) e.eta -= dt;
      const arrived = s.inbound.filter((e) => e.eta <= 0).length;
      s.inbound = s.inbound.filter((e) => e.eta > 0);
      for (let k = 0; k < arrived; k++) s.crews.push({ to: null, eta: 0 });
    }
    // Fuel burns with speed: FUEL_ENDURANCE seconds at FUEL_KN, nothing while stopped.
    if (s.fuel > 0) {
      const kn = Math.abs(s.u) / KT;
      s.fuel = Math.max(0, s.fuel - (dt * kn) / (FUEL_KN * FUEL_ENDURANCE));
    }
    // Low fuel caps the speed (the same shape as the engine room's cap); dry tanks let her drift to a stop.
    if (s.fuel <= 0) {
      s.u *= Math.exp(-dt / DRIFT_TAU);
      if (Math.abs(s.u) < 0.01) s.u = 0;
    } else if (s.fuel < LOW_FUEL) {
      const cap = TELEGRAPH[4].kn * KT * (0.35 + (0.65 * s.fuel) / LOW_FUEL);
      if (s.u > cap) s.u = cap;
    }
  }
}

// Move one free crew from a squadron ship to another. Refused unless both ships are afloat and in squadron, they are within
// CREW_RANGE, the sender has a crew to spare (it keeps at least one) and that crew is not on a compartment.
export function transferCrew(sim, fromIdx, toIdx) {
  const from = sim.ships[fromIdx];
  const to = sim.ships[toIdx];
  if (!alive(from) || !alive(to) || from === to) return false;
  if (!sim.squad.includes(from) || !sim.squad.includes(to)) return false;
  if (dist(from, to) > CREW_RANGE) return false;
  if (from.crews.length < 2) return false;
  const k = from.crews.findIndex((c) => c.to === null);
  if (k < 0) return false;
  from.crews.splice(k, 1);
  (to.inbound ??= []).push({ eta: TRANSIT_S });
  return true;
}

// Refill a squadron ship's guns and fuel from a supply ship (s.supply true) within RESUPPLY_RANGE.
export function resupply(sim, idx) {
  const s = sim.ships[idx];
  if (!alive(s) || !sim.squad.includes(s)) return false;
  const depot = sim.ships.find((d) => d !== s && d.supply && alive(d) && dist(d, s) <= RESUPPLY_RANGE);
  if (!depot) return false;
  s.gun.stock = fullStock(s);
  s.gun.ammo = s.gun.stock.he + s.gun.stock.ap;
  s.fuel = 1;
  return true;
}

export function stocksOf(ship) {
  return {
    he: ship.gun.stock.he,
    ap: ship.gun.stock.ap,
    missiles: ship.missiles ?? 0,
    crews: ship.crews.length, // aboard; crews still in transit are in `inbound`
    fuel: ship.fuel ?? 1,
  };
}

// Squadron resources (src/squadronResources.js): fuel and its speed cap, crew transfers, resupply, stocks, determinism. Runs in Node.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SquadronSim, DT } from '../src/squadron.js';
import { KT, TELEGRAPH, CREWS, AMMO_STOCK } from '../src/duel.js';
import { ROLES } from '../src/squadronRoles.js';
import {
  stepResources, transferCrew, resupply, stocksOf, FUEL_ENDURANCE, LOW_FUEL, CREW_RANGE, TRANSIT_S, RESUPPLY_RANGE,
} from '../src/squadronResources.js';

const FULL_KN = TELEGRAPH[4].kn;

describe('fuel', () => {
  it('starts full and drains with speed: about 40 minutes at 12 kn', () => {
    const sim = new SquadronSim({ seed: 1 });
    const s = sim.squad[0];
    s.u = 12 * KT;
    for (let i = 0; i < 1200; i++) stepResources(sim, 1); // 20 minutes
    assert.ok(Math.abs(s.fuel - 0.5) < 1e-9, `half fuel after 20 min at 12 kn, got ${s.fuel}`);
    assert.equal(sim.ships[0].fuel, s.fuel);
    assert.ok(FUEL_ENDURANCE === 2400);
  });

  it('burns nothing while stopped', () => {
    const sim = new SquadronSim({ seed: 1 });
    const s = sim.squad[1];
    s.u = 0;
    for (let i = 0; i < 600; i++) stepResources(sim, 1);
    assert.equal(s.fuel, 1);
  });

  it('caps the speed once low, and leaves it alone above the low mark', () => {
    const sim = new SquadronSim({ seed: 1 });
    const s = sim.squad[0];
    s.fuel = LOW_FUEL / 2;
    s.u = FULL_KN * KT;
    stepResources(sim, 0.01);
    const cap = FULL_KN * KT * (0.35 + 0.65 * 0.5);
    assert.ok(s.u <= cap + 1e-9, `speed ${s.u} above the low-fuel cap ${cap}`);
    assert.ok(s.u > 0.5 * cap, 'still making way');

    const t = new SquadronSim({ seed: 1 });
    t.squad[0].fuel = 0.5;
    t.squad[0].u = FULL_KN * KT;
    stepResources(t, 0.01);
    assert.equal(t.squad[0].u, FULL_KN * KT);
  });

  it('drifts to a stop when the tanks are dry', () => {
    const sim = new SquadronSim({ seed: 1 });
    const s = sim.squad[0];
    s.fuel = 0;
    s.u = FULL_KN * KT;
    let last = s.u;
    for (let i = 0; i < 300; i++) {
      stepResources(sim, 1);
      assert.ok(s.u <= last, 'never speeds up');
      last = s.u;
    }
    assert.ok(s.u < 0.01 * FULL_KN * KT, `nearly stopped after 5 min, u=${s.u}`);
    assert.equal(s.fuel, 0);
  });

  it('only squadron ships burn fuel; threats keep the full tank', () => {
    const sim = new SquadronSim({ seed: 1 });
    const threat = sim.newShip(-3000, 0, 0, 1);
    threat.u = 12 * KT;
    for (let i = 0; i < 100; i++) stepResources(sim, 1);
    assert.equal(threat.fuel, 1);
  });
});

describe('crew transfer', () => {
  it('moves a free crew between ships in range, and it takes transit time to come aboard', () => {
    const sim = new SquadronSim({ seed: 2 });
    const [a, b] = sim.squad;
    assert.ok(Math.hypot(a.x - b.x, a.z - b.z) <= CREW_RANGE);
    assert.equal(a.crews.length, CREWS);
    assert.equal(transferCrew(sim, 0, 1), true);
    assert.equal(a.crews.length, CREWS - 1, 'the crew has left the sender');
    assert.equal(b.crews.length, CREWS, 'not aboard yet');
    stepResources(sim, TRANSIT_S / 2);
    assert.equal(b.crews.length, CREWS, 'still in transit');
    stepResources(sim, TRANSIT_S);
    assert.equal(b.crews.length, CREWS + 1, 'aboard after the transit time');
    assert.equal(b.inbound.length, 0);
  });

  it('is refused out of range, from a sunk ship, with one crew left, or with no free crew', () => {
    const sim = new SquadronSim({ seed: 3 });
    sim.squad[2].x = -5000;
    assert.equal(transferCrew(sim, 0, 2), false, 'out of range');
    sim.squad[1].tSunk = 5;
    assert.equal(transferCrew(sim, 0, 1), false, 'sunk receiver');
    sim.squad[1].tSunk = null;
    sim.squad[0].crews = [{ to: null, eta: 0 }];
    assert.equal(transferCrew(sim, 0, 1), false, 'never takes a ship to zero');
    sim.squad[0].crews = [{ to: 'gun', eta: 0 }, { to: 'bridge', eta: 0 }, { to: 'engine', eta: 0 }];
    assert.equal(transferCrew(sim, 0, 1), false, 'no free crew');
    assert.equal(transferCrew(sim, 0, 0), false, 'not to itself');
  });
});

describe('resupply and stocks', () => {
  it('reports the stocks the duel starts with', () => {
    const sim = new SquadronSim({ seed: 4 });
    const s = sim.squad[0];
    const st = stocksOf(s);
    assert.deepEqual(st, { he: s.gun.stock.he, ap: s.gun.stock.ap, missiles: 0, crews: CREWS, fuel: 1 });
    assert.ok(s.gun.stock.he > 0 && s.gun.stock.ap > 0);
  });

  it('refills guns and fuel from a supply ship within range only', () => {
    const sim = new SquadronSim({ seed: 5 });
    const s = sim.squad[0];
    const full = { he: Math.round(AMMO_STOCK.he * ROLES[s.role].stock), ap: Math.round(AMMO_STOCK.ap * ROLES[s.role].stock) };
    s.gun.stock = { he: 3, ap: 1 };
    s.fuel = 0.4;
    const depot = sim.newShip(s.x + 200, s.z, 0, 0);
    depot.supply = true;
    assert.equal(resupply(sim, 0), true);
    assert.deepEqual(stocksOf(s), { he: full.he, ap: full.ap, missiles: 0, crews: CREWS, fuel: 1 });
    depot.x = s.x + RESUPPLY_RANGE + 50;
    s.gun.stock = { he: 3, ap: 1 };
    assert.equal(resupply(sim, 0), false);
    assert.equal(s.gun.stock.he, 3);
  });
});

describe('determinism', () => {
  it('the same seed and the same transfers give the same resource state, bit for bit', () => {
    const play = () => {
      const sim = new SquadronSim({ seed: 9 });
      for (let i = 0; i < 4000; i++) {
        if (i === 500) transferCrew(sim, 0, 1);
        if (i === 900) sim.squad[1].fuel = 0.1;
        sim.step(DT);
      }
      return JSON.stringify(sim.squad.map((s) => [s.fuel, s.u, s.x, s.z, s.crews.length, s.inbound ?? []]));
    };
    assert.equal(play(), play());
  });
});

// The traffic of the port of Zabana (src/harbourTraffic.js, stepped by HarbourSim): the computer's ships keep clear of the land and
// of the ships alongside, keep the speed limits, give way to outbound ships, never cross in the fishing pass, stop for the player's
// ship, and a contact with one of them is scored like a quay; the tugs and the pilot boat answer her.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { HarbourSim, STATIC_SOLIDS, PASS_AREA, KT, TUGS, px, toChart, inPoly, boxCorners, speedZone, gateSide } from '../src/harbour.js';
import { VESSEL_TYPES } from '../src/harbourTraffic.js';
import { setSpeed } from './harbourPilot.mjs';

// The traffic alone: the player's ship parked far out at sea, out of everyone's way.
function alone(route, seconds, each) {
  const sim = new HarbourSim({ route });
  Object.assign(sim, px(1400, 1500), { u: 0 });
  setSpeed(sim, 0);
  for (let i = 0; i < seconds * 120; i++) {
    sim.t += 1 / 120;
    sim.traffic.step(1 / 120, sim);
    if (i % 30 === 0) each?.(sim);
  }
  return sim;
}

describe('the traffic', () => {
  it('has fishing boats, yachts, ships at anchor, the tugs and the pilot boat, and ships under way', () => {
    const sim = new HarbourSim({ route: 'B' });
    const types = new Set(sim.traffic.vessels.map((v) => v.type));
    for (const t of ['tug', 'pilot', 'trawler', 'yacht', 'coaster', 'cargo', 'tanker']) assert.ok(types.has(t), t);
    assert.equal(sim.traffic.vessels.filter((v) => v.role === 'tug').length, 2);
    assert.equal(VESSEL_TYPES.tug.L, 30);
  });
  for (const route of 'ABCDEFGH') {
    it(`${route}: in twenty minutes no ship of the traffic touches the land, a quay or a ship alongside, or speeds`, () => {
      const bad = [];
      const passOccupancy = [];
      alone(route, 1200, (sim) => {
        const solids = [...STATIC_SOLIDS, ...sim.moored];
        let inPass = 0;
        for (const v of sim.traffic.vessels) {
          if (!sim.traffic.visible(v) || v.mode === 'fast') continue;
          const pts = boxCorners({ x: v.x, z: v.z, psi: v.psi, len: v.L * 0.92, beam: v.B * 0.92 });
          if (pts.some((p) => solids.some((s) => inPoly(s, p.x, p.z)))) bad.push(`${v.id} aground at ${toChart(v.x, v.z).map(Math.round)} t ${sim.t.toFixed(0)}`);
          const lim = speedZone(v.x, v.z).kn;
          if (Math.abs(v.u) / KT > lim + 0.5) bad.push(`${v.id} at ${(Math.abs(v.u) / KT).toFixed(1)} kn where the limit is ${lim}`);
          if (v.state === 'run' && inPoly(PASS_AREA, v.x, v.z)) inPass++;
        }
        passOccupancy.push(inPass);
      });
      assert.deepEqual([...new Set(bad)].slice(0, 5), []);
      assert.ok(Math.max(...passOccupancy) <= 1, 'never two boats in the fishing pass at once');
    });
  }
  it('an inbound ship holds outside the entrance while an outbound one is in the passage, and the entrance lights show red', () => {
    // F: the player sails from berth 6 while a coaster comes in from sea
    const sim = new HarbourSim({ route: 'F' });
    const inbound = sim.traffic.get('inbound');
    sim.vhfKey();
    sim.lineKey();
    assert.equal(sim.outbound, true);
    let held = false;
    for (let i = 0; i < 700 * 120; i++) {
      sim.step(1 / 120, { slide: sim.t < 60 ? 1 : 0 });
      if (inbound.holding) held = true;
    }
    assert.ok(held, `the coaster held (it is at ${toChart(inbound.x, inbound.z).map(Math.round)})`);
    assert.ok(gateSide(inbound.x, inbound.z) < 0, 'outside the entrance');
    assert.equal(sim.traffic.outboundInPassage(sim, inbound), true, 'for her');
    // the coaster leaving berth 3 turns the lights red for the player coming in
    const b = new HarbourSim({ route: 'B' });
    for (let i = 0; i < 5 * 120; i++) { b.t += 1 / 120; b.traffic.step(1 / 120, b); }
    assert.equal(b.entryLight, 'red');
  });
  it('a ship of the traffic stops for the player\'s ship in her way, and a contact with her is scored', () => {
    const sim = new HarbourSim({ route: 'G' });
    const out = sim.traffic.get('cargoOut');
    // the player stopped across the outbound lane, just south of the entrance
    Object.assign(sim, px(562, 540), { psi: Math.PI / 2, u: 0, vhf: true, pilotAboard: true, hour0: 0 }); // high water: no stream to set her clear
    sim.side = gateSide(sim.x, sim.z);
    setSpeed(sim, 0);
    for (let i = 0; i < 200 * 120; i++) sim.step(1 / 120, {});
    assert.equal(out.blockedBy, 'player');
    assert.ok(Math.abs(out.u) < 0.1, 'she has stopped');
    assert.ok(sim.violations.some((v) => v.key === 'priority'), 'and the player is told to clear her way');
    // ram her
    const ram = new HarbourSim({ route: 'A' });
    const anchored = ram.traffic.get('anchor2');
    Object.assign(ram, { x: anchored.x - 150, z: anchored.z, psi: 0, u: 5 * KT, stage: 'berth', stageIdx: 2 });
    setSpeed(ram, 5);
    for (let i = 0; i < 60 * 120 && !ram.contacts.crash && !ram.contacts.hard; i++) ram.step(1 / 120, {});
    assert.ok(ram.contacts.hard + ram.contacts.crash >= 1, JSON.stringify(ram.contacts));
    assert.ok(ram.damage > 0);
  });
  it('the tugs come out from berth 2 and make fast; the pilot boat comes alongside and puts the pilot aboard', () => {
    const sim = new HarbourSim({ route: 'A', traffic: false });
    sim.vhfKey();
    const pb = sim.traffic.get('pilot');
    assert.equal(pb.mode, 'loiter');
    // into the pilot station at 6 knots
    Object.assign(sim, px(575, 870), { psi: 0, u: 6 * KT });
    setSpeed(sim, 5);
    for (let i = 0; i < 120 * 120 && !sim.pilotAboard; i++) sim.step(1 / 120, {});
    assert.equal(sim.pilotAboard, true);
    sim.tugKey();
    assert.equal(sim.tugs, 'called');
    const tugA = sim.traffic.get('tugA');
    assert.equal(tugA.mode, 'toShip');
    for (let i = 0; i < 500 * 120 && sim.tugs !== 'fast'; i++) sim.step(1 / 120, { wheel: Math.max(-1, Math.min(1, -sim.psi * 3)) });
    assert.equal(sim.tugs, 'fast');
    assert.ok(Math.abs(sim.u) / KT <= 6.2, 'they make fast at 6 knots or less');
    sim.tugKey();
    assert.equal(sim.tugs, 'released');
    assert.equal(tugA.mode, 'home');
    assert.ok(TUGS.part === 8);
  });
});

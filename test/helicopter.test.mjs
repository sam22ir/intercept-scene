import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { HeliFlight, PAD, HOLD_ALT, LAND_STEADY, LIFT_STEADY } from '../src/heliFlight.js';
import { HelmSim, DT } from '../src/helm.js';

const run = (h, secs, steady, dt = 0.05) => { for (let t = 0; t < secs; t += dt) h.step(dt, steady); };
const onDeck = (h) => h.state.y === PAD.y && h.state.x === PAD.x && h.state.z === PAD.z;

describe('the deck helicopter', () => {
  it('flies a circuit and lands again on a steady course, never jumping', () => {
    const h = new HeliFlight(7);
    assert.ok(onDeck(h));
    let prev = { ...h.state };
    let flights = 0;
    let was = false;
    let maxH = 0;
    for (let t = 0; t < 1500; t += 0.05) {
      h.step(0.05, true);
      const s = h.state;
      assert.ok(Math.hypot(s.x - prev.x, s.y - prev.y, s.z - prev.z) < 3, `no jump at ${t.toFixed(1)} s`);
      assert.ok(s.y >= PAD.y - 1e-9, 'never below the pad');
      if (s.flying && !was) flights += 1;
      was = s.flying;
      maxH = Math.max(maxH, s.y - PAD.y);
      prev = { ...s };
    }
    assert.ok(flights >= 4, 'it flies now and then');
    assert.ok(maxH > 20, 'it climbs well clear of the deck');
  });
  it('leaves straight ahead, clear of the mast, and comes back in over the stern', () => {
    const h = new HeliFlight(9);
    for (let t = 0; t < 400 && h.phase !== 'circuit'; t += 0.05) h.step(0.05, true);
    assert.equal(h.phase, 'circuit');
    const lane = h.circuit.D;
    let maxX = -Infinity;
    let prevX = h.state.x;
    let early = true;
    let lateral = 0;
    let comeIn = [];
    while (h.phase === 'circuit') {
      h.step(0.05, true);
      const s = h.state;
      if (early && h.u < 0.12) assert.ok(s.x >= prevX - 0.2, 'the first part of the flight is forward, never sideways or back');
      else early = false;
      prevX = s.x;
      maxX = Math.max(maxX, s.x - PAD.x);
      if (s.x - PAD.x > -40 && s.x - PAD.x < 100) lateral = Math.max(lateral, Math.abs(s.z - PAD.z)); // abeam the superstructure
      if (h.u > 0.93) comeIn.push(s.x - PAD.x);
    }
    assert.ok(maxX > 150, 'it turns well ahead of the bow');
    assert.ok(lateral >= 14 && lateral <= lane + 0.5, 'abeam the ship it keeps to a lane, not over the mast');
    assert.ok(comeIn.length > 1 && comeIn[comeIn.length - 1] > comeIn[0], 'it comes in over the stern, flying ahead');
  });
  it('never takes off while the ship is turning, even with its rotor ready', () => {
    const h = new HeliFlight(3);
    run(h, 400, false);
    assert.ok(onDeck(h) && h.phase === 'parked', 'parked: the wait only counts on a steady course');
    run(h, 300, true); // steady long enough to spin up, then she turns before it lifts
    const h2 = new HeliFlight(3);
    for (let t = 0; t < 400 && h2.phase !== 'ready'; t += 0.05) h2.step(0.05, true);
    assert.equal(h2.phase, 'ready');
    run(h2, 120, false);
    assert.ok(onDeck(h2) && h2.rpm === 1, 'rotor turning, still on the deck, waiting for a steady course');
    run(h2, LIFT_STEADY + 1, true);
    assert.ok(h2.state.flying, 'steady again: it lifts');
  });
  it('does not land while she turns: it holds its hover over the pad, and lands once she is steady', () => {
    const h = new HeliFlight(11);
    for (let t = 0; t < 800 && h.phase !== 'hold'; t += 0.05) h.step(0.05, true);
    assert.equal(h.phase, 'hold');
    h.steadyFor = 0;
    run(h, 90, false);
    assert.equal(h.phase, 'hold');
    assert.ok(Math.abs(h.state.y - PAD.y - HOLD_ALT) < 1.6, 'waiting at its height above the pad');
    let yawMin = Infinity;
    let yawMax = -Infinity;
    for (let i = 0; i < 400; i++) { h.step(0.05, false); yawMin = Math.min(yawMin, h.state.yaw); yawMax = Math.max(yawMax, h.state.yaw); }
    assert.ok(yawMax - yawMin > 0.08, 'its heading wanders: a hover is never rigid');
    assert.ok(Math.abs(h.state.x - PAD.x) < 8 && Math.abs(h.state.z - PAD.z) < 8, 'over the pad, drifting a little');
    run(h, LAND_STEADY + 0.5, true);
    assert.equal(h.phase, 'descend');
    run(h, 30, true);
    assert.ok(onDeck(h), 'landed');
  });
  it('waves off a landing that she turns into: it climbs back to the hover', () => {
    const h = new HeliFlight(11);
    for (let t = 0; t < 800 && h.phase !== 'descend'; t += 0.05) h.step(0.05, true);
    run(h, 3, true);
    assert.ok(h.state.y > PAD.y + 1 && h.phase === 'descend');
    h.step(0.05, false);
    assert.equal(h.phase, 'waveoff');
    run(h, 6, false);
    assert.equal(h.phase, 'hold');
    assert.ok(h.state.y - PAD.y > HOLD_ALT - 1.6, 'back at the waiting height');
  });
  it('is driven by the sim: it lifts off only when the rudder is amidships', () => {
    const sim = new HelmSim();
    sim.nextSpawn = Infinity;
    const hard = { left: 0, right: 1, gun: 0 };
    for (let t = 0; t < 300; t += DT) sim.step(DT, hard); // hard over for five minutes
    assert.ok(onDeck(sim.heli) && sim.heli.phase === 'parked', 'turning the whole time: it stays parked');
    let started = false;
    for (let t = 0; t < 400; t += DT) { sim.step(DT, { left: 0, right: 0, gun: 0 }); started = started || sim.heli.phase !== 'parked'; }
    assert.ok(started, 'steady: it starts');
  });
  it('the player can ask it to take off at once (on a steady course) and to land', () => {
    const h = new HeliFlight(5);
    assert.equal(h.action, 'takeoff');
    run(h, 2, true);
    h.request();
    run(h, LIFT_STEADY + 6 + 5 + 1, true); // the steady wait, the spin-up and the lift
    assert.ok(h.state.flying, 'it is airborne long before its random wait would be over');
    assert.equal(h.action, 'land');
    h.request();
    assert.equal(h.action, null, 'a landing is under way');
    run(h, 80, true);
    assert.ok(onDeck(h), 'landed, the circuit cut short');
    assert.equal(h.action, 'takeoff');
  });
  it('a take-off request still waits for a steady course, and landing while the rotor is only turning shuts it down', () => {
    const h = new HeliFlight(5);
    h.request();
    run(h, 120, false);
    assert.ok(onDeck(h) && h.phase === 'parked', 'she is turning: it does not start');
    for (let t = 0; t < 30 && h.phase !== 'spinup'; t += 0.05) h.step(0.05, true);
    assert.equal(h.phase, 'spinup');
    assert.equal(h.action, 'land');
    h.request();
    assert.equal(h.phase, 'spindown');
    run(h, 12, true);
    assert.equal(h.phase, 'parked');
  });
});

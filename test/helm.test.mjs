// The Solo Air Defense mission's model (src/helm.js): the ship answers the wheel and the telegraph like a ship, a drone
// left alone escalates from detection to circling, low passes and a strike, and the missile kills it.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  HelmSim, TELEGRAPH, START_ORDER, KT, RUDDER_MAX, RADAR_RANGE, CELLS, ARC, relName, compass,
} from '../src/helm.js';

const run = (sim, seconds, input = {}) => { for (let i = 0; i < seconds * 10; i++) sim.advance(0.1, input); };
const events = (sim) => sim.takeEvents();

describe('the ship', () => {
  it('starts at half ahead, on 000, and holds her course with the wheel amidships', () => {
    const sim = new HelmSim();
    sim.nextSpawn = Infinity;
    assert.equal(sim.order, START_ORDER);
    run(sim, 60);
    assert.ok(Math.abs(sim.knots - TELEGRAPH[START_ORDER].kn) < 0.05, `${sim.knots} kn`);
    assert.equal(Math.round(sim.headingDeg), 0);
    assert.ok(sim.x > 400 && Math.abs(sim.z) < 1e-6, 'she runs north');
  });

  it('puts the rudder over while the key is held, and eases it back when it is let go', () => {
    const sim = new HelmSim();
    sim.nextSpawn = Infinity;
    run(sim, 3, { right: 1 });
    assert.ok(sim.rudder > 0.25 && sim.rudder < RUDDER_MAX, `rudder ${sim.rudder}`);
    run(sim, 10, { right: 1 });
    assert.ok(Math.abs(sim.rudder - RUDDER_MAX) < 1e-9, 'full rudder at 35 degrees');
    run(sim, 8);
    assert.ok(Math.abs(sim.rudder) < 1e-9, 'amidships again');
  });

  it('turns to starboard on right rudder, slowly at first, with a tactical diameter of a few ship lengths', () => {
    const sim = new HelmSim();
    sim.nextSpawn = Infinity;
    run(sim, 2, { right: 1 });
    assert.ok(sim.rateOfTurn > 0 && sim.rateOfTurn < 40, `the swing builds up: ${sim.rateOfTurn} deg/min`);
    const start = { x: sim.x, z: sim.z };
    let maxZ = 0;
    for (let i = 0; i < 2400 && sim.headingDeg < 180; i++) { sim.advance(0.1, { right: 1 }); maxZ = Math.max(maxZ, sim.z - start.z); }
    assert.ok(sim.headingDeg >= 179, 'she comes round');
    assert.ok(maxZ > 300 && maxZ < 700, `tactical diameter ${maxZ.toFixed(0)} m`);
    assert.ok(sim.knots < TELEGRAPH[START_ORDER].kn - 1, 'she loses speed in the hard turn');
    assert.ok(sim.heel < 0, 'she heels outward (port side down) turning to starboard');
  });

  it('answers the telegraph over half a minute, one step at a time, and stops', () => {
    const sim = new HelmSim();
    sim.nextSpawn = Infinity;
    sim.telegraph(+1);
    sim.telegraph(+1);
    assert.equal(TELEGRAPH[sim.order].name, 'Flank');
    sim.telegraph(+1);
    assert.equal(TELEGRAPH[sim.order].name, 'Flank', 'no step past flank');
    run(sim, 10);
    assert.ok(sim.knots > 16.5 && sim.knots < 26, `working up: ${sim.knots} kn`);
    run(sim, 150);
    assert.ok(Math.abs(sim.knots - 28) < 0.3);
    for (let i = 0; i < 5; i++) sim.telegraph(-1);
    assert.equal(TELEGRAPH[sim.order].kn, 0);
    run(sim, 300);
    assert.ok(Math.abs(sim.u) < 0.3 * KT, `stopped: ${sim.knots} kn`);
  });
});

describe('a drone left alone', () => {
  it('is detected, closes, circles, makes closer and closer low passes, then dives into the ship', () => {
    const sim = new HelmSim({ seed: 3 });
    const seen = [];
    let passes = [];
    let firstRange = null;
    for (let i = 0; i < 6000 && !seen.includes('struck'); i++) {
      sim.advance(0.1, {});
      for (const e of events(sim)) {
        if (e.type === 'alarm') seen.push(`alarm${e.level}`);
        if (e.type === 'struck') seen.push('struck');
        if (e.type === 'pass') passes.push(sim.rangeTo(e.pos));
      }
      const d = sim.drones[0];
      if (d && d.detected && firstRange === null) firstRange = sim.rangeTo(d.pos);
      if (d && !seen.includes(d.phase)) seen.push(d.phase);
    }
    assert.ok(firstRange !== null && firstRange <= RADAR_RANGE && firstRange > RADAR_RANGE - 100, `detected at ${firstRange}`);
    for (const s of ['inbound', 'alarm1', 'circle', 'alarm2', 'pass', 'extend', 'attack', 'alarm3', 'struck']) assert.ok(seen.includes(s), `${s} in ${seen}`);
    assert.ok(passes.length >= 3, `${passes.length} passes`);
    assert.equal(sim.strikes, 1);
    assert.ok(sim.t < 330, `strike after ${sim.t.toFixed(0)} s`);
  });

  it('three strikes put the ship out of action; she stops and reset sails again', () => {
    const sim = new HelmSim({ seed: 5 });
    for (let i = 0; i < 30000 && !sim.out; i++) sim.advance(0.1, {});
    assert.ok(sim.out);
    assert.equal(sim.strikes, 3);
    run(sim, 200);
    assert.ok(sim.knots < 0.5);
    sim.reset();
    assert.equal(sim.out, false);
    assert.equal(sim.strikes, 0);
    assert.equal(sim.cellsLeft, CELLS);
  });
});

describe('the missile', () => {
  it('shoots down a drone ahead, with one round', () => {
    const sim = new HelmSim();
    sim.nextSpawn = Infinity;
    const d = sim.spawn({ bearing: 0.3, range: 3000, alt: 150 });
    run(sim, 0.5);
    assert.ok(d.detected);
    events(sim);
    sim.fire();
    assert.equal(sim.cellsLeft, CELLS - 1);
    let fired = false;
    for (let i = 0; i < 300 && d.alive; i++) {
      sim.advance(0.1, {});
      for (const e of events(sim)) if (e.type === 'fire') fired = true;
    }
    assert.ok(fired, 'the round left the launcher');
    assert.equal(d.alive, false);
    assert.equal(d.phase, 'down');
    assert.equal(sim.kills, 1);
    assert.ok(d.wreck && d.wreck.burstDist < 4.5, 'fuzed close to the drone');
  });

  it('will not engage a drone astern, too close, or out of range', () => {
    const sim = new HelmSim();
    sim.nextSpawn = Infinity;
    const astern = sim.spawn({ bearing: Math.PI, range: 2500, alt: 120 });
    run(sim, 0.2);
    sim.targetId = astern.id;
    assert.match(sim.engageable(astern), /arc/);
    sim.fire();
    assert.equal(sim.cellsLeft, CELLS, 'no round spent');
    astern.pos.set(sim.x + 100, 50, sim.z);
    assert.match(sim.engageable(astern), /close/);
    astern.pos.set(sim.x + 4900, 50, sim.z);
    assert.match(sim.engageable(astern), /range/);
    assert.ok(ARC > Math.PI / 2 && ARC < Math.PI, 'abeam is inside the arc, astern is not');
  });

  it('hits a drone on its low pass along the side', () => {
    const sim = new HelmSim({ seed: 3 });
    let d = null;
    for (let i = 0; i < 6000; i++) {
      sim.advance(0.1, {});
      d = sim.drones[0];
      if (d && d.phase === 'pass' && sim.rangeTo(d.pos) < 1200 && !sim.engageable(d)) break;
    }
    assert.equal(d.phase, 'pass');
    sim.fire();
    run(sim, 15);
    assert.equal(d.alive, false, `drone still flying, ${sim.rangeTo(d.pos)} m`);
    assert.equal(sim.kills, 1);
  });
});

describe('words', () => {
  it('names bearings the navy way', () => {
    assert.equal(relName(THREE.MathUtils.degToRad(45)), 'green 045');
    assert.equal(relName(THREE.MathUtils.degToRad(-90)), 'red 090');
    assert.equal(relName(0), 'right ahead');
    assert.equal(relName(Math.PI), 'right astern');
    assert.equal(Math.round(compass(-Math.PI / 2)), 270);
  });
});

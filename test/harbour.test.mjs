// The harbour mission's model (src/harbour.js): the port traced from the images is sound (the berths, the entrance and the
// fairway are clear water), the lines hold her, the thrusters work only at a crawl, contacts are scored by how hard they are,
// and a scripted pilot can take her out, round the buoy, bring her back in and lay her alongside berth 7.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  HarbourSim, LAND, BREAKWATER, SOLIDS, MOORED, INSIDE, GATE, FAIRWAY, START_BERTH, TARGET_BERTH, HULL_PTS, TELEGRAPH, STOP_ORDER, KT,
  SPEED_LIMIT, inPoly, clearance, gateSide, px, IMG, HALF_BEAM, FENDER, BERTH_TOL,
} from '../src/harbour.js';

const wrapPi = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const hullClear = (x, z, psi) => Math.min(...HULL_PTS.map(([a, b]) => clearance(x + a * Math.cos(psi) - b * Math.sin(psi), z + a * Math.sin(psi) + b * Math.cos(psi))));
const order = (sim, kn) => { sim.order = TELEGRAPH.findIndex((o) => o.kn === kn); };

// A pilot: steers for a point with the rudder (proportional on the bearing, damped by the turn rate) at a given telegraph order.
function steer(sim, x, z, gain = 2.2) {
  const want = Math.atan2(z - sim.z, x - sim.x);
  const err = wrapPi(want - sim.psi);
  return Math.max(-1, Math.min(1, err * gain - sim.r * 14));
}
function run(sim, seconds, inputOf) {
  for (let i = 0; i < seconds * 120; i++) sim.step(1 / 120, inputOf());
}

describe('the port, as traced', () => {
  it('converts the image at 1.107 m a pixel, north up', () => {
    assert.equal(IMG, 1.107);
    const a = px(1020, 475), b = px(1120, 375);
    assert.deepEqual([a.x, a.z], [0, 0]);
    assert.ok(Math.abs(b.x - 110.7) < 1e-9 && Math.abs(b.z - 110.7) < 1e-9, 'up the image is north (+x), right is east (+z)');
  });
  it('has an entrance about 200 m wide, facing the open sea to the east', () => {
    const w = Math.hypot(GATE.a.x - GATE.b.x, GATE.a.z - GATE.b.z);
    assert.ok(w > 170 && w < 230, `entrance ${w.toFixed(0)} m`);
    assert.ok(clearance((GATE.a.x + GATE.b.x) / 2, (GATE.a.z + GATE.b.z) / 2) > 80, 'the middle of the entrance is open water');
    assert.ok(gateSide(200, -400) > 0 && gateSide(-100, 600) < 0, 'the basin is inside the line, the fairway outside');
  });
  it('puts both berths in clear water alongside their quays, and the buoy well out', () => {
    for (const B of [START_BERTH, TARGET_BERTH]) {
      const c = hullClear(B.x, B.z, B.psi);
      assert.ok(c > 0.5 && c < 3, `${B.name}: ${c.toFixed(2)} m between her side and the nearest solid`);
    }
    assert.ok(clearance(FAIRWAY.x, FAIRWAY.z) > 300, 'the fairway buoy lies in open water');
    assert.ok(!inPoly(INSIDE, FAIRWAY.x, FAIRWAY.z), 'and outside the harbour');
  });
  it('keeps the ships alongside clear of each other and of the quays', () => {
    for (const m of MOORED) {
      assert.ok(!inPoly(LAND, m.x, m.z) && !inPoly(BREAKWATER, m.x, m.z), `${m.type} afloat`);
      for (const o of MOORED) if (o !== m) assert.ok(!inPoly(o, m.x, m.z), `${m.type} does not overlap a ${o.type}`);
    }
    assert.ok(SOLIDS.length >= 2 + MOORED.length);
  });
});

describe('the ship', () => {
  it('stays alongside while the lines are fast, whatever the engine does', () => {
    const sim = new HarbourSim();
    order(sim, 16);
    run(sim, 20, () => ({ wheel: 1, turn: 1, slide: 1 }));
    assert.equal(sim.x, START_BERTH.x);
    assert.equal(sim.z, START_BERTH.z);
    assert.equal(sim.stage, 'alongside');
  });
  it('lets go on L, and moves off sideways with both thrusters', () => {
    const sim = new HarbourSim();
    sim.lineKey();
    assert.equal(sim.stage, 'depart');
    assert.equal(sim.lines, false);
    const f = START_BERTH.face;
    run(sim, 40, () => ({ slide: -1 })); // to port: away from the pier
    const off = (sim.x - f.a.x) * f.n.x + (sim.z - f.a.z) * f.n.z;
    assert.ok(off > HALF_BEAM + FENDER + 12, `she is ${off.toFixed(1)} m off the quay`);
    assert.ok(Math.abs(wrapPi(sim.psi - START_BERTH.psi)) < 0.02, 'without turning');
    assert.equal(sim.contacts.touch + sim.contacts.hard + sim.contacts.crash, 0);
  });
  it('turns on the spot with the thrusters, but they do nothing at speed', () => {
    const a = new HarbourSim();
    a.lineKey();
    a.x += 30 * Math.cos(a.psi + Math.PI / 2) * -1; a.z += 30 * Math.sin(a.psi + Math.PI / 2) * -1; // well off the quay
    const psi0 = a.psi;
    run(a, 20, () => ({ turn: 1 }));
    assert.ok(wrapPi(a.psi - psi0) > 0.25, `turned ${(wrapPi(a.psi - psi0) * 57.3).toFixed(0)}°`);
    assert.ok(Math.hypot(a.u, a.v) < 0.05, 'standing still');
    const b = new HarbourSim();
    b.lines = false; b.stage = 'sea'; b.x = FAIRWAY.x + 600; b.z = FAIRWAY.z; b.u = 8 * KT; b.psi = 0;
    order(b, 10);
    run(b, 5, () => ({ turn: 1, slide: 1 }));
    assert.ok(Math.abs(b.r) < 1e-3 && Math.abs(b.v) < 1e-3, 'no effect at 8 knots');
  });
  it('carries her way: from 10 knots stopped, she runs on for hundreds of metres', () => {
    const sim = new HarbourSim();
    sim.lines = false; sim.stage = 'sea'; sim.x = 2000; sim.z = 2000; sim.psi = 0; sim.u = 10 * KT;
    order(sim, 0);
    run(sim, 30, () => ({}));
    assert.ok(sim.x - 2000 > 100, `ran on ${(sim.x - 2000).toFixed(0)} m in 30 s`);
    assert.ok(sim.u > 0 && sim.u < 10 * KT * 0.75, "and slowed down");
  });
});

describe('contacts', () => {
  const ram = (kn) => {
    const sim = new HarbourSim();
    sim.lines = false; sim.stage = 'berth';
    // abreast berth 7, heading straight at the quay
    const f = TARGET_BERTH.face;
    const d = kn < 1 ? 52 : 80; // her bow 3 m (or 31 m) off the quay
    sim.x = TARGET_BERTH.x + f.n.x * d; sim.z = TARGET_BERTH.z + f.n.z * d;
    sim.psi = Math.atan2(-f.n.z, -f.n.x);
    sim.u = kn * KT;
    order(sim, kn >= 3 ? 3 : 0);
    run(sim, 60, () => ({}));
    return sim;
  };
  it('a crawl into the quay is a touch, no damage', () => {
    const s = ram(0.4);
    assert.ok(s.contacts.touch >= 1 && s.contacts.hard === 0 && s.contacts.crash === 0, JSON.stringify(s.contacts));
    assert.equal(s.damage, 0);
    assert.ok(hullClear(s.x, s.z, s.psi) >= 0, 'and she never ends up inside the quay');
  });
  it('a collision at speed damages her, and enough of them hole her', () => {
    const s = ram(6);
    assert.ok(s.contacts.crash >= 1, JSON.stringify(s.contacts));
    assert.ok(s.damage > 20);
    const t = new HarbourSim();
    t.lines = false; t.stage = 'depart';
    for (let i = 0; i < 6; i++) t.contact(2.5);
    assert.equal(t.stage, 'wrecked');
    assert.equal(t.damage, 100);
  });
});

describe('the mission', () => {
  it('goes out, round the buoy, back in, and makes fast alongside berth 7', () => {
    const sim = new HarbourSim();
    const stages = [sim.stage];
    const note = () => { if (stages[stages.length - 1] !== sim.stage) stages.push(sim.stage); };
    sim.lineKey();
    note();
    run(sim, 45, () => ({ slide: -1 })); // off the quay
    // out: through the basin and the entrance at 6 knots, then to the buoy and round it
    const wps = [px(720, 300), px(960, 400), px(1030, 470), px(1250, 520), { x: FAIRWAY.x - 90, z: FAIRWAY.z - 160 }, { x: FAIRWAY.x + 160, z: FAIRWAY.z + 40 }];
    const back = [px(1300, 470), px(1030, 470), px(900, 330), px(780, 240)];
    let wp = 0, route = wps;
    for (let i = 0; i < 1500 * 120 && sim.stage !== 'berth'; i++) {
      const target = route[wp];
      if (Math.hypot(target.x - sim.x, target.z - sim.z) < 70) {
        if (wp < route.length - 1) wp++;
        else if (route === wps) { route = back; wp = 0; }
      }
      order(sim, sim.inside ? 6 : 10);
      sim.step(1 / 120, { wheel: steer(sim, route[wp].x, route[wp].z) });
      note();
    }
    assert.deepEqual(stages, ['alongside', 'depart', 'sea', 'return', 'berth']);
    assert.ok(sim.maxInside <= SPEED_LIMIT + 0.3, `fastest inside ${sim.maxInside.toFixed(1)} kn`);
    assert.equal(sim.contacts.hard + sim.contacts.crash, 0, JSON.stringify(sim.contacts));
    // the last few metres: lay her stopped and parallel just off berth 7, then the lines go on by themselves
    const f = TARGET_BERTH.face;
    Object.assign(sim, { x: TARGET_BERTH.x + f.n.x * 1, z: TARGET_BERTH.z + f.n.z * 1, psi: f.psi, u: 0, v: 0, r: 0 });
    order(sim, 0);
    assert.equal(sim.berthState().ok, true, sim.berthState().why);
    run(sim, BERTH_TOL.hold + 0.5, () => ({}));
    assert.equal(sim.stage, 'done');
    assert.equal(sim.lines, true);
    assert.ok(sim.result.stars >= 1 && sim.result.stars <= 3);
    assert.ok(sim.result.time > 60);
  });
  it('refuses to make fast while she is still moving or far off', () => {
    const sim = new HarbourSim();
    sim.lines = false; sim.stage = 'berth';
    sim.x = TARGET_BERTH.x + 150; sim.z = TARGET_BERTH.z;
    sim.lineKey();
    assert.equal(sim.stage, 'berth');
    const f = TARGET_BERTH.face;
    Object.assign(sim, { x: TARGET_BERTH.x, z: TARGET_BERTH.z, psi: f.psi, u: 1.5 * KT });
    assert.match(sim.berthState().why, /Stop her/);
  });
  it('warns once when she goes over the speed limit inside', () => {
    const sim = new HarbourSim();
    sim.lines = false; sim.stage = 'depart';
    Object.assign(sim, px(720, 300), { psi: 1.75, u: 9 * KT });
    order(sim, 10);
    run(sim, 6, () => ({}));
    const says = sim.takeEvents().filter((e) => e.type === 'say' && /limit/.test(e.text));
    assert.equal(says.length, 1);
    assert.ok(sim.overLimit > 3);
    assert.equal(STOP_ORDER, TELEGRAPH.findIndex((o) => o.kn === 0));
  });
});

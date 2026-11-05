// The harbour mission's model (src/harbour.js): the port of Zabana drawn from port-zabana.svg is sound (the berths, the channel and
// the entrance are clear water, the scales are the chart's), the depths and the tide are the chart's, the ships handle as they should,
// contacts and groundings are scored, the rules of the chart are enforced, and a scripted pilot (test/harbourPilot.mjs) sails each
// of the standard manoeuvres A to H to the end.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  HarbourSim, ROUTES, SHIPS, LAND, MOLES, STATIC_SOLIDS, FACES, RAMP, LOCK, TURN_CIRCLE, PASS, CHANNEL, GATE, PILOT_ZONE, ANCHORAGE, LIGHTS, BUOYS,
  KT, MPX, STOP_ORDER, TUGS, BERTH_TOL, CHECKLIST, BERTHS, px, toChart, inPoly, clearance, chartDepth, tideHeight, tidalStream, lightOn, speedZone,
  gateSide, mooredFor, boxCorners, thrusterFactor, tugFactor,
} from '../src/harbour.js';
import { follow, setSpeed, wrap } from './harbourPilot.mjs';

const hullClear = (sim, x, z, psi, solids) => Math.min(...sim.hullPts.map(([a, b]) => clearance(x + a * Math.cos(psi) - b * Math.sin(psi), z + a * Math.sin(psi) + b * Math.cos(psi), solids)));
const fixed = (sim) => sim.solids.filter((s) => !s.vessel);
const run = (sim, seconds, inputOf = () => ({})) => { for (let i = 0; i < seconds * 120; i++) sim.step(1 / 120, inputOf(sim)); };
const tugsOn = (s) => { if (s.pilotAboard && s.tugs === 'none' && s.needsTugs) s.tugKey(); };
// the last metres: lay her still and parallel just off her berth (or stern to the ramp), and the lines go on by themselves
function layAlongside(sim) {
  const T = sim.target;
  Object.assign(sim, { x: T.x + (T.face ? T.face.n.x : 0), z: T.z + (T.face ? T.face.n.z : 0), psi: T.psi, u: 0, v: 0, r: 0 });
  setSpeed(sim, 0);
  assert.equal(sim.berthState().ok, true, sim.berthState().why);
  run(sim, BERTH_TOL.hold + 0.5);
}

describe('the chart, as drawn', () => {
  it('converts the chart at 3 m a pixel, north up, from the middle of the entrance', () => {
    assert.equal(MPX, 3);
    assert.deepEqual(px(575, 482), { x: 0, z: 0 });
    const p = px(675, 382);
    assert.equal(p.x, 300, 'up the chart is north (+x)');
    assert.equal(p.z, 300, 'right is east (+z)');
    assert.deepEqual(toChart(p.x, p.z), [675, 382]);
  });
  it('has the chart\'s dimensions: lock 42 × 180 m, turning circle Ø 290 m, fishing pass 90 m, channel 162 m', () => {
    const b = LOCK.chamber.box;
    assert.equal(Math.round(b.x1 - b.x0), 180);
    assert.equal(Math.round(b.z1 - b.z0), 42);
    assert.ok(Math.abs(2 * TURN_CIRCLE.r - 290) < 3, `Ø ${2 * TURN_CIRCLE.r} m`);
    assert.equal(Math.round(PASS.box.x1 - PASS.box.x0), 90);
    assert.equal(Math.round(CHANNEL.box.z1 - CHANNEL.box.z0), 162);
    const gap = Math.hypot(GATE.a.x - GATE.b.x, GATE.a.z - GATE.b.z) - 2 * 7 * MPX; // between the heads' faces
    assert.ok(gap > 140 && gap < 170, `entrance ${gap.toFixed(0)} m clear`);
    assert.equal(Math.round(FACES.b10.len), 228, 'the Quai Est');
    assert.ok(gateSide(px(600, 400).x, px(600, 400).z) > 0 && gateSide(px(575, 700).x, px(575, 700).z) < 0, 'the avant-port is inside the entrance line');
  });
  it('lists the berths, the lights and the buoys of the chart', () => {
    assert.deepEqual(BERTHS.map((b) => b.no), ['1', '2', '3-5', '6', '7', '8', '9', '10', 'Q1-Q3', 'Q4-Q5', 'M']);
    assert.deepEqual(BERTHS.map((b) => b.len), [90, 90, 300, 180, 150, 200, 220, 190, 270, 120, 0]);
    assert.deepEqual(BERTHS.map((b) => b.depth), [5.5, 6.5, 9.0, 8.5, 7.5, 7.0, 9.5, 9.0, 7.5, 7.5, 2.8]);
    assert.deepEqual(LIGHTS.map((l) => l.char), ['Fl(2) W 10s', 'Fl(3) WR 12s', 'Fl R 4s', 'Fl G 4s', 'Iso W 2s', 'Iso W 2s']);
    assert.deepEqual(BUOYS.filter((b) => b.kind === 'port').map((b) => b.id), ['R2', 'R4']);
    assert.deepEqual(BUOYS.filter((b) => b.kind === 'stbd').map((b) => b.id), ['G1', 'G3']);
    assert.equal(CHECKLIST.length, 8);
  });
  it('puts every berth in clear water alongside its quay, and every start in open water', () => {
    for (const R of Object.values(ROUTES)) {
      const sim = new HarbourSim({ route: R.id, traffic: false });
      const solids = fixed(sim);
      const c0 = hullClear(sim, sim.x, sim.z, sim.psi, solids);
      assert.ok(R.start.berth ? c0 > 0.5 && c0 < 3 : c0 > 25, `${R.id} start: ${c0.toFixed(1)} m clear`);
      if (!sim.target) continue;
      const c = hullClear(sim, sim.target.x, sim.target.z, sim.target.psi, solids);
      assert.ok(c > 0.5 && c < 3.5, `${R.id} ${sim.target.name}: ${c.toFixed(2)} m between her side and the nearest solid`);
    }
  });
  it('keeps the ships alongside afloat and clear of each other', () => {
    for (const r of 'ABCDEFGH') {
      const M = mooredFor(r);
      for (const m of M) {
        for (const p of m.pts) assert.ok(!STATIC_SOLIDS.some((s) => inPoly(s, p.x, p.z)), `${r}: the ${m.type} is afloat`);
        for (const o of M) if (o !== m) assert.ok(!inPoly(o, m.x, m.z), `${r}: ${m.type} clear of the ${o.type}`);
      }
    }
  });
  it('draws each manoeuvre\'s route in water deep enough for her ship at her tide, clear of the quays', () => {
    for (const R of Object.values(ROUTES)) {
      const sim = new HarbourSim({ route: R.id, traffic: false });
      const pts = R.chart.flat();
      pts.forEach((p, i) => {
        if (!R.start.berth && i < pts.length - 2) assert.ok(clearance(p.x, p.z) > 0, `${R.id}: route point ${toChart(p.x, p.z).map(Math.round)} inside a solid`);
        assert.ok(sim.depthAt(p.x, p.z) > sim.ship.T, `${R.id}: ${(sim.depthAt(p.x, p.z) - sim.ship.T).toFixed(1)} m under her keel at ${toChart(p.x, p.z).map(Math.round)}`);
      });
    }
  });
});

describe('depths and the tide', () => {
  it('reads the chart\'s depths: the dredged channel, the shallows outside it, the basins, Les Corbeaux and the wreck', () => {
    const at = (X, Y) => chartDepth(px(X, Y).x, px(X, Y).z);
    assert.ok(at(575, 560) >= 9.0 && at(575, 560) <= 9.2, 'the channel: 9.0 m');
    assert.ok(at(520, 520) < 5, 'shallow outside the channel by the entrance');
    assert.ok(at(575, 900) > 25, 'deep water off the landing buoy');
    assert.ok(Math.abs(at(392, 300) - 3.7) < 0.4, 'the fishing basin');
    assert.ok(Math.abs(at(805, 296) - 2.7) < 0.2, 'the marina');
    assert.equal(at(575, 200), 7.0, 'the lock\'s sill');
    assert.ok(at(301, 467) < 0, 'Les Corbeaux dry');
    assert.ok(at(850, 520) <= 7.6 && at(850, 520) > 5, 'the wreck: 7.6 m over it at least');
  });
  it('rises and falls with the chart\'s tides, and keeps the bassin à flot at high water', () => {
    assert.ok(Math.abs(tideHeight(true, 0) - 6.2) < 1e-9 && Math.abs(tideHeight(true, 6.21) - 0.8) < 1e-6, 'springs: +6.20 / +0.80');
    assert.ok(Math.abs(tideHeight(false, 0) - 4.9) < 1e-9 && Math.abs(tideHeight(false, 6.21) - 2.1) < 1e-6, 'neaps: +4.90 / +2.10');
    assert.ok(Math.abs(tideHeight(true, 3.105) - 3.5) < 1e-6, 'mean level +3.50');
    const s = new HarbourSim({ route: 'D', traffic: false });
    const q = px(600, 140), c = px(575, 560);
    assert.ok(Math.abs(s.depthAt(q.x, q.z) - (chartDepth(q.x, q.z) + 5.5)) < 1e-9);
    assert.ok(Math.abs(s.depthAt(c.x, c.z) - (chartDepth(c.x, c.z) + s.tide)) < 1e-9);
  });
  it('sets the stream across the entrance: the flood 090° 1.5 kn, the ebb 270° 1.8 kn, nothing inside', () => {
    const p = px(578, 520), inside = px(600, 400);
    const flood = tidalStream(true, -12.42 / 4, p.x, p.z), ebb = tidalStream(true, 12.42 / 4, p.x, p.z);
    assert.ok(Math.abs(flood.kn - 1.5) < 0.01 && flood.z > 0, `flood ${flood.kn.toFixed(2)} kn east`);
    assert.ok(Math.abs(ebb.kn + 1.8) < 0.01 && ebb.z < 0, `ebb ${ebb.kn.toFixed(2)} kn west`);
    assert.equal(tidalStream(true, -3, inside.x, inside.z).kn, 0);
    assert.ok(Math.abs(tidalStream(false, -12.42 / 4, p.x, p.z).kn) < 1, 'weaker at neaps');
  });
  it('flashes the lights in their characters', () => {
    const count = (char, T) => { let n = 0, was = false; for (let t = 0; t < T; t += 0.05) { const on = lightOn(char, t); if (on && !was) n++; was = on; } return n; };
    assert.equal(count('Fl(2) W 10s', 10), 2);
    assert.equal(count('Fl(3) WR 12s', 12), 3);
    assert.equal(count('Fl R 4s', 8), 2);
    let on = 0; for (let t = 0; t < 2; t += 0.01) on += lightOn('Iso W 2s', t) ? 1 : 0;
    assert.ok(Math.abs(on - 100) <= 1, 'isophase: as long lit as dark');
  });
  it('limits the speed: 8 kn in the avant-port and the channel, 5 in the basins, 2 in the lock', () => {
    const z = (X, Y) => speedZone(px(X, Y).x, px(X, Y).z).kn;
    assert.equal(z(600, 420), 8);
    assert.equal(z(575, 600), 8);
    assert.equal(z(628, 290), 5);
    assert.equal(z(400, 300), 5);
    assert.equal(z(575, 200), 2);
    assert.equal(z(600, 140), 5);
    assert.equal(z(575, 850), Infinity);
  });
});

describe('the ships', () => {
  it('gives each manoeuvre the chart\'s ship', () => {
    assert.deepEqual(Object.values(ROUTES).map((R) => SHIPS[R.ship].L), [180, 200, 25, 120, 190, 180, 150, 180]);
    const big = new HarbourSim({ route: 'A', traffic: false }), small = new HarbourSim({ route: 'C', traffic: false }), d = new HarbourSim({ route: 'D', traffic: false });
    assert.ok(big.needsPilot && big.needsTugs, 'a 180 m cargo takes a pilot and tugs');
    assert.ok(!small.needsPilot && !small.needsTugs, 'a 25 m trawler neither');
    assert.ok(d.needsPilot && d.needsTugs, 'the 120 m ship of D takes the two tugs the chart asks for');
    assert.deepEqual(big.tel.map((t) => t.kn), [-8, -5, -2, 0, 2, 5, 8, 14], 'dead slow 2 (the lock), slow 5 (the basins), half 8 (the avant-port)');
  });
  it('stays alongside while the lines are fast, whatever the engine does', () => {
    const sim = new HarbourSim({ route: 'F', traffic: false });
    const x0 = sim.x, z0 = sim.z;
    setSpeed(sim, 14);
    run(sim, 20, () => ({ wheel: 1, turn: 1, slide: 1 }));
    assert.equal(sim.x, x0);
    assert.equal(sim.z, z0);
    assert.equal(sim.stage, 'alongside');
  });
  it('turns with the thrusters only at a crawl, with the tugs up to 6 knots', () => {
    const open = (u, tugs) => {
      const s = new HarbourSim({ route: 'A', traffic: false });
      Object.assign(s, px(900, 1200), { psi: 0, u: u * KT });
      if (tugs) { s.tugs = 'fast'; s.traffic.attachTugs(s); }
      setSpeed(s, u);
      const p0 = s.psi;
      run(s, 30, () => ({ turn: 1 }));
      return Math.abs(wrap(s.psi - p0));
    };
    assert.ok(open(0, false) > 0.1, 'thrusters turn her stopped');
    assert.ok(open(5, false) < 0.01, 'and do nothing at 5 kn');
    assert.ok(open(5, true) > 0.08, 'the tugs still turn her at 5 kn');
    assert.equal(thrusterFactor(5 * KT, 4), 0);
    assert.ok(tugFactor(3 * KT) === 1 && tugFactor(TUGS.none * KT) === 0);
  });
  it('carries her way: a 180 m cargo stopped from 8 knots runs on for hundreds of metres', () => {
    const sim = new HarbourSim({ route: 'A', traffic: false });
    Object.assign(sim, px(900, 1200), { psi: 0, u: 8 * KT });
    const x0 = sim.x;
    setSpeed(sim, 0);
    run(sim, 60);
    assert.ok(sim.x - x0 > 150, `ran on ${(sim.x - x0).toFixed(0)} m in a minute`);
  });
});

describe('contacts and groundings', () => {
  const ram = (kn) => {
    const sim = new HarbourSim({ route: 'A', traffic: false });
    sim.stage = 'berth';
    const f = FACES.b35, T = sim.target;
    const d = kn < 1 ? sim.ship.L / 2 + 3 : sim.ship.L / 2 + 30;
    Object.assign(sim, { x: T.x - f.n.x * 0 + f.n.x * (d - sim.ship.B / 2), z: T.z + f.n.z * (d - sim.ship.B / 2), psi: Math.atan2(-f.n.z, -f.n.x), u: kn * KT });
    setSpeed(sim, kn >= 2 ? 2 : 0);
    run(sim, 60);
    return sim;
  };
  it('a crawl into the quay is a touch, no damage', () => {
    const s = ram(0.4);
    assert.ok(s.contacts.touch >= 1 && s.contacts.hard === 0 && s.contacts.crash === 0, JSON.stringify(s.contacts));
    assert.equal(s.damage, 0);
  });
  it('a collision at speed damages her, and enough of them hole her', () => {
    const s = ram(5);
    assert.ok(s.contacts.crash >= 1, JSON.stringify(s.contacts));
    assert.ok(s.damage > 20);
    const t = new HarbourSim({ route: 'A', traffic: false });
    for (let i = 0; i < 6; i++) t.contact(2.5);
    assert.equal(t.stage, 'wrecked');
    assert.equal(t.damage, 100);
  });
  it('a deep ship out of the channel at low water runs aground; a trawler does not', () => {
    const t = new HarbourSim({ route: 'E', traffic: false });
    t.hour0 = 6.2; // low water springs
    Object.assign(t, px(520, 560), { psi: 0, u: 4 * KT });
    run(t, 40);
    assert.ok(t.groundings >= 1 && t.aground, 'the tanker is aground');
    assert.ok(Math.abs(t.u) < 1 * KT);
    const c = new HarbourSim({ route: 'C', traffic: false });
    c.hour0 = 0;
    Object.assign(c, px(520, 600), { psi: 0, u: 4 * KT });
    run(c, 20);
    assert.equal(c.groundings, 0, 'the trawler floats over at high water');
  });
});

describe('the rules of the port', () => {
  it('a ship over 80 m entering the channel without her pilot, unannounced, breaks two rules and fails item 1', () => {
    const sim = new HarbourSim({ route: 'A', traffic: false });
    follow(sim, [{ to: [580, 700], kn: 8 }, { to: [580, 600], kn: 8 }], { stopAt: (s) => toChart(s.x, s.z)[1] < 620 });
    const keys = sim.violations.map((v) => v.key);
    assert.ok(keys.includes('noPilot') && keys.includes('noVhf'), keys.join());
    assert.equal(sim.items[1], 'fail');
  });
  it('a ship over 120 m inside without tugs breaks the towage rule', () => {
    const sim = new HarbourSim({ route: 'A', traffic: false });
    Object.assign(sim, { vhf: true, pilotAboard: true, stage: 'channel', stageIdx: 1 }, px(578, 540), { psi: 0, u: 4 * KT });
    sim.side = gateSide(sim.x, sim.z);
    setSpeed(sim, 5);
    run(sim, 200, (s) => ({ wheel: Math.max(-1, Math.min(1, wrap(0 - s.psi) * 3)) }));
    assert.ok(sim.violations.some((v) => v.key === 'noTugs'), sim.violations.map((v) => v.key).join());
    assert.equal(sim.items[3], 'fail');
  });
  it('the speed limits are scored: 5 knots in the basins', () => {
    const sim = new HarbourSim({ route: 'G', traffic: false });
    Object.assign(sim, { stage: 'berth', stageIdx: 2 }, px(685, 316), { psi: 0, u: 7 * KT });
    setSpeed(sim, 8);
    run(sim, 12);
    assert.ok(sim.overLimit > 5, `${sim.overLimit.toFixed(1)} s over`);
    assert.ok(sim.takeEvents().some((e) => e.type === 'say' && /5 nd/.test(e.text)));
  });
  it('no stopping in the turning circle', () => {
    const sim = new HarbourSim({ route: 'A', traffic: false });
    Object.assign(sim, { stage: 'berth', stageIdx: 2, x: TURN_CIRCLE.x, z: TURN_CIRCLE.z, u: 0, psi: 0 });
    setSpeed(sim, 0);
    run(sim, 62);
    assert.ok(sim.violations.some((v) => v.key === 'circle'));
  });
  it('no anchoring in the channel or by the cable; the anchorage is the place', () => {
    const at = (X, Y) => { const s = new HarbourSim({ route: 'A', traffic: false }); Object.assign(s, px(X, Y), { u: 0 }); s.anchorKey(); return s; };
    assert.ok(at(575, 600).violations.some((v) => v.key === 'anchorChannel'));
    assert.ok(at(575, 760).violations.some((v) => v.key === 'anchorChannel'), 'nor on the leading line out to the pilot station');
    assert.ok(at(960, 470).violations.some((v) => v.key === 'anchorCable'));
    const ok = at(850, 640);
    assert.equal(ok.violations.length, 0);
    assert.ok(ok.anchor);
    run(ok, 60, () => ({}));
    assert.ok(Math.hypot(ok.x - ok.anchor.x, ok.z - ok.anchor.z) <= ok.anchor.r + 1, 'the cable holds her');
    ok.anchorKey();
    run(ok, 21);
    assert.equal(ok.anchor, null, 'weighed in 20 s');
    const fast = new HarbourSim({ route: 'A', traffic: false });
    fast.anchorKey();
    assert.equal(fast.anchor, null, 'not at 8 knots');
  });
  it('the lock works from two hours before high water to two after; its closed gates are solid', () => {
    const sim = new HarbourSim({ route: 'D', traffic: false });
    assert.ok(sim.lockWindow);
    sim.hour0 = 4;
    assert.ok(!sim.lockWindow);
    sim.updateSolids();
    const gate = px(575, 232), bridge = px(575, 222);
    assert.ok(sim.solids.some((s) => inPoly(s, gate.x, gate.z)) && sim.solids.some((s) => inPoly(s, bridge.x, bridge.z)));
    Object.assign(sim, { stage: 'lock', stageIdx: 2 }, px(575, 300), { psi: 0, u: 0, vhf: true, pilotAboard: true, tugs: 'fast' });
    run(sim, 5);
    assert.equal(sim.lock.state, 'closed');
    assert.ok(sim.takeEvents().some((e) => /PM-2 h/.test(e.text ?? '')));
    sim.hour0 = 0;
    run(sim, 50);
    assert.equal(sim.lock.state, 'open');
    sim.updateSolids();
    assert.ok(!sim.solids.some((s) => inPoly(s, gate.x, gate.z)), 'the sea gates open');
    assert.equal(sim.lockLight, 'green');
  });
  it('refuses to make fast while she is moving or on the wrong side', () => {
    const sim = new HarbourSim({ route: 'A', traffic: false });
    Object.assign(sim, { stage: 'berth', stageIdx: 2 });
    const T = sim.target;
    Object.assign(sim, { x: T.x, z: T.z, psi: T.psi, u: 1.5 * KT });
    assert.match(sim.berthState().why, /Stoppez/);
    Object.assign(sim, { psi: wrap(T.psi + Math.PI), u: 0 });
    assert.match(sim.berthState().why, /Bâbord à quai/, 'A berths port side to');
    sim.lineKey();
    assert.equal(sim.stage, 'berth');
  });
});

describe('the standard manoeuvres, sailed by a scripted pilot', () => {
  it('A: cargo 180 m to berths 3-4-5, pilot, tugs, port side to, all fast, 3 stars', () => {
    const sim = new HarbourSim({ route: 'A' });
    sim.vhfKey();
    follow(sim, [{ to: [578, 815], kn: 6 }, { to: [587, 700], kn: 6 }, { to: [587, 560], kn: 5 }, { to: [585, 482], kn: 4 }, { to: [604, 430], kn: 3 }, { to: [616, 385], kn: 2 }, { to: [616, 320], kn: 2 }, { to: [616, 283], kn: (s, d) => (d > 120 ? 2 : 0), r: 8 }],
      { stopAt: (s) => s.stage === 'berth' && s.berthState().dist < 60 && Math.abs(s.u) < 0.3, on: tugsOn, maxT: 3000 });
    assert.equal(sim.stage, 'berth');
    // alongside with the tugs: hold her parallel, kill the way along the quay, push her in gently
    const f = sim.target.face;
    for (let i = 0; i < 400 * 120 && sim.stage !== 'done'; i++) {
      const b = sim.berthState();
      const along = b.along * Math.sign(Math.cos(sim.psi - f.psi));
      setSpeed(sim, along > 3 && sim.u > -0.15 ? -2 : along < -3 && sim.u < 0.15 ? 2 : 0);
      const turn = Math.max(-1, Math.min(1, wrap(sim.target.psi - sim.psi) * 30 - sim.r * 60));
      const gap = Math.min(b.gapFwd, b.gapAft), wantIn = gap > 6 ? 0.25 : gap > 1.5 ? 0.1 : 0.03;
      sim.step(1 / 120, { turn, slide: (b.closing < wantIn ? -1 : b.closing > wantIn + 0.05 ? 1 : 0) * -sim.target.wallSide });
    }
    assert.equal(sim.stage, 'done');
    assert.deepEqual(sim.items, { 1: 'ok', 2: 'ok', 3: 'ok', 4: 'na', 5: 'ok', 6: 'ok', 7: 'na', 8: 'na' });
    assert.equal(sim.contacts.hard + sim.contacts.crash, 0);
    assert.equal(sim.result.stars, 3);
    assert.ok(sim.maxInside <= 8.3);
  });
  it('B: ferry 200 m turns 180° to starboard in the circle, then lies stern to the Ro-Ro ramp', () => {
    const sim = new HarbourSim({ route: 'B', traffic: false });
    sim.vhfKey();
    follow(sim, [{ to: [576, 815], kn: 6 }, { to: [588, 700], kn: 6 }, { to: [588, 560], kn: 5 }, { to: [586, 482], kn: 4 }, { to: [592, 440], kn: 2 }, { to: [600, 398], kn: (s, d) => (d > 80 ? 2 : d > 20 ? 1 : 0), r: 8 }],
      { stopAt: (s) => s.stage === 'evitage' && Math.hypot(s.x - TURN_CIRCLE.x, s.z - TURN_CIRCLE.z) < 45 && Math.abs(s.u) < 0.3, on: tugsOn, maxT: 2000 });
    assert.equal(sim.stage, 'evitage');
    for (let i = 0; i < 500 * 120 && sim.stage === 'evitage'; i++) { setSpeed(sim, 0); sim.step(1 / 120, { turn: Math.abs(sim.r) < (TUGS.yaw + 1 / 57.3) * 0.8 ? 1 : 0.2 }); }
    assert.equal(sim.stage, 'berth');
    assert.equal(sim.items[4], 'ok', 'turned inside the circle');
    assert.ok(Math.abs(wrap(sim.psi - Math.PI)) < 0.35, 'bow south');
    layAlongside(sim);
    assert.equal(sim.stage, 'done');
    assert.ok(sim.berthState().gapFwd < 4, 'stern at the ramp');
  });
  it('C: trawler 25 m along the Digue Ouest, through the 90 m pass, to the fishing basin', () => {
    const sim = new HarbourSim({ route: 'C' });
    sim.vhfKey();
    follow(sim, [{ to: [586, 700], kn: 6 }, { to: [586, 560], kn: 5 }, { to: [584, 482], kn: 4 }, { to: [560, 445], kn: 4 }, { to: [515, 418], kn: 4 }, { to: [500, 335], kn: 3 }, { to: [492, 303], kn: 2 }, { to: [420, 302], kn: 2 }, { to: [385, 302], kn: (s, d) => (d > 30 ? 1.5 : 0), r: 6 }],
      { stopAt: (s) => s.stage === 'berth' && s.berthState().dist < 40 && Math.abs(s.u) < 0.2, maxT: 2600 });
    assert.equal(sim.stage, 'berth');
    layAlongside(sim);
    assert.equal(sim.stage, 'done');
    assert.equal(sim.items[3], 'na', 'no tugs for a trawler');
    assert.equal(sim.items[1], 'ok');
    assert.equal(sim.contacts.hard + sim.contacts.crash, 0);
  });
  it('D: 120 m ship waits for the green light, locks up at 2 knots and lies at Q5 in the bassin à flot', () => {
    const sim = new HarbourSim({ route: 'D' });
    sim.vhfKey();
    follow(sim, [{ to: [576, 815], kn: 6 }, { to: [578, 700], kn: 6 }, { to: [578, 560], kn: 5 }, { to: [576, 482], kn: 4 }], { stopAt: (s) => s.stage === 'lock', on: tugsOn, maxT: 2000 });
    follow(sim, [{ to: [575, 420], kn: 3 }, { to: [575, 330], kn: 2 }, { to: [575, 290], kn: (s, d) => (s.lockLight === 'green' ? 2 : d > 60 ? 1.5 : 0), r: 5 }], { stopAt: (s) => s.lockLight === 'green', maxT: 600 });
    assert.equal(sim.lock.state, 'open');
    assert.ok(!sim.violations.some((v) => v.key === 'lockRed'));
    const mid = px(575, 202);
    for (let i = 0; i < 900 * 120 && sim.stage === 'lock'; i++) {
      const st = sim.lock.state;
      setSpeed(sim, st === 'filling' ? 0 : st === 'out' || st === 'done' ? 2 : mid.x - sim.x > 25 ? 2 : 0);
      sim.step(1 / 120, { slide: Math.max(-1, Math.min(1, -(sim.z - mid.z) * 0.3 - sim.v * 3)), turn: Math.max(-1, Math.min(1, wrap(-sim.psi) * 30 - sim.r * 60)) });
    }
    assert.equal(sim.stage, 'berth', `the lock: ${sim.lock.state}`);
    assert.equal(sim.lock.state, 'out');
    assert.ok(sim.maxInside < 5.5);
    layAlongside(sim);
    assert.equal(sim.stage, 'done');
    assert.deepEqual(sim.items, { 1: 'ok', 2: 'ok', 3: 'ok', 4: 'na', 5: 'ok', 6: 'ok', 7: 'na', 8: 'na' });
  });
  it('E: tanker 190 m from the south-east, two tugs, to berth 10 with the fire wire', () => {
    const sim = new HarbourSim({ route: 'E', traffic: false });
    sim.vhfKey();
    follow(sim, [[700, 900, 6], [620, 860, 6], [592, 800, 6], [591, 700, 5], [590, 560, 5], [587, 482, 4], [598, 448, 3]].map(([X, Y, kn]) => ({ to: [X, Y], kn })), { stopAt: (s) => s.stage === 'berth', on: tugsOn, maxT: 2500 });
    assert.equal(sim.stage, 'berth');
    assert.equal(sim.groundings, 0);
    layAlongside(sim);
    assert.ok(sim.takeEvents().some((e) => /Coupe-feu/.test(e.text ?? '')));
    assert.equal(sim.items[3], 'ok');
  });
  it('F: cargo leaves berth 6 bow south, keeps right, drops her pilot off the station', () => {
    const sim = new HarbourSim({ route: 'F' });
    sim.vhfKey();
    sim.lineKey();
    assert.equal(sim.items[7], 'ok', 'VHF 12 told before letting go');
    run(sim, 60, () => ({ slide: 1 }));
    follow(sim, [{ to: [636, 340], kn: 2 }, { to: [618, 400], kn: 3 }, { to: [590, 440], kn: 3 }, { to: [576, 480], kn: 4 }, { to: [560, 545], kn: 5 },
      { to: [556, 640], kn: 6, input: (s) => { if (s.tugs === 'fast' && gateSide(s.x, s.z) < -30) s.tugKey(); return {}; } }, { to: [545, 700], kn: 6 }, { to: [570, 812], kn: 6 }, { to: [575, 900], kn: 5 }], { maxT: 2500 });
    assert.equal(sim.stage, 'done');
    assert.deepEqual(sim.items, { 1: 'na', 2: 'na', 3: 'ok', 4: 'na', 5: 'na', 6: 'na', 7: 'ok', 8: 'ok' });
    assert.equal(sim.pilotAboard, false);
    assert.equal(sim.contacts.hard + sim.contacts.crash + sim.groundings, 0);
  });
  it('G: the outbound cargo waits, then the two pass port to port in the crossing zone', () => {
    const sim = new HarbourSim({ route: 'G' });
    const out = sim.traffic.get('cargoOut');
    sim.vhfKey();
    assert.equal(sim.entryLight, 'red', 'an outbound ship in the passage: entry forbidden');
    follow(sim, [[578, 815, 6], [588, 700, 6], [588, 560, 5], [586, 482, 4], [600, 448, 3]].map(([X, Y, kn]) => ({ to: [X, Y], kn })), { stopAt: (s) => s.stage === 'berth', on: tugsOn, maxT: 2500 });
    assert.ok(toChart(out.x, out.z)[1] > 664 && !out.outbound, 'the outbound cargo is out past the crossing zone');
    assert.deepEqual(sim.crossing, { done: true, ok: true, why: '' });
    assert.ok(!sim.violations.some((v) => ['cross', 'priority', 'redEntry'].includes(v.key)), sim.violations.map((v) => v.text).join(' / '));
    layAlongside(sim);
    assert.equal(sim.stage, 'done');
  });
  it('H: the tugs pivot her 180° to starboard in the circle at under a knot, then she sails', () => {
    const sim = new HarbourSim({ route: 'H' });
    assert.equal(sim.tugs, 'fast');
    sim.vhfKey();
    for (let i = 0; i < 600 * 120 && sim.stage === 'evitage'; i++) { setSpeed(sim, 0); sim.step(1 / 120, { turn: Math.abs(sim.r) < TUGS.yaw * 0.6 ? 1 : 0.3 }); }
    assert.equal(sim.stage, 'resume');
    assert.equal(sim.items[4], 'ok');
    sim.tugKey();
    follow(sim, [{ to: [590, 440], kn: 3 }, { to: [570, 480], kn: 4 }, { to: [560, 560], kn: 5 }], { maxT: 900 });
    assert.equal(sim.stage, 'done');
    assert.equal(sim.result.stars, 3);
  });
});

void [LAND, MOLES, RAMP, PILOT_ZONE, ANCHORAGE, STOP_ORDER, boxCorners];

// Fleet orders: course, speed, formations, sector patrols, stance, goto, and the purity and determinism of steerGoal.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { applyOrder, steerGoal, formationStation, patrolOffset, canonicalForm } from '../src/fleetOrders.js';
import { FleetSim, DT } from '../src/fleet.js';

// Threats off: these tests check the orders, not the fight.
const quiet = (seed = 1, n = 4) => new FleetSim({ seed, n, hooks: { planThreats: () => [] } });
const runFor = (sim, seconds) => { for (let i = 0; i < Math.round(seconds / DT); i++) sim.step(DT); };
const distTo = (s, p) => Math.hypot(p.x - s.x, p.z - s.z);

describe('course and speed', () => {
  it('applyOrder changes only the ships the order names', () => {
    const sim = new FleetSim({ seed: 1 });
    applyOrder(sim, { to: [1], type: 'course', course: 450 });
    assert.equal(sim.squad[1].goal.course, 90);
    assert.equal(sim.squad[0].goal.course, 0);
  });

  it('steerGoal returns numeric { course, kn } and does not change the ship', () => {
    const sim = new FleetSim({ seed: 1 });
    const before = structuredClone(sim.squad[2].goal);
    const g1 = steerGoal(sim, sim.squad[2]);
    const g2 = steerGoal(sim, sim.squad[2]);
    assert.equal(typeof g1.course, 'number');
    assert.equal(typeof g1.kn, 'number');
    assert.deepEqual(g1, g2);
    assert.deepEqual(sim.squad[2].goal, before);
  });

  it('a course or goto order clears formation and sector; speed only sets kn', () => {
    const sim = quiet(2);
    const s = sim.squad[1];
    applyOrder(sim, { to: 1, type: 'form', form: 'BOX' });
    assert.equal(s.form, 'BOX');
    applyOrder(sim, { to: 1, type: 'speed', kn: 9 });
    assert.equal(s.form, 'BOX');
    assert.equal(s.goal.kn, 9);
    applyOrder(sim, { to: 1, type: 'course', course: 180 });
    assert.equal(s.form, null);
    assert.equal(s.sector, null);
    assert.equal(s.goal.course, 180);
  });

  it('ignores a non-finite course or speed rather than poisoning the goal', () => {
    const sim = quiet(2);
    applyOrder(sim, { to: 'all', type: 'course', course: NaN });
    applyOrder(sim, { to: 'all', type: 'speed', kn: undefined });
    assert.equal(sim.squad[0].goal.course, 0);
    assert.equal(sim.squad[0].goal.kn, 16);
  });
});

describe('formations', () => {
  it('canonicalises names and rejects unknown ones', () => {
    assert.equal(canonicalForm('box'), 'BOX');
    assert.equal(canonicalForm('line'), 'FORM 3');
    assert.equal(canonicalForm('form  d'), 'FORM D');
    assert.equal(canonicalForm('FORM 999'), null);
    assert.equal(canonicalForm(null), null);
  });

  it('stations are laid off from the lead on her heading', () => {
    const sim = quiet(3);
    const lead = sim.squad[0];
    applyOrder(sim, { to: 'all', type: 'form', form: 'FORM 3' });
    const st = formationStation(sim, sim.squad[2]); // rank 1: two spacings to starboard
    assert.ok(Math.abs(st.x - lead.x) < 1e-6, 'abeam, not ahead');
    assert.ok(Math.abs(st.z - lead.z - 800) < 1e-6, `starboard ${st.z - lead.z}`);
  });

  for (const form of ['FORM 1', 'FORM 3', 'BOX', 'FORM D']) {
    it(`${form}: every ship reaches its station within 60 m and stays there`, () => {
      const sim = quiet(7);
      sim.order({ to: 'all', type: 'form', form });
      // a ship astern of the column has to make up ground on a lead doing 16 kn: run until all are on station (or give up)
      const onStation = () => sim.squad.slice(1).every((s) => distTo(s, formationStation(sim, s)) < 60);
      for (let i = 0; i < 90 && !onStation(); i++) runFor(sim, 20);
      runFor(sim, 60);
      for (const s of sim.squad.slice(1)) {
        const err = distTo(s, formationStation(sim, s));
        assert.ok(err < 60, `${form} SHIP${s.idx + 1} is ${err.toFixed(0)} m from station`);
      }
      // no collisions: ships never close to within 150 m of one another
      for (let i = 0; i < sim.squad.length; i++) for (let j = i + 1; j < sim.squad.length; j++) {
        assert.ok(distTo(sim.squad[i], sim.squad[j]) > 150, `${form}: ships ${i} and ${j} too close`);
      }
    });
  }

  it('a formation follows the lead when she turns', () => {
    const sim = quiet(8);
    sim.order({ to: 'all', type: 'form', form: 'FORM 3' });
    runFor(sim, 200);
    sim.order({ to: 0, type: 'course', course: 90 });
    runFor(sim, 300);
    for (const s of sim.squad.slice(1)) {
      const err = distTo(s, formationStation(sim, s));
      assert.ok(err < 80, `SHIP${s.idx + 1} is ${err.toFixed(0)} m from its station after the lead's turn`);
    }
  });
});

describe('sector patrols', () => {
  it('a patrol point stays inside its sector and sweeps through it', () => {
    const sec = { from: 60, to: 120, inner: 1000, outer: 2000 };
    for (let t = 0; t < 1800; t += 37) {
      const p = patrolOffset(sec, t);
      const r = Math.hypot(p.x, p.z);
      const b = ((Math.atan2(p.z, p.x) * 180) / Math.PI + 360) % 360;
      assert.ok(r >= 1000 && r <= 2000, `range ${r} at t=${t}`);
      assert.ok(b >= 60 && b <= 120, `bearing ${b} at t=${t}`);
    }
  });

  it('a ship ordered to a sector steers into it and stays there', () => {
    const sim = quiet(9);
    applyOrder(sim, { to: 3, type: 'sector', sector: { from: 60, to: 120, inner: 1000, outer: 2000 } });
    const ship = sim.squad[3], lead = sim.squad[0];
    runFor(sim, 400);
    let worst = 0;
    for (let i = 0; i < 40; i++) {
      runFor(sim, 10);
      const dx = ship.x - lead.x, dz = ship.z - lead.z;
      const r = Math.hypot(dx, dz);
      const b = ((Math.atan2(dz, dx) * 180) / Math.PI + 360) % 360;
      const outside = Math.max(1000 - r, r - 2000, 60 - b, b - 120, 0);
      worst = Math.max(worst, outside);
    }
    assert.ok(worst < 150, `left the sector by ${worst.toFixed(0)} m`);
  });

  it('an invalid sector is dropped', () => {
    const sim = quiet(9);
    applyOrder(sim, { to: 1, type: 'sector', sector: { from: 0, to: 90, inner: 2000, outer: 1000 } });
    assert.equal(sim.squad[1].sector, null);
  });
});

describe('stance', () => {
  it('hold stops the guns at once, engage restores them', () => {
    const sim = quiet(5);
    applyOrder(sim, { to: 2, type: 'stance', stance: 'hold' });
    const s = sim.squad[2];
    assert.equal(s.stance, 'hold');
    assert.equal(s.cmd.fire, false);
    assert.equal(s.cmd.gat, false);
    assert.equal(s.auto, false);
    applyOrder(sim, { to: 2, type: 'stance', stance: 'engage' });
    assert.equal(s.stance, 'engage');
    assert.equal(s.cmd.fire, true);
    assert.equal(s.auto, true);
  });

  it('a ship on hold fires no shells in a fight', () => {
    const sim = new FleetSim({ seed: 5, hooks: { planThreats: () => [{ t: 1, kind: 'frigate', rel: 0, range: 4000 }] } });
    sim.order({ to: 1, type: 'stance', stance: 'hold' });
    runFor(sim, 200);
    assert.equal(sim.squad[1].stats.shells + sim.squad[1].stats.bursts, 0);
  });
});

describe('goto', () => {
  it('arrives and stops at the point', () => {
    const sim = quiet(4);
    sim.order({ to: 2, type: 'goto', x: 0, z: 1500 });
    runFor(sim, 400);
    const s = sim.squad[2];
    assert.ok(Math.hypot(s.x, s.z - 1500) < 80, `at ${s.x.toFixed(0)}, ${s.z.toFixed(0)}`);
    assert.ok(sim.knots(s) < 4, `still ${sim.knots(s).toFixed(1)} kn`);
  });
});

describe('determinism', () => {
  const script = (sim) => {
    sim.order({ to: 'all', type: 'form', form: 'BOX' });
    runFor(sim, 120);
    sim.order({ to: 1, type: 'sector', sector: { from: 0, to: 90, inner: 800, outer: 1600 } });
    sim.order({ to: 2, type: 'goto', x: 300, z: -900 });
    sim.order({ to: 3, type: 'stance', stance: 'hold' });
    runFor(sim, 200);
  };
  it('two sims with the same seed and orders end identical', () => {
    const a = new FleetSim({ seed: 12 }), b = new FleetSim({ seed: 12 });
    script(a);
    script(b);
    assert.equal(a.digest(), b.digest());
  });
});

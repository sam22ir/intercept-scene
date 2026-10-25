// The kill-cam recorder (src/helmReplay.js): snapshots, interpolation, clips, and nothing kept beyond SPAN.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { HelmSim } from '../src/helm.js';
import { Recorder, SPAN, PRE, POST, HZ, replayRate, SLOW, SLOWEST } from '../src/helmReplay.js';

const run = (sim, rec, seconds) => { for (let i = 0; i < seconds * 60; i++) { sim.advance(1 / 60, {}); rec.record(sim); } };

describe('the recorder', () => {
  it('keeps one snapshot per 1 / HZ s and nothing older than SPAN', () => {
    const sim = new HelmSim({ seed: 3 });
    const rec = new Recorder();
    run(sim, rec, SPAN + 10);
    const first = rec.frames[0].t;
    assert.ok(sim.t - first <= SPAN + 1 / HZ + 0.05, `span ${sim.t - first}`);
    assert.ok(Math.abs(rec.frames.length - (sim.t - first) * HZ) < 3, `${rec.frames.length} frames`);
  });

  it('interpolates the ship and a drone between two snapshots', () => {
    const sim = new HelmSim({ seed: 3 });
    sim.nextSpawn = Infinity;
    const rec = new Recorder();
    sim.spawn({ bearing: 1, range: 4000, alt: 150 });
    run(sim, rec, 3);
    const [a, b] = [rec.frames[10], rec.frames[11]];
    const mid = rec.sample((a.t + b.t) / 2);
    assert.ok(Math.abs(mid.ship.x - (a.ship.x + b.ship.x) / 2) < 1e-9);
    assert.ok(Math.abs(mid.drones[0].p[0] - (a.drones[0].p[0] + b.drones[0].p[0]) / 2) < 1e-9);
    assert.ok(Math.abs(Math.hypot(...mid.drones[0].q) - 1) < 1e-9, 'a unit quaternion');
    assert.equal(rec.sample(-5).t, -5);
  });

  it('notes a kill with its wreck and cuts a clip about it', () => {
    const sim = new HelmSim({ seed: 3 });
    sim.nextSpawn = Infinity;
    const rec = new Recorder();
    const d = sim.spawn({ bearing: 1, range: 3000, alt: 100 });
    run(sim, rec, 12);
    sim.down(d, 'missile', d.pos.clone());
    for (const e of sim.takeEvents()) rec.note(e, sim);
    run(sim, rec, 1);
    const ev = rec.last();
    assert.equal(ev.type, 'explosion');
    assert.equal(ev.id, d.id);
    assert.ok(ev.wreck && ev.wreck.burstPos);
    const c = rec.clip(ev);
    assert.ok(c.t0 >= rec.frames[0].t && Math.abs(c.t0 - (ev.t - PRE)) < 1e-9);
    assert.ok(Math.abs(c.t1 - (ev.t + POST)) < 1e-9);
    assert.ok(rec.sample(c.t0).drones.some((x) => x.id === d.id), 'the drone is in the clip');
  });

  it('forgets everything when the mission starts again', () => {
    const sim = new HelmSim({ seed: 3 });
    const rec = new Recorder();
    run(sim, rec, 5);
    rec.kills.push({ type: 'explosion', t: 4, id: 1, pos: [0, 0, 0], wreck: null });
    sim.reset();
    run(sim, rec, 1);
    assert.equal(rec.last(), null);
    assert.ok(rec.frames[0].t < 1.1);
  });

  it('plays slowest through the impact and slow around it', () => {
    assert.equal(replayRate(10, 10), SLOWEST);
    assert.equal(replayRate(2, 10), SLOW);
    assert.equal(replayRate(20, 10), SLOW);
  });
});

// The manual-flight model (src/fly.js): the deck and engine rules, the catapult, arrow-key flight at the
// default 75 m/s, the parachute when the engine is cut, crashes, and the missile on F. Runs in Node, no
// browser: the model steps at a fixed 1/240 s, so these runs are exact and repeatable.
//
// fly.js imports scenario.js, which reads its mission from globalThis once at import; this mission uses
// the recovery ('chute') scenario (no scripted missile).

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL, fileURLToPath } from 'node:url';

let F;
let S;
before(async () => {
  globalThis.__SHIP_VARIANT = 'fwd';
  globalThis.__SCENARIO = 'chute';
  const url = (f) => `${pathToFileURL(fileURLToPath(new URL(f, import.meta.url))).href}?fly`;
  S = await import(url('../src/scenario.js'));
  F = await import(url('../src/fly.js'));
});

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);
const run = (sim, seconds, input = {}) => { for (let i = 0; i < seconds * 60; i++) sim.advance(1 / 60, input); };
const messages = (sim) => sim.takeEvents().filter((e) => e.type === 'say').map((e) => e.text);

// Engine on, full power, catapult away: a drone in flight, a couple of seconds after the stroke.
function airborne(seconds = 3) {
  const sim = new F.FlySim();
  sim.toggleEngine();
  run(sim, F.T_SPOOL + 0.3);
  sim.catapult();
  run(sim, seconds);
  return sim;
}

describe('fly: the deck, the engine and the catapult', () => {
  it('starts on the cradle with the engine off, moving with the ship', () => {
    const sim = new F.FlySim();
    assert.equal(sim.phase, 'deck');
    assert.equal(sim.engineOn, false);
    near(sim.vel.x, S.SHIP_SPEED, 1e-9, 'moves with the ship');
    run(sim, 2);
    assert.equal(sim.phase, 'deck');
    near(sim.pos.x, S.RAIL.start.x + S.RAIL.ride * S.RAIL.up.x + S.SHIP_SPEED * sim.t, 1e-6, 'carried by the ship');
  });

  it('will not fire the catapult with the engine off', () => {
    const sim = new F.FlySim();
    sim.catapult();
    assert.equal(sim.phase, 'deck');
    assert.match(messages(sim).join('|'), /engine first/i);
  });

  it('runs the engine up over the scripted 3 s, and arms the catapult if it is pressed early', () => {
    const sim = new F.FlySim();
    sim.toggleEngine();
    run(sim, 1);
    near(sim.spin, 1 / F.T_SPOOL, 0.02, 'a third of the way up');
    sim.catapult();
    assert.equal(sim.phase, 'deck');
    assert.equal(sim.armed, true);
    run(sim, F.T_SPOOL);
    assert.notEqual(sim.phase, 'deck', 'fired by itself at full power');
  });

  it('fires the scenario short stroke in its own time and leaves the rail at its release speed relative to the ship', () => {
    const sim = new F.FlySim();
    sim.toggleEngine();
    run(sim, F.T_SPOOL + 0.2);
    sim.catapult();
    assert.equal(sim.phase, 'cat');
    run(sim, F.T_RELEASE - F.T_SPOOL - 0.05);
    assert.equal(sim.phase, 'cat');
    while (sim.phase === 'cat') sim.stepOnce(F.DT, {});
    assert.equal(sim.phase, 'flight');
    const rel = sim.vel.clone();
    rel.x -= S.SHIP_SPEED;
    const vRelease = (2 * S.RAIL.length) / (F.T_RELEASE - F.T_SPOOL); // v = a t and s = a t^2 / 2
    near(rel.length(), vRelease, 0.5, 'release speed relative to the ship');
    assert.ok(vRelease > 22 && vRelease < 30, 'about 26 m/s, not ' + vRelease.toFixed(1));
    near(S.RAIL.length, 3.6, 1e-9, 'a compact rail');
    near(sim.cradleT, F.T_SPOOL + (sim.t - sim.tLaunch), 1e-9, 'cradle clock');
  });

  it('cannot start the engine after the launch, and cannot fire the catapult in the air', () => {
    const sim = airborne(1);
    sim.takeEvents();
    sim.catapult();
    assert.match(messages(sim).join('|'), /only works on the ship/i);
    assert.equal(sim.phase, 'flight');
  });
});

describe('fly: arrow-key flight', () => {
  it('settles at the default 75 m/s after the booster', () => {
    const sim = airborne(4);
    assert.equal(sim.phase, 'flight');
    near(sim.speed, 75, 0.01, 'airspeed');
    near(sim.vel.length(), 75, 0.01, 'velocity');
  });

  it('a held right arrow banks right and turns right by g tan(bank) / v', () => {
    const sim = airborne(3);
    const a0 = sim.alpha;
    run(sim, 6, { right: true });
    near(sim.bank, F.MAX_BANK, 0.02, 'bank reaches the limit');
    const rate = (S.G * Math.tan(sim.bank)) / sim.speed;
    near(sim.alpha - a0, rate * 6, 0.35, 'heading change');
    assert.ok(sim.alpha > a0, 'turned to starboard');
    // The wing really is down on the right: local +X (left wing) points up.
    const left = new (sim.pos.constructor)(1, 0, 0).applyQuaternion(sim.quat);
    assert.ok(left.y > 0.3, 'right wing down');
  });

  it('turns hard: a half circle in under 8 s, on a radius of about 150 m', () => {
    const sim = airborne(4);
    const a0 = sim.alpha;
    let t = 0;
    while (sim.alpha - a0 < Math.PI && t < 12) { sim.advance(1 / 60, { right: true }); t += 1 / 60; }
    assert.ok(t < 8, `a half turn took ${t.toFixed(1)} s`);
    near(75 / ((S.G * Math.tan(F.MAX_BANK)) / 75), 150, 25, 'turn radius');
  });

  it('a held left arrow turns left', () => {
    const sim = airborne(3);
    const a0 = sim.alpha;
    run(sim, 4, { left: true });
    assert.ok(sim.alpha < a0 - 0.3);
  });

  it('up climbs and down descends, and level flight holds its height', () => {
    const sim = airborne(3);
    const y0 = sim.pos.y;
    run(sim, 4, { up: true });
    assert.ok(sim.pos.y > y0 + 60, `climbed to ${sim.pos.y.toFixed(0)} m`);
    const y1 = sim.pos.y;
    run(sim, 10);
    assert.ok(Math.abs(sim.pos.y - y1) < 25, 'levels off when the key is released');
  });

  it('flying straight off the rail does not touch the sea or the ship', () => {
    const sim = airborne(3);
    run(sim, 30);
    assert.equal(sim.phase, 'flight');
    assert.ok(sim.pos.y > 5, `altitude ${sim.pos.y.toFixed(1)}`);
  });

  it('a held down arrow ends in the sea', () => {
    const sim = airborne(3);
    run(sim, 20, { down: true });
    assert.equal(sim.phase, 'crashed');
    assert.equal(sim.wreck.kind, 'sea');
  });

  it('the cruise speed can be changed within its limits', () => {
    const sim = airborne(3);
    sim.setSpeed(60);
    run(sim, 3);
    near(sim.speed, 60, 0.01, 'slower');
    sim.setSpeed(500);
    near(sim.speedTarget, F.SPEED_LIMITS[1], 0, 'limited');
  });
});

describe('fly: the engine cut and the parachute', () => {
  it('E in flight cuts the engine for good and opens the parachute', () => {
    const sim = airborne(5);
    sim.takeEvents();
    sim.toggleEngine();
    assert.equal(sim.phase, 'chute');
    assert.equal(sim.engineOn, false);
    assert.ok(sim.takeEvents().some((e) => e.type === 'chute'));
    sim.toggleEngine();
    assert.equal(sim.engineOn, false, 'it cannot be restarted in the air');
    assert.equal(sim.phase, 'chute');
  });

  it('descends under canopy at about 5.4 m/s and splashes down afloat', () => {
    const sim = airborne(5);
    sim.toggleEngine();
    const y0 = sim.pos.y;
    run(sim, 4);
    const vy = (y0 - sim.pos.y) / 4;
    assert.ok(vy > 3 && vy < 12, `sink ${vy.toFixed(1)} m/s`);
    run(sim, 60);
    assert.equal(sim.phase, 'splashed');
    near(sim.pos.y, 0.18, 0.2, 'floating');
    assert.ok(Number.isFinite(sim.tSplash));
    assert.ok(sim.done);
  });

  it('the prop winds down after the engine is cut', () => {
    const sim = airborne(5);
    sim.toggleEngine();
    run(sim, 6);
    assert.ok(sim.spin < 0.02);
  });
});

describe('fly: the missile on F', () => {
  it('needs the drone in the air', () => {
    const sim = new F.FlySim();
    sim.fire();
    assert.equal(sim.shot, null);
    assert.match(messages(sim).join('|'), /in the air/i);
  });

  it('slews the launcher, fires, and destroys a drone flying straight', () => {
    const sim = airborne(6);
    sim.fire();
    assert.ok(sim.shot && sim.shot.tFire === null, 'slewing');
    run(sim, F.SLEW_TIME + 0.2);
    assert.ok(sim.missile, 'away');
    near(sim.shot.tFire - sim.shot.tPress, F.SLEW_TIME, 0.02, 'fires when the launcher is on');
    let guard = 0;
    while (sim.phase === 'flight' && guard++ < 60 * 14) sim.advance(1 / 60, {});
    assert.equal(sim.phase, 'destroyed');
    assert.equal(sim.wreck.kind, 'missile');
    assert.ok(sim.wreck.burstDist < 4, `burst ${sim.wreck.burstDist.toFixed(1)} m from the drone`);
    assert.equal(sim.missile, null);
    assert.ok(sim.done);
  });

  it('still kills a turning, climbing drone', () => {
    const sim = airborne(3);
    run(sim, 6, { right: true, up: true });
    sim.fire();
    let guard = 0;
    while (sim.phase === 'flight' && guard++ < 60 * 20) sim.advance(1 / 60, { right: true, up: true });
    assert.equal(sim.phase, 'destroyed');
  });

  it('kills a drone under its parachute too', () => {
    const sim = airborne(3);
    run(sim, 8, { up: true }); // climb first: a canopy from low down is on the water before a round can arrive
    sim.toggleEngine();
    run(sim, 1);
    assert.equal(sim.phase, 'chute');
    sim.fire();
    let guard = 0;
    while (sim.phase === 'chute' && guard++ < 60 * 20) sim.advance(1 / 60, {});
    assert.equal(sim.phase, 'destroyed');
  });

  it('can still shoot a drone floating after splashdown', () => {
    const sim = airborne(5);
    sim.toggleEngine();
    run(sim, 60);
    assert.equal(sim.phase, 'splashed');
    sim.fire();
    assert.ok(sim.shot, 'the launcher turns');
    let guard = 0;
    while (sim.phase === 'splashed' && guard++ < 60 * 20) sim.advance(1 / 60, {});
    assert.equal(sim.phase, 'destroyed');
  });

  it('refuses a target beyond the missile\'s range, and a second round only while one is not on its way', () => {
    const far = airborne(3);
    run(far, 70, {});
    assert.ok(far.shipRange() > F.MISSILE_RANGE);
    far.takeEvents();
    far.fire();
    assert.equal(far.shot, null);
    assert.match(messages(far).join('|'), /out of range/i);

    const sim = airborne(6);
    sim.fire();
    sim.fire();
    assert.equal(sim.shots.length, 1, 'one round at a time');
  });

  it('a missile that cannot catch the drone is lost, not left flying', () => {
    const sim = airborne(3);
    run(sim, 20); // well out, but inside the range
    sim.setSpeed(110);
    sim.fire();
    // Outrun it by diving the drone into the sea? No: just check the timeout path through the model's own rule.
    sim.shot.aim.pitch = 0.5;
    let guard = 0;
    while ((sim.missile || sim.shot.tFire === null) && sim.phase === 'flight' && guard++ < 60 * 20) sim.advance(1 / 60, {});
    assert.ok(sim.phase === 'destroyed' || sim.missile === null);
  });
});

describe('fly: determinism and reset', () => {
  it('the same keys give exactly the same flight', () => {
    const a = airborne(3);
    const b = airborne(3);
    run(a, 5, { left: true, up: true });
    run(b, 5, { left: true, up: true });
    assert.deepEqual(a.pos.toArray(), b.pos.toArray());
  });

  it('is independent of the frame rate', () => {
    const run2 = (fps) => {
      const sim = new F.FlySim();
      sim.toggleEngine();
      for (let i = 0; i < fps * 3.3; i++) sim.advance(1 / fps, {});
      sim.catapult();
      for (let i = 0; i < fps * 8; i++) sim.advance(1 / fps, { right: true });
      return sim.pos.clone();
    };
    const p30 = run2(30);
    const p144 = run2(144);
    assert.ok(p30.distanceTo(p144) < 10, `${p30.distanceTo(p144).toFixed(2)} m apart`);
  });

  it('reset puts everything back on the deck', () => {
    const sim = airborne(6);
    sim.fire();
    run(sim, 4);
    sim.reset();
    assert.equal(sim.phase, 'deck');
    assert.equal(sim.shot, null);
    assert.equal(sim.missile, null);
    assert.equal(sim.shots.length, 0);
    assert.equal(sim.chute, null);
    assert.equal(sim.wreck, null);
  });
});

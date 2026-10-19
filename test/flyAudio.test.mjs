// The manual-flight mission's sound (src/flyAudio.js), against a stand-in AudioContext: the recorded
// samples are decoded, the six beds run as loops, the one-shots start on the model's events (and only
// while sound is on), delayed ones wait for their moment, and updating from live flight states never throws.

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import * as THREE from 'three';

let made = { sources: 0, loops: 0 };
let ctxRef = null;
const param = () => ({ value: 0, setTargetAtTime() {}, setValueAtTime() {} });
const node = () => ({ connect(n) { return n; }, gain: param(), frequency: param(), pan: param(), Q: param(), threshold: param(), ratio: param(), type: '' });
class FakeContext {
  constructor() { this.currentTime = 0; this.state = 'running'; this.destination = {}; ctxRef = this; }
  createGain() { return node(); }
  createDynamicsCompressor() { return node(); }
  createBiquadFilter() { return node(); }
  createBufferSource() {
    made.sources++;
    const s = { buffer: null, loop: false, playbackRate: param(), connect() {}, start() { if (s.loop) made.loops++; } };
    return s;
  }
  // Like a browser: the success callback is called, and a promise comes back too.
  decodeAudioData(bytes, ok) {
    const buf = { duration: bytes.byteLength > 40000 ? 3 : 1 };
    Promise.resolve().then(() => ok?.(buf));
    return Promise.resolve(buf);
  }
  resume() { return Promise.resolve(); }
  suspend() { return Promise.resolve(); }
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const camera = {
  getWorldPosition: (v) => v.set(-60, 12, 20),
  getWorldQuaternion: (q) => q.identity(),
};

let F;
let audio;
let engineLevel;
let sim;
before(async () => {
  globalThis.__SHIP_VARIANT = 'fwd';
  globalThis.__SCENARIO = 'chute';
  const handlers = {};
  globalThis.AudioContext = FakeContext;
  globalThis.addEventListener = (ev, fn) => { handlers[ev] = fn; };
  const url = (f) => `${pathToFileURL(new URL(f, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')).href}?flyaudio`;
  F = await import(url('../src/fly.js'));
  const { createFlyAudio, engineLevel: level } = await import(url('../src/flyAudio.js'));
  engineLevel = level;
  audio = createFlyAudio();
  handlers.keydown(); // the first key press creates the context
  await tick();
  await tick();
  sim = new F.FlySim();
});

const run = (seconds, input = {}) => { for (let i = 0; i < seconds * 60; i++) { sim.advance(1 / 60, input); audio.update(sim, camera, 1 / 60); } };

describe('fly audio', () => {
  it('decodes every embedded sample and starts the six beds as loops', () => {
    assert.equal(audio.supported, true);
    assert.equal(audio.state, 'running');
    assert.deepEqual([...audio.loaded].sort(), ['boom', 'booster', 'clunk', 'engine', 'hiss', 'hum', 'launch', 'motor', 'splash', 'surf', 'wind']);
    assert.equal(made.loops, 6, 'engine, booster, missile motor, ship hum, wind, surf');
  });

  it('the engine is silent while it is off, rises with the run-up and falls away after a cut', () => {
    assert.equal(engineLevel(0), 0, 'stopped');
    assert.equal(engineLevel(0.03), 0, 'barely turning');
    assert.ok(engineLevel(0.3) > 0.1 && engineLevel(0.3) < engineLevel(1), 'run-up');
    assert.ok(engineLevel(1) >= 0.55, 'full power');
    assert.equal(engineLevel(1, true), 0, 'wrecked');
    let prev = 0;
    for (let s = 0; s <= 1.0001; s += 0.02) { const l = engineLevel(s); assert.ok(l >= prev - 1e-9, `rises smoothly at ${s}`); prev = l; }
    // After a cut the prop winds down (e^(-t/1.4)): quiet within a few seconds.
    assert.equal(engineLevel(Math.exp(-5 / 1.4)), 0);
  });

  it('updates through a whole flight without throwing: deck, catapult, flight, missile, explosion', () => {
    sim.toggleEngine();
    run(F.T_SPOOL + 0.3);
    sim.catapult();
    run(4);
    sim.fire();
    run(F.SLEW_TIME + 0.3);
    assert.ok(sim.missile, 'the missile is flying');
    run(10);
    assert.equal(sim.phase, 'destroyed');
    run(2);
  });

  it('starts a one-shot on each event, and only while sound is on', () => {
    made.sources = 0;
    for (const type of ['launch', 'release']) audio.event({ type }, sim);
    audio.event({ type: 'fire', pos: new THREE.Vector3(1, 2, 3) }, sim);
    audio.event({ type: 'explosion', pos: new THREE.Vector3(1, 2, 3) }, sim);
    audio.event({ type: 'crash', kind: 'sea', pos: new THREE.Vector3(1, 0, 3) }, sim);
    audio.event({ type: 'crash', kind: 'ship', pos: new THREE.Vector3(1, 8, 3) }, sim);
    audio.event({ type: 'splashdown', pos: new THREE.Vector3(1, 0, 3) }, sim);
    audio.event({ type: 'missile-lost', pos: new THREE.Vector3(1, 3, 3) }, sim);
    audio.event({ type: 'missile-lost', pos: new THREE.Vector3(1, 300, 3) }, sim); // high in the air: no splash
    audio.event({ type: 'say', text: 'x' }, sim); // no sound
    assert.equal(made.sources, 8);
    audio.setEnabled(false);
    made.sources = 0;
    audio.event({ type: 'launch' }, sim);
    assert.equal(made.sources, 0, 'silent when switched off');
    audio.setEnabled(true);
  });

  it('holds a delayed one-shot until its moment', () => {
    made.sources = 0;
    audio.later('splash', new THREE.Vector3(0, 0, 0), 2);
    audio.update(sim, camera, 1 / 60);
    assert.equal(made.sources, 0, 'not yet');
    ctxRef.currentTime += 2.1;
    audio.update(sim, camera, 1 / 60);
    assert.equal(made.sources, 1, 'now');
    audio.later('splash', new THREE.Vector3(0, 0, 0), 5);
    audio.reset();
    ctxRef.currentTime += 6;
    audio.update(sim, camera, 1 / 60);
    assert.equal(made.sources, 1, 'a restart drops what was waiting');
  });

  it('is quiet (master gain to zero) while the context is suspended or the tab is hidden', () => {
    ctxRef.state = 'suspended';
    audio.update(sim, camera, 1 / 60);
    ctxRef.state = 'running';
    assert.doesNotThrow(() => audio.update(sim, camera, 1 / 60));
  });
});

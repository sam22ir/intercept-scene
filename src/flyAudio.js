import * as THREE from 'three';
import { shipPos, RAIL } from './scenario.js';
import { SOUNDS } from './audioAssets.js';
import { T_SPOOL, T_RELEASE, BOOST_TIME } from './fly.js';

// Sound for the manual-flight mission. The samples are the ones audio.js uses (ElevenLabs sound
// effects, embedded in the bundle), but nothing here follows a timeline: the loops (engine, booster,
// missile motor, ship hum, wind, surf) are driven every frame from the live simulation, and the
// one-shots (catapult, release, missile launch, explosion, splashes) start when the model reports the
// event. The listener is the camera, as in the other missions: loudness falls with distance, distant
// sounds darken, and everything pans left and right; moving sources are Doppler-shifted by their speed
// relative to the camera (which, in the chase view, moves along with the drone).

const SOUND_SPEED = 340;
const { smoothstep, clamp } = THREE.MathUtils;
const att = (d, ref) => ref / (ref + d);
const doppler = (vr) => clamp(SOUND_SPEED / (SOUND_SPEED + vr), 0.5, 2); // vr > 0: receding

// voice -> sample for the looping beds
const LOOPS = { engine: 'engine', booster: 'booster', missile: 'motor', ship: 'hum', wind: 'wind', surf: 'surf' };
// one-shot voices: sample, level, and the distance at which they have fallen to half
const SHOTS = {
  hiss: { level: 0.55, ref: 60 },
  clunk: { level: 0.9, ref: 60 },
  launch: { level: 1.0, ref: 110 },
  boom: { level: 1.6, ref: 140 },
  splash: { level: 0.6, ref: 70 },
};

export function createFlyAudio() {
  const AudioCtx = globalThis.AudioContext ?? globalThis.webkitAudioContext;
  let ctx = null;
  let master = null;
  let voices = null;
  let enabled = true;
  let failed = !AudioCtx;
  const buffers = {};
  const queue = []; // one-shots waiting for their moment: { at, name, pos }
  const shotPos = Object.fromEntries(Object.keys(SHOTS).map((k) => [k, new THREE.Vector3()]));

  // Scratch.
  const cam = new THREE.Vector3();
  const camPrev = new THREE.Vector3();
  const camVel = new THREE.Vector3();
  const right = new THREE.Vector3();
  const camQuat = new THREE.Quaternion();
  const to = new THREE.Vector3();
  const rel = new THREE.Vector3();
  const tmp = new THREE.Vector3();
  const tmp2 = new THREE.Vector3();
  let haveCam = false;

  function bytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out.buffer;
  }

  // Every voice ends: low-pass (distance) -> level -> pan -> master.
  function chain(distance = true) {
    const g = ctx.createGain();
    g.gain.value = 0;
    const p = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    if (p) { g.connect(p); p.connect(master); } else g.connect(master);
    let lp = null;
    if (distance) {
      lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 14000;
      lp.Q.value = 0.5;
      lp.connect(g);
    }
    return { g, p, lp, in: lp ?? g, src: null };
  }

  function build() {
    master = ctx.createGain();
    master.gain.value = 0;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.ratio.value = 5;
    master.connect(comp);
    comp.connect(ctx.destination);
    voices = {};
    for (const name of ['engine', 'booster', 'missile', 'ship', ...Object.keys(SHOTS)]) voices[name] = chain();
    voices.wind = chain(false); // ambience sits at the listener
    voices.surf = chain(false);
  }

  function startLoop(sample) {
    for (const [voice, name] of Object.entries(LOOPS)) {
      if (name !== sample) continue;
      const s = ctx.createBufferSource();
      s.buffer = buffers[name];
      s.loop = true;
      s.connect(voices[voice].in);
      s.start();
      voices[voice].src = s;
    }
  }

  function loadBuffers() {
    for (const name of Object.keys(SOUNDS)) {
      const done = (buf) => { buffers[name] = buf; startLoop(name); };
      try {
        ctx.decodeAudioData(bytes(SOUNDS[name]), done, () => {})?.catch?.(() => {});
      } catch { /* undecodable on this browser: that sound stays silent */ }
    }
  }

  function ensure() {
    if (ctx || failed) return;
    try {
      ctx = new AudioCtx();
      build();
      loadBuffers();
    } catch {
      failed = true;
      ctx = null;
    }
  }

  // Browsers keep a context suspended until a user gesture; resume on the first one.
  const wake = (fromGesture = true) => {
    if (!enabled) return;
    if (!ctx && !fromGesture && !globalThis.navigator?.userActivation?.hasBeenActive) return;
    ensure();
    if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
  };
  for (const ev of ['pointerdown', 'keydown']) globalThis.addEventListener?.(ev, () => wake(true), { passive: true });
  globalThis.document?.addEventListener?.('visibilitychange', () => {
    if (!ctx) return;
    if (document.hidden) ctx.suspend().catch(() => {});
    else if (enabled) ctx.resume().catch(() => {});
  });

  const set = (param, value) => param.setTargetAtTime(value, ctx.currentTime, 0.025);

  // Aim a voice at a world position: loudness, darkening and pan from the listener.
  function place(voice, pos, level, ref) {
    to.subVectors(pos, cam);
    const d = to.length();
    set(voice.g.gain, level * att(d, ref));
    if (voice.lp) set(voice.lp.frequency, clamp(14000 / (1 + d / 140), 500, 14000));
    if (voice.p) set(voice.p.pan, d > 0.5 ? clamp(to.dot(right) / d, -1, 1) * 0.8 : 0);
  }

  // How fast a source at `pos` moving at `vel` is receding from the camera (m/s, + = away).
  function radial(pos, vel) {
    rel.subVectors(vel, camVel);
    to.subVectors(pos, cam);
    const d = to.length();
    return d > 0.5 ? rel.dot(to) / d : 0;
  }

  const loopRate = (voice, rate) => { if (voice.src) set(voice.src.playbackRate, rate); };

  // One-shots.
  function start(name, pos) {
    const buf = buffers[name];
    if (!buf || !ctx || !enabled) return;
    shotPos[name].copy(pos);
    const node = ctx.createBufferSource();
    node.buffer = buf;
    node.connect(voices[name].in);
    node.start();
  }
  function play(name, pos, delay = 0) {
    if (failed || !SHOTS[name]) return;
    if (!ctx) { ensure(); if (!ctx) return; }
    if (delay > 0) queue.push({ at: ctx.currentTime + delay, name, pos: pos.clone() });
    else start(name, pos);
  }

  const railPoint = (f, t, out) => out.copy(RAIL.start).addScaledVector(RAIL.dir, RAIL.length * f).add(shipPos(t, tmp2));

  // The model's events: the one-shots that mark them.
  function event(e, sim) {
    switch (e.type) {
      case 'launch': play('hiss', railPoint(0.5, sim.t, tmp)); break;
      case 'release': play('clunk', railPoint(1, sim.t, tmp)); break;
      case 'fire': play('launch', e.pos); break;
      case 'explosion': play('boom', e.pos); break;
      case 'crash': play(e.kind === 'ship' ? 'boom' : 'splash', e.pos); break;
      case 'splashdown': play('splash', e.pos); break;
      case 'missile-lost': if (e.pos.y < 8) play('splash', e.pos); break;
      default: break;
    }
  }

  // Every frame: place the beds from the live state.
  function update(sim, camera, dt) {
    if (!ctx || failed) return;
    camera.getWorldPosition(cam);
    camera.getWorldQuaternion(camQuat);
    right.set(1, 0, 0).applyQuaternion(camQuat);
    // The camera's own velocity (smoothed; ignore a cut or a reset).
    if (haveCam && dt > 0) {
      tmp.subVectors(cam, camPrev).divideScalar(dt);
      if (tmp.length() < 400) camVel.lerp(tmp, 0.2); else camVel.set(0, 0, 0);
    }
    camPrev.copy(cam);
    haveCam = true;

    const live = enabled && ctx.state === 'running' && !globalThis.document?.hidden;
    set(master.gain, live ? 0.9 : 0);
    if (!live) { queue.length = 0; return; }

    // Delayed one-shots whose moment has come.
    for (let i = queue.length - 1; i >= 0; i--) {
      if (ctx.currentTime >= queue[i].at) { start(queue[i].name, queue[i].pos); queue.splice(i, 1); }
    }

    const wrecked = sim.phase === 'crashed' || sim.phase === 'destroyed';
    const v = voices;
    const dop = doppler(radial(sim.pos, sim.vel));

    // The engine: pitch follows the prop (and a little the airspeed), Doppler-shifted; it dies with the drone.
    const fast = sim.phase === 'flight' ? 0.92 + 0.1 * (sim.speed / 75) : 1;
    loopRate(v.engine, (0.7 + 0.6 * sim.spin) * dop * fast);
    place(v.engine, sim.pos, wrecked ? 0 : 0.1 + 0.5 * sim.spin, 45);

    // The booster canister under the tail, from the stroke to just past release.
    const burn = sim.tLaunch === null ? -1 : sim.cradleT - T_SPOOL;
    const total = T_RELEASE - T_SPOOL + BOOST_TIME;
    const boost = burn < 0 || wrecked ? 0 : smoothstep(burn, -0.05, 0.25) * (1 - smoothstep(burn, total - 0.3, total + 0.5));
    loopRate(v.booster, dop);
    place(v.booster, sim.pos, 0.9 * boost, 90);

    // The missile's motor, Doppler-shifted by its closing speed.
    const m = sim.missile;
    if (m) {
      const age = Math.max(0, sim.t - m.tFire);
      const motor = (1 - Math.exp(-age / 0.03)) * (0.6 + 0.4 * Math.exp(-age / 1.5));
      loopRate(v.missile, doppler(radial(m.pos, m.vel)));
      place(v.missile, m.pos, motor, 110);
    } else {
      set(v.missile.g.gain, 0);
    }

    // The one-shots keep their place and fall off with distance as the camera moves.
    for (const [name, s] of Object.entries(SHOTS)) place(v[name], shotPos[name], s.level, s.ref);

    // The ship's hum, the wind (from the air speed) and the surf (from the height).
    place(v.ship, tmp.set(-20, 5, 0).add(shipPos(sim.t, tmp2)), 0.12, 80);
    const windSpeed = sim.phase === 'flight' ? sim.speed : sim.phase === 'cat' ? sim.speed * 0.5 : sim.phase === 'chute' ? sim.speed * 0.3 : 0;
    const high = smoothstep(cam.y, 5, 200);
    const gust = 0.85 + 0.15 * Math.sin(sim.t * 0.9) * Math.sin(sim.t * 0.37 + 1);
    loopRate(v.wind, 1 + 0.5 * Math.min(windSpeed / 90, 1));
    set(v.wind.g.gain, (0.1 + 0.15 * high + 0.6 * Math.min(windSpeed / 90, 1)) * gust);
    set(v.surf.g.gain, 0.35 * (1 - smoothstep(cam.y, 8, 120)) * (0.8 + 0.2 * Math.sin(sim.t * 0.6)));
  }

  return {
    update,
    event,
    // A one-shot `delay` seconds from now (the wreck's pieces landing).
    later: play,
    // Drop one-shots still waiting (a restart).
    reset() { queue.length = 0; },
    get enabled() { return enabled; },
    setEnabled(on) {
      enabled = on;
      if (on) wake(false);
    },
    // For inspection from the console.
    get state() { return ctx?.state ?? (failed ? 'unavailable' : 'idle'); },
    get supported() { return !failed; },
    get loaded() { return Object.keys(buffers); },
  };
}

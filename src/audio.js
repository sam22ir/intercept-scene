import * as THREE from 'three';
import {
  scenario, shipPos, missilePos, propSpin01, RAIL,
} from './scenario.js';
import { SOUNDS } from './audioAssets.js';

// Sound design. The samples are sound effects generated with ElevenLabs (text to sound
// v2), processed by scripts/build-sounds.py and embedded in the bundle, so the offline
// file still needs nothing else. Like the visuals, everything follows the sim time `t`:
//  * loops (engine, rocket motors, wind, surf, hum) run continuously and each frame
//    get their gain, filter and playback rate from `t` and the camera;
//  * one-shots (catapult, launch, explosion, splashes) play from the sample offset
//    `t - tEvent`, and re-sync whenever time jumps, so seeking lands mid-sound.
//    They play while the clock runs forward; scrubbing and reverse keep the loops.
// Sound is silent while time stands still.
//
// `dronePos(t, out)` resolves the drone (or its wreck) in world space;
// `splashTimes` lists when pieces of the drone hit the sea.

const SOUND_SPEED = 340;
const { smoothstep, clamp } = THREE.MathUtils;

const att = (d, ref) => ref / (ref + d); // loudness falloff with distance
const doppler = (vr) => clamp(SOUND_SPEED / (SOUND_SPEED + vr), 0.5, 2); // vr > 0: receding

// voice -> sample for the looping beds
const LOOPS = { engine: 'engine', booster: 'booster', missile: 'motor', ship: 'hum', wind: 'wind', surf: 'surf' };

export function createAudio({ dronePos, splashTimes }) {
  const AudioCtx = globalThis.AudioContext ?? globalThis.webkitAudioContext;
  let ctx = null;
  let master = null;
  let voices = null;
  let shots = [];
  let enabled = true;
  let failed = !AudioCtx;
  let lastT = -1;
  let lastMove = -10;
  const buffers = {};

  // --- Scratch -----------------------------------------------------------------
  const cam = new THREE.Vector3();
  const right = new THREE.Vector3();
  const src = new THREE.Vector3();
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const vel = new THREE.Vector3();
  const to = new THREE.Vector3();
  const camQuat = new THREE.Quaternion();
  const camPrev = new THREE.Vector3();
  let camSpeed = 0;

  // --- Graph -------------------------------------------------------------------

  function bytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out.buffer;
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
        // callbacks for old Safari, the promise for everyone else
        ctx.decodeAudioData(bytes(SOUNDS[name]), done, () => {})?.catch?.(() => {});
      } catch { /* undecodable on this browser: that sound stays silent */ }
    }
  }

  // Every voice ends: low-pass (distance) -> level -> pan -> master.
  function chain(distance = true) {
    const g = ctx.createGain();
    g.gain.value = 0;
    const p = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    if (p) g.connect(p).connect(master); else g.connect(master);
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
    master.connect(comp).connect(ctx.destination);

    voices = {};
    for (const name of ['engine', 'booster', 'missile', 'ship', 'hiss', 'clunk', 'launch', 'boom', 'splash']) voices[name] = chain();
    voices.wind = chain(false); // ambience sits at the listener
    voices.surf = chain(false);

    // One-shots: which voice plays which sample at which time.
    shots = [
      { voice: 'hiss', name: 'hiss', t0: scenario.tSpool },
      { voice: 'clunk', name: 'clunk', t0: scenario.tRelease },
    ];
    if (scenario.hasMissile) {
      shots.push({ voice: 'launch', name: 'launch', t0: scenario.tLaunch });
      shots.push({ voice: 'boom', name: 'boom', t0: scenario.tHit });
    }
    for (const t0 of splashTimes) shots.push({ voice: 'splash', name: 'splash', t0 });
    for (const s of shots) s.cur = null;
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
    // Without a prior gesture the context could not start (and would log a warning).
    if (!ctx && !fromGesture && !globalThis.navigator?.userActivation?.hasBeenActive) return;
    ensure();
    if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
  };
  for (const ev of ['pointerdown', 'keydown']) globalThis.addEventListener?.(ev, () => wake(true), { passive: true });
  globalThis.document?.addEventListener('visibilitychange', () => {
    if (!ctx) return;
    if (document.hidden) ctx.suspend().catch(() => {});
    else if (enabled) ctx.resume().catch(() => {});
  });

  // --- Per-frame drive ---------------------------------------------------------

  const set = (param, value) => param.setTargetAtTime(value, ctx.currentTime, 0.025);

  // Aim a voice at a world position: loudness, darkening and pan from the listener.
  function place(voice, pos, level, ref) {
    to.subVectors(pos, cam);
    const d = to.length();
    set(voice.g.gain, level * att(d, ref));
    if (voice.lp) set(voice.lp.frequency, clamp(14000 / (1 + d / 140), 500, 14000));
    if (voice.p) set(voice.p.pan, d > 0.5 ? clamp(to.dot(right) / d, -1, 1) * 0.8 : 0);
  }

  // Receding speed of a source moving from p0 to p1 over 0.1 s, seen from the camera.
  function radial(pos, p0, p1, out) {
    out.subVectors(p1, p0).multiplyScalar(10);
    to.subVectors(pos, cam);
    const d = to.length();
    return d > 0.5 ? out.dot(to) / d : 0;
  }

  const loopRate = (voice, rate) => { if (voice.src) set(voice.src.playbackRate, rate); };

  function stopShot(s) {
    if (!s.cur) return;
    try { s.cur.stop(); } catch { /* already ended */ }
    s.cur = null;
  }

  // Keep a one-shot on the sample offset `t - t0` while the clock runs forward.
  function driveShot(s, t, forward, rate) {
    const buf = buffers[s.name];
    const off = t - s.t0;
    if (!buf || !forward || off < 0 || off > buf.duration - 0.03) { stopShot(s); return; }
    if (s.cur) {
      const expected = s.off0 + (ctx.currentTime - s.ctx0) * s.rate;
      if (Math.abs(expected - off) < 0.12 && s.rate === rate) return;
      stopShot(s);
    }
    const node = ctx.createBufferSource();
    node.buffer = buf;
    node.playbackRate.value = rate;
    node.connect(voices[s.voice].in);
    node.start(0, off);
    node.onended = () => { if (s.cur === node) s.cur = null; };
    s.cur = node;
    s.off0 = off;
    s.ctx0 = ctx.currentTime;
    s.rate = rate;
  }

  function update(t, camera, clock) {
    if (!ctx || failed) return;
    const now = performance.now() / 1000;
    if (Math.abs(t - lastT) > 1e-4) lastMove = now;
    const moving = clock.playing || now - lastMove < 0.25;
    const dt = lastT < 0 ? 0 : Math.abs(t - lastT);
    lastT = t;
    camera.getWorldPosition(cam);
    camera.getWorldQuaternion(camQuat);
    right.set(1, 0, 0).applyQuaternion(camQuat);

    // Wind comes from how fast the camera itself moves; ignore jumps (cuts, scrubs).
    const step = camPrev.distanceTo(cam);
    camPrev.copy(cam);
    const speed = dt > 0 && dt < 0.2 && step / dt < 300 ? step / dt : 0;
    camSpeed += (speed - camSpeed) * 0.1;

    const live = enabled && moving && ctx.state === 'running';
    set(master.gain, live ? 0.9 : 0);
    if (!live) { for (const s of shots) stopShot(s); return; }

    const v = voices;
    const { tHit, tBoost0, tBoost1, hasMissile } = scenario;
    const forward = clock.playing && clock.direction > 0;
    const rate = clamp(clock.speed, 0.25, 4);
    for (const s of shots) driveShot(s, t, forward, rate);

    // Drone engine: pitch follows prop speed, Doppler-shifted by its motion.
    dronePos(t, src);
    dronePos(t - 0.05, a);
    dronePos(t + 0.05, b);
    const dop = doppler(radial(src, a, b, vel));
    const spin = propSpin01(t);
    loopRate(v.engine, (0.7 + 0.6 * spin) * dop);
    place(v.engine, src, t < tHit ? 0.1 + 0.5 * spin : 0, 45); // dies with the drone (or at the chute cut, via spin)

    // Booster canister under the tail, burning from the stroke to just past release.
    const boost = smoothstep(t, tBoost0 - 0.05, tBoost0 + 0.25) * (1 - smoothstep(t, tBoost1 - 0.3, tBoost1 + 0.5));
    loopRate(v.booster, dop);
    place(v.booster, src, 0.9 * boost, 90);

    // Catapult (the burst and clunk are one-shots at the rail).
    src.copy(RAIL.start).addScaledVector(RAIL.dir, RAIL.length * 0.5).add(shipPos(t, a));
    place(v.hiss, src, 0.55, 60);
    place(v.clunk, src, 0.9, 60);

    // Missile motor loop, launch whoosh and impact. Everything ends at the hit.
    if (hasMissile) {
      const age = Math.max(0, t - scenario.tLaunch);
      const burn = t < scenario.tLaunch || t >= tHit ? 0 : (1 - Math.exp(-age / 0.03)) * (0.6 + 0.4 * Math.exp(-age / 1.5));
      missilePos(t, src);
      missilePos(t - 0.05, a);
      missilePos(t + 0.05, b);
      loopRate(v.missile, doppler(radial(src, a, b, vel)));
      place(v.missile, src, burn, 110);
      place(v.launch, src, t < tHit ? 1.0 : 0, 110);
      place(v.boom, scenario.hitPos, 1.6, 140);
    }

    // Sea impacts, at the wreck's splashdown.
    dronePos(splashTimes.length ? splashTimes[0] : t, src).setY(0);
    place(v.splash, src, 0.6, 70);

    // Ship hum, wind and surf.
    src.set(-20, 5, 0).add(shipPos(t, a));
    place(v.ship, src, 0.12, 80);
    const high = smoothstep(cam.y, 5, 200);
    const gust = 0.85 + 0.15 * Math.sin(t * 0.9) * Math.sin(t * 0.37 + 1);
    loopRate(v.wind, 1 + 0.5 * Math.min(camSpeed / 90, 1));
    set(v.wind.g.gain, (0.1 + 0.15 * high + 0.6 * Math.min(camSpeed / 90, 1)) * gust);
    set(v.surf.g.gain, 0.35 * (1 - smoothstep(cam.y, 8, 120)) * (0.8 + 0.2 * Math.sin(t * 0.6)));
  }

  return {
    update,
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

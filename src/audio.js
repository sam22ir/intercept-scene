import * as THREE from 'three';
import {
  scenario, shipPos, missilePos, propSpin01, RAIL, LAUNCHER_PIVOT,
} from './scenario.js';

// Procedural sound, built from Web Audio nodes only (no samples, no worklets, so
// the single-file offline build still works). Like the visuals, every voice is a
// function of the sim time `t`: the sources run continuously and each frame we
// set their gain, filter and pitch from `t` and the camera position. Nothing is
// scheduled, so scrubbing and reverse playback just work. Sound is silent while
// time stands still.
//
// `dronePos(t, out)` resolves the drone (or its wreck) in world space;
// `splashTimes` lists when pieces of the drone hit the sea.

const SOUND_SPEED = 340;
const { smoothstep, clamp } = THREE.MathUtils;

const att = (d, ref) => ref / (ref + d); // loudness falloff with distance
const doppler = (vr) => clamp(SOUND_SPEED / (SOUND_SPEED + vr), 0.5, 2); // vr > 0: receding
const after = (t, t0) => Math.max(0, t - t0);
const bump = (t, a, b) => { const u = (t - a) / (b - a); return u > 0 && u < 1 ? 4 * u * (1 - u) : 0; };

export function createAudio({ dronePos, splashTimes }) {
  const AudioCtx = globalThis.AudioContext ?? globalThis.webkitAudioContext;
  let ctx = null;
  let master = null;
  let voices = null;
  let enabled = true;
  let failed = !AudioCtx;
  let lastT = -1;
  let lastMove = -10;

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

  function noiseBuffer(kind) {
    const len = ctx.sampleRate * 3;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    let seed = kind === 'brown' ? 7 : 11;
    for (let i = 0; i < len; i++) {
      seed = (seed * 16807) % 2147483647;
      const w = (seed / 2147483647) * 2 - 1;
      if (kind === 'brown') { last = (last + 0.02 * w) / 1.02; d[i] = last * 3.5; } else d[i] = w;
    }
    return buf;
  }

  function build() {
    master = ctx.createGain();
    master.gain.value = 0;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.ratio.value = 6;
    master.connect(comp).connect(ctx.destination);

    const white = noiseBuffer('white');
    const brown = noiseBuffer('brown');
    const noise = (buf, offset) => {
      const s = ctx.createBufferSource();
      s.buffer = buf;
      s.loop = true;
      s.start(0, offset);
      return s;
    };
    const osc = (type, freq) => {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = freq;
      o.start();
      return o;
    };
    const filter = (type, freq, q = 0.7) => {
      const f = ctx.createBiquadFilter();
      f.type = type;
      f.frequency.value = freq;
      f.Q.value = q;
      return f;
    };
    // Every voice ends in a gain (level) -> optional panner -> master.
    const out = () => {
      const g = ctx.createGain();
      g.gain.value = 0;
      const p = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
      if (p) { g.connect(p).connect(master); } else g.connect(master);
      return { g, p, lp: null };
    };
    // Optional distance low-pass sits before the level.
    const spatial = (head) => {
      const o = out();
      o.lp = filter('lowpass', 12000, 0.5);
      head.connect(o.lp).connect(o.g);
      return o;
    };

    const v = {};

    // Drone engine: two detuned saws, amplitude-flutter at the firing rate.
    {
      const o1 = osc('sawtooth', 60);
      const o2 = osc('sawtooth', 60.7);
      const mixer = ctx.createGain();
      mixer.gain.value = 0.5;
      const tone = filter('lowpass', 1400, 1.2);
      const flutter = ctx.createGain();
      flutter.gain.value = 0.7;
      const lfo = osc('sine', 30);
      const lfoDepth = ctx.createGain();
      lfoDepth.gain.value = 0.3;
      lfo.connect(lfoDepth).connect(flutter.gain);
      o1.connect(mixer);
      o2.connect(mixer);
      mixer.connect(tone).connect(flutter);
      v.engine = { ...spatial(flutter), o1, o2, lfo, tone };
    }
    // Rocket motors (booster, missile): hiss band plus rumble.
    const rocket = () => {
      const hiss = noise(white, 0.3);
      const band = filter('bandpass', 900, 0.5);
      const rumble = noise(brown, 1.1);
      const low = filter('lowpass', 220, 0.7);
      const sum = ctx.createGain();
      hiss.connect(band).connect(sum);
      rumble.connect(low).connect(sum);
      return { ...spatial(sum), band, low };
    };
    v.booster = rocket();
    v.missile = rocket();
    // Catapult: pneumatic burst + the clunk of the cradle on its buffers.
    {
      const hiss = noise(white, 0.8);
      const hp = filter('highpass', 2800, 0.6);
      hiss.connect(hp);
      v.hiss = spatial(hp);
      const thump = osc('sine', 62);
      const click = noise(white, 1.6);
      const cl = filter('bandpass', 1800, 1.5);
      const sum = ctx.createGain();
      thump.connect(sum);
      click.connect(cl).connect(sum);
      v.clunk = spatial(sum);
    }
    // Launcher servo whine.
    {
      const o = osc('sawtooth', 200);
      const lp = filter('lowpass', 900, 1);
      o.connect(lp);
      v.servo = { ...spatial(lp), o };
    }
    // Explosion: crack + body (swept low-pass) + sub.
    {
      const n = noise(white, 2.0);
      const body = filter('lowpass', 3000, 0.8);
      const rumble = noise(brown, 0.4);
      const sub = osc('sine', 46);
      const sum = ctx.createGain();
      n.connect(body).connect(sum);
      rumble.connect(sum);
      sub.connect(sum);
      v.boom = { ...spatial(sum), body };
    }
    // Splashes.
    {
      const n = noise(white, 2.5);
      const bp = filter('bandpass', 1400, 0.6);
      n.connect(bp);
      v.splash = spatial(bp);
    }
    // Ship: engine hum + a wash of broadband noise.
    {
      const o1 = osc('sine', 52);
      const o2 = osc('triangle', 78);
      const n = noise(brown, 2.2);
      const lp = filter('lowpass', 160, 0.7);
      const sum = ctx.createGain();
      o1.connect(sum);
      o2.connect(sum);
      n.connect(lp).connect(sum);
      v.ship = spatial(sum);
    }
    // Ambient: wind and surf, always at the listener.
    {
      const n = noise(white, 0.1);
      const bp = filter('bandpass', 400, 0.4);
      n.connect(bp);
      v.wind = { ...out(), bp };
      bp.connect(v.wind.g);
      const s = noise(brown, 1.7);
      const lp = filter('lowpass', 450, 0.6);
      s.connect(lp);
      v.surf = out();
      lp.connect(v.surf.g);
    }
    voices = v;
  }

  function ensure() {
    if (ctx || failed) return;
    try {
      ctx = new AudioCtx();
      build();
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
    return d;
  }

  function radial(pos, p0, p1, out) {
    // Receding speed of a source moving from p0 to p1 over 0.1 s, seen from the camera.
    out.subVectors(p1, p0).multiplyScalar(10);
    to.subVectors(pos, cam);
    const d = to.length();
    return d > 0.5 ? out.dot(to) / d : 0;
  }

  function update(t, camera, clockPlaying) {
    if (!ctx || failed) return;
    const now = performance.now() / 1000;
    if (Math.abs(t - lastT) > 1e-4) lastMove = now;
    const moving = clockPlaying || now - lastMove < 0.25;
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

    set(master.gain, enabled && moving && ctx.state === 'running' ? 0.9 : 0);
    if (!enabled || !moving) return;

    const v = voices;
    const { tHit, tLaunch, tRelease, tSpool, tBoost0, tBoost1, hasMissile } = scenario;
    const alive = t < tHit; // the engine dies with the drone (or at the chute cut, via propSpin01)

    // Drone engine, pitched with prop speed and Doppler-shifted by its motion.
    {
      dronePos(t, src);
      dronePos(t - 0.05, a);
      dronePos(t + 0.05, b);
      const dop = doppler(radial(src, a, b, vel));
      const spin = propSpin01(t);
      const f = (58 + 92 * spin) * dop;
      set(v.engine.o1.frequency, f);
      set(v.engine.o2.frequency, f * 1.012);
      set(v.engine.lfo.frequency, f * 0.5);
      set(v.engine.tone.frequency, 500 + 1300 * spin);
      place(v.engine, src, alive ? (0.1 + 0.55 * spin) : 0, 45);

      // Booster canister under the tail, burning from the stroke to just past release.
      const boost = smoothstep(t, tBoost0 - 0.05, tBoost0 + 0.25) * (1 - smoothstep(t, tBoost1 - 0.3, tBoost1 + 0.5));
      set(v.booster.band.frequency, 800 * dop);
      place(v.booster, src, 1.1 * boost, 90);
    }

    // Catapult: air burst at the stroke, clunk at the buffers.
    {
      src.copy(RAIL.start).addScaledVector(RAIL.dir, RAIL.length * 0.5).add(shipPos(t, a));
      const tt = after(t, tSpool);
      const burst = t < tSpool ? 0 : (1 - Math.exp(-tt / 0.02)) * (0.8 * Math.exp(-tt / 0.5) + 0.2 * Math.exp(-tt / 2));
      place(v.hiss, src, 0.55 * burst, 60);
      const c = after(t, tRelease);
      const clunk = t < tRelease ? 0 : (1 - Math.exp(-c / 0.004)) * Math.exp(-c / 0.14);
      place(v.clunk, src, 1.2 * clunk, 60);
    }

    // Missile: ignition crack, motor, launcher servo. Both end at impact.
    if (hasMissile) {
      const age = after(t, tLaunch);
      const burn = t < tLaunch || t >= tHit ? 0
        : (1 - Math.exp(-age / 0.03)) * (0.6 + 0.4 * Math.exp(-age / 1.5));
      missilePos(t, src);
      missilePos(t - 0.05, a);
      missilePos(t + 0.05, b);
      const dop = doppler(radial(src, a, b, vel));
      set(v.missile.band.frequency, 700 * dop);
      set(v.missile.low.frequency, 200 * dop);
      place(v.missile, src, 1.5 * burn, 110);

      const slew = Math.max(bump(t, tLaunch - 4, tLaunch - 1), bump(t, tLaunch + 3, tLaunch + 6));
      set(v.servo.o.frequency, 170 + 90 * slew);
      src.copy(LAUNCHER_PIVOT).add(shipPos(t, a));
      place(v.servo, src, 0.1 * slew, 25);

      // Impact.
      const e = after(t, tHit);
      const boom = t < tHit ? 0 : (1 - Math.exp(-e / 0.004)) * (0.65 * Math.exp(-e / 0.35) + 0.35 * Math.exp(-e / 1.7));
      set(v.boom.body.frequency, 160 + 3500 * Math.exp(-e / 0.5));
      place(v.boom, scenario.hitPos, 2.4 * boom, 140);
    } else {
      place(v.missile, cam, 0, 1);
      place(v.servo, cam, 0, 1);
      place(v.boom, cam, 0, 1);
    }

    // Sea impacts.
    {
      let s = 0;
      for (const ts of splashTimes) {
        const e = t - ts;
        if (e > 0) s += (1 - Math.exp(-e / 0.01)) * Math.exp(-e / 0.45);
      }
      dronePos(splashTimes.length ? splashTimes[0] : t, src).setY(0);
      place(v.splash, src, 0.5 * Math.min(s, 1.5), 70);
    }

    // Ship hum, wind and surf.
    {
      src.set(-20, 5, 0).add(shipPos(t, a));
      place(v.ship, src, 0.07, 80); // a bed, not a drone over the engine run-up
      const high = smoothstep(cam.y, 5, 200);
      const gust = 0.85 + 0.15 * Math.sin(t * 0.9) * Math.sin(t * 0.37 + 1);
      set(v.wind.bp.frequency, 260 + 9 * camSpeed + 200 * high);
      set(v.wind.g.gain, (0.05 + 0.1 * high + 0.5 * Math.min(camSpeed / 90, 1)) * gust);
      set(v.surf.g.gain, 0.4 * (1 - smoothstep(cam.y, 8, 120)) * (0.8 + 0.2 * Math.sin(t * 0.6)));
    }
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
  };
}

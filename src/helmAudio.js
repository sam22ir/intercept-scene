import * as THREE from 'three';
import { SOUNDS } from './audioAssets.js';

// Sound for the Solo Air Defense mission, driven live from the simulation (helm.js) like the manual flight's: the
// samples are the bundle's ElevenLabs effects (audio.js); the listener is the camera, so loudness falls with
// distance, distant sounds darken, everything pans, and moving sources are Doppler-shifted.
//  beds      the ship's hum and the surf along her side (both with her speed), the wind; the two nearest drones'
//            engines; the motor of each missile in flight.
//  one-shots the missile leaving its cell, the warhead, splashes.
//  synth     the ship's own signals: a two-tone chime for a new radar contact, a rapid alarm for a drone closing
//            or passing, a klaxon while one is on its attack run, and the telegraph's bell.

const SOUND_SPEED = 340;
const { smoothstep, clamp } = THREE.MathUtils;
const att = (d, ref) => ref / (ref + d);
const doppler = (vr) => clamp(SOUND_SPEED / (SOUND_SPEED + vr), 0.5, 2);

const LOOPS = { hum: 'hum', surf: 'surf', wind: 'wind', drone0: 'engine', drone1: 'engine', motor0: 'motor', motor1: 'motor' };
const SHOTS = { launch: { level: 1.0, ref: 110 }, boom: { level: 1.6, ref: 160 }, splash: { level: 0.7, ref: 80 } };

export function createHelmAudio() {
  const AudioCtx = globalThis.AudioContext ?? globalThis.webkitAudioContext;
  let ctx = null;
  let master = null;
  let voices = null;
  let enabled = true;
  let failed = !AudioCtx;
  const buffers = {};
  const cam = new THREE.Vector3();
  const camPrev = new THREE.Vector3();
  const camVel = new THREE.Vector3();
  const right = new THREE.Vector3();
  const camQuat = new THREE.Quaternion();
  const to = new THREE.Vector3();
  const rel = new THREE.Vector3();
  const tmp = new THREE.Vector3();
  let haveCam = false;
  let klaxonNext = 0;

  function bytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out.buffer;
  }
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
    for (const name of [...Object.keys(LOOPS), ...Object.keys(SHOTS)]) voices[name] = chain(name !== 'wind');
    voices.signal = chain(false); // the ship's alarms sound on the bridge, where the listener is
  }
  function startLoop(sample) {
    for (const [voice, name] of Object.entries(LOOPS)) {
      if (name !== sample) continue;
      const s = ctx.createBufferSource();
      s.buffer = buffers[name];
      s.loop = true;
      s.loopStart = 0;
      s.connect(voices[voice].in);
      s.start(0, Math.random() * Math.max(0.01, buffers[name].duration - 0.1)); // the two engines out of step
      voices[voice].src = s;
    }
  }
  // The missile's motor: a rocket's roar, not a whine. Pink noise with a deep rumble under it, the burn flickering
  // a little, and sparse crackles, looped; softened by a low-pass and given some body round 300 Hz. The listener's
  // Doppler shifts its pitch as it passes, and distance darkens it like everything else.
  function rocketBuffer() {
    const sr = ctx.sampleRate;
    const n = Math.floor(sr * 3);
    const buf = ctx.createBuffer(1, n, sr);
    const d = buf.getChannelData(0);
    let b0 = 0; let b1 = 0; let b2 = 0; let brown = 0;
    for (let i = 0; i < n; i++) {
      const w = Math.random() * 2 - 1;
      b0 = 0.99765 * b0 + w * 0.099046;
      b1 = 0.963 * b1 + w * 0.2965164;
      b2 = 0.57 * b2 + w * 1.0526913;
      const pink = (b0 + b1 + b2 + w * 0.1848) * 0.2;
      brown = (brown + 0.02 * w) / 1.02;
      const t = i / sr;
      const flicker = 1 + 0.16 * Math.sin(2 * Math.PI * 9 * t) * Math.sin(2 * Math.PI * 0.8 * t) + 0.08 * Math.sin(2 * Math.PI * 23 * t + 1);
      const crackle = Math.random() < 0.0008 ? (Math.random() * 2 - 1) * 1.4 : 0;
      d[i] = (pink * 0.75 + brown * 4.5 + crackle) * flicker;
    }
    const f = Math.floor(sr * 0.1); // a seamless loop: the end is blended into the start
    for (let i = 0; i < f; i++) { const a = i / f; d[i] = d[i] * a + d[n - f + i] * (1 - a); }
    let peak = 0;
    for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(d[i]));
    for (let i = 0; i < n; i++) d[i] = (d[i] / (peak || 1)) * 0.9;
    return { buf, loopEnd: (n - f) / sr };
  }
  function startRocket() {
    const { buf, loopEnd } = rocketBuffer();
    for (const name of ['motor0', 'motor1']) {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      src.loopStart = 0;
      src.loopEnd = loopEnd;
      const body = ctx.createBiquadFilter();
      body.type = 'peaking';
      body.frequency.value = 300;
      body.gain.value = 5;
      body.Q.value = 0.8;
      const soft = ctx.createBiquadFilter();
      soft.type = 'lowpass';
      soft.frequency.value = 2400;
      soft.Q.value = 0.4;
      src.connect(body);
      body.connect(soft);
      soft.connect(voices[name].in);
      src.start(0, Math.random() * 1.5);
      voices[name].src = src;
    }
  }
  function loadBuffers() {
    for (const name of Object.keys(SOUNDS)) {
      if (name === 'motor') continue; // the missile's motor is synthesised (startRocket), not this recording
      const done = (buf) => { buffers[name] = buf; startLoop(name); };
      try { ctx.decodeAudioData(bytes(SOUNDS[name]), done, () => {})?.catch?.(() => {}); } catch { /* stays silent */ }
    }
  }
  function ensure() {
    if (ctx || failed) return;
    try { ctx = new AudioCtx(); build(); loadBuffers(); startRocket(); } catch { failed = true; ctx = null; }
  }
  const wake = (fromGesture = true) => {
    if (!enabled) return;
    if (!ctx && !fromGesture && !globalThis.navigator?.userActivation?.hasBeenActive) return;
    ensure();
    if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
  };
  for (const ev of ['pointerdown', 'keydown']) globalThis.addEventListener?.(ev, () => wake(true), { passive: true });
  globalThis.document?.addEventListener?.('visibilitychange', () => {
    if (!ctx) return;
    if (document.hidden) ctx.suspend().catch(() => {}); else if (enabled) ctx.resume().catch(() => {});
  });

  const set = (param, value) => param.setTargetAtTime(value, ctx.currentTime, 0.03);
  function place(voice, pos, level, ref) {
    to.subVectors(pos, cam);
    const d = to.length();
    set(voice.g.gain, level * att(d, ref));
    if (voice.lp) set(voice.lp.frequency, clamp(14000 / (1 + d / 140), 400, 14000));
    if (voice.p) set(voice.p.pan, d > 0.5 ? clamp(to.dot(right) / d, -1, 1) * 0.8 : 0);
  }
  function radial(pos, vel) {
    rel.subVectors(vel, camVel);
    to.subVectors(pos, cam);
    const d = to.length();
    return d > 0.5 ? rel.dot(to) / d : 0;
  }
  const loopRate = (voice, rate) => { if (voice.src) set(voice.src.playbackRate, rate); };

  function shot(name, pos) {
    const buf = buffers[name];
    if (!buf || !ctx || !enabled || ctx.state !== 'running') return;
    const node = ctx.createBufferSource();
    node.buffer = buf;
    const v = voices[name];
    to.subVectors(pos, cam);
    const d = to.length();
    v.g.gain.cancelScheduledValues(ctx.currentTime);
    v.g.gain.value = SHOTS[name].level * att(d, SHOTS[name].ref);
    if (v.lp) v.lp.frequency.value = clamp(14000 / (1 + d / 140), 400, 14000);
    if (v.p) v.p.pan.value = d > 0.5 ? clamp(to.dot(right) / d, -1, 1) * 0.8 : 0;
    node.connect(v.in);
    node.start();
  }

  // A synthesised tone on the signal voice: [freq Hz, start s, length s] notes, square or sine.
  function tones(notes, type = 'square', level = 0.12) {
    if (!ctx || !enabled || ctx.state !== 'running') return;
    const t0 = ctx.currentTime;
    set(voices.signal.g.gain, 1);
    for (const [f, at, len] of notes) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = type;
      o.frequency.value = f;
      g.gain.setValueAtTime(0, t0 + at);
      g.gain.linearRampToValueAtTime(level, t0 + at + 0.01);
      g.gain.setValueAtTime(level, t0 + at + len - 0.03);
      g.gain.linearRampToValueAtTime(0, t0 + at + len);
      o.connect(g);
      g.connect(voices.signal.in);
      o.start(t0 + at);
      o.stop(t0 + at + len + 0.02);
    }
  }
  function bell() {
    if (!ctx || !enabled || ctx.state !== 'running') return;
    const t0 = ctx.currentTime;
    set(voices.signal.g.gain, 1);
    for (const [f, lvl] of [[1180, 0.16], [2950, 0.05], [4400, 0.025]]) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'sine';
      o.frequency.value = f;
      g.gain.setValueAtTime(lvl, t0);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 1.4);
      o.connect(g);
      g.connect(voices.signal.in);
      o.start(t0);
      o.stop(t0 + 1.5);
    }
  }

  function event(e) {
    switch (e.type) {
      case 'fire': shot('launch', e.pos); break;
      case 'explosion': case 'struck': shot('boom', e.pos); break;
      case 'splash': shot('splash', e.pos); break;
      case 'missile-lost': if (e.pos.y < 8) shot('splash', e.pos); break;
      case 'telegraph': bell(); break;
      case 'lock': tones([[1320, 0, 0.09], [1760, 0.12, 0.09], [2349, 0.24, 0.2]], 'sine', 0.16); break; // the launcher has caught the target
      case 'alarm':
        if (e.level === 1) tones([[880, 0, 0.18], [660, 0.22, 0.3]], 'sine', 0.18); // new contact
        else if (e.level === 2) tones([0, 1, 2, 3, 4, 5].map((i) => [i % 2 ? 740 : 990, i * 0.14, 0.12])); // closing
        break;
      default: break;
    }
  }

  function update(sim, camera, dt) {
    if (!ctx || failed) return;
    camera.getWorldPosition(cam);
    camera.getWorldQuaternion(camQuat);
    right.set(1, 0, 0).applyQuaternion(camQuat);
    if (haveCam && dt > 0) {
      tmp.subVectors(cam, camPrev).divideScalar(dt);
      if (tmp.length() < 600) camVel.lerp(tmp, 0.2); else camVel.set(0, 0, 0);
    }
    camPrev.copy(cam);
    haveCam = true;
    const live = enabled && ctx.state === 'running' && !globalThis.document?.hidden;
    set(master.gain, live ? 0.9 : 0);
    if (!live) return;
    const v = voices;
    const sp = clamp(Math.abs(sim.u) / 14, 0, 1);
    // The ship: machinery hum amidships, surf along her side, both growing with her speed.
    const ship = tmp.set(sim.x, 6, sim.z);
    place(v.hum, ship, 0.1 + 0.12 * sp, 90);
    loopRate(v.hum, 0.85 + 0.3 * sp);
    place(v.surf, ship, (0.15 + 0.5 * sp) * (1 - smoothstep(cam.y, 20, 300)), 70);
    loopRate(v.wind, 1 + 0.3 * sp);
    set(v.wind.g.gain, 0.12 + 0.12 * smoothstep(cam.y, 5, 200) + 0.1 * sp);
    // The two nearest drones' engines.
    const drones = sim.live.slice().sort((a, b) => a.pos.distanceToSquared(cam) - b.pos.distanceToSquared(cam));
    for (let i = 0; i < 2; i++) {
      const d = drones[i];
      const voice = v[`drone${i}`];
      if (!d) { set(voice.g.gain, 0); continue; }
      loopRate(voice, (d.phase === 'attack' ? 1.25 : 1.1) * doppler(radial(d.pos, d.vel)));
      place(voice, d.pos, 0.7, 60);
    }
    // The missiles' motors.
    for (let i = 0; i < 2; i++) {
      const m = sim.missiles[i];
      const voice = v[`motor${i}`];
      if (!m) { set(voice.g.gain, 0); continue; }
      const age = Math.max(0, sim.t - m.tFire);
      loopRate(voice, clamp(doppler(radial(m.pos, m.vel)), 0.8, 1.25)); // the roar's pitch shifts only a little as it passes
      place(voice, m.pos, 0.6 * (1 - Math.exp(-age / 0.08)) * (0.65 + 0.35 * Math.exp(-age / 1.2)), 110);
    }
    // The klaxon while a drone is on its attack run.
    if (sim.threat >= 3 && sim.t >= klaxonNext) {
      tones([[520, 0, 0.42], [390, 0.45, 0.42]], 'sawtooth', 0.07);
      klaxonNext = sim.t + 1.1;
    }
  }

  return {
    update,
    event,
    reset() { klaxonNext = 0; },
    get enabled() { return enabled; },
    setEnabled(on) { enabled = on; if (on) wake(false); },
    get state() { return ctx?.state ?? (failed ? 'unavailable' : 'idle'); },
    get supported() { return !failed; },
  };
}

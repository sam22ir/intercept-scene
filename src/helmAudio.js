import * as THREE from 'three';
import { SOUNDS } from './audioAssets.js';
import { HIT } from './helmHit.js';
import { HELI_LOOP } from './helmHeli.js';
import { GUN_MOUNTS, GUN_SPIN } from './helm.js';

// Sound for the Solo Air Defense mission, driven live from the simulation (helm.js) like the manual flight's: the
// samples are the bundle's ElevenLabs effects (audio.js); the listener is the camera, so loudness falls with
// distance, distant sounds darken, everything pans, and moving sources are Doppler-shifted.
//  beds      the ship's hum and the surf along her side (both with her speed), the wind; the two nearest drones'
//            engines; the motor of each missile in flight.
//            the deck helicopter: an ElevenLabs recording of a helicopter's rotor chop (helmHeli.js) played at the rotor's speed (until it
//            has decoded, a synthesised blade-slap loop), with a little turbine whine and tail rotor under it, from where she is,
//            Doppler-shifted, loud while the rotor turns.
//  one-shots the missile leaving its cell, the warhead, splashes.
//  synth     the ship's own signals: a two-tone chime for a new radar contact, a rapid alarm for a drone closing
//            or passing, a klaxon while one is on its attack run, and the telegraph's bell.

const SOUND_SPEED = 340;
const { smoothstep, clamp } = THREE.MathUtils;
const att = (d, ref) => ref / (ref + d);
const doppler = (vr) => clamp(SOUND_SPEED / (SOUND_SPEED + vr), 0.5, 2);

const LOOPS = { hum: 'hum', surf: 'surf', wind: 'wind', drone0: 'engine', drone1: 'engine', motor0: 'motor', motor1: 'motor' };
const SHOTS = { launch: { level: 1.0, ref: 110 }, hit: { level: 1.4, ref: 160 }, boom: { level: 1.0, ref: 160 }, splash: { level: 0.7, ref: 80 } };

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
  const heliPos = new THREE.Vector3();
  const heliP = new THREE.Vector3();
  const heliPrev = new THREE.Vector3();
  const heliV = new THREE.Vector3();
  let haveHeli = false;
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
    for (const name of ['gun0', 'gun1', 'spin0', 'spin1', 'heli']) voices[name] = chain(true);
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
  // The rotary guns: about 83 rounds a second, so each round is a sharp crack (a burst of noise that dies in a couple of
  // milliseconds, with the thump of the discharge under it) and together they make the ripping buzz of a rotary cannon.
  // One second of it, looped exactly (a whole number of rounds), every round a little different; the two guns play it at
  // slightly different speeds so they beat against each other. The barrels' spin-up and spin-down is a whining tone.
  function gunBuffer() {
    const sr = ctx.sampleRate;
    const rate = 83;
    const n = sr;
    const buf = ctx.createBuffer(1, n, sr);
    const d = buf.getChannelData(0);
    const len = Math.floor(sr * 0.03);
    for (let k = 0; k < rate; k++) {
      const at = Math.floor((k * sr) / rate);
      const amp = 0.8 + Math.random() * 0.4;
      let lp = 0;
      for (let i = 0; i < len; i++) {
        const t = i / sr;
        const w = Math.random() * 2 - 1;
        lp += (w - lp) * 0.5; // a little dulled
        const crack = (w * 0.55 + lp * 0.7) * Math.exp(-t / 0.0022);
        const thump = Math.sin(2 * Math.PI * (95 - 2200 * t) * t) * Math.exp(-t / 0.011) * 0.9;
        d[(at + i) % n] += (crack + thump) * amp;
      }
    }
    let peak = 0;
    for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(d[i]));
    for (let i = 0; i < n; i++) d[i] = (d[i] / (peak || 1)) * 0.95;
    return buf;
  }
  function startGuns() {
    const buf = gunBuffer();
    for (const [i, name] of ['gun0', 'gun1'].entries()) {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      src.playbackRate.value = i ? 0.965 : 1.0;
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 70;
      const presence = ctx.createBiquadFilter();
      presence.type = 'peaking';
      presence.frequency.value = 1800;
      presence.gain.value = 5;
      presence.Q.value = 0.7;
      src.connect(hp);
      hp.connect(presence);
      presence.connect(voices[name].in);
      src.start(0, i * 0.31);
      voices[name].src = src;
    }
    for (const name of ['spin0', 'spin1']) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = 120;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 900;
      o.connect(lp);
      lp.connect(voices[name].in);
      o.start();
      voices[name].osc = o;
    }
  }
  // The helicopter. The rotor is one pre-rendered loop of four turns of a four-blade rotor (16 blade slaps, 4.8 turns a second at
  // full speed), each slap a low "whop" (a thump falling from about 95 to 45 Hz and a dull burst of low noise), a short sharp crack
  // on top of it and a whoosh of air, every one a little different in strength and timing; it is played at a speed that follows
  // the rotor, so the beat and the pitch fall together as it spins down, as a real one's do. Under it: the turbine's whine and its
  // exhaust rumble, and the tail rotor's buzz, each following the rotor speed too.
  function heliBuffer() {
    const sr = ctx.sampleRate;
    const n = Math.round((sr * 4) / 4.8);
    const buf = ctx.createBuffer(1, n, sr);
    const d = buf.getChannelData(0);
    const slaps = 16;
    const gap = n / slaps;
    const blade = [1, 0.88, 1.06, 0.94]; // the blades are never quite alike
    let brown = 0;
    for (let k = 0; k < slaps; k++) {
      const at = Math.floor(k * gap + (Math.random() - 0.5) * 0.003 * sr);
      const amp = blade[k % 4] * (0.88 + Math.random() * 0.24);
      const len = Math.floor(sr * 0.12);
      let ph = 0;
      let lp = 0;
      for (let i = 0; i < len; i++) {
        const t = i / sr;
        ph += (2 * Math.PI * (95 - 50 * Math.min(1, t / 0.06))) / sr;
        const w = Math.random() * 2 - 1;
        lp += (w - lp) * 0.2;
        brown = (brown + 0.08 * w) / 1.08;
        const thump = Math.sin(ph) * Math.exp(-t / 0.032);
        const crack = (w - lp) * Math.exp(-t / 0.007);
        const body = brown * 5 * Math.exp(-t / 0.045);
        d[(((at + i) % n) + n) % n] += amp * (thump * 1.1 + crack * 0.4 + body);
      }
    }
    // The whoosh between: air noise swelling round each slap.
    let sw = 0;
    for (let i = 0; i < n; i++) {
      const w = Math.random() * 2 - 1;
      sw += (w - sw) * 0.07;
      const ph = ((i % gap) / gap) * Math.PI * 2;
      d[i] += sw * 1.6 * (0.35 + 0.65 * (0.5 - 0.5 * Math.cos(ph)) ** 2);
    }
    let mean = 0;
    let peak = 0;
    for (let i = 0; i < n; i++) mean += d[i];
    mean /= n;
    for (let i = 0; i < n; i++) { d[i] -= mean; peak = Math.max(peak, Math.abs(d[i])); }
    for (let i = 0; i < n; i++) d[i] = (d[i] / (peak || 1)) * 0.9;
    return buf;
  }
  // The recording: both channels mixed, its end blended into its start so the loop has no seam, then swapped in for the synthesised
  // loop (the other voices of the helicopter are turned down, as the recording has its own whine).
  function useHeliSample(buf) {
    const p = voices.heli.parts;
    if (!p) return;
    const sr = buf.sampleRate;
    const n = buf.length;
    const f = Math.floor(sr * 0.15);
    const out = ctx.createBuffer(1, n - f, sr);
    const o = out.getChannelData(0);
    const chans = Array.from({ length: buf.numberOfChannels }, (_, c) => buf.getChannelData(c));
    const at = (i) => chans.reduce((a, c) => a + c[i], 0) / chans.length;
    for (let i = 0; i < n - f; i++) o[i] = i < f ? at(i) * (i / f) + at(n - f + i) * (1 - i / f) : at(i);
    let peak = 0;
    for (let i = 0; i < o.length; i++) peak = Math.max(peak, Math.abs(o[i]));
    for (let i = 0; i < o.length; i++) o[i] = (o[i] / (peak || 1)) * 0.95;
    const src = ctx.createBufferSource();
    src.buffer = out;
    src.loop = true;
    src.playbackRate.value = p.rotor.playbackRate.value;
    src.connect(p.rotorIn);
    src.start();
    try { p.rotor.stop(); } catch { /* already stopped */ }
    p.rotor = src;
    p.sample = true;
  }
  function startHeli() {
    const sr = ctx.sampleRate;
    const out = voices.heli.in;
    const rotor = ctx.createBufferSource();
    rotor.buffer = heliBuffer();
    rotor.loop = true;
    rotor.playbackRate.value = 0.05;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 32;
    const body = ctx.createBiquadFilter();
    body.type = 'peaking';
    body.frequency.value = 110;
    body.gain.value = 4;
    body.Q.value = 0.8;
    const soft = ctx.createBiquadFilter();
    soft.type = 'lowpass';
    soft.frequency.value = 3800;
    const rotorG = ctx.createGain();
    rotorG.gain.value = 0;
    rotor.connect(hp);
    voices.heli.rotorIn = hp;
    hp.connect(body);
    body.connect(soft);
    soft.connect(rotorG);
    rotorG.connect(out);
    // Turbine: a thin whine (two partials) and the exhaust's rumble.
    const whine = ctx.createOscillator();
    whine.type = 'sawtooth';
    whine.frequency.value = 600;
    const whine2 = ctx.createOscillator();
    whine2.type = 'sine';
    whine2.frequency.value = 1200;
    const whineBp = ctx.createBiquadFilter();
    whineBp.type = 'bandpass';
    whineBp.frequency.value = 1500;
    whineBp.Q.value = 0.7;
    const whineG = ctx.createGain();
    whineG.gain.value = 0;
    whine.connect(whineBp);
    whine2.connect(whineBp);
    whineBp.connect(whineG);
    whineG.connect(out);
    const rb = ctx.createBuffer(1, sr * 2, sr);
    const rd = rb.getChannelData(0);
    let brown = 0;
    for (let i = 0; i < rd.length; i++) { brown = (brown + 0.04 * (Math.random() * 2 - 1)) / 1.04; rd[i] = brown * 6; }
    const f = Math.floor(sr * 0.1);
    for (let i = 0; i < f; i++) { const a = i / f; rd[i] = rd[i] * a + rd[rd.length - f + i] * (1 - a); }
    const rumble = ctx.createBufferSource();
    rumble.buffer = rb;
    rumble.loop = true;
    rumble.loopEnd = (rd.length - f) / sr;
    const rumbleLp = ctx.createBiquadFilter();
    rumbleLp.type = 'lowpass';
    rumbleLp.frequency.value = 260;
    const rumbleG = ctx.createGain();
    rumbleG.gain.value = 0;
    rumble.connect(rumbleLp);
    rumbleLp.connect(rumbleG);
    rumbleG.connect(out);
    // The tail rotor's buzz.
    const tail = ctx.createOscillator();
    tail.type = 'sawtooth';
    tail.frequency.value = 80;
    const tailLp = ctx.createBiquadFilter();
    tailLp.type = 'lowpass';
    tailLp.frequency.value = 700;
    const tailG = ctx.createGain();
    tailG.gain.value = 0;
    tail.connect(tailLp);
    tailLp.connect(tailG);
    tailG.connect(out);
    for (const n of [rotor, whine, whine2, rumble, tail]) n.start();
    voices.heli.parts = { rotor, rotorIn: hp, rotorG, whine, whine2, whineG, rumbleG, tail, tailG, sample: false };
  }
  function loadBuffers() {
    try { ctx.decodeAudioData(bytes(HIT), (buf) => { buffers.hit = buf; }, () => {})?.catch?.(() => {}); } catch { /* the burst stays silent */ }
    try { ctx.decodeAudioData(bytes(HELI_LOOP), (buf) => useHeliSample(buf), () => {})?.catch?.(() => {}); } catch { /* the synthesised loop stays */ }
    for (const name of Object.keys(SOUNDS)) {
      if (name === 'motor') continue; // the missile's motor is synthesised (startRocket), not this recording
      const done = (buf) => { buffers[name] = buf; startLoop(name); };
      try { ctx.decodeAudioData(bytes(SOUNDS[name]), done, () => {})?.catch?.(() => {}); } catch { /* stays silent */ }
    }
  }
  function ensure() {
    if (ctx || failed) return;
    try { ctx = new AudioCtx(); build(); loadBuffers(); startRocket(); startGuns(); startHeli(); } catch { failed = true; ctx = null; }
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
    // The burst is rounded off: a deeper pitch and no harsh highs (the raw recording is brittle and clips).
    if (v.lp) v.lp.frequency.value = Math.min(clamp(14000 / (1 + d / 140), 400, 14000), name === 'boom' ? 2800 : 14000);
    if (name === 'boom') node.playbackRate.value = 0.82;
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
      case 'explosion': shot('hit', e.pos); break; // the missile bursting on the drone
      case 'struck': shot('boom', e.pos); break;
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
    // The guns: the crack-train while a gun fires, heard from where it stands (the other gun is a little different), and the
    // whine of its barrels spinning up and down.
    if (sim.guns) {
      for (let i = 0; i < 2; i++) {
        const g = sim.guns[i];
        const pos = sim.toWorld(GUN_MOUNTS[i], tmp);
        place(voices[`gun${i}`], pos, g.firing ? 1.15 : 0, 170);
        const sp = clamp(g.spinRate / GUN_SPIN, 0, 1);
        place(voices[`spin${i}`], pos, 0.07 * sp * sp, 90);
        if (voices[`spin${i}`].osc) set(voices[`spin${i}`].osc.frequency, 90 + 520 * sp);
      }
    }
    // The helicopter on the deck: silent parked, loud as the rotor turns, from wherever she is (in the ship's frame, so it rides
    // with the ship); her motion over the water against the listener's makes the Doppler shift.
    if (v.heli.parts) {
      const st = sim.heli.state;
      sim.toWorld(heliPos.set(st.x, st.y + 1.8, st.z), heliP);
      if (haveHeli && dt > 0) heliV.subVectors(heliP, heliPrev).divideScalar(dt).clampLength(0, 120);
      heliPrev.copy(heliP);
      haveHeli = true;
      const rpm = clamp(st.rpm, 0, 1);
      const dop = doppler(radial(heliP, heliV));
      const p = v.heli.parts;
      set(p.rotor.playbackRate, Math.max(0.05, rpm) * dop);
      set(p.rotorG.gain, (p.sample ? 0.8 : 0.6) * rpm ** 1.1);
      set(p.whine.frequency, (420 + 700 * rpm) * dop);
      set(p.whine2.frequency, (840 + 1400 * rpm) * dop);
      set(p.whineG.gain, (p.sample ? 0.008 : 0.035) * rpm * rpm);
      set(p.rumbleG.gain, (p.sample ? 0.12 : 0.5) * (0.15 + 0.85 * rpm) * (rpm > 0.01 ? 1 : 0));
      set(p.tail.frequency, (30 + 75 * rpm) * dop);
      set(p.tailG.gain, (p.sample ? 0.012 : 0.05) * rpm * rpm);
      place(v.heli, heliP, 0.55, 70); // a background sound: it must not compete with the guns, missiles and alarms
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
    reset() { klaxonNext = 0; haveHeli = false; },
    get enabled() { return enabled; },
    setEnabled(on) { enabled = on; if (on) wake(false); },
    get state() { return ctx?.state ?? (failed ? 'unavailable' : 'idle'); },
    get supported() { return !failed; },
    get heliSample() { return !!voices?.heli?.parts?.sample; }, // the recorded rotor loop has decoded and replaced the synthesised one
  };
}

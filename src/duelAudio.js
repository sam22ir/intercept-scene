import * as THREE from 'three';
import { SOUNDS } from './audioAssets.js';
import { GUN, HIT, SINK, MISSILE, KILL } from './duelAssets.js';

// Sound for the ship duel, driven live from the simulation (duel.js) like Solo Air Defense's (helmAudio.js): the
// samples are the bundle's ElevenLabs effects (audio.js); the listener is the camera, so loudness falls with
// distance, distant sounds darken, everything pans, and a far sound arrives late (sound is slow: the crack of a
// gun across four kilometres comes some twelve seconds after the flash).
//  beds      each ship's hum and the surf along her side (both with her speed), the wind.
//  one-shots the 76 mm firing, a shell bursting on a hull, a ship going down (these three are ElevenLabs effects made for the
//            duel, duelAssets.js), and splashes.
//  synth     the rotary guns' ripping buzz (as in Solo Air Defense), a short alarm when one of your compartments goes.
// Nothing is created until the sound is switched on (the browser wants a gesture first).

const SOUND_SPEED = 340;
const { smoothstep, clamp } = THREE.MathUtils;
const att = (d, ref) => ref / (ref + d);

export function createDuelAudio() {
  const AudioCtx = globalThis.AudioContext ?? globalThis.webkitAudioContext;
  let ctx = null;
  let master = null;
  let enabled = true;
  let failed = !AudioCtx;
  let ready = false;
  const buffers = {};
  const voices = {};
  const cam = new THREE.Vector3();
  const right = new THREE.Vector3();
  const camQuat = new THREE.Quaternion();
  const rel = new THREE.Vector3();

  const bytes = (b64) => { const bin = atob(b64); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out.buffer; };
  function chain(distance = true) {
    const g = ctx.createGain();
    g.gain.value = 0;
    const p = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    if (p) { g.connect(p); p.connect(master); } else g.connect(master);
    let lp = null;
    if (distance) { lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 14000; lp.Q.value = 0.5; lp.connect(g); }
    return { g, p, lp, in: lp ?? g, src: null };
  }
  // The rotary guns: about 83 rounds a second, each a sharp crack with a thump under it, one second looped exactly.
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
        lp += (w - lp) * 0.5;
        d[(at + i) % n] += ((w * 0.55 + lp * 0.7) * Math.exp(-t / 0.0022) + Math.sin(2 * Math.PI * (95 - 2200 * t) * t) * Math.exp(-t / 0.011) * 0.9) * amp;
      }
    }
    let peak = 0;
    for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(d[i]));
    for (let i = 0; i < n; i++) d[i] = (d[i] / (peak || 1)) * 0.95;
    return buf;
  }
  function loop(name, buf, rate = 1, offset = Math.random()) {
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.playbackRate.value = rate;
    src.connect(voices[name].in);
    src.start(0, offset * Math.max(0.01, buf.duration - 0.1));
    voices[name].src = src;
  }
  async function build() {
    master = ctx.createGain();
    master.gain.value = 0;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.ratio.value = 5;
    master.connect(comp);
    comp.connect(ctx.destination);
    for (const name of ['hum0', 'hum1', 'surf0', 'surf1', 'gun0', 'gun1']) voices[name] = chain(true);
    voices.wind = chain(false);
    voices.signal = chain(false); // the ship's own alarm sounds on the bridge, where the listener is
    const names = ['hum', 'surf', 'wind', 'splash'];
    await Promise.all(names.map(async (n) => {
      try { buffers[n] = await ctx.decodeAudioData(bytes(SOUNDS[n])); } catch { /* that sound stays silent */ }
    }));
    for (const [n, b64] of Object.entries({ gun: GUN, hit: HIT, sink: SINK, missile: MISSILE, kill: KILL })) {
      try { buffers[n] = await ctx.decodeAudioData(bytes(b64)); } catch { /* that sound stays silent */ }
    }
    if (buffers.hum) { loop('hum0', buffers.hum); loop('hum1', buffers.hum, 0.97); }
    if (buffers.surf) { loop('surf0', buffers.surf); loop('surf1', buffers.surf, 0.96); }
    if (buffers.wind) loop('wind', buffers.wind);
    const guns = gunBuffer();
    loop('gun0', guns, 1, 0);
    loop('gun1', guns, 0.965, 0.3);
    ready = true;
  }
  function start() {
    if (ctx || failed) return;
    try { ctx = new AudioCtx(); build().catch(() => { failed = true; }); } catch { failed = true; }
  }
  // The first user gesture starts the audio context (browsers insist).
  const unlock = () => {
    start();
    if (ctx?.state === 'suspended') ctx.resume();
    if (ctx && master) master.gain.setTargetAtTime(enabled ? 0.9 : 0, ctx.currentTime, 0.05);
  };
  if (!failed) for (const ev of ['pointerdown', 'keydown']) window.addEventListener(ev, unlock, { passive: true });

  // Where a world point is, as the camera hears it: its distance and its pan (-1 left .. 1 right).
  function listen(p) {
    rel.set(p[0] - cam.x, p[1] - cam.y, p[2] - cam.z);
    const d = rel.length();
    return { d, pan: d > 1 ? clamp(rel.dot(right) / d, -1, 1) : 0 };
  }
  function set(v, gain, d, pan = 0, dark = true) {
    const t = ctx.currentTime;
    v.g.gain.setTargetAtTime(gain, t, 0.08);
    if (v.p) v.p.pan.setTargetAtTime(pan, t, 0.08);
    if (v.lp && dark) v.lp.frequency.setTargetAtTime(clamp(14000 / (1 + d / 400), 700, 14000), t, 0.1);
  }
  // A one-shot at a world point: gain falls with distance, the sound arrives after d / 340 s.
  function shot(name, p, { level = 1, ref = 160, rate = 1 } = {}) {
    if (!ready || !buffers[name] || !enabled) return;
    const { d, pan } = listen(p);
    const src = ctx.createBufferSource();
    src.buffer = buffers[name];
    src.playbackRate.value = rate * (0.94 + Math.random() * 0.12);
    const v = chain(true);
    v.g.gain.value = level * att(d, ref);
    if (v.p) v.p.pan.value = pan;
    v.lp.frequency.value = clamp(14000 / (1 + d / 400), 700, 14000);
    src.connect(v.in);
    src.start(ctx.currentTime + Math.min(d / SOUND_SPEED, 20));
    src.onended = () => { try { v.g.disconnect(); } catch { /* gone */ } };
  }
  // A short two-tone alarm on the bridge.
  function beep() {
    if (!ready || !enabled) return;
    const t = ctx.currentTime;
    for (const [k, f] of [[0, 880], [0.16, 660], [0.32, 880]]) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'square';
      o.frequency.value = f;
      g.gain.setValueAtTime(0, t + k);
      g.gain.linearRampToValueAtTime(0.1, t + k + 0.01);
      g.gain.linearRampToValueAtTime(0, t + k + 0.12);
      o.connect(g);
      g.connect(voices.signal.in);
      o.start(t + k);
      o.stop(t + k + 0.14);
    }
    voices.signal.g.gain.value = 1;
  }

  return {
    get supported() { return !failed; },
    get enabled() { return enabled; },
    setEnabled(on) {
      enabled = on;
      if (on) start();
      if (ctx && master) master.gain.setTargetAtTime(on ? 0.9 : 0, ctx.currentTime, 0.05);
    },
    reset() { /* the loops run on; the one-shots die by themselves */ },
    // The simulation's events (duel.js): a shot, a hit, a splash, a compartment out, a ship sunk.
    event(e) {
      if (!ready) return;
      if (e.type === 'shot') shot('gun', e.pos, { level: 1.1, ref: 220, rate: 1 });
      else if (e.type === 'hit') shot('hit', e.pos, { level: 1.3, ref: 200, rate: 1 });
      else if (e.type === 'splash') shot('splash', e.pos, { level: 0.8, ref: 90, rate: 0.9 });
      else if (e.type === 'out' && e.ship === 0) beep();
      else if (e.type === 'mslLaunch') shot('missile', e.pos, { level: 1.2, ref: 260, rate: 1 });
      else if (e.type === 'mslKilled') shot('kill', e.pos, { level: 1.3, ref: 240, rate: 1 });
      else if (e.type === 'mslHit') shot('hit', e.pos, { level: 1.6, ref: 260, rate: 0.85 });
      else if (e.type === 'lockon' && e.ship === 0) beep();
      else if (e.type === 'sunk') shot('sink', e.pos, { level: 1.5, ref: 500, rate: 1 });
    },
    // Every frame: the beds and the guns, from the ships' state and the camera.
    update(sim, camera) {
      if (!ready || !enabled) return;
      cam.copy(camera.position);
      camera.getWorldQuaternion(camQuat);
      right.set(1, 0, 0).applyQuaternion(camQuat);
      for (const s of sim.ships) {
        const i = s.idx;
        const { d, pan } = listen([s.x, 8, s.z]);
        const sunk = s.tSunk !== null;
        const speed = clamp(Math.abs(s.u) / 14, 0, 1.4);
        set(voices[`hum${i}`], (sunk ? 0 : 0.08 + 0.22 * speed) * att(d, 180), d, pan);
        set(voices[`surf${i}`], (sunk ? 0.05 : 0.04 + 0.3 * speed * smoothstep(speed, 0, 0.3)) * att(d, 140), d, pan);
        const firing = s.gats.some((g) => g.firing);
        const gunPos = listen(sim.toWorld(s, [-33.6, 13, 0]));
        set(voices[`gun${i}`], firing ? 0.9 * att(gunPos.d, 150) : 0, gunPos.d, gunPos.pan);
        if (voices[`gun${i}`].src) voices[`gun${i}`].src.playbackRate.setTargetAtTime(0.98 + s.gats[0].spinRate / 4000, ctx.currentTime, 0.1);
      }
      set(voices.wind, 0.12, 0, 0, false);
    },
  };
}

import { SOUNDS } from './audioAssets.js';
import { HORN_MP3 } from './maneuverAssets.js';

// Sound for the harbour mission, driven live by the simulation like Solo Air Defense's: the engine's hum pitched by the
// telegraph and her speed, the water along her hull, the thrusters' whine, a light wind; one-shots for the telegraph's bell,
// the ship's horn (B), the lines going and a contact against a quay (a dull clunk, louder the harder). The loops and the clunk
// are the embedded samples of audioAssets.js, the horn the drill's (maneuverAssets.js); the bell is synthesised.
const toBuffer = (b64) => {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
};

export function createHarbourAudio() {
  const AudioCtx = globalThis.AudioContext ?? globalThis.webkitAudioContext;
  let ctx = null, master = null, failed = !AudioCtx, enabled = true;
  const buf = {};
  const loops = {};
  let hornSrc = null;

  function ensure() {
    if (ctx || failed) return;
    try {
      ctx = new AudioCtx();
      const comp = ctx.createDynamicsCompressor();
      master = ctx.createGain();
      master.gain.value = 0.7;
      master.connect(comp);
      comp.connect(ctx.destination);
    } catch { failed = true; ctx = null; return; }
    const want = { hum: SOUNDS.hum, surf: SOUNDS.surf, wind: SOUNDS.wind, motor: SOUNDS.motor, engine: SOUNDS.engine, clunk: SOUNDS.clunk, splash: SOUNDS.splash, horn: HORN_MP3 };
    for (const [k, v] of Object.entries(want)) ctx.decodeAudioData(toBuffer(v)).then((b) => { buf[k] = b; if (['hum', 'surf', 'wind', 'motor', 'engine'].includes(k)) startLoop(k); }).catch(() => {});
  }
  function startLoop(k) {
    const src = ctx.createBufferSource();
    src.buffer = buf[k];
    src.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 1800;
    const g = ctx.createGain();
    g.gain.value = 0;
    src.connect(lp).connect(g).connect(master);
    src.start();
    loops[k] = { src, g, lp };
  }
  const wake = () => { if (!enabled) return; ensure(); if (ctx?.state === 'suspended') ctx.resume().catch(() => {}); };
  for (const ev of ['pointerdown', 'keydown']) globalThis.addEventListener?.(ev, wake, { passive: true });
  globalThis.document?.addEventListener('visibilitychange', () => {
    if (!ctx) return;
    if (document.hidden) ctx.suspend().catch(() => {});
    else if (enabled) ctx.resume().catch(() => {});
  });

  const set = (k, gain, rate, cutoff) => {
    const l = loops[k];
    if (!l) return;
    const t = ctx.currentTime;
    l.g.gain.setTargetAtTime(gain, t, 0.25);
    if (rate) l.src.playbackRate.setTargetAtTime(rate, t, 0.4);
    if (cutoff) l.lp.frequency.setTargetAtTime(cutoff, t, 0.3);
  };
  function shot(k, gain = 1, rate = 1) {
    if (!ctx || !buf[k] || !enabled) return null;
    const src = ctx.createBufferSource();
    src.buffer = buf[k];
    src.playbackRate.value = rate;
    const g = ctx.createGain();
    g.gain.value = gain;
    src.connect(g).connect(master);
    src.start();
    return src;
  }
  // The engine-room telegraph's bell: two quick strikes.
  function bell() {
    if (!ctx || !enabled) return;
    for (const dt of [0, 0.16]) {
      const t = ctx.currentTime + dt;
      for (const [f, a] of [[1320, 0.18], [2650, 0.06], [3960, 0.03]]) {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.frequency.value = f;
        g.gain.setValueAtTime(a, t);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
        o.connect(g).connect(master);
        o.start(t);
        o.stop(t + 1);
      }
    }
  }

  // The general alarm: a harsh two-tone warble for three seconds (man overboard).
  function generalAlarm() {
    if (!ctx || !enabled) return;
    const t0 = ctx.currentTime;
    const o = ctx.createOscillator(), g = ctx.createGain(), lp = ctx.createBiquadFilter();
    o.type = 'square';
    lp.type = 'lowpass'; lp.frequency.value = 2400;
    for (let i = 0; i < 12; i++) o.frequency.setValueAtTime(i % 2 ? 620 : 880, t0 + i * 0.25);
    g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(0.16, t0 + 0.05);
    g.gain.setValueAtTime(0.16, t0 + 2.9); g.gain.exponentialRampToValueAtTime(0.0001, t0 + 3.1);
    o.connect(lp).connect(g).connect(master);
    o.start(t0); o.stop(t0 + 3.2);
  }

  // A VHF transmission: a short burst of squelch noise and the roger beep.
  function radioChirp() {
    if (!ctx || !enabled) return;
    const t0 = ctx.currentTime, n = Math.floor(ctx.sampleRate * 0.18);
    const b = ctx.createBuffer(1, n, ctx.sampleRate), d = b.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
    const src = ctx.createBufferSource(), bp = ctx.createBiquadFilter(), g = ctx.createGain();
    src.buffer = b; bp.type = 'bandpass'; bp.frequency.value = 1800; bp.Q.value = 0.8; g.gain.value = 0.08;
    src.connect(bp).connect(g).connect(master);
    src.start(t0);
    const o = ctx.createOscillator(), og = ctx.createGain();
    o.frequency.value = 1250;
    og.gain.setValueAtTime(0.0001, t0 + 0.2); og.gain.exponentialRampToValueAtTime(0.06, t0 + 0.22); og.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.34);
    o.connect(og).connect(master);
    o.start(t0 + 0.2); o.stop(t0 + 0.36);
  }

  return {
    get supported() { return !failed; },
    get enabled() { return enabled; },
    setEnabled(on) { enabled = on; if (on) wake(); if (master) master.gain.value = on ? 0.7 : 0; },
    reset() { try { hornSrc?.stop(); } catch { /* already stopped */ } hornSrc = null; },
    // `inside`: how far into her the camera is (1 on the bridge: the engine is a muffled hum, the water quieter)
    update(sim, onBoard = 0) {
      if (!ctx || !enabled) return;
      const kn = Math.abs(sim.u) / 0.514444;
      const order = Math.abs(sim.ordered ?? 0);
      set('hum', 0.22 + 0.05 * Math.min(order, 16) / 16, 0.8 + 0.35 * Math.min(order, 16) / 16, 700 + 900 * (1 - onBoard));
      set('engine', 0.05 * Math.min(order, 16) / 16 * (1 - 0.6 * onBoard), 0.45 + 0.2 * Math.min(order, 16) / 16, 900);
      set('surf', Math.min(kn / 10, 1) * 0.5 * (1 - 0.5 * onBoard), 0.85 + 0.03 * kn, 1200 + 200 * kn);
      set('wind', 0.06 + 0.02 * Math.min(kn / 10, 1), 1, 1400);
      const thr = Math.max(Math.abs(sim.thr.yaw), Math.abs(sim.thr.sway));
      set('motor', 0.16 * thr, 0.35 + 0.1 * thr, 900);
    },
    event(e) {
      if (!ctx || !enabled) return;
      if (e.type === 'telegraph') bell();
      else if (e.type === 'alarm') { generalAlarm(); this.horn(3.2); }
      else if (e.type === 'contact') shot('clunk', Math.min(0.25 + e.hit * 0.9, 1.2), 0.6);
      else if (e.type === 'say' && e.sound === 'lines') { shot('splash', 0.35, 1.6); setTimeout(() => shot('splash', 0.25, 1.8), 900); }
      else if (e.type === 'vhf') radioChirp();
    },
    horn(len = 2.4) {
      if (!ctx || !buf.horn || !enabled) return;
      try { hornSrc?.stop(); } catch { /* already stopped */ }
      const src = ctx.createBufferSource();
      src.buffer = buf.horn;
      src.playbackRate.value = 0.82;
      const g = ctx.createGain();
      const t = ctx.currentTime;
      g.gain.setValueAtTime(0.9, t);
      g.gain.setTargetAtTime(0, t + len, 0.15);
      src.connect(g).connect(master);
      src.start();
      src.stop(t + len + 1);
      hornSrc = src;
    },
  };
}

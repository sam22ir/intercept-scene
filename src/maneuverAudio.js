import { CUES } from './maneuvers.js';
import { HORN_MP3, CLICK_MP3 } from './maneuverAssets.js';

// Sound for the naval maneuvers mission: ship horns on the orders and serials, and a click for each
// flash of the signal lamp. The horn and the click are ElevenLabs sound effects (text-to-sound v2),
// embedded as base64 in maneuverAssets.js so the offline file needs nothing else; if they cannot be
// decoded the same sounds are synthesised instead. The cues come from the model (maneuvers.js CUES,
// in sim time); each frame the ones the clock just passed are played. Scrubbing, jumping and playing
// backwards are silent, like the intercept mission's one-shots. Sounds are quieter with the camera's
// distance from the ship that makes them.

const HORN_PITCH = { ship1: [98, 123], ship2: [110, 139], unit: [82, 104] }; // Hz, for the synthesised fallback
const HORN_RATE = { ship1: 1, ship2: 1.14, unit: 0.86 }; // playback rate of the recorded horn
const CLICK_OFFSET = 0.4; // s of lead-in silence before the click in its file
const MAX_STEP = 3; // s of sim time per frame beyond which the clock jumped (a scrub), so nothing plays

const toBuffer = (b64) => {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
};

export function createManeuverAudio() {
  const AudioCtx = globalThis.AudioContext ?? globalThis.webkitAudioContext;
  let ctx = null;
  let master = null;
  let noise = null; // fallback click
  let samples = null; // { horn, click } decoded AudioBuffers
  let enabled = true;
  let failed = !AudioCtx;
  let lastT = NaN;

  function ensure() {
    if (ctx || failed) return;
    try {
      ctx = new AudioCtx();
      const comp = ctx.createDynamicsCompressor();
      master = ctx.createGain();
      master.gain.value = 0.8;
      master.connect(comp);
      comp.connect(ctx.destination);
      // One second of white noise for the fallback click.
      noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const d = noise.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    } catch {
      failed = true;
      ctx = null;
      return;
    }
    // The recorded sounds decode in the background; until then (or if that fails) the synthesised ones play.
    Promise.all([ctx.decodeAudioData(toBuffer(HORN_MP3)), ctx.decodeAudioData(toBuffer(CLICK_MP3))])
      .then(([horn, click]) => { samples = { horn, click }; })
      .catch(() => { samples = null; });
  }

  // Browsers keep a context suspended until a user gesture; resume on the first one.
  const wake = (fromGesture = true) => {
    if (!enabled) return;
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

  // The recorded horn, trimmed (with a short fade) when the cue is shorter than the sample.
  function hornSample(ship, len, gain) {
    const now = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = samples.horn;
    src.playbackRate.value = HORN_RATE[ship];
    const out = ctx.createGain();
    const play = Math.min(len + 0.4, samples.horn.duration / HORN_RATE[ship]);
    out.gain.setValueAtTime(gain, now);
    if (play < samples.horn.duration / HORN_RATE[ship] - 0.05) {
      out.gain.setValueAtTime(gain, now + Math.max(play - 0.3, 0.05));
      out.gain.linearRampToValueAtTime(0, now + play);
    }
    src.connect(out);
    out.connect(master);
    src.start(now);
    src.stop(now + play + 0.05);
  }

  function hornSynth(ship, len, gain) {
    const now = ctx.currentTime;
    const out = ctx.createGain();
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 1000;
    out.gain.setValueAtTime(0, now);
    out.gain.linearRampToValueAtTime(gain, now + 0.18);
    out.gain.setValueAtTime(gain, now + Math.max(len - 0.35, 0.2));
    out.gain.linearRampToValueAtTime(0, now + len + 0.25);
    for (const f of HORN_PITCH[ship]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = f;
      o.connect(lp);
      o.start(now);
      o.stop(now + len + 0.3);
    }
    lp.connect(out);
    out.connect(master);
  }

  function click(gain) {
    const now = ctx.currentTime;
    const src = ctx.createBufferSource();
    if (samples) {
      src.buffer = samples.click;
      src.playbackRate.value = 0.94 + Math.random() * 0.14; // no two flashes sound identical
      const g = ctx.createGain();
      g.gain.value = gain;
      src.connect(g);
      g.connect(master);
      src.start(now, CLICK_OFFSET, 0.4);
      return;
    }
    src.buffer = noise;
    src.playbackRate.value = 1.3;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 2400;
    bp.Q.value = 3;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.05);
    src.connect(bp);
    bp.connect(g);
    g.connect(master);
    src.start(now, Math.random() * 0.5, 0.06);
  }

  const gainAt = (cam, pos) => Math.min(Math.max(900 / (cam.position.distanceTo(pos) + 250), 0.1), 1);

  return {
    get enabled() { return enabled; },
    get supported() { return !failed; },
    get recorded() { return !!samples; }, // for inspection: true once the ElevenLabs sounds have decoded
    setEnabled(on) { enabled = on; if (on) wake(false); },
    // positions: {ship1, ship2, unit} world positions of the ships; clock: {playing, direction}.
    update(t, camera, positions, clock) {
      const prev = lastT;
      lastT = t;
      if (!enabled || !ctx || ctx.state !== 'running' || Number.isNaN(prev)) return;
      const dt = t - prev;
      if (dt <= 0 || dt > MAX_STEP || !clock.playing || clock.direction < 0) return;
      for (const c of CUES) {
        if (c.t <= prev) continue;
        if (c.t > t) break;
        const g = gainAt(camera, positions[c.ship]);
        if (c.kind === 'horn') (samples ? hornSample : hornSynth)(c.ship, c.len, 0.6 * g);
        else click(0.9 * g);
      }
    },
  };
}

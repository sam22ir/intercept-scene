// The maneuvers mission's sound (src/maneuverAudio.js), against a stand-in AudioContext: the
// recorded ElevenLabs horn per order and click per lamp flash, the synthesised fallback when the
// recordings cannot be decoded, and silence while scrubbing, jumping or playing backwards.

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { PHASES, CUES, LIGHT } from '../src/maneuvers.js';
import { HORN_MP3, CLICK_MP3 } from '../src/maneuverAssets.js';

let made = { oscillators: 0, sources: 0 };
const param = () => ({ value: 0, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} });
const makeContext = (decodes) => class FakeContext {
  constructor() { this.currentTime = 0; this.sampleRate = 8000; this.state = 'running'; this.destination = {}; }
  createDynamicsCompressor() { return { connect() {} }; }
  createGain() { return { gain: param(), connect() {} }; }
  createBuffer() { return { duration: 1, getChannelData: () => new Float32Array(8000) }; }
  createOscillator() { made.oscillators++; return { type: '', frequency: param(), connect() {}, start() {}, stop() {} }; }
  createBiquadFilter() { return { type: '', frequency: param(), Q: param(), connect() {} }; }
  createBufferSource() { made.sources++; return { buffer: null, playbackRate: param(), connect() {}, start() {}, stop() {} }; }
  decodeAudioData(bytes) { return decodes ? Promise.resolve({ duration: bytes.byteLength > 40000 ? 3 : 1 }) : Promise.reject(new Error('cannot decode')); }
  resume() { return Promise.resolve(); }
  suspend() { return Promise.resolve(); }
};

const cam = { position: { distanceTo: () => 100 } };
const positions = { ship1: {}, ship2: {} };
const playing = { playing: true, direction: 1 };
const tick = () => new Promise((r) => setTimeout(r, 0));

async function build(decodes, tag) {
  const handlers = {};
  globalThis.AudioContext = makeContext(decodes);
  globalThis.addEventListener = (ev, fn) => { handlers[ev] = fn; };
  const { createManeuverAudio } = await import(`../src/maneuverAudio.js?${tag}`);
  const audio = createManeuverAudio();
  handlers.pointerdown(); // the first user gesture creates the context
  await tick();
  await tick();
  return audio;
}

const step = (audio, from, to, clock = playing) => {
  made = { oscillators: 0, sources: 0 };
  audio.update(from, cam, positions, clock);
  audio.update(to, cam, positions, clock);
  return { ...made };
};

describe('embedded sound effects', () => {
  it('are real mp3 data (ID3 or an MPEG frame sync at the start)', () => {
    for (const b64 of [HORN_MP3, CLICK_MP3]) {
      const bytes = Buffer.from(b64, 'base64');
      assert.ok(bytes.length > 5000, 'not empty');
      assert.ok(bytes.subarray(0, 3).toString() === 'ID3' || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0));
    }
  });
});

describe('maneuver audio with the recorded sounds', () => {
  let audio;
  before(async () => { audio = await build(true, 'recorded'); });

  it('has decoded the recordings', () => assert.equal(audio.recorded, true));

  it('plays the recorded horn (one buffer source) as an order executes', () => {
    const tx = PHASES[2].tx;
    assert.deepEqual(step(audio, tx - 0.2, tx + 0.2), { oscillators: 0, sources: 1 });
  });

  it('plays each cue once, then not again', () => {
    const tx = PHASES[4].tx;
    audio.update(tx - 0.5, cam, positions, playing);
    made = { oscillators: 0, sources: 0 };
    audio.update(tx + 0.1, cam, positions, playing);
    audio.update(tx + 0.2, cam, positions, playing);
    assert.equal(made.sources, 1);
  });

  it('clicks at the start of a lamp flash', () => {
    const click = CUES.find((c) => c.kind === 'click' && c.t > LIGHT.t0);
    assert.equal(step(audio, click.t - 0.02, click.t + 0.02).sources, 1);
  });

  it('is silent when scrubbing (a big jump), playing backwards or paused', () => {
    const tx = PHASES[3].tx;
    const none = { oscillators: 0, sources: 0 };
    assert.deepEqual(step(audio, tx - 50, tx + 50), none);
    assert.deepEqual(step(audio, tx + 0.2, tx - 0.2), none);
    assert.deepEqual(step(audio, tx - 0.2, tx + 0.2, { playing: true, direction: -1 }), none);
    assert.deepEqual(step(audio, tx - 0.2, tx + 0.2, { playing: false, direction: 1 }), none);
  });

  it('is silent when switched off', () => {
    audio.setEnabled(false);
    const tx = PHASES[5].tx;
    assert.deepEqual(step(audio, tx - 0.2, tx + 0.2), { oscillators: 0, sources: 0 });
    audio.setEnabled(true);
  });
});

describe('maneuver audio when the recordings cannot be decoded', () => {
  it('falls back to the synthesised horn (two tones) and click', async () => {
    const audio = await build(false, 'synth');
    assert.equal(audio.recorded, false);
    const tx = PHASES[2].tx;
    assert.deepEqual(step(audio, tx - 0.2, tx + 0.2), { oscillators: 2, sources: 0 });
    const click = CUES.find((c) => c.kind === 'click' && c.t > LIGHT.t0);
    assert.equal(step(audio, click.t - 0.02, click.t + 0.02).sources, 1);
  });
});

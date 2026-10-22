// The sea's wave table (src/seaWaves.js): the heights match the significant wave height asked for, the table is deterministic,
// no crest loops, and a hull rides the surface under her.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { WAVES, makeSea, significantHeight, seaHeight, seaSlope, seaTilt } from '../src/seaWaves.js';

const std = (sea) => {
  const xs = [];
  for (let i = 0; i < 4000; i++) xs.push(seaHeight(sea, (i * 37.7) % 3000, (i * 91.3) % 3000, i * 0.37));
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
};

describe('the sea table', () => {
  it('maps the sea state to the Douglas scale, rising with the state', () => {
    let last = -1;
    for (const s of [0.4, 0.7, 1, 1.7, 2.5, 3.4, 4.4, 5.4]) { const h = significantHeight(s); assert.ok(h > last, `Hs rises at ${s}`); last = h; }
    assert.ok(significantHeight(1.7) > 1.25 && significantHeight(1.7) < 2.5, 'moderate');
    assert.ok(significantHeight(5.4) > 8 && significantHeight(5.4) < 9, 'very high waves');
  });
  it('makes waves whose height has the right spread (Hs = 4 sigma), and the same ones every time', () => {
    for (const s of [0.4, 1.0, 1.7, 3.4, 5.4]) {
      const sea = makeSea(s, 2.5);
      assert.equal(sea.waves.length, WAVES);
      const hs = 4 * std(sea);
      assert.ok(Math.abs(hs - sea.Hs) / sea.Hs < 0.3, `state ${s}: measured Hs ${hs.toFixed(2)} for ${sea.Hs.toFixed(2)}`);
    }
    assert.deepEqual(makeSea(2, 1).waves, makeSea(2, 1).waves);
  });
  it('keeps the crests from folding over (the Gerstner steepness sum stays under 1) and the slopes sane', () => {
    for (const s of [1, 3.4, 5.4]) {
      const sea = makeSea(s, 0);
      const sum = sea.waves.reduce((t, w) => t + w.Q * w.k * w.a, 0);
      assert.ok(sum <= 0.71, `state ${s}: sum ${sum}`);
      let worst = 0;
      for (let i = 0; i < 2000; i++) { const [sx, sz] = seaSlope(sea, i * 3.1, i * 1.7, i * 0.2); worst = Math.max(worst, Math.hypot(sx, sz)); }
      assert.ok(worst < 1.2, `state ${s}: steepest slope ${worst}`);
    }
  });
  it('waves travel: the surface at a point changes with time, and long waves go faster than short ones', () => {
    const sea = makeSea(2, 0);
    assert.notEqual(seaHeight(sea, 10, 20, 0), seaHeight(sea, 10, 20, 3));
    const ws = sea.waves.map((w) => w.w / w.k); // phase speed
    assert.ok(ws[0] > ws[WAVES - 1] * 3, 'the longest swell outruns the shortest chop');
  });
  it('a hull follows the surface: heave, pitch and roll are finite and grow with the sea', () => {
    const calm = makeSea(0.4, 0), rough = makeSea(5.4, 0);
    const spread = (sea) => { let m = 0; for (let i = 0; i < 400; i++) { const t = seaTilt(sea, 100, 50, 0.3, i * 0.9); assert.ok(Number.isFinite(t.heave + t.pitch + t.roll)); m = Math.max(m, Math.abs(t.heave)); } return m; };
    assert.ok(spread(rough) > 4 * spread(calm));
  });
});

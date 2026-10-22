import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LOOKS, WEATHERS, resolveLook, lookFor, todAt, fromDisplay, displayOf } from '../src/looks.js';

test('fromDisplay round-trips through ACES', () => {
  for (const c of [[170, 200, 232], [240, 188, 134], [92, 102, 116], [46, 64, 128], [248, 140, 92]]) {
    const d = displayOf(fromDisplay(c));
    for (let i = 0; i < 3; i++) assert.ok(Math.abs(d[i] - c[i]) <= 2, `${c} -> ${d}`);
  }
});

test('every look resolves under every weather', () => {
  for (const name of Object.keys(LOOKS)) {
    for (const w of [undefined, ...WEATHERS]) {
      const L = resolveLook(name, w);
      assert.ok(L.fog[0] < L.fog[1]);
      assert.ok(L.sunI > 0 && L.env > 0);
      for (const k of ['horizon', 'zenith']) for (const v of L[k]) assert.ok(v >= 0 && v <= 255);
      assert.ok(L.sea.state > 0);
    }
  }
});

test('weather overrides the default and is deterministic', () => {
  const a = resolveLook('intercept', 'squalls');
  assert.equal(a.weather, 'squalls');
  assert.ok(a.squalls > 0);
  assert.deepEqual(a, resolveLook('intercept', 'squalls'));
  assert.equal(resolveLook('intercept', 'nonsense').weather, LOOKS.intercept.weather);
  assert.equal(resolveLook('duel', 'clear').weather, 'clear');
});

test('time of day: lower sun is warmer and dimmer', () => {
  const low = todAt(5);
  const high = todAt(40);
  assert.ok(low.horizon[0] > low.horizon[2], 'a low sun has a warm horizon');
  assert.ok(low.sunI < high.sunI);
  assert.ok(todAt(-10).sunI > 0 && todAt(90).sunI > 0, 'out-of-range elevations clamp');
});

test('overcast darkens and greys the sky; duel is the roughest sea', () => {
  const clear = resolveLook('chute');
  const grey = resolveLook('duel');
  assert.ok(grey.sunI < clear.sunI);
  assert.ok(Math.max(...grey.horizon) - Math.min(...grey.horizon) < Math.max(...clear.horizon) - Math.min(...clear.horizon));
  assert.ok(grey.sea.state > clear.sea.state && grey.sea.caps > clear.sea.caps);
  assert.ok(grey.sea.glitter < clear.sea.glitter);
});

test('missions map to looks; the drills and Solo Air Defense keep the calm look', () => {
  assert.equal(lookFor('intercept'), 'intercept');
  assert.equal(lookFor('chute'), 'chute');
  assert.equal(lookFor('fly'), 'fly');
  assert.equal(lookFor('duel'), 'duel');
  for (const m of ['maneuvers', 'maneuvers2', 'formations', 'helm']) assert.equal(lookFor(m), null);
});

test('the calm look keeps its original constants', () => {
  const src = readFileSync(new URL('../src/environment.js', import.meta.url), 'utf8');
  assert.match(src, /CALM_HORIZON = new THREE\.Color\(0\.06, 0\.56, 3\.0\)/);
  assert.match(src, /CALM_ZENITH = new THREE\.Color\(0, 0\.16, 1\.4\)/);
  assert.match(src, /uDeep: \{ value: calm \? new THREE\.Color\(0\.012, 0\.075, 0\.13\)/);
});

test('a look keeps its own numbers under its own default weather; others change them by the difference', () => {
  const d = resolveLook('duel');
  assert.deepEqual(d.fog, LOOKS.duel.fog);
  assert.ok(Math.abs(d.sea.state - LOOKS.duel.sea.state) < 1e-9);
  assert.equal(resolveLook('intercept').fog[1], LOOKS.intercept.fog[1]);
  assert.ok(resolveLook('duel', 'clear').overcast < 0.2, 'clear weather clears the duel sky');
  assert.ok(resolveLook('duel', 'clear').sea.state < d.sea.state);
  assert.ok(resolveLook('intercept', 'clear').fog[1] > LOOKS.intercept.fog[1]);
});

test('the duel is never fought in fog: fog far exceeds the main gun range under every weather', async () => {
  const { MAIN_RANGE } = await import('../src/duel.js');
  for (const w of WEATHERS) assert.ok(resolveLook('duel', w).fog[1] > MAIN_RANGE * 1.1, `${w}: ${resolveLook('duel', w).fog}`);
});

test('the sea mirrors the sky through display-space stops, warm at the horizon and blue above', () => {
  const L = resolveLook('intercept', 'clear');
  assert.equal(L.skyStops.length, 4);
  assert.deepEqual(L.skyStops[0], L.horizon);
  assert.deepEqual(L.skyStops[3], L.zenith);
  assert.ok(L.skyStops[0][0] > L.skyStops[0][2], 'warm at the horizon');
  assert.ok(L.skyStops[3][2] > L.skyStops[3][0], 'blue overhead');
});

// Deep links: URL building/parsing (src/share.js) and the #path= override in scenario.js.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildShareUrl, readShareParams } from '../src/share.js';

const base = 'https://example.test/app/?ship=aft&mode=chute&t=99&focus=x#old';

describe('share url', () => {
  it('writes ship, mode, rounded t and focus, and drops old params', () => {
    const u = new URL(buildShareUrl({ ship: 'fwd', mode: 'intercept', t: 12.3456, focus: 'ship', director: false, path: null }, base));
    assert.equal(u.searchParams.get('ship'), 'fwd');
    assert.equal(u.searchParams.get('mode'), 'intercept');
    assert.equal(u.searchParams.get('t'), '12.35');
    assert.equal(u.searchParams.get('focus'), 'ship');
    assert.equal(u.hash, '');
  });
  it('uses cam=director instead of focus, and omits focus=free', () => {
    const d = new URL(buildShareUrl({ ship: 'fwd', mode: 'intercept', t: 1, focus: 'plane', director: true, path: null }, base));
    assert.equal(d.searchParams.get('cam'), 'director');
    assert.equal(d.searchParams.get('focus'), null);
    const f = new URL(buildShareUrl({ ship: 'fwd', mode: 'intercept', t: 1, focus: 'free', director: false, path: null }, base));
    assert.equal(f.searchParams.get('focus'), null);
  });
  it('round-trips t and focus through readShareParams', () => {
    const u = new URL(buildShareUrl({ ship: 'fwd', mode: 'intercept', t: 7.77, focus: 'plane', director: false, path: null }, base));
    assert.deepEqual(readShareParams(u.search), { t: 7.77, focus: 'plane', director: false });
  });
});

describe('shared path in the hash', () => {
  it('is used by scenario.js and does not touch storage', async () => {
    const points = [[-100, 60, 150], [-200, 70, 300], [200, 80, 300], [300, 90, 100], [200, 70, -100]];
    const url = new URL(buildShareUrl({ ship: 'fwd', mode: 'intercept', t: 0, focus: 'free', director: false, path: points }, 'https://example.test/'));
    assert.match(url.hash, /^#path=[A-Za-z0-9_-]+$/);
    let writes = 0;
    globalThis.location = { hash: url.hash, search: '' };
    globalThis.localStorage = { getItem: () => null, setItem: () => { writes++; }, removeItem: () => { writes++; } };
    globalThis.__SHIP_VARIANT = 'fwd';
    globalThis.__SCENARIO = 'intercept';
    try {
      const S = await import(`../src/scenario.js?shared=${Date.now()}`);
      assert.equal(S.SHARED_PATH, true);
      assert.equal(S.scenario.customPath, true);
      assert.deepEqual(S.ACTIVE_PATH, points);
      assert.equal(writes, 0);
    } finally {
      delete globalThis.location;
      delete globalThis.localStorage;
    }
  });
  it('ignores a malformed hash', async () => {
    globalThis.location = { hash: '#path=%%%not-base64', search: '' };
    globalThis.__SHIP_VARIANT = 'fwd';
    globalThis.__SCENARIO = 'intercept';
    try {
      const S = await import(`../src/scenario.js?bad=${Date.now()}`);
      assert.equal(S.SHARED_PATH, false);
    } finally {
      delete globalThis.location;
    }
  });
});

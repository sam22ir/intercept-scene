// The start screen's animated previews (src/menuArt.js): every mission has one, the still frame has no
// animation (reduced motion), nothing loads from outside, and the shot leaves the way the launcher fires.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MISSION_IDS, SHIPS } from '../src/menu.js';
import { previewArt } from '../src/menuArt.js';

describe('the mission previews', () => {
  for (const id of MISSION_IDS) {
    for (const ship of SHIPS.map((s) => s.id)) {
      it(`${id} with the ${ship} launcher`, () => {
        const still = previewArt(id, ship, false);
        const live = previewArt(id, ship, true);
        for (const svg of [still, live]) {
          assert.match(svg, /^<svg [^>]*viewBox="0 0 480 220"/, 'a self-contained svg');
          assert.doesNotMatch(svg, /href=|src=|url\(|https?:|<script|<image/i, 'nothing loads from outside');
        }
        assert.doesNotMatch(still, /<animate/, 'the still frame has no animation');
        assert.match(live, /<animate/, 'the live preview moves');
        assert.ok(live.length > still.length * 0.9);
        assert.equal(previewArt(id, ship, true), live, 'the same inputs give the same picture');
      });
    }
  }

  it('has nothing for an unknown mission', () => {
    assert.equal(previewArt('nope'), '');
  });

  it('shows each launcher firing the way it really fires', () => {
    const missilePath = (svg) => svg.match(/<animateMotion path="([^"]+)"[^>]*keyTimes="0;0\.5;/)?.[1];
    const start = (d) => d.match(/^M([\d.]+) ([\d.]+)/).slice(1).map(Number);
    const end = (d) => d.match(/([\d.]+) ([\d.]+)$/).slice(1).map(Number);
    const fwd = missilePath(previewArt('intercept', 'fwd'));
    const aft = missilePath(previewArt('intercept', 'aft'));
    assert.ok(fwd && aft, 'both previews have a missile');
    // the ship runs bow to the right: the forward box is right of the aft one, and the shot goes over the bow (right) or astern (left)
    assert.ok(start(fwd)[0] > start(aft)[0], 'the forward box is forward of the aft box');
    assert.ok(end(fwd)[0] > start(fwd)[0], 'forward launcher: the missile leaves over the bow');
    assert.ok(end(aft)[0] < start(aft)[0], 'aft launcher: the missile leaves astern');
  });

  it('the recovery canopy is a red parachute and nothing is fired', () => {
    const svg = previewArt('chute', 'fwd', true);
    assert.match(svg, /a-canopy/);
    assert.doesNotMatch(svg, /a-missile/);
  });
});

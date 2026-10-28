// The main menu's animated previews (src/menuArt.js): every mission has one, the still frame has no
// animation (reduced motion), nothing loads from outside, the captions follow the language, and the shot
// leaves the way the launcher fires.

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
          assert.match(svg, /^<svg [^>]*viewBox="0 0 640 300"/, 'a self-contained svg');
          // Only references to its own gradients and filter (url(#…)), nothing from outside.
          assert.doesNotMatch(svg.replace(/url\(#ma-[a-z]+\)/g, ''), /href=|src=|url\(|https?:|<script|<image/i, 'nothing loads from outside');
          for (const ref of svg.matchAll(/url\(#(ma-[a-z]+)\)/g)) assert.match(svg, new RegExp(`id="${ref[1]}"`), `${ref[1]} is defined`);
        }
        assert.doesNotMatch(still, /<animate/, 'the still frame has no animation');
        assert.match(live, /<animate/, 'the live preview moves');
        assert.equal(previewArt(id, ship, true), live, 'the same inputs give the same picture');
      });
    }
  }

  it('has nothing for an unknown mission', () => {
    assert.equal(previewArt('nope'), '');
  });

  it('shows each launcher firing the way it really fires', () => {
    const shot = (svg) => svg.match(/data-shot="([^"]+)"/)?.[1];
    const start = (d) => d.match(/^M([\d.]+) ([\d.]+)/).slice(1).map(Number);
    const end = (d) => d.match(/([\d.]+) ([\d.]+)$/).slice(1).map(Number);
    const fwd = shot(previewArt('intercept', 'fwd'));
    const aft = shot(previewArt('intercept', 'aft'));
    assert.ok(fwd && aft, 'both previews have a missile');
    // the ship runs bow to the right: the forward box is right of the aft one, and the shot goes over the bow (right) or astern (left)
    assert.ok(start(fwd)[0] > start(aft)[0], 'the forward box is forward of the aft box');
    assert.ok(end(fwd)[0] > start(fwd)[0], 'forward launcher: the missile leaves over the bow');
    assert.ok(end(aft)[0] < start(aft)[0], 'aft launcher: the missile leaves astern');
  });

  it('the recovery canopy is a red parachute and nothing is fired', () => {
    const svg = previewArt('chute', 'fwd', true);
    assert.match(svg, /a-canopy/);
    assert.doesNotMatch(svg, /a-msl|data-shot/);
  });

  it('the captions follow the language', () => {
    assert.match(previewArt('intercept', 'fwd', true, 'en'), /SPLASH ONE/);
    assert.match(previewArt('intercept', 'fwd', true, 'fr'), /CIBLE DÉTRUITE/);
    assert.doesNotMatch(previewArt('duel', 'fwd', true, 'fr'), />YOU</);
  });
});

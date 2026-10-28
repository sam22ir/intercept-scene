// The missions in French (src/frenchDom.js + src/missionFr.js): exact strings, patterns whose varying
// parts are translated too, and the guard that keeps short patterns off sentences the dictionary lacks.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { translator, compile } from '../src/frenchDom.js';
import { MISSION_FR } from '../src/missionFr.js';

const tr = translator(MISSION_FR);

describe('the mission translator', () => {
  it('translates exact strings and leaves what it does not know', () => {
    assert.equal(tr('Main menu'), 'Menu principal');
    assert.equal(tr('  Main   menu '), 'Menu principal', 'spacing does not matter');
    assert.equal(tr('Some sentence nobody wrote'), null);
    assert.equal(tr('123 m'), null, 'numbers alone are left alone');
    assert.equal(tr.node(' Main menu '), ' Menu principal ', 'a text node keeps its own spaces');
  });

  it('fills patterns, translating their parts', () => {
    assert.equal(tr('Next: Missile launch in 2.0 s'), 'Suivant : Tir du missile dans 2.0 s');
    assert.equal(tr('Man overboard, starboard side!'), 'Homme à la mer, côté tribord !');
    assert.equal(tr('Telegraph: stop engines'), 'Transmetteur : stop machines');
    assert.equal(tr('12.5 kn'), '12.5 nd');
    assert.equal(tr('Green 009'), 'Tribord 009');
  });

  it('a short pattern never takes a long part', () => {
    assert.equal(tr('SHIP1 and SHIP2'), 'SHIP1 et SHIP2');
    assert.equal(tr('This is a long English sentence the dictionary does not have and it goes on'), null);
  });

  it('every entry compiles, and no French text asks for more parts than the English gives', () => {
    const { patterns } = compile(MISSION_FR);
    assert.ok(patterns.length > 50);
    for (const [en, fr] of Object.entries(MISSION_FR)) {
      assert.equal(typeof fr, 'string', en);
      const n = (en.match(/\{\}/g) ?? []).length;
      const m = (fr.match(/\{\d*\}/g) ?? []).length;
      assert.ok(m <= n, `${en}: ${m} > ${n}`);
      assert.ok(fr.trim().length > 0, en);
    }
  });
});

// English and French: the main menu's own words (i18n.js) have the same keys in both languages, and every
// mission, category, launcher and level has its French text (menuFr.js) with the same keys on the keyboard.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { UI, LANGS, readLang } from '../src/i18n.js';
import { FR } from '../src/menuFr.js';
import { MISSIONS, GROUPS, FAMILIES, SHIPS, ENEMY_LEVELS, menuText, entriesOf } from '../src/menu.js';

const shapeOf = (v) => (typeof v === 'function' ? 'fn' : Array.isArray(v) ? `array:${v.length}` : typeof v);

describe('the interface words', () => {
  it('has English and French, English by default', () => {
    assert.deepEqual(LANGS.map((l) => l.id), ['en', 'fr']);
    assert.equal(readLang(), 'en', 'no stored choice in Node');
  });

  it('has every key in both languages, of the same kind', () => {
    assert.deepEqual(Object.keys(UI.fr).sort(), Object.keys(UI.en).sort());
    for (const k of Object.keys(UI.en)) assert.equal(shapeOf(UI.fr[k]), shapeOf(UI.en[k]), k);
    assert.notEqual(UI.fr.appName, UI.en.appName);
  });
});

describe('the missions in French', () => {
  for (const m of MISSIONS) {
    it(m.id, () => {
      const fr = FR.missions[m.id];
      assert.ok(fr, 'has French words');
      for (const f of ['name', 'kind', 'blurb', 'tagline', 'facts', 'keys', 'button']) {
        if (m[f] === undefined) continue;
        assert.ok(fr[f] ?? (f === 'blurb' || f === 'tagline' ? null : m[f]), `${m.id}.${f}`);
      }
      for (const f of ['fixed', 'fixedNote', 'sub', 'tile']) if (m[f]) assert.ok(fr[f], `${m.id}.${f}`);
      assert.equal(fr.facts.length, m.facts.length, 'as many facts');
      assert.deepEqual(fr.keys.map(([k]) => k), m.keys.map(([k]) => k), 'the same keys, only the labels translated');
      const t = menuText(m.id, 'fwd', 'fr');
      assert.equal(t.title, fr.name);
      assert.ok(t.brand.length <= 16, 'the top-bar title fits');
      assert.ok(t.tabTitle.endsWith('— Simulateur naval'));
    });
  }

  it('every category, family, launcher and level', () => {
    for (const g of GROUPS) assert.ok(FR.groups[g.id]?.name && FR.groups[g.id]?.hint, g.id);
    for (const f of FAMILIES) assert.ok(FR.families[f.id]?.name, f.id);
    for (const s of SHIPS) assert.ok(FR.ships[s.id]?.name && FR.ships[s.id]?.desc, s.id);
    for (const l of ENEMY_LEVELS) assert.ok(FR.levels[l.id]?.name && FR.levels[l.id]?.desc, l.id);
    assert.equal(entriesOf('drill', 'fr')[0].name, FR.families.drill.name);
    assert.equal(menuText('intercept', 'aft', 'fr').ship, FR.ships.aft.name);
  });
});

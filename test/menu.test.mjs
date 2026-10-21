// The main menu's words (src/menu.js) against what the missions really do: every title, tagline, fact and
// key the start screen shows for a choice is checked against the real scenario, flight model, exercise
// and key bindings, and the static markup in index.html is checked against the data. A title can no longer
// describe something a mission does not do.

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { MISSIONS, SHIPS, GROUPS, MISSION_IDS, FIXED_SHIP, menuText, missionById } from '../src/menu.js';

const read = (f) => readFileSync(new URL(f, import.meta.url), 'utf8');
const html = read('../index.html');
const src = {
  start: read('../src/start.js'), main: read('../src/main.js'), maneuvers: read('../src/maneuversMain.js'), fly: read('../src/flyMain.js'),
  formations: read('../src/formationsMain.js'), helm: read('../src/helmMain.js'),
  timeline: read('../src/timeline.js'),
};
const urlOf = (f, q) => `${pathToFileURL(new URL(f, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')).href}?${q}`;

// The scenario in each of its two drone modes, each under its own module instance (it reads its mission at import).
const scenarios = {};
let M; // maneuvers.js (three ships)
let M2; // maneuvers.js with two ships
let F; // fly.js
let H; // helm.js
let FM; // formations.js
before(async () => {
  for (const mode of ['intercept', 'chute']) {
    globalThis.__SHIP_VARIANT = 'fwd';
    globalThis.__SCENARIO = mode;
    scenarios[mode] = (await import(urlOf('../src/scenario.js', `menu-${mode}`))).scenario;
  }
  globalThis.__SCENARIO = 'chute'; // fly.js loads the base scenario module under the recovery mission
  M = await import(urlOf('../src/maneuvers.js', 'menu'));
  globalThis.__DRILL_SHIPS = 2;
  M2 = await import(urlOf('../src/maneuvers.js', 'menu-two'));
  delete globalThis.__DRILL_SHIPS;
  F = await import(urlOf('../src/fly.js', 'menu'));
  H = await import(urlOf('../src/helm.js', 'menu'));
  FM = await import(urlOf('../src/formations.js', 'menu'));
});

const chooser = () => html.slice(html.indexOf('<div id="chooser"'), html.indexOf('<svg width="0"'));
const rowOf = (id) => chooser().match(new RegExp(`<button class="mission( tile)?"[^>]*data-mode="${id}">(.*?)</button>`, 's'))?.[2] ?? '';
const isTile = (id) => new RegExp(`<button class="mission tile"[^>]*data-mode="${id}"`).test(chooser());
const cardOf = (id) => chooser().match(new RegExp(`<button class="card"[^>]*data-ship="${id}">(.*?)</button>`, 's'))?.[1] ?? '';
const text = (s) => s.replace(/<svg.*?<\/svg>/gs, '').replace(/<kbd>.*?<\/kbd>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

describe('the menu data', () => {
  it('lists the seven missions once each, in a fixed order, with every field', () => {
    assert.deepEqual(MISSION_IDS, ['intercept', 'chute', 'fly', 'maneuvers2', 'maneuvers', 'formations', 'helm']);
    assert.equal(new Set(MISSIONS.map((m) => m.name)).size, MISSIONS.length, 'names are unique');
    for (const m of MISSIONS) {
      for (const f of ['name', 'kind', 'blurb', 'tagline', 'brand', 'button']) assert.ok(typeof m[f] === 'string' && m[f].length >= 3, `${m.id}.${f}`);
      assert.ok(m.facts.length === 3 && m.facts.every((x) => x.length > 3), `${m.id} has three facts`);
      assert.ok(m.keys.length >= 4 && m.keys.every(([k, l]) => k && l), `${m.id} lists its controls`);
      assert.ok(m.brand.length <= 16, `${m.id}'s top-bar title fits`);
      if (!m.ship) assert.ok(m.fixed && m.fixedNote && m.sub, `${m.id} says what is fixed`);
    }
    assert.deepEqual(MISSIONS.filter((m) => !m.ship).map((m) => m.id), ['fly', 'maneuvers2', 'maneuvers', 'formations', 'helm']);
  });

  it('groups the missions: the drone ones, then the tactical maneuvers by the number of ships', () => {
    assert.deepEqual(GROUPS.map((g) => g.id), ['drone', 'tactical']);
    assert.deepEqual(MISSIONS.filter((m) => m.group === 'drone').map((m) => m.id), ['intercept', 'chute', 'fly']);
    const tac = MISSIONS.filter((m) => m.group === 'tactical' && m.tile);
    assert.deepEqual(tac.map((m) => m.ships), [2, 3, 4]);
    assert.deepEqual(MISSIONS.filter((m) => m.group === 'tactical' && !m.tile).map((m) => m.id), ['helm'], 'Solo Air Defense is a row after the tiles');
    for (const m of tac) {
      assert.equal(m.tile, `${m.ships} ships`);
      assert.ok(m.tileSub && m.facts[0].startsWith(`${m.ships} ships`), `${m.id} says how many ships`);
    }
    assert.ok(MISSIONS.every((m) => GROUPS.some((g) => g.id === m.group)));
    assert.equal(M.SHIP_IDS.length, 3);
    assert.equal(M2.SHIP_IDS.length, 2);
  });

  it('start.js builds its mission list from the data, not from a list of its own', () => {
    assert.match(src.start, /MISSION_IDS/);
    assert.doesNotMatch(src.start, /MODE_NAMES|MODE_NOTES|SHIP_NAMES/);
    assert.doesNotMatch(html, /Plan the sortie/);
  });
});

describe('the title follows the options', () => {
  for (const m of MISSIONS) {
    for (const ship of SHIPS.map((s) => s.id)) {
      it(`${m.id} with the ${ship} launcher`, () => {
        const t = menuText(m.id, ship);
        assert.equal(t.title, m.name, 'the heading is the mission');
        assert.ok(t.tabTitle.startsWith(m.name) && t.tabTitle.endsWith('— Intercept scene'), 'the tab says the mission');
        assert.ok(t.summary.startsWith(`${m.name} · `));
        assert.ok(t.button.length > 3);
        if (m.ship) {
          const s = SHIPS.find((x) => x.id === ship);
          assert.equal(t.hasShip, true);
          assert.equal(t.ship, s.name);
          assert.ok(t.summary.endsWith(s.name), 'the summary names the launcher chosen');
          assert.ok(t.tabTitle.includes(s.name));
          assert.equal(t.note, s.desc, 'the note describes the launcher chosen');
          assert.ok(t.sub.startsWith(`${s.short} launcher`) && t.sub.endsWith(m.name), 'the top bar names launcher and mission');
        } else {
          assert.equal(t.hasShip, false);
          assert.equal(t.ship, null);
          assert.ok(!t.summary.includes('launcher') && !t.tabTitle.includes('launcher'), 'a fixed ship is not offered as a choice');
          assert.equal(t.summary, t.summary.replace(/\s+$/, ''));
          assert.equal(t.note, m.fixedNote);
          assert.equal(t.sub, m.sub);
        }
      });
    }
  }

  it('the missions without a choice always use the forward launcher', () => {
    assert.equal(FIXED_SHIP, 'fwd');
    assert.equal(menuText('fly', 'aft').ship, null);
    assert.match(missionById('fly').fixedNote, /forward/i);
  });
});

describe('the words are true of the missions', () => {
  it('Intercept: one drone and one missile that shoots it down', () => {
    const sc = scenarios.intercept;
    assert.equal(sc.hasMissile, true);
    assert.equal(sc.engagements.length, 1);
    assert.equal(sc.drones.length, 1);
    const m = missionById('intercept');
    assert.ok(m.facts[0].startsWith('1 drone') && m.facts[0].includes('1 missile'));
    assert.match(m.tagline, /shoots it down/);
    assert.ok(Number.isFinite(sc.tHit), 'the drone is hit');
  });

  it('Recovery: no missile, a parachute, and a splashdown', () => {
    const sc = scenarios.chute;
    assert.equal(sc.hasMissile, false);
    assert.equal(sc.engagements.length, 0);
    assert.ok(Number.isFinite(sc.tChute) && Number.isFinite(sc.tSplash) && sc.tSplash > sc.tChute);
    const m = missionById('chute');
    assert.match(m.tagline, /never fired/);
    assert.match(m.tagline, /parachute/);
    assert.match(m.tagline, /lands in the sea/);
    assert.ok(m.facts.includes('No missile'));
  });

  it('Two-ship drill: ALG and RUS alone, the number of orders, the length and the play speed', () => {
    const m = missionById('maneuvers2');
    const minutes = Math.round(M2.exercise.tEnd / 60);
    assert.ok(m.tagline.includes(`${M2.PHASES.length} orders, about ${minutes} minutes`), `${M2.PHASES.length} orders, ${minutes} min`);
    assert.ok(m.facts.includes(`${M2.PHASES.length} orders`));
    assert.ok(m.facts.includes(`About ${minutes} minutes`));
    assert.match(m.tagline, /4×/);
    assert.deepEqual(M2.SHIP_IDS, ['alg', 'rus']);
    assert.ok(!/unit/i.test(m.tagline + m.facts.join()), 'no unit in the two-ship drill');
    for (const f of ['FORM 120', 'FORM 345']) assert.ok(m.tagline.includes(f) && M2.PHASES.some((p) => p.title === f), f);
    assert.match(src.start, /__DRILL_SHIPS = mode === 'maneuvers2' \? 2 : 3/);
  });

  it('Three-ship drill: the number of orders, the length of the exercise and the play speed', () => {
    const m = missionById('maneuvers');
    const minutes = Math.round(M.exercise.tEnd / 60);
    assert.ok(m.tagline.includes(`${M.PHASES.length} orders, about ${minutes} minutes`), `${M.PHASES.length} orders, ${minutes} min`);
    assert.ok(m.facts.includes(`${M.PHASES.length} orders`));
    assert.ok(m.facts.includes(`About ${minutes} minutes`));
    assert.match(src.maneuvers, /clock\.setSpeed\(4\)/);
    assert.match(m.tagline, /4×/);
    for (const id of ['ALG', 'RUS']) assert.ok(m.facts[0].includes(id) && m.tagline.includes(id));
  });

  it('Four-ship formations: SHIP1 to SHIP4, the number of orders, the length and the play speed', () => {
    const m = missionById('formations');
    const minutes = Math.round(FM.exercise.tEnd / 60);
    assert.ok(m.tagline.includes(`${FM.PHASES.length} orders, about ${minutes} minutes`), `${FM.PHASES.length} orders, ${minutes} min`);
    assert.ok(m.facts.includes(`${FM.PHASES.length} orders`));
    assert.ok(m.facts.includes(`About ${minutes} minutes`));
    assert.match(src.formations, /clock\.setSpeed\(8\)/);
    assert.match(m.tagline, /8×/);
    assert.deepEqual(Object.values(FM.SHIP_NAMES), ['SHIP1', 'SHIP2', 'SHIP3', 'SHIP4']);
    assert.ok(m.tagline.includes('SHIP1 to SHIP4') && m.facts[0].includes('SHIP1 to SHIP4'));
    for (const f of ['line ahead', 'line of bearing', 'line abreast', 'box', 'diamond', 'CORPEN', 'TURN']) assert.ok(m.tagline.includes(f), f);
    assert.ok(FM.PHASES.some((p) => p.kind === 'corpen') && FM.PHASES.some((p) => p.kind === 'turn'));
    assert.deepEqual([...new Set(FM.PHASES.filter((p) => p.kind === 'form').map((p) => p.form))].sort(), ['abreast', 'bearing', 'box', 'column', 'diamond']);
    for (const [k] of m.keys.filter(([x]) => /^[A-Z5]$/.test(x))) assert.match(src.formations, new RegExp(`key === '${k.toLowerCase()}'`), `formations: ${k}`);
    assert.match(src.start, /formationsMain\.js/);
  });

  it('Solo Air Defense: the rounds, the views, and every key it lists is really bound', () => {
    const m = missionById('helm');
    assert.ok(m.facts.includes(`${H.CELLS} missiles`));
    assert.match(src.helm, /const VIEWS = \['bridge', 'behind', 'above', 'missile', 'sight', 'target', 'orbit'\]/);
    assert.ok(m.facts.includes('7 views'));
    for (const letter of ['f', 'm', 'r', 'v', 'i']) assert.match(src.helm, new RegExp(`case '${letter}':`), `helmMain binds ${letter}`);
    for (const k of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Tab']) assert.match(src.helm, new RegExp(k));
    const label = Object.fromEntries(m.keys);
    assert.match(label.F, /missile/);
    assert.match(label['↑ ↓'], /telegraph/);
    assert.match(m.tagline, /three hits/);
    assert.equal(H.TELEGRAPH.length, 7);
    assert.match(src.start, /helmMain\.js/);
  });

  it('Fly the drone: the cruise speed, and every key it lists is really bound', () => {
    const m = missionById('fly');
    assert.ok(m.tagline.includes(`${F.DEFAULT_SPEED} m/s`), `${F.DEFAULT_SPEED} m/s`);
    assert.ok(m.facts.includes(`${F.DEFAULT_SPEED} m/s cruise`));
    const keys = m.keys.map(([k]) => k);
    for (const letter of ['e', 'l', 'f', 'r', 'v', 'm']) {
      assert.match(src.fly, new RegExp(`case '${letter}':`), `flyMain binds ${letter}`);
      assert.ok(keys.includes(letter.toUpperCase()), `the menu lists ${letter.toUpperCase()}`);
    }
    for (const arrow of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']) assert.match(src.fly, new RegExp(arrow));
    assert.ok(keys.includes('← →') && keys.includes('↑ ↓'));
    // The text names what each key really does.
    const label = Object.fromEntries(m.keys);
    assert.match(label.E, /engine/);
    assert.match(label.L, /catapult/);
    assert.match(label.F, /missile/);
    assert.match(m.tagline, /E starts the engine/);
    assert.match(m.tagline, /L fires the catapult/);
    assert.match(m.tagline, /F fires/);
  });

  it('the keys listed for the other missions are bound in their scenes', () => {
    for (const id of ['intercept', 'chute']) {
      const keys = missionById(id).keys.map(([k]) => k);
      for (const k of keys.filter((x) => /^[A-Z]$/.test(x))) assert.match(src.main, new RegExp(`key === '${k.toLowerCase()}'`), `${id}: ${k}`);
    }
    for (const [k] of missionById('maneuvers').keys.filter(([x]) => /^[A-Z]$/.test(x))) assert.match(src.maneuvers, new RegExp(`key === '${k.toLowerCase()}'`), `maneuvers: ${k}`);
    // Space and the arrows belong to the shared timeline.
    assert.match(src.timeline, /ArrowLeft/);
    assert.match(src.timeline, /' '|Space/);
  });
});

describe('index.html shows what the data says', () => {
  for (const m of MISSIONS) {
    it(`the ${m.id} ${m.tile ? 'tile' : 'row'}`, () => {
      const row = rowOf(m.id);
      assert.ok(row, 'it exists');
      assert.equal(isTile(m.id), !!m.tile, 'the tactical maneuvers by number of ships are tiles');
      if (m.tile) {
        assert.equal(text(row.match(/<b>(.*?)<\/b>/s)[1]), m.tile);
        assert.equal(text(row.match(/<small>(.*?)<\/small>/s)[1]), m.tileSub);
      } else {
        assert.equal(text(row.match(/<b>(.*?)<\/b>/s)[1]), m.name);
        assert.equal(text(row.match(/<small>(.*?)<\/small>/s)[1]), m.blurb);
        assert.equal(text(row.match(/<em class="m-kind">(.*?)<\/em>/s)[1]), m.kind);
      }
      assert.match(row, /<svg/);
    });
  }

  it('heads each group with its name, in order', () => {
    const heads = [...chooser().matchAll(/<h2 class="m-group"[^>]*>(.*?)<\/h2>/gs)].map((x) => text(x[1].replace(/<em.*?<\/em>/s, '')).replace(/&amp;/g, '&'));
    assert.deepEqual(heads, GROUPS.map((g) => g.name));
  });

  for (const s of SHIPS) {
    it(`the ${s.id} launcher card`, () => {
      const card = cardOf(s.id);
      assert.ok(card, 'the card exists');
      assert.equal(text(card.match(/<span class="card-name">(.*?)<\/span>/s)[1]), s.name);
      assert.equal(text(card.match(/<span class="card-desc">(.*?)<\/span>/s)[1]), s.desc);
    });
  }

  it('has the slots the start screen fills (and no fixed title text of its own)', () => {
    for (const id of ['ch-title', 'ch-kind', 'ch-tag', 'ch-facts', 'ch-keys', 'ch-art', 'ch-summary', 'chooser-sub', 'ch-start']) {
      assert.match(chooser(), new RegExp(`id="${id}"`), id);
    }
    assert.match(chooser(), /<h1 id="ch-title"><\/h1>/, 'the heading is filled from the data');
    assert.match(chooser(), /aria-labelledby="ch-step2"/, 'the launcher block the start screen hides');
    assert.equal((chooser().match(/data-mode="/g) ?? []).length, MISSIONS.length);
    assert.equal((chooser().match(/data-ship="/g) ?? []).length, SHIPS.length);
    assert.match(html, /<title>Intercept scene<\/title>/);
  });
});

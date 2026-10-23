// The main menu's words (src/menu.js) against what the missions really do: every title, tagline, fact and
// key the start screen shows for a choice is checked against the real scenario, flight model, exercise
// and key bindings, and the static markup in index.html is checked against the data. A title can no longer
// describe something a mission does not do.

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { MISSIONS, SHIPS, ENEMY_LEVELS, DEFAULT_LEVEL, SQUADRON_SCENARIOS, DEFAULT_SCENARIO, GROUPS, FAMILIES, ENTRIES, entriesOf, groupOf, MISSION_IDS, FIXED_SHIP, menuText, missionById } from '../src/menu.js';

const read = (f) => readFileSync(new URL(f, import.meta.url), 'utf8');
const html = read('../index.html');
const src = {
  start: read('../src/start.js'), main: read('../src/main.js'), maneuvers: read('../src/maneuversMain.js'), fly: read('../src/flyMain.js'),
  formations: read('../src/formationsMain.js'), helm: read('../src/helmMain.js'), duel: read('../src/duelMain.js'), squadron: read('../src/squadronMain.js'),
  timeline: read('../src/timeline.js'),
};
const urlOf = (f, q) => `${pathToFileURL(fileURLToPath(new URL(f, import.meta.url))).href}?${q}`;

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
// A mission is a list row, or (the three drills) a variant button in the Ships picker.
const rowOf = (id) => chooser().match(new RegExp(`<button class="(mission|pick)"[^>]*data-mode="${id}">(.*?)</button>`, 's'))?.[2] ?? '';
const rowKind = (id) => chooser().match(new RegExp(`<button class="(mission|pick)"[^>]*data-mode="${id}"`))?.[1];
const tabButtons = () => [...chooser().matchAll(/<button class="tab"[^>]*data-tab="(\w+)"[^>]*>(.*?)<\/button>/gs)].map((x) => [x[1], text(x[2].match(/<b>(.*?)<\/b>/s)[1])]);
const cardOf = (id) => chooser().match(new RegExp(`<button class="card"[^>]*data-ship="${id}">(.*?)</button>`, 's'))?.[1] ?? '';
const text = (s) => s.replace(/<svg.*?<\/svg>/gs, '').replace(/<kbd>.*?<\/kbd>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

describe('the menu data', () => {
  it('lists the nine missions once each, in a fixed order, with every field', () => {
    assert.deepEqual(MISSION_IDS, ['intercept', 'chute', 'fly', 'maneuvers2', 'maneuvers', 'formations', 'helm', 'duel', 'squadron']);
    assert.equal(new Set(MISSIONS.map((m) => m.name)).size, MISSIONS.length, 'names are unique');
    for (const m of MISSIONS) {
      for (const f of ['name', 'kind', 'blurb', 'tagline', 'brand', 'button']) assert.ok(typeof m[f] === 'string' && m[f].length >= 3, `${m.id}.${f}`);
      assert.ok(m.facts.length === 3 && m.facts.every((x) => x.length > 3), `${m.id} has three facts`);
      assert.ok(m.keys.length >= 4 && m.keys.every(([k, l]) => k && l), `${m.id} lists its controls`);
      assert.ok(m.brand.length <= 16, `${m.id}'s top-bar title fits`);
      if (!m.ship) assert.ok(m.fixed && m.fixedNote && m.sub, `${m.id} says what is fixed`);
    }
    assert.deepEqual(MISSIONS.filter((m) => !m.ship).map((m) => m.id), ['fly', 'maneuvers2', 'maneuvers', 'formations', 'helm', 'duel', 'squadron']);
  });

  it('has three tabs by what the player does, each with real missions', () => {
    assert.deepEqual(GROUPS.map((g) => g.id), ['watch', 'play', 'command', 'drill']);
    assert.deepEqual(GROUPS.map((g) => g.name), ['Watch', 'Play', 'Command', 'Drill']);
    assert.deepEqual(MISSIONS.filter((m) => m.group === 'watch').map((m) => m.id), ['intercept', 'chute']);
    assert.deepEqual(MISSIONS.filter((m) => m.group === 'play').map((m) => m.id), ['fly', 'helm', 'duel']);
    assert.deepEqual(MISSIONS.filter((m) => m.group === 'command').map((m) => m.id), ['squadron']);
    assert.deepEqual(MISSIONS.filter((m) => m.group === 'drill').map((m) => m.id), ['maneuvers2', 'maneuvers', 'formations']);
    assert.ok(MISSIONS.every((m) => GROUPS.some((g) => g.id === m.group)), 'every mission is on a tab');
    for (const g of GROUPS) assert.ok(g.hint && entriesOf(g.id).length > 0, `${g.id} lists something`);
    assert.ok(MISSIONS.filter((m) => m.group === 'watch').every((m) => m.kind === 'Replay'), 'Watch holds the replays');
    assert.ok(MISSIONS.filter((m) => m.group === 'play').every((m) => m.kind === 'Manual'), 'Play holds the hands-on missions');
    assert.ok(MISSIONS.filter((m) => m.group === 'drill').every((m) => m.kind === 'Drill'), 'Drill holds the exercises');
  });

  it('folds the three drills into one entry, by the number of ships', () => {
    assert.equal(FAMILIES.length, 1);
    assert.deepEqual(FAMILIES[0].members, ['maneuvers2', 'maneuvers', 'formations']);
    assert.deepEqual(FAMILIES[0].members.map((id) => missionById(id).ships), [2, 3, 4]);
    for (const id of FAMILIES[0].members) {
      const m = missionById(id);
      assert.equal(m.tile, `${m.ships} ships`);
      assert.ok(m.tileSub && m.facts[0].startsWith(`${m.ships} ships`), `${id} says how many ships`);
    }
    assert.deepEqual(entriesOf('drill').map((e) => e.members), [FAMILIES[0].members]);
    assert.deepEqual(ENTRIES.map((e) => e.id), ['intercept', 'chute', 'fly', 'helm', 'duel', 'squadron', 'maneuvers2'], 'the list order M steps through');
    assert.equal(new Set(ENTRIES.flatMap((e) => e.members)).size, MISSIONS.length, 'every mission is reachable from one entry');
    assert.equal(groupOf('formations'), 'drill');
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
        assert.ok(t.tabTitle.startsWith(m.name) && t.tabTitle.endsWith('— Simulation'), 'the tab says the mission');
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
    assert.ok(m.facts.includes(`${H.CELLS} missiles + 2 guns`));
    assert.match(src.helm, /const VIEWS = \['bridge', 'behind', 'above', 'missile', 'sight', 'target', 'orbit'\]/);
    assert.ok(m.facts.includes('7 views'));
    for (const letter of ['f', 'm', 'a', 'n', 'r', 'v', 'i']) assert.match(src.helm, new RegExp(`case '${letter}':`), `helmMain binds ${letter}`);
    for (const k of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Tab']) assert.match(src.helm, new RegExp(k));
    const label = Object.fromEntries(m.keys);
    assert.match(label.M, /missile/);
    assert.match(label.G, /guns/);
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

describe('the words are true of the ship duel', () => {
  let D;
  before(async () => { D = await import(urlOf('../src/duel.js', 'menu')); });

  it('two frigates, one enemy helmsman, the guns and the compartments it lists', () => {
    const m = missionById('duel');
    const sim = new D.DuelSim({ seed: 1 });
    assert.equal(sim.ships.length, 2);
    assert.ok(sim.ships[1].ai && !sim.ships[0].ai, 'one helmsman, the enemy');
    assert.match(m.facts[0], /^76 mm with a zoom ring/);
    assert.deepEqual(Object.keys(D.AMMO_TYPES), ['he', 'ap']);
    assert.equal(sim.ships[0].gats.length, 2, 'the two 30 mm guns');
    assert.match(m.facts[1], /radar sight/);
    assert.ok(D.MAIN_ARC > 0 && D.MAIN_MOUNT[0] > 0, 'the 76 mm is on the bow');
    assert.equal(D.COMP_IDS.length, 5);
    assert.match(m.facts[2], new RegExp(`^${D.CREWS} repair crews`));
    assert.match(m.tagline, /76 mm/);
    assert.match(m.tagline, /30 mm/);
    assert.match(m.tagline, /sinks/);
    for (const w of ['repair crews']) assert.match(m.tagline, new RegExp(w));
    assert.equal(m.level, true, 'the enemy level is a choice');
    assert.equal(menuText('duel').hasLevel, true);
    assert.equal(menuText('fly').hasLevel, false);
  });

  it('the enemy levels on the screen are the simulation\'s', () => {
    assert.deepEqual(ENEMY_LEVELS.map((l) => l.id), D.DUEL_LEVELS);
    assert.ok(D.DUEL_LEVELS.includes(DEFAULT_LEVEL));
    for (const l of ENEMY_LEVELS) assert.match(chooser(), new RegExp(`data-level="${l.id}"`));
    assert.match(src.duel, /__DUEL_LEVEL/, 'the scene reads the level start.js sets');
    assert.match(src.start, /__DUEL_LEVEL/);
  });

  it('every key it lists is really bound, and the tagline names the firing key', () => {
    const keys = missionById('duel').keys.map(([k]) => k);
    for (const k of keys.filter((x) => /^[A-Z]$/.test(x))) assert.match(src.duel, new RegExp(`(case '${k.toLowerCase()}'|key === '${k.toLowerCase()}')`), `duel: ${k}`);
    assert.ok(keys.includes('← →') && keys.includes('↑ ↓'));
    for (const k of ['z', 'x']) assert.match(src.duel, new RegExp(`case '${k}'`), `duel: ${k}`);
    assert.doesNotMatch(src.duel, /lock.on|proportional/i, 'the duel has no homing ship missiles: only the helicopter fires one, at your word');
    for (const k of ['k', 'b', 'm']) assert.match(src.duel, new RegExp(`case '${k}'`), `duel: ${k}`);
    for (const arrow of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']) assert.match(src.duel, new RegExp(arrow));
    assert.match(missionById('duel').tagline, /hold F/);
    assert.match(src.start, /duelMain\.js/);
  });
});

describe('the words are true of squadron orders', () => {
  let FS, FO, SC;
  before(async () => {
    FS = await import(urlOf('../src/squadron.js', 'menu'));
    FO = await import(urlOf('../src/squadronOrders.js', 'menu'));
    SC = await import(urlOf('../src/squadronScoring.js', 'menu'));
  });

  it('a squadron of four frigates that the player only gives orders to', () => {
    const m = missionById('squadron');
    const sim = new FS.SquadronSim({ seed: 1 });
    assert.equal(sim.squad.length, 4);
    assert.ok(m.tagline.includes('four frigates') && m.facts[0].startsWith('4 frigates'));
    assert.equal(sim.n, 4);
    assert.ok(sim.squad.every((s) => s.ai), 'every hull has a helmsman: the player only orders');
    assert.equal(m.group, 'command');
    assert.equal(m.level, true, 'the raiders have a level');
    assert.match(m.fixedNote, /picket, two gun ships and an escort/);
    assert.deepEqual(sim.squad.map((s) => s.role), ['picket', 'gun', 'gun', 'escort']);
  });

  it('the scenarios on the screen are the simulation\'s', () => {
    assert.deepEqual(SQUADRON_SCENARIOS.map((x) => x.id), Object.keys(SC.SCENARIOS));
    assert.ok(SQUADRON_SCENARIOS.some((x) => x.id === DEFAULT_SCENARIO));
    for (const x of SQUADRON_SCENARIOS) assert.match(chooser(), new RegExp(`data-scenario="${x.id}"`));
    assert.equal((chooser().match(/data-scenario="/g) ?? []).length, SQUADRON_SCENARIOS.length);
    assert.equal(menuText('squadron').hasScenario, true);
    assert.equal(menuText('duel').hasScenario, false);
    assert.match(missionById('squadron').tagline, /Escort/);
    assert.match(missionById('squadron').tagline, /defend a zone/);
    assert.match(src.squadron, /__SQUADRON_SCENARIO/, 'the scene reads the scenario start.js sets');
    assert.match(src.squadron, /__DUEL_LEVEL/, 'and the level');
    assert.match(src.start, /__SQUADRON_SCENARIO/);
    assert.match(src.start, /squadronMain\.js/);
  });

  it('the four formations, sector patrol and hold fire the text names are real orders', () => {
    assert.deepEqual(Object.keys(FO.FORMATIONS), ['FORM 1', 'FORM 3', 'BOX', 'FORM D']);
    for (const t of ['form', 'sector', 'stance', 'course', 'speed', 'goto']) assert.ok(FS.ORDER_TYPES.includes(t), t);
    const m = missionById('squadron');
    assert.match(m.tagline, /pause to plan/);
    assert.match(m.tagline, /rewind with Z/);
    assert.match(m.tagline, /on the radar/);
    assert.equal(typeof new FS.SquadronSim({ seed: 1 }).rewindTo, 'function');
  });

  it('every key it lists is really bound in the scene, with its behaviour', () => {
    const m = missionById('squadron');
    const keys = m.keys.map(([k]) => k);
    for (const k of keys.filter((x) => /^[A-Z]$/.test(x))) assert.match(src.squadron, new RegExp(`case '${k.toLowerCase()}':`), `squadron: ${k}`);
    assert.match(src.squadron, /case ' ':/, 'Space');
    for (const arrow of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']) assert.match(src.squadron, new RegExp(arrow));
    assert.ok(keys.includes('← →') && keys.includes('↑ ↓') && keys.includes('Space') && keys.includes('0 – 4'));
    assert.match(src.squadron, /'0'/);
    const label = Object.fromEntries(m.keys);
    assert.match(label.F, /formation/);
    assert.match(label.P, /sector/);
    assert.match(label.E, /hold fire/);
    assert.match(label.X, /crew/);
    assert.match(label.Z, /rewind/);
    assert.match(label.Space, /pause/);
    // the hold-fire key must not shadow a shared one (the readouts, the interface and the sound keys stay where they are)
    for (const shared of ['h', 'c', 's', 'n']) assert.ok(!keys.includes(shared.toUpperCase()), `${shared} is not listed`);
    assert.match(src.squadron, /case 'h':/);
    assert.match(src.squadron, /case 'c':/);
    assert.doesNotMatch(src.squadron, /DuelSim\(/, 'it runs on the squadron simulation');
  });
});

describe('index.html shows what the data says', () => {
  for (const m of MISSIONS) {
    it(`the ${m.id} ${m.group === 'drill' ? 'variant' : 'row'}`, () => {
      const row = rowOf(m.id);
      assert.ok(row, 'it exists');
      assert.equal(rowKind(m.id), m.group === 'drill' ? 'pick' : 'mission', 'the drills are variants of one list row, the rest are rows');
      assert.match(row, /<svg/);
      if (m.group === 'drill') {
        assert.equal(text(row.match(/<b>(.*?)<\/b>/s)[1]), m.tile);
        assert.equal(text(row.match(/<small>(.*?)<\/small>/s)[1]), m.tileSub);
      } else {
        assert.equal(text(row.match(/<b>(.*?)<\/b>/s)[1]), m.name);
        assert.equal(text(row.match(/<small>(.*?)<\/small>/s)[1]), m.blurb);
        assert.equal(text(row.match(/<em class="m-kind">(.*?)<\/em>/s)[1]), m.kind);
        assert.match(chooser(), new RegExp(`data-group="${m.group}"[^>]*data-mode="${m.id}"`), 'the row sits on its tab');
      }
    });
  }

  it('has a tab for each group, in order, and a list row for each entry', () => {
    assert.deepEqual(tabButtons(), GROUPS.map((g) => [g.id, g.name]));
    for (const e of ENTRIES) {
      const attr = e.family ? `data-family="${e.family}"` : `data-mode="${e.id}"`;
      const row = chooser().match(new RegExp(`<button class="mission"[^>]*data-group="${e.group}"[^>]*${attr}[^>]*>(.*?)</button>`, 's'))?.[1];
      assert.ok(row, `${e.name} has a row on the ${e.group} tab`);
      assert.equal(text(row.match(/<b>(.*?)<\/b>/s)[1]), e.name);
      assert.equal(text(row.match(/<small>(.*?)<\/small>/s)[1]), e.blurb);
    }
    assert.equal((chooser().match(/<button class="mission"/g) ?? []).length, ENTRIES.length, 'no row the data does not know');
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
    for (const id of ['ch-title', 'ch-kind', 'ch-tag', 'ch-facts', 'ch-keys', 'ch-keys-more', 'ch-stage', 'ch-tabhint', 'ch-summary', 'chooser-sub', 'ch-last', 'ch-start']) {
      assert.match(chooser(), new RegExp(`id="${id}"`), id);
    }
    assert.match(chooser(), /<h1 id="ch-title"><\/h1>/, 'the heading is filled from the data');
    assert.match(chooser(), /class="brief-ship variant"/, 'the launcher block the start screen hides');
    assert.match(chooser(), /class="brief-drill variant"/, 'the ships block, shown on the Drill tab');
    assert.equal((chooser().match(/data-mode="/g) ?? []).length, MISSIONS.length);
    assert.equal((chooser().match(/data-ship="/g) ?? []).length, SHIPS.length);
    assert.equal((chooser().match(/data-level="/g) ?? []).length, ENEMY_LEVELS.length);
    assert.match(chooser(), /class="brief-level variant"/, 'the enemy block, shown for the ship duel');
    assert.match(html, /<title>Simulation<\/title>/);
  });

  it('start.js fills the previews from menuArt.js, which imports nothing', () => {
    assert.match(src.start, /from '\.\/menuArt\.js'/);
    assert.doesNotMatch(read('../src/menuArt.js'), /^import /m);
  });
});

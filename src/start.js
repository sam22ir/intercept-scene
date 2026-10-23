import './style.css';

// Entry point. The ship fit and the mission are chosen on a start screen, and the page
// ALWAYS opens on it, whatever the address: a ?ship=/?mode= only preselects the choices, and
// a shared link's moment (?t, ?focus, ?cam, #path) waits until Start is pressed. The only ways
// past it are ?start=1 (scripted and headless runs; it removes itself from the address bar
// once used) and the app's own reloads (the path editor, the engagement panel and the
// maneuvers' standby stepper set sessionStorage 'intercept.skip' before reloading, which
// is read once).
// scenario.js reads `globalThis.__SHIP_VARIANT` / `__SCENARIO` (set here) or
// ?ship=fwd|aft and ?mode=intercept|chute at import time, so the scene is
// imported only after a choice is made: no page reload needed.

const $ = (s) => document.querySelector(s);
// Merely naming `localStorage` can throw (blocked storage, sandboxed viewers),
// so every access happens inside try.
const read = (kind, key) => { try { return globalThis[kind].getItem(key); } catch { return null; } };
const write = (kind, key, value) => { try { globalThis[kind].setItem(key, value); } catch { /* storage unavailable */ } };

let shown = false;
function showFatal(err) {
  if (shown) return;
  shown = true;
  const msg = String(err?.message ?? err ?? 'unknown error');
  $('#loading')?.remove();
  const box = document.createElement('div');
  box.className = 'fatal';
  const webgl = /webgl|context/i.test(msg);
  box.innerHTML = '<b>The simulation could not start.</b><br>'
    + (webgl
      ? 'Your browser could not start 3D graphics (WebGL). Try Chrome, Edge or Firefox with hardware acceleration turned on.'
      : 'Please try Chrome, Edge or Firefox, and send this text if it keeps happening:')
    + '<pre></pre>';
  box.querySelector('pre').textContent = msg.slice(0, 400);
  document.body.appendChild(box);
}

import { MISSION_IDS, FIXED_SHIP, ENTRIES, GROUPS, ENEMY_LEVELS, DEFAULT_LEVEL, SQUADRON_SCENARIOS, DEFAULT_SCENARIO, groupOf, missionById, menuText } from './menu.js';
import { previewArt } from './menuArt.js';

const MODES = MISSION_IDS;
let mode = 'intercept';
// The two- and three-ship drills are one scene (maneuversMain.js); the model reads the number of ships once at import.
const isDrill = (m) => m === 'maneuvers' || m === 'maneuvers2';

// The ship duel's enemy level (a choice on the start screen, like the launcher); the scene reads it once.
let level = DEFAULT_LEVEL;
const validLevel = (id) => (ENEMY_LEVELS.some((l) => l.id === id) ? id : null);
// The squadron mission's scenario (escort or defend), chosen the same way; the scene reads it once.
let scenario = DEFAULT_SCENARIO;
const validScenario = (id) => (SQUADRON_SCENARIOS.some((x) => x.id === id) ? id : null);

let launched = false;
async function launch(id) {
  if (launched) return; // Enter on a focused button fires both keydown and click
  launched = true;
  globalThis.__SHIP_VARIANT = id;
  // The maneuvers and fly missions have their own scenes; scenario.js (which the ship model imports) just sees
  // an intercept for the first and a recovery (no scripted missile to simulate) for the second.
  globalThis.__SCENARIO = isDrill(mode) || mode === 'formations' ? 'intercept' : mode === 'fly' || mode === 'helm' || mode === 'duel' || mode === 'squadron' ? 'chute' : mode;
  if (isDrill(mode)) globalThis.__DRILL_SHIPS = mode === 'maneuvers2' ? 2 : 3;
  if (menuText(mode, id).hasShip) { // the missions without a choice leave it alone
    write('localStorage', 'intercept.ship', id);
    write('localStorage', `intercept.ship.${mode}`, id); // each mission remembers its own launcher
  }
  if (groupOf(mode) === 'drill') write('localStorage', 'intercept.drill', mode); // and the drill its number of ships
  if (menuText(mode, id).hasLevel) { globalThis.__DUEL_LEVEL = level; write('localStorage', mode === 'squadron' ? 'intercept.level.squadron' : 'intercept.level.duel', level); }
  if (menuText(mode, id).hasScenario) { globalThis.__SQUADRON_SCENARIO = scenario; write('localStorage', 'intercept.scenario.squadron', scenario); }
  write('localStorage', 'intercept.mode', mode);
  try {
    const url = new URL(location.href);
    url.searchParams.set('ship', id);
    url.searchParams.set('mode', mode);
    url.searchParams.delete('start'); // a scripted start is used once: a refresh shows the menu again
    history.replaceState(null, '', url); // keeps the ship and mission preselected on a refresh
  } catch { /* not allowed in some viewers: fine */ }
  document.title = menuText(mode, id).tabTitle;
  $('#chooser').hidden = true;
  document.body.classList.add('playing');
  $('#loading').hidden = false;
  window.addEventListener('error', (e) => showFatal(e.error ?? e.message));
  window.addEventListener('unhandledrejection', (e) => showFatal(e.reason));
  // Let the loading screen paint before the scene's heavy synchronous setup.
  await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 30)));
  try {
    await (isDrill(mode) ? import('./maneuversMain.js') : mode === 'formations' ? import('./formationsMain.js')
      : mode === 'fly' ? import('./flyMain.js') : mode === 'helm' ? import('./helmMain.js') : mode === 'duel' ? import('./duelMain.js') : mode === 'squadron' ? import('./squadronMain.js') : import('./main.js'));
  } catch (err) {
    showFatal(err);
  }
}

// Three tabs (Watch, Play, Drill), a mission list for the tab, and a briefing that follows the choice: an
// animated preview, what it is, a variant where the mission has one (the launcher, or the number of ships
// in a drill) and its controls; then Start. Selection changes only on click or key; hover is visual only,
// so the summary and the Start target never follow the mouse. Every word the screen says for a choice
// comes from menu.js (and test/menu.test.mjs checks it); the previews come from menuArt.js.
function showChooser(preselect, preselectLevel = null, preselectScenario = null) {
  const chooser = $('#chooser');
  chooser.hidden = false;
  const cards = [...chooser.querySelectorAll('[data-ship]')];
  const rows = [...chooser.querySelectorAll('.mission')];
  const segs = [...chooser.querySelectorAll('.pick[data-mode]')];
  const tabs = [...chooser.querySelectorAll('[data-tab]')];
  const summary = $('#ch-summary');
  const shipStep = chooser.querySelector('.brief-ship');
  const drillStep = chooser.querySelector('.brief-drill');
  const levelStep = chooser.querySelector('.brief-level');
  const levelBtns = [...chooser.querySelectorAll('[data-level]')];
  const scenarioStep = chooser.querySelector('.brief-scenario');
  const scenarioBtns = [...chooser.querySelectorAll('[data-scenario]')];
  const startBtn = $('#ch-start');
  const sub = $('#chooser-sub');
  const lastEl = $('#ch-last');
  const stage = $('#ch-stage');
  const kindEl = $('#ch-kind');
  const titleEl = $('#ch-title');
  const tagEl = $('#ch-tag');
  const factsEl = $('#ch-facts');
  const keysEl = $('#ch-keys');
  const moreEl = $('#ch-keys-more');
  const tabHint = $('#ch-tabhint');
  const li = (text) => Object.assign(document.createElement('li'), { textContent: text });
  const reduced = (() => { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; } })();

  // Each mission remembers its own launcher, and the drills their number of ships.
  const validShip = (id) => (cards.some((c) => c.dataset.ship === id) ? id : null);
  const shipFor = {};
  for (const m of MISSION_IDS) {
    if (!missionById(m).ship) continue;
    shipFor[m] = validShip(read('localStorage', `intercept.ship.${m}`)) ?? validShip(read('localStorage', 'intercept.ship')) ?? 'fwd';
  }
  // The address names a launcher for its own mission only: launch() writes ?ship= even for the missions with none.
  if (validShip(preselect) && missionById(mode).ship) shipFor[mode] = preselect;
  const drills = ENTRIES.find((e) => e.family).members;
  const lastIn = { watch: 'intercept', play: 'fly', command: 'squadron', drill: drills.includes(read('localStorage', 'intercept.drill')) ? read('localStorage', 'intercept.drill') : drills[0] };
  lastIn[groupOf(mode)] = mode;
  level = validLevel(preselectLevel) ?? validLevel(read('localStorage', mode === 'squadron' ? 'intercept.level.squadron' : 'intercept.level.duel')) ?? validLevel(read('localStorage', 'intercept.level.duel')) ?? DEFAULT_LEVEL;
  scenario = validScenario(preselectScenario) ?? validScenario(read('localStorage', 'intercept.scenario.squadron')) ?? DEFAULT_SCENARIO;
  const lastPlayed = MISSION_IDS.includes(rememberedMode) ? rememberedMode : null;
  const shipNow = () => shipFor[mode] ?? FIXED_SHIP;

  let artKey = '';
  const paint = () => {
    const ship = shipNow();
    const t = menuText(mode, ship);
    const group = groupOf(mode);
    tabs.forEach((b) => b.setAttribute('aria-checked', String(b.dataset.tab === group)));
    tabHint.textContent = GROUPS.find((g) => g.id === group).hint;
    rows.forEach((b) => {
      b.hidden = b.dataset.group !== group;
      b.setAttribute('aria-checked', String(b.dataset.family ? group === 'drill' : b.dataset.mode === mode));
    });
    segs.forEach((b) => b.setAttribute('aria-checked', String(b.dataset.mode === mode)));
    cards.forEach((c) => c.setAttribute('aria-checked', String(c.dataset.ship === ship)));
    const key = t.hasShip ? `${mode}:${ship}` : mode;
    if (key !== artKey) { artKey = key; stage.innerHTML = previewArt(mode, ship, !reduced); } // a fresh svg restarts the loop
    kindEl.textContent = t.kind;
    titleEl.textContent = t.title;
    tagEl.textContent = t.tagline;
    factsEl.replaceChildren(...t.facts.map(li));
    const all = group === 'play' || group === 'command' || t.keys.length <= 5;
    const shown = all ? t.keys : t.keys.slice(0, 4);
    keysEl.replaceChildren(...shown.map(([k, label]) => {
      const item = li('');
      const kbd = document.createElement('kbd');
      kbd.textContent = k;
      item.append(kbd, label);
      return item;
    }));
    moreEl.textContent = all ? '' : `${t.keys.length - shown.length} more once it is running.`;
    shipStep.hidden = !t.hasShip; // the missions with a fixed ship have no launcher to pick
    drillStep.hidden = group !== 'drill';
    levelStep.hidden = !t.hasLevel;
    levelBtns.forEach((b) => b.setAttribute('aria-checked', String(b.dataset.level === level)));
    scenarioStep.hidden = !t.hasScenario;
    scenarioBtns.forEach((b) => b.setAttribute('aria-checked', String(b.dataset.scenario === scenario)));
    startBtn.firstChild.textContent = `${t.button} `;
    summary.textContent = t.summary;
    sub.textContent = t.note;
    lastEl.hidden = lastPlayed !== mode;
    document.title = t.tabTitle;
  };
  const setMode = (m) => { mode = m; lastIn[groupOf(m)] = m; paint(); };
  const setShip = (id) => { if (missionById(mode).ship) { shipFor[mode] = id; paint(); } };
  const setLevel = (id) => { level = id; paint(); };
  const setScenario = (id) => { scenario = id; paint(); };
  const setTab = (g) => setMode(lastIn[g]);
  const pickRow = (row) => setMode(row.dataset.family ? lastIn.drill : row.dataset.mode);
  const go = () => { window.removeEventListener('keydown', onKey); launch(menuText(mode, shipNow()).hasShip ? shipNow() : FIXED_SHIP); };

  // Arrow keys move within a radio group (focus follows selection, as radios do); the list skips the rows of the other tabs.
  const arrows = (list, i, e, pick) => {
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1;
    const next = list[(i + step + list.length) % list.length];
    pick(next);
    next.focus();
  };
  const onKey = (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const group = groupOf(mode);
    if (e.key.startsWith('Arrow')) {
      const visible = rows.filter((r) => !r.hidden);
      const groups = [[tabs, (b) => setTab(b.dataset.tab)], [visible, pickRow], [segs, (b) => setMode(b.dataset.mode)], [cards, (b) => setShip(b.dataset.ship)], [levelBtns, (b) => setLevel(b.dataset.level)], [scenarioBtns, (b) => setScenario(b.dataset.scenario)]];
      const hit = groups.find(([list]) => list.includes(e.target));
      if (hit) arrows(hit[0], hit[0].indexOf(e.target), e, hit[1]);
      else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && group === 'drill') arrows(segs, segs.findIndex((b) => b.dataset.mode === mode), e, (b) => setMode(b.dataset.mode));
      else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && menuText(mode, shipNow()).hasShip) setShip(shipNow() === 'fwd' ? 'aft' : 'fwd');
      else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && menuText(mode, shipNow()).hasLevel) arrows(levelBtns, levelBtns.findIndex((b) => b.dataset.level === level), e, (b) => setLevel(b.dataset.level));
      else return;
      e.preventDefault();
    } else if ((e.key === 's' || e.key === 'S') && menuText(mode, shipNow()).hasScenario) {
      setScenario(SQUADRON_SCENARIOS[(SQUADRON_SCENARIOS.findIndex((x) => x.id === scenario) + 1) % SQUADRON_SCENARIOS.length].id); // S: the other scenario
    } else if (e.key === 'm' || e.key === 'M') {
      const next = ENTRIES[(ENTRIES.findIndex((en) => en.members.includes(mode)) + 1) % ENTRIES.length];
      setMode(next.family ? lastIn[next.group] : next.id);
    } else if (e.key >= '1' && e.key <= '3') {
      const n = Number(e.key);
      if (group === 'drill') setMode(segs[n - 1].dataset.mode);
      else if (menuText(mode, shipNow()).hasShip && n <= cards.length) setShip(cards[n - 1].dataset.ship);
      else if (menuText(mode, shipNow()).hasLevel) setLevel(levelBtns[n - 1].dataset.level);
    } else if (e.key === 'Enter') { e.preventDefault(); go(); } // also when a card has focus after a click
  };

  tabs.forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));
  rows.forEach((b) => b.addEventListener('click', () => pickRow(b)));
  segs.forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
  levelBtns.forEach((b) => b.addEventListener('click', () => setLevel(b.dataset.level)));
  scenarioBtns.forEach((b) => b.addEventListener('click', () => setScenario(b.dataset.scenario)));
  // A double click on a mission, a drill size, a level or a scenario enters the mission (its first click already picked it).
  [...rows, ...segs, ...levelBtns, ...scenarioBtns].forEach((b) => b.addEventListener('dblclick', go));
  cards.forEach((c) => {
    c.addEventListener('click', () => setShip(c.dataset.ship));
    c.addEventListener('dblclick', go); // a double click still starts straight away
  });
  $('#ch-start').addEventListener('click', go);
  window.addEventListener('keydown', onKey);
  paint();
  $('#ch-start').focus({ preventScroll: true });
}

// "Change ship" reloads with this flag so the chooser shows even though the
// URL still names a ship.
const forceChooser = read('sessionStorage', 'intercept.chooser') === '1';
write('sessionStorage', 'intercept.chooser', '0');
const skipChooser = read('sessionStorage', 'intercept.skip') === '1';
write('sessionStorage', 'intercept.skip', '0');
let fromUrl = null;
let modeFromUrl = null;
let levelFromUrl = null;
let scenarioFromUrl = null;
let scripted = false;
try {
  const params = new URLSearchParams(location.search);
  fromUrl = params.get('ship');
  modeFromUrl = params.get('mode');
  levelFromUrl = params.get('level');
  scenarioFromUrl = params.get('scenario');
  scripted = params.has('start'); // ?start=1: for scripted and headless runs only
} catch { /* ignore */ }
const rememberedMode = read('localStorage', 'intercept.mode');
mode = MODES.includes(modeFromUrl) ? modeFromUrl : (MODES.includes(rememberedMode) ? rememberedMode : 'intercept');
const validShip = fromUrl === 'fwd' || fromUrl === 'aft';
if ((validShip || isDrill(mode) || mode === 'formations' || mode === 'fly' || mode === 'helm' || mode === 'duel' || mode === 'squadron') && !forceChooser && (skipChooser || scripted)) {
  level = validLevel(levelFromUrl) ?? validLevel(read('localStorage', mode === 'squadron' ? 'intercept.level.squadron' : 'intercept.level.duel')) ?? validLevel(read('localStorage', 'intercept.level.duel')) ?? DEFAULT_LEVEL;
  scenario = validScenario(scenarioFromUrl) ?? validScenario(read('localStorage', 'intercept.scenario.squadron')) ?? DEFAULT_SCENARIO;
  launch(validShip ? fromUrl : 'fwd');
} else showChooser(validShip ? fromUrl : null, validLevel(levelFromUrl), validScenario(scenarioFromUrl));

// The top bar's Menu button goes back to the main menu through each scene's own handler on #btn-ship.
document.querySelector('#btn-home')?.addEventListener('click', () => document.querySelector('#btn-ship')?.click());

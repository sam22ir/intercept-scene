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

import { MISSION_IDS, ENEMY_LEVELS, DEFAULT_LEVEL, groupOf, menuText } from './menu.js';
import { createMainMenu } from './mainMenu.js';
import { ui, readLang } from './i18n.js';
import { installFrench } from './frenchDom.js';
import { MISSION_FR } from './missionFr.js';

const MODES = MISSION_IDS;
let mode = 'intercept';
// The two- and three-ship drills are one scene (maneuversMain.js); the model reads the number of ships once at import.
const isDrill = (m) => m === 'maneuvers' || m === 'maneuvers2';

// The ship duel's enemy level (a choice on the start screen, like the launcher); the scene reads it once.
let level = DEFAULT_LEVEL;
const validLevel = (id) => (ENEMY_LEVELS.some((l) => l.id === id) ? id : null);

let launched = false;
async function launch(id) {
  if (launched) return; // Enter on a focused button fires both keydown and click
  launched = true;
  globalThis.__SHIP_VARIANT = id;
  // The maneuvers and fly missions have their own scenes; scenario.js (which the ship model imports) just sees
  // an intercept for the first and a recovery (no scripted missile to simulate) for the second.
  globalThis.__SCENARIO = isDrill(mode) || mode === 'formations' ? 'intercept' : mode === 'fly' || mode === 'helm' || mode === 'harbour' || mode === 'mob' || mode === 'duel' ? 'chute' : mode;
  if (mode === 'harbour' || mode === 'mob') globalThis.__HARBOUR_DRILL = mode; // one scene, two exercises
  if (isDrill(mode)) globalThis.__DRILL_SHIPS = mode === 'maneuvers2' ? 2 : 3;
  if (menuText(mode, id).hasShip) { // the missions without a choice leave it alone
    write('localStorage', 'intercept.ship', id);
    write('localStorage', `intercept.ship.${mode}`, id); // each mission remembers its own launcher
  }
  if (groupOf(mode) === 'drill') write('localStorage', 'intercept.drill', mode); // and the drill its number of ships
  if (menuText(mode, id).hasLevel) { globalThis.__DUEL_LEVEL = level; write('localStorage', 'intercept.level.duel', level); }
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
  $('#loading-text').textContent = ui().loading;
  // French: the missions write English, and frenchDom.js translates what they show (the harbour pilot is French already).
  if (readLang() === 'fr' && mode !== 'harbour') globalThis.__french = installFrench(MISSION_FR);
  $('#loading').hidden = false;
  window.addEventListener('error', (e) => showFatal(e.error ?? e.message));
  window.addEventListener('unhandledrejection', (e) => showFatal(e.reason));
  // Let the loading screen paint before the scene's heavy synchronous setup.
  await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 30)));
  try {
    await (isDrill(mode) ? import('./maneuversMain.js') : mode === 'formations' ? import('./formationsMain.js')
      : mode === 'fly' ? import('./flyMain.js') : mode === 'helm' ? import('./helmMain.js') : mode === 'harbour' || mode === 'mob' ? import('./harbourMain.js') : mode === 'duel' ? import('./duelMain.js') : import('./main.js'));
  } catch (err) {
    showFatal(err);
  }
}

// The main menu (mainMenu.js) shows the missions and their options; Start hands the choice back here.
function showChooser(preselect, preselectLevel = null) {
  createMainMenu($('#chooser'), {
    mode,
    ship: preselect,
    level: validLevel(preselectLevel) ?? validLevel(read('localStorage', 'intercept.level.duel')) ?? DEFAULT_LEVEL,
    lastPlayed: MISSION_IDS.includes(rememberedMode) ? rememberedMode : null,
    reducedMotion: (() => { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; } })(),
    onLaunch: (choice) => { mode = choice.mode; level = choice.level; launch(choice.ship); },
  });
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
let scripted = false;
try {
  const params = new URLSearchParams(location.search);
  fromUrl = params.get('ship');
  modeFromUrl = params.get('mode');
  levelFromUrl = params.get('level');
  scripted = params.has('start'); // ?start=1: for scripted and headless runs only
} catch { /* ignore */ }
const rememberedMode = read('localStorage', 'intercept.mode');
mode = MODES.includes(modeFromUrl) ? modeFromUrl : (MODES.includes(rememberedMode) ? rememberedMode : 'intercept');
const validShip = fromUrl === 'fwd' || fromUrl === 'aft';
if ((validShip || isDrill(mode) || mode === 'formations' || mode === 'fly' || mode === 'helm' || mode === 'harbour' || mode === 'mob' || mode === 'duel') && !forceChooser && (skipChooser || scripted)) {
  level = validLevel(levelFromUrl) ?? validLevel(read('localStorage', 'intercept.level.duel')) ?? DEFAULT_LEVEL;
  launch(validShip ? fromUrl : 'fwd');
} else showChooser(validShip ? fromUrl : null, validLevel(levelFromUrl));

// The top bar's Menu button goes back to the main menu through each scene's own handler on #btn-ship.
document.querySelector('#btn-home')?.addEventListener('click', () => document.querySelector('#btn-ship')?.click());

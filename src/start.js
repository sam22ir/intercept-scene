import './style.css';

// Entry point. The ship fit and the mission are chosen on a start screen, and the page
// ALWAYS opens on it, whatever the address: a ?ship=/?mode= only preselects the choices, and
// a shared link's moment (?t, ?focus, ?cam, #path) waits until Start is pressed. The only ways
// past it are ?start=1 (scripted and headless runs; it removes itself from the address bar
// once used) and the app's own reloads (the path editor, the engagement panel and the
// maneuvers' standby stepper set sessionStorage 'intercept.skip' before reloading, which
// is read once).
// scenario.js reads `globalThis.__SHIP_VARIANT` / `__SCENARIO` (set here) or
// ?ship=fwd|aft and ?mode=intercept|chute|pair at import time, so the scene is
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

import { MISSION_IDS, FIXED_SHIP, menuText } from './menu.js';

const MODES = MISSION_IDS;
let mode = 'intercept';

let launched = false;
async function launch(id) {
  if (launched) return; // Enter on a focused button fires both keydown and click
  launched = true;
  globalThis.__SHIP_VARIANT = id;
  // The maneuvers and fly missions have their own scenes; scenario.js (which the ship model imports) just sees
  // an intercept for the first and a recovery (no scripted missile to simulate) for the second.
  globalThis.__SCENARIO = mode === 'maneuvers' || mode === 'formations' ? 'intercept' : mode === 'fly' ? 'chute' : mode;
  if (menuText(mode, id).hasShip) write('localStorage', 'intercept.ship', id); // the missions without a choice leave it alone
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
    await (mode === 'maneuvers' ? import('./maneuversMain.js') : mode === 'formations' ? import('./formationsMain.js')
      : mode === 'fly' ? import('./flyMain.js') : import('./main.js'));
  } catch (err) {
    showFatal(err);
  }
}

// Two choices (mission, launcher) and a Start button. Selection changes only on click or
// key; hover is visual only, so the summary and the Start target never follow the mouse. Every word the
// screen says for a choice comes from menu.js (and test/menu.test.mjs checks it).
function showChooser(preselect) {
  const chooser = $('#chooser');
  chooser.hidden = false;
  const cards = [...chooser.querySelectorAll('[data-ship]')];
  const missions = [...chooser.querySelectorAll('[data-mode]')];
  const summary = $('#ch-summary');
  const shipStep = chooser.querySelector('[aria-labelledby="ch-step2"]');
  const startBtn = $('#ch-start');
  const sub = $('#chooser-sub');
  const remembered = read('localStorage', 'intercept.ship');
  const startShip = cards.some((c) => c.dataset.ship === preselect) ? preselect : remembered;
  let ship = cards.some((c) => c.dataset.ship === startShip) ? startShip : 'fwd';

  const art = $('#ch-art');
  const kindEl = $('#ch-kind');
  const titleEl = $('#ch-title');
  const tagEl = $('#ch-tag');
  const factsEl = $('#ch-facts');
  const keysEl = $('#ch-keys');
  const li = (text) => Object.assign(document.createElement('li'), { textContent: text });

  // Everything the screen says follows the choice, from menu.js.
  const paint = () => {
    const t = menuText(mode, ship);
    cards.forEach((c) => c.setAttribute('aria-checked', String(c.dataset.ship === ship)));
    missions.forEach((b) => b.setAttribute('aria-checked', String(b.dataset.mode === mode)));
    const row = missions.find((b) => b.dataset.mode === mode);
    art.innerHTML = row?.querySelector('svg')?.outerHTML ?? '';
    kindEl.textContent = t.kind;
    titleEl.textContent = t.title;
    tagEl.textContent = t.tagline;
    factsEl.replaceChildren(...t.facts.map(li));
    keysEl.replaceChildren(...t.keys.map(([key, label]) => {
      const item = li('');
      const kbd = document.createElement('kbd');
      kbd.textContent = key;
      item.append(kbd, label);
      return item;
    }));
    shipStep.hidden = !t.hasShip; // the missions with a fixed ship have no launcher to pick
    startBtn.firstChild.textContent = `${t.button} `;
    summary.textContent = t.summary;
    sub.textContent = t.note;
    document.title = t.tabTitle;
  };
  const setMode = (m) => { mode = m; paint(); };
  const setShip = (id) => { ship = id; paint(); };
  const go = () => { window.removeEventListener('keydown', onKey); launch(menuText(mode, ship).hasShip ? ship : FIXED_SHIP); };

  // Arrow keys move within a radio group (focus follows selection, as radios do).
  const arrows = (list, i, e, set, key) => {
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1;
    const next = list[(i + step + list.length) % list.length];
    set(next.dataset[key]);
    next.focus();
  };
  const onKey = (e) => {
    if (e.key.startsWith('Arrow')) {
      const mi = missions.indexOf(e.target);
      const ci = cards.indexOf(e.target);
      if (mi >= 0) arrows(missions, mi, e, setMode, 'mode');
      else if (ci >= 0) arrows(cards, ci, e, setShip, 'ship');
      else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && menuText(mode, ship).hasShip) setShip(ship === 'fwd' ? 'aft' : 'fwd');
      else return;
      e.preventDefault();
    } else if (e.key === 'm' || e.key === 'M') setMode(MODES[(MODES.indexOf(mode) + 1) % MODES.length]);
    else if ((e.key === '1' || e.key === '2') && menuText(mode, ship).hasShip) setShip(cards[Number(e.key) - 1].dataset.ship);
    else if (e.key === 'Enter') { e.preventDefault(); go(); } // also when a card has focus after a click
  };

  missions.forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
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
let scripted = false;
try {
  const params = new URLSearchParams(location.search);
  fromUrl = params.get('ship');
  modeFromUrl = params.get('mode');
  scripted = params.has('start'); // ?start=1: for scripted and headless runs only
} catch { /* ignore */ }
const rememberedMode = read('localStorage', 'intercept.mode');
mode = MODES.includes(modeFromUrl) ? modeFromUrl : (MODES.includes(rememberedMode) ? rememberedMode : 'intercept');
const validShip = fromUrl === 'fwd' || fromUrl === 'aft';
if ((validShip || mode === 'maneuvers' || mode === 'formations' || mode === 'fly') && !forceChooser && (skipChooser || scripted)) launch(validShip ? fromUrl : 'fwd');
else showChooser(validShip ? fromUrl : null);

// The top bar's Menu button goes back to the main menu through each scene's own handler on #btn-ship.
document.querySelector('#btn-home')?.addEventListener('click', () => document.querySelector('#btn-ship')?.click());

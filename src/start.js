import './style.css';

// Entry point. The ship fit and the mission are chosen on a start screen.
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

const MODES = ['intercept', 'chute', 'pair'];
let mode = 'intercept';

let launched = false;
async function launch(id) {
  if (launched) return; // Enter on a focused button fires both keydown and click
  launched = true;
  globalThis.__SHIP_VARIANT = id;
  globalThis.__SCENARIO = mode;
  write('localStorage', 'intercept.ship', id);
  write('localStorage', 'intercept.mode', mode);
  try {
    const url = new URL(location.href);
    url.searchParams.set('ship', id);
    url.searchParams.set('mode', mode);
    history.replaceState(null, '', url); // keeps a refresh on the same ship
  } catch { /* not allowed in some viewers: fine */ }
  $('#chooser').hidden = true;
  document.body.classList.add('playing');
  $('#loading').hidden = false;
  window.addEventListener('error', (e) => showFatal(e.error ?? e.message));
  window.addEventListener('unhandledrejection', (e) => showFatal(e.reason));
  // Let the loading screen paint before the scene's heavy synchronous setup.
  await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 30)));
  try {
    await import('./main.js');
  } catch (err) {
    showFatal(err);
  }
}

// Two choices (mission, ship) and a Start button. Selection changes only on click or
// key; hover is visual only, so the summary and the Start target never follow the mouse.
const SHIP_NAMES = { fwd: '920 · Forward launcher', aft: '921 · Aft launcher' };
const MODE_NAMES = { intercept: 'Intercept', chute: 'Recovery', pair: 'Two drones' };
const MODE_NOTES = {
  intercept: 'Same drone, same shot on either ship. The difference is where the launcher sits.',
  chute: 'The missile is never fired: the drone opens an orange parachute and lands in the sea.',
  pair: 'A second drone leaves the same catapult 14 s later, on a wider, higher track.',
};

function showChooser() {
  const chooser = $('#chooser');
  chooser.hidden = false;
  const cards = [...chooser.querySelectorAll('[data-ship]')];
  const missions = [...chooser.querySelectorAll('[data-mode]')];
  const summary = $('#ch-summary');
  const sub = $('#chooser-sub');
  const remembered = read('localStorage', 'intercept.ship');
  let ship = cards.some((c) => c.dataset.ship === remembered) ? remembered : 'fwd';

  const paint = () => {
    cards.forEach((c) => c.setAttribute('aria-checked', String(c.dataset.ship === ship)));
    missions.forEach((b) => b.setAttribute('aria-checked', String(b.dataset.mode === mode)));
    summary.textContent = `${MODE_NAMES[mode]} · ${SHIP_NAMES[ship]}`;
    sub.textContent = MODE_NOTES[mode];
  };
  const setMode = (m) => { mode = m; paint(); };
  const setShip = (id) => { ship = id; paint(); };
  const go = () => { window.removeEventListener('keydown', onKey); launch(ship); };

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
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') setShip(ship === 'fwd' ? 'aft' : 'fwd');
      else return;
      e.preventDefault();
    } else if (e.key === 'm' || e.key === 'M') setMode(MODES[(MODES.indexOf(mode) + 1) % MODES.length]);
    else if (e.key === '1' || e.key === '2') setShip(cards[Number(e.key) - 1].dataset.ship);
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
let fromUrl = null;
let modeFromUrl = null;
try {
  const params = new URLSearchParams(location.search);
  fromUrl = params.get('ship');
  modeFromUrl = params.get('mode');
} catch { /* ignore */ }
const rememberedMode = read('localStorage', 'intercept.mode');
mode = MODES.includes(modeFromUrl) ? modeFromUrl : (MODES.includes(rememberedMode) ? rememberedMode : 'intercept');
if ((fromUrl === 'fwd' || fromUrl === 'aft') && !forceChooser) launch(fromUrl);
else showChooser();

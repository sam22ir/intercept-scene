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

async function launch(id) {
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

function showChooser() {
  const chooser = $('#chooser');
  chooser.hidden = false;
  const cards = [...chooser.querySelectorAll('[data-ship]')];
  const remembered = read('localStorage', 'intercept.ship');
  let focused = Math.max(0, cards.findIndex((c) => c.dataset.ship === remembered));
  const mark = () => cards.forEach((c, i) => c.classList.toggle('focused', i === focused));
  const sub = $('#chooser-sub');
  const missions = [...chooser.querySelectorAll('[data-mode]')];
  const setMode = (m) => {
    mode = m;
    missions.forEach((b) => b.classList.toggle('active', b.dataset.mode === m));
    sub.textContent = m === 'chute'
      ? 'The missile is never fired: the drone finishes its flight, opens an orange parachute and lands in the sea. The ship choice changes the ship only.'
      : m === 'pair'
        ? 'A second drone leaves the same catapult 14 s after the first, on a wider, higher track. The frigate fires one missile at each.'
        : 'Same drone, same shot. The difference is where the missile launcher sits.';
  };
  missions.forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
  setMode(mode);
  const pick = (id) => { window.removeEventListener('keydown', onKey); launch(id); };
  const onKey = (e) => {
    if (e.key === 'm' || e.key === 'M') setMode(MODES[(MODES.indexOf(mode) + 1) % MODES.length]);
    else if (e.key === '1' || e.key === '2') pick(cards[Number(e.key) - 1].dataset.ship);
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { focused = (focused + 1) % cards.length; mark(); }
    else if (e.key === 'Enter') pick(cards[focused].dataset.ship);
  };
  mark();
  cards.forEach((c, i) => {
    c.addEventListener('click', () => pick(c.dataset.ship));
    c.addEventListener('pointerenter', () => { focused = i; mark(); });
  });
  window.addEventListener('keydown', onKey);
  cards[focused].focus();
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

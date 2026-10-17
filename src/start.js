import './style.css';

// Entry point. The ship fit is chosen on a start screen. scenario.js reads
// `globalThis.__SHIP_VARIANT` (set here) or ?ship=fwd|aft at import time, so
// the scene is imported only after a ship is picked: no page reload needed.

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

async function launch(id) {
  globalThis.__SHIP_VARIANT = id;
  write('localStorage', 'intercept.ship', id);
  try {
    const url = new URL(location.href);
    url.searchParams.set('ship', id);
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
  const pick = (id) => { window.removeEventListener('keydown', onKey); launch(id); };
  const onKey = (e) => {
    if (e.key === '1' || e.key === '2') pick(cards[Number(e.key) - 1].dataset.ship);
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
try { fromUrl = new URLSearchParams(location.search).get('ship'); } catch { /* ignore */ }
if ((fromUrl === 'fwd' || fromUrl === 'aft') && !forceChooser) launch(fromUrl);
else showChooser();

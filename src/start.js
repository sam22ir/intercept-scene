import './style.css';

// Entry point. The ship fit is chosen on a start screen and applied by
// reloading with ?ship=fwd|aft (scenario.js reads it at import time), so the
// scene is only imported once a ship is picked.
const ships = new URLSearchParams(location.search).get('ship');
let remembered = null;
try { remembered = localStorage.getItem('intercept.ship'); } catch { /* storage unavailable */ }

if (ships === 'fwd' || ships === 'aft') {
  try { localStorage.setItem('intercept.ship', ships); } catch { /* storage unavailable */ }
  document.body.classList.add('playing');
  import('./main.js');
} else {
  const chooser = document.querySelector('#chooser');
  chooser.hidden = false;
  const cards = [...chooser.querySelectorAll('[data-ship]')];
  const pick = (id) => { location.search = `?ship=${id}`; };
  let focused = Math.max(0, cards.findIndex((c) => c.dataset.ship === remembered));
  const mark = () => cards.forEach((c, i) => c.classList.toggle('focused', i === focused));
  mark();
  cards.forEach((c, i) => {
    c.addEventListener('click', () => pick(c.dataset.ship));
    c.addEventListener('pointerenter', () => { focused = i; mark(); });
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === '1' || e.key === '2') pick(cards[Number(e.key) - 1].dataset.ship);
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { focused = (focused + 1) % cards.length; mark(); }
    else if (e.key === 'Enter') pick(cards[focused].dataset.ship);
  });
  cards[focused].focus();
}

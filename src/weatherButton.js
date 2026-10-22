import { WEATHERS } from './looks.js';

// The More menu's "Weather" entry for the missions that have a look (looks.js): it cycles Auto (the mission's own weather),
// Clear, Haze, Squalls and Overcast. The weather is read once at start-up, so a change is stored and the scene reloads, back
// into the mission and (for the scripted ones) to the same moment.
const KEY = 'intercept.weather';
const CHOICES = ['auto', ...WEATHERS];
const LABEL = { auto: 'Auto', clear: 'Clear', haze: 'Hazy', squalls: 'Squalls', overcast: 'Overcast' };

export function wireWeather({ look, getTime = null }) {
  const button = document.querySelector('#btn-weather');
  if (!button) return;
  if (!look) { button.hidden = true; return; }
  let stored = 'auto';
  try { const w = localStorage.getItem(KEY); if (WEATHERS.includes(w)) stored = w; } catch { /* blocked storage */ }
  const show = () => {
    button.firstChild.textContent = `Weather: ${LABEL[stored]}${stored === 'auto' ? ` (${LABEL[look.weather]})` : ''}`;
    button.dataset.weather = stored;
  };
  button.hidden = false;
  show();
  button.addEventListener('click', () => {
    stored = CHOICES[(CHOICES.indexOf(stored) + 1) % CHOICES.length];
    try {
      if (stored === 'auto') localStorage.removeItem(KEY); else localStorage.setItem(KEY, stored);
      sessionStorage.setItem('intercept.skip', '1'); // straight back into the scene
      if (getTime) sessionStorage.setItem('intercept.seek', String(getTime()));
      const url = new URL(location.href);
      if (url.searchParams.has('weather')) { url.searchParams.delete('weather'); history.replaceState(null, '', url); }
      location.reload();
    } catch { show(); }
  });
}

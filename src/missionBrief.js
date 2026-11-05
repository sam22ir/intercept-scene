import { PLAN_DEFAULTS, PLAN_RANGES, RAIL_END, TOD_CHOICES, WEATHER_CHOICES, generatePath, linkRanges, loadPlan, planStats, validatePlan } from './missionPlan.js';

// The window that opens on Start in the Watch missions: the mission's settings beside a live drawing of the drone's path,
// from above and from the side, generated from them by missionPlan.js. It only hands the plan back: start.js stores it and
// scenario.js flies it. All its words are in i18n.js.

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const read = (key) => { try { return globalThis.localStorage.getItem(key); } catch { return null; } };
const pathKey = (mode, ship) => `intercept.path.${mode === 'chute' ? 'chute.' : ''}${ship === 'aft' ? 'aft.' : ''}v2`;
const clock = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
const int = (n) => Math.round(n).toLocaleString('en-US');

// A plan to start from: the last one, with the weather as the Settings page has it.
function startingPlan() {
  const plan = loadPlan() ?? { ...PLAN_DEFAULTS };
  const w = read('intercept.weather');
  return { ...plan, droneSpeed: PLAN_DEFAULTS.droneSpeed, weather: WEATHER_CHOICES.includes(w) ? w : 'auto' }; // the cruise speed is not a choice
}

const VALUE = {
  alt: (v) => `${int(v)} m`,
  runAlt: (v) => `${int(v)} m`,
  turnBack: (v) => `${int(v)} m`,
  engage: (v) => `${int(v)} m`,
  shipKn: (v) => `${v} kn`,
  heading: (v) => `${String(v).padStart(3, '0')}°`,
  burst: (v, u) => (v === 0 ? u.bBurstHit : `${v} m`),
};

// The drawing: from above with the bow to the right and port up, then height against distance flown.
function drawView(plan, path, mode, ship, u) {
  const W = 460;
  const H = 230;
  const pts = [[RAIL_END[0], RAIL_END[2]], ...path.points.map((p) => [p[0], p[2]])];
  const xs = pts.map((p) => p[0]);
  const zs = pts.map((p) => p[1]);
  const pad = 34;
  const e = path.engage; // the range ring stays on the drawing too
  const x0 = Math.min(...xs, -e), x1 = Math.max(...xs, e), z0 = Math.min(...zs, -e), z1 = Math.max(...zs, e);
  const k = Math.min((W - 2 * pad) / Math.max(1, x1 - x0), (H - 2 * pad) / Math.max(1, z1 - z0));
  const ox = (W - k * (x1 - x0)) / 2 - k * x0;
  const oz = (H - k * (z1 - z0)) / 2 - k * z0;
  const sx = (x) => (ox + k * x).toFixed(1);
  const sz = (z) => (oz + k * z).toFixed(1);
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${sx(p[0])} ${sz(p[1])}`).join('');
  const dir = ship === 'aft' ? -1 : 1;
  const ex = dir * path.engage;
  const north = (-plan.heading * Math.PI) / 180; // the way north lies from the bow, which points right on the drawing
  const cx = W - 34;
  const nx = cx + 11 * Math.sin(north + Math.PI / 2);
  const ny = 30 - 11 * Math.cos(north + Math.PI / 2);
  const flip = (x) => (Number(sx(x)) > W - 90 ? 'end' : 'start');
  const top = `<svg class="br-map" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(u.bPreview)}">`
    + `<circle class="br-ring" cx="${sx(0)}" cy="${sz(0)}" r="${(k * path.engage).toFixed(1)}"/>`
    + `<path class="br-path" d="${line}"/>`
    + `<path class="br-ship" transform="translate(${sx(0)} ${sz(0)})" d="M-13 -4H7L14 0L7 4H-13Z"/>`
    + `<circle class="br-turn" cx="${sx(path.turnPoint[0])}" cy="${sz(path.turnPoint[1])}" r="4"/>`
    + `<text class="br-txt" x="${sx(path.turnPoint[0])}" y="${Number(sz(path.turnPoint[1])) - 9}" text-anchor="middle">${esc(u.bMapTurn)} ${int(path.turnBack)} m</text>`
    + `<circle class="br-fire" cx="${sx(ex)}" cy="${sz(0)}" r="5"/>`
    + `<text class="br-txt fire" x="${sx(ex)}" y="${Number(sz(0)) + 18}" text-anchor="${flip(ex)}">${esc(mode === 'chute' ? u.bMapLock : u.bMapFire)} ${int(path.engage)} m</text>`
    + `<g class="br-north"><circle cx="${cx}" cy="30" r="13"/><path d="M${cx} 30L${nx.toFixed(1)} ${ny.toFixed(1)}"/><text x="${(cx + 21 * Math.sin(north + Math.PI / 2)).toFixed(1)}" y="${(34 - 21 * Math.cos(north + Math.PI / 2)).toFixed(1)}" text-anchor="middle">N</text></g>`
    + '</svg>';

  const PW = 460;
  const PH = 76;
  const all = [RAIL_END, ...path.points];
  let s = 0;
  const prof = all.map((p, i) => {
    if (i) s += Math.hypot(p[0] - all[i - 1][0], p[2] - all[i - 1][2]);
    return [s, p[1]];
  });
  const hMax = Math.max(...prof.map((p) => p[1]), 1);
  const px = (d) => (34 + ((PW - 44) * d) / Math.max(1, s)).toFixed(1);
  const py = (h) => (PH - 12 - ((PH - 26) * h) / hMax).toFixed(1);
  const side = `<svg class="br-side" viewBox="0 0 ${PW} ${PH}" aria-hidden="true">`
    + `<path class="br-sea" d="M34 ${PH - 12}H${PW - 10}"/>`
    + `<path class="br-path" d="${prof.map((p, i) => `${i ? 'L' : 'M'}${px(p[0])} ${py(p[1])}`).join('')}"/>`
    + `<text class="br-txt" x="30" y="${Number(py(hMax)) + 4}" text-anchor="end">${int(hMax)}</text>`
    + `<text class="br-txt" x="30" y="${PH - 8}" text-anchor="end">0</text>`
    + '</svg>';
  return top + side;
}

const seg = (id, label, choices, value) => `<div class="br-row seg"><span>${esc(label)}</span><div class="mm-seg" role="radiogroup" aria-label="${esc(label)}">${choices.map(([v, l]) => `<button type="button" role="radio" data-seg="${id}" data-val="${v}" aria-checked="${v === value}">${esc(l)}</button>`).join('')}</div></div>`;

// `opts`: { mode, ship, title, button, u, onStart, onCancel } (the launcher is chosen on the mission's panel, before this window)
export function briefHtml({ mode, ship, title, button, u }) {
  const slider = (key, label) => {
    const [lo, hi, step] = PLAN_RANGES[key];
    return `<label class="br-row"><span>${esc(label)}</span><input type="range" data-key="${key}" min="${lo}" max="${hi}" step="${step}"><output data-out="${key}"></output></label>`;
  };
  const drawn = read(pathKey(mode, ship)) !== null;
  return `<header class="mm-dh"><h2>${esc(title)}</h2><button type="button" class="mm-x" data-close title="${esc(u.close)} (Esc)" aria-label="${esc(u.close)}">×</button></header>`
    + `<div class="mm-dbody br-body"><form class="br-form" onsubmit="return false">`
    + `<h3>${esc(u.bDrone)}</h3>`
    + slider('alt', u.bAlt) + slider('runAlt', u.bRunAlt) + slider('turnBack', u.bTurnBack) + slider('engage', mode === 'chute' ? u.bLock : u.bEngage)
    + (mode === 'chute' ? '' : slider('burst', u.bBurst))
    + `<h3>${esc(u.bShip)}</h3>`
    + slider('shipKn', u.bShipSpeed) + slider('heading', u.bHeading)
    + `<h3>${esc(u.bConditions)}</h3>`
    + seg('weather', u.sWeather, [['auto', u.auto], ['clear', u.wClear], ['haze', u.wHaze], ['squalls', u.wSqualls], ['overcast', u.wOvercast]], 'auto')
    + seg('tod', u.bTod, TOD_CHOICES.map((id) => [id, { auto: u.auto, dawn: u.bDawn, noon: u.bNoon, dusk: u.bDusk, night: u.bNight }[id]]), 'auto')
    + (drawn ? `<h3>${esc(u.bPath)}</h3>${seg('drawn', u.bPathFrom, [['0', u.bPathGen], ['1', u.bPathDrawn]], '0')}` : '')
    + `</form><div class="br-view"><div class="br-draw"></div><p class="br-stats"></p><ul class="br-notes"></ul></div></div>`
    + `<footer class="br-foot"><button type="button" class="mm-link" data-defaults>${esc(u.bDefaults)}</button><span></span><button type="button" class="br-cancel" data-close-2>${esc(u.bCancel)}</button><button type="button" class="mm-start br-start" id="br-start"><span>${esc(button)}</span><svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4.5l13 7.5-13 7.5z"/></svg></button></footer>`;
}

export function wireBrief(dlg, { mode, ship, u, onStart, onCancel }) {
  let plan = validatePlan(startingPlan());
  const drawn = () => plan.drawn && read(pathKey(mode, ship)) !== null;

  function update() {
    plan = validatePlan(plan);
    for (const input of dlg.querySelectorAll('input[data-key]')) {
      const key = input.dataset.key;
      input.value = plan[key];
      input.style.setProperty('--fill', `${((input.value - input.min) / (input.max - input.min)) * 100}%`);
      dlg.querySelector(`[data-out="${key}"]`).textContent = VALUE[key](plan[key], u);
    }
    dlg.querySelectorAll('[data-seg]').forEach((b) => {
      const { seg: id, val } = b.dataset;
      const now = id === 'drawn' ? (plan.drawn ? '1' : '0') : plan[id];
      b.setAttribute('aria-checked', String(val === now));
    });
    const path = generatePath(plan, { variant: ship, mode });
    const draw = dlg.querySelector('.br-draw');
    const usingDrawn = drawn();
    dlg.querySelector('.br-form').classList.toggle('br-drawn', usingDrawn);
    dlg.querySelector('.br-view').classList.toggle('br-drawn', usingDrawn);
    draw.innerHTML = drawView(plan, path, mode, ship, u);
    const s = planStats(plan, path);
    dlg.querySelector('.br-stats').textContent = usingDrawn ? u.bUsingDrawn : u.bStats(int(path.radius), Math.round(s.vMin), plan.droneSpeed, s.vMax > plan.droneSpeed + 0.5 ? Math.round(s.vMax) : null, clock(s.tEngage));
    dlg.querySelector('.br-notes').innerHTML = usingDrawn ? '' : path.notes.map((n) => `<li>${esc(u.bNote[n.key](int(n.value)))}</li>`).join('');
  }

  dlg.querySelectorAll('input[data-key]').forEach((input) => input.addEventListener('input', () => {
    plan[input.dataset.key] = Number(input.value);
    // The run in can be no higher than the top; moving the top takes it along when they were together.
    if (input.dataset.key === 'alt' && plan.runAlt > plan.alt) plan.runAlt = plan.alt;
    if (input.dataset.key === 'runAlt' && plan.runAlt > plan.alt) plan.alt = plan.runAlt;
    plan = linkRanges(plan, input.dataset.key, { variant: ship, mode });
    update();
  }));
  dlg.querySelectorAll('[data-seg]').forEach((b) => b.addEventListener('click', () => {
    const { seg: id, val } = b.dataset;
    if (id === 'drawn') plan.drawn = val === '1';
    else plan[id] = val;
    update();
  }));
  dlg.querySelector('[data-defaults]').addEventListener('click', () => { plan = { ...PLAN_DEFAULTS }; update(); });
  dlg.querySelector('[data-close-2]').addEventListener('click', onCancel);
  dlg.querySelector('#br-start').addEventListener('click', () => onStart({ ...plan, drawn: drawn() }));
  update();
}

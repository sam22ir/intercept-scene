import './mainMenu.css';
import {
  MISSIONS, MISSION_IDS, FIXED_SHIP, GROUPS, FAMILIES, SHIPS, ENEMY_LEVELS, DEFAULT_LEVEL,
  entriesOf, groupOf, missionById, menuText, missionIn, groupIn, shipIn, levelIn,
} from './menu.js';
import { previewArt } from './menuArt.js';
import { LANG, LANGS, UI, saveLang } from './i18n.js';

// The main menu, built from the data in menu.js / menuFr.js (no mission words live in index.html): a top bar
// (brand, language, Help, Settings), the four categories down the left, the category's missions, the selected
// mission's animated preview (menuArt.js) with its briefing, the set-up steps it has (launcher, number of ships,
// enemy level) and its controls, and Start. Help (about, missions, the in-mission buttons, this menu) and
// Settings (language and the preferences every mission reads from storage) are overlays. The language
// re-renders the menu at once; the missions read it when they load. Selection changes only on a click or a
// key, never on hover, and Start, Enter or a double click launches (once: `onLaunch` is start.js's launch()).

const $ = (root, s) => root.querySelector(s);
const read = (key) => { try { return globalThis.localStorage.getItem(key); } catch { return null; } };
const write = (key, v) => { try { if (v === null) globalThis.localStorage.removeItem(key); else globalThis.localStorage.setItem(key, v); } catch { /* storage unavailable */ } };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// The preferences on the Settings page, with the storage key each mission already reads.
export const SETTINGS = [
  { id: 'sound', key: 'intercept.sound', label: 'sSound', options: [['1', 'on'], ['0', 'off']], def: '1' },
  { id: 'units', key: 'intercept.units', label: 'sUnits', options: [['kmh', 'kmh'], ['kn', 'knots']], def: 'kmh' },
  { id: 'labels', key: 'intercept.labels', label: 'sLabels', options: [['1', 'on'], ['0', 'off']], def: '1' },
  { id: 'trails', key: 'intercept.trails', label: 'sTrails', options: [['1', 'on'], ['0', 'off']], def: '1' },
  { id: 'map', key: 'intercept.map', label: 'sMap', options: [['1', 'on'], ['0', 'off']], def: '1' },
  { id: 'weather', key: 'intercept.weather', label: 'sWeather', note: 'sWeatherNote', options: [[null, 'auto'], ['clear', 'wClear'], ['haze', 'wHaze'], ['squalls', 'wSqualls'], ['overcast', 'wOvercast']], def: null },
  { id: 'quality', key: 'intercept.quality', label: 'sQuality', note: 'sQualityNote', options: [[null, 'auto'], ['high', 'qHigh'], ['medium', 'qMedium'], ['low', 'qLow']], def: null },
  { id: 'motion', key: 'intercept.menuMotion', label: 'sMotion', options: [['1', 'on'], ['0', 'off']], def: '1' },
];
const settingValue = (s) => {
  const v = read(s.key);
  return s.options.some(([o]) => o === v) ? v : s.def;
};

// Small line icons: one per category and one per mission row (the drills share theirs).
const ICON = {
  watch: '<path d="M4 20 Q20 6 36 20 Q20 34 4 20Z"/><circle cx="20" cy="20" r="5"/>',
  combat: '<circle cx="20" cy="20" r="13"/><path d="M20 4 V12 M20 28 V36 M4 20 H12 M28 20 H36"/><circle class="hot" cx="20" cy="20" r="2.5"/>',
  sea: '<circle cx="20" cy="20" r="13"/><circle cx="20" cy="20" r="6"/><path d="M20 7 V14 M20 26 V33 M7 20 H14 M26 20 H33"/>',
  drill: '<path class="ship" d="M6 10 H22 L28 14 L22 18 H6Z"/><path class="ship" d="M6 24 H22 L28 28 L22 32 H6Z"/><path d="M14 18 V24"/>',
  intercept: '<path class="arc" d="M6 34 Q10 10 28 12"/><path class="hot" d="M24 10 h10 M29 6 v8"/><circle class="burst" cx="29" cy="11" r="6"/>',
  chute: '<path class="canopy" d="M8 18 Q20 2 32 18 Z"/><path d="M8 18 L20 30 L32 18 M20 18 V30"/><path class="hot" d="M15 31 h10"/><path class="sea" d="M4 36 Q10 34 16 36 T28 36 T38 36"/>',
  fly: '<path class="hot" d="M8 22 h24 M20 16 v12 M14 30 h12"/><circle cx="20" cy="22" r="4"/><path class="arc" d="M4 36 Q12 30 20 30"/>',
  helm: '<path class="ship" d="M4 27 H25 L32 31 L25 35 H4Z"/><path d="M18 27 V20 M14 22 H22"/><path class="hot" d="M28 9 h8 M32 5 v8"/><path class="arc" d="M21 20 Q24 10 30 9"/>',
  harbour: '<path d="M4 10 H30 V30 M30 30 L26 30"/><path d="M4 34 H20 L24 30"/><path class="ship" d="M8 20 H22 L27 23 L22 26 H8Z"/><circle class="burst" cx="35" cy="33" r="2.5"/>',
  mob: '<path class="arc" d="M8 30 C4 20 10 8 20 8 C30 8 34 16 30 24 C27 30 18 30 16 22"/><path class="ship" d="M10 32 H22 L26 34.5 L22 37 H10Z"/><circle class="burst" cx="17" cy="21" r="3"/>',
  duel: '<path class="ship" d="M3 28 H17 L22 31 L17 34 H3Z"/><path class="foe" d="M37 12 H23 L18 9 L23 6 H37Z"/><path class="arc" d="M18 26 Q26 10 31 14"/><circle class="burst" cx="31" cy="14" r="3.5"/>',
  maneuvers2: '<path class="ship" d="M6 9 H23 L29 13 L23 17 H6Z"/><path class="ship" d="M6 23 H23 L29 27 L23 31 H6Z"/><path d="M15 17 V23"/>',
  maneuvers: '<path class="ship" d="M8 4 H22 L27 7.5 L22 11 H8Z"/><path class="ship" d="M8 16 H22 L27 19.5 L22 23 H8Z"/><path class="ship" d="M5 28 H24 L31 32 L24 36 H5Z"/><path d="M15 11 V16 M15 23 V28"/>',
  formations: '<path class="ship" d="M17 4 L20 10 L23 4Z M8 15 L11 21 L14 15Z M26 15 L29 21 L32 15Z M17 26 L20 32 L23 26Z"/><path d="M20 12 L11 15 M20 12 L29 15 M11 23 L20 26 M29 23 L20 26"/>',
  help: '<circle cx="12" cy="12" r="9.5"/><path d="M9.3 9.2a2.8 2.8 0 0 1 5.4 1c0 1.9-2.7 2.3-2.7 4"/><circle class="dot" cx="12" cy="17.6" r="0.9"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/>',
  play: '<path d="M7 4.5l13 7.5-13 7.5z"/>',
  levelBars: (n) => [[8, 24], [17, 18], [26, 12]].map(([x, y], i) => `<path class="bar${i < n ? ' on' : ''}" d="M${x} 30 V${y}"/>`).join(''),
};
const icon = (body, cls = 'ic', box = 40) => `<svg class="${cls}" viewBox="0 0 ${box} ${box}" aria-hidden="true" focusable="false">${body}</svg>`;
const SHIP_ART = (id) => `<svg viewBox="0 0 320 96" aria-hidden="true" focusable="false"><path class="sea" d="M0 80 Q20 76 40 80 T80 80 T120 80 T160 80 T200 80 T240 80 T280 80 T320 80 V96 H0Z"/>`
  + '<path class="hull" d="M20 74 L246 74 L304 58 L300 52 L18 52 Z"/><path class="sup" d="M44 52 L48 38 L110 38 L114 52Z M130 52 L135 34 L196 34 L200 52Z M146 34 L150 20 L182 20 L186 34Z"/><path class="mast" d="M166 20 V6 M160 11 H172"/>'
  + (id === 'aft'
    ? '<path class="arc" d="M60 30 Q36 -6 10 6"/><rect class="box" x="54" y="30" width="20" height="9" rx="2" transform="rotate(30 64 34)"/>'
    : '<path class="arc" d="M222 38 Q254 -2 308 6"/><rect class="box" x="208" y="40" width="22" height="12" rx="2"/>')
  + '</svg>';

export function createMainMenu(root, { mode: initialMode, ship: preShip, level: preLevel, lastPlayed, reducedMotion, onLaunch }) {
  let lang = LANG;
  let mode = MISSION_IDS.includes(initialMode) ? initialMode : 'intercept';
  let level = ENEMY_LEVELS.some((l) => l.id === preLevel) ? preLevel : DEFAULT_LEVEL;
  let overlay = null; // 'help' | 'settings' | null
  let helpTab = 'about';
  let storyOpen = false;
  let gone = false;
  const t = () => UI[lang];

  // Each mission remembers its own launcher, and the drills their number of ships.
  const validShip = (id) => (SHIPS.some((s) => s.id === id) ? id : null);
  const shipFor = {};
  for (const m of MISSIONS.filter((x) => x.ship)) shipFor[m.id] = validShip(read(`intercept.ship.${m.id}`)) ?? validShip(read('intercept.ship')) ?? 'fwd';
  if (validShip(preShip) && missionById(mode).ship) shipFor[mode] = preShip;
  const drills = FAMILIES[0].members;
  const lastIn = Object.fromEntries(GROUPS.map((g) => [g.id, MISSIONS.find((m) => m.group === g.id).id]));
  lastIn.drill = drills.includes(read('intercept.drill')) ? read('intercept.drill') : drills[0];
  lastIn[groupOf(mode)] = mode;
  const shipNow = () => shipFor[mode] ?? FIXED_SHIP;
  const motion = () => !reducedMotion && settingValue(SETTINGS.find((s) => s.id === 'motion')) !== '0';

  // --- Rendering ---------------------------------------------------------------------------------------
  // The layout: the brand and the Help / Settings / language buttons; the categories as tabs; then the
  // category's missions as cards, each with its own live preview, beside a panel for the selected one
  // (briefing, set-up steps, controls, Start).
  let artSeq = 0;
  function shell() {
    const u = t();
    root.innerHTML = `
      <div class="mm-bg" aria-hidden="true"><svg viewBox="0 0 1000 600" preserveAspectRatio="xMidYMid slice"><path class="bg-grid" d="${[100, 200, 300, 400, 500].map((y) => `M0 ${y}H1000`).join('')}${[100, 200, 300, 400, 500, 600, 700, 800, 900].map((x) => `M${x} 0V600`).join('')}"/><g class="bg-radar"><circle cx="500" cy="660" r="200"/><circle cx="500" cy="660" r="400"/><circle cx="500" cy="660" r="600"/><g class="bg-sweep"><path d="M500 660 L500 60 A600 600 0 0 1 846 170Z"/></g></g></svg></div>
      <div class="mm2">
        <header class="mm-top">
          <div class="mm-brand">
            <svg class="brand-radar" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="5"/><g class="brand-sweep"><path d="M12 12 L12 2 A10 10 0 0 1 20.7 7Z"/></g><circle class="brand-dot" cx="12" cy="12" r="1.6"/></svg>
            <div><b>${esc(u.appName)}</b><span>${esc(u.appSub)}</span></div>
          </div>
          <div class="mm-actions">
            <div class="mm-lang" role="radiogroup" aria-label="${esc(u.sLanguage)}">${LANGS.map((l) => `<button type="button" role="radio" data-lang="${l.id}" aria-checked="${l.id === lang}" title="${esc(l.name)}">${l.short}</button>`).join('')}</div>
            <button type="button" class="mm-btn" data-open="help" title="${esc(u.help)} (H)">${icon(ICON.help, 'ic', 24)}<span>${esc(u.help)}</span></button>
            <button type="button" class="mm-btn" data-open="settings" title="${esc(u.settings)} (G)">${icon(ICON.gear, 'ic', 24)}<span>${esc(u.settings)}</span></button>
          </div>
        </header>
        <nav class="mm-cats" role="radiogroup" aria-label="${esc(u.category)}">
          ${GROUPS.map((g0) => {
            const g = groupIn(g0, lang);
            const n = MISSIONS.filter((m) => m.group === g.id).length;
            return `<button type="button" class="mm-cat" role="radio" data-tab="${g.id}" aria-checked="false">${icon(ICON[g.id])}<b>${esc(g.name)}</b><em class="mm-n">${n}</em></button>`;
          }).join('')}
        </nav>
        <p class="mm-hint" id="ch-tabhint"></p>
        <section class="mm-grid" aria-label="${esc(u.missions)}"><div class="mm-missions" role="radiogroup" aria-label="${esc(u.missions)}"></div></section>
        <aside class="mm-panel" aria-live="polite">
          <div class="mm-panel-in" id="ch-panel">
            <p class="mm-kind" id="ch-kind"></p>
            <h1 id="ch-title"></h1>
            <ul class="mm-facts" id="ch-facts"></ul>
            <div class="mm-story"><p id="ch-tag"></p><button type="button" class="mm-more" id="ch-more" aria-expanded="false" hidden></button></div>
            <div class="mm-step" data-step="ship" hidden><h2>${esc(u.launcher)}</h2><div class="mm-cards" role="radiogroup" aria-label="${esc(u.launcher)}"></div></div>
            <div class="mm-step" data-step="drill" hidden><h2>${esc(u.ships)}</h2><div class="mm-picks" role="radiogroup" aria-label="${esc(u.ships)}"></div></div>
            <div class="mm-step" data-step="level" hidden><h2>${esc(u.enemy)}</h2><div class="mm-picks" role="radiogroup" aria-label="${esc(u.enemy)}"></div></div>
            <div class="mm-keys"><h2>${esc(u.controls)}</h2><ul id="ch-keys"></ul><p id="ch-keys-more"></p></div>
          </div>
          <footer class="mm-go">
            <p class="mm-sum"><span id="ch-summary"></span><small id="chooser-sub"></small></p>
            <button type="button" id="ch-start" class="mm-start"><span></span>${icon(ICON.play, 'ic', 24)}</button>
            <div class="mm-go-row"><em class="mm-last" id="ch-last" hidden>${esc(u.lastPlayed)}</em><button type="button" class="mm-continue" id="ch-continue" hidden></button></div>
          </footer>
        </aside>
        <p class="mm-foot"><span>${esc(u.stats(MISSIONS.length, GROUPS.length))}</span><span class="mm-keyhint">${esc(u.menuKeys)}</span><a id="dl-offline-menu" href="/intercept-offline" download="intercept-offline.html" title="${esc(u.offlineHint)}">${esc(u.offline)}</a></p>
      </div>
      <div class="mm-overlay" id="mm-overlay" hidden><div class="mm-dialog" role="dialog" aria-modal="true" tabindex="-1"></div></div>`;
    document.documentElement.lang = lang;
    wire();
    paint(true);
  }

  // A card's preview: its own mission (the drill card shows the number of ships picked), with its own ids.
  const cardArt = (e) => {
    const id = e.family ? lastIn.drill : e.id;
    return previewArt(id, shipFor[id] ?? FIXED_SHIP, motion(), lang, `m${++artSeq}`);
  };

  // The cards for the selected category, the panel for the selected mission.
  function paint(fresh = false) {
    const u = t();
    const group = groupOf(mode);
    const ship = shipNow();
    const text = menuText(mode, ship, lang);
    root.querySelectorAll('[data-tab]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.tab === group)));
    $(root, '#ch-tabhint').textContent = groupIn(GROUPS.find((g) => g.id === group), lang).hint;
    const list = $(root, '.mm-missions');
    const entries = entriesOf(group, lang);
    const listKey = `${group}:${lang}:${motion()}`;
    if (fresh || list.dataset.key !== listKey) {
      list.dataset.key = listKey;
      list.dataset.count = String(entries.length);
      list.innerHTML = entries.map((e) => {
        const attr = e.family ? `data-family="${e.family}"` : `data-mode="${e.id}"`;
        return `<button type="button" class="mm-mission" role="radio" ${attr} aria-checked="false">`
          + `<span class="mm-prev" data-art="${e.family ? '' : e.id}">${cardArt(e)}</span>`
          + `<span class="mm-cardfoot">${icon(ICON[e.family ? lastIn.drill : e.id])}<span class="mm-m-txt"><b>${esc(e.name)}</b><small>${esc(e.blurb)}</small></span><em class="mm-m-kind">${esc(e.kind)}</em></span>`
          + '<i class="mm-sel" aria-hidden="true"></i></button>';
      }).join('');
      list.querySelectorAll('.mm-mission').forEach((b) => {
        b.addEventListener('click', () => pickRow(b));
        b.addEventListener('dblclick', go);
      });
    }
    list.querySelectorAll('.mm-mission').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.family ? group === 'drill' : b.dataset.mode === mode)));
    // A card follows its mission's launcher or number of ships: redraw it when that changes.
    list.querySelectorAll('.mm-mission').forEach((b) => {
      const id = b.dataset.family ? lastIn.drill : b.dataset.mode;
      const key = `${id}:${shipFor[id] ?? ''}`;
      const prev = b.querySelector('.mm-prev');
      if (prev.dataset.key !== key) {
        if (prev.dataset.key) prev.innerHTML = previewArt(id, shipFor[id] ?? FIXED_SHIP, motion(), lang, `m${++artSeq}`);
        prev.dataset.key = key;
        if (b.dataset.family) b.querySelector('.mm-cardfoot .ic').outerHTML = icon(ICON[id]);
      }
    });

    // The panel slides in again when the mission changes.
    const panel = $(root, '#ch-panel');
    if (panel.dataset.mode !== mode) {
      panel.dataset.mode = mode;
      panel.classList.remove('in');
      void panel.offsetWidth;
      panel.classList.add('in');
    }
    $(root, '#ch-kind').textContent = `${groupIn(GROUPS.find((g) => g.id === group), lang).name} · ${text.kind}`;
    $(root, '#ch-title').textContent = text.title;
    const tag = $(root, '#ch-tag');
    if (tag.textContent !== text.tagline) { tag.textContent = text.tagline; storyOpen = false; }
    const story = $(root, '.mm-story');
    story.classList.toggle('open', storyOpen);
    const more = $(root, '#ch-more');
    more.textContent = storyOpen ? u.less : u.more;
    more.setAttribute('aria-expanded', String(storyOpen));
    requestAnimationFrame(() => { more.hidden = !storyOpen && tag.scrollHeight <= tag.clientHeight + 2; });
    $(root, '#ch-facts').innerHTML = text.facts.map((f) => `<li>${esc(f)}</li>`).join('');
    const all = text.keys.length <= 6;
    const shown = all ? text.keys : text.keys.slice(0, 6);
    $(root, '#ch-keys').innerHTML = shown.map(([k, l]) => `<li><kbd>${esc(k)}</kbd>${esc(l)}</li>`).join('');
    $(root, '#ch-keys-more').textContent = all ? '' : u.moreKeys(text.keys.length - shown.length);

    // Set-up steps: the launcher, the number of ships (a drill), the enemy's level.
    const shipStep = $(root, '[data-step="ship"]');
    shipStep.hidden = !text.hasShip;
    if (text.hasShip) {
      shipStep.querySelector('.mm-cards').innerHTML = SHIPS.map((s0, i) => {
        const s = shipIn(s0, lang);
        return `<button type="button" class="mm-card" role="radio" data-ship="${s.id}" aria-checked="${s.id === ship}">${SHIP_ART(s.id)}<span><b><kbd>${i + 1}</kbd>${esc(s.name)}</b><small>${esc(s.desc)}</small></span></button>`;
      }).join('');
    }
    const drillStep = $(root, '[data-step="drill"]');
    drillStep.hidden = group !== 'drill';
    if (group === 'drill') {
      drillStep.querySelector('.mm-picks').innerHTML = drills.map((id, i) => {
        const m = missionIn(missionById(id), lang);
        return `<button type="button" class="mm-pick" role="radio" data-mode="${id}" aria-checked="${id === mode}">${icon(ICON[id])}<span><b><kbd>${i + 1}</kbd>${esc(m.tile)}</b><small>${esc(m.tileSub)}</small></span></button>`;
      }).join('');
    }
    const levelStep = $(root, '[data-step="level"]');
    levelStep.hidden = !text.hasLevel;
    if (text.hasLevel) {
      levelStep.querySelector('.mm-picks').innerHTML = ENEMY_LEVELS.map((l0, i) => {
        const l = levelIn(l0, lang);
        return `<button type="button" class="mm-pick" role="radio" data-level="${l.id}" aria-checked="${l.id === level}">${icon(ICON.levelBars(i + 1))}<span><b><kbd>${i + 1}</kbd>${esc(l.name)}</b><small>${esc(l.desc)}</small></span></button>`;
      }).join('');
    }
    root.querySelectorAll('[data-ship]').forEach((b) => { b.onclick = () => setShip(b.dataset.ship); b.ondblclick = go; });
    root.querySelectorAll('.mm-picks [data-mode]').forEach((b) => { b.onclick = () => setMode(b.dataset.mode); b.ondblclick = go; });
    root.querySelectorAll('[data-level]').forEach((b) => { b.onclick = () => setLevel(b.dataset.level); b.ondblclick = go; });

    // The way in, and a quick way back into the last mission played.
    $(root, '#ch-start span').textContent = text.button;
    $(root, '#ch-summary').textContent = text.summary;
    $(root, '#chooser-sub').textContent = text.note;
    $(root, '#ch-last').hidden = lastPlayed !== mode;
    const cont = $(root, '#ch-continue');
    cont.hidden = !lastPlayed || lastPlayed === mode;
    if (lastPlayed) {
      cont.innerHTML = `<small>${esc(u.continue)}</small> <b>${esc(missionIn(missionById(lastPlayed), lang).name)}</b>`;
      cont.title = u.continueHint;
    }
    $(root, '.mm-go-row').hidden = $(root, '#ch-last').hidden && cont.hidden;
    document.title = text.tabTitle;
  }

  // --- Overlays ----------------------------------------------------------------------------------------
  function renderOverlay() {
    const box = $(root, '#mm-overlay');
    box.hidden = !overlay;
    if (!overlay) return;
    const dlg = box.querySelector('.mm-dialog');
    dlg.innerHTML = overlay === 'help' ? helpHtml() : settingsHtml();
    dlg.querySelector('[data-close]').addEventListener('click', closeOverlay);
    dlg.querySelectorAll('[data-help]').forEach((b) => b.addEventListener('click', () => { helpTab = b.dataset.help; renderOverlay(); }));
    dlg.querySelectorAll('[data-set]').forEach((b) => b.addEventListener('click', () => applySetting(b.dataset.set, b.dataset.val)));
    dlg.querySelector('[data-reset]')?.addEventListener('click', resetSettings);
    dlg.querySelectorAll('[data-goto]').forEach((b) => b.addEventListener('click', () => { closeOverlay(); setMode(b.dataset.goto); }));
    dlg.focus({ preventScroll: true });
  }
  const openOverlay = (which) => { overlay = which; renderOverlay(); };
  function closeOverlay() { overlay = null; renderOverlay(); $(root, '#ch-start')?.focus({ preventScroll: true }); }

  function helpHtml() {
    const u = t();
    const tabs = [['about', u.tabAbout], ['missions', u.tabMissions], ['scene', u.tabScene], ['menu', u.tabMenu]];
    const rows = (list) => `<dl class="mm-dl">${list.map(([k, v]) => `<dt><kbd>${esc(k)}</kbd></dt><dd>${esc(v)}</dd>`).join('')}</dl>`;
    let body = '';
    if (helpTab === 'about') {
      body = `<p class="mm-lead">${esc(u.aboutLead)}</p><ul class="mm-points">${u.aboutPoints.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>`
        + `<div class="mm-catgrid">${GROUPS.map((g0) => {
          const g = groupIn(g0, lang);
          return `<div>${icon(ICON[g.id])}<b>${esc(g.name)}</b><small>${esc(g.hint)}</small><span>${MISSIONS.filter((m) => m.group === g.id).map((m) => esc(missionIn(m, lang).name)).join(' · ')}</span></div>`;
        }).join('')}</div>`
        + `<p class="mm-note">${esc(u.aboutTech)} <a href="/intercept-offline" download="intercept-offline.html">${esc(u.offline)}</a></p>`;
    } else if (helpTab === 'missions') {
      body = GROUPS.map((g0) => {
        const g = groupIn(g0, lang);
        return `<h3>${esc(g.name)}</h3>` + MISSIONS.filter((m) => m.group === g.id).map((m0) => {
          const m = missionIn(m0, lang);
          return `<article class="mm-hm">${icon(ICON[m.id])}<div><b>${esc(m.name)}</b> <em>${esc(m.kind)}</em><p>${esc(m.tagline)}</p><p class="mm-hkeys">${m.keys.map(([k, l]) => `<span><kbd>${esc(k)}</kbd> ${esc(l)}</span>`).join('')}</p><button type="button" class="mm-link" data-goto="${m.id}">${esc(m.button)} →</button></div></article>`;
        }).join('');
      }).join('');
    } else if (helpTab === 'scene') {
      body = `<p class="mm-lead">${esc(u.sceneLead)}</p>`
        + `<dl class="mm-dl wide">${u.sceneButtons.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>`
        + rows(u.sceneMouse)
        + `<p class="mm-note">${esc(u.sceneTimeline)}</p>`;
    } else {
      body = `<p class="mm-lead">${esc(u.menuLead)}</p>${rows(u.menuKeyList)}<ul class="mm-points">${u.menuTips.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>`;
    }
    return `<header class="mm-dh"><h2>${icon(ICON.help, 'ic', 24)}${esc(u.helpTitle)}</h2><button type="button" class="mm-x" data-close title="${esc(u.close)} (Esc)" aria-label="${esc(u.close)}">×</button></header>`
      + `<nav class="mm-dtabs" role="tablist">${tabs.map(([id, name]) => `<button type="button" role="tab" data-help="${id}" aria-selected="${id === helpTab}">${esc(name)}</button>`).join('')}</nav>`
      + `<div class="mm-dbody">${body}</div>`;
  }

  function settingsHtml() {
    const u = t();
    const seg = (id, options, current) => `<div class="mm-seg" role="radiogroup">${options.map(([val, label]) => `<button type="button" role="radio" data-set="${id}" data-val="${val ?? ''}" aria-checked="${(val ?? '') === (current ?? '')}">${esc(label)}</button>`).join('')}</div>`;
    const rows = [
      `<div class="mm-srow"><div><b>${esc(u.sLanguage)}</b><small>${esc(u.sLanguageNote)}</small></div>${seg('lang', LANGS.map((l) => [l.id, l.name]), lang)}</div>`,
      ...SETTINGS.map((s) => `<div class="mm-srow"><div><b>${esc(u[s.label])}</b>${s.note ? `<small>${esc(u[s.note])}</small>` : ''}</div>${seg(s.id, s.options.map(([v, k]) => [v, u[k]]), settingValue(s))}</div>`),
    ];
    return `<header class="mm-dh"><h2>${icon(ICON.gear, 'ic', 24)}${esc(u.settingsTitle)}</h2><button type="button" class="mm-x" data-close title="${esc(u.close)} (Esc)" aria-label="${esc(u.close)}">×</button></header>`
      + `<div class="mm-dbody">${rows.join('')}<div class="mm-srow end"><button type="button" class="mm-link" data-reset>${esc(u.sReset)}</button><span class="mm-toast" aria-live="polite"></span></div></div>`;
  }

  function applySetting(id, val) {
    if (id === 'lang') { setLang(val); return; }
    const s = SETTINGS.find((x) => x.id === id);
    write(s.key, val === '' ? null : val);
    if (id === 'motion') paint();
    renderOverlay();
  }
  function resetSettings() {
    for (const s of SETTINGS) write(s.key, null);
    paint();
    renderOverlay();
    const toast = root.querySelector('.mm-toast');
    if (toast) toast.textContent = t().sResetDone;
  }
  function setLang(id) {
    if (!UI[id] || id === lang) return;
    lang = id;
    saveLang(id);
    const keep = overlay;
    shell();
    if (keep) openOverlay(keep);
  }

  // --- Choices and keys ---------------------------------------------------------------------------------
  const setMode = (m) => { mode = m; lastIn[groupOf(m)] = m; paint(); };
  const setShip = (id) => { if (missionById(mode).ship) { shipFor[mode] = id; paint(); } };
  const setLevel = (id) => { level = id; paint(); };
  const setTab = (g) => setMode(lastIn[g]);
  const pickRow = (row) => setMode(row.dataset.family ? lastIn.drill : row.dataset.mode);
  function go() {
    if (gone) return;
    gone = true;
    window.removeEventListener('keydown', onKey);
    onLaunch({ mode, ship: menuText(mode, shipNow(), lang).hasShip ? shipNow() : FIXED_SHIP, level });
  }
  function goContinue() {
    if (!lastPlayed) return;
    mode = lastPlayed;
    go();
  }

  const arrows = (list, i, e, pick) => {
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1;
    const next = list[(i + step + list.length) % list.length];
    pick(next);
    root.querySelector(`${next.tagName.toLowerCase()}[${[...next.attributes].find((a) => a.name.startsWith('data-'))?.name}="${Object.values(next.dataset)[0]}"]`)?.focus();
  };
  function onKey(e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (overlay) {
      if (e.key === 'Escape') { e.preventDefault(); closeOverlay(); }
      return;
    }
    const group = groupOf(mode);
    const has = menuText(mode, shipNow(), lang);
    if (e.key.startsWith('Arrow')) {
      const lists = [
        [[...root.querySelectorAll('[data-tab]')], (b) => setTab(b.dataset.tab)],
        [[...root.querySelectorAll('.mm-mission')], pickRow],
        [[...root.querySelectorAll('.mm-picks [data-mode]')], (b) => setMode(b.dataset.mode)],
        [[...root.querySelectorAll('[data-ship]')], (b) => setShip(b.dataset.ship)],
        [[...root.querySelectorAll('[data-level]')], (b) => setLevel(b.dataset.level)],
      ];
      const hit = lists.find(([list]) => list.includes(e.target));
      if (hit) arrows(hit[0], hit[0].indexOf(e.target), e, hit[1]);
      else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        const rows = lists[1][0];
        const i = rows.findIndex((r) => r.getAttribute('aria-checked') === 'true');
        arrows(rows, Math.max(0, i), e, pickRow);
      } else if (group === 'drill') {
        const i = drills.indexOf(mode);
        setMode(drills[(i + (e.key === 'ArrowRight' ? 1 : -1) + drills.length) % drills.length]);
      } else if (has.hasShip) setShip(shipNow() === 'fwd' ? 'aft' : 'fwd');
      else if (has.hasLevel) {
        const i = ENEMY_LEVELS.findIndex((l) => l.id === level);
        setLevel(ENEMY_LEVELS[(i + (e.key === 'ArrowRight' ? 1 : -1) + ENEMY_LEVELS.length) % ENEMY_LEVELS.length].id);
      } else return;
      e.preventDefault();
    } else if (e.key === 'm' || e.key === 'M') {
      const flat = GROUPS.flatMap((g) => entriesOf(g.id));
      const next = flat[(flat.findIndex((en) => en.members.includes(mode)) + 1) % flat.length];
      setMode(next.family ? lastIn[next.group] : next.id);
    } else if (e.key >= '1' && e.key <= '3') {
      const n = Number(e.key);
      if (group === 'drill') setMode(drills[n - 1]);
      else if (has.hasShip && n <= SHIPS.length) setShip(SHIPS[n - 1].id);
      else if (has.hasLevel) setLevel(ENEMY_LEVELS[n - 1].id);
    } else if (e.key === 'h' || e.key === 'H' || e.key === '?') openOverlay('help');
    else if (e.key === 'g' || e.key === 'G') openOverlay('settings');
    else if (e.key === 'Enter' && !e.target.closest?.('.mm-actions, .mm-lang')) { e.preventDefault(); go(); }
  }

  function wire() {
    root.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));
    root.querySelectorAll('[data-lang]').forEach((b) => b.addEventListener('click', () => setLang(b.dataset.lang)));
    root.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => openOverlay(b.dataset.open)));
    $(root, '#ch-more').addEventListener('click', () => { storyOpen = !storyOpen; paint(); });
    $(root, '#ch-start').addEventListener('click', go);
    $(root, '#ch-continue').addEventListener('click', goContinue);
    $(root, '#mm-overlay').addEventListener('click', (e) => { if (e.target.id === 'mm-overlay') closeOverlay(); });
  }

  root.hidden = false;
  shell();
  window.addEventListener('keydown', onKey);
  $(root, '#ch-start').focus({ preventScroll: true });
  return { get mode() { return mode; }, open: openOverlay };
}

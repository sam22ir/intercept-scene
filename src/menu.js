// The main menu's words, in one place. Pure data (it imports only i18n.js: the main menu must not load
// the scene, whose modules read the chosen ship and mission once at import). mainMenu.js builds the screen
// from it, the missions read their top-bar title from it, and test/menu.test.mjs checks it against the
// real scenario, flight model and key bindings, so a title can never describe something a mission does not do.
// The English words live here; menuFr.js holds the French ones (test/i18n.test.mjs checks they match).
//
// A mission with `ship: true` lets the player pick the launcher; the others fix it (`fixed` says what is
// fixed, for the summary line). The missions are sorted into four categories by what they are for
// (`GROUPS`): Watch (scripted engagements to scrub), Combat (you fly or fight), Seamanship (you handle
// the ship) and Fleet drills (the naval exercises). A category lists its entries (`entriesOf`): each mission
// is one, except the three drills, which are one entry (`FAMILIES`) whose variants are chosen by the number of
// ships (`ships`, `tile`, `tileSub`). A mission with `level: true` (the surface battle) lets the player pick
// the enemy's level (`ENEMY_LEVELS`).

import { readLang } from './i18n.js';
import { FR } from './menuFr.js';

export const GROUPS = [
  { id: 'watch', name: 'Watch', hint: 'Scripted engagements you watch and scrub both ways' },
  { id: 'combat', name: 'Combat', hint: 'You fly the drone or fight the ship' },
  { id: 'sea', name: 'Seamanship', hint: 'You handle the ship: harbour and rescue' },
  { id: 'drill', name: 'Fleet drills', hint: 'Frigates manoeuvre together on signals' },
];

export const FAMILIES = [
  { id: 'drill', group: 'drill', name: 'Tactical maneuvers', blurb: 'Frigates wheel and change station on orders', members: ['maneuvers2', 'maneuvers', 'formations'] },
];

export const MISSIONS = [
  {
    id: 'intercept',
    group: 'watch',
    name: 'Missile intercept',
    kind: 'Replay',
    blurb: 'The frigate shoots the target drone down',
    tagline: 'A target drone is catapulted off a stealth frigate, climbs gradually to 250 m as it flies 1.6 km out on her side, then turns back at the ship. On that inbound run the frigate\'s missile shoots it down.',
    facts: ['1 drone · 1 missile', 'Scrub time both ways', 'Cinematic camera'],
    keys: [['Space', 'play / pause'], ['← →', 'step through time'], ['D', 'cinematic camera'], ['1 – 3', 'follow drone, missile, ship'], ['E', 'edit the flight path'], ['G', 'missile engagement']],
    ship: true,
    brand: 'Intercept',
    button: 'Start replay',
  },
  {
    id: 'chute',
    group: 'watch',
    name: 'Parachute recovery',
    kind: 'Replay',
    blurb: 'No shot: the drone comes home by parachute',
    tagline: 'The same flight, but the missile is never fired: the launcher locks on and tracks the inbound drone. It comes down to 90 m off the port quarter, the engine cuts, a red parachute opens and the drone lands in the sea.',
    facts: ['No missile', 'Red parachute', 'Lands in the sea'],
    keys: [['Space', 'play / pause'], ['← →', 'step through time'], ['D', 'cinematic camera'], ['1 – 3', 'follow drone, ship'], ['E', 'edit the flight path']],
    ship: true,
    brand: 'Recovery',
    button: 'Start replay',
  },
  {
    id: 'fly',
    group: 'combat',
    name: 'Fly the drone',
    kind: 'Hands-on',
    blurb: 'Catapult off, fly it, dodge the missile',
    tagline: 'You fly it. E starts the engine on the ship and L fires the catapult; the arrow keys fly at 75 m/s; E in the air cuts the engine and opens the parachute; F fires the frigate\'s missile at you.',
    facts: ['You are the pilot', '75 m/s cruise', 'The missile hunts you'],
    keys: [['← →', 'turn'], ['↑ ↓', 'climb / dive'], ['E', 'engine'], ['L', 'catapult'], ['F', 'missile'], ['R', 'fly again'], ['V', 'camera'], ['M', 'map']],
    ship: false,
    fixed: 'manual flight',
    fixedNote: 'The forward launcher, fixed.',
    brand: 'Fly',
    sub: 'manual flight',
    button: 'Take off',
  },
  {
    id: 'maneuvers2',
    group: 'drill',
    ships: 2,
    tile: '2 ships',
    tileSub: 'SHIP1 · SHIP2',
    name: 'Two-ship drill',
    kind: 'Drill',
    blurb: 'SHIP1 and SHIP2 run the briefing deck',
    tagline: 'Two frigates, SHIP1 and SHIP2, run the briefing deck on their own: a wheel in column, turns together, a change of guide, FORM 120 and FORM 345, light and flag serials, and a close pass. 12 orders, about 36 minutes, played at 4×.',
    facts: ['2 ships: SHIP1 and SHIP2', '12 orders', 'About 36 minutes'],
    keys: [['Space', 'play / pause'], ['O', 'the orders'], ['I', 'the signal text'], ['1 – 3', 'follow SHIP1, SHIP2, the formation'], ['M', 'map']],
    ship: false,
    fixed: 'SHIP1 & SHIP2',
    fixedNote: 'Two frigates, fixed: SHIP1 and SHIP2.',
    brand: 'Maneuvers',
    sub: 'SHIP1 & SHIP2 · two-ship drill',
    button: 'Start exercise',
  },
  {
    id: 'maneuvers',
    group: 'drill',
    ships: 3,
    tile: '3 ships',
    tileSub: 'SHIP1 · SHIP2 · unit',
    name: 'Three-ship drill',
    kind: 'Drill',
    blurb: 'SHIP1 and SHIP2 drill round a larger unit',
    tagline: 'Two frigates, SHIP1 and SHIP2, run the briefing deck in formation, with a larger unit sailing alongside: turns together, a change of station, light and flag serials, and a close pass. 18 orders, about 70 minutes, played at 4×.',
    facts: ['3 ships: SHIP1, SHIP2 and a unit', '18 orders', 'About 70 minutes'],
    keys: [['Space', 'play / pause'], ['O', 'the orders'], ['I', 'the signal text'], ['1 – 3', 'follow SHIP1, SHIP2, the formation'], ['M', 'map']],
    ship: false,
    fixed: 'SHIP1, SHIP2 & unit',
    fixedNote: 'Three ships, fixed: SHIP1, SHIP2 and the unit.',
    brand: 'Maneuvers',
    sub: 'SHIP1, SHIP2 & unit · three-ship drill',
    button: 'Start exercise',
  },
  {
    id: 'formations',
    group: 'drill',
    ships: 4,
    tile: '4 ships',
    tileSub: 'SHIP1 – SHIP4',
    name: 'Four-ship formations',
    kind: 'Drill',
    blurb: 'SHIP1 to SHIP4 change formation',
    tagline: 'Four frigates, SHIP1 to SHIP4, run the tactical formations: line ahead, line of bearing, line abreast, box and diamond, SHIP1 leading as the guide, with wheels (CORPEN) and turns together (TURN) between them. 11 orders, about 37 minutes, played at 8×.',
    facts: ['4 ships: SHIP1 to SHIP4', '11 orders', 'About 37 minutes'],
    keys: [['Space', 'play / pause'], ['1 – 4', 'follow SHIP1 to SHIP4'], ['5', 'the whole formation'], ['M', 'map'], ['L', 'labels']],
    ship: false,
    fixed: 'SHIP1 to SHIP4',
    fixedNote: 'Four frigates, fixed: SHIP1 to SHIP4.',
    brand: 'Formations',
    sub: 'SHIP1 to SHIP4 · tactical formations',
    button: 'Start exercise',
  },
  {
    id: 'helm',
    group: 'combat',
    ships: 1,
    name: 'Solo Air Defense',
    kind: 'Hands-on',
    blurb: 'Sail the frigate · fight off drones',
    tagline: 'You have the ship. The arrow keys work the rudder and the engine telegraph, the radar picks up drones coming in, M fires the forward launcher\'s missiles at them, and the two 30 mm rotary guns on the aft deck fire while you hold G, or by themselves in automatic (A), for what comes in astern. A drone you leave alone makes one low pass, comes round and dives into the ship on its second approach: three hits and she is out of action.',
    facts: ['1 ship: you steer', '8 missiles + 2 guns', '7 views'],
    keys: [['← →', 'rudder'], ['↑ ↓', 'engine telegraph'], ['M', 'make a missile ready'], ['F', 'launch it'], ['G', 'hold: aft guns fire'], ['A', 'guns automatic on / off'], ['Tab', 'next target'], ['1 – 7', 'bridge, behind, above, missile, radar, target, orbit'], ['N', 'radar map'], ['I', 'intercept camera on / off']],
    ship: false,
    fixed: 'you steer',
    fixedNote: 'One frigate with the forward launcher: you steer her.',
    brand: 'Solo Air Defense',
    sub: '1 ship · you steer',
    button: 'Take command',
  },
  {
    id: 'harbour',
    group: 'sea',
    name: 'Harbour pilot',
    kind: 'Hands-on',
    blurb: 'Port of Zabana: standard manoeuvres A to H, with traffic',
    tagline: 'The imaginary teaching port of Zabana (North-East Atlantic), built from its chart. Eight standard manoeuvres: a cargo ship to berths 3-4-5, the Ro-Ro ferry to its ramp after swinging, a trawler through the fishing-basin pass, the lock into the wet dock, a tanker at the East quay, a departure, a meeting in the channel and an assisted swing. Pilot at P, VHF 12, tugs, entrance lights, tides and stream, traffic in the bay: every rule on the chart counts toward the score. The mission itself speaks French.',
    facts: ['Zabana, from its chart', 'Manoeuvres A to H, traffic', 'Rules and checklist scored'],
    keys: [['← →', 'rudder'], ['↑ ↓', 'engine telegraph'], ['Q E', 'pivot'], ['A D', 'crab sideways'], ['L', 'let go / make fast'], ['T', 'tugs'], ['K', 'VHF 12'], ['M', 'anchor'], ['1 – 6', 'bridge, wing, behind, chart, orbit, light'], ['N G', 'chart, manoeuvre']],
    ship: false,
    fixed: 'you steer',
    fixedNote: 'The ship of the chosen manoeuvre: you have the conn.',
    brand: 'Harbour pilot',
    sub: 'Zabana · manoeuvres A to H',
    button: 'Cast off',
  },
  {
    id: 'mob',
    group: 'sea',
    name: 'Man overboard',
    kind: 'Hands-on',
    blurb: 'Williamson turn and recovery alongside',
    tagline: 'On passage in the Baie de Zabana at 10 knots, someone goes over the side. Put the rudder hard over toward him at once, swing her through the Williamson turn (reverse at 60° off) onto the reciprocal course, come back down your own wake and stop with him abeam while the crew get a line on him. Run him down or draw him into the screws and he is lost.',
    facts: ['Williamson turn', 'He drifts with the sea', 'Stop with him abeam'],
    keys: [['← →', 'rudder'], ['↑ ↓', 'engine telegraph'], ['Q E', 'turn on the spot'], ['A D', 'move sideways'], ['1 – 6', 'bridge, wing, behind, chart, orbit, tower'], ['N', 'chart'], ['R', 'try again']],
    ship: false,
    fixed: 'you steer',
    fixedNote: 'One frigate on passage in the Baie de Zabana: you have the conn.',
    brand: 'Man overboard',
    sub: 'Williamson turn drill',
    button: 'Take the conn',
  },
  {
    id: 'duel',
    group: 'combat',
    name: 'Surface battle',
    kind: 'Hands-on',
    blurb: 'Frigate against frigate: sink her first',
    tagline: 'You sail a frigate against one that sails herself. The 76 mm trains itself and fires while you hold F, or, in the radar view (5), aim the sight at any part of her hull while the helm is locked. Two 30 mm guns aft only reach astern and abeam. Three repair crews (Z, X) fight fires and floods until one ship sinks. The battle opens with the radar finding her, a short tour of the ship and your first shot (nobody fires before it); your helicopter then goes out over her and radios what it sees, you can fire its missile (M) and call friendly frigates (K), and islands hide ships.',
    facts: ['76 mm with a zoom ring and a lock', 'radar sight aims at any part of her hull', '3 repair crews'],
    keys: [['← →', 'rudder'], ['↑ ↓', 'engine telegraph'], ['F', 'fire the 76 mm (hold)'], ['G', 'fire the 30 mm (hold)'], ['A', '30 mm guns automatic on / off'], ['Z X', 'pick a compartment, send a crew'], ['1 – 5', 'views, 5 is the radar'], ['R', 'fight again'], ['N', 'map'], ['K', 'call a friendly frigate'], ['B', 'send or recall the helicopter'], ['M', 'fire the helicopter missile']],
    ship: false,
    level: true,
    fixed: 'you steer',
    fixedNote: 'One frigate with the forward 76 mm: you steer her.',
    brand: 'Surface battle',
    sub: 'frigate duel',
    button: 'Open fire',
  },
];

export const SHIPS = [
  { id: 'fwd', name: 'Forward launcher', short: 'Fwd', desc: 'Box on the forward deckhouse. Fires over the bow at a drone coming in from ahead.' },
  { id: 'aft', name: 'Aft launcher', short: 'Aft', desc: 'Box on the hangar roof. Fires astern at a drone coming in from behind.' },
];

export const MISSION_IDS = MISSIONS.map((m) => m.id);
export const ENEMY_LEVELS = [
  { id: 'easy', name: 'Easy', desc: 'Sails straight at you and shoots wide' },
  { id: 'normal', name: 'Normal', desc: 'Weaves a little and keeps her bow on you' },
  { id: 'hard', name: 'Hard', desc: 'Shoots straight, jinks and runs when hurt' },
];
export const DEFAULT_LEVEL = 'normal';
export const FIXED_SHIP = 'fwd'; // what a mission without a choice uses
const SUFFIX = { en: 'Naval Simulator', fr: 'Simulateur naval' };

// The words in a language: English as written above, French from menuFr.js laid over it.
const pick = (obj, fr, lang) => (lang === 'fr' && fr ? { ...obj, ...fr } : obj);
export const missionIn = (m, lang = readLang()) => pick(m, FR.missions[m.id], lang);
export const groupIn = (g, lang = readLang()) => pick(g, FR.groups[g.id], lang);
export const familyIn = (f, lang = readLang()) => pick(f, FR.families[f.id], lang);
export const shipIn = (s, lang = readLang()) => pick(s, FR.ships[s.id], lang);
export const levelIn = (l, lang = readLang()) => pick(l, FR.levels[l.id], lang);

// What a category lists, in order: a mission each, with the family's members folded into one entry.
// `id` is the entry's first mission; `family` is set on a folded one.
export function entriesOf(groupId, lang = 'en') {
  const out = [];
  for (const raw of MISSIONS.filter((x) => x.group === groupId)) {
    const m = missionIn(raw, lang);
    const famRaw = FAMILIES.find((f) => f.members.includes(m.id));
    if (!famRaw) out.push({ id: m.id, group: groupId, name: m.name, blurb: m.blurb, kind: m.kind, family: null, members: [m.id] });
    else if (!out.some((e) => e.family === famRaw.id)) {
      const fam = familyIn(famRaw, lang);
      out.push({ id: m.id, group: groupId, name: fam.name, blurb: fam.blurb, kind: m.kind, family: fam.id, members: fam.members });
    }
  }
  return out;
}
export const ENTRIES = GROUPS.flatMap((g) => entriesOf(g.id));
export const groupOf = (id) => missionById(id).group;
export const missionById = (id) => MISSIONS.find((m) => m.id === id) ?? MISSIONS[0];
export const shipById = (id) => SHIPS.find((s) => s.id === id) ?? SHIPS[0];

// Everything the screen (and the mission's top bar) says for a choice, in the interface language.
export function menuText(missionId, shipId = FIXED_SHIP, lang = readLang()) {
  const raw = missionById(missionId);
  const m = missionIn(raw, lang);
  const s = shipIn(raw.ship ? shipById(shipId) : shipById(FIXED_SHIP), lang);
  const launcherWord = lang === 'fr' ? 'lanceur' : 'launcher';
  return {
    id: m.id,
    title: m.name,
    kind: m.kind,
    tagline: m.tagline,
    facts: m.facts,
    keys: m.keys,
    hasShip: !!raw.ship,
    hasLevel: !!raw.level,
    ship: raw.ship ? s.name : null,
    summary: raw.ship ? `${m.name} · ${s.name}` : `${m.name} · ${m.fixed}`,
    note: raw.ship ? s.desc : m.fixedNote,
    button: m.button,
    tabTitle: raw.ship ? `${m.name} · ${s.name} — ${SUFFIX[lang] ?? SUFFIX.en}` : `${m.name} — ${SUFFIX[lang] ?? SUFFIX.en}`,
    brand: m.brand,
    sub: raw.ship ? (lang === 'fr' ? `${launcherWord} ${s.short} · ${m.name}` : `${s.short} ${launcherWord} · ${m.name}`) : m.sub,
  };
}

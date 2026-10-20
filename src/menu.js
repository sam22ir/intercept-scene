// The start screen's words, in one place. Pure data (it imports nothing: the start screen must not load
// the scene, whose modules read the chosen ship and mission once at import). start.js fills the screen
// from it, the missions read their top-bar title from it, and test/menu.test.mjs checks it against the
// real scenario, flight model and key bindings, so a title can never describe something a mission does not do.
//
// A mission with `ship: true` lets the player pick the launcher; the others fix it (`fixed` says what is
// fixed, for the summary line).

export const MISSIONS = [
  {
    id: 'intercept',
    name: 'Intercept',
    kind: 'Replay',
    blurb: 'A missile shoots the drone down',
    tagline: 'A target drone is catapulted off a stealth frigate, flies a loop and a low close pass, then turns back at the ship. On that inbound run the frigate\'s missile shoots it down.',
    facts: ['1 drone · 1 missile', 'Scrub time both ways', 'Cinematic camera'],
    keys: [['Space', 'play / pause'], ['← →', 'step through time'], ['D', 'cinematic camera'], ['1 – 3', 'follow drone, missile, ship'], ['E', 'edit the flight path'], ['G', 'missile engagement']],
    ship: true,
    brand: 'Intercept',
    button: 'Start simulation',
  },
  {
    id: 'chute',
    name: 'Recovery',
    kind: 'Replay',
    blurb: 'No missile · lands by parachute',
    tagline: 'The same flight, but the missile is never fired. At the end of the planned path the engine cuts, a red parachute opens and the drone lands in the sea.',
    facts: ['No missile', 'Red parachute', 'Lands in the sea'],
    keys: [['Space', 'play / pause'], ['← →', 'step through time'], ['D', 'cinematic camera'], ['1 – 3', 'follow drone, ship'], ['E', 'edit the flight path']],
    ship: true,
    brand: 'Recovery',
    button: 'Start simulation',
  },
  {
    id: 'pair',
    name: 'Two drones',
    kind: 'Replay',
    blurb: 'A missile for each target',
    tagline: 'A second drone leaves the same catapult 14 s after the first, on a wider, higher track, and a second missile is fired at it from the next launcher cell.',
    facts: ['2 drones · 2 missiles', '14 s apart', 'Scrub time both ways'],
    keys: [['Space', 'play / pause'], ['← →', 'step through time'], ['D', 'cinematic camera'], ['1 – 5', 'follow drones, missiles, ship'], ['E', 'edit the flight path']],
    ship: true,
    brand: 'Two drones',
    button: 'Start simulation',
  },
  {
    id: 'maneuvers',
    name: 'Naval maneuvers',
    kind: 'Drill',
    blurb: 'Two frigates run a signalled drill',
    tagline: 'Two frigates, ALG and RUS, run the briefing deck in formation, with a larger unit sailing alongside: turns together, a change of station, light and flag serials, and a close pass. 18 orders, about 70 minutes, played at 4×.',
    facts: ['3 ships: ALG, RUS and a unit', '18 orders', 'About 70 minutes'],
    keys: [['Space', 'play / pause'], ['O', 'the orders'], ['I', 'the signal text'], ['1 – 3', 'follow ALG, RUS, the formation'], ['M', 'map']],
    ship: false,
    fixed: 'ALG & RUS',
    fixedNote: 'Both frigates are fixed: ALG and RUS.',
    brand: 'Maneuvers',
    sub: 'ALG & RUS · signalled drill',
    button: 'Start exercise',
  },
  {
    id: 'formations',
    name: 'Four-ship formations',
    kind: 'Drill',
    blurb: 'SHIP1 to SHIP4 change formation',
    tagline: 'Four frigates, SHIP1 to SHIP4, run the tactical formations: line ahead, line of bearing, line abreast, box and diamond, SHIP1 leading as the guide, with wheels (CORPEN) and turns together (TURN) between them. 11 orders, about 54 minutes, played at 8×.',
    facts: ['4 ships: SHIP1 to SHIP4', '11 orders', 'About 54 minutes'],
    keys: [['Space', 'play / pause'], ['1 – 4', 'follow SHIP1 to SHIP4'], ['5', 'the whole formation'], ['M', 'map'], ['L', 'labels']],
    ship: false,
    fixed: 'SHIP1 to SHIP4',
    fixedNote: 'Four frigates, fixed: SHIP1 to SHIP4.',
    brand: 'Formations',
    sub: 'SHIP1 to SHIP4 · tactical formations',
    button: 'Start exercise',
  },
  {
    id: 'fly',
    name: 'Fly the drone',
    kind: 'Manual',
    blurb: 'Arrow keys · E engine · L catapult · F missile',
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
];

export const SHIPS = [
  { id: 'fwd', name: 'Forward launcher', short: 'Fwd', desc: 'Box on the forward deckhouse. Short, steep shot over the bow.' },
  { id: 'aft', name: 'Aft launcher', short: 'Aft', desc: 'Box on the hangar roof. Fires astern at a drone coming in from behind.' },
];

export const MISSION_IDS = MISSIONS.map((m) => m.id);
export const FIXED_SHIP = 'fwd'; // what a mission without a choice uses
const SUFFIX = 'Intercept scene';

export const missionById = (id) => MISSIONS.find((m) => m.id === id) ?? MISSIONS[0];
export const shipById = (id) => SHIPS.find((s) => s.id === id) ?? SHIPS[0];

// Everything the screen (and the mission's top bar) says for a choice.
export function menuText(missionId, shipId = FIXED_SHIP) {
  const m = missionById(missionId);
  const s = m.ship ? shipById(shipId) : shipById(FIXED_SHIP);
  return {
    id: m.id,
    title: m.name,
    kind: m.kind,
    tagline: m.tagline,
    facts: m.facts,
    keys: m.keys,
    hasShip: m.ship,
    ship: m.ship ? s.name : null,
    summary: m.ship ? `${m.name} · ${s.name}` : `${m.name} · ${m.fixed}`,
    note: m.ship ? s.desc : m.fixedNote,
    button: m.button,
    tabTitle: m.ship ? `${m.name} · ${s.name} — ${SUFFIX}` : `${m.name} — ${SUFFIX}`,
    brand: m.brand,
    sub: m.ship ? `${s.short} launcher · ${m.name}` : m.sub,
  };
}

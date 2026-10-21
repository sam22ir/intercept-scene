// The start screen's words, in one place. Pure data (it imports nothing: the start screen must not load
// the scene, whose modules read the chosen ship and mission once at import). start.js fills the screen
// from it, the missions read their top-bar title from it, and test/menu.test.mjs checks it against the
// real scenario, flight model and key bindings, so a title can never describe something a mission does not do.
//
// A mission with `ship: true` lets the player pick the launcher; the others fix it (`fixed` says what is
// fixed, for the summary line). The screen has three tabs (`GROUPS`, by what the player does): Watch (replays
// to scrub), Play (take the controls) and Drill (the naval exercises). A tab lists its entries (`entriesOf`):
// each mission is one, except the three drills, which are one entry ("Tactical maneuvers", `FAMILIES`) whose
// variants are chosen by the number of ships (`ships`, `tile`, `tileSub`). A mission with `level: true` (the ship
// duel) lets the player pick the enemy's level (`ENEMY_LEVELS`).

export const GROUPS = [
  { id: 'watch', name: 'Watch', hint: 'Replays you can scrub both ways' },
  { id: 'play', name: 'Play', hint: 'You take the controls' },
  { id: 'drill', name: 'Drill', hint: 'Naval exercises run on orders' },
];

export const FAMILIES = [
  { id: 'drill', group: 'drill', name: 'Tactical maneuvers', blurb: 'Frigates wheel and change station on orders', members: ['maneuvers2', 'maneuvers', 'formations'] },
];

export const MISSIONS = [
  {
    id: 'intercept',
    group: 'watch',
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
    group: 'watch',
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
    id: 'fly',
    group: 'play',
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
  {
    id: 'maneuvers2',
    group: 'drill',
    ships: 2,
    tile: '2 ships',
    tileSub: 'ALG · RUS',
    name: 'Two-ship drill',
    kind: 'Drill',
    blurb: 'ALG and RUS run the briefing deck',
    tagline: 'Two frigates, ALG and RUS, run the briefing deck on their own: a wheel in column, turns together, a change of guide, FORM 120 and FORM 345, light and flag serials, and a close pass. 12 orders, about 36 minutes, played at 4×.',
    facts: ['2 ships: ALG and RUS', '12 orders', 'About 36 minutes'],
    keys: [['Space', 'play / pause'], ['O', 'the orders'], ['I', 'the signal text'], ['1 – 3', 'follow ALG, RUS, the formation'], ['M', 'map']],
    ship: false,
    fixed: 'ALG & RUS',
    fixedNote: 'Two frigates, fixed: ALG and RUS.',
    brand: 'Maneuvers',
    sub: 'ALG & RUS · two-ship drill',
    button: 'Start exercise',
  },
  {
    id: 'maneuvers',
    group: 'drill',
    ships: 3,
    tile: '3 ships',
    tileSub: 'ALG · RUS · unit',
    name: 'Three-ship drill',
    kind: 'Drill',
    blurb: 'ALG and RUS drill round a larger unit',
    tagline: 'Two frigates, ALG and RUS, run the briefing deck in formation, with a larger unit sailing alongside: turns together, a change of station, light and flag serials, and a close pass. 18 orders, about 70 minutes, played at 4×.',
    facts: ['3 ships: ALG, RUS and a unit', '18 orders', 'About 70 minutes'],
    keys: [['Space', 'play / pause'], ['O', 'the orders'], ['I', 'the signal text'], ['1 – 3', 'follow ALG, RUS, the formation'], ['M', 'map']],
    ship: false,
    fixed: 'ALG, RUS & unit',
    fixedNote: 'Three ships, fixed: ALG, RUS and the unit.',
    brand: 'Maneuvers',
    sub: 'ALG, RUS & unit · three-ship drill',
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
    group: 'play',
    ships: 1,
    name: 'Solo Air Defense',
    kind: 'Manual',
    blurb: 'Sail the frigate · fight off drones',
    tagline: 'You have the ship. The arrow keys work the rudder and the engine telegraph, the radar picks up drones coming in, M fires the forward launcher\'s missiles at them, and the two 30 mm rotary guns on the aft deck fire while you hold G, or by themselves in automatic (A), for what comes in astern. A drone you leave alone makes one low pass, comes round and dives into the ship on its second approach: three hits and she is out of action.',
    facts: ['1 ship: you steer', '8 missiles + 2 guns', '7 views'],
    keys: [['← →', 'rudder'], ['↑ ↓', 'engine telegraph'], ['M', 'make a missile ready'], ['F', 'launch it'],['G', 'hold: aft guns fire'], ['A', 'guns automatic on / off'], ['Tab', 'next target'], ['1 – 7', 'bridge, behind, above, missile, radar, target, orbit'], ['N', 'radar map'], ['I', 'intercept camera on / off']],
    ship: false,
    fixed: 'you steer',
    fixedNote: 'One frigate with the forward launcher: you steer her.',
    brand: 'Solo Air Defense',
    sub: '1 ship · you steer',
    button: 'Take command',
  },
  {
    id: 'duel',
    group: 'play',
    name: 'Ship duel',
    kind: 'Manual',
    blurb: 'Frigate against frigate: sink her first',
    tagline: 'You sail a frigate against an enemy frigate that sails herself. Her 76 mm gun trains on its own and fires while you hold F (or take it by hand with T), HE to start fires or AP to wreck a compartment (Q). A forward launcher locks on and sends an anti-ship missile (M, then Enter); the two 30 mm guns aft, which only reach astern and abeam, are your defence against hers, so your stern and your heading matter. Fires and floods are fought with three repair crews (Z, X) until one ship sinks.',
    facts: ['HE and AP rounds, 4 missiles each', 'aft guns shoot down missiles', '3 repair crews against fires and floods'],
    keys: [['← →', 'rudder'], ['↑ ↓', 'engine telegraph'], ['F', 'fire the 76 mm (hold)'], ['Q', 'change the round, HE or AP'], ['T', 'aim the 76 mm by hand'], ['M', 'ready the missile launcher'], ['Enter', 'launch once locked on'], ['G', 'fire the 30 mm guns (hold)'], ['A', '30 mm guns automatic on / off'], ['Z', 'pick a compartment'], ['X', 'send or recall a repair crew'], ['1 – 6', 'behind, bridge, sight, above, shell, orbit'], ['R', 'fight again'], ['N', 'map']],
    ship: false,
    level: true,
    fixed: 'you steer',
    fixedNote: 'One frigate with the forward 76 mm: you steer her.',
    brand: 'Ship duel',
    sub: 'frigate duel',
    button: 'Open fire',
  },
];

export const SHIPS = [
  { id: 'fwd', name: 'Forward launcher', short: 'Fwd', desc: 'Box on the forward deckhouse. Short, steep shot over the bow.' },
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
const SUFFIX = 'Simulation';

// What a tab lists, in order: a mission each, with the family's members folded into one entry.
// `id` is the entry's first mission; `family` is set on a folded one.
export function entriesOf(groupId) {
  const out = [];
  for (const m of MISSIONS.filter((x) => x.group === groupId)) {
    const fam = FAMILIES.find((f) => f.members.includes(m.id));
    if (!fam) out.push({ id: m.id, group: groupId, name: m.name, blurb: m.blurb, kind: m.kind, family: null, members: [m.id] });
    else if (!out.some((e) => e.family === fam.id)) out.push({ id: m.id, group: groupId, name: fam.name, blurb: fam.blurb, kind: m.kind, family: fam.id, members: fam.members });
  }
  return out;
}
export const ENTRIES = GROUPS.flatMap((g) => entriesOf(g.id));
export const groupOf = (id) => missionById(id).group;
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
    hasLevel: !!m.level,
    ship: m.ship ? s.name : null,
    summary: m.ship ? `${m.name} · ${s.name}` : `${m.name} · ${m.fixed}`,
    note: m.ship ? s.desc : m.fixedNote,
    button: m.button,
    tabTitle: m.ship ? `${m.name} · ${s.name} — ${SUFFIX}` : `${m.name} — ${SUFFIX}`,
    brand: m.brand,
    sub: m.ship ? `${s.short} launcher · ${m.name}` : m.sub,
  };
}

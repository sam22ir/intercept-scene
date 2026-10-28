// The main menu's animated previews: one looping SVG per mission, as a string. Pure: it imports nothing
// (the menu must not load the scene, whose modules read the chosen ship and mission once at import).
// Every animation shares one 10 s loop and works in keyTimes windows, so the parts stay in step without
// scripting, and with `animate` false the same picture is a still frame (reduced motion: CSS media queries do
// not stop SMIL, so the menu decides). Gradients and the glow filter are defined inside each picture (local
// `url(#…)` references only; one preview is on screen at a time). Colours that are not in the gradients come
// from the `.art` rules in mainMenu.css. test/menuArt.test.mjs checks that every mission has a preview, that
// nothing loads from outside, and that the shot leaves the way the launcher fires (`data-shot`).

const DUR = '10s';
const LOOP = `dur="${DUR}" repeatCount="indefinite"`;
const W = 640;
const H = 300;
const HZ = 182; // the horizon in the side views
const f3 = (x) => Math.min(0.999, Math.max(0, x)).toFixed(3);

// Visible only between a and b (fractions of the loop).
const window_ = (a, b) => `<animate attributeName="opacity" calcMode="discrete" values="0;1;0" keyTimes="0;${f3(a)};${f3(b)}" ${LOOP}/>`;

// A thing that follows `path` during kt = [a, b], hidden outside it. `scale` = [values, keyTimes] shrinks it
// with distance; `still` = [x, y, angle, scale] is where the still frame draws it (null: left out).
function mover(body, { path, kt, still, rotate = 'auto', scale = null, attrs = '' }, animate) {
  if (!animate) {
    if (!still) return '';
    const [x, y, r = 0, s = 1] = still;
    return `<g ${attrs} transform="translate(${x} ${y}) rotate(${r}) scale(${s})">${body}</g>`;
  }
  const [a, b] = kt;
  const inner = scale
    ? `<g><animateTransform attributeName="transform" type="scale" values="${scale[0]}" keyTimes="${scale[1]}" ${LOOP}/>${body}</g>`
    : body;
  return `<g ${attrs} opacity="0">${window_(a, b)}`
    + `<animateMotion path="${path}" rotate="${rotate}" calcMode="linear" keyPoints="0;0;1;1" keyTimes="0;${f3(a)};${f3(b)};1" ${LOOP}/>${inner}</g>`;
}

// A smoke or contrail line that draws itself along `d` during kt, then fades by `fade`.
function drawn(d, kt, cls, animate, fade = 0.97) {
  if (!animate) return `<path class="${cls}" d="${d}"/>`;
  const [a, b] = kt;
  return `<path class="${cls}" d="${d}" pathLength="1" stroke-dasharray="1 1" stroke-dashoffset="1">`
    + `<animate attributeName="stroke-dashoffset" values="1;1;0;0" keyTimes="0;${f3(a)};${f3(b)};1" ${LOOP}/>`
    + `<animate attributeName="opacity" values="0;0;1;1;0;0" keyTimes="0;${f3(a - 0.001)};${f3(a)};${f3(fade - 0.05)};${f3(fade)};1" ${LOOP}/></path>`;
}

// An explosion at fraction `at`: a white flash, an orange fireball, a shock ring and falling debris.
function boom(x, y, at, animate, r = 26) {
  if (!animate) {
    return `<circle cx="${x}" cy="${y}" r="${r * 0.8}" fill="url(#ma-fire)" opacity="0.9"/><circle class="a-ring" cx="${x}" cy="${y}" r="${r * 1.3}" opacity="0.5"/>`;
  }
  const k = (d) => f3(at + d);
  const debris = [[-30, 70], [-12, 92], [8, 86], [26, 64], [40, 96]].map(([dx, dy], i) => (
    `<circle class="a-debris" r="${1.6 + (i % 2)}" cx="${x}" cy="${y}" opacity="0">`
    + `<animate attributeName="cx" values="${x};${x};${x + dx}" keyTimes="0;${k(0)};1" ${LOOP}/>`
    + `<animate attributeName="cy" values="${y};${y};${y + dy}" keyTimes="0;${k(0)};1" ${LOOP}/>`
    + `<animate attributeName="opacity" values="0;0;1;1;0" keyTimes="0;${k(0)};${k(0.01)};${k(0.22)};${k(0.26)}" ${LOOP}/></circle>`
  )).join('');
  return `<circle cx="${x}" cy="${y}" r="0" fill="#fff" opacity="0" filter="url(#ma-glow)">`
    + `<animate attributeName="r" values="0;0;${r * 1.4};0;0" keyTimes="0;${k(0)};${k(0.02)};${k(0.06)};1" ${LOOP}/>`
    + `<animate attributeName="opacity" values="0;0;1;0;0" keyTimes="0;${k(0)};${k(0.01)};${k(0.06)};1" ${LOOP}/></circle>`
    + `<circle cx="${x}" cy="${y}" r="0" fill="url(#ma-fire)" opacity="0">`
    + `<animate attributeName="r" values="0;0;${r};${r * 1.2};${r * 1.2}" keyTimes="0;${k(0)};${k(0.03)};${k(0.14)};1" ${LOOP}/>`
    + `<animate attributeName="opacity" values="0;0;1;0;0" keyTimes="0;${k(0)};${k(0.01)};${k(0.16)};1" ${LOOP}/></circle>`
    + `<circle class="a-smoke" cx="${x}" cy="${y}" r="0" opacity="0">`
    + `<animate attributeName="r" values="0;0;${r * 0.8};${r * 1.8};${r * 1.8}" keyTimes="0;${k(0.02)};${k(0.08)};${k(0.3)};1" ${LOOP}/>`
    + `<animate attributeName="cy" values="${y};${y};${y - 18};${y - 18}" keyTimes="0;${k(0.02)};${k(0.3)};1" ${LOOP}/>`
    + `<animate attributeName="opacity" values="0;0;0.7;0;0" keyTimes="0;${k(0.02)};${k(0.06)};${k(0.32)};1" ${LOOP}/></circle>`
    + `<circle class="a-ring" cx="${x}" cy="${y}" r="0" opacity="0">`
    + `<animate attributeName="r" values="0;0;${r * 2.4};${r * 2.4}" keyTimes="0;${k(0)};${k(0.08)};1" ${LOOP}/>`
    + `<animate attributeName="opacity" values="0;0;0.9;0;0" keyTimes="0;${k(0)};${k(0.01)};${k(0.08)};1" ${LOOP}/></circle>`
    + debris;
}

// A splash ring on the water at fraction `at`.
function splash(x, y, at, animate, r = 24) {
  if (!animate) return `<ellipse class="a-foam" cx="${x}" cy="${y}" rx="${r * 0.7}" ry="${r * 0.15}" opacity="0.7"/>`;
  return `<ellipse class="a-foam" cx="${x}" cy="${y}" rx="0" ry="0" opacity="0">`
    + `<animate attributeName="rx" values="0;0;${r};${r}" keyTimes="0;${f3(at)};${f3(at + 0.1)};1" ${LOOP}/>`
    + `<animate attributeName="ry" values="0;0;${r * 0.22};${r * 0.22}" keyTimes="0;${f3(at)};${f3(at + 0.1)};1" ${LOOP}/>`
    + `<animate attributeName="opacity" values="0;0;0.9;0;0" keyTimes="0;${f3(at)};${f3(at + 0.01)};${f3(at + 0.12)};1" ${LOOP}/></ellipse>`
    + `<path class="a-plume" d="M${x - 6} ${y}Q${x} ${y - 30} ${x + 6} ${y}Z" opacity="0">`
    + `<animate attributeName="opacity" values="0;0;0.9;0;0" keyTimes="0;${f3(at)};${f3(at + 0.01)};${f3(at + 0.06)};1" ${LOOP}/></path>`;
}

// A HUD caption that shows during [a, b].
const caption = (x, y, text, a, b, animate, cls = 'a-hudtxt', anchor = 'start') => (animate
  ? `<text class="${cls}" x="${x}" y="${y}" text-anchor="${anchor}" opacity="0">${window_(a, b)}${tr(text)}</text>`
  : '');

// The words the pictures show, in French (the signal words EXECUTE and A STATION stay as they are).
const FR = {
  'TARGET INBOUND': 'CIBLE EN APPROCHE', 'BIRD AWAY': 'MISSILE PARTI', 'SPLASH ONE': 'CIBLE DÉTRUITE',
  'LOCK-ON · NO FIRE': 'ACCROCHÉ · PAS DE TIR', 'CHUTE OPEN · 90 m': 'PARACHUTE · 90 m', RECOVERED: 'RÉCUPÉRÉ',
  'MISSILE WARNING': 'ALERTE MISSILE', 'BREAK RIGHT': 'DÉGAGEMENT À DROITE', 'MISSED YOU': 'ÉVITÉ',
  'TRACK 01 · MISSILE': 'PISTE 01 · MISSILE', 'TRACK 02 · ASTERN · GUNS': 'PISTE 02 · ARRIÈRE · CANONS', SPLASH: 'DÉTRUIT', 'SPLASH TWO': 'DEUX DÉTRUITS',
  'PILOT ABOARD · VHF 12': 'PILOTE À BORD · VHF 12', 'TUG FAST · DEAD SLOW': 'REMORQUEUR PRIS · TRÈS LENTE', 'ALL FAST · BERTH 4': 'AMARRÉ · POSTE 4',
  'MAN OVERBOARD · STARBOARD': 'HOMME À LA MER · TRIBORD', 'HARD OVER · 60° · REVERSE': 'BARRE TOUTE · 60° · CONTRE', 'DOWN THE WAKE': 'DANS LE SILLAGE', 'STOPPED · HIM ABEAM': 'STOPPÉ · PAR LE TRAVERS',
  'HIT · ENGINE ROOM': 'TOUCHÉ · MACHINE', 'INCOMING · SHORT': 'TIR ADVERSE · COURT', 'HIT · SHE IS BURNING': 'TOUCHÉ · ELLE BRÛLE', YOU: 'VOUS', ENEMY: 'ENNEMI',
};
let lang = 'en';
const tr = (s) => (lang === 'fr' && FR[s]) || s;

// Everything a picture shares: gradients, the glow filter and the camera's corner brackets.
const DEFS = '<defs>'
  + '<linearGradient id="ma-sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0a1626"/><stop offset="0.55" stop-color="#1d3a5a"/><stop offset="0.86" stop-color="#d9824a"/><stop offset="1" stop-color="#f3b06a"/></linearGradient>'
  + '<linearGradient id="ma-sea" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#28506e"/><stop offset="0.3" stop-color="#123049"/><stop offset="1" stop-color="#06131f"/></linearGradient>'
  + '<radialGradient id="ma-sun" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#fff3d1"/><stop offset="0.25" stop-color="#ffc77a" stop-opacity="0.9"/><stop offset="1" stop-color="#ff8a3d" stop-opacity="0"/></radialGradient>'
  + '<radialGradient id="ma-fire" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#fff6c8"/><stop offset="0.35" stop-color="#ffb347"/><stop offset="0.75" stop-color="#ff5a1f" stop-opacity="0.8"/><stop offset="1" stop-color="#7a1d06" stop-opacity="0"/></radialGradient>'
  + '<radialGradient id="ma-deep" cx="0.5" cy="0.45" r="0.7"><stop offset="0" stop-color="#0f3a52"/><stop offset="1" stop-color="#05121c"/></radialGradient>'
  + '<linearGradient id="ma-sweep" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#3ddc84" stop-opacity="0"/><stop offset="1" stop-color="#3ddc84" stop-opacity="0.55"/></linearGradient>'
  + '<filter id="ma-glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="2.4" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>'
  + '</defs>';
const BRACKETS = '<path class="a-bracket" d="M14 34V14H34M606 14H626V34M626 266V286H606M34 286H14V266"/>';

// --- Side views (the replays) ------------------------------------------------------------------------
function seaAndSky(animate) {
  const waves = [0, 1, 2, 3].map((i) => {
    const y = HZ + 14 + i * 26;
    const d = `M-80 ${y}${Array.from({ length: 10 }, (_, j) => ` q20 -${3 + i} 40 0 t40 0`).join('')}`;
    const move = animate ? `<animateTransform attributeName="transform" type="translate" values="0 0;-80 0" dur="${3 + i}s" repeatCount="indefinite"/>` : '';
    return `<path class="a-wave" d="${d}" opacity="${0.35 - i * 0.06}">${move}</path>`;
  }).join('');
  const cloud = (x, y, s, dx, dur) => {
    const body = `<g transform="translate(${x} ${y}) scale(${s})"><ellipse class="a-cloud" cx="0" cy="0" rx="46" ry="9"/><ellipse class="a-cloud" cx="-14" cy="-6" rx="22" ry="9"/><ellipse class="a-cloud" cx="14" cy="-5" rx="18" ry="7"/></g>`;
    return animate ? `<g>${body}<animateTransform attributeName="transform" type="translate" values="0 0;${dx} 0;0 0" dur="${dur}s" repeatCount="indefinite"/></g>` : body;
  };
  return `<rect width="${W}" height="${HZ}" fill="url(#ma-sky)"/>`
    + `<circle cx="520" cy="${HZ - 6}" r="70" fill="url(#ma-sun)"/>`
    + cloud(120, 70, 1, 40, 40) + cloud(440, 46, 0.8, -30, 34) + cloud(300, 104, 0.6, 24, 28)
    + `<rect y="${HZ}" width="${W}" height="${H - HZ}" fill="url(#ma-sea)"/>`
    + `<path class="a-glint" d="M470 ${HZ + 4}H570M490 ${HZ + 10}H560M505 ${HZ + 17}H545"/>`
    + waves;
}

// The frigate in profile, bow to the right, centred at x = 320 on the waterline. Its fixtures in scene
// coordinates: the catapult (port side, aft of midships) and the two launcher boxes.
const SHIP_X = 320;
const CAT = [262, 156];
const BOX = { fwd: [396, 140], aft: [276, 132] };
function frigate(variant, animate, { lock = null } = {}) {
  const hull = `<path class="a-hull" d="M208 ${HZ + 2} L218 ${HZ - 22} L452 ${HZ - 22} L438 ${HZ - 4} Q430 ${HZ + 2} 414 ${HZ + 2}Z"/>`
    + `<path class="a-hull-edge" d="M218 ${HZ - 22} L452 ${HZ - 22}"/>`;
  const sup = `<path class="a-sup" d="M232 ${HZ - 22} L236 ${HZ - 44} L300 ${HZ - 44} L304 ${HZ - 22}Z`
    + ` M312 ${HZ - 22} L318 ${HZ - 52} L380 ${HZ - 52} L386 ${HZ - 22}Z M326 ${HZ - 52} L332 ${HZ - 70} L366 ${HZ - 70} L370 ${HZ - 52}Z"/>`
    + `<path class="a-win" d="M336 ${HZ - 62}H362"/>`
    + `<path class="a-mast" d="M348 ${HZ - 70}V${HZ - 96}M340 ${HZ - 86}H356"/>`
    + `<circle class="a-dome" cx="270" cy="${HZ - 50}" r="8"/>`
    + `<path class="a-gun" d="M410 ${HZ - 22}V${HZ - 28}H424L440 ${HZ - 31}"/>`;
  const radar = animate
    ? `<rect class="a-radar" x="342" y="${HZ - 100}" width="12" height="3"><animateTransform attributeName="transform" type="scale" values="1 1;0.1 1;1 1" additive="sum" dur="1.6s" repeatCount="indefinite"/></rect>`
    : `<rect class="a-radar" x="342" y="${HZ - 100}" width="12" height="3"/>`;
  const [bx, by] = BOX[variant];
  const aim = variant === 'aft' ? -150 : -30;
  // The box turns to its target before it fires (or, in a recovery, while it tracks).
  const turn = lock && animate
    ? `<animateTransform attributeName="transform" type="rotate" values="0 ${bx} ${by};0 ${bx} ${by};${aim} ${bx} ${by};${aim} ${bx} ${by};0 ${bx} ${by}" keyTimes="0;${f3(lock[0] - 0.05)};${f3(lock[0])};${f3(lock[1])};1" ${LOOP}/>`
    : '';
  const box = `<g>${turn}<rect class="a-box" x="${bx - 8}" y="${by - 5}" width="18" height="10" rx="2"/></g>`;
  const cat = `<path class="a-cat" d="M${CAT[0] - 14} ${CAT[1] + 6} L${CAT[0] + 4} ${CAT[1] - 2}"/>`;
  const wake = `<path class="a-wake" d="M208 ${HZ + 2} Q150 ${HZ + 4} 40 ${HZ + 8} L40 ${HZ + 12} Q150 ${HZ + 10} 212 ${HZ + 6}Z"/>`
    + `<path class="a-bow" d="M438 ${HZ - 2} q12 4 22 2"/>`;
  return wake + hull + sup + radar + box + cat;
}

const droneSide = '<g class="a-dronebody"><path d="M-10 0H9L12 -1.5L9 -3H-8Z"/><path d="M-1 -1L-6 -8H-3L4 -1Z"/><path d="M-9 -1L-12 -6H-10L-6 -1Z"/></g>';
const missileSide = '<g><path class="a-msl" d="M-10 0H6"/><path class="a-mslhead" d="M6 -1.6L10 0L6 1.6Z"/><circle class="a-flame" cx="-12" cy="0" r="2.6" filter="url(#ma-glow)"/></g>';
const reticle = (a, b, animate, cls = 'a-lock') => (animate
  ? `<g class="${cls}" opacity="0">${window_(a, b)}<path d="M-14 -9V-14H-9M9 -14H14V-9M14 9V14H9M-9 14H-14V9"/><animateTransform attributeName="transform" type="scale" values="1.8;1.8;1;1" keyTimes="0;${f3(a)};${f3(a + 0.04)};1" ${LOOP}/></g>`
  : `<g class="${cls}"><path d="M-14 -9V-14H-9M9 -14H14V-9M14 9V14H9M-9 14H-14V9"/></g>`);

// The drone's out-and-back flight: away on the ship's side (fwd ahead, aft astern), a turn far out, back in.
const OUT = {
  fwd: 'M262 150 C300 118 360 94 440 80 S584 54 612 60 C634 66 622 78 590 78 L470 84',
  aft: 'M262 150 C230 118 180 94 140 80 S48 56 24 62 C4 68 18 80 50 80 L170 84',
};
const HIT = { fwd: [470, 84], aft: [170, 84] };
const SHOT = { fwd: 'M396 140 C412 116 438 96 470 84', aft: 'M276 132 C250 110 206 94 170 84' };
// The drone shrinks as it flies away and turns round far out (the x scale flips: it then faces the other way).
const farScale = (v, back = 0.75) => {
  const d = v === 'aft' ? -1 : 1;
  const p = (x, y) => `${(x * d).toFixed(2)} ${y}`;
  return [[p(1, 1), p(1, 1), p(0.42, 0.42), p(0.42, 0.42), p(-0.42, 0.42), p(-back, back), p(-back, back)].join(';'), '0;0.03;0.3;0.36;0.4;0.62;1'];
};

function intercept(ship, animate) {
  const v = ship === 'aft' ? 'aft' : 'fwd';
  const [hx, hy] = HIT[v];
  const fly = [0.03, 0.62];
  const shot = [0.5, 0.62];
  const drone = droneSide + reticle(0.42, 0.62, animate);
  const lead = v === 'aft' ? 'start' : 'end';
  const hudX = v === 'aft' ? 34 : 606;
  return seaAndSky(animate) + frigate(v, animate, { lock: [0.45, 0.66] })
    + drawn(OUT[v], fly, 'a-contrail', animate, 0.7)
    + mover(drone, { path: OUT[v], kt: fly, scale: farScale(v), rotate: '0', still: [hx + (v === 'aft' ? -60 : 60), hy - 4, 0, v === 'aft' ? '0.8 0.8' : '-0.8 0.8'] }, animate)
    + drawn(SHOT[v], shot, 'a-smoketrail', animate, 0.9)
    + mover(missileSide, { path: SHOT[v], kt: shot, still: [hx + (v === 'aft' ? 34 : -34), hy + 14, v === 'aft' ? 200 : -20], attrs: `data-shot="${SHOT[v]}"` }, animate)
    + boom(hx, hy, 0.62, animate)
    + drawn(`M${hx} ${hy} C${hx + 6} ${hy + 40} ${hx + 10} ${HZ - 30} ${hx + 12} ${HZ + 4}`, [0.63, 0.84], 'a-falling', animate, 0.98)
    + splash(hx + 12, HZ + 6, 0.84, animate)
    + caption(hudX, 40, 'TARGET INBOUND', 0.4, 0.5, animate, 'a-hudtxt warn', lead)
    + caption(hudX, 40, 'BIRD AWAY', 0.5, 0.62, animate, 'a-hudtxt', lead)
    + caption(hudX, 40, 'SPLASH ONE', 0.63, 0.97, animate, 'a-hudtxt ok', lead)
    + caption(hudX, 58, 'ALT 250 m', 0.4, 0.62, animate, 'a-hudsub', lead)
    + BRACKETS;
}

function chute(ship, animate) {
  const v = ship === 'aft' ? 'aft' : 'fwd';
  const path = v === 'aft'
    ? 'M262 150 C230 118 180 94 140 80 S48 56 24 62 C4 68 18 80 50 80 C110 82 160 98 190 120'
    : 'M262 150 C300 118 360 94 440 80 S584 54 612 60 C634 66 622 78 590 78 C470 82 300 98 190 120';
  const fall = 'M190 120 C188 140 184 160 180 178';
  const fly = [0.03, 0.62];
  const canopy = '<g class="a-canopygrp"><path class="a-canopy" d="M-16 -24 Q0 -38 16 -24 Q8 -27 0 -27 Q-8 -27 -16 -24Z"/><path class="a-line" d="M-16 -24L0 -2M16 -24L0 -2M-6 -27L0 -2M6 -27L0 -2"/></g>';
  const swing = animate ? '<animateTransform attributeName="transform" type="rotate" values="-8;8;-8" dur="2.4s" repeatCount="indefinite"/>' : '';
  return seaAndSky(animate) + frigate(v, animate, { lock: [0.42, 0.66] })
    + drawn(path, fly, 'a-contrail', animate, 0.75)
    + mover(droneSide + reticle(0.42, 0.62, animate, 'a-lock track'), { path, kt: fly, scale: farScale(v, 0.85), rotate: '0', still: [300, 104, 0, v === 'aft' ? '0.85 0.85' : '-0.85 0.85'] }, animate)
    + mover(`<g>${swing}${canopy}${droneSide}</g>`, { path: fall, kt: [0.62, 0.86], rotate: '0', still: [184, 150, 0, 1] }, animate)
    + splash(180, HZ + 2, 0.86, animate, 30)
    + caption(34, 40, 'LOCK-ON · NO FIRE', 0.42, 0.62, animate, 'a-hudtxt warn')
    + caption(34, 40, 'CHUTE OPEN · 90 m', 0.62, 0.86, animate, 'a-hudtxt')
    + caption(34, 40, 'RECOVERED', 0.86, 0.99, animate, 'a-hudtxt ok')
    + BRACKETS;
}

// --- Fly the drone: behind the drone, the sea rushing under it, the missile closing in ---------------
function fly(animate) {
  const vx = 320;
  const vy = 140;
  const rays = [-300, -180, -90, -30, 30, 90, 180, 300].map((dx) => `M${vx} ${vy}L${vx + dx * 4} ${H}`).join('');
  const lines = [0, 1, 2, 3, 4].map((i) => {
    const y0 = vy + 4 + i * 4;
    if (!animate) return `<path class="a-grid" d="M0 ${vy + 12 + i * i * 7}H${W}"/>`;
    return `<path class="a-grid" d="M0 ${y0}H${W}"><animate attributeName="d" values="M0 ${vy + 2}H${W};M0 ${H}H${W}" keyTimes="0;1" dur="1.6s" begin="${-i * 0.32}s" calcMode="spline" keySplines="0.7 0 1 1" repeatCount="indefinite"/></path>`;
  }).join('');
  const sky = `<rect width="${W}" height="${vy}" fill="url(#ma-sky)"/><circle cx="160" cy="${vy - 4}" r="60" fill="url(#ma-sun)"/>`;
  const sea = `<rect y="${vy}" width="${W}" height="${H - vy}" fill="url(#ma-sea)"/><path class="a-grid" d="${rays}"/>${lines}`;
  const bank = animate
    ? `<animateTransform attributeName="transform" type="rotate" values="0 ${vx} 200;0 ${vx} 200;-35 ${vx} 200;-35 ${vx} 200;0 ${vx} 200;30 ${vx} 200;30 ${vx} 200;0 ${vx} 200" keyTimes="0;0.12;0.18;0.34;0.42;0.56;0.7;0.8" ${LOOP}/>`
    : `<animateTransform attributeName="transform" type="rotate" values="-20 ${vx} 200" dur="1s" fill="freeze"/>`;
  const drone = `<g>${animate ? bank : ''}<g transform="translate(${vx} 200)" class="a-rear">`
    + '<path class="a-wing" d="M-120 4 L-10 -2 L10 -2 L120 4 L120 8 L10 4 L-10 4 L-120 8Z"/>'
    + '<path class="a-fus" d="M-12 -8 Q0 -16 12 -8 L10 12 Q0 18 -10 12Z"/>'
    + '<path class="a-wing" d="M-40 -30 L-4 -10 L4 -10 L40 -30 L40 -26 L4 -4 L-4 -4 L-40 -26Z"/>'
    + '<path class="a-wing" d="M-2 -10 V-40 H2 V-10Z"/>'
    + `<circle class="a-prop" r="16" cy="2">${animate ? '<animate attributeName="r" values="16;14;16" dur="0.12s" repeatCount="indefinite"/>' : ''}</circle>`
    + '</g></g>';
  const still = !animate ? `<g transform="rotate(-20 ${vx} 200)"><g transform="translate(${vx} 200)" class="a-rear"><path class="a-wing" d="M-120 4 L-10 -2 L10 -2 L120 4 L120 8 L10 4 L-10 4 L-120 8Z"/><path class="a-fus" d="M-12 -8 Q0 -16 12 -8 L10 12 Q0 18 -10 12Z"/><path class="a-wing" d="M-40 -30 L-4 -10 L4 -10 L40 -30 L40 -26 L4 -4 L-4 -4 L-40 -26Z"/><path class="a-wing" d="M-2 -10 V-40 H2 V-10Z"/><circle class="a-prop" r="16" cy="2"/></g></g>` : '';
  // The missile climbs in from low behind, the drone breaks right, the missile overshoots and bursts wide.
  const mPath = 'M110 300 C180 260 260 230 330 214 S520 170 600 120';
  const missile = '<g><circle class="a-flame" r="5" filter="url(#ma-glow)"/><circle class="a-mslhead" r="2.6"/></g>';
  const cap = (x, label, at) => `<g transform="translate(${x} 52)"><rect class="a-key" width="30" height="26" rx="6"/><text class="a-keytext" x="15" y="18" text-anchor="middle">${label}</text>`
    + (animate ? `<rect class="a-keyon" width="30" height="26" rx="6" opacity="0"><animate attributeName="opacity" values="0;0;0.9;0.9;0;0" keyTimes="0;${f3(at)};${f3(at + 0.01)};${f3(at + 0.14)};${f3(at + 0.16)};1" ${LOOP}/></rect>` : '') + '</g>';
  return sky + sea
    + drawn(mPath, [0.3, 0.68], 'a-smoketrail', animate, 0.8)
    + mover(missile, { path: mPath, kt: [0.3, 0.68], rotate: '0', still: [300, 220] }, animate)
    + boom(600, 120, 0.68, animate, 18)
    + (animate ? drone : still)
    + caption(34, 40, 'MISSILE WARNING', 0.3, 0.5, animate, 'a-hudtxt warn')
    + caption(34, 40, 'BREAK RIGHT', 0.5, 0.68, animate, 'a-hudtxt')
    + caption(34, 40, 'MISSED YOU', 0.68, 0.95, animate, 'a-hudtxt ok')
    + caption(606, 100, '75 m/s', 0.02, 0.99, animate, 'a-hudsub', 'end')
    + cap(530, '←', 0.12) + cap(566, '↑', 0.42) + cap(602, '→', 0.5)
    + BRACKETS;
}

// --- Plan views ------------------------------------------------------------------------------------
const water = '<rect width="640" height="300" fill="url(#ma-deep)"/>';
const grid = `<path class="a-gridline" d="${[60, 120, 180, 240].map((y) => `M0 ${y}H640`).join('')}${[80, 160, 240, 320, 400, 480, 560].map((x) => `M${x} 0V300`).join('')}"/>`;
const planShip = (cls = 'a-ship', len = 1) => `<path class="${cls}" d="M${-18 * len} -5H${8 * len}L${19 * len} 0L${8 * len} 5H${-18 * len}Z"/>`;

// Solo Air Defense: the radar scope; a drone is met by a missile, the next one from astern by the guns.
function helm(animate) {
  const cx = 320;
  const cy = 150;
  const rings = [45, 90, 135].map((r) => `<circle class="a-scope" cx="${cx}" cy="${cy}" r="${r}"/>`).join('');
  const ticks = Array.from({ length: 36 }, (_, i) => {
    const a = (i * 10 * Math.PI) / 180;
    const r0 = i % 9 === 0 ? 125 : 130;
    return `M${(cx + Math.sin(a) * r0).toFixed(1)} ${(cy - Math.cos(a) * r0).toFixed(1)}L${(cx + Math.sin(a) * 135).toFixed(1)} ${(cy - Math.cos(a) * 135).toFixed(1)}`;
  }).join('');
  const labels = [['000', cx, cy - 141], ['090', cx + 150, cy + 4], ['180', cx, cy + 152], ['270', cx - 150, cy + 4]]
    .map(([t, x, y]) => `<text class="a-scopetxt" x="${x}" y="${y}" text-anchor="middle">${t}</text>`).join('');
  const sweep = `<path d="M${cx} ${cy}L${cx} ${cy - 135}A135 135 0 0 1 ${(cx + 135 * Math.sin(0.7)).toFixed(1)} ${(cy - 135 * Math.cos(0.7)).toFixed(1)}Z" fill="url(#ma-sweep)" transform="rotate(-40 ${cx} ${cy})"/>`;
  const sweepAnim = animate
    ? `<g>${sweep}<animateTransform attributeName="transform" type="rotate" from="0 ${cx} ${cy}" to="360 ${cx} ${cy}" dur="2.5s" repeatCount="indefinite"/></g>`
    : sweep;
  const own = `<g transform="translate(${cx} ${cy}) rotate(-90)">${planShip('a-ship')}</g>`;
  const d1 = `M${cx - 128} ${cy - 70}L${cx - 40} ${cy - 22}`;
  const d2 = `M${cx + 40} ${cy + 130}L${cx + 10} ${cy + 36}`;
  const blip = '<g class="a-blip"><path d="M-6 0H6M0 -6V6"/><circle r="3"/></g>';
  const shot1 = `M${cx - 4} ${cy - 10}L${cx - 40} ${cy - 22}`;
  const tracer = animate
    ? `<path class="a-tracer" d="M${cx + 2} ${cy + 14}L${cx + 10} ${cy + 36}" stroke-dasharray="3 5" opacity="0">${window_(0.72, 0.82)}<animate attributeName="stroke-dashoffset" values="0;-16" dur="0.2s" repeatCount="indefinite"/></path>`
    : '';
  return water + grid + `<circle cx="${cx}" cy="${cy}" r="135" class="a-scopebg"/>` + rings + `<path class="a-scope" d="${ticks}"/>`
    + `<path class="a-scope" d="M${cx - 135} ${cy}H${cx + 135}M${cx} ${cy - 135}V${cy + 135}"/>` + labels + sweepAnim + own
    + drawn(d1, [0.04, 0.42], 'a-track', animate, 0.5)
    + mover(blip, { path: d1, kt: [0.04, 0.42], rotate: '0', still: [cx - 90, cy - 48] }, animate)
    + drawn(shot1, [0.3, 0.42], 'a-smoketrail', animate, 0.55)
    + mover('<circle class="a-mslhead" r="2.6" filter="url(#ma-glow)"/>', { path: shot1, kt: [0.3, 0.42], rotate: '0', still: [cx - 22, cy - 16] }, animate)
    + boom(cx - 40, cy - 22, 0.42, animate, 12)
    + drawn(d2, [0.42, 0.82], 'a-track', animate, 0.9)
    + mover(blip, { path: d2, kt: [0.42, 0.82], rotate: '0', still: [cx + 26, cy + 86] }, animate)
    + tracer + boom(cx + 10, cy + 36, 0.82, animate, 10)
    + caption(34, 40, 'TRACK 01 · MISSILE', 0.2, 0.42, animate, 'a-hudtxt warn')
    + caption(34, 40, 'TRACK 02 · ASTERN · GUNS', 0.6, 0.82, animate, 'a-hudtxt warn')
    + caption(34, 40, 'SPLASH', 0.42, 0.5, animate, 'a-hudtxt ok')
    + caption(34, 40, 'SPLASH TWO', 0.82, 0.97, animate, 'a-hudtxt ok')
    + BRACKETS;
}

// Harbour pilot: the port of Zabana in plan view (north up, from its chart); manoeuvre A comes up the
// leading line between the jetty lights and berths at 3-4-5 (in green), a tug meeting her inside.
function harbour(animate) {
  const s = 'transform="translate(80 40) scale(1)"';
  const shallow = '<path class="a-shallow" d="M0 0H480V160L412 140L341 168L327 168V73H243V40H322V0H217V40H235V73H181V103H165V89H121V132H165V120H181V168L124 176L50 152L0 148Z"/>';
  const land = '<path class="a-land" d="M0 0H480V143L412 126L341 155L327 155V73H243V40H322V0H217V40H235V73H181V103H165V89H121V132H165V120H181V155L124 164L50 140L0 135Z"/>';
  const piers = '<path class="a-land" d="M209 73H221V120H209ZM245 73H257V129H245ZM281 73H293V117H281Z"/>';
  const dikes = '<path class="a-dike" d="M181 150L186 152L195 186L225 205L221 211L189 190L178 154ZM324 150L329 153L322 190L260 216L256 210L316 185Z"/>';
  const town = [[60, 40], [90, 60], [130, 30], [380, 40], [420, 70], [440, 30], [360, 100]].map(([x, y]) => `<rect class="a-roof" x="${x}" y="${y}" width="14" height="10"/>`).join('');
  const blink = (x, y, cls, period) => `<circle class="${cls}" cx="${x}" cy="${y}" r="4" filter="url(#ma-glow)">${animate ? `<animate attributeName="opacity" values="1;0.15;1" dur="${period}s" repeatCount="indefinite"/>` : ''}</circle>`;
  const lead = '<path class="a-lead" d="M241 260V100"/>';
  const berth = '<path class="a-berth" d="M259 86L259 111"/>';
  const path = 'M241 262Q244 200 262 158L263 100';
  const tugPath = 'M200 140Q230 150 258 150';
  const own = `<g>${planShip('a-ship', 0.9)}</g>`;
  return water
    + `<g ${s}>${shallow}${land}${town}${piers}${dikes}${berth}${lead}`
    + blink(223, 208, 'a-red', 2) + blink(258, 212, 'a-green', 2.6) + blink(140, 150, 'a-white', 3.2)
    + drawn(path, [0.04, 0.9], 'a-wakeline', animate, 0.97)
    + mover(own, { path, kt: [0.04, 0.9], still: [263, 104, -90] }, animate)
    + mover(`<g>${planShip('a-tug', 0.4)}</g>`, { path: tugPath, kt: [0.45, 0.9], still: [252, 150, 0] }, animate)
    + '</g>'
    + caption(34, 40, 'PILOT ABOARD · VHF 12', 0.06, 0.4, animate, 'a-hudtxt')
    + caption(34, 40, 'TUG FAST · DEAD SLOW', 0.45, 0.88, animate, 'a-hudtxt warn')
    + caption(34, 40, 'ALL FAST · BERTH 4', 0.9, 0.99, animate, 'a-hudtxt ok')
    + BRACKETS;
}

// Man overboard: the Williamson turn in plan view; the wake draws behind her, the lifebuoy smokes and she
// stops with him abeam.
function mob(animate) {
  const path = 'M320 290V170Q320 140 344 124Q374 106 384 82Q388 60 368 50Q344 42 334 66Q326 88 326 120V150';
  const own = planShip('a-ship', 1.1);
  const man = '<circle class="a-buoy" cx="330" cy="158" r="6"/><circle class="a-man" cx="330" cy="158" r="2.2"/>';
  const smoke = animate
    ? [0, 1, 2].map((i) => `<circle class="a-orange" cx="330" cy="158" r="3" opacity="0"><animate attributeName="cy" values="158;120" dur="3s" begin="${i}s" repeatCount="indefinite"/><animate attributeName="r" values="3;14" dur="3s" begin="${i}s" repeatCount="indefinite"/><animate attributeName="opacity" values="0.6;0" dur="3s" begin="${i}s" repeatCount="indefinite"/></circle>`).join('')
    : '<circle class="a-orange" cx="330" cy="140" r="9" opacity="0.4"/>';
  const ring = animate ? '<circle class="a-ring" cx="330" cy="158" r="8"><animate attributeName="r" values="6;26" dur="2s" repeatCount="indefinite"/><animate attributeName="opacity" values="0.9;0" dur="2s" repeatCount="indefinite"/></circle>' : '';
  const angle = '<path class="a-arcmark" d="M320 170 L354 150 M320 150 A20 20 0 0 1 337 160"/><text class="a-scopetxt" x="342" y="176">60°</text>';
  return water + grid + angle
    + drawn(path, [0.04, 0.9], 'a-wakeline', animate, 0.98)
    + smoke + man + ring
    + mover(own, { path, kt: [0.04, 0.9], still: [326, 140, 90] }, animate)
    + caption(34, 40, 'MAN OVERBOARD · STARBOARD', 0.04, 0.2, animate, 'a-hudtxt warn')
    + caption(34, 40, 'HARD OVER · 60° · REVERSE', 0.2, 0.62, animate, 'a-hudtxt')
    + caption(34, 40, 'DOWN THE WAKE', 0.62, 0.9, animate, 'a-hudtxt')
    + caption(34, 40, 'STOPPED · HIM ABEAM', 0.9, 0.99, animate, 'a-hudtxt ok')
    + BRACKETS;
}

// Surface battle: two frigates in plan view trade 76 mm shells; yours hit and set her on fire, hers fall short.
function duel(animate) {
  const you = [150, 210];
  const foe = [490, 92];
  const sail = (x, y, ang, cls, dx, dy) => {
    const body = `<g transform="rotate(${ang})"><path class="a-wakeplan" d="M-24 -3 L-80 -9 L-80 9 L-24 3Z"/>${planShip(cls, 1.5)}</g>`;
    return animate
      ? `<g><animateTransform attributeName="transform" type="translate" values="${x} ${y};${x + dx} ${y + dy};${x} ${y}" ${LOOP}/>${body}</g>`
      : `<g transform="translate(${x} ${y})">${body}</g>`;
  };
  const shot1 = `M172 200Q320 60 478 96`;
  const shot2 = `M470 100Q330 220 200 236`;
  const shot3 = `M172 200Q330 70 492 92`;
  const muzzle = (x, y, at) => (animate
    ? `<circle cx="${x}" cy="${y}" r="7" fill="#ffd27a" filter="url(#ma-glow)" opacity="0"><animate attributeName="opacity" values="0;0;1;0;0" keyTimes="0;${f3(at)};${f3(at + 0.005)};${f3(at + 0.03)};1" ${LOOP}/></circle>`
    : '');
  const fire = animate
    ? `<g opacity="0">${window_(0.88, 1)}<circle cx="496" cy="90" r="6" fill="url(#ma-fire)"><animate attributeName="r" values="5;8;5" dur="0.4s" repeatCount="indefinite"/></circle>`
      + [0, 1].map((i) => `<circle class="a-smoke" cx="496" cy="88" r="4"><animate attributeName="cy" values="88;50" dur="2s" begin="${i}s" repeatCount="indefinite"/><animate attributeName="r" values="4;16" dur="2s" begin="${i}s" repeatCount="indefinite"/><animate attributeName="opacity" values="0.6;0" dur="2s" begin="${i}s" repeatCount="indefinite"/></circle>`).join('') + '</g>'
    : '<circle cx="496" cy="90" r="7" fill="url(#ma-fire)"/>';
  return water + grid
    + sail(you[0], you[1], -24, 'a-ship', 16, -6) + sail(foe[0], foe[1], 160, 'a-foe', -14, 4)
    + `<text class="a-label" x="150" y="252" text-anchor="middle">${tr('YOU')}</text><text class="a-label red" x="490" y="66" text-anchor="middle">${tr('ENEMY')}</text>`
    + muzzle(172, 200, 0.1) + drawn(shot1, [0.1, 0.28], 'a-shell', animate, 0.4)
    + boom(478, 96, 0.28, animate, 14)
    + muzzle(470, 100, 0.38) + drawn(shot2, [0.38, 0.52], 'a-shell red', animate, 0.62)
    + splash(200, 236, 0.52, animate, 18)
    + muzzle(172, 200, 0.7) + drawn(shot3, [0.7, 0.88], 'a-shell', animate, 0.97)
    + boom(492, 92, 0.88, animate, 18) + fire
    + caption(34, 40, 'HIT · ENGINE ROOM', 0.28, 0.38, animate, 'a-hudtxt ok')
    + caption(34, 40, 'INCOMING · SHORT', 0.42, 0.6, animate, 'a-hudtxt warn')
    + caption(34, 40, 'HIT · SHE IS BURNING', 0.88, 0.99, animate, 'a-hudtxt ok')
    + BRACKETS;
}

// Fleet drills: ships in plan view (all heading east) change formation on a signal; the lamp flashes the order.
const FORM = {
  2: { names: ['SHIP1', 'SHIP2'], a: [[290, 150], [370, 150]], b: [[330, 110], [330, 190]], from: 'FORM 1 · COLUMN', to: 'TURN STBD 9' },
  3: { names: ['SHIP1', 'SHIP2', 'UNIT'], a: [[250, 150], [330, 150], [410, 150]], b: [[330, 90], [330, 150], [330, 210]], from: 'FORM 1 · COLUMN', to: 'FORM 3 · LINE ABREAST' },
  4: { names: ['SHIP1', 'SHIP2', 'SHIP3', 'SHIP4'], a: [[400, 150], [330, 110], [330, 190], [260, 150]], b: [[330, 60], [330, 120], [330, 180], [330, 240]], from: 'FORM D · DIAMOND', to: 'FORM 3 · LINE ABREAST' },
};
function drill(n, animate) {
  const f = FORM[n];
  const ships = f.names.map((name, i) => {
    const [ax, ay] = f.a[i];
    const [bx, by] = f.b[i];
    const cls = name === 'UNIT' ? 'a-unit' : 'a-ship';
    const body = `<path class="a-wakeplan" d="M-20 -4 L-80 -12 L-80 12 L-20 4Z"/>${planShip(cls, name === 'UNIT' ? 1.4 : 1.1)}<text class="a-label" x="-4" y="-12" text-anchor="middle">${name}</text>`;
    if (!animate) return `<g transform="translate(${ax} ${ay})">${body}</g>`;
    const v = `${ax} ${ay};${ax} ${ay};${bx} ${by};${bx} ${by};${ax} ${ay};${ax} ${ay}`;
    return `<g><animateTransform attributeName="transform" type="translate" values="${v}" keyTimes="0;0.15;0.42;0.62;0.9;1" calcMode="spline" keySplines=".5 0 .5 1;.5 0 .5 1;0 0 1 1;.5 0 .5 1;0 0 1 1" ${LOOP}/>${body}</g>`;
  }).join('');
  const lamp = animate
    ? `<circle cx="${f.a[0][0] + 10}" cy="${f.a[0][1] - 14}" r="4" fill="#fff6c8" filter="url(#ma-glow)" opacity="0"><animate attributeName="opacity" values="0;1;0;1;1;0;1;0;0" keyTimes="0;0.02;0.04;0.06;0.09;0.1;0.12;0.14;1" ${LOOP}/><animateTransform attributeName="transform" type="translate" values="0 0;0 0;${f.b[0][0] - f.a[0][0]} ${f.b[0][1] - f.a[0][1]};${f.b[0][0] - f.a[0][0]} ${f.b[0][1] - f.a[0][1]};0 0;0 0" keyTimes="0;0.15;0.42;0.62;0.9;1" ${LOOP}/></circle>`
    : '';
  const north = '<g transform="translate(600 70)"><circle class="a-scope" r="16"/><path class="a-ship" d="M0 -14L5 0H-5Z"/><text class="a-scopetxt" y="30" text-anchor="middle">N</text></g>';
  return water + grid + north + ships + lamp
    + caption(34, 40, `EXECUTE · ${f.to}`, 0.15, 0.42, animate, 'a-hudtxt warn')
    + caption(34, 40, 'A STATION', 0.42, 0.62, animate, 'a-hudtxt ok')
    + caption(34, 40, `EXECUTE · ${f.from}`, 0.62, 0.9, animate, 'a-hudtxt warn')
    + caption(34, 40, 'A STATION', 0.9, 0.99, animate, 'a-hudtxt ok')
    + BRACKETS;
}

const SCENES = {
  intercept: (ship, a) => intercept(ship, a),
  chute: (ship, a) => chute(ship, a),
  fly: (_s, a) => fly(a),
  helm: (_s, a) => helm(a),
  harbour: (_s, a) => harbour(a),
  mob: (_s, a) => mob(a),
  duel: (_s, a) => duel(a),
  maneuvers2: (_s, a) => drill(2, a),
  maneuvers: (_s, a) => drill(3, a),
  formations: (_s, a) => drill(4, a),
};

// The preview for a mission (and launcher, where the mission has one), its captions in `language` (en or fr).
// `animate` false gives a still frame. Several previews can share a page (the menu's cards): `idPrefix`
// renames this one's gradient and filter ids so they never collide.
export function previewArt(mission, ship = 'fwd', animate = true, language = 'en', idPrefix = null) {
  const scene = SCENES[mission];
  if (!scene) return '';
  lang = language;
  const svg = `<svg class="art" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid slice" role="img" aria-hidden="true" focusable="false">${DEFS}${scene(ship, animate)}</svg>`;
  return idPrefix ? svg.replace(/(id="|url\(#)ma-/g, `$1${idPrefix}-`) : svg;
}

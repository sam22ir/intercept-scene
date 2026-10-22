// The start screen's animated previews: one small looping SVG per mission, as a string. Pure data: it
// imports nothing (the start screen must not load the scene, whose modules read the chosen ship and
// mission once at import). Every animation shares one 9 s duration and loops with keyTimes windows, so
// the parts stay in step without ids, and with `animate` false the same picture is a still frame
// (reduced motion: CSS media queries do not stop SMIL, so start.js decides). Colours come from the
// `.stage` rules in style.css. test/menuArt.test.mjs checks that every mission has a preview, and that
// the shot leaves the way the launcher fires (forward over the bow, aft astern at a drone from behind).

const DUR = '9s';
const FOREVER = 'repeatCount="indefinite"';

// A thing that follows a path during a window of the loop (kt = [start, end] as fractions of the loop),
// invisible outside it. `still` is where the still frame draws it, or null to leave it out.
function mover(body, { path, kt, still, rotate = 'auto' }, animate) {
  if (!animate) return still ? `<g transform="translate(${still[0]} ${still[1]})${still[2] ? ` rotate(${still[2]})` : ''}">${body}</g>` : '';
  const [a, b] = kt;
  return `<g opacity="0"><animate attributeName="opacity" calcMode="discrete" values="0;1;0" keyTimes="0;${a};${b}" dur="${DUR}" ${FOREVER}/>`
    + `<animateMotion path="${path}" rotate="${rotate}" calcMode="linear" keyPoints="0;0;1;1" keyTimes="0;${a};${b};1" dur="${DUR}" ${FOREVER}/>${body}</g>`;
}

// A burst that opens at fraction `at` of the loop.
function burst(x, y, at, animate, r = 22) {
  if (!animate) return `<circle class="a-burst" cx="${x}" cy="${y}" r="${r * 0.6}" opacity="0.8"/>`;
  const k = (d) => Math.min(0.999, at + d).toFixed(3);
  return `<circle class="a-burst" cx="${x}" cy="${y}" r="0" opacity="0">`
    + `<animate attributeName="r" values="0;0;${r * 0.7};${r};${r}" keyTimes="0;${at};${k(0.05)};${k(0.14)};1" dur="${DUR}" ${FOREVER}/>`
    + `<animate attributeName="opacity" values="0;0;0.95;0;0" keyTimes="0;${at};${k(0.02)};${k(0.14)};1" dur="${DUR}" ${FOREVER}/></circle>`;
}

const drone = '<path class="a-drone" d="M-9 0H9M-1 0L-6 -7M-1 0L-6 7M-9 0L-11 -3M-9 0L-11 3"/>';
const missile = '<path class="a-missile" d="M-9 0H4"/><circle class="a-missile-head" cx="5" r="2.2"/>';
const trail = (d) => `<path class="a-trail" d="${d}"/>`;

const SEA = 'M0 174 Q30 169 60 174 T120 174 T180 174 T240 174 T300 174 T360 174 T420 174 T480 174 V220 H0Z';
function frigate(variant) {
  const box = variant === 'aft'
    ? '<rect class="a-hot" x="56" y="40" width="20" height="10" rx="2" transform="rotate(35 66 45)"/>'
    : '<rect class="a-hot" x="208" y="49" width="22" height="13" rx="2"/>';
  return '<g transform="translate(120 112) scale(0.75)">'
    + '<path class="a-hull" d="M20 84 L246 84 L304 68 L300 62 L18 62 Z"/><path class="a-deck" d="M18 62 H300"/>'
    + '<path class="a-sup" d="M44 62 L48 48 L110 48 L114 62Z M130 62 L135 44 L196 44 L200 62Z M146 44 L150 30 L182 30 L186 44Z M238 62 V57 H262 V62Z"/>'
    + '<path class="a-mast" d="M166 30 V14 M160 20 H172"/><circle class="a-dome" cx="90" cy="41" r="8"/>' + box + '</g>';
}
const sideScene = (inner, variant, extra = '') => `<rect class="a-sky" width="480" height="220"/><path class="a-sea" d="${SEA}"/>${extra}${frigate(variant)}${inner}`;

function intercept(ship, animate) {
  const aft = ship === 'aft';
  // Forward: the drone loops, passes, climbs out ahead and comes back inbound over the bow; the missile leaves the forward box.
  // Aft: it swings round and comes back from astern; the missile leaves the aft box, astern.
  const dronePath = aft
    ? 'M176 152 C200 60 330 20 420 50 C470 68 460 12 380 12 C270 12 120 30 40 66'
    : 'M176 152 C200 50 300 20 350 50 C390 74 360 118 320 104 C290 94 340 66 436 70';
  const missilePath = aft ? 'M170 146 C120 100 80 76 40 66' : 'M284 153 C330 90 400 70 436 70';
  const end = aft ? [40, 66] : [436, 70];
  return sideScene(trail(dronePath) + trail(missilePath)
    + mover(drone, { path: dronePath, kt: [0.02, 0.66], still: [end[0] + (aft ? 14 : -14), end[1] - (aft ? 0 : 4)] }, animate)
    + mover(missile, { path: missilePath, kt: [0.5, 0.66], still: aft ? [100, 88, 215] : [380, 80, -25] }, animate)
    + burst(end[0], end[1], 0.66, animate), ship);
}

function chute(animate) {
  const path = 'M176 152 C220 60 330 40 372 56 C400 70 396 100 396 160';
  const canopy = '<path class="a-canopy" d="M-17 -22 Q0 -34 17 -22Z"/><path class="a-line" d="M-17 -22L0 -3M17 -22L0 -3"/>';
  const ring = animate
    ? '<ellipse class="a-ring" cx="396" cy="172" rx="2" ry="1" opacity="0"><animate attributeName="rx" values="2;2;30;30" keyTimes="0;0.9;0.99;1" dur="9s" repeatCount="indefinite"/><animate attributeName="opacity" values="0;0;0.8;0;0" keyTimes="0;0.9;0.92;0.99;1" dur="9s" repeatCount="indefinite"/></ellipse>'
    : '<ellipse class="a-ring" cx="396" cy="172" rx="22" ry="4" opacity="0.6"/>';
  const open = animate
    ? `<g opacity="0"><animate attributeName="opacity" calcMode="discrete" values="0;1;0" keyTimes="0;0.36;0.9" dur="${DUR}" ${FOREVER}/><animateMotion path="${path}" rotate="0" calcMode="linear" keyPoints="0;0;1;1" keyTimes="0;0.02;0.9;1" dur="${DUR}" ${FOREVER}/>${canopy}</g>`
    : `<g transform="translate(386 120)">${canopy}</g>`;
  return sideScene(trail(path)
    + mover(drone, { path, kt: [0.02, 0.9], still: [386, 120], rotate: '0' }, animate) + open + ring, 'fwd');
}

function fly(animate) {
  const path = 'M176 152 C230 140 260 90 300 80 S360 36 400 66 S444 112 430 60';
  const chase = 'M284 153 C330 120 370 80 392 50';
  const cap = (x, label, at) => `<g transform="translate(${x} 22)"><rect class="a-key" width="26" height="22" rx="5"/><text class="a-keytext" x="13" y="15.5" text-anchor="middle">${label}</text>`
    + (animate ? `<rect class="a-keyon" width="26" height="22" rx="5" opacity="0"><animate attributeName="opacity" values="0;0;0.9;0;0" keyTimes="0;${at};${(at + 0.03).toFixed(3)};${(at + 0.12).toFixed(3)};1" dur="${DUR}" ${FOREVER}/></rect>` : '') + '</g>';
  return sideScene(trail(path)
    + mover(drone, { path, kt: [0.02, 0.97], still: [352, 56, -25] }, animate)
    + mover(missile, { path: chase, kt: [0.55, 0.9], still: [372, 74, -50] }, animate)
    + cap(24, '←', 0.12) + cap(54, '↑', 0.3) + cap(84, '→', 0.5), 'fwd');
}

function helm(animate) {
  const rings = '<circle class="a-ring" cx="240" cy="110" r="40"/><circle class="a-ring" cx="240" cy="110" r="75"/><circle class="a-ring" cx="240" cy="110" r="105"/><path class="a-line" d="M240 5V215M135 110H345"/>';
  const sweep = animate
    ? `<g><animateTransform attributeName="transform" type="rotate" from="0 240 110" to="360 240 110" dur="${DUR}" ${FOREVER}/><path class="a-sweep" d="M240 110 L240 5 A105 105 0 0 1 314 36Z"/></g>`
    : '<path class="a-sweep" d="M240 110 L240 5 A105 105 0 0 1 314 36Z"/>';
  const own = '<path class="a-ship" d="M240 98 L248 122 L240 117 L232 122Z"/>';
  const d1 = 'M60 30L215 98', d2 = 'M430 40L262 96';
  return `<rect class="a-water" width="480" height="220"/>${rings}${sweep}${own}`
    + trail(d1) + trail(d2)
    + mover('<path class="a-blip" d="M-5 0L5 0M0 -5V5"/>', { path: d1, kt: [0.02, 0.4], still: [128, 56], rotate: '0' }, animate)
    + mover(missile, { path: 'M240 100L160 74', kt: [0.28, 0.4], still: [190, 84, 200] }, animate)
    + burst(160, 74, 0.4, animate, 16)
    + mover('<path class="a-blip" d="M-5 0L5 0M0 -5V5"/>', { path: d2, kt: [0.36, 0.81], still: [330, 72], rotate: '0' }, animate)
    + (animate ? `<path class="a-tracer" d="M250 100L301 83" opacity="0"><animate attributeName="opacity" calcMode="discrete" values="0;1;0" keyTimes="0;0.72;0.81" dur="${DUR}" ${FOREVER}/></path>` : '')
    + burst(301, 83, 0.81, animate, 14);
}

// Tactical maneuvers: ships in plan view change formation (all heading east); each layout is a list of ship centres.
const FORM = {
  2: { names: ['ALG', 'RUS'], a: [[205, 110], [275, 110]], b: [[240, 82], [240, 138]] },
  3: { names: ['ALG', 'RUS', 'UNIT'], a: [[170, 110], [240, 110], [310, 110]], b: [[240, 62], [240, 110], [240, 158]] },
  4: { names: ['SHIP1', 'SHIP2', 'SHIP3', 'SHIP4'], a: [[300, 110], [240, 78], [240, 142], [180, 110]], b: [[240, 44], [240, 92], [240, 140], [240, 188]] },
};
function drill(n, animate) {
  const f = FORM[n];
  const ships = f.names.map((name, i) => {
    const [ax, ay] = f.a[i], [bx, by] = f.b[i];
    const body = `<path class="a-ship" d="M-16 -5H8L17 0L8 5H-16Z"/><path class="a-wake" d="M-20 0H-58"/><text class="a-label" x="-6" y="-9" text-anchor="middle">${name}</text>`;
    if (!animate) return `<g transform="translate(${ax} ${ay})">${body}</g>`;
    const v = `${ax} ${ay};${ax} ${ay};${bx} ${by};${bx} ${by};${ax} ${ay};${ax} ${ay}`;
    return `<g><animateTransform attributeName="transform" type="translate" values="${v}" keyTimes="0;0.15;0.4;0.65;0.9;1" calcMode="spline" keySplines=".5 0 .5 1;.5 0 .5 1;0 0 1 1;.5 0 .5 1;0 0 1 1" dur="${DUR}" ${FOREVER}/>${body}</g>`;
  }).join('');
  const grid = '<path class="a-line" d="M0 55H480M0 110H480M0 165H480M80 0V220M160 0V220M240 0V220M320 0V220M400 0V220"/>';
  const north = '<path class="a-ship" d="M452 40L458 24L464 40Z"/><text class="a-label" x="458" y="54" text-anchor="middle">N</text>';
  return `<rect class="a-water" width="480" height="220"/>${grid}${north}${ships}`;
}


// Ship duel: two frigates in plan view trade shells (yours hits, hers falls short, yours hits again); the 76 mm's arc is shaded.
function duel(animate) {
  const youShip = '<g transform="translate(100 152) rotate(-18)"><path class="a-ship" d="M-26 -6H12L26 0L12 6H-26Z"/><text class="a-label" x="-6" y="-12" text-anchor="middle">YOU</text></g>';
  const foeShip = '<g transform="translate(380 70) rotate(162)"><path class="a-foe" d="M-26 -6H12L26 0L12 6H-26Z"/></g><text class="a-label" x="380" y="52" text-anchor="middle">ENEMY</text>';
  const arc = '<path class="a-arc" transform="translate(100 152)" d="M0 0 L170 -128 A213 213 0 0 1 150 150Z"/>';
  const shot1 = 'M128 142Q250 40 352 76', shot2 = 'M352 82Q240 170 140 164', shot3 = 'M128 142Q250 52 360 72';
  const ring = animate
    ? `<ellipse class="a-ring" cx="146" cy="168" rx="2" ry="1" opacity="0"><animate attributeName="rx" values="2;2;22;22" keyTimes="0;0.5;0.62;1" dur="${DUR}" ${FOREVER}/><animate attributeName="ry" values="1;1;8;8" keyTimes="0;0.5;0.62;1" dur="${DUR}" ${FOREVER}/><animate attributeName="opacity" values="0;0;0.8;0;0" keyTimes="0;0.5;0.53;0.64;1" dur="${DUR}" ${FOREVER}/></ellipse>`
    : '<ellipse class="a-ring" cx="146" cy="168" rx="18" ry="6" opacity="0.6"/>';
  const grid = '<path class="a-line" d="M0 55H480M0 110H480M0 165H480M80 0V220M160 0V220M240 0V220M320 0V220M400 0V220"/>';
  return `<rect class="a-water" width="480" height="220"/>${grid}${arc}${trail(shot1)}${trail(shot2)}${youShip}${foeShip}`
    + mover(missile, { path: shot1, kt: [0.1, 0.3], still: [300, 54, -12] }, animate)
    + burst(352, 76, 0.3, animate, 18)
    + mover(missile, { path: shot2, kt: [0.38, 0.5], still: [220, 150, 160] }, animate)
    + ring
    + mover(missile, { path: shot3, kt: [0.7, 0.88], still: [250, 56, -10] }, animate)
    + burst(360, 72, 0.88, animate, 24);
}

// Squadron orders: four frigates in plan view change from a column into a line abreast, shoot a raider and a drone as they close, with the
// selected ship's sector shaded. Everything is drawn from the same two layouts, as the drills are.
function squadron(animate) {
  const A = [[205, 110], [165, 110], [125, 110], [85, 110]];
  const B = [[205, 58], [205, 94], [205, 130], [205, 166]];
  const ships = A.map(([ax, ay], i) => {
    const [bx, by] = B[i];
    const body = `<path class="a-ship" d="M-14 -4.5H7L15 0L7 4.5H-14Z"/><path class="a-wake" d="M-18 0H-48"/><text class="a-label" x="-4" y="-8" text-anchor="middle">${i + 1}</text>`;
    if (!animate) return `<g transform="translate(${bx} ${by})">${body}</g>`;
    const v = `${ax} ${ay};${ax} ${ay};${bx} ${by};${bx} ${by};${ax} ${ay};${ax} ${ay}`;
    return `<g><animateTransform attributeName="transform" type="translate" values="${v}" keyTimes="0;0.1;0.3;0.7;0.9;1" calcMode="spline" keySplines=".5 0 .5 1;.5 0 .5 1;0 0 1 1;.5 0 .5 1;0 0 1 1" dur="${DUR}" ${FOREVER}/>${body}</g>`;
  }).join('');
  const grid = '<path class="a-line" d="M0 55H480M0 110H480M0 165H480M80 0V220M160 0V220M240 0V220M320 0V220M400 0V220"/>';
  const rings = '<circle class="a-ring" cx="205" cy="110" r="60"/><circle class="a-ring" cx="205" cy="110" r="110"/>';
  const wedge = '<path class="a-arc" d="M205 94 L292 44 A100 100 0 0 1 292 144Z"/>';
  const foePath = 'M472 30 C410 56 340 84 296 96';
  const dronePath = 'M472 196 C400 170 320 140 236 132';
  const shot = 'M222 96 L296 96';
  const foe = '<path class="a-foe" d="M-9 -4H5L11 0L5 4H-9Z"/>';
  const blip = '<path class="a-blip" d="M-5 0L5 0M0 -5V5"/>';
  return `<rect class="a-water" width="480" height="220"/>${grid}${rings}${wedge}${trail(foePath)}${trail(dronePath)}${ships}`
    + mover(foe, { path: foePath, kt: [0.12, 0.5], still: [380, 62, 160] }, animate)
    + mover(missile, { path: shot, kt: [0.42, 0.5], still: [258, 96] }, animate)
    + burst(296, 96, 0.5, animate, 20)
    + mover(blip, { path: dronePath, kt: [0.55, 0.84], still: [330, 158], rotate: '0' }, animate)
    + burst(236, 132, 0.84, animate, 14);
}

const SCENES = {
  intercept: (ship, a) => intercept(ship, a),
  chute: (_s, a) => chute(a),
  fly: (_s, a) => fly(a),
  helm: (_s, a) => helm(a),
  duel: (_s, a) => duel(a),
  squadron: (_s, a) => squadron(a),
  maneuvers2: (_s, a) => drill(2, a),
  maneuvers: (_s, a) => drill(3, a),
  formations: (_s, a) => drill(4, a),
};

// The preview for a mission (and launcher, where the mission has one). `animate` false gives a still frame.
export function previewArt(mission, ship = 'fwd', animate = true) {
  const scene = SCENES[mission];
  if (!scene) return '';
  return `<svg class="art" viewBox="0 0 480 220" preserveAspectRatio="xMidYMid slice" role="img" aria-hidden="true" focusable="false">${scene(ship, animate)}</svg>`;
}

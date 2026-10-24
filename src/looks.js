// The look of each mission's world: one pure table (no DOM, no three.js), tested in Node by test/looks.test.mjs.
//
// A look is a time of day (`elev`, the sun's elevation in degrees, and `az`) plus how overcast it is, how rough the sea
// is, what scenery stands on the horizon and what the weather does. Everything the environment draws (the sky, the haze
// band, the fog, the sun and fill light, the colour of the water, the cloud tint) is derived from that one elevation by
// `todAt`, so a new mood is a new row, not new shader code. Colours are designed as the sRGB a viewer should see and
// converted by `fromDisplay` to the linear values the scene feeds through the renderer's ACES tone mapping.
//
// `drill` is the original calm look (the three naval drills and Solo Air Defense): its constants live in environment.js
// and are not derived from here, so it renders exactly as before.

export const EXPOSURE = 0.75; // every mission's renderer.toneMappingExposure

// --- ACES (three.js's ACESFilmicToneMapping, in JS) so a design colour can be solved back to a scene colour ----------
const IN = [[0.59719, 0.35458, 0.04823], [0.076, 0.90834, 0.01566], [0.0284, 0.13383, 0.83777]];
const OUT = [[1.60475, -0.53108, -0.07367], [-0.10208, 1.10813, -0.00605], [-0.00327, -0.07276, 1.07602]];
const mul = (m, v) => [m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2], m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2], m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2]];
const fit = (v) => { const a = v * (v + 0.0245786) - 0.000090537; const b = v * (0.983729 * v + 0.432951) + 0.238081; return a / b; };
const sat = (x) => Math.min(1, Math.max(0, x));

// Linear scene colour -> linear display colour, as the shader does it.
export function aces(rgb, exposure = EXPOSURE) {
  const c = mul(IN, rgb.map((x) => (x * exposure) / 0.6));
  return mul(OUT, c.map(fit)).map(sat);
}
const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toSrgb = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);

// sRGB 0-255 that the viewer should see -> the linear scene colour that tone-maps to it (Gauss-Newton, a few steps).
export function fromDisplay(srgb255, exposure = EXPOSURE) {
  const target = srgb255.map((c) => toLinear(c / 255));
  let x = target.map((c) => Math.max(c, 0.01) * 1.2);
  for (let it = 0; it < 40; it++) {
    const f = aces(x, exposure);
    const err = f.map((v, i) => v - target[i]);
    if (Math.max(...err.map(Math.abs)) < 1e-5) break;
    const J = [0, 1, 2].map((j) => { // numeric Jacobian, column j
      const h = Math.max(1e-4, x[j] * 1e-3);
      const y = x.slice(); y[j] += h;
      return aces(y, exposure).map((v, i) => (v - f[i]) / h);
    });
    // solve J^T-shaped system: dx = -Jm^-1 err with Jm[i][j] = J[j][i]
    const Jm = [0, 1, 2].map((i) => [0, 1, 2].map((j) => J[j][i]));
    const dx = solve3(Jm, err.map((e) => -e));
    if (!dx) break;
    x = x.map((v, i) => Math.max(1e-4, v + dx[i] * 0.8));
  }
  return x;
}
function solve3(m, b) {
  const [a, bb, c] = m;
  const det = a[0] * (bb[1] * c[2] - bb[2] * c[1]) - a[1] * (bb[0] * c[2] - bb[2] * c[0]) + a[2] * (bb[0] * c[1] - bb[1] * c[0]);
  if (Math.abs(det) < 1e-12) return null;
  const d = (col) => {
    const r = [a.slice(), bb.slice(), c.slice()];
    for (let i = 0; i < 3; i++) r[i][col] = b[i];
    return r[0][0] * (r[1][1] * r[2][2] - r[1][2] * r[2][1]) - r[0][1] * (r[1][0] * r[2][2] - r[1][2] * r[2][0]) + r[0][2] * (r[1][0] * r[2][1] - r[1][1] * r[2][0]);
  };
  return [d(0) / det, d(1) / det, d(2) / det];
}
// sRGB 0-255 -> linear 0-1 (for colours that are drawn as they are, without tone mapping).
export const srgbToLinear = (c255) => c255.map((c) => toLinear(c / 255));
export const displayOf = (rgb, exposure = EXPOSURE) => aces(rgb, exposure).map((c) => Math.round(toSrgb(c) * 255));

// --- time of day ---------------------------------------------------------------------------------------------------
// Stops by sun elevation (degrees): horizon and zenith as the sRGB the sky shows, the sun's glow, the sun light's colour and
// strength, the fill light, and `warm`, how far the water and the clouds pick up the sky's colour.
const TOD = [
  { elev: -3, horizon: [112, 88, 120], zenith: [14, 22, 62], glow: [200, 110, 100], sun: [0x8a, 0x6a, 0x8a], sunI: 0.45, hemi: [0x40, 0x48, 0x78], hemiI: 0.45, warm: 0.5 },
  { elev: 3, horizon: [248, 140, 92], zenith: [46, 64, 128], glow: [255, 130, 70], sun: [0xff, 0x9a, 0x60], sunI: 1.5, hemi: [0x70, 0x68, 0x90], hemiI: 0.5, warm: 0.4 },
  { elev: 10, horizon: [240, 188, 134], zenith: [66, 98, 168], glow: [255, 172, 96], sun: [0xff, 0xc8, 0x90], sunI: 2.3, hemi: [0xb0, 0xb0, 0xc8], hemiI: 0.55, warm: 0.28 },
  { elev: 25, horizon: [182, 206, 232], zenith: [62, 114, 202], glow: [255, 226, 170], sun: [0xff, 0xf1, 0xdc], sunI: 2.7, hemi: [0xcf, 0xe0, 0xff], hemiI: 0.6, warm: 0.06 },
  { elev: 45, horizon: [170, 202, 236], zenith: [48, 108, 208], glow: [255, 236, 190], sun: [0xff, 0xf6, 0xe8], sunI: 2.9, hemi: [0xd4, 0xe4, 0xff], hemiI: 0.62, warm: 0 },
];
const lerp = (a, b, t) => a + (b - a) * t;
const mix3 = (a, b, t) => a.map((v, i) => lerp(v, b[i], t));

export function todAt(elev) {
  const e = Math.min(Math.max(elev, TOD[0].elev), TOD[TOD.length - 1].elev);
  let i = 0;
  while (i < TOD.length - 2 && e > TOD[i + 1].elev) i++;
  const a = TOD[i];
  const b = TOD[i + 1];
  const t = (e - a.elev) / (b.elev - a.elev);
  const out = { elev };
  for (const k of ['horizon', 'zenith', 'glow', 'sun', 'hemi']) out[k] = mix3(a[k], b[k], t);
  for (const k of ['sunI', 'hemiI', 'warm']) out[k] = lerp(a[k], b[k], t);
  return out;
}

// --- the looks -----------------------------------------------------------------------------------------------------
// elev, az      the sun (degrees); the sky and light come from todAt(elev)
// overcast      0 clear .. 1 a solid grey deck: the sky is pulled toward grey and the sun fades
// cover         strength of the cloud-deck pattern painted on the dome (0 for a clear sky)
// fog           [near, far] metres, for the sea shader and scene.fog together
// sea           state (wave size, 1 = the original), caps (whitecaps), wind (a steady drift, m/s along x and z),
//               glitter (sun glitter on the water), reflect (how much sky the water mirrors)
// clouds        sprite clouds: count, altitude band, size, opacity, plus an optional lower layer
// scenery       islands, distant ships and buoys that stay put in the world (see environment.js)
// weather       default weather; ?weather= or localStorage['intercept.weather'] overrides it
export const LOOKS = {
  // The scripted drone missions. Intercept is lit by a low late sun, so the missile's trail and fireball read against warm haze.
  intercept: {
    elev: 9, az: 225, overcast: 0.05, cover: 0.0, fog: [2600, 15000],
    sea: { state: 1.0, caps: 0.25, wind: [0.6, 0.3], glitter: 1.0, reflect: 0.9 },
    clouds: { count: 40, alt: [900, 2300], size: [800, 2100], opacity: 0.8 },
    scenery: { islands: 3, buoys: 0, ships: 2 }, weather: 'haze',
  },
  // Recovery: a clear, bright morning, so the red canopy stands out and the sea is a clean blue.
  chute: {
    elev: 38, az: 150, overcast: 0, cover: 0.0, fog: [4000, 18000],
    sea: { state: 0.8, caps: 0.1, wind: [0.5, 0.4], glitter: 1.0, reflect: 0.9 },
    clouds: { count: 34, alt: [1000, 2400], size: [800, 2000], opacity: 0.8 },
    scenery: { islands: 4, buoys: 0, ships: 1 }, weather: 'clear',
  },
  // Fly the drone: a high clear day, with stationary scenery to judge speed and height by, and cloud layers to climb through.
  fly: {
    elev: 34, az: 190, overcast: 0, cover: 0.0, fog: [4500, 20000],
    sea: { state: 1.0, caps: 0.2, wind: [0.9, 0.2], glitter: 1.0, reflect: 0.9 },
    clouds: { count: 40, alt: [1100, 2600], size: [900, 2200], opacity: 0.85, low: { count: 26, alt: [350, 700], size: [500, 1400], opacity: 0.8 } },
    scenery: { islands: 7, buoys: 130, ships: 3 }, weather: 'clear',
  },
  // Harbour pilot: a clear Mediterranean afternoon over Jijel, the sun in the south-west over the town, a near-flat sea in the
  // port. No scenery: the port, the town and the hills are the mission's own.
  harbour: {
    elev: 40, az: 215, overcast: 0, cover: 0.0, fog: [5000, 24000],
    sea: { state: 0.45, caps: 0.0, wind: [0.3, 0.2], glitter: 0.7, reflect: 0.85 },
    clouds: { count: 24, alt: [1200, 2600], size: [800, 2000], opacity: 0.75 },
    scenery: { islands: 0, buoys: 0, ships: 0 }, weather: 'clear',
  },
  // The ship duel: heavy grey weather and a rough sea.
  duel: {
    elev: 20, az: 200, overcast: 0.85, cover: 0.9, fog: [1800, 12000],
    sea: { state: 1.7, caps: 1.0, wind: [1.4, 0.6], glitter: 0.0, reflect: 0.7 },
    clouds: { count: 0 },
    scenery: { islands: 0, buoys: 0, ships: 0 }, weather: 'overcast',
  },
};

// The sea's reflection of the sky is sampled at these positions along the horizon-to-zenith blend (t = height ^ 0.55: the
// heights 0, 0.1, 0.3 and 1).
export const SKY_STOPS = [0, 0.28, 0.52, 1];

export const WEATHERS = ['clear', 'haze', 'squalls', 'overcast'];

// What a weather does on top of a look: fog distances, overcast and sea added, and which weather sprites are drawn.
export const WEATHER = {
  clear: { fogK: 1.0, overcast: 0, cover: 0, state: 0, caps: 0, squalls: 0, banks: 0 },
  haze: { fogK: 0.62, overcast: 0.08, cover: 0.0, state: 0, caps: 0, squalls: 0, banks: 6 },
  squalls: { fogK: 0.8, overcast: 0.45, cover: 0.55, state: 0.5, caps: 0.5, squalls: 5, banks: 10 },
  overcast: { fogK: 0.72, overcast: 0.8, cover: 0.9, state: 0.6, caps: 0.5, squalls: 0, banks: 8 },
};

// The look with a weather applied. Pure: the same inputs always give the same world.
export function resolveLook(name, weather) {
  const base = LOOKS[name];
  if (!base) return null;
  // Each look's numbers already describe its own default weather, so a weather only changes them by how far it differs
  // from that default (the default itself changes nothing, and `clear` on the duel really does clear the sky).
  const w = WEATHER[WEATHERS.includes(weather) ? weather : base.weather] ?? WEATHER.clear;
  const d = WEATHER[base.weather];
  const rel = (a, b, lo, hi) => Math.min(hi, Math.max(lo, a + b));
  const overcast = rel(base.overcast, w.overcast - d.overcast, 0, 1);
  const tod = todAt(base.elev);
  const grey = (c, k) => { const l = 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2]; return mix3(c, [l, l, l], k); };
  const dim = (c, k) => c.map((v) => v * k);
  const horizon = dim(mix3(tod.horizon, grey(tod.horizon, 1), overcast * 0.85), 1 - overcast * 0.12);
  const zenith = dim(mix3(tod.zenith, grey(tod.zenith, 1), overcast * 0.9), 1 - overcast * 0.35);
  return {
    name,
    weather: WEATHERS.includes(weather) ? weather : base.weather,
    elev: base.elev,
    az: base.az,
    overcast,
    cover: rel(base.cover, w.cover - d.cover, 0, 1),
    fog: [base.fog[0] * (w.fogK / d.fogK), base.fog[1] * (w.fogK / d.fogK)],
    horizon: horizon.map(Math.round), // sRGB 0-255, as the viewer should see them
    zenith: zenith.map(Math.round),
    glow: tod.glow.map((v) => v * (1 - overcast)), // the sun's glow, fading as the deck thickens
    sunColor: tod.sun,
    sunI: tod.sunI * (1 - overcast * 0.65),
    hemi: tod.hemi,
    hemiI: tod.hemiI * (1 + overcast * 0.25),
    warm: tod.warm,
    env: 0.7 * (1 - overcast * 0.35),
    sea: {
      state: Math.max(0.4, base.sea.state + w.state - d.state),
      caps: rel(base.sea.caps, w.caps - d.caps, 0, 1.2),
      wind: base.sea.wind,
      glitter: base.sea.glitter * (1 - overcast),
      reflect: base.sea.reflect,
    },
    clouds: base.clouds,
    scenery: base.scenery,
    squalls: w.squalls,
    banks: w.banks,
    // The water mirrors the sky: its colour at four heights, blended in display space (sRGB) and then solved back to scene
    // colours, so a warm horizon fades to the blue above it without the pink that blending after the tone curve gives.
    skyStops: SKY_STOPS.map((t) => horizon.map((v, i) => Math.round(v + (zenith[i] - v) * t))),
    // The physical Sky only lights the scene (the image-based light); these set how warm and hazy that light is.
    ibl: { turbidity: 2 + overcast * 8 + (1 - Math.min(base.elev, 30) / 30) * 4, rayleigh: 1.4 + (1 - Math.min(base.elev, 30) / 30) * 1.2, mie: 0.004 + overcast * 0.006 },
  };
}

// The mission a look belongs to. `mode` is the start screen's mission name.
export function lookFor(mode) {
  if (mode === 'intercept') return 'intercept';
  if (mode === 'chute') return 'chute';
  if (mode === 'fly') return 'fly';
  if (mode === 'duel') return 'duel';
  return null; // the drills and Solo Air Defense keep the calm look
}

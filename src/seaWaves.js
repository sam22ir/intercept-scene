// The sea as a sum of travelling waves (a Pierson-Moskowitz spectrum cut into a dozen Gerstner components), pure and deterministic.
// The ocean shader (environment.js, createRealOcean) is fed this table and moves its vertices and shades its normals with it; the ships
// ride the very same surface through seaHeight / seaTilt, so a hull is never above or below the water the picture shows.
//
//   state    the sea state as the menus have it: wave steepness, 1 is the old sea, 0.4 almost flat, 5.4 very high waves
//   Hs       the significant wave height in metres that state stands for (about the Douglas scale: slight 0.8, moderate 2, rough 3.3,
//            very rough 5, high 8.5)
//   waves    N components: direction (dx, dz), wave number k (rad/m), amplitude a (m), angular frequency w (deep water, w = sqrt(g k)),
//            phase, and the Gerstner steepness Q (how much each crest pinches; the sum of Q k a is kept under 0.8 so no crest loops)

export const WAVES = 12;
const G = 9.81;
const TABLE = [[0, 0.8], [0.4, 0.1], [1.0, 0.8], [1.7, 2.0], [2.5, 3.3], [3.4, 5.0], [5.4, 8.5]]; // [state, Hs]; the first row is a guard
const REL = [2.4, 1.8, 1.4, 1.12, 0.9, 0.72, 0.56, 0.43, 0.32, 0.23, 0.16, 0.11]; // each wavelength as a part of the peak's, long to short

export function significantHeight(state) {
  if (state <= TABLE[1][0]) return TABLE[1][1] * Math.max(state, 0) / TABLE[1][0];
  for (let i = 2; i < TABLE.length; i++) {
    if (state <= TABLE[i][0]) {
      const [s0, h0] = TABLE[i - 1], [s1, h1] = TABLE[i];
      return h0 + (h1 - h0) * (state - s0) / (s1 - s0);
    }
  }
  return TABLE[TABLE.length - 1][1];
}

// A small seeded generator, so the same state always gives the same sea.
function rand(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// `windDir` is the direction the waves travel, radians from +X towards +Z (the scene's x and z).
export function makeSea(state, windDir = 0) {
  const Hs = significantHeight(state);
  const Tp = 3.8 * Math.sqrt(Math.max(Hs, 0.15)) + 0.8; // the peak period of a fully developed sea
  const lamP = 1.56 * Tp * Tp;
  const r = rand(20260);
  const k = REL.map((q) => (2 * Math.PI) / (lamP * q));
  const w = k.map((kk) => Math.sqrt(G * kk));
  const wp = Math.sqrt(G * (2 * Math.PI) / lamP);
  const S = w.map((ww) => ww ** -5 * Math.exp(-1.25 * (wp / ww) ** 4));
  const dw = w.map((_, i) => Math.abs((w[Math.min(i + 1, WAVES - 1)] - w[Math.max(i - 1, 0)]) / (i === 0 || i === WAVES - 1 ? 1 : 2)));
  let a = S.map((s, i) => Math.sqrt(2 * s * dw[i]));
  const sigma2 = a.reduce((t, x) => t + x * x / 2, 0);
  const norm = (Hs / 4) / Math.sqrt(sigma2 || 1);
  a = a.map((x) => x * norm);
  const waves = [];
  let sumKA = 0;
  for (let i = 0; i < WAVES; i++) {
    const spread = (22 + 48 * (i / (WAVES - 1))) * Math.PI / 180; // the long swell is nearly aligned, the short chop is scattered
    const th = windDir + spread * (r() * 2 - 1);
    waves.push({ dx: Math.cos(th), dz: Math.sin(th), k: k[i], a: a[i], w: w[i], ph: r() * 2 * Math.PI, lam: (2 * Math.PI) / k[i], Q: 0 });
    sumKA += k[i] * a[i];
  }
  const q = Math.min(1, 0.7 / Math.max(sumKA, 1e-6)); // choppy, but no crest folds over itself
  for (const wv of waves) wv.Q = q;
  return { state, Hs, windDir, waves, lamP };
}

export function seaHeight(sea, x, z, t) {
  let h = 0;
  for (const v of sea.waves) h += v.a * Math.sin(v.k * (v.dx * x + v.dz * z) - v.w * t + v.ph);
  return h;
}

// The slopes of the surface at a point: [d h / d x, d h / d z].
export function seaSlope(sea, x, z, t) {
  let sx = 0, sz = 0;
  for (const v of sea.waves) {
    const c = v.a * v.k * Math.cos(v.k * (v.dx * x + v.dz * z) - v.w * t + v.ph);
    sx += c * v.dx; sz += c * v.dz;
  }
  return [sx, sz];
}

// How a hull of length `len` and beam `beam` sits on the sea at (x, z) heading `psi` (the scene's heading, along (cos psi, sin psi)): the height
// of her middle and her pitch (+ bow up) and roll (+ starboard down), found from the surface under her bow, stern and sides. A ship this long
// does not follow the short waves, so only the length-averaged surface counts: the sea is read at the hull's own points.
export function seaTilt(sea, x, z, psi, t, len = 110, beam = 14) {
  const fx = Math.cos(psi), fz = Math.sin(psi);
  const sx = -fz, sz = fx; // starboard
  const hb = seaHeight(sea, x + fx * len * 0.4, z + fz * len * 0.4, t);
  const hs = seaHeight(sea, x - fx * len * 0.4, z - fz * len * 0.4, t);
  const hp = seaHeight(sea, x - sx * beam * 0.5, z - sz * beam * 0.5, t);
  const hq = seaHeight(sea, x + sx * beam * 0.5, z + sz * beam * 0.5, t);
  const h0 = seaHeight(sea, x, z, t);
  return {
    heave: (h0 * 2 + hb + hs + hp + hq) / 6,
    pitch: Math.atan2(hb - hs, len * 0.8),
    roll: Math.atan2(hq - hp, beam),
  };
}

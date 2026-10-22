import { mulberry32 } from './rng.js';

// The world's islands and distant ships as pure data: where they are and how high the land stands. `scenery.js` builds the
// meshes from this and `fly.js` crashes the drone into the same land, so what you see is what you can hit. Imports only the
// seeded rng, so Node can check it.

// Everything that stands in the world repeats this often around a far-flying camera. It is more than twice the largest fog
// distance, so an island only jumps from one side to the other while it is fogged out.
export const WORLD_PERIOD = 44000;

const hash = (ix, iz) => {
  let h = Math.imul(ix, 374761393) + Math.imul(iz, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};
export function vnoise(x, z) {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx);
  const uz = fz * fz * (3 - 2 * fz);
  const a = hash(ix, iz);
  const b = hash(ix + 1, iz);
  const c = hash(ix, iz + 1);
  const d = hash(ix + 1, iz + 1);
  return a + (b - a) * ux + (c - a) * uz + (a - b - c + d) * ux * uz;
}
export const fbm = (x, z) => 0.55 * vnoise(x, z) + 0.28 * vnoise(x * 2.1 + 5, z * 2.1 - 3) + 0.17 * vnoise(x * 4.3 - 8, z * 4.3 + 11);

// The sea lane: the ship steams along +X from the origin for good, so nothing stands within `LANE` of the line z = 0.
const LANE = 1200;

// `count` islands, 150 to 1,400 m across, 3.5 to 11 km from the origin and clear of the ship's lane.
export function islandLayout(count) {
  const rng = mulberry32(4242);
  const out = [];
  for (let i = 0; i < count; i++) {
    const radius = 150 + rng() * rng() * 1300;
    const height = 25 + radius * (0.12 + 0.12 * rng());
    const seed = rng() * 1000;
    let x = 0;
    let z = 0;
    for (let tries = 0; tries < 40; tries++) {
      const a = (i / count) * Math.PI * 2 + rng() * 0.8 + tries * 0.37;
      const d = 3500 + rng() * 7500;
      x = Math.cos(a) * d;
      z = Math.sin(a) * d;
      if (Math.abs(z) > radius * 1.3 + LANE) break;
    }
    out.push({ x, z, radius, height, seed });
  }
  return out;
}

// Merchant ships on the horizon (5.5 to 12 km out), also clear of the lane.
export function farShipLayout(count) {
  const rng = mulberry32(909);
  const out = [];
  for (let i = 0; i < count; i++) {
    const length = 150 + rng() * 150;
    let x = 0;
    let z = 0;
    for (let tries = 0; tries < 40; tries++) {
      const a = (i / count) * Math.PI * 2 + 1 + rng() * 1.3 + tries * 0.41;
      const d = 5500 + rng() * 6500;
      x = Math.cos(a) * d;
      z = Math.sin(a) * d;
      if (Math.abs(z) > 700) break;
    }
    out.push({ x, z, length, heading: rng() * Math.PI * 2 });
  }
  return out;
}

// The land's height (metres above the sea, -6 well offshore) at an offset (dx, dz) from an island's centre.
export function islandHeight(isl, dx, dz) {
  const r = Math.hypot(dx, dz);
  if (r > isl.radius * 1.3) return -6;
  const th = Math.atan2(dz, dx);
  const shore = 0.72 + 0.28 * fbm(Math.cos(th) * 1.6 + isl.seed, Math.sin(th) * 1.6 + isl.seed); // an irregular shore
  const u = r / (isl.radius * shore);
  if (u >= 1.25) return -6;
  const body = Math.max(0, 1 - u * u);
  const h = isl.height * (Math.pow(body, 0.8) * (0.35 + 0.9 * fbm(dx / isl.radius * 2.2 + isl.seed, dz / isl.radius * 2.2 - isl.seed))) - 4 * u;
  return Math.max(h, -6);
}

const wrap = (d) => d - Math.round(d / WORLD_PERIOD) * WORLD_PERIOD;

// The highest land under (x, z) among `islands`, counting each as repeated every WORLD_PERIOD; 0 or less at sea.
export function landHeightAtWorld(islands, x, z) {
  let h = -6;
  for (const isl of islands) {
    const dx = wrap(x - isl.x);
    const dz = wrap(z - isl.z);
    if (Math.abs(dx) > isl.radius * 1.3 || Math.abs(dz) > isl.radius * 1.3) continue;
    h = Math.max(h, islandHeight(isl, dx, dz));
  }
  return h;
}

// How a frigate handles, shared by the two missions where you sail her (Solo Air Defense in helm.js and the
// ship duel in duel.js). Pure and import-free, so both simulations and their tests can load it without the
// scene. A hull is any object with { x, z, psi, u, r, rudder, heel } (metres, radians, m/s); stepHull() moves
// it one fixed step. The ship's frame is the model's: bow +X, starboard +Z; a heading psi is measured from +X
// toward +Z (clockwise from north, as a compass).
//
//   ← →   the wheel: held keys put the rudder over (15 degrees a second, 35 at most); let go and the
//         helmsman eases it back amidships.
//   ↑ ↓   the engine-room telegraph, one step at a time.
//   The hull answers like a ship, not a car, but a quick one: a first-order (Nomoto) turn that builds up in a couple
//   of seconds, a tactical diameter of little more than a ship length at full rudder, speed that comes and goes in a
//   few seconds, a little speed lost in a hard turn, and an outward heel while she turns.

const rad = (d) => (d * Math.PI) / 180;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const wrapPi = (a) => Math.atan2(Math.sin(a), Math.cos(a));

export const KT = 0.514444; // m/s per knot
export const TELEGRAPH = [
  { name: 'Slow astern', kn: -5 },
  { name: 'Stop', kn: 0 },
  { name: 'Dead slow', kn: 5 },
  { name: 'Slow', kn: 10 },
  { name: 'Half', kn: 16 },
  { name: 'Full', kn: 22 },
  { name: 'Flank', kn: 28 },
];
export const START_ORDER = 4; // half ahead
export const RUDDER_MAX = rad(35);
const RUDDER_RATE = rad(15); // per second, hold the key (full rudder in about two seconds)
const TURN_T = 2.5; // s: how long the swing takes to build up
const TURN_RADIUS = 70; // m at full rudder (a tactical diameter of about a ship length and a bit: she is very nimble)
const SPEED_T = 6; // s: the speed comes and goes on this time constant
const ACCEL_MAX = 1.0; // m/s²
const TURN_LOSS = 0.15; // fraction of the ordered speed lost at full rudder
const HEEL = 0.07; // rad of heel per (rad/s of turn × m/s of speed)
export const HALF_LENGTH = 58; // m
export const HALF_BEAM = 7.5;

// The two 30 mm rotary guns on the aft deckhouse roof, one each side (pivots in the ship's frame, as [x, y, z]).
export const GUN_MOUNT_LOCAL = [[-33.6, 13.3, -4.2], [-33.6, 13.3, 4.2]];
export const GUN_BLOCK = rad(40); // each gun's own dead zone reaches this far past the bow on its own side ...
// ... and, across the roof, the superstructure (radome, funnel, mast) hides the far side up to 110 degrees from the bow, so each gun
// has its own dead zone, and each fires alone: yaw is + toward port, so the port gun is blind from 110 degrees to starboard to
// GUN_BLOCK to port, and the starboard gun the mirror of it. Abeam only the near gun can fire, astern both.
export const GUN_DEAD = [{ from: -rad(110), to: GUN_BLOCK }, { from: -GUN_BLOCK, to: rad(110) }];
export const gunBlind = (i, yaw) => yaw > GUN_DEAD[i].from && yaw < GUN_DEAD[i].to;

// One step of the hull. `want` is the wheel (-1 port, 0 amidships, +1 starboard); `orderKn` the ordered speed;
// `radius` (the turning radius at full rudder; the ship duel's frigates are heavier than Solo Air Defense's nimble one),
// `rudderLimit` (a damaged steering gear) and `speedCap` (a damaged engine room, a fraction of the ordered
// ahead speed) default to a sound ship.
export function stepHull(s, dt, { want = 0, orderKn = 0, rudderLimit = RUDDER_MAX, speedCap = 1, radius = TURN_RADIUS } = {}) {
  // The wheel: held keys put the rudder over; let go and it comes back amidships.
  const goal = want * rudderLimit;
  s.rudder += clamp(goal - s.rudder, -RUDDER_RATE * dt, RUDDER_RATE * dt);
  if (Math.abs(s.rudder) > rudderLimit) s.rudder = clamp(s.rudder, -rudderLimit, rudderLimit);
  // Speed: toward the ordered speed (less in a hard turn), on a time constant, with a limit to the acceleration.
  const ordered = (orderKn > 0 ? orderKn * speedCap : orderKn) * KT * (1 - TURN_LOSS * Math.abs(s.rudder) / RUDDER_MAX);
  s.u += clamp((ordered - s.u) / SPEED_T, -ACCEL_MAX, ACCEL_MAX) * dt;
  // Turn (Nomoto, first order): the rate builds toward the steady turn for this rudder and speed.
  const rSteady = (s.u / radius) * (s.rudder / RUDDER_MAX) * (s.u < 0 ? 0.5 : 1);
  s.r += ((rSteady - s.r) / TURN_T) * dt;
  s.psi = wrapPi(s.psi + s.r * dt);
  s.x += Math.cos(s.psi) * s.u * dt;
  s.z += Math.sin(s.psi) * s.u * dt;
  // Heel outward in the turn (port side down turning to starboard), on a short lag.
  s.heel += ((-HEEL * s.r * s.u - s.heel) / 3) * dt;
}

// A bearing from north (deg 0..360), and a relative one as the navy says it: green to starboard, red to port ("green 045").
const deg = (r) => (r * 180) / Math.PI;
export const compass = (r) => ((deg(r) % 360) + 360) % 360;
export function relName(relRad) {
  const d = Math.round(deg(wrapPi(relRad)));
  if (Math.abs(d) <= 2) return 'right ahead';
  if (Math.abs(d) >= 178) return 'right astern';
  return `${d > 0 ? 'green' : 'red'} ${String(Math.abs(d)).padStart(3, '0')}`;
}
export const kmText = (m) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`);

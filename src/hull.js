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

// --- Heavy handling, for the ship duel (opt-in: DuelSim({ realHandling: true }); Solo Air Defense keeps stepHull) -----------------------------
// A 4,000 tonne frigate, not a quick one:
//   - the steering gear is slow (the rudder goes over at 5 degrees a second and comes back at 6), so a turn is begun well before it is wanted;
//   - the swing builds on the hull's own time (a first-order Nomoto turn with T = about 0.9 L / U: eight seconds at 14 knots, sixteen at 7),
//     and goes on a while after the rudder is amidships;
//   - full rudder gives a tactical diameter of about three lengths (a 170 m turning radius), and costs a quarter of her speed;
//   - she has weight: speed builds at a third of a metre a second, and with the engines eased she coasts down, only slowly, on her drag;
//   - in a turn she skids: the hull's sideways drift (`sway`, to the outside) builds with the turn rate and the speed, so she goes a little
//     sideways, and heels outward;
//   - going astern the rudder is half as effective.
const REAL_RUDDER_RATE = rad(5);
const REAL_RUDDER_RETURN = rad(6);
export const REAL_RADIUS = 170; // m at full rudder, at speed (a tactical diameter of about three lengths)
const REAL_LENGTH = 116;
const REAL_TURN_LOSS = 0.25;
const REAL_ACCEL = 0.33; // m/s², ahead
const REAL_ASTERN = 0.4; // m/s², when the order is astern (the screw bites harder than it spins ahead)
const REAL_COAST = 0.2; // m/s², the most the drag takes off her speed with the engines eased
const REAL_SPEED_T = 14; // s
const SWAY_T = 3.5; // s: the skid builds to about (3.5 s × the turn rate) of her speed
const REAL_HEEL = 0.09;

// `yaw` is an extra yaw acceleration (rad/s², the sea knocking her bow about).
export function stepHullReal(s, dt, { want = 0, orderKn = 0, rudderLimit = RUDDER_MAX, speedCap = 1, radius = REAL_RADIUS, yaw = 0 } = {}) {
  const goal = want * rudderLimit;
  const rate = want === 0 ? REAL_RUDDER_RETURN : REAL_RUDDER_RATE;
  s.rudder += clamp(goal - s.rudder, -rate * dt, rate * dt);
  if (Math.abs(s.rudder) > rudderLimit) s.rudder = clamp(s.rudder, -rudderLimit, rudderLimit);
  const ordered = (orderKn > 0 ? orderKn * speedCap : orderKn) * KT * (1 - REAL_TURN_LOSS * Math.abs(s.rudder) / RUDDER_MAX);
  const dv = ordered - s.u;
  const up = orderKn < 0 && dv < 0 ? REAL_ASTERN : REAL_ACCEL;
  s.u += clamp(dv / REAL_SPEED_T, -REAL_COAST, up) * dt;
  const T = clamp((0.9 * REAL_LENGTH) / Math.max(Math.abs(s.u), 3), 5, 25);
  const rSteady = (s.u / radius) * (s.rudder / RUDDER_MAX) * (s.u < 0 ? 0.5 : 1);
  s.r += ((rSteady - s.r) / T) * dt + yaw * dt;
  s.psi = wrapPi(s.psi + s.r * dt);
  s.sway = s.sway ?? 0;
  s.sway += (-s.u * s.r - s.sway / SWAY_T) * dt;
  s.sway = clamp(s.sway, -0.25 * Math.abs(s.u), 0.25 * Math.abs(s.u));
  const c = Math.cos(s.psi), n = Math.sin(s.psi); // forward is (c, n), starboard is (-n, c)
  s.x += (c * s.u - n * s.sway) * dt;
  s.z += (n * s.u + c * s.sway) * dt;
  s.heel += ((-REAL_HEEL * s.r * s.u - s.heel) / 4) * dt;
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

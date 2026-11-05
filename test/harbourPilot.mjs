// A scripted pilot for the harbour tests: follows legs (with cross-track correction), at given speeds, with actions on the way.
import * as m from '../src/harbour.js';
export const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
export function setSpeed(sim, kn) {
  let best = m.STOP_ORDER;
  sim.tel.forEach((t, i) => { if (Math.abs(t.kn - kn) < Math.abs(sim.tel[best].kn - kn)) best = i; });
  sim.order = best;
}
// steer along the leg from A to B: aim at a point `look` metres ahead of her projection on it
export function legWheel(sim, A, B, look = 120) {
  const ex = B.x - A.x, ez = B.z - A.z, L = Math.hypot(ex, ez) || 1, ux = ex / L, uz = ez / L;
  const t = Math.min(L, Math.max(0, (sim.x - A.x) * ux + (sim.z - A.z) * uz) + look);
  const xte = -(sim.x - A.x) * uz + (sim.z - A.z) * ux; // + to the right of the leg
  sim._xi = Math.max(-400, Math.min(400, (sim._xi ?? 0) + xte * (1 / 120))); // the stream: an integral of the offset
  const k = 0.8 * xte + 0.02 * sim._xi;
  const tx = A.x + ux * t + uz * k, tz = A.z + uz * t - ux * k;
  const e = wrap(Math.atan2(tz - sim.z, tx - sim.x) - sim.psi);
  return Math.max(-1, Math.min(1, e * 3 - sim.r * 2.3 * sim.ship.turnT));
}
// Should she wait? Red entrance lights ahead of her, or a ship in her lane ahead.
export function yieldTo(sim) {
  const toGate = m.gateSide(sim.x, sim.z);
  if (sim.route.kind === 'in' && toGate < 0 && toGate > -420 && sim.entryLight === 'red') return true;
  const c = Math.cos(sim.psi), s = Math.sin(sim.psi);
  return sim.traffic.vessels.some((v) => {
    if (!sim.traffic.visible(v) || v.role) return false;
    const dx = v.x - sim.x, dz = v.z - sim.z, ax = dx * c + dz * s, az = -dx * s + dz * c;
    return ax > 0 && ax < sim.ship.L / 2 + v.L / 2 + 160 && Math.abs(az) < sim.ship.B / 2 + v.B / 2 + 20;
  });
}
// legs: [{ to:[X,Y], kn, r?, until?(sim) }, ...]; on(sim) runs each step
export function follow(sim, legs, { stopAt, on, maxT = 2000, log } = {}) {
  let A = { x: sim.x, z: sim.z }, i = 0;
  const pts = legs.map((l) => ({ ...l, P: m.px(l.to[0], l.to[1]) }));
  for (let n = 0; n < maxT * 120 && !sim.over && !(stopAt && stopAt(sim)); n++) {
    const L = pts[i];
    const d = Math.hypot(L.P.x - sim.x, L.P.z - sim.z);
    if (d < (L.r ?? Math.max(60, sim.ship.turnR * 0.45)) && i < pts.length - 1) { A = L.P; i++; sim._xi = 0; continue; }
    on?.(sim);
    let kn = typeof L.kn === 'function' ? L.kn(sim, d) : L.kn;
    if (sim.route && sim.traffic && yieldTo(sim)) kn = sim.u > 0.4 ? -5 : 0; // she carries her way: stopping takes astern power
    setSpeed(sim, kn);
    sim.step(1 / 120, { wheel: legWheel(sim, A, L.P), ...(L.input?.(sim) ?? {}) });
    if (log) for (const e of sim.takeEvents()) if (e.type === 'say' || e.type === 'vhf') log.push(`${sim.t.toFixed(0)} ${e.text}`);
  }
  return sim;
}

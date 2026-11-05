// The kill-cam's recorder for Solo Air Defense (no DOM, no three.js, tested in Node by test/helmReplay.test.mjs).
//
// While the mission runs, a thin snapshot of the poses (the ship, every drone, every missile) is kept for the last SPAN seconds
// of sim time, and each kill or hit on the ship is noted. The replay is opt-in and the player's own button: it plays a
// clip back in slow motion from the snapshots, so the sim itself is never rewound.

export const HZ = 30; // snapshots per second of sim time
export const SPAN = 30; // s kept
export const PRE = 7; // s of a clip before the kill
export const POST = 4.5; // s after it
export const SLOW = 0.5; // replay speed
export const SLOWEST = 0.12; // replay speed around the impact
export const NEAR = [1.2, 0.9]; // s before and after the impact that play at SLOWEST

const v3 = (v) => [v.x, v.y, v.z];
const lerp = (a, b, k) => a + (b - a) * k;
const mix3 = (a, b, k) => [lerp(a[0], b[0], k), lerp(a[1], b[1], k), lerp(a[2], b[2], k)];
const wrapPi = (a) => Math.atan2(Math.sin(a), Math.cos(a));

function nlerp(a, b, k) { // quaternions as [x, y, z, w]
  const s = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3] < 0 ? -1 : 1;
  const q = a.map((v, i) => lerp(v, s * b[i], k));
  const n = Math.hypot(...q) || 1;
  return q.map((v) => v / n);
}

export class Recorder {
  constructor() { this.clear(); }

  clear() {
    this.frames = [];
    this.kills = []; // { type: 'explosion' | 'struck', t, id, pos: [x, y, z], wreck }
    this.next = 0;
  }

  // Called after every sim advance; keeps one snapshot per 1 / HZ s.
  record(sim) {
    const last = this.frames[this.frames.length - 1];
    if (last && sim.t < last.t) this.clear(); // the mission started again
    if (sim.t < this.next - 1e-6) return;
    this.next = sim.t + 1 / HZ;
    this.frames.push({
      t: sim.t,
      ship: { x: sim.x, z: sim.z, psi: sim.psi, heel: sim.heel, yaw: sim.launcher.yaw, pitch: sim.launcher.pitch },
      drones: sim.drones.map((d) => ({ id: d.id, alive: d.alive, p: v3(d.pos), q: [d.quat.x, d.quat.y, d.quat.z, d.quat.w] })),
      missiles: sim.missiles.map((m) => ({ id: m.id, p: v3(m.pos), d: v3(m.dir) })),
    });
    const old = sim.t - SPAN;
    while (this.frames.length > 2 && this.frames[0].t < old) this.frames.shift();
    while (this.kills.length && this.kills[0].t < old) this.kills.shift();
  }

  // A kill, or a drone's hit on the ship, as it happens.
  note(e, sim) {
    if (e.type !== 'explosion' && e.type !== 'struck') return;
    const d = sim.drones.find((x) => x.id === e.id);
    this.kills.push({ type: e.type, t: sim.t, id: e.id, pos: v3(e.pos), wreck: d?.wreck ?? null });
  }

  last() { return this.kills[this.kills.length - 1] ?? null; }

  // The span of a clip about a kill, cut to what was recorded.
  clip(ev) {
    const first = this.frames[0]?.t ?? ev.t;
    return { ev, t0: Math.max(first, ev.t - PRE), t1: ev.t + POST };
  }

  // The state at sim time t, interpolated between the two snapshots round it (the nearest one outside the recording).
  sample(t) {
    const f = this.frames;
    if (!f.length) return null;
    let i = 0;
    let j = f.length - 1;
    while (j - i > 1) { const m = (i + j) >> 1; if (f[m].t <= t) i = m; else j = m; }
    const a = f[i];
    const b = f[j];
    const k = b.t > a.t ? Math.min(Math.max((t - a.t) / (b.t - a.t), 0), 1) : 0;
    const by = (list, id) => list.find((x) => x.id === id);
    const near = k < 0.5 ? a : b;
    const far = k < 0.5 ? b : a;
    return {
      t,
      ship: {
        x: lerp(a.ship.x, b.ship.x, k), z: lerp(a.ship.z, b.ship.z, k), psi: a.ship.psi + wrapPi(b.ship.psi - a.ship.psi) * k,
        heel: lerp(a.ship.heel, b.ship.heel, k), yaw: lerp(a.ship.yaw, b.ship.yaw, k), pitch: lerp(a.ship.pitch, b.ship.pitch, k),
      },
      drones: near.drones.map((d) => {
        const o = by(far.drones, d.id);
        if (!o) return d;
        const pa = by(a.drones, d.id);
        const pb = by(b.drones, d.id);
        return { id: d.id, alive: d.alive, p: mix3(pa.p, pb.p, k), q: nlerp(pa.q, pb.q, k) };
      }),
      missiles: near.missiles.map((m) => {
        const o = by(far.missiles, m.id);
        if (!o) return m;
        const pa = by(a.missiles, m.id);
        const pb = by(b.missiles, m.id);
        const d = mix3(pa.d, pb.d, k);
        const n = Math.hypot(...d) || 1;
        return { id: m.id, p: mix3(pa.p, pb.p, k), d: d.map((x) => x / n) };
      }),
    };
  }
}

// How fast a clip plays at replay time rt: slow, and slowest through the impact.
export function replayRate(rt, tk) {
  const s = rt - tk;
  return s > -NEAR[0] && s < NEAR[1] ? SLOWEST : SLOW;
}

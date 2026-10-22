// Fleet command, hook 1: what an order does, and where a squadron ship steers. Pure: imports nothing.
//   applyOrder(sim, order)  -> void   apply one logged order (see the header of fleet.js for the format) to the ships it names.
//   steerGoal(sim, ship)    -> { course (deg true, 0 = +X north, clockwise), kn }   what FleetSim.think steers for, every 0.5 s.
// The stub handles every order type in the plainest way (formations are only remembered, not flown): a real version may
// reuse the station maths of formations.js and bake the stations from `ship.form` and `ship.sector`.
const wrapDeg = (a) => ((a % 360) + 360) % 360;

export function applyOrder(sim, order) {
  for (const s of sim.targetsOf(order.to)) {
    switch (order.type) {
      case 'course': s.goal = { ...s.goal, course: wrapDeg(order.course), to: null }; break;
      case 'speed': s.goal = { ...s.goal, kn: order.kn }; break;
      case 'stance': s.stance = order.stance === 'hold' ? 'hold' : 'engage'; break;
      case 'form': s.form = order.form ?? null; break;
      case 'sector': s.sector = order.sector ?? null; break;
      case 'goto': s.goal = { ...s.goal, to: [order.x, order.z] }; break;
      default: break;
    }
  }
}

export function steerGoal(sim, ship) {
  const g = ship.goal;
  if (g.to) {
    const dx = g.to[0] - ship.x, dz = g.to[1] - ship.z;
    if (Math.hypot(dx, dz) < 150) return { course: g.course, kn: Math.min(g.kn, 5) };
    return { course: wrapDeg((Math.atan2(dz, dx) * 180) / Math.PI), kn: g.kn };
  }
  return { course: g.course, kn: g.kn };
}

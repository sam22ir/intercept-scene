// Fleet command, hook 4: what a role changes about a frigate. Stat tweaks only, the physics rules are the same for everyone.
//   ROLES                  { picket, gun, escort } -> { name, radar (detection range multiplier), stock (76 mm rounds multiplier),
//                          gats (30 mm rounds multiplier), gatRange, reload, hp, crews, topSpeed }
//   applyRole(ship, role)  -> void   sets ship.role and the tweaks on a freshly built ship. Idempotent: the first call records the
//                          ship's base stats (ship.roleBase), every later call starts from them, so tweaks never compound.
//
// Which tweaks duel.js reads today (so they have a real effect):
//   stock     yes: ship.gun.stock (he / ap) and ship.gun.ammo (stepMain, fireMain).
//   gats      yes: ship.gats[i].ammo (stepGats).
//   hp        yes: ship.hp (sinking, damage). Duel's hull repair caps at HULL_HP, so the bonus is lost on the first hull repair.
//   crews     yes: ship.ai.p.crews (how many crews the helmsman sends) and extra entries in ship.crews.
//   radar, gatRange, reload, topSpeed: NOT read by duel.js. Fields for fleet code only, until duel.js has hooks for the
//             76 mm reload (MAIN_RELOAD), the 30 mm range (GUN_RANGE) and a top-speed cap.
export const ROLES = {
  picket: { name: 'Picket', radar: 1.5, stock: 0.7, gats: 1.5, gatRange: 1.25, reload: 1, hp: 1, crews: 0, topSpeed: 1 },
  gun: { name: 'Gun ship', radar: 1, stock: 1.3, gats: 1, gatRange: 1, reload: 1.2, hp: 1, crews: 0, topSpeed: 1 },
  escort: { name: 'Escort', radar: 1, stock: 1, gats: 1, gatRange: 1, reload: 1, hp: 1.2, crews: 1, topSpeed: 0.8 },
};

export function applyRole(ship, role) {
  const key = ROLES[role] ? role : 'escort';
  const r = ROLES[key];
  if (!ship.roleBase) {
    ship.roleBase = {
      stock: { ...ship.gun.stock },
      gats: ship.gats.map((g) => g.ammo),
      hp: ship.hp,
      crews: ship.ai?.p?.crews ?? 0,
      crewCount: ship.crews.length,
    };
  }
  const base = ship.roleBase;
  ship.role = key;
  ship.radar = r.radar;
  ship.gatRange = r.gatRange;
  ship.reload = r.reload;
  ship.topSpeed = r.topSpeed;

  for (const k of Object.keys(base.stock)) ship.gun.stock[k] = Math.round(base.stock[k] * r.stock);
  ship.gun.ammo = ship.gun.stock.he + ship.gun.stock.ap;

  ship.gats.forEach((g, i) => { g.ammo = Math.round(base.gats[i] * r.gats); });

  ship.hp = base.hp * r.hp;

  if (ship.ai?.p) ship.ai.p = { ...ship.ai.p, crews: base.crews + r.crews };
  const want = base.crewCount + r.crews;
  while (ship.crews.length < want) ship.crews.push({ to: null, eta: 0 });
  if (ship.crews.length > want) ship.crews.length = want;
}

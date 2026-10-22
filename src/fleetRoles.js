// Fleet command, hook 4: what a role changes about a frigate. Stat tweaks only, the physics rules are the same for everyone.
//   ROLES                  { picket, gun, escort } -> { name, radar (detection range multiplier), stock (76 mm rounds multiplier),
//                          gats (30 mm rounds multiplier) }
//   applyRole(ship, role)  -> void   sets ship.role and the tweaks on a freshly built ship.
export const ROLES = {
  picket: { name: 'Picket', radar: 1.5, stock: 0.7, gats: 1 },
  gun: { name: 'Gun ship', radar: 1, stock: 1.3, gats: 1 },
  escort: { name: 'Escort', radar: 1, stock: 1, gats: 1.5 },
};

export function applyRole(ship, role) {
  const r = ROLES[role] ?? ROLES.escort;
  ship.role = ROLES[role] ? role : 'escort';
  ship.radar = r.radar;
  for (const k of Object.keys(ship.gun.stock)) ship.gun.stock[k] = Math.round(ship.gun.stock[k] * r.stock);
  ship.gun.ammo = ship.gun.stock.he + ship.gun.stock.ap;
  for (const g of ship.gats) g.ammo = Math.round(g.ammo * r.gats);
}

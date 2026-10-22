// Ship roles (src/fleetRoles.js): each role changes the stat it claims, applying twice does not compound, the same seed gives the
// same result, and a seeded gun ship vs picket comparison shows the intended difference.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ROLES, applyRole } from '../src/fleetRoles.js';
import { FleetSim } from '../src/fleet.js';
import { makeShip, HULL_HP } from '../src/duel.js';

// A fresh frigate with the squadron helmsman's profile, built the way duel.js builds one.
function freshShip() {
  const s = makeShip(0, 0, 0, 0, 0);
  s.ai = { level: 'squad', p: { crews: 2, ammo: 'he' }, next: 0, side: 1, jink: 0, nextJink: Infinity };
  return s;
}
const total = (s) => s.gun.stock.he + s.gun.stock.ap;
const gats = (s) => s.gats.map((g) => g.ammo);

describe('the role table', () => {
  it('names the three roles, each with the fields the tweaks use', () => {
    assert.deepEqual(Object.keys(ROLES).sort(), ['escort', 'gun', 'picket']);
    for (const r of Object.values(ROLES)) {
      assert.equal(typeof r.name, 'string');
      for (const k of ['radar', 'stock', 'gats', 'gatRange', 'reload', 'hp', 'crews', 'topSpeed']) assert.equal(typeof r[k], 'number', k);
    }
  });

  it('applyRole sets the role and falls back to escort for an unknown one', () => {
    const s = freshShip();
    applyRole(s, 'gun');
    assert.equal(s.role, 'gun');
    applyRole(s, 'nonsense');
    assert.equal(s.role, 'escort');
  });
});

describe('each role changes the stat it claims', () => {
  it('picket: better radar, fewer 76 mm rounds, more and longer-ranged 30 mm', () => {
    const base = freshShip();
    const s = freshShip();
    applyRole(s, 'picket');
    assert.equal(s.radar, ROLES.picket.radar);
    assert.ok(s.radar > 1);
    assert.ok(total(s) < total(base), '76 mm stock smaller');
    assert.equal(s.gun.ammo, total(s), 'the loaded total follows the stock');
    assert.ok(gats(s).every((a, i) => a > gats(base)[i]), '30 mm rounds up');
    assert.ok(s.gatRange > 1);
  });

  it('gun ship: more 76 mm rounds and a faster reload; 30 mm and radar as they were', () => {
    const base = freshShip();
    const s = freshShip();
    applyRole(s, 'gun');
    assert.ok(total(s) > total(base), '76 mm stock larger');
    assert.ok(s.gun.stock.he > base.gun.stock.he && s.gun.stock.ap > base.gun.stock.ap);
    assert.ok(s.reload > 1, 'reload rate up');
    assert.deepEqual(gats(s), gats(base));
    assert.equal(s.radar, 1);
  });

  it('escort: more hull points, one more repair crew (in the helmsman and in the ship), a lower top speed cap', () => {
    const base = freshShip();
    const s = freshShip();
    applyRole(s, 'escort');
    assert.equal(s.hp, HULL_HP * ROLES.escort.hp);
    assert.ok(s.hp > base.hp);
    assert.equal(s.ai.p.crews, base.ai.p.crews + 1);
    assert.equal(s.crews.length, base.crews.length + 1);
    assert.ok(s.topSpeed < 1);
  });

  it('re-applying a role starts from the base stats: nothing compounds', () => {
    const once = freshShip();
    applyRole(once, 'picket');
    const twice = freshShip();
    applyRole(twice, 'gun');
    applyRole(twice, 'picket');
    assert.equal(total(twice), total(once));
    assert.deepEqual(gats(twice), gats(once));
    assert.equal(twice.radar, once.radar);
    assert.equal(twice.role, 'picket');
  });
});

describe('seeded fleets with roles', () => {
  it('the same seed gives the same result (digest and role stats)', () => {
    const a = new FleetSim({ seed: 7, n: 3 });
    const b = new FleetSim({ seed: 7, n: 3 });
    for (let i = 0; i < 300; i++) { a.advance(0.1); b.advance(0.1); }
    assert.equal(a.digest(), b.digest());
    assert.deepEqual(a.squad.map((s) => s.role), ['picket', 'gun', 'escort']);
    assert.deepEqual(a.squad.map((s) => total(s)), b.squad.map((s) => total(s)));
  });

  it('the gun ship starts with more 76 mm rounds than the picket in the same fleet', () => {
    const sim = new FleetSim({ seed: 3, n: 3 });
    const [picket, gun] = sim.squad;
    assert.equal(picket.role, 'picket');
    assert.equal(gun.role, 'gun');
    assert.ok(total(gun) > total(picket), `gun ${total(gun)} vs picket ${total(picket)}`);
  });

  // Not runnable yet: in 60 s both ships fire about 10 to 13 rounds, far from the stock, and duel.js reloads every ship at
  // MAIN_RELOAD, so `ship.reload` (the gun ship's 1.2) changes nothing until duel.js reads it.
  it.todo('the gun ship fires more 76 mm rounds than the picket in 60 s (needs a duel.js hook: `ship.reload` on MAIN_RELOAD)');
});

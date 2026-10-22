// Ship roles (src/squadronRoles.js): each role changes the stat it claims, applying twice does not compound, the same seed gives the
// same result, and a seeded gun ship vs picket comparison shows the intended difference.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ROLES, applyRole } from '../src/squadronRoles.js';
import { SquadronSim } from '../src/squadron.js';
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
      for (const k of ['radar', 'stock', 'gats', 'reload', 'hp', 'crews', 'topSpeed']) assert.equal(typeof r[k], 'number', k);
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

  it('escort: one more repair crew (in the helmsman and in the ship), a lower top speed cap', () => {
    const base = freshShip();
    const s = freshShip();
    applyRole(s, 'escort');
    assert.equal(s.hp, HULL_HP, 'no hull bonus: duel repair would cap it');
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

describe('seeded squadrons with roles', () => {
  it('the same seed gives the same result (digest and role stats)', () => {
    const a = new SquadronSim({ seed: 7, n: 3 });
    const b = new SquadronSim({ seed: 7, n: 3 });
    for (let i = 0; i < 300; i++) { a.advance(0.1); b.advance(0.1); }
    assert.equal(a.digest(), b.digest());
    assert.deepEqual(a.squad.map((s) => s.role), ['picket', 'gun', 'escort']);
    assert.deepEqual(a.squad.map((s) => total(s)), b.squad.map((s) => total(s)));
  });

  it('the gun ship starts with more 76 mm rounds than the picket in the same squadron', () => {
    const sim = new SquadronSim({ seed: 3, n: 3 });
    const [picket, gun] = sim.squad;
    assert.equal(picket.role, 'picket');
    assert.equal(gun.role, 'gun');
    assert.ok(total(gun) > total(picket), `gun ${total(gun)} vs picket ${total(picket)}`);
  });

  it('the gun ship reloads faster than the picket (SquadronSim.fireMain)', () => {
    const sim = new SquadronSim({ seed: 3, level: 'normal', scenario: 'defend' });
    const pick = sim.squad.find((x) => x.role === 'picket'), gun = sim.squad.find((x) => x.role === 'gun');
    sim.fireMain(pick);
    sim.fireMain(gun);
    assert.ok(gun.gun.cool < pick.gun.cool, `gun ${gun.gun.cool} vs picket ${pick.gun.cool}`);
  });
  it('the escort is capped below full speed', () => {
    const sim = new SquadronSim({ seed: 3, level: 'normal', scenario: 'defend' });
    const esc = sim.squad.find((x) => x.role === 'escort');
    esc.u = 100;
    sim.step(1 / 120);
    assert.ok(esc.u < 100 && esc.u > 0);
  });
});

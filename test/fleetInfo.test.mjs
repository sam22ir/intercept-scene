// fleetInfo: gradual contacts (detected, then tracked, then lost) and alerts that fire once. Runs in Node.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { contactsFor, alertsOf, TRACK_AFTER, LOST_FADE } from '../src/fleetInfo.js';
import { FleetSim } from '../src/fleet.js';

const quiet = (over = {}) => new FleetSim({ seed: 1, hooks: { planThreats: () => [], ...over } });
const find = (list, idx) => list.find((c) => c.idx === idx);

describe('contacts (gradual)', () => {
  it('a hostile in radar range is detected first (bearing only), then tracked after a few seconds', () => {
    const sim = quiet();
    const e = sim.newShip(3000, 0, Math.PI, 1);
    const c0 = find(contactsFor(sim, 0), e.idx);
    assert.ok(c0, 'in range, so a contact');
    assert.equal(c0.state, 'detected');
    assert.equal(c0.psi, null, 'no course while only detected');
    assert.equal(c0.u, null);
    assert.equal(c0.kind, null, 'no class while only detected');
    assert.ok(c0.conf < 1);
    assert.ok(Number.isFinite(c0.bearing));
    const c1 = find(contactsFor(sim, TRACK_AFTER - 1), e.idx);
    assert.equal(c1.state, 'detected', 'still short of the track time');
    const c2 = find(contactsFor(sim, TRACK_AFTER + 1), e.idx);
    assert.equal(c2.state, 'tracked');
    assert.equal(c2.conf, 1);
    assert.equal(c2.x, e.x);
    assert.equal(c2.z, e.z);
    assert.equal(c2.psi, e.psi);
    assert.equal(c2.kind, e.kind);
  });

  it('a detected position is vague: its range is rounded to the grid', () => {
    const sim = quiet();
    const e = sim.newShip(3137, 0, Math.PI, 1);
    const c = find(contactsFor(sim, 0), e.idx);
    assert.equal(c.range % 500, 0);
    assert.notEqual(c.x, e.x);
  });

  it('a contact beyond the radar range is not listed', () => {
    const sim = quiet();
    const e = sim.newShip(20000, 0, Math.PI, 1);
    assert.equal(find(contactsFor(sim, 0), e.idx), undefined);
  });

  it('a tracked contact that leaves range is lost for a while (fading), then gone', () => {
    const sim = quiet();
    const e = sim.newShip(3000, 0, Math.PI, 1);
    contactsFor(sim, 0);
    contactsFor(sim, TRACK_AFTER + 1);
    e.x = 30000;
    const lost = find(contactsFor(sim, TRACK_AFTER + 2), e.idx);
    assert.equal(lost.state, 'lost');
    const later = find(contactsFor(sim, TRACK_AFTER + 2 + LOST_FADE / 2), e.idx);
    assert.equal(later.state, 'lost');
    assert.ok(later.conf > 0 && later.conf < 1);
    assert.equal(find(contactsFor(sim, TRACK_AFTER + 2 + LOST_FADE + 1), e.idx), undefined);
  });

  it('a merely detected contact that leaves range is dropped at once', () => {
    const sim = quiet();
    const e = sim.newShip(3000, 0, Math.PI, 1);
    contactsFor(sim, 0);
    e.x = 30000;
    assert.equal(find(contactsFor(sim, 1), e.idx), undefined);
  });

  it('calls do not change the sim', () => {
    const sim = quiet();
    sim.newShip(3000, 0, Math.PI, 1);
    const before = sim.digest();
    contactsFor(sim, 0);
    contactsFor(sim, 10);
    alertsOf(sim);
    assert.equal(sim.digest(), before);
  });
});

describe('alerts', () => {
  it('flooding fires once per episode and again only after it cleared', () => {
    const sim = quiet();
    sim.squad[1].flood = 1;
    let a = alertsOf(sim).filter((x) => x.type === 'flooding');
    assert.equal(a.length, 1);
    assert.equal(a[0].ship, 1);
    assert.equal(a[0].severity, 'warn');
    assert.equal(a[0].active, true);
    sim.t = 1;
    assert.equal(alertsOf(sim).filter((x) => x.type === 'flooding').length, 1, 'no repeat while it lasts');
    sim.squad[1].flood = 0;
    sim.t = 2;
    a = alertsOf(sim).filter((x) => x.type === 'flooding');
    assert.equal(a.length, 1);
    assert.equal(a[0].active, false);
    sim.squad[1].flood = 1;
    sim.t = 3;
    assert.equal(alertsOf(sim).filter((x) => x.type === 'flooding').length, 2);
  });

  it('a fire names its compartment', () => {
    const sim = quiet();
    sim.squad[0].fire.gun = 0.5;
    const f = alertsOf(sim).find((x) => x.type === 'fire');
    assert.ok(f);
    assert.match(f.text, /76 mm gun/);
    assert.equal(f.severity, 'danger');
  });

  it('low fuel and low ammunition warn once', () => {
    const sim = quiet();
    sim.squad[2].fuel = 0.1;
    sim.squad[2].gun.ammo = 3;
    const types = alertsOf(sim).map((x) => x.type);
    assert.equal(types.filter((t) => t === 'fuel').length, 1);
    assert.equal(types.filter((t) => t === 'ammo').length, 1);
  });

  it('a missile launch is seen once, and an inbound one once when it closes', () => {
    const sim = quiet();
    const m = sim.newShip(9000, 0, Math.PI, 1, 'missile');
    let al = alertsOf(sim);
    assert.equal(al.filter((x) => x.type === 'missile').length, 1);
    assert.equal(al.filter((x) => x.type === 'inbound').length, 0, 'still far');
    m.x = 1000;
    sim.t = 4;
    al = alertsOf(sim);
    assert.equal(al.filter((x) => x.type === 'inbound').length, 1);
    sim.t = 5;
    al = alertsOf(sim);
    assert.equal(al.filter((x) => x.type === 'missile').length, 1);
    assert.equal(al.filter((x) => x.type === 'inbound').length, 1);
    assert.ok(al.every((x) => Number.isFinite(x.t)));
  });

  it('a new run (a reset) starts the alerts afresh', () => {
    const sim = quiet();
    sim.squad[0].flood = 1;
    assert.equal(alertsOf(sim).length, 1);
    sim.reset();
    assert.equal(alertsOf(sim).length, 0);
  });
});

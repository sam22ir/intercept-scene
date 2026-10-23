import test from 'node:test';
import assert from 'node:assert/strict';
import { DuelSim } from '../src/duel.js';

const run = (level, opts, secs) => {
  const sim = new DuelSim({ seed: 5, level, waves: true, enemyHelis: true, ...opts });
  const none = { left: 0, right: 0, fire: 0, gat: 0, aim: null };
  for (let i = 0; i < secs * 30; i++) sim.step(1 / 30, none);
  return sim;
};

test('Easy sends no enemy helicopter', () => {
  assert.equal(run('easy', {}, 90).ehops.length, 0);
});

test('Normal and Hard send helicopters that hit the player', () => {
  for (const lv of ['normal', 'hard']) {
    const sim = run(lv, { gunRange: 0 }, 150); // no 30 mm answer: it lives and fires
    assert.ok(sim.ehops.length >= 1, `${lv}: a helicopter flew`);
    assert.ok(sim.player.stats.taken > 0, `${lv}: it hit the player`);
  }
});

test('the option off means no helicopters, and Hard brings more frigates than Normal', () => {
  const off = new DuelSim({ seed: 5, level: 'hard', waves: true });
  off.step(1 / 30, { left: 0, right: 0, fire: 0, gat: 0, aim: null });
  assert.equal(off.ehops.length, 0);
  const n = (lv) => new DuelSim({ seed: 5, level: lv, waves: true }).pending.filter((w) => w.kind === 'enemy').length;
  assert.ok(n('hard') > n('normal') && n('normal') > n('easy'));
});

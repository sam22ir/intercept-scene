// Solo Air Defense's grades and best scores (src/helmScoring.js).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { gradeOf, raidScore, raidRun, classicRun, loadBest, saveBest, KEY } from '../src/helmScoring.js';

const clean = { n: 1, decoys: 10, real: 3, realKilled: 3, decoysKilled: 10, realStruck: 0, decoysStruck: 0, cellsUsed: 3, cellsOnDecoys: 0, rounds: 300, strikes: 0 };
const memory = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)) }; };

describe('grades', () => {
  it('maps a score to a letter', () => {
    assert.deepEqual([100, 95, 94, 85, 70, 55, 54, 0].map(gradeOf), ['S', 'S', 'A', 'A', 'B', 'C', 'D', 'D']);
  });
});

describe('raid score', () => {
  it('a clean raid with a few rounds is an S', () => {
    const r = raidScore(clean);
    assert.equal(r.grade, 'S');
    assert.ok(r.score >= 95);
  });
  it('a missile that gets through costs more than a decoy, and a cell on a decoy costs something', () => {
    const missile = raidScore({ ...clean, realStruck: 1 }).score;
    const decoy = raidScore({ ...clean, decoysStruck: 1 }).score;
    const waste = raidScore({ ...clean, cellsOnDecoys: 2 }).score;
    assert.ok(missile < decoy && decoy < raidScore(clean).score);
    assert.ok(waste < raidScore(clean).score);
  });
  it('never goes below 0', () => {
    assert.equal(raidScore({ ...clean, realStruck: 3, decoysStruck: 10, cellsOnDecoys: 8, rounds: 5000 }).score, 0);
  });
});

describe('runs', () => {
  it('a raid run is the mean of its raids, less 15 if she was lost', () => {
    const dirty = { ...clean, realStruck: 1 };
    const run = raidRun([clean, dirty]);
    assert.equal(run.raids, 2);
    assert.equal(run.score, Math.round((raidScore(clean).score + raidScore(dirty).score) / 2));
    assert.equal(raidRun([clean, dirty], true).score, run.score - 15);
  });
  it('more clean raids rank higher', () => {
    assert.ok(raidRun([clean, clean]).points > raidRun([clean]).points);
  });
  it('the plain mission scores kills against damage and ammunition', () => {
    const good = classicRun({ kills: 5, strikes: 0, cellsUsed: 5, rounds: 400 });
    const bad = classicRun({ kills: 5, strikes: 2, cellsUsed: 8, rounds: 2000 });
    assert.ok(good.score > bad.score);
    assert.equal(classicRun({ kills: 0, strikes: 3, out: true }).grade, 'D');
  });
});

describe('best scores', () => {
  it('keeps the best of each mode and says when a run beats it', () => {
    const store = memory();
    const a = raidRun([clean]);
    assert.equal(loadBest('raid', store), null);
    assert.equal(saveBest(a, store).isNew, true);
    assert.equal(saveBest(raidRun([{ ...clean, realStruck: 1 }]), store).isNew, false, 'a worse run is not kept');
    assert.equal(loadBest('raid', store).points, a.points);
    assert.equal(saveBest(raidRun([clean, clean]), store).isNew, true);
    assert.equal(loadBest('classic', store), null, 'the modes are separate');
  });
  it('survives blocked or damaged storage', () => {
    const broken = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
    assert.equal(loadBest('raid', broken), null);
    assert.doesNotThrow(() => saveBest(raidRun([clean]), broken));
    const junk = memory(); junk.setItem(KEY, '{not json');
    assert.equal(loadBest('raid', junk), null);
  });
});

import './helpers/browser';
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { planExpansion } from '../src/features/expansion/planner';
import { coalitionOptions, arriving } from '../src/features/expansion/cooperation';
import { nearby } from '../src/features/expansion/world';
import { defaults, members, totalCount, completionMs } from '../src/features/expansion/types';
import { planet, identity } from './helpers/fixtures';

test('planner assigns scarce targets jointly and respects inventory and queue travel deadlines', () => {
  const jobs = [
    { sourceId: 1n, targetId: 3n, count: 10, travelMs: 1000 },
    { sourceId: 1n, targetId: 4n, count: 10, travelMs: 2000 },
    { sourceId: 2n, targetId: 3n, count: 10, travelMs: 2000 },
  ];
  const result = planExpansion(jobs, new Map([[1n, 10], [2n, 10]]), 1500, 10000);
  assert.equal(result.exact, true); assert.equal(result.jobs.length, 2);
  assert.ok(result.jobs.some(j => j.sourceId === 1n && j.targetId === 4n));
  assert.ok(result.jobs.some(j => j.sourceId === 2n && j.targetId === 3n));
  const tight = planExpansion(jobs, new Map([[1n, 20], [2n, 10]]), 1500, 2000);
  assert.equal(tight.jobs.length, 1);
});
test('nearby excludes locked targets before applying per-source n and radius', () => {
  const source = planet(1n, 0, 0, true);
  assert.deepEqual(nearby(source, [source, planet(2n, 1, 0), planet(3n, 2, 0), planet(4n, 40, 0)], new Set([2n]), { ...defaults, candidates: 1 }).map(p => p.planetId), [3n]);
});
test('two and three nearby planets can jointly capture with one arriving probe of margin', () => {
  const target = planet(10n, 1, 1); target.probeCount = 10;
  const sources = [planet(1n, 0, 0, true), planet(2n, 1, 0, true), planet(3n, 0, 1, true)]
    .map(planet => ({ planet, available: 5, travelMs: 10000, lossPct: 0 }));
  assert.equal(coalitionOptions(target, sources.slice(0, 2), defaults).length, 0);
  const triple = coalitionOptions(target, sources, defaults);
  assert.ok(triple.length > 0);
  for (const job of triple) {
    assert.equal(members(job).length, 3); assert.equal(totalCount(job), 12);
    assert.ok(members(job).every(m => m.count <= 5 && m.count > 0));
  }
  const pair = coalitionOptions(target, sources.slice(0, 2).map(s => ({ ...s, available: 8 })), defaults);
  assert.ok(pair.length > 0); assert.equal(totalCount(pair[0]), 12);
  assert.equal(coalitionOptions(target, sources, { ...defaults, maxSources: 2 }).length, 0);
});
test('group budgets include each fleet toll, source proximity and arrival spread', () => {
  const target = planet(10n, 1, 1); target.probeCount = 10;
  const sources = [planet(1n, 0, 0, true), planet(2n, 1, 0, true)]
    .map(planet => ({ planet, available: 14, travelMs: 10000, lossPct: 50 }));
  const plans = coalitionOptions(target, sources, defaults);
  assert.ok(plans.length > 0);
  for (const plan of plans) assert.equal(members(plan).reduce((sum, m) => sum + arriving(m.count, 50), 0), 12);
  assert.equal(coalitionOptions(target, sources.map(s => ({ ...s, available: 11 })), defaults).length, 0);
  assert.equal(coalitionOptions(target, [sources[0], { ...sources[1], travelMs: 25001 }], defaults).length, 0);
  assert.equal(coalitionOptions(target, [sources[0], { ...sources[1], planet: planet(2n, 9, 0, true) }], defaults).length, 0);
  target.ownerId = identity; assert.equal(coalitionOptions(target, sources, defaults).length, 0);
});
test('planner counts a group as one capture and reserves every contributing source', () => {
  const group = { sourceId: 1n, targetId: 10n, count: 7, travelMs: 1000, support: [{ sourceId: 2n, count: 6, travelMs: 2000 }] };
  const competing = { sourceId: 2n, targetId: 11n, count: 6, travelMs: 1000 };
  assert.equal(planExpansion([group, competing], new Map([[1n, 7], [2n, 6]]), 1500, 10000).jobs.length, 1);
  const both = planExpansion([group, competing], new Map([[1n, 7], [2n, 12]]), 1500, 10000);
  assert.equal(both.jobs.length, 2);
  assert.equal(planExpansion([group], new Map([[1n, 7], [2n, 5]]), 1500, 10000).jobs.length, 0);
  assert.equal(planExpansion([group], new Map([[1n, 7], [2n, 6]]), 1500, 1999).jobs.length, 0);
  const slowSolo = { sourceId: 3n, targetId: 10n, count: 13, travelMs: 9000 };
  assert.equal(completionMs(planExpansion([slowSolo, group], new Map([[1n, 7], [2n, 6], [3n, 13]]), 1500, 10000).jobs[0]), 9000);
});

test('coalition is still useful when it frees the scarce source and increases total captures', () => {
  const solo = { sourceId: 1n, targetId: 10n, count: 6, travelMs: 1000 };
  const group = { sourceId: 1n, targetId: 10n, count: 3, travelMs: 1000, support: [{ sourceId: 2n, count: 3, travelMs: 1000 }] };
  const second = { sourceId: 1n, targetId: 11n, count: 3, travelMs: 1000 };
  const plan = planExpansion([solo, group, second], new Map([[1n, 6], [2n, 3]]), 1500, 10000);
  assert.equal(plan.exact, true); assert.equal(plan.jobs.length, 2);
  assert.ok(plan.jobs.some(j => j.support?.length));
});

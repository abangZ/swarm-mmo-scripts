import './helpers/browser';
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { coalitionOptions, cooperationGroups, arriving } from '../src/features/expansion/cooperation';
import { planExpansion } from '../src/features/expansion/planner';
import { ExpansionEngine } from '../src/features/expansion/engine';
import { defaults, members, totalCount, validateSettings } from '../src/features/expansion/types';
import { loadSettings, parseSettings } from '../src/app/settings';
import { coalitionWorld, planet, settle } from './helpers/fixtures';
import { unresolved } from '../src/runtime/operations';

const settings = { ...defaults, maxSources: 10 };
function world(size = 10) {
  const f = coalitionWorld(size);
  f.target.probeCount = size * 2 - 2;
  f.snapshot.owned.forEach((p, i) => { p.positionX = i % 4; p.positionY = Math.floor(i / 4); f.snapshot.budgets.set(p.planetId, 2); });
  return f;
}

test('numeric coalition settings accept 1–10, preserve older values, and reject fractions or excess', () => {
  for (const maxSources of [1, 3, 10]) {
    localStorage.setItem('swarm-helper-expansion-settings', JSON.stringify({ ...defaults, maxSources }));
    assert.equal(parseSettings(loadSettings()).maxSources, maxSources);
  }
  for (const maxSources of [0, 11, 3.5, NaN]) assert.throws(() => validateSettings({ ...settings, maxSources }));
  assert.throws(() => parseSettings({ ...loadSettings(), maxSources: '' }));
});

test('ten-source allocations respect every toll and budget, and the planner accepts the entire batch', () => {
  const f = world();
  const sources = f.snapshot.owned.map(p => ({ planet: p, available: 4, travelMs: 10000, lossPct: 50 }));
  const options = coalitionOptions(f.target, sources, settings);
  assert.ok(options.length > 0 && options.length <= 8);
  for (const job of options) {
    assert.equal(members(job).length, 10);
    assert.equal(members(job).reduce((n, m) => n + arriving(m.count, 50), 0), f.target.probeCount + 2);
    assert.ok(members(job).every(m => m.count <= 4));
  }
  assert.equal(coalitionOptions(f.target, sources, { ...settings, maxSources: 9 }).length, 0);
  const budget = new Map(sources.map(s => [s.planet.planetId, s.available]));
  const competitor = { sourceId: sources[0].planet.planetId, targetId: 1000n, count: 4, travelMs: 1000 };
  assert.equal(planExpansion([...options, competitor], budget, 1500, 120000, 1800000).jobs.length, 1);
  budget.set(competitor.sourceId, 8);
  assert.equal(planExpansion([...options, competitor], budget, 1500, 120000, 1800000).jobs.length, 2);
});

test('420-source candidate generation remains bounded and preserves spatial and arrival compatibility', () => {
  const sources = Array.from({ length: 420 }, (_, i) => ({ planet: planet(BigInt(i + 1), i % 21, Math.floor(i / 21), true), available: i % 9 + 1, travelMs: (i % 30) * 2000, lossPct: 0 }));
  const groups = [...cooperationGroups(sources, 10)];
  const large = groups.filter(g => g.length > 3);
  assert.ok(large.length > 0 && large.length <= 32);
  assert.ok(groups.length <= 67);
  for (const group of large) {
    assert.ok(group.length <= 10);
    assert.equal(new Set(group.map(s => s.planet.planetId)).size, group.length);
    for (const a of group) for (const b of group) {
      assert.ok(Math.hypot(a.planet.positionX - b.planet.positionX, a.planet.positionY - b.planet.positionY) <= 8);
      assert.ok(Math.abs(a.travelMs - b.travelMs) <= 15000);
    }
  }
});

for (const size of [4, 10]) test(`${size} sources capture through one native batch and one inventory barrier`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  const f = world(size); f.world.syncInventory = mock.fn(async () => {});
  const engine = new ExpansionEngine(() => {}, () => f.world), run = engine.start({ ...settings, maxSources: size });
  t.after(async () => { engine.stop(); await run; });
  await settle();
  assert.equal((f.world.launchGroup as any).mock.callCount(), 1);
  const job = (f.world.launchGroup as any).mock.calls[0].arguments[0];
  assert.equal(members(job).length, size); assert.equal(totalCount(job), size * 2);
  assert.equal((f.world.launch as any).mock.callCount(), 0);
  assert.equal((f.world.syncInventory as any).mock.callCount(), 1);
  assert.equal((f.world.syncInventory as any).mock.calls[0].arguments[0].length, size);
  assert.equal(engine.state.sent, size); assert.equal(engine.state.flights, 1);
});

test('a ten-source batch rechecks its last contributor before dispatch', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  localStorage.setItem('swarm-helper-last-operation-v1', '100000');
  const f = world(), engine = new ExpansionEngine(() => {}, () => f.world), run = engine.start(settings);
  t.after(async () => { engine.stop(); await run; });
  await settle();
  f.snapshot.budgets.set(f.snapshot.owned.at(-1)!.planetId, 0);
  t.mock.timers.tick(1500); await settle();
  assert.equal((f.world.launchGroup as any).mock.callCount(), 0);
  assert.equal((f.world.launch as any).mock.callCount(), 0);
  assert.equal(unresolved(), false);
});

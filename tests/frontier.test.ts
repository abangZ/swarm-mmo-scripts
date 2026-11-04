import './helpers/browser';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FrontierPlanner } from '../src/features/expansion/frontier';
import { PlanningQuotes } from '../src/features/expansion/planning-quotes';
import { finishPlanning } from '../src/runtime/planning';
import { defaultPolicy } from '../src/features/commander/types';
import { defaults, members } from '../src/features/expansion/types';
import { fakeWorld, planet } from './helpers/fixtures';

test('idle frontier checks reach a rich source among thousands and reuse unchanged native quotes', t => {
  t.mock.timers.enable({ apis: ['Date'], now: 100000 });
  const f = fakeWorld(), planner = new FrontierPlanner(), cache = new PlanningQuotes();
  f.snapshot.quoteVersion = 'v1'; f.snapshot.attackMultiplierUpperBound = 1;
  f.snapshot.owned = Array.from({ length: 3000 }, (_, i) => planet(BigInt(i + 100), 0, 0, true));
  const rich = f.snapshot.owned.at(-1)!;
  f.snapshot.budgets = new Map(f.snapshot.owned.map(p => [p.planetId, p === rich ? 10000 : 1]));
  f.snapshot.planets = [...f.snapshot.owned, ...Array.from({ length: 50 }, (_, i) => planet(BigInt(i + 10000), i + 1, 0))];
  const quotes = t.mock.method(f.world, 'quote', () => ({ count: 25, travelMs: 1000 }));
  f.world.route = () => ({ travelMs: 1000, lossPct: 0 });
  const config = { settings: { ...defaults, radius: 64 }, policy: defaultPolicy };
  const plan = () => finishPlanning(planner.steps(cache.begin(f.world, f.snapshot), f.snapshot, config, f.snapshot.budgets, new Set(), true));
  assert.deepEqual(plan(), []);
  t.mock.timers.tick(2000);
  assert.deepEqual(plan().map(job => job.sourceId), [rich.planetId, rich.planetId, rich.planetId]);
  assert.equal(quotes.mock.callCount(), 3, 'weak sources do not consume native quote time');
  t.mock.timers.tick(5000);
  assert.equal(plan().length, 3, 'the rich source continues before every weak source has been visited');
  assert.equal(quotes.mock.callCount(), 3, 'unchanged local quotes are reused');
});

test('frontier drafts retain fleet locks and a bounded nearest-target search', t => {
  t.mock.timers.enable({ apis: ['Date'], now: 100000 });
  const f = fakeWorld(), planner = new FrontierPlanner();
  const config = { settings: { ...defaults, radius: 64 }, policy: defaultPolicy };
  finishPlanning(planner.steps(f.world, f.snapshot, config, f.snapshot.budgets, new Set(), false));
  f.snapshot.budgets.set(1n, 1000);
  f.snapshot.planets = [f.source, ...Array.from({ length: 50 }, (_, i) => planet(BigInt(i + 2), i + 1, 0))];
  f.snapshot.incoming.add(3n);
  const quotes = t.mock.method(f.world, 'quote', () => null);
  const jobs = finishPlanning(planner.steps(f.world, f.snapshot, config, f.snapshot.budgets, new Set([2n]), false));
  assert.deepEqual(jobs, []);
  assert.equal(quotes.mock.callCount(), 32);
  assert.ok(quotes.mock.calls.every(call => call.arguments[1] !== 2n && call.arguments[1] !== 3n));
});

test('32 unaffordable nearby targets cannot hide the next affordable frontier target', t => {
  t.mock.timers.enable({ apis: ['Date'], now: 100000 });
  const f = fakeWorld(), planner = new FrontierPlanner();
  const config = { settings: { ...defaults, radius: 64 }, policy: defaultPolicy };
  f.snapshot.attackMultiplierUpperBound = 1;
  finishPlanning(planner.steps(f.world, f.snapshot, config, f.snapshot.budgets, new Set(), false));
  f.snapshot.budgets.set(1n, 100);
  const targets = Array.from({ length: 33 }, (_, i) => ({ ...planet(BigInt(i + 2), i + 1, 0), probeCount: i === 32 ? 10 : 1000 }));
  f.snapshot.planets = [f.source, ...targets];
  const quote = t.mock.method(f.world, 'quote', () => ({ count: 12, travelMs: 1000 }));
  const jobs = finishPlanning(planner.steps(f.world, f.snapshot, config, f.snapshot.budgets, new Set(), true));
  assert.deepEqual(jobs.map(job => job.targetId), [34n]); assert.equal(quote.mock.callCount(), 1);
});

test('unproductive rich sources cannot repeatedly starve an unchecked useful source', t => {
  t.mock.timers.enable({ apis: ['Date'], now: 100000 });
  const f = fakeWorld(), planner = new FrontierPlanner();
  f.snapshot.owned = Array.from({ length: 25 }, (_, i) => planet(BigInt(i + 100), 0, 0, true));
  f.snapshot.planets = [...f.snapshot.owned, f.target];
  f.snapshot.budgets = new Map(f.snapshot.owned.map((p, i) => [p.planetId, 1000 - i]));
  const last = f.snapshot.owned.at(-1)!.planetId;
  f.world.quote = source => source === last ? { count: 12, travelMs: 1000 } : null;
  const config = { settings: defaults, policy: defaultPolicy };
  const plan = () => finishPlanning(planner.steps(f.world, f.snapshot, config, f.snapshot.budgets, new Set(), true));
  plan();
  let jobs: ReturnType<typeof plan> = [];
  for (let i = 0; i < 7; i++) { t.mock.timers.tick(2000); jobs = plan(); if (jobs.length) break; }
  assert.equal(jobs[0]?.sourceId, last, 'older unchecked sources progress even after rich sources become eligible again');
});

test('nearby 435 and 230 probes capture a 644-probe neutral through the fast coalition path', t => {
  t.mock.timers.enable({ apis: ['Date'], now: 100000 });
  const f = fakeWorld(), planner = new FrontierPlanner();
  const ally = planet(3n, 0, 1, true);
  f.target.probeCount = 644;
  f.snapshot.owned.push(ally); f.snapshot.planets.push(ally);
  f.snapshot.budgets = new Map([[1n, 435], [3n, 230]]); f.snapshot.attackMultiplierUpperBound = 1;
  f.world.quote = () => null;
  f.world.route = () => ({ travelMs: 10000, lossPct: 0 }); f.world.launchGroup = async () => {};
  const config = { settings: defaults, policy: defaultPolicy };
  const plan = () => finishPlanning(planner.steps(f.world, f.snapshot, config, f.snapshot.budgets, new Set(), true));
  assert.deepEqual(plan(), []); t.mock.timers.tick(2000);
  const jobs = plan();
  assert.equal(jobs.length, 1); assert.equal(jobs[0].targetId, 2n);
  assert.equal(members(jobs[0]).length, 2);
  assert.equal(members(jobs[0]).reduce((sum, m) => sum + m.count, 0), 646);
  for (const m of members(jobs[0])) assert.ok(m.count <= f.snapshot.budgets.get(m.sourceId)!);
});

test('frontier coalitions retain native group support, fleet, range, loss and arrival-spread constraints', t => {
  t.mock.timers.enable({ apis: ['Date'], now: 100000 });
  for (const blocked of ['group-disabled', 'fleet', 'range', 'loss', 'spread'] as const) {
    const f = fakeWorld(), planner = new FrontierPlanner(), ally = planet(3n, 0, 1, true);
    f.target.probeCount = 150;
    f.snapshot.owned.push(ally); f.snapshot.planets.push(ally);
    f.snapshot.budgets = new Map([[1n, 100], [3n, 100]]); f.snapshot.attackMultiplierUpperBound = 1;
    f.world.quote = () => null; f.world.launchGroup = async () => {};
    f.world.route = source => ({ travelMs: blocked === 'spread' && source === 3n ? 30000 : 10000, lossPct: blocked === 'loss' ? 50 : 0 });
    if (blocked === 'group-disabled') f.world.supportsGroup = () => false;
    if (blocked === 'range') ally.positionY = 9;
    if (blocked === 'fleet') f.snapshot.incoming.add(2n);
    const config = { settings: defaults, policy: defaultPolicy };
    const plan = () => finishPlanning(planner.steps(f.world, f.snapshot, config, f.snapshot.budgets, new Set(), true));
    plan(); t.mock.timers.tick(2000);
    assert.deepEqual(plan(), [], blocked);
  }
});

test('a fast coalition draft shares donor budgets across targets and bounds native evaluations', t => {
  t.mock.timers.enable({ apis: ['Date'], now: 100000 });
  const f = fakeWorld(), planner = new FrontierPlanner();
  f.snapshot.owned = Array.from({ length: 25 }, (_, i) => planet(BigInt(100 + i), 0, 0, true));
  f.snapshot.planets = [...f.snapshot.owned, ...Array.from({ length: 32 }, (_, i) => ({ ...planet(BigInt(200 + i), 1, 0), probeCount: 150 }))];
  f.snapshot.budgets = new Map(f.snapshot.owned.map(p => [p.planetId, 100]));
  f.snapshot.attackMultiplierUpperBound = 1;
  f.world.quote = () => null; f.world.launchGroup = async () => {};
  const route = t.mock.fn(() => ({ travelMs: 10000, lossPct: 0 })); f.world.route = route;
  const config = { settings: defaults, policy: defaultPolicy };
  const plan = () => finishPlanning(planner.steps(f.world, f.snapshot, config, f.snapshot.budgets, new Set(), true));
  plan(); t.mock.timers.tick(2000);
  const jobs = plan(), spent = new Map<bigint, number>();
  assert.ok(jobs.length > 0); assert.ok(route.mock.callCount() <= 96);
  for (const job of jobs) for (const m of members(job)) spent.set(m.sourceId, (spent.get(m.sourceId) ?? 0) + m.count);
  for (const [id, count] of spent) assert.ok(count <= f.snapshot.budgets.get(id)!);
});

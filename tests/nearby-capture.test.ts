import './helpers/browser';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultPolicy } from '../src/features/commander/types';
import { FrontierPlanner } from '../src/features/expansion/frontier';
import { LogisticsPlanner } from '../src/features/expansion/logistics';
import { nearbyCaptureWindow } from '../src/features/expansion/nearby-capture';
import { expansionProposals } from '../src/features/expansion/proposals';
import { defaults, members } from '../src/features/expansion/types';
import { finishPlanning } from '../src/runtime/planning';
import { fakeWorld, planet } from './helpers/fixtures';

function setup() {
  const f = fakeWorld();
  f.source.level = 1;
  f.target.probeCount = 4;
  const far = { ...planet(3n, 22, 0), probeCount: 0 };
  f.snapshot.planets.push(far);
  f.snapshot.budgets.set(1n, 3);
  f.snapshot.productionTicks = new Map([[1n, 60000]]);
  f.snapshot.attackMultiplierUpperBound = 1;
  f.world.route = (_src, id) => ({ travelMs: id === far.planetId ? 240000 : 15000, lossPct: 0 });
  f.world.quote = (src, id) => {
    const count = id === far.planetId ? 1 : 5;
    return count <= (f.snapshot.budgets.get(src) ?? 0) ? { count, travelMs: f.world.route!(src, id)!.travelMs } : null;
  };
  const config = { settings: { ...defaults }, policy: defaultPolicy };
  const plan = (locked = new Set<bigint>()) => expansionProposals(f.world, f.snapshot, config, f.snapshot.budgets, locked);
  return { ...f, far, config, plan };
}

test('three probes wait two production ticks for an earlier capture; the real quote is required after growth', () => {
  const f = setup();
  assert.deepEqual(f.plan().edges, []);
  assert.match(f.plan().sources[0].reason, /附近 #2/);
  f.snapshot.budgets.set(1n, 4);
  assert.deepEqual(f.plan().edges, []);
  f.snapshot.budgets.set(1n, 5);
  assert.ok(f.plan().edges.some(e => e.targetId === 2n && e.count === 5));
  f.world.quote = () => null;
  assert.deepEqual(f.plan().edges, []);
});

test('a faster immediate flight, a locked neighbor or an unviable local route leaves the source free', () => {
  const f = setup();
  assert.deepEqual(f.plan(new Set([2n])).edges.map(j => j.targetId), [3n]);
  f.snapshot.incoming.add(2n);
  assert.deepEqual(f.plan().edges.map(j => j.targetId), [3n]);
  f.snapshot.incoming.clear();
  f.snapshot.productionTicks!.set(1n, 120000);
  assert.deepEqual(f.plan().edges.map(j => j.targetId), [3n]);
  f.snapshot.productionTicks!.set(1n, 60000);
  f.world.route = (_src, id) => ({ travelMs: id === 3n ? 240000 : 15000, lossPct: id === 2n ? 50 : 0 });
  assert.deepEqual(f.plan().edges.map(j => j.targetId), [3n]);
});

test('frontier refill and the full planner both defer a distant coalition; other sources can still launch', t => {
  t.mock.timers.enable({ apis: ['Date'], now: 10000 });
  const f = setup(), peer = { ...planet(4n, -1, 0, true), level: 1 };
  f.snapshot.planets.push(peer); f.snapshot.owned.push(peer); f.snapshot.budgets.set(4n, 3);
  f.far.probeCount = 4;
  f.world.quote = () => null;
  f.world.route = (src, id) => ({ travelMs: id === 3n ? 240000 : 15000, lossPct: src === 4n && id === 2n ? 100 : 0 });
  f.world.launchGroup = async () => {};
  assert.deepEqual(f.plan().edges, []);
  const frontier = new FrontierPlanner();
  const fast = (locked = new Set<bigint>()) => finishPlanning(frontier.steps(f.world, f.snapshot, f.config, f.snapshot.budgets, locked, true));
  fast(); t.mock.timers.tick(5000);
  assert.deepEqual(fast(), []);
  t.mock.timers.tick(5000);
  assert.ok(fast(new Set([2n])).some(job => job.targetId === 3n && members(job).length === 2));
  f.snapshot.budgets.set(4n, 6);
  f.world.quote = (src, id) => src === 4n && id === 3n ? { count: 6, travelMs: 240000 } : null;
  assert.ok(f.plan().edges.some(job => job.sourceId === 4n && !job.support));
});

test('rear supply leaves a donor enough stock to take its own faster neighbor', t => {
  const f = setup(), donor = f.source, hub = { ...planet(10n, 22, 1, true), level: 1 };
  f.snapshot.planets.push(hub); f.snapshot.owned = [hub, donor]; f.snapshot.budgets.set(hub.planetId, 1);
  f.snapshot.intelligence = true; f.snapshot.identity = 'me'; f.snapshot.quoteVersion = 'rules-1';
  f.far.probeCount = 3;
  f.world.quote = (src, id) => src === 1n && id === 2n && f.snapshot.budgets.get(1n)! >= 5 ? { count: 5, travelMs: 15000 } : null;
  f.world.route = (src, id) => ({ travelMs: src === 1n && id === 10n ? 240000 : 15000, lossPct: 0 });
  f.world.launchGroup = async () => {};
  const planner = new LogisticsPlanner('planet');
  const plan = (locked = new Set<string>()) => finishPlanning(planner.steps(f.world, f.snapshot, f.config, f.snapshot.budgets, locked));
  // Establish the hub campaign before the cheaper donor-side neighbor appears.
  f.snapshot.planets = f.snapshot.planets.filter(p => p !== f.target);
  assert.equal(plan().job?.kind, 'expansion-supply');
  f.snapshot.planets.push(f.target);
  const quote = t.mock.method(f.world, 'quote', f.world.quote);
  assert.equal(plan().job, undefined);
  plan();
  assert.equal(quote.mock.calls.filter(call => call.arguments[0] === 1n && call.arguments[1] === 2n).length, 1,
    'the next logistics pass reuses the local price and route at unchanged stock');
  f.snapshot.budgets.set(1n, 5);
  assert.equal(plan().job, undefined);
  f.snapshot.budgets.set(1n, 8);
  assert.equal(plan().job?.count, 3);
  f.snapshot.budgets.set(1n, 3);
  assert.equal(plan(new Set(['planet:2'])).job?.count, 3);
});

test('local forecast prices at most four neighbors per source and stock, regardless of competing jobs', () => {
  const f = setup();
  const neighbors = Array.from({ length: 1000 }, (_, i) => ({ ...f.target, planetId: BigInt(100 + i) }));
  let lookups = 0, prices = 0;
  const forecast = nearbyCaptureWindow(f.snapshot, defaults, () => { lookups++; return neighbors; }, () => true,
    () => { prices++; return { route: { travelMs: 15000, lossPct: 0 } }; });
  assert.equal(forecast(f.source, 3, 3, 50000), undefined);
  assert.equal(lookups, 0);
  for (let i = 0; i < 500; i++) assert.ok(forecast(f.source, 3, 3, 240000));
  assert.equal(lookups, 1); assert.equal(prices, 4);
});
